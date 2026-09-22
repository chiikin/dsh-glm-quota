/**
 * dsh-glm-quota 宿主半侧（host half）—— GLM Coding Plan 配额查询、重置卡与缓存（hmr-probe-474280175）。
 *
 * 职责：
 * - 跟踪每个会话当前生效的模型选择（session/event 的 model/selection 事件），
 *   缺省回落到 agentDefaultModel.currentSelection()（全局默认）；
 * - 当前供应商为 zai-coding-cn 时，用该供应商绑定的凭证
 *   （credentialRef('ZAI_CODING_CN_API_KEY')，即「添加模型提供商」时录入的 Key）
 *   查询智谱 Coding Plan 配额 / 套餐订阅 / 现金余额 / 重置卡，带 TTL 缓存与并发去重；
 * - SSE 推送：GET /dsh-glm-quota/events?sessionId=<id> 长连接，向浏览器推送
 *   model/selection（显隐即时同步）与 turn/end（回合结束自动刷新）事件；
 * - 重置：POST /dsh-glm-quota/reset { sessionId, window: 'fiveHours'|'week' }
 *   先拉取最新重置卡列表，取该窗口最早到期的一张执行 /use，成功后失效缓存并回读快照。
 *
 * 上游端点（均为 open.bigmodel.cn；monitor/biz 网关接受裸 Key 或 Bearer，
 * 重置卡端点与网页端行为一致使用 Bearer）：
 *   GET  /api/monitor/usage/quota/limit                5h/周 窗口配额（必需）
 *   GET  /api/biz/subscription/list                    套餐名称/到期/自动续费（尽力）
 *   GET  /api/biz/account/query-customer-account-report 现金余额（尽力）
 *   GET  /api/biz/customer-package-reset/list?targetType=PERSONAL   重置卡列表（尽力）
 *   POST /api/biz/customer-package-reset/use           执行重置（消耗资源，绝不缓存）
 *
 * 重置卡端点语义参考 OmniRoute PR #12754（"GLM Coding Plan Reset Cards"）：
 * data.fiveHourResets / data.weekResets 两个桶，条目含 recordId/expireTime/status 等；
 * 已消耗/过期/不可用条目过滤，按到期时间升序。/use 请求体
 * { targetType:'PERSONAL', resetType:'FIVE_HOUR'|'WEEK', recordId, requestId }。
 *
 * 隐私：Key 只在宿主进程内解析与使用，绝不随响应返回浏览器；上游原始响应
 * 也不透传，只回本项目化后的最小字段集合。
 */

import { randomUUID } from 'node:crypto';
import { credentialRef } from '@deepseek-ai/dsh-credentials';

/** 插件行 id（与 cordis.patch.yml 一致） */
export const name = 'glm-quota';
/** 注入的服务：webServer（路由）+ agentDefaultModel（当前供应商）+ credentials（凭证） */
export const inject = ['webServer', 'agentDefaultModel', 'credentials'];

/** 状态路由前缀 */
const ROUTE_PREFIX = '/dsh-glm-quota';
/** 目标供应商 id（pi-ai 的 zai-coding-cn provider） */
const TARGET_PROVIDER = 'zai-coding-cn';
/** 供应商绑定的凭证引用名（与 provider auth 的 envApiKeyAuth 一致） */
const CREDENTIAL_REF_NAME = 'ZAI_CODING_CN_API_KEY';
/** 上游站点（monitor/biz 网关与 coding API 同域） */
const UPSTREAM_HOST = 'https://open.bigmodel.cn';
/** 成功快照缓存 TTL：60s（上游为非公开接口，克制轮询） */
const CACHE_TTL_MS = 60_000;
/** 失败结果的短缓存 TTL：10s（避免高频触发打爆上游） */
const ERROR_TTL_MS = 10_000;
/** 单次上游请求超时 */
const UPSTREAM_TIMEOUT_MS = 15_000;
/** 会话选择缓存的容量上限（LRU 语义：超限丢最旧） */
const MAX_SESSIONS = 200;

