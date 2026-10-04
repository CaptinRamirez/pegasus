# Pegasus

单用户自用的加密货币永续合约手动交易终端，接 OKX。React 前端 + Node/TypeScript 后端，pnpm monorepo。

```
pegasus/
├── apps/
│   ├── api/          Fastify 后端：OKX 行情/账户接入、风控、下单、WebSocket 推送、持久化
│   └── web/          React + Vite 交易终端（K 线、盘口、成交、下单面板、持仓、风控面板、信号面板）
├── packages/
│   ├── shared/       前后端共享的领域类型、zod 校验、WS 协议、合约张数/价格换算
│   ├── okx/          OKX v5 REST + WebSocket 客户端（签名、登录、心跳、重连、重订阅、按 seqId 校验盘口连续性）
│   └── mock-okx/     本地模拟的 OKX 交易所（REST + WS + 撮合），离线开发和端到端测试用
├── docs/api.md       前后端接口契约
├── docker-compose.yml  Postgres（可选）
└── .env.example
```

## 设计要点

- **所有金额都是十进制字符串**，计算用 decimal.js，数据库用 NUMERIC。代码里不用 JS `number` 算钱。
- **OKX 的 `sz` 是张数**。`packages/shared/src/sizing.ts` 负责币数 / USDT 名义 ↔ 张数的换算，按 `lotSz` 向下取整并校验 `minSz`、`maxLmtSz`、`maxMktSz`。前端预览和后端下单用同一套逻辑。
- **风控在后端强制执行**（`apps/api/src/services/risk-engine.ts`）：单笔名义上限、单品种和总持仓名义上限、杠杆上限、限价偏离标记价带宽、市价单预估滑点上限、挂单数上限、日内亏损熔断（UTC 0 点重置），以及手动 kill switch。kill switch 打开时拒绝新的开仓单（平仓/减仓单仍可下），并撤掉账户的全部挂单（每次打开熔断撤一次，条件单不在其内；撤完之后再挂的平仓单会保留，熔断期间重启也不会再撤，上次没撤完的才会在重启后继续撤）；**只读 key 无法撤单**，这时不会撤掉任何挂单，页面会提示到 OKX 上自行撤单。kill switch 和当日权益基准保存在 `data/pegasus-state.json`，关掉再打开不会丢；手动熔断不会自己解除。亏损熔断还在生效时解除需要二次确认，确认后以当前权益为新的基准重新计算（用于资金划出这类不是交易亏损的情况）。
- **状态以交易所为准**：私有 WS 推送订单、持仓、账户；每 60 秒及每次重连后用 REST 对账。
- **API key 只在后端**，通过 `.env` 读取。前端用一个共享 token（`API_TOKEN`）访问后端，后端默认只监听 127.0.0.1，并且只接受发往本机（localhost / 127.0.0.1）且来自 `WEB_ORIGINS` 所列页面地址的请求。页面必须用 http://localhost:5174 或 http://127.0.0.1:5174 打开，否则下单和实时推送会被拒绝（403）。
- **先跑模拟盘**：`OKX_DEMO=1` 使用 OKX 模拟交易（REST 加 `x-simulated-trading: 1`，WS 走 `wspap.okx.com`）。

## 快速开始

环境：Node ≥ 22，pnpm 10（`corepack enable` 即可）。

```bash
pnpm install
cp .env.example .env        # 填 OKX_API_KEY / SECRET / PASSPHRASE，API_TOKEN 改成随机串
```

### 一键启动

```bash
pnpm start        # Windows 上也可以直接双击 start.bat
```

先构建前端页面，再按 `.env` 的配置依次启动后端和前端，就绪后自动打开浏览器（http://localhost:5174）。关闭窗口或 Ctrl+C 停止全部服务。打开页面后输入 `.env` 里的 `API_TOKEN`。

启动时窗口里会打印这次启动所用的代码版本（git 提交号），`GET /api/health` 的 `version` 也是它。页面和后端都是启动那一刻的代码：运行中 `git pull` 不会改变正在运行的任何一半，**更新代码后要关掉窗口重新启动**才生效。前端构建失败时启动器会直接说明并退出，不会启动任何服务。

启动参数（`pnpm start` 和 `start.bat` 通用，例如 `pnpm start --mock`、`start.bat --mock`）：

| 参数 | 作用 |
| --- | --- |
| `--mock` | 不连 OKX，改用本地模拟交易所（见方式一） |
| `--dev` | 开发模式：前端用 Vite 开发服务器（改代码即时刷新），不做构建 |
| `--no-open` | 不自动打开浏览器 |

启动时连不上 OKX（网络或代理问题）会重试三次，仍失败就用一句话说明并退出。日志除了显示在窗口里，也会写到 `logs/pegasus-日期.log`（保留最近 14 个），关掉窗口之后还能查看。

### 方式一：离线，用本地 mock 交易所

不需要 OKX 账号，也不需要外网：

```bash
pnpm start --mock      # Windows：在项目目录的命令行里运行 start.bat --mock
```

`--mock` 只在这一次启动里把 OKX 地址指向本机的模拟交易所（端口 9100）、换成模拟 key，并把合约限定为 mock 支持的 `BTC-USDT-SWAP` 和 `ETH-USDT-SWAP`。**它不读写 `.env` 里的 key，也不需要改 `.env`**，所以不要把 mock 的变量写进存着实盘 key 的 `.env`。模拟账户的熔断状态单独存在 `data/pegasus-state.mock.json`，不会和真实账户的混在一起。

