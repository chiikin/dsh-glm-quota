/**
 * dsh-glm-quota 浏览器半侧（client half）—— 「剩余额度」芯片 + 悬浮详情 + 重置卡。
 *
 * 注册位置：composer 工具行 conversation.input.right 槽（list 型、session 作用域）。
 * 该槽渲染在 conversation.input.model（模型选择器）同一行的紧左侧。
 *
 * 刷新策略（无定时轮询）：
 * - 挂载时拉取一次（走宿主 60s TTL 缓存）；
 * - SSE（/dsh-glm-quota/events）：model/selection → 立即显隐同步（轻拉取）；
 *   turn/end → 回合结束自动刷新（强制回源，60s 保底间隔）；
 * - useSession 的 running 下降沿作为 SSE 失效时的兜底；
 * - 手动刷新按钮（30s 冷却）。
 *
 * 悬浮窗：5h/周窗口剩余（百分比 + 进度条 + 积分明细 + 重置倒计时）、套餐到期、
 * 现金余额、重置卡（可重置窗口 + 截止时间 + 重置按钮，点击弹确认框）。
 * 悬停交互：popover 与芯片零空隙 + 隐形桥接条 + 离开宽限定时器，鼠标可移入弹窗操作。
 *
 * 配色（按剩余量）：≥60% 绿 / 20-59% 橙 / <20% 红；全部带字面量兜底色。
 * Key 全程留在宿主进程，浏览器不接触任何凭证。
 * 本文件是「普通副作用脚本」：加载时调用 window.__ModuleLoader__.load，
 * 不能包含顶层 ESM export / import（react 由 factory 的 require 取得）。
 */

/* global window, document */

