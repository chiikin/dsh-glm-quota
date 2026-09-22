# dsh-glm-quota

GLM Coding Plan（智谱 bigmodel.cn 订阅套餐）配额显示插件，适用于 DeepSeek Harness（DSH）Web UI。

> **English**: A DeepSeek Harness (DSH) plugin that shows your GLM Coding Plan quota — 5-hour / weekly credit windows, plan expiry, reset cards and cash balance — as a compact chip left of the model selector in the composer. Zero-config for personal plans: it reads the key you configured for the `zai-coding-cn` provider. Install with `dsh plugin --profile web add dsh-glm-quota`.

在输入框工具行、**模型选择器的左侧**显示一个「剩余额度」芯片，鼠标悬停展开详情：

- **5 小时窗口 / 周窗口**：剩余百分比、进度条（按剩余量配色：≥60% 绿 / 20-59% 橙 / <20% 红）、剩余/总额度积分、重置时间与倒计时
- **套餐**：名称、当期到期时间、自动续费与下期续费日
- **现金余额**：标准 API 现金账户可用余额（¥）
- 手动刷新按钮（30 秒冷却）；悬浮窗倒计时每 30 秒本地重绘
- **自动刷新无定时轮询**：挂载时拉取一次；**每次会话回合结束自动刷新一次**（60 秒保底间隔）；模型选择变化时立即显隐并刷新（组合提供投影钩子时）

## 特性

- **零配置**：仅当选中的模型供应商为 `zai-coding-cn` 时显示；Key 自动读取「添加模型提供商」时录入的凭证（`ZAI_CODING_CN_API_KEY`），浏览器半侧不接触任何凭证
- **个人套餐免 org/project**：实测查询配额只需 API Key（无需 DevTools 抓 `bigmodel-organization` / `bigmodel-project` 头）；`type` 参数自动探测（个人不带 type，团队以 `type=2` 兜底）
- **事件驱动刷新**：无定时器轮询上游；宿主对上游 60s TTL 缓存（失败 10s），并发去重；刷新时机为挂载、回合结束（`running` 下降沿）、模型切换与手动按钮
- **错误可见**：Key 未配置 / 无 Coding Plan / 上游异常分别显示对应芯片文案，不静默伪造数据

## 安装（DSH profile）

推荐用官方 CLI 安装（自动维护依赖与 bundle 列表）：

```bash
# 从 npm 安装（发布后的包名）
dsh plugin --profile web add dsh-glm-quota

# 或直接从 GitHub 安装（本包是纯 JS、lib/ 随仓库分发，无需构建授权）
dsh plugin --profile web add github:chiikin/dsh-glm-quota

# 或从本地 tarball 安装
pnpm pack   # 生成 dsh-glm-quota-0.1.0.tgz
dsh plugin --profile web add ./dsh-glm-quota-0.1.0.tgz
```

`<profile>` 换成实际的 profile 名（默认 web）。也可以手动安装：在 profile 目录 `pnpm add dsh-glm-quota`，再把下面一段加进 profile 的 `cordis.patch.yml`（用户 patch 层）：

```yaml
- insert:
    - id: glm-quota
      name: 'dsh-glm-quota'
```

安装后重启 DSH（或等待 patch 热重载）生效。

## 工作原理

```
浏览器 (lib/client.js)                     宿主 (lib/index.js)
┌──────────────────────────┐  事件驱动   ┌──────────────────────────────┐
│ conversation.input.right │ ──────────▶ │ GET /dsh-glm-quota/status    │
│ 「剩余额度」芯片+悬浮窗    │  挂载/回合  │  · 会话级供应商判定            │
│ useSession(running 沿)    │  结束/切模型│    (model/selection 事件跟踪, │
└──────────────────────────┘             │    回落 agentDefaultModel)    │
                                         │  · credentials.resolve        │
                                         │    (ZAI_CODING_CN_API_KEY)    │
                                         │  · 60s TTL 缓存 ──▶ open.bigmodel.cn
                                         └──────────────────────────────┘
```

上游端点（非官方公开接口，改版可能失效）：

| 端点 | 用途 |
| --- | --- |
| `GET /api/monitor/usage/quota/limit` | 5h / 周窗口配额 |
| `GET /api/biz/subscription/list` | 套餐名称、到期、自动续费 |
| `GET /api/biz/account/query-customer-account-report` | 现金余额 |

## 已知限制

- 上游为智谱 monitor/biz 网关的非公开接口，官方改版可能导致部分字段缺失（插件按「尽力而为」降级：配额是主信号，订阅/余额失败只显示告警）
- 仅支持中国大陆站（open.bigmodel.cn / bigmodel.cn）；z.ai 国际站路径相同但认证方式为 `Bearer`，暂未适配
- 团队套餐理论上经 `type=2` 兜底可查，但团队上下文头（org/project）未实现——如团队套餐查询为空，需要补充组织上下文支持

## License

MIT