### 方式二：OKX 模拟盘

1. 在 OKX 网页右上角切到「模拟交易」，在模拟交易的 API 管理里创建一个 API key（勾选交易权限）。模拟盘的 key 和实盘的 key 是分开的。
2. `.env` 里填 key，并保持 `OKX_DEMO=1`。
3. `pnpm start`。

### 方式三：实盘

把 `OKX_DEMO=0`，换成实盘 key，`pnpm start`。启动日志会打印 `LIVE TRADING MODE`。建议先把 `RISK_*` 调小。只读 key 也可以用：能看行情和账户，不能从 Pegasus 下单、撤单。

### 单独调试某一个服务（开发用）

`pnpm dev:mock`、`pnpm dev:api`、`pnpm dev:web` 分别启动模拟交易所、后端（改代码自动重启）和前端开发服务器。要让单独启动的后端连 mock，需要把四个地址变量一起设好（只设其中几个会被拒绝启动），PowerShell 写法：

```powershell
$env:OKX_REST_URL = 'http://127.0.0.1:9100'
$env:OKX_WS_PUBLIC_URL = 'ws://127.0.0.1:9100/ws/v5/public'
$env:OKX_WS_PRIVATE_URL = 'ws://127.0.0.1:9100/ws/v5/private'
$env:OKX_WS_BUSINESS_URL = 'ws://127.0.0.1:9100/ws/v5/business'
$env:OKX_API_KEY = 'mock'; $env:OKX_API_SECRET = 'mock'; $env:OKX_API_PASSPHRASE = 'mock'
$env:INSTRUMENTS = 'BTC-USDT-SWAP,ETH-USDT-SWAP'
pnpm dev:api
```

这些变量只在当前命令行窗口里有效，同样不要写进 `.env`。

### 持久化

不配 `DATABASE_URL` 时订单流水只在内存里（重启后从 OKX 重新读取当前挂单和持仓）；kill switch 和当日权益基准保存在 `data/pegasus-state.json`（可用 `STATE_FILE` 改位置），同一个 UTC 日内重启后熔断和当日亏损照旧，跨日后自动的亏损熔断解除、手动熔断保留。这个文件损坏时后端会以 kill switch 打开的状态启动，需要手动解除。要把订单流水落库：

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
| `SIGNAL_PHASES` | SIGNALS 面板计算的日线切点（UTC 小时），`0`、`12` 或 `0,12`（默认）。每个切点按 1/n 个单位算仓位：两个切点时同一标的分两笔各半仓 |
| `OKX_WS_TRADING` | 保持 `0`（用 REST 下单撤单）。设为 `1` 会被拒绝启动：OKX 已弃用 WebSocket 下单接口的 `instId` 参数，Pegasus 尚未迁移到 `instIdCode` |
| `OKX_REST_URL` 等四个地址变量 | 只在连 mock 时需要，四个必须一起设或都不设；一般用 `--mock` 即可，不必手动设 |
| `API_TOKEN` | 前端访问后端的共享密钥 |
| `WEB_ORIGINS` | 允许访问后端的页面地址（逗号分隔，精确匹配），默认 `http://localhost:5174,http://127.0.0.1:5174`；只有把页面改到别的地址或端口时才需要改 |
| `STATE_FILE` | 保存 kill switch 和当日权益基准的文件，默认 `data/pegasus-state.json`（相对项目目录） |
| `LOG_DIR` | 日志目录，默认 `logs`（相对项目目录），每天一个文件，保留最近 14 个 |
| `RISK_MAX_ORDER_NOTIONAL` | 单笔最大名义（USD） |
| `RISK_MAX_POSITION_NOTIONAL_PER_INSTRUMENT` | 单品种最大持仓名义 |
| `RISK_MAX_TOTAL_POSITION_NOTIONAL` | 总持仓名义上限 |
| `RISK_MAX_LEVERAGE` | 允许的最大杠杆 |
| `RISK_DAILY_LOSS_LIMIT` | 日内亏损熔断（权益相对当日基准的回撤；基准是当日 UTC 0 点后第一次读到的权益，当天第一次启动得晚就从那时算起，风控面板会标出 “since HH:MM UTC”） |
| `RISK_MAX_OPEN_ORDERS` | 最大挂单数 |
| `RISK_PRICE_BAND_PCT` | 限价相对标记价允许的偏离，小数（`0.05` 即 5%），必须小于 1 |
| `RISK_MAX_SLIPPAGE_PCT` | 市价单按盘口预估的最大滑点，小数（`0.005` 即 0.5%），必须小于 1 |

账户的持仓模式（净持仓 / 双向持仓）从 OKX 账户配置读取，双向模式下下单必须带 `posSide`。

## 常用命令

```bash
pnpm typecheck   # 所有包类型检查
pnpm test        # 所有包单元测试 / 端到端测试（端到端用 mock 交易所）
pnpm build       # 前端构建
pnpm backtest    # 用实盘同一份信号代码回测 BTC、ETH（约两分钟；--help 看全部参数）
```

## 接口

前后端契约见 `docs/api.md`。后端 REST 在 `/api/*`，实时推送在 `/ws?token=...`。

## 已知限制 / 下一步

- 只支持 SWAP（永续）；交割、期权、现货未接。
- 自动策略引擎未实现（第二期）。
- 前端为桌面宽度设计。