/** 会话作用域的宿主对象可能有两种形态，做防御式取 id */
function sessionIdOf(session) {
	const s = /** @type {any} */ (session);
	const id = s?.header?.id ?? s?.id;
	return id === undefined || id === null ? '' : String(id);
}

/** 数值兜底：非法/缺失返回 null，绝不伪造 0 */
function numOrNull(value) {
	const n = Number(value);
	return Number.isFinite(n) ? n : null;
}

/** 字符串兜底：非空字符串才收（数字也收，转字符串） */
function strOrNull(value) {
	if (typeof value === 'string' && value.trim()) return value.trim();
	if (typeof value === 'number' && Number.isFinite(value)) return String(value);
	return null;
}

/** 在记录里按优先级取第一个可用字符串字段 */
function firstString(record, keys) {
	for (const key of keys) {
		const v = strOrNull(record?.[key]);
		if (v !== null) return v;
	}
	return null;
}

/**
 * 从 limits 数组里挑指定窗口（unit: 3=5h 滚动窗，6=周窗）；
 * 条目缺 unit 字段时作为所有窗口的兜底（与 openusage 的 findLimit 语义一致）。
 */
function pickWindow(limits, unit) {
	if (!Array.isArray(limits)) return undefined;
	return (
		limits.find((l) => l?.type === 'CREDIT_LIMIT' && l?.unit === unit) ??
		limits.find((l) => (l?.type === 'CREDIT_LIMIT' || l?.name === 'CREDIT_LIMIT') && l?.unit === undefined)
	);
}

/** 把一条 CREDIT_LIMIT 条目投影成前端需要的最小字段 */
function windowView(entry) {
	if (!entry) return null;
	const total = numOrNull(entry.usage);
	const used = numOrNull(entry.currentValue);
	const remaining = numOrNull(entry.remaining);
	const percent = numOrNull(entry.percentage);
	const resetAtMs = numOrNull(entry.nextResetTime);
	const usedPercent =
		percent !== null
			? percent
			: total !== null && total > 0 && used !== null
				? Math.round((used / total) * 100)
				: null;
	return {
		usedPercent,
		totalCredits: total,
		usedCredits: used,
		remainingCredits: remaining,
		/** epoch ms；前端本地渲染倒计时 */
		resetAt: resetAtMs !== null && resetAtMs > 0 ? resetAtMs : null,
	};
}

/** 套餐订阅投影（取 VALID 条目，缺省第一条） */
function subscriptionView(data) {
	const list = Array.isArray(data) ? data : [];
	const plan = list.find((s) => s?.status === 'VALID') ?? list[0];
	if (!plan) return null;
	// valid 形如 "2026-12-18 10:00:00-2027-03-18 10:00:00"（当期起-止）；
	// 分隔符与日期内的 '-' 混在一起，用「末段以 4 位年份开头」锚定切分。
	const raw = typeof plan.valid === 'string' ? plan.valid : '';
	const m = /^(.+?)\s*-\s*(\d{4}-\d{2}-\d{2}.*)$/.exec(raw);
	return {
		name: strOrNull(plan.productName),
		/** 当期结束（套餐到期时间，原样字符串） */
		periodEnd: m ? m[2].trim() : null,
		nextRenewAt: strOrNull(plan.nextRenewTime),
		autoRenew: plan.autoRenew === 1 || plan.autoRenew === true,
	};
}

/** 现金余额投影 */
function balanceView(data) {
	const d = data && typeof data === 'object' ? data : {};
	const available = numOrNull(d.availableBalance ?? d.balance);
	if (available === null) return null;
	return { currency: 'CNY', available };
}

// ---------------------------------------------------------------------------
// 重置卡解析（语义对齐 OmniRoute glmResetCards.ts）
// ---------------------------------------------------------------------------