window.__ModuleLoader__.load({
	id: 'dsh-glm-quota',
	// eslint-disable-next-line @typescript-eslint/no-explicit-any -- DSH __ModuleLoader__ 契约（f(require) => module）
	factory: (require) => {
		const module = { exports: {} };

		// eslint-disable-next-line @typescript-eslint/no-explicit-any -- DSH 注入的模块无静态类型
		const react = require('react');
		const { useState, useEffect, useRef, useCallback } = react;

		/**
		 * hyperscript：children 合并进 props 后经 react.createElement 创建元素。
		 * （children 数组/节点/字符串/null 均可；已有 children 时追加合并）
		 */
		function hh(type, props, ...children) {
			const existing = props?.children;
			const merged =
				existing === undefined
					? children
					: children.length > 0
						? (Array.isArray(existing) ? existing : [existing]).concat(children)
						: existing;
			return react.createElement(type, { ...props, children: merged });
		}

		const STATUS_URL = '/dsh-glm-quota/status';
		const EVENTS_URL = '/dsh-glm-quota/events';
		const RESET_URL = '/dsh-glm-quota/reset';
		const TARGET_PROVIDER = 'zai-coding-cn';
		/** 自动刷新（回合结束）的最小间隔：60s */
		const AUTO_REFRESH_MIN_MS = 60_000;
		/** 手动刷新冷却：30s */
		const REFRESH_COOLDOWN_MS = 30_000;
		/** 悬浮窗倒计时本地重绘周期：30s（纯渲染，不发请求） */
		const COUNTDOWN_TICK_MS = 30_000;
		/** 鼠标离开芯片/弹窗后的关闭宽限：240ms */
		const HOVER_GRACE_MS = 240;
		const POP_WIDTH = 280;

		const CSS = `
.dglm-chip{position:relative;display:inline-flex;align-items:center;gap:6px;height:24px;padding:0 9px;border-radius:999px;font-size:12px;line-height:1;border:1px solid var(--dsw-alias-border-l2);color:var(--dsw-alias-label-secondary);cursor:default;user-select:none;white-space:nowrap;background:transparent}
.dglm-chip:hover{background:var(--dsw-alias-bg-layer-1);color:var(--dsw-alias-label-primary)}
.dglm-chip.is-error{color:var(--dsw-alias-state-error-primary,#dc2626)}
.dglm-bar{position:relative;width:36px;height:4px;border-radius:2px;background:var(--dsw-alias-border-l2);overflow:hidden;flex:none}
.dglm-bar>i{position:absolute;top:0;bottom:0;left:0;border-radius:2px;transition:width .4s ease,background-color .4s ease}
.dglm-pop{position:fixed;z-index:10000;width:${POP_WIDTH}px;padding:12px 14px 10px;border-radius:10px;background:var(--dsw-alias-bg-layer-1);color:var(--dsw-alias-label-primary);border:1px solid var(--dsw-alias-border-l2);box-shadow:0 8px 28px rgba(0,0,0,.16);font-size:12px;line-height:1.55;white-space:normal;word-break:break-word}
.dglm-pop h4{margin:0 0 8px;font-size:12px;font-weight:600;color:var(--dsw-alias-label-primary);display:flex;align-items:center;justify-content:space-between;gap:8px}
.dglm-win{margin:6px 0 10px}
.dglm-win .dglm-row1{display:flex;justify-content:space-between;gap:8px;color:var(--dsw-alias-label-secondary)}
.dglm-win .dglm-row2{display:flex;align-items:center;gap:8px;margin-top:4px}
.dglm-win .dglm-bar2{position:relative;flex:1;height:5px;border-radius:3px;background:var(--dsw-alias-border-l2);overflow:hidden}
.dglm-win .dglm-bar2>i{position:absolute;top:0;bottom:0;left:0;border-radius:3px;transition:width .4s ease,background-color .4s ease}
.dglm-sep{height:1px;background:var(--dsw-alias-border-l2);margin:8px 0}
.dglm-kv{display:flex;justify-content:space-between;align-items:center;gap:8px;margin:2px 0}
.dglm-kv b{font-weight:500;color:var(--dsw-alias-label-primary);text-align:right}
.dglm-foot{display:flex;justify-content:space-between;align-items:center;margin-top:8px;color:var(--dsw-alias-label-tertiary);font-size:11px}
.dglm-btn{border:1px solid var(--dsw-alias-border-l2);background:transparent;color:var(--dsw-alias-label-secondary);border-radius:6px;font-size:11px;padding:2px 10px;cursor:pointer;white-space:nowrap}
.dglm-btn:hover:not(:disabled){color:var(--dsw-alias-label-primary);background:var(--dsw-alias-bg-layer-1)}
.dglm-btn:disabled{opacity:.5;cursor:default}
.dglm-btn.is-primary{border-color:var(--dsw-alias-state-business-primary,#4f6ef7);color:var(--dsw-alias-state-business-primary,#4f6ef7)}
.dglm-warn{margin:6px 0 0;font-size:11px;color:var(--dsw-alias-state-error-primary,#dc2626)}
.dglm-ok{margin:6px 0 0;font-size:11px;color:var(--dsw-alias-state-ok-primary,#16a34a)}
.dglm-sub{color:var(--dsw-alias-label-tertiary);margin-top:2px}
.dglm-bridge{position:fixed;height:8px;z-index:9999}
.dglm-modal{position:absolute;inset:0;background:rgba(0,0,0,.38);border-radius:10px;display:flex;align-items:center;justify-content:center;z-index:3}
.dglm-modal-card{background:var(--dsw-alias-bg-layer-1);border:1px solid var(--dsw-alias-border-l2);border-radius:8px;padding:12px;width:88%;box-shadow:0 6px 20px rgba(0,0,0,.2)}
.dglm-modal-title{font-size:12px;font-weight:600;margin-bottom:6px;color:var(--dsw-alias-label-primary)}
.dglm-modal-body{font-size:12px;line-height:1.6;color:var(--dsw-alias-label-secondary);margin-bottom:10px}
.dglm-modal-actions{display:flex;justify-content:flex-end;gap:8px}
`;

		/** 幂等注入样式（本包唯一的全局 DOM 副作用） */
		function injectCss() {
			if (document.getElementById('dglm-style')) return;
			const tag = document.createElement('style');
			tag.id = 'dglm-style';
			tag.textContent = CSS;
			document.head.appendChild(tag);
		}

		/**
		 * 剩余百分比 → 颜色档位：≥60% 绿 / 20-59% 橙 / <20% 红。
		 * 全部带字面量兜底（主题 token 缺失也能绘制）。
		 */
		function levelColor(remainPercent) {
			if (typeof remainPercent !== 'number') return 'var(--dsw-alias-state-ok-primary,#16a34a)';
			if (remainPercent < 20) return 'var(--dsw-alias-state-error-primary,#dc2626)';
			if (remainPercent < 60) return 'var(--dsw-alias-state-warning-primary,#d97706)';
			return 'var(--dsw-alias-state-ok-primary,#16a34a)';
		}

		/** epoch ms → 倒计时文案；已过期返回「即将重置」 */
		function countdown(resetAt, now) {
			if (typeof resetAt !== 'number') return '';
			const diff = resetAt - now;
			if (diff <= 0) return '即将重置';
			const minutes = Math.floor(diff / 60000);
			const days = Math.floor(minutes / 1440);
			const hours = Math.floor((minutes % 1440) / 60);
			const mins = minutes % 60;
			if (days > 0) return `${days}天${hours}小时`;
			if (hours > 0) return `${hours}小时${mins}分`;
			return `${Math.max(mins, 1)}分钟`;
		}

		/** epoch ms → 本地短时间（今天内 HH:mm，否则 MM-dd HH:mm） */
		function shortTime(resetAt, now) {
			if (typeof resetAt !== 'number') return '';
			const d = new Date(resetAt);
			const pad = (n) => String(n).padStart(2, '0');
			const hm = `${pad(d.getHours())}:${pad(d.getMinutes())}`;
			if (d.toDateString() === new Date(now).toDateString()) return hm;
			return `${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${hm}`;
		}

		/** epoch ms → 日期（MM-dd）或带时间的短格式 */
		function shortDate(ms, now) {
			if (typeof ms !== 'number') return '—';
			const d = new Date(ms);
			const pad = (n) => String(n).padStart(2, '0');
			return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
		}

		/** 剩余百分比（0-100）：100 - 已用百分比，缺失返回 null */
		function remainingPercent(win) {
			if (!win || typeof win.usedPercent !== 'number') return null;
			return Math.max(0, Math.min(100, 100 - win.usedPercent));
		}

		/** credits 明细文案："剩余 1430 / 2000 积分" */
		function creditsText(win) {
			const rem = win?.remainingCredits ?? null;
			const total = win?.totalCredits ?? null;
			if (rem === null && total === null) return '';
			if (total !== null) return `剩余 ${rem ?? '?'} / ${total} 积分`;
			return `剩余 ${rem ?? '?'} 积分`;
		}

		/** 悬浮窗内的单个窗口行（进度条填充 = 剩余量） */
		function WindowRow({ title, win, now }) {
			if (!win) return null;
			const remPct = remainingPercent(win);
			const fill = remPct === null ? 0 : remPct;
			const detail = creditsText(win);
			const resetBits = [];
			if (win.resetAt !== null) {
				const cd = countdown(win.resetAt, now);
				const st = shortTime(win.resetAt, now);
				if (cd) resetBits.push(cd);
				if (st) resetBits.push(st + ' 重置');
			}
			return hh(
				'div',
				{ className: 'dglm-win' },
				hh(
					'div',
					{ className: 'dglm-row1' },
					hh('span', null, title),
					hh('span', { style: { color: levelColor(remPct) } }, remPct === null ? '—' : `剩余 ${remPct}%`),
				),
				hh(
					'div',
					{ className: 'dglm-row2' },
					hh(
						'div',
						{ className: 'dglm-bar2' },
						hh('i', { style: { width: `${fill}%`, background: levelColor(remPct) } }),
					),
					hh('span', { style: { color: 'var(--dsw-alias-label-tertiary)' } }, detail || resetBits.join(' · ')),
				),
				detail && resetBits.length > 0
					? hh('div', { className: 'dglm-sub' }, resetBits.join(' · '))
					: null,
			);
		}

		/**
		 * 「剩余额度」芯片（含悬浮详情与重置卡操作）。
		 * 标准注入：session 作用域槽自带 sessionId 与 useSession。
		 */
		function QuotaChip(props) {
			const sessionId = props?.sessionId;
			const useSession = typeof props?.useSession === 'function' ? props.useSession : null;

			const [state, setState] = useState(null);
			const [offline, setOffline] = useState(false);
			const [open, setOpen] = useState(false);
			const [pos, setPos] = useState(null);
			const [refreshing, setRefreshing] = useState(false);
			const [confirming, setConfirming] = useState(null); // 'fiveHours' | 'week'
			const [resetting, setResetting] = useState(false);
			const [resetNote, setResetNote] = useState(null); // {kind:'ok'|'err', text}
			const [, setTick] = useState(0);
			const chipRef = useRef(null);
			const autoLastRef = useRef(0);
			const manualLastRef = useRef(0);
			const closeTimerRef = useRef(null);

			// 回合运行状态（SSE 失效时的兜底自动刷新信号）
			const running = useSession
				? (useSession((s) => (s == null ? false : Boolean(s.running))) ?? false)
				: false;

			const load = useCallback(
				async (force) => {
					try {
						const q = force ? '&refresh=1' : '';
						const r = await fetch(`${STATUS_URL}?sessionId=${encodeURIComponent(sessionId ?? '')}${q}`, {
							cache: 'no-store',
						});
						if (!r.ok) throw new Error(`宿主路由 HTTP ${r.status}`);
						const j = await r.json();
						if (j && j.ok) {
							setState(j);
							setOffline(false);
						}
					} catch (e) {
						setOffline(true);
						console.warn('[dsh-glm-quota] status 拉取失败:', e);
					}
				},
				[sessionId],
			);

			/** 自动刷新（回合结束等）：60s 保底间隔 */
			const autoRefresh = useCallback(() => {
				if (Date.now() - autoLastRef.current < AUTO_REFRESH_MIN_MS) return;
				autoLastRef.current = Date.now();
				void load(true);
			}, [load]);

			// 挂载拉取一次
			useEffect(() => {
				void load(false);
			}, [load]);

			// SSE：selection → 轻拉取（显隐即时同步）；turn-end → 自动刷新
			useEffect(() => {
				if (typeof EventSource === 'undefined' || !sessionId) return undefined;
				let es;
				try {
					es = new EventSource(`${EVENTS_URL}?sessionId=${encodeURIComponent(sessionId)}`);
				} catch {
					return undefined;
				}
				const onSelection = () => {
					void load(false);
				};
				const onTurnEnd = () => {
					autoRefresh();
				};
				es.addEventListener('selection', onSelection);
				es.addEventListener('turn-end', onTurnEnd);
				return () => {
					es.removeEventListener('selection', onSelection);
					es.removeEventListener('turn-end', onTurnEnd);
					es.close();
				};
			}, [sessionId, load, autoRefresh]);

			// 兜底：useSession 的 running 下降沿（SSE 断开时仍能自动刷新）
			const prevRunningRef = useRef(false);
			useEffect(() => {
				const prev = prevRunningRef.current;
				prevRunningRef.current = running;
				if (prev && !running) autoRefresh();
			}, [running, autoRefresh]);

			// 悬浮窗倒计时本地重绘（纯渲染）
			useEffect(() => {
				const timer = setInterval(() => setTick((x) => x + 1), COUNTDOWN_TICK_MS);
				return () => clearInterval(timer);
			}, []);

			// ---- 悬停交互：宽限定时器 + 桥接，鼠标可移入弹窗 ----
			const cancelClose = useCallback(() => {
				if (closeTimerRef.current !== null) {
					clearTimeout(closeTimerRef.current);
					closeTimerRef.current = null;
				}
			}, []);
			const scheduleClose = useCallback(() => {
				cancelClose();
				closeTimerRef.current = setTimeout(() => setOpen(false), HOVER_GRACE_MS);
			}, [cancelClose]);
			useEffect(() => cancelClose, [cancelClose]);

			// 悬浮期间页面滚动/缩放即关闭，避免固定定位漂移
			useEffect(() => {
				if (!open) return undefined;
				const close = () => setOpen(false);
				window.addEventListener('scroll', close, true);
				window.addEventListener('resize', close);
				return () => {
					window.removeEventListener('scroll', close, true);
					window.removeEventListener('resize', close);
				};
			}, [open]);

			const visible = state ? Boolean(state.visible) : false;
			if (!visible) return null;
			if (!state) {
				if (!offline) return null;
				return hh('span', { className: 'dglm-chip is-error', title: 'dsh-glm-quota: status 不可达' }, 'GLM 额度离线');
			}

			const snapshot = state.snapshot;
			const error = state.error ?? snapshot?.error;

			if (error) {
				const label =
					error === 'credential-missing'
						? 'GLM Key 未配置'
						: error === 'no-plan'
							? '无 Coding Plan'
							: '额度获取失败';
				return hh('span', { className: 'dglm-chip is-error', title: 'dsh-glm-quota: ' + label }, label);
			}
			if (!snapshot) return null;

			const { fiveHours, week } = snapshot.windows ?? {};
			const rems = [remainingPercent(fiveHours), remainingPercent(week)].filter((v) => typeof v === 'number');
			const chipRemain = rems.length > 0 ? Math.min(...rems) : null;

			const openPop = () => {
				cancelClose();
				const rect = chipRef.current?.getBoundingClientRect();
				if (rect) {
					// 与芯片顶边零空隙（popover 底边 = 芯片顶边），鼠标可连续移入
					const top = rect.top;
					const left = Math.max(8, Math.min(rect.right - POP_WIDTH, window.innerWidth - POP_WIDTH - 8));
					setPos({ top, left, chipLeft: rect.left, chipWidth: rect.width });
				}
				setOpen(true);
			};

			const now = Date.now();
			const plan = snapshot.plan;
			const balance = snapshot.balance;
			const resets = Array.isArray(snapshot.resets) ? snapshot.resets : [];

			const manualRefresh = () => {
				if (refreshing) return;
				if (now - manualLastRef.current < REFRESH_COOLDOWN_MS) return;
				manualLastRef.current = now;
				setRefreshing(true);
				void load(true).finally(() => setRefreshing(false));
			};

			// ---- 重置卡 ----
			const resetWindows = [
				{ key: 'fiveHours', resetType: 'FIVE_HOUR', label: '5 小时窗口', cards: resets.filter((c) => c.resetType === 'FIVE_HOUR') },
				{ key: 'week', resetType: 'WEEK', label: '周窗口', cards: resets.filter((c) => c.resetType === 'WEEK') },
			];
			const confirmMeta =
				confirming === 'fiveHours'
					? { label: '5 小时窗口', desc: '5 小时滚动窗口' }
					: confirming === 'week'
						? { label: '周窗口', desc: '每周用量窗口' }
						: null;

			const beginConfirm = (key) => {
				setResetNote(null);
				setConfirming(key);
			};
			const doReset = () => {
				if (resetting || !confirming) return;
				setResetting(true);
				setResetNote(null);
				fetch(RESET_URL, {
					method: 'POST',
					headers: { 'Content-Type': 'application/json' },
					body: JSON.stringify({ sessionId, window: confirming }),
				})
					.then(async (r) => {
						const j = await r.json().catch(() => null);
						if (j && j.ok) {
							setState((s) => (s ? { ...s, snapshot: j.snapshot } : s));
							setResetNote({ kind: 'ok', text: '重置成功，额度已刷新' });
							autoLastRef.current = Date.now();
							setTimeout(() => {
								setConfirming(null);
								setResetNote(null);
							}, 1200);
						} else {
							setResetNote({ kind: 'err', text: (j && j.message) || '重置失败，请稍后重试' });
						}
					})
					.catch((e) => {
						setResetNote({ kind: 'err', text: String(e && e.message ? e.message : e) });
					})
					.finally(() => {
						setResetting(false);
					});
			};

			// ---- 悬浮窗 children ----
			const popChildren = [
				hh(
					'h4',
					null,
					hh('span', null, plan?.name ? `GLM Coding Plan · ${plan.name}` : 'GLM Coding Plan'),
					hh(
						'span',
						{ style: { fontWeight: 400, fontSize: 11, color: 'var(--dsw-alias-label-tertiary)' } },
						String(state.provider ?? ''),
					),
				),
				hh(WindowRow, { title: '5 小时窗口', win: fiveHours, now }),
				hh(WindowRow, { title: '周窗口', win: week, now }),
			];

			if (plan || balance) popChildren.push(hh('div', { className: 'dglm-sep' }));
			if (plan) {
				popChildren.push(
					hh(
						'div',
						null,
						hh(
							'div',
							{ className: 'dglm-kv' },
							hh('span', { style: { color: 'var(--dsw-alias-label-secondary)' } }, '套餐到期'),
							hh('b', null, plan.periodEnd ?? plan.nextRenewAt ?? '—'),
						),
						hh(
							'div',
							{ className: 'dglm-kv' },
							hh('span', { style: { color: 'var(--dsw-alias-label-secondary)' } }, '自动续费'),
							hh('b', null, plan.autoRenew ? `开启（下期 ${plan.nextRenewAt ?? '—'}）` : '关闭'),
						),
					),
				);
			}
			if (balance) {
				popChildren.push(
					hh(
						'div',
						{ className: 'dglm-kv' },
						hh('span', { style: { color: 'var(--dsw-alias-label-secondary)' } }, '现金余额'),
						hh('b', null, `¥${balance.available}`),
					),
				);
			}

			// ---- 重置卡区块 ----
			popChildren.push(hh('div', { className: 'dglm-sep' }));
			popChildren.push(
				hh('div', { className: 'dglm-kv' }, hh('span', { style: { color: 'var(--dsw-alias-label-secondary)' } }, '重置机会')),
			);
			for (const rw of resetWindows) {
				const earliest = rw.cards.reduce(
					(min, c) => Math.min(min, typeof c.expiresAtMs === 'number' ? c.expiresAtMs : Number.POSITIVE_INFINITY),
					Number.POSITIVE_INFINITY,
				);
				const hasCard = rw.cards.length > 0;
				popChildren.push(
					hh(
						'div',
						{ className: 'dglm-kv' },
						hh(
							'span',
							{ style: { color: 'var(--dsw-alias-label-secondary)' } },
							hasCard
								? `${rw.label} ×${rw.cards.length}${earliest !== Number.POSITIVE_INFINITY ? ` · 截止 ${shortDate(earliest, now)}` : ''}`
								: `${rw.label} 无可用卡`,
						),
						hh(
							'button',
							{
								className: 'dglm-btn is-primary',
								type: 'button',
								disabled: !hasCard || resetting,
								onClick: () => beginConfirm(rw.key),
								title: hasCard ? `消耗 1 张重置卡，立即清零${rw.label}用量` : '没有可使用的重置卡',
							},
							'重置',
						),
					),
				);
			}

			for (const w of snapshot.warnings ?? []) {
				popChildren.push(hh('div', { className: 'dglm-warn' }, w));
			}
			popChildren.push(
				hh(
					'div',
					{ className: 'dglm-foot' },
					hh('span', null, snapshot.fetchedAt ? `更新于 ${shortTime(snapshot.fetchedAt, now)}` : ''),
					hh(
						'button',
						{
							className: 'dglm-btn',
							type: 'button',
							disabled: refreshing,
							onClick: manualRefresh,
							title: '立即重新查询（30 秒冷却）',
						},
						refreshing ? '查询中…' : '刷新',
					),
				),
			);

			return hh(
				'span',
				{
					className: 'dglm-chip',
					ref: chipRef,
					onMouseEnter: openPop,
					onMouseLeave: scheduleClose,
				},
				hh('span', null, '剩余额度'),
				hh(
					'span',
					{ style: { fontWeight: 600, color: levelColor(chipRemain) } },
					chipRemain === null ? '—' : `${chipRemain}%`,
				),
				hh(
					'span',
					{ className: 'dglm-bar' },
					hh('i', {
						style: {
							width: chipRemain === null ? '0%' : `${chipRemain}%`,
							background: levelColor(chipRemain),
						},
					}),
				),
				open && pos
					? hh(
							'div',
							{
								className: 'dglm-pop',
								style: { top: pos.top, left: pos.left, transform: 'translateY(-100%)' },
								onMouseEnter: cancelClose,
								onMouseLeave: scheduleClose,
								onClick: (e) => e.stopPropagation(),
							},
							...popChildren,
							// 确认弹窗（popover 内覆盖层）
							confirmMeta
								? hh(
										'div',
										{ className: 'dglm-modal' },
										hh(
											'div',
											{ className: 'dglm-modal-card' },
											hh('div', { className: 'dglm-modal-title' }, `重置${confirmMeta.label}？`),
											hh(
												'div',
												{ className: 'dglm-modal-body' },
												`将立即消耗 1 张${confirmMeta.label}重置卡，${confirmMeta.desc}的已用量清零（剩余额度恢复满额）。此操作不可撤销。`,
											),
											resetNote
												? hh(
														'div',
														{ className: resetNote.kind === 'ok' ? 'dglm-ok' : 'dglm-warn' },
														resetNote.text,
													)
												: null,
											hh(
												'div',
												{ className: 'dglm-modal-actions' },
												hh(
													'button',
													{
														className: 'dglm-btn',
														type: 'button',
														disabled: resetting,
														onClick: () => {
															setConfirming(null);
															setResetNote(null);
														},
													},
													'取消',
												),
												hh(
													'button',
													{
														className: 'dglm-btn is-primary',
														type: 'button',
														disabled: resetting,
														onClick: doReset,
													},
													resetting ? '处理中…' : '确认重置',
												),
											),
										),
									)
								: null,
						)
					: null,
				// 隐形桥接条：覆盖芯片与弹窗之间的过渡带（零空隙之外的保险）
				open && pos
					? hh('span', {
							className: 'dglm-bridge',
							style: { top: pos.top - 8, left: pos.chipLeft, width: pos.chipWidth },
							onMouseEnter: cancelClose,
							onMouseLeave: scheduleClose,
						})
					: null,
			);
		}

		const name = 'glm-quota';
		const inject = ['slots'];

		// eslint-disable-next-line @typescript-eslint/no-explicit-any -- DSH 注入的 ctx（slots 服务无静态类型）
		function apply(ctx) {
			console.info('[dsh-glm-quota] client apply：注册 conversation.input.right 芯片');
			injectCss();
			ctx.slots.inject('conversation.input.right', function* () {
				try {
					yield ctx.slots.register(
						{ name: 'conversation.input.right', id: 'glm-quota', order: 100 },
						QuotaChip,
					);
					console.info('[dsh-glm-quota] 芯片已注册');
				} catch (e) {
					console.error('[dsh-glm-quota] 槽位注册失败:', e);
				}
			});
		}

		module.exports = { name, inject, apply };
		return module.exports;
	},
});
