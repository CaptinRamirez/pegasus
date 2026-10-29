# 交易团队审核报告（2026-10-28）

> 来源：2026-10-28 晚由一个多智能体审核流程产出（4 个读图员、8 个审核角色、合并去重、每条发现 1 到 3 位独立审核员投票、3 轮补漏、交易台主管汇总），共 211 个智能体，全程只读。原始发现 73 条确认、17 条推翻、186 个检查过没问题的点，保存在会话的 workflow 日志里。文中行号对应当时的工作区（含未提交的 10-28 保利润改动）。


一句话结论：程序有 1 个让滚仓池自 10-18 起永远不开仓的缺陷；交易员没有可检验的方法，本周把单笔风险提到 10% 后，按模型自己报的胜率，账户大概率在攒够样本前先亏掉一半；两套实验现在都得不出结论。

## 一、必须改的（会亏钱或会坏）

### 1. 滚仓池在 20 点切点下永远不开仓，停机错过的离场也不补做（严重；来源：10-18 采纳 20 点切点时的程序改动）
会发生什么：每天 20:00 UTC 收盘时，程序判断"是不是日线收盘"用的是 0 点，答案永远是"不是"。入场只在日线收盘才做，所以永远不入场，也不记录跳过。停机后补做错过的收盘时，同样找不到离场信号。
证据：[apps/api/src/services/campaign-step.ts:194](apps/api/src/services/campaign-step.ts#L194) 没传切点；[apps/api/src/services/campaign.ts:643](apps/api/src/services/campaign.ts#L643) 也没传；[apps/api/src/services/campaign-step.ts:375](apps/api/src/services/campaign-step.ts#L375) 补做时没传。账本 cutHour 20，21 步，0 个战役。
审核员更正：正常运行时的离场仍然有效，离场分支不看这个标志。实际后果是入场自 10-18 起失效，20 个战役的验收永远达不到；停机后离场最多晚几天，不会"一直到爆仓"。
最小修改：把切点传进这 2 处，加 1 个 20 点的测试。开发者改。

### 2. 每笔冒 10% 本金，按模型自己的胜率，50 笔之前大概率先亏一半（高；老板 10-27 的规则）
会发生什么：止损比 1.05% 近时，仓位顶到 10 倍上限，约 95% 权益当保证金。第 4 笔就是：保证金 1,010，权益 1,065。模型自报胜率 0.38 到 0.45，盈亏比 1.1 到 2.3，扣费后期望为负。模拟 20,000 次：50 笔后权益中位数约 0.5 到 0.6，7 到 9 成路径碰到 50% 回撤。
证据：[packages/shared/src/trader.ts:281](packages/shared/src/trader.ts#L281) riskPct 0.10；[packages/shared/src/trader.ts:494](packages/shared/src/trader.ts#L494) 杠杆上限。
审核员更正：前 3 笔按 2% 风险，只有第 4 笔按 10%。"全押"是老板明确下的令，文档写了理由。但它和 [docs/proposals/claude-auto-trader.md:55](docs/proposals/claude-auto-trader.md#L55) 的验收线（回撤不超过 50%）冲突，二者只能留一个。
最小修改：老板二选一：风险降到 2% 到 3%；或保持 10%，承认实验测的是"能活多久"，不是"有没有优势"。

### 3. "浮盈不能变亏"只按开仓价算，手续费、资金费、滑点没算（高；本周 10-28 的改动）
会发生什么：止损移到开仓价或略高，规则放行。触发后仍亏手续费约 10 U、资金费约 2 U、滑点约 18 点。判断"是否浮盈"用的是叫模型之前的标记价，模型想 8 到 22 秒，价格已经变了。
证据：[packages/shared/src/trader.ts:431](packages/shared/src/trader.ts#L431) 用毛开仓价和严格小于；[apps/api/src/services/trader.ts:318](apps/api/src/services/trader.ts#L318) 用旧标记价。
审核员更正：漏洞只在开仓价到保本价之间约 140 点，最多亏 1% 到 1.5% 权益。第 4 笔的 -36 是止损移到开仓价以下，新规则能挡住。3 位审核员都认为是中级。
最小修改：止损必须高于 成交价 ×(1 + 2 × 手续费率) 再加已付资金费，用执行时的实时标记价判断。老板定规则，开发者改 2 行。

### 4. 没有自动重启和报警，3 套栈同一窗口（高）
会发生什么：任何一个子进程退出，启动脚本把 3 套全停，没有通知。凌晨挂掉，晚上才发现。Windows 下 child.kill() 不走关机流程，10 次重启日志里没有一条 "shutting down"。
证据：[scripts/start.mjs:81](scripts/start.mjs#L81)、[scripts/start.mjs:110](scripts/start.mjs#L110)。
审核员更正：纸面交易所每单落盘，重启后按 K 线回放止损，不丢钱，丢的是停机期间交易员的决定。start-trader.bat 已能单独跑交易员。审核员判中级或低级。
最小修改：加一个检查：trader-state.json 超过 20 分钟没更新或 /api/health 失败就通知。开发者改。

### 5. 所有 API 层测试只跑 0 点收盘，20 点设定没有测试（高）
第 1 条就是这样漏过去的。
证据：[apps/api/test/campaign-step.test.ts:120](apps/api/test/campaign-step.test.ts#L120)；[apps/api/test/campaign-signals.test.ts:288](apps/api/test/campaign-signals.test.ts#L288) 期待 0。
审核员更正：shared 和 backtest 包有 20 点测试，缺的只是 API 层的 decideClose、walkMissedCloses 和服务。
最小修改：和第 1 条一起加 3 个用例。开发者改。

### 6. 滚仓真实下单代码在本机从未跑过（发现者判高，3 位审核员判低到中）
3 个资金池、23 个池日，没有一笔 pc 单。第一次入场时设杠杆、市价买、加保证金、回退平仓都是第一次在纸面交易所上跑。
证据：[apps/api/src/services/campaign-orders.ts:203](apps/api/src/services/campaign-orders.ts#L203)；[apps/api/test/e2e-paper.test.ts:1](apps/api/test/e2e-paper.test.ts#L1) 没有滚仓用例。
审核员更正：纸面交易所用 mock 的撮合引擎，e2e 已测过；没跑过的是 ADA、DOT、TRX 等币的合约规格和 5.6 U 最小仓位。池子只有 56 U。
最小修改：老板决定：监督下强制做 1 笔纸面入场，或加 1 个纸面 e2e。

### 7. 默认每单上限 5,000 U，10 万 U 账户上 1% 风险跟单实际只剩 0.08% 到 0.5%（发现者判高，审核员判低到中）
证据：[apps/api/src/config.ts:59](apps/api/src/config.ts#L59)；[apps/api/src/services/campaign-signals-plan.ts:333](apps/api/src/services/campaign-signals-plan.ts#L333)。
审核员更正：跟单页会显示被限制后的风险金额，不是无声的。这个账户至今 0 笔成交。.env 没读，可能已改过。
最小修改：老板决定：限额按账户规模设，或账户按限额设。

### 8. 手动跟单和滚仓规则不是同一笔交易（发现者判高，审核员判低到中）
跟单按 1% 风险到硬止损定仓位，止损挂在交易所盘中按标记价触发；规则押一半现金、10 倍、没有止损、只在日线收盘后离场。同一个信号，两份纸面记录会不一样，谁也验证不了谁。
证据：[apps/api/src/services/campaign-signals-plan.ts:320](apps/api/src/services/campaign-signals-plan.ts#L320)；[apps/api/src/services/channel-trailing.ts:33](apps/api/src/services/channel-trailing.ts#L33)；[apps/api/src/services/campaign.ts:277](apps/api/src/services/campaign.ts#L277)。
审核员更正：这是 [docs/api.md:925](docs/api.md#L925) 写明的设计，缺的是一句"跟单止损盘中触发，规则等收盘"。至今 0 笔跟单。
最小修改：老板决定：跟单作为独立方法写明，或改成和规则一样。

## 二、纸面和真实的差距

纸面比 OKX 好的地方（纸面成绩会偏高）：
- 停机或断线超过 60 秒期间触发的止损按触发价成交，没有滑点，每次最多好 2 U（[packages/paper/src/replay.ts:108](packages/paper/src/replay.ts#L108)）。本周 4 次止损都走实盘路径，没受影响。
- 断线不到 60 秒的那段价格被跳过，这段里穿过又回来的止损不触发（[packages/paper/src/exchange.ts:218](packages/paper/src/exchange.ts#L218)）。
- 市价单按 books5 前 5 档加权成交，不吃掉盘口，超过 5 档按第 5 档价。没有档位表、全仓强平、自动减仓、价格带（[packages/mock-okx/src/engine/margin.ts:27](packages/mock-okx/src/engine/margin.ts#L27)）。当前 1 万 U 名义、逐仓的仓位不受影响。
- 没有限频和重试，真账户重连时会撞 OKX 限频（[packages/okx/src/rest.ts:354](packages/okx/src/rest.ts#L354)）。

纸面和 OKX 一样或更严：
- 手续费 taker 0.05%、maker 0.02%，是 OKX 最差档。4 笔亏损 95.5 U 里 22.2 U 是手续费，占 23%（[packages/paper/src/server.ts:64](packages/paper/src/server.ts#L64)）。
- 资金费每 8 小时真的在扣，10-28 两次共 2.03 U。
- 止损按标记价触发、市价吃盘口，4 次成交比触发价差 0 到 18 点，和实盘相近。
- 回放时同一根 K 线按最坏顺序处理。

对照组的成本算法和真单不同：固定 5 bps 滑点、固定 10 bps 手续费、不扣资金费、止损按触发价平。4 笔里偏差 1 到 10 U，方向不固定（[apps/api/src/services/trader.ts:639](apps/api/src/services/trader.ts#L639)）。

## 三、交易逻辑

### (a) Claude 交易员
有没有方法：没有。提示第 37 行写了"周线日线定方向、做日线级别"，但没说用什么指标定方向，没说入场、出场，没说周线日线不一致怎么办（[apps/api/src/services/trader-model.ts:37](apps/api/src/services/trader-model.ts#L37)）。模型每次换一种定义：10-27 23:00 用收盘价高于 EMA50 判日线多，10-28 17:30 用 EMA5<10<21 判空，然后因"周日线冲突"连续 3 次空仓。

日志显示什么：76 次决定，66 次空仓。5 单 4 成交 4 亏，共 -95.5 U。前 3 笔止损 0.56 到 0.96 倍 1 小时 ATR，持仓 9 到 40 分钟。第 4 笔浮盈 +142 时把止损移到开仓价以下 129 点，理由是"4.8 倍 1H ATR 不算贴身"，-36 出局。按模型自己报的胜率和止损目标距离，5 单里 4 单扣费后期望为负，而代码不读 confidence（[packages/shared/src/trader.ts:389](packages/shared/src/trader.ts#L389)）。75 个 confidence 值里 66 个在 0.3 到 0.5，30 个正好 0.4。价格到了自己定的触发价，36 次叫醒里 31 次空仓并把价位推远。推理过程没存，只有 3 条一句话理由（[apps/api/src/services/trader-model.ts:96](apps/api/src/services/trader-model.ts#L96)）。

提示缺什么：定方向的指标；入场出场的数字；"涨不动"的定义；资金费是成本；成交量（张）和持仓量（BTC）的单位；周末不叫模型；止盈按市价成交。

团队会怎么改：方向、入场、出场各写成 1 个可检验的数（例如：方向 = 1D 和 1W 的 EMA 排列一致；止损不窄于 1 倍日 ATR；浮盈达到 2 倍手续费后止损移到保本价以上）。保本和止盈放进代码，模型只做否决。风险 2%。冻结提示版本，每条记录写版本号。

老板"只放数据"规则的代价：方法只能老板写，开发者不能补一句定义。第 35 行是抱怨不是规则，模型反着抱怨做："按主人要求不提前收紧"（[apps/api/src/services/trader-model.ts:35](apps/api/src/services/trader-model.ts#L35)）。每改一次提示样本归零，10 天改了约 10 版。

### (b) 滚仓规则
结论：规则没有证明过的优势，文档自己也这么写。现行 10 倍固定杠杆下 84% 的战役以强平结束，10 日低点离场只在 15% 的战役里起作用（[docs/strategy.md:200](docs/strategy.md#L200)）。3 倍 ATR 杠杆的改进（12,176 到 21,430）只在 0 点切点算过。池子实际用 20 点切点，在那里 3 ATR 是 12,473，比现行规则的 14,469 差（[docs/proposals/cut-hour.md:30](docs/proposals/cut-hour.md#L30)）。现行规则 75 个起点的总额随切点从 3,970 变到 85,952，差 21 倍，总额主要是切点运气。6 个切点里 3 ATR 赢 4 个，按单个战役算强平率从 84% 降到 59%，这部分比较稳。10 个币是 2026 年挑的幸存者（[packages/shared/src/campaign.ts:85](packages/shared/src/campaign.ts#L85)）。最重要的事实：因为第一条缺陷，纸面测试自 10-18 起实际没在跑。

### (c) 怎样才算证明
样本：日线级别方法一年只有 15 到 26 单。按模型目前的胜率，证明 +0.2R 的优势需要约 170 到 400 单，是 2 到 4 年。50 笔分不清运气和本事。
对照：现在的对照组只有方向抛硬币，止损、目标、每次移止损都跟着模型（[apps/api/src/services/trader.ts:651](apps/api/src/services/trader.ts#L651)）。它只测方向，测不了止损管理。要加 1 个固定止损（1 倍日 ATR）的对照和 1 个"从不交易"的基线。验收线写的是 20 条抛硬币序列的分布，代码只跑 1 条（[apps/api/src/services/trader.ts:632](apps/api/src/services/trader.ts#L632)）。
预注册：验收线已写（[docs/proposals/claude-auto-trader.md:54](docs/proposals/claude-auto-trader.md#L54)：90 天或 60 笔、胜过 9 成抛硬币、回撤小于 50%）。但护栏 10-27 改了，提示 10 天改约 10 版，每条记录没有版本号（[packages/shared/src/trader.ts:644](packages/shared/src/trader.ts#L644)），打分脚本没写。现有 4 笔不算数。要做的：冻结提示和护栏，记版本，从第 0 笔重数，按 R 倍数报成绩并附标准误。

## 四、其他发现（中低）

中：
- 日亏 50% 线和风控开关都碰不到，每天只靠 3 单刹车，3 笔满仓止损一天最多亏约 27%。老板规则。[apps/api/src/services/trader.ts:427](apps/api/src/services/trader.ts#L427)
- 市价开仓记的是叫模型前的标记价，不是成交价，差 44 到 47 点；保利润规则、对照组、战绩按错价算；盈亏数字本身对。[apps/api/src/services/trader.ts:483](apps/api/src/services/trader.ts#L483)
- "涨不动就止盈"没有数字也没有代码；模型仍可平仓或把止损移到开仓价以上。老板规则。[apps/api/src/services/trader-model.ts:36](apps/api/src/services/trader-model.ts#L36)
- 模型按自己给的胜率算期望为负还开单，confidence 没人读；老板 10-27 已拒绝加期望门槛。[packages/shared/src/trader.ts:389](packages/shared/src/trader.ts#L389)
- 提示第 35 行是抱怨不是规则。老板规则。[apps/api/src/services/trader-model.ts:35](apps/api/src/services/trader-model.ts#L35)
- 纸面交易所写文件没有 try/catch，每 15 秒写一次，失败即崩溃，整套栈停；同类 EPERM 在 API 侧发生过 7 次，纸面侧还没发生。[packages/paper/src/exchange.ts:130](packages/paper/src/exchange.ts#L130)
- 10-28 的新规则和提示还没进运行中的进程，重启 start-trader.bat 才生效。[packages/shared/src/trader.ts:429](packages/shared/src/trader.ts#L429)
- 10 个币是事后挑的幸存者，strategy.md 3.1 没写。[packages/shared/src/campaign.ts:85](packages/shared/src/campaign.ts#L85)
- 模型推理没存。[apps/api/src/services/trader-model.ts:96](apps/api/src/services/trader-model.ts#L96)
- 每条决定没记提示版本、程序版本、进程号；4 笔亏损来自 3 个版本。[packages/shared/src/trader.ts:644](packages/shared/src/trader.ts#L644)
- 给模型看的上笔止损距离是改后的 0.16%，不是开仓时的 1.04%。[packages/shared/src/trader.ts:580](packages/shared/src/trader.ts#L580)
- 止损放宽到 1 倍日 ATR 回测才略赚（+0.25R，93 笔，t=1.47），未证实，10% 风险下回撤 68%。
- 日线方法一年 15 到 26 单，证明优势要 100 到 400 单；本周 5 单不算日线级别。
- 3 ATR 改进在 20 点切点反转，strategy.md 3.4 没写。[docs/proposals/cut-hour.md:30](docs/proposals/cut-hour.md#L30)
- 验收样本每改一次提示归零，打分脚本没写。[docs/proposals/claude-auto-trader.md:54](docs/proposals/claude-auto-trader.md#L54)
- 对照组跟着模型移止损，只测方向。[apps/api/src/services/trader.ts:454](apps/api/src/services/trader.ts#L454)

低：
- 按波动定杠杆已排在 11-09 董事会，需补 20 点切点的数。[docs/strategy.md:200](docs/strategy.md#L200)
- 周末 48 小时不叫模型，提示没说；仓位靠交易所止损。[apps/api/src/services/trader-model.ts:63](apps/api/src/services/trader-model.ts#L63)
- 盘中被止损有时记成"外部平仓"，出场价一律没记；盈亏正确。[apps/api/src/services/trader.ts:583](apps/api/src/services/trader.ts#L583)
- 决定按 15 到 21 秒前的标记价执行，收紧失败不重试（有日志）。[apps/api/src/services/trader.ts:325](apps/api/src/services/trader.ts#L325)
- 资金费真在扣，模型成本表里没有；费率在案卷里有。[packages/shared/src/trader.ts:590](packages/shared/src/trader.ts#L590)
- 交易员 e2e 行情太平，开仓价、止损标签、限价、模型出错都没测。[apps/api/test/e2e-trader.test.ts:479](apps/api/test/e2e-trader.test.ts#L479)
- 模型刚设的价位被设之前的 K 线高低点"触发"，白叫醒；没因此下单。[apps/api/src/services/trader.ts:388](apps/api/src/services/trader.ts#L388)
- 11-01 美国冬令时后 minutesSinceUsOpen 错 1 小时；时段窗口是固定 UTC，仍覆盖。[apps/api/src/services/trader-dossier.ts:45](apps/api/src/services/trader-dossier.ts#L45)
- 价到触发价 31 次空仓并推远。[apps/api/src/services/trader-model.ts:61](apps/api/src/services/trader-model.ts#L61)
- 每分钟整读日志文件，每天长约 1 MB，1 年后才成问题。[apps/api/src/services/trader.ts:744](apps/api/src/services/trader.ts#L744)
- 纸面交易所不写日志文件；账户文件里有成交和资金费明细。[packages/paper/src/cli.ts:32](packages/paper/src/cli.ts#L32)
- 后台标签页每分钟被踢重连，一天刷 361 KB 日志；不影响交易员。[apps/api/src/ws/hub.ts:252](apps/api/src/ws/hub.ts#L252)
- 权益涨过 1,183 U 后紧止损的单会被 11,240 名义额上限拒掉。[apps/api/src/services/trader.ts:463](apps/api/src/services/trader.ts#L463)
- 跨零点持仓整笔结果记在平仓日，日亏数字偏小；风控引擎没这问题。[apps/api/src/services/trader-state.ts:144](apps/api/src/services/trader-state.ts#L144)
- 提示说止盈按目标价成交，实际按标记价触发市价成交。[apps/api/src/services/trader-model.ts:53](apps/api/src/services/trader-model.ts#L53)
- EMA200 只有 60 步平滑，一半还是种子均值；ATR 是简单均值。[apps/api/src/services/trader-dossier.ts:46](apps/api/src/services/trader-dossier.ts#L46)
- 日记 R 按初始止损算（惯例），加一列终止损 R 即可。[apps/api/src/services/journal-book.ts:864](apps/api/src/services/journal-book.ts#L864)
- 提示里的美盘时钟和案卷字段对不上。[apps/api/src/services/trader-model.ts:42](apps/api/src/services/trader-model.ts#L42)
- 缓存只盖住系统提示，案卷每次全价重发，约 1 到 2 美元/天。[apps/api/src/services/trader-model.ts:98](apps/api/src/services/trader-model.ts#L98)
- max_tokens 128k 与 180 秒超时矛盾；拒答时叫醒价位丢 1 小时（有意为之）。[apps/api/src/services/trader-model.ts:75](apps/api/src/services/trader-model.ts#L75)
- 交易员栈后端订阅 10 个币，纸面交易所只认 BTC；有意为之。[apps/api/src/config.ts:326](apps/api/src/config.ts#L326)
- 手续费占 4 笔亏损 23%；前 3 笔紧止损下占初始风险 15% 到 22%。[packages/paper/src/server.ts:64](packages/paper/src/server.ts#L64)
- 模型费用没上限，实际 1 到 2.3 美元/天。[apps/api/src/services/trader.ts:712](apps/api/src/services/trader.ts#L712)
- 连亏计数每天归零（老板本周改的）；最近 5 笔战绩仍可见。[apps/api/src/services/trader-state.ts:144](apps/api/src/services/trader-state.ts#L144)
- 数据公布瞬间叫醒模型，看不到数值；每次约 0.1 美元。[apps/api/src/services/trader.ts:394](apps/api/src/services/trader.ts#L394)
- 真账户限频和重试没处理；纸面不受影响。[packages/okx/src/rest.ts:354](packages/okx/src/rest.ts#L354)
- 开仓记录按"交易员"筛选报 400。[apps/api/src/routes/journal.ts:11](apps/api/src/routes/journal.ts#L11)
- 止损改动原因页面只留 30 条，接口能取 200 条。[apps/web/src/i18n/zh.ts:981](apps/web/src/i18n/zh.ts#L981)
- 护栏说明少了 3 条新规则，10% 是上限。[apps/web/src/i18n/zh.ts:186](apps/web/src/i18n/zh.ts#L186)
- 页面没有交易员累计盈亏；"同一止损"说法审核员认为正确。[apps/web/src/i18n/zh.ts:220](apps/web/src/i18n/zh.ts#L220)
- 信号页没有日志，但信号可从 K 线重算。[apps/api/src/services/campaign-signals.ts:275](apps/api/src/services/campaign-signals.ts#L275)
- 看不到累计亏损（1,124 到 1,028），周末持仓不提示。[apps/web/src/components/TraderPanel.tsx:180](apps/web/src/components/TraderPanel.tsx#L180)
- 日历 1 小时才刷新，改时间可能提前白叫醒 1 次。[apps/api/src/services/trader-macro.ts:127](apps/api/src/services/trader-macro.ts#L127)
- 文档说提示有"数据前 15 分钟不开仓"，其实 10-22 已删。[docs/proposals/claude-auto-trader.md:132](docs/proposals/claude-auto-trader.md#L132)
- TRADER_CALENDAR 实际没用过，提示没解释。[apps/api/src/services/trader.ts:707](apps/api/src/services/trader.ts#L707)
- 老板自己的纸面账户 24 天 0 成交；因为没有入场信号，不是缺陷。[data/paper-account.json:1](data/paper-account.json#L1)
- 成交量按张、持仓量按 BTC，差 100 倍，提示没写单位；模型目前只用比例。[apps/api/src/services/trader-model.ts:40](apps/api/src/services/trader-model.ts#L40)
- 文档说案卷有多空比、主动买卖比、强平，实际没有；提示本身写得对。[docs/proposals/claude-auto-trader.md:27](docs/proposals/claude-auto-trader.md#L27)
- 没有测试把看信号到成交记账整条链跑一遍。[apps/api/test/e2e-journal.test.ts:153](apps/api/test/e2e-journal.test.ts#L153)
- 启动日志没打印切分小时；接口和信号页能看到。[apps/api/src/index.ts:34](apps/api/src/index.ts#L34)
- 时段刚开始那一次调用高低点为空。[apps/api/src/services/trader-dossier.ts:97](apps/api/src/services/trader-dossier.ts#L97)
- 衍生数据接口出错静默置空。[apps/api/src/services/trader-dossier.ts:178](apps/api/src/services/trader-dossier.ts#L178)
- 日志把机器人下的单写成"手动"，日记里是对的。[apps/api/src/services/order-service.ts:495](apps/api/src/services/order-service.ts#L495)
- 文档写 3 个周期 200 根，代码是 5 个周期 260 根。[docs/proposals/claude-auto-trader.md:23](docs/proposals/claude-auto-trader.md#L23)

## 五、检查过没问题的

交易员代码：
- 入场检查（止损在亏损侧、目标不近于止损、限价 2% 内、有仓不开）和新保利润规则对 10-28 案例判断正确：[packages/shared/src/trader.ts:418](packages/shared/src/trader.ts#L418)
- 仓位算法：止损亏损 = 风险比例 × 权益，名义额封顶 0.95 × 10 × 权益，整手、最小量；第 4、5 笔复算一致：[packages/shared/src/trader.ts:487](packages/shared/src/trader.ts#L487)
- 入场闸门、时段、周末、日切、tick 重入保护、状态文件 tmp+rename、损坏则锁定：[apps/api/src/services/trader.ts:419](apps/api/src/services/trader.ts#L419)
- 模型出错路径：超时 180 秒、1 次重试，拒答、截断、解析失败都变成"无决定"并记录原因：[apps/api/src/services/trader-model.ts:109](apps/api/src/services/trader-model.ts#L109)
- 重启持仓：REST 先加载再连私有通道，10-27 20:22 重启没误记结果；guardStop 补挂丢失止损：[apps/api/src/services/trader.ts:512](apps/api/src/services/trader.ts#L512)
- 对照组机制对称；抛硬币序列无偏（10 万次 50.3% 多）
- 决定日志与状态一致：76 决定、5 单、4 结果、权益 1,124 到 1,028；4 笔盈亏与日记逐笔相等
- 提示只含数据说明、代码行为、老板原话；第 52 到 55、61 到 62 行与代码一致；案卷完整（5 周期 × 96 根、指标、水位、衍生、日历、新闻）
- 指标定义：EMA、MACD、Wilder RSI、VWAP、量比、摆动点；资金费 72h 均值、OI 24h 变化、OI 单位核实
- 新闻和日历：时区解析、排序、去重、TTL、失败降级正确

执行与纸面：
- 手续费与 OKX 普通档一致，8 笔逐笔核对；资金费 2 次结算时间、费率、符号正确；逐仓强平公式和档位 1 维持保证金率来自 OKX
- 止损按标记价触发、市价吃盘口；4 次止损都走实盘路径，没经过回放；滑点 1 到 18 点
- 账户文件每单落盘、启动留 .bak、损坏拒读；回放幂等、最坏顺序先、读完再应用
- 限价单取消与成交竞争、收紧与触发竞争、附挂止损校验、风控开关不动条件单：均正确
- 交易员和对照组 9.9 U 差额全部能解释（5.6 入场价、2.2 滑点、2.0 资金费）

滚仓：
- 20 日通道算法、无前视、497 参考战役复现到 1e-6、分红算法 C13 一致
- 切点在 awaitBars、processClose、closesAfter、账本检查、池旁回放都传了；只有 decideClose:194 和 walkMissedCloses:375 没传
- 20 点切分的日线 100/100 与账本一致；10-19 到 10-28 没有入场信号，最近 TRX 差 1.84%
- 账本完整：21 步、0 错误、0 漏收盘；日志 29 次 step done、40 次回放
- 跟单计划：状态优先级、杠杆上限、强平价复算、风控引擎放行、psw 前缀、路由校验

运维：
- 启动脚本环境变量优先级、端口占用拒绝、先构建再启动；案卷护栏等于代码默认，无 .env 覆盖迹象（.env 没读）
- 看门狗和重连：10-28 的 1006 断线 2 秒重连；10-26 停机是 DNS，当时无仓
- 磁盘：data 2.74 MB，logs/trader 11 天 650 KB
- 5 个进程的运行表、每笔亏损对应的程序版本和护栏已还原

文档与研究：
- strategy.md 对赔率和"没有证明的优势"写得直白；edge-research、claude-entry-advisor 引用准确

## 六、团队建议的下一步

1. 开发者今天修第 1 条（切点传进 decideClose 和 walkMissedCloses，加 3 个 20 点测试），然后重启 3 套栈，让 10-28 的规则同时生效。
2. 老板决定交易员的单笔风险：降到 2% 到 3% 继续考核，或保持 10% 并把验收线改成"存活"。
3. 老板用自己的话把方法写成 3 个数（定方向用什么、止损最窄多少、浮盈多少后止损到哪里），写完冻结提示 90 天。
4. 开发者给每条决定记提示哈希、程序版本、进程号，加 1 个固定止损对照和 1 个"从不交易"基线，写打分脚本。
5. 老板决定保利润规则是否按成交价加手续费和资金费算，开发者据此改 2 行。
6. 开发者在 11-09 董事会前给出 3 ATR 在 20 点切点和 6 个切点的数字，老板据此投票。
7. 开发者加死人开关（20 分钟没心跳就通知）和纸面交易所 save() 的 try/catch。

## 七、被推翻的说法

- 证据是样本内挑的，同日多币信号靠随机顺序分钱：机制存在，但 strategy.md 第 19、35、136、140 行已全部写明并决定，是公开的设计。
- 回放用 K 线最低价判强平，对账容差太宽：是写明的保守选择；池旁回放用 OKX 资金费不是 Binance；强平类型和收盘精确比对，容差只在入场价和倍数。
- 没过标准的"看天气"仍显示在页面：方案自己写了没过线就降为纯显示；影子不下单。
- 提示说每笔止损亏 10%：提示第 52 行写的是"在杠杆上限内"，前几笔按 2% 风险没被封顶。
- 收止损随便改缓存里第一条单：amendStop 先刷新再按 algoId 校验；交易员账户只有自己的止损；OKX 路径在纸面外被拒绝。
- 挂单一碰到价格就全成交不排队：OKX 上最优卖价到了 P 就意味着 P 的买单已全部成交，和纸面一致。
- 附挂止损止盈只在纸面放行、真账户未验证：是写明的阶段闸门，老板没有 OKX 密钥，场景不存在。
- 重启取消冷却时删掉了模型自己定的查看：删除是有意的（trader.ts:188 注释），那次查看是在冷却期内定的；最近 5 笔战绩仍传给模型。
- 手续费率是猜的：0.05/0.02 是 OKX 普通档最差情况，纸面按此扣，可用 PAPER_TAKER_FEE 改；无密钥读不到实际档位。
- 自动交易员和滚仓只能纸面跑：是有意的安全闸门，不是缺陷。
- 界面一切正常看不出入场失效：跳过的入场会记"入场（跳过）"并给原因；账本里 21 步本来就没有入场信号。
- 新闻标题里的数字会被当成价位：10-22 的 81,500 是真实 ETF 成本位，只是 4 条理由之一，那单没成交。
- 双向持仓模式代码路径从未跑过：纸面账户是净持仓模式，交易员在纸面外被拒绝；order-service 的双向路径有自己的测试。
- 新闻源失败提示没告诉模型含义：提示是自解释的英文句子，76 条里只 1 条非空，日历从未失败。
- 按主人方法加模型止损回测 6 年亏损、和抛硬币一样：同一脚本把止损放宽到 1 倍日 ATR 就变成 +0.247R、3.27 倍；0.5 ATR 和 3R 是审核员自己选的参数，老板方法没写止损。
- 第 5 单在自己定的 81,300 以下买入且日线空头：叫醒价位只决定何时问模型，不是入场承诺；第 5 单理由是周线多头、日线低点抬高、收盘站上日 EMA50。
- 周线只给已收盘的上周：本周的日线和当天高低点都在案卷里，模型能看到本周突破。

Skipped: no file re-read, line numbers taken from the verifiers' verdicts; where verifiers disagreed the finder's severity was kept and the verifiers' downgrade stated beside it.