/** z.ai 无时区时间串按 UTC 解析，其余走标准 Date.parse */
const RESET_TS_PATTERN = /^(\d{4})-(\d{2})-(\d{2})[ T](\d{2}):(\d{2}):(\d{2})(?:\.(\d{1,3}))?$/;
function parseResetTimestampMs(value) {
	const trimmed = String(value).trim();
	const m = RESET_TS_PATTERN.exec(trimmed);
	if (m) {
		const frac = Number(((m[7] ?? '0') + '000').slice(0, 3));
		const ts = Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3]), Number(m[4]), Number(m[5]), Number(m[6]));
		return Number.isFinite(ts) ? ts + frac : null;
	}
	const ts = Date.parse(trimmed);
	return Number.isFinite(ts) ? ts : null;
}

/** 归一化状态串（小写字母数字），判定卡片是否已不可用 */
function normalizeStatus(value) {
	if (typeof value !== 'string') return null;
	const n = value.trim().toLowerCase().replace(/[^a-z0-9]/g, '');
	return n || null;
}

function isUnavailableCard(record) {
	const status = normalizeStatus(record?.status ?? record?.state ?? record?.outcome ?? record?.result ?? record?.code);
	if (status && ['consumed', 'redeeming', 'redeemed', 'used', 'expired', 'unavailable'].includes(status)) return true;
	return record?.available === false || record?.consumed === true || record?.redeemed === true;
}

/** 解析单张重置卡；不可用/无 id/已过期 → null */
function parseResetCard(value, fallbackType) {
	if (!value || typeof value !== 'object') return null;
	if (isUnavailableCard(value)) return null;
	const id = firstString(value, ['recordId', 'id', 'packageResetId', 'resetId']);
	if (id === null) return null;
	const expireRaw = firstString(value, ['expireTime', 'expiredTime', 'expiresAt', 'endTime']);
	let expiresAtMs = null;
	if (expireRaw !== null) {
		expiresAtMs = parseResetTimestampMs(expireRaw);
		if (expiresAtMs !== null && expiresAtMs <= Date.now()) return null;
	}
	const rt = String(value.resetType ?? value.type ?? '').trim().toUpperCase();
	return {
		id,
		resetType: rt === 'WEEK' || rt === 'FIVE_HOUR' ? rt : fallbackType,
		expiresAtMs,
		title: firstString(value, ['packageName', 'name', 'title']),
	};
}

/** 解析整个重置卡列表（两个桶合并、过滤、按到期升序） */
function parseResetCards(data) {
	const d = data && typeof data === 'object' ? data : {};
	const buckets = [
		{ key: 'fiveHourResets', resetType: 'FIVE_HOUR' },
		{ key: 'weekResets', resetType: 'WEEK' },
	];
	const cards = [];
	for (const { key, resetType } of buckets) {
		const entries = d[key];
		if (!Array.isArray(entries)) continue;
		for (const entry of entries) {
			const card = parseResetCard(entry, resetType);
			if (card) cards.push(card);
		}
	}
	cards.sort((a, b) => (a.expiresAtMs ?? Number.POSITIVE_INFINITY) - (b.expiresAtMs ?? Number.POSITIVE_INFINITY));
	return cards;
}

/**
 * 宿主插件主体。
 * @param {any} ctx cordis 上下文（webServer/agentDefaultModel/credentials 无静态类型）
 */
