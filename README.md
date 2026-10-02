# Pegasus

单用户自用的加密货币永续合约手动交易终端，接 OKX。React 前端 + Node/TypeScript 后端，pnpm monorepo。

```
pegasus/
├── apps/
│   ├── api/          Fastify 后端：OKX 行情/账户接入、风控、下单、WebSocket 推送、持久化
│   └── web/          React + Vite 交易终端（K 线、盘口、成交、下单面板、持仓、风控面板）
├── packages/
│   ├── shared/       前后端共享的领域类型、zod 校验、WS 协议、合约张数/价格换算
│   ├── okx/          OKX v5 REST + WebSocket 客户端（签名、登录、心跳、重连、重订阅、盘口校验和）
│   └── mock-okx/     本地模拟的 OKX 交易所（REST + WS + 撮合），离线开发和端到端测试用
├── docs/api.md       前后端接口契约
├── docker-compose.yml  Postgres（可选）
└── .env.example
```

## 设计要点

- **所有金额都是十进制字符串**，计算用 decimal.js，数据库用 NUMERIC。代码里不用 JS `number` 算钱。
- **OKX 的 `sz` 是张数**。`packages/shared/src/sizing.ts` 负责币数 / USDT 名义 ↔ 张数的换算，按 `lotSz` 向下取整并校验 `minSz`、`maxLmtSz`、`maxMktSz`。前端预览和后端下单用同一套逻辑。
- **风控在后端强制执行**（`apps/api/src/services/risk-engine.ts`）：单笔名义上限、单品种和总持仓名义上限、杠杆上限、限价偏离标记价带宽、市价单预估滑点上限、挂单数上限、日内亏损熔断（UTC 0 点重置），以及手动 kill switch。kill switch 打开时拒绝新单并撤掉全部挂单。
- **状态以交易所为准**：私有 WS 推送订单、持仓、账户；每 60 秒及每次重连后用 REST 对账。
- **API key 只在后端**，通过 `.env` 读取。前端用一个共享 token（`API_TOKEN`）访问后端，后端默认只监听 127.0.0.1。
- **先跑模拟盘**：`OKX_DEMO=1` 使用 OKX 模拟交易（REST 加 `x-simulated-trading: 1`，WS 走 `wspap.okx.com`）。

## 快速开始

环境：Node ≥ 22，pnpm 10（`corepack enable` 即可）。

```bash
pnpm install
cp .env.example .env        # 填 OKX_API_KEY / SECRET / PASSPHRASE，API_TOKEN 改成随机串
```

### 方式一：离线，用本地 mock 交易所

不需要 OKX 账号，也不需要外网。

```bash
# 终端 1：模拟交易所（默认 http://127.0.0.1:9100）
pnpm dev:mock

# 终端 2：后端，把 OKX 地址指到 mock
OKX_REST_URL=http://127.0.0.1:9100 \
OKX_WS_PUBLIC_URL=ws://127.0.0.1:9100/ws/v5/public \
OKX_WS_PRIVATE_URL=ws://127.0.0.1:9100/ws/v5/private \
OKX_WS_BUSINESS_URL=ws://127.0.0.1:9100/ws/v5/business \
OKX_API_KEY=mock OKX_API_SECRET=mock OKX_API_PASSPHRASE=mock \
pnpm dev:api

# 终端 3：前端 http://localhost:5173
pnpm dev:web
```

打开页面后输入 `.env` 里的 `API_TOKEN`。

### 方式二：OKX 模拟盘

1. 在 OKX 网页右上角切到「模拟交易」，在模拟交易的 API 管理里创建一个 API key（勾选交易权限）。模拟盘的 key 和实盘的 key 是分开的。
2. `.env` 里填 key，并保持 `OKX_DEMO=1`。
3. `pnpm dev:api` 和 `pnpm dev:web`。

### 方式三：实盘

把 `OKX_DEMO=0`，换成实盘 key。启动日志会打印 `LIVE TRADING MODE`。建议先把 `RISK_*` 调小。

### 持久化（可选）

不配 `DATABASE_URL` 时订单流水和风控状态只在内存里。要落库：

```bash
docker compose up -d postgres
echo 'DATABASE_URL=postgres://pegasus:pegasus@127.0.0.1:5432/pegasus' >> .env
pnpm db:migrate
```

## 配置

见 `.env.example`。关键项：

| 变量 | 说明 |
| --- | --- |
| `OKX_DEMO` | `1` 模拟盘，`0` 实盘 |
| `INSTRUMENTS` | 启动时跟踪的合约，逗号分隔，例如 `BTC-USDT-SWAP,ETH-USDT-SWAP` |
| `DEFAULT_TD_MODE` | 默认保证金模式 `cross` / `isolated` |
| `OKX_WS_TRADING` | `1` 用私有 WebSocket 下单撤单（延迟更低），`0` 用 REST（默认） |
| `API_TOKEN` | 前端访问后端的共享密钥 |
| `RISK_MAX_ORDER_NOTIONAL` | 单笔最大名义（USD） |
| `RISK_MAX_POSITION_NOTIONAL_PER_INSTRUMENT` | 单品种最大持仓名义 |
| `RISK_MAX_TOTAL_POSITION_NOTIONAL` | 总持仓名义上限 |
| `RISK_MAX_LEVERAGE` | 允许的最大杠杆 |
| `RISK_DAILY_LOSS_LIMIT` | 日内亏损熔断（权益相对当日 UTC 0 点基准的回撤） |
| `RISK_MAX_OPEN_ORDERS` | 最大挂单数 |
| `RISK_PRICE_BAND_PCT` | 限价相对标记价允许的偏离 |
| `RISK_MAX_SLIPPAGE_PCT` | 市价单按盘口预估的最大滑点 |

账户的持仓模式（净持仓 / 双向持仓）从 OKX 账户配置读取，双向模式下下单必须带 `posSide`。

## 常用命令

```bash
pnpm typecheck   # 所有包类型检查
pnpm test        # 所有包单元测试 / 端到端测试（端到端用 mock 交易所）
pnpm build       # 前端构建
```

## 接口

前后端契约见 `docs/api.md`。后端 REST 在 `/api/*`，实时推送在 `/ws?token=...`。

## 已知限制 / 下一步

- 只支持 SWAP（永续）；交割、期权、现货未接。
- 自动策略引擎未实现（第二期）。
- 前端为桌面宽度设计。