export function apply(ctx) {
	/** 会话 id → { provider, model }（来源：session/event 的 model/selection） */
	const sessionSelection = new Map();

	/** SSE 客户端：sessionId → Set<res> */
	const sseClients = new Map();
	const broadcastSse = (sessionId, event, data) => {
		const set = sseClients.get(sessionId);
		if (!set) return;
		const frame = `event: ${event}\ndata: ${JSON.stringify(data ?? {})}\n\n`;
		for (const res of set) {
			try {
				res.write(frame);
			} catch {
				set.delete(res);
			}
		}
	};

	ctx.effect(
		() =>
			ctx.on('session/event', (session, event) => {
				const type = /** @type {any} */ (event)?.type;
				if (type !== 'model/selection' && type !== 'turn/end') return;
				const sessionId = sessionIdOf(session);
				if (!sessionId) return;
				if (type === 'model/selection') {
					const provider = /** @type {any} */ (event)?.data?.provider;
					if (typeof provider !== 'string' || provider.length === 0) return;
					if (sessionSelection.size >= MAX_SESSIONS && !sessionSelection.has(sessionId)) {
						const oldest = sessionSelection.keys().next().value;
						if (oldest !== undefined) sessionSelection.delete(oldest);
					}
					sessionSelection.set(sessionId, {
						provider,
						model: String(/** @type {any} */ (event)?.data?.model ?? ''),
					});
					broadcastSse(sessionId, 'selection', {});
				} else {
					broadcastSse(sessionId, 'turn-end', {});
				}
			}),
		'dsh-glm-quota: session events → SSE',
	);

	// 插件卸载时关闭全部 SSE 连接
	ctx.effect(() => {
		const all = [...sseClients.values()].flatMap((set) => [...set]);
		return () => {
			for (const res of all) {
				try {
					res.end();
				} catch {
					/* 已断 */
				}
			}
			sseClients.clear();
		};
	}, 'dsh-glm-quota: SSE shutdown');

	/** 解析供应商绑定的 Key；失败/未配置返回 undefined（绝不抛出到路由层） */
	async function resolveKey() {
		try {
			const rc = await ctx.credentials.resolve(credentialRef(CREDENTIAL_REF_NAME));
			return rc?.value ?? undefined;
		} catch {
			return undefined;
		}
	}

	/**
	 * 上游请求。quota/subscription/account 裸 Key；重置卡端点用 Bearer（与网页端一致）。
	 * success !== true 视为业务失败（抛错，附 msg）。
	 */
	async function requestUpstream(pathnameAndQuery, key, { method = 'GET', body, bearer = false } = {}) {
		const res = await fetch(UPSTREAM_HOST + pathnameAndQuery, {
			method,
			headers: {
				Accept: 'application/json',
				Authorization: bearer ? `Bearer ${key}` : key,
				...(body !== undefined ? { 'Content-Type': 'application/json' } : {}),
			},
			...(body !== undefined ? { body: JSON.stringify(body) } : {}),
			signal: AbortSignal.timeout(UPSTREAM_TIMEOUT_MS),
			cache: 'no-store',
		});
		if (!res.ok) throw new Error(`上游 HTTP ${res.status}`);
		const payload = await /** @type {any} */ (await res.json());
		if (payload?.success !== true) {
			throw new Error(payload?.msg ? `智谱接口：${payload.msg}` : `智谱接口错误码 ${payload?.code ?? '未知'}`);
		}
		return payload.data;
	}

	/** limits 数组兜底归一（兼容 data.limits 与顶层数组两种形态） */
	function limitsOf(data) {
		if (Array.isArray(data)) return data;
		return Array.isArray(data?.limits) ? data.limits : [];
	}

	/** 拉取重置卡列表（不缓存；重置执行前必须拿到最新列表） */
	async function fetchResetCards(key) {
		const data = await requestUpstream('/api/biz/customer-package-reset/list?targetType=PERSONAL', key, {
			bearer: true,
		});
		// fail-closed：完整列表应答必须带两个桶数组，缺一律视为异常（不当作"无卡"）
		if (!data || typeof data !== 'object' || Array.isArray(data)) throw new Error('重置卡响应结构异常');
		if (!Array.isArray(data.fiveHourResets) || !Array.isArray(data.weekResets)) {
			throw new Error('重置卡响应缺少桶数组');
		}
		return parseResetCards(data);
	}

	/** 当前缓存：{ at, ttl, promise, data } */
	const cache = { at: 0, ttl: CACHE_TTL_MS, promise: null, data: null };

	/**
	 * 取配额快照（TTL 缓存 + 并发去重；refresh=true 强制回源）。
	 * @returns {Promise<any>} { fetchedAt, plan, windows, balance, resets, warnings }
	 */
	async function getSnapshot(refresh) {
		const now = Date.now();
		if (!refresh && cache.data && now - cache.at < cache.ttl) return cache.data;
		if (!refresh && cache.promise) return cache.promise;

		const run = (async () => {
			const key = await resolveKey();
			if (!key) return { error: 'credential-missing', fetchedAt: Date.now() };

			// 1) 配额（必需）。个人套餐不带 type 即返回；limits 为空时以 type=2 兜底探测团队套餐。
			let limits;
			try {
				limits = limitsOf(await requestUpstream('/api/monitor/usage/quota/limit', key));
				if (limits.length === 0) {
					limits = limitsOf(await requestUpstream('/api/monitor/usage/quota/limit?type=2', key));
				}
			} catch (e) {
				return { error: 'upstream', message: e instanceof Error ? e.message : String(e), fetchedAt: Date.now() };
			}
			if (limits.length === 0) return { error: 'no-plan', fetchedAt: Date.now() };

			const fiveHours = windowView(pickWindow(limits, 3));
			const week = windowView(pickWindow(limits, 6));

			// 2) 套餐订阅 / 现金余额 / 重置卡（全部尽力而为：失败记 warning，不影响配额）
			const extra = { plan: null, balance: null, resets: [], warnings: [] };
			await Promise.allSettled([
				requestUpstream('/api/biz/subscription/list', key).then(
					(d) => {
						extra.plan = subscriptionView(d);
					},
					(e) => {
						extra.warnings.push('订阅信息获取失败：' + (e instanceof Error ? e.message : String(e)));
					},
				),
				requestUpstream('/api/biz/account/query-customer-account-report', key).then(
					(d) => {
						extra.balance = balanceView(d);
					},
					(e) => {
						extra.warnings.push('余额获取失败：' + (e instanceof Error ? e.message : String(e)));
					},
				),
				fetchResetCards(key).then(
					(cards) => {
						extra.resets = cards;
					},
					(e) => {
						extra.warnings.push('重置卡获取失败：' + (e instanceof Error ? e.message : String(e)));
					},
				),
			]);

			return {
				fetchedAt: Date.now(),
				windows: { fiveHours, week },
				plan: extra.plan,
				balance: extra.balance,
				resets: extra.resets,
				warnings: extra.warnings,
			};
		})();

		cache.promise = run.finally(() => {
			cache.promise = null;
		});
		const data = await cache.promise;
		cache.data = data;
		cache.at = Date.now();
		cache.ttl = data?.error ? ERROR_TTL_MS : CACHE_TTL_MS;
		return data;
	}

	/**
	 * 执行重置：取该窗口最早到期的可用卡 → /use → 成功后失效缓存并回读快照。
	 * @returns {Promise<{ok:true, snapshot:any} | {ok:false, error:string, message?:string}>}
	 */
	async function executeReset(key, resetType) {
		let cards;
		try {
			cards = await fetchResetCards(key);
		} catch (e) {
			return { ok: false, error: 'list-failed', message: e instanceof Error ? e.message : String(e) };
		}
		const card = cards.find((c) => c.resetType === resetType);
		if (!card) return { ok: false, error: 'no-card', message: '该窗口没有可用的重置卡' };
		const numericId = Number(card.id);
		try {
			await requestUpstream('/api/biz/customer-package-reset/use', key, {
				method: 'POST',
				bearer: true,
				body: {
					targetType: 'PERSONAL',
					resetType,
					recordId: Number.isFinite(numericId) ? numericId : card.id,
					requestId: randomUUID(),
				},
			});
		} catch (e) {
			return { ok: false, error: 'reset-failed', message: e instanceof Error ? e.message : String(e) };
		}
		cache.data = null;
		cache.at = 0;
		const snapshot = await getSnapshot(true);
		return { ok: true, snapshot };
	}

	/** JSON 响应 */
	function sendJson(res, status, obj, headers = {}) {
		const body = JSON.stringify(obj);
		res.writeHead(status, {
			'content-type': 'application/json; charset=utf-8',
			'content-length': Buffer.byteLength(body),
			...headers,
		});
		res.end(body);
	}

	/** 收集请求体文本 */
	function readBody(req) {
		return new Promise((resolve, reject) => {
			const chunks = [];
			req.on('data', (c) => chunks.push(c));
			req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
			req.on('error', reject);
		});
	}

	/** 统一做供应商判定（status / reset 共用） */
	function currentProvider(sessionId) {
		const sessionSel = sessionId ? sessionSelection.get(sessionId) : undefined;
		if (sessionSel) return sessionSel.provider;
		try {
			return ctx.agentDefaultModel.currentSelection()?.provider;
		} catch {
			return undefined;
		}
	}

	ctx.effect(
		() =>
			ctx.webServer.register({
				kind: 'prefix',
				path: ROUTE_PREFIX,
				handler: async (req, res) => {
					try {
						const url = new URL(req.url ?? '/', 'http://localhost');
						const sessionId = url.searchParams.get('sessionId') ?? '';

						// ---- SSE 事件流：selection / turn-end 推送 ----
						if (url.pathname === `${ROUTE_PREFIX}/events`) {
							if (req.method !== 'GET') {
								sendJson(res, 405, { ok: false, error: 'method-not-allowed' });
								return;
							}
							res.writeHead(200, {
								'content-type': 'text/event-stream; charset=utf-8',
								'cache-control': 'no-cache, no-store',
								connection: 'keep-alive',
								'x-accel-buffering': 'no',
							});
							res.write(': connected\n\n');
							if (!sseClients.has(sessionId)) sseClients.set(sessionId, new Set());
							const set = sseClients.get(sessionId);
							set.add(res);
							req.on('close', () => {
								set.delete(res);
								if (set.size === 0) sseClients.delete(sessionId);
							});
							return;
						}

						// ---- 状态查询 ----
						if (url.pathname === `${ROUTE_PREFIX}/status`) {
							if (req.method !== 'GET') {
								sendJson(res, 405, { ok: false, error: 'method-not-allowed' });
								return;
							}
							const refresh = url.searchParams.get('refresh') === '1';
							const provider = currentProvider(sessionId);
							if (provider !== TARGET_PROVIDER) {
								sendJson(res, 200, { ok: true, visible: false, provider: provider ?? null });
								return;
							}
							const key = await resolveKey();
							if (!key) {
								sendJson(res, 200, { ok: true, visible: true, provider, error: 'credential-missing' });
								return;
							}
							const snapshot = await getSnapshot(refresh);
							sendJson(
								res,
								200,
								{ ok: true, visible: true, provider, snapshot },
								{ 'cache-control': 'no-cache, no-store' },
							);
							return;
						}

						// ---- 执行重置 ----
						if (url.pathname === `${ROUTE_PREFIX}/reset`) {
							if (req.method !== 'POST') {
								sendJson(res, 405, { ok: false, error: 'method-not-allowed' });
								return;
							}
							let body;
							try {
								body = JSON.parse(await readBody(req));
							} catch {
								sendJson(res, 200, { ok: false, error: 'bad-request', message: '请求体不是合法 JSON' });
								return;
							}
							const resetType =
								body?.window === 'week' ? 'WEEK' : body?.window === 'fiveHours' ? 'FIVE_HOUR' : null;
							if (!resetType) {
								sendJson(res, 200, { ok: false, error: 'bad-request', message: 'window 必须为 fiveHours 或 week' });
								return;
							}
							const provider = currentProvider(sessionId);
							if (provider !== TARGET_PROVIDER) {
								sendJson(res, 200, { ok: false, error: 'provider-mismatch', message: '当前供应商不是 zai-coding-cn' });
								return;
							}
							const key = await resolveKey();
							if (!key) {
								sendJson(res, 200, { ok: false, error: 'credential-missing', message: '缺少凭证 ZAI_CODING_CN_API_KEY' });
								return;
							}
							const result = await executeReset(key, resetType);
							sendJson(res, 200, result, { 'cache-control': 'no-cache, no-store' });
							return;
						}

						sendJson(res, 404, { ok: false, error: 'not-found' });
					} catch (e) {
						sendJson(res, 500, { ok: false, error: e instanceof Error ? e.message : String(e) });
					}
				},
			}),
		'dsh-glm-quota: routes',
	);
}

