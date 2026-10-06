# Pegasus API contract (web ⇄ api)

All routes live under `/api`. Every route except `GET /api/health` requires
`Authorization: Bearer <API_TOKEN>`; the check is made on the route the request was matched to, so a
percent-encoded or absolute-form spelling of a path needs the token like the plain one.

The API is meant for the terminal page only, which reaches it same-origin through the Vite proxy.
Every request, including `/api/health`, the `/ws` upgrade and unknown paths, is checked first for where it comes from:

- `Host` must name this machine: `localhost`, `127.0.0.1` or `[::1]` (any port), or `API_HOST` when that is
  not a wildcard (`0.0.0.0`, `::`). Otherwise `403 FORBIDDEN_HOST`.
- `Origin`, when the request carries one, must be exactly one of `WEB_ORIGINS` (comma separated, default
  `http://localhost:5174,http://127.0.0.1:5174`). Otherwise, the literal `null` included, `403 FORBIDDEN_ORIGIN`.
  Requests without an `Origin` (the launcher's health probe, scripts) pass.
- There are no CORS headers and no preflight answers: a page on another origin cannot call the API.

Responses use the envelope from
`@pegasus/shared` (`ApiResponse<T>`):

```json
{ "ok": true, "data": ... }
{ "ok": false, "error": { "code": "RISK_REJECTED", "message": "...", "details": { } } }
```

Numeric values are decimal strings. Timestamps are epoch milliseconds.
Request bodies are validated with the zod schemas in `packages/shared/src/schemas.ts`.

| Method | Path | Body / query | Returns |
| --- | --- | --- | --- |
| GET | `/api/health` | – | `{ ok: true, version, demo, paper, connection: { okxPublic, okxPrivate, okxBusiness }, serverTime }` (no auth, so only the three socket states; the full `ConnectionStatus` is sent over `/ws`). `version` is the short git commit the launcher started the stack from (`PEGASUS_VERSION`), `"unknown"` when the API was started another way |
| GET | `/api/instruments` | – | `Instrument[]` (tracked instruments) |
| GET | `/api/account` | – | `{ config: AccountConfig \| null, balance: Balance \| null }` (`config` is null until the account was loaded) |
| GET | `/api/account/leverage` | `?instId&mgnMode` | `{ instId, mgnMode, posSide, lever }[]` |
| POST | `/api/account/leverage` | `SetLeverageRequest` | `{ instId, mgnMode, posSide, lever }[]`; a `lever` above `RISK_MAX_LEVERAGE` answers `RISK_REJECTED` (`details.code` = `MAX_LEVERAGE`) and nothing is sent to OKX |
| GET | `/api/positions` | – | `Position[]` |
| POST | `/api/positions/close` | `ClosePositionRequest` | `{ instId, posSide }` (any instrument with a position, tracked by the server or not) |
| GET | `/api/orders/open` | – | `Order[]` |
| GET | `/api/orders/history` | `OrdersHistoryQuery` | `Order[]` newest first |
| GET | `/api/fills` | `FillsQuery` | `Fill[]` newest first |
| POST | `/api/orders/preview` | `PlaceOrderRequest` | `OrderPreview` (see below) |
| POST | `/api/orders` | `PlaceOrderRequest` | `{ order: Order, preview: OrderPreview }` |
| POST | `/api/orders/cancel` | `CancelOrderRequest` | `{ ordId, clOrdId }` |
| POST | `/api/orders/cancel-all` | `CancelAllRequest` | `{ canceled: number }` (open orders only; algo orders are not touched) |
| GET | `/api/algo-orders` | – | `AlgoOrderList`: `{ orders: AlgoOrder[], ts }`, the stop-loss / take-profit algo orders read from OKX for this request (see "Stops" below) |
| POST | `/api/algo-orders` | `PlaceStopRequest` (`{ instId, mgnMode, posSide?, slTriggerPx, sz? }`) | `201` `{ algoId, instId, slTriggerPx, sz }`: a stop-loss was placed for an open position (see "Stops") |
| POST | `/api/algo-orders/amend` | `AmendAlgoOrderRequest` (`{ instId, algoId, slTriggerPx }`) | `{ algoId, instId, slTriggerPx, previous }`: the stop was moved from `previous` to `slTriggerPx` (as rounded) |
| POST | `/api/algo-orders/cancel` | `CancelAlgoOrderRequest` (`{ instId, algoId }`) | `{ algoId, instId }` (a take-profit leg or a trailing stop as well) |
| POST | `/api/positions/take-profits` | `PlaceTakeProfitsRequest` (`{ instId, mgnMode, posSide?, takeProfits: { triggerPx, fraction }[] }`) | `201` `PlaceTakeProfitsResult`: `{ instId, posSide, legs: { algoId, triggerPx, sz }[] }` — take-profit legs for an open position (see "Exit orders"; paper trading and the local mock only) |
| POST | `/api/positions/trailing-stop` | `PlaceTrailingStopRequest` (`{ instId, mgnMode, posSide?, ratio, activePx?, sz? }`) | `201` `PlaceTrailingStopResult`: `{ algoId, instId, posSide, sz, callbackRatio, activePx }` — the exchange's trailing stop for an open position (see "Exit orders") |
| POST | `/api/positions/channel-trailing` | `SetChannelTrailingRequest` (`{ instId, mgnMode, posSide?, bars }`) | `ChannelTrailingEntry`: channel trailing set for an open position, its stop placed or moved at once (see "Exit orders") |
| POST | `/api/positions/channel-trailing/clear` | `ClearChannelTrailingRequest` (`{ instId, mgnMode, posSide? }`) | `{ instId, mgnMode, posSide, cleared }`; the stop stays where it is |
| GET | `/api/trailing` | – | `TrailingView`: `{ enabled, entries: ChannelTrailingEntry[], pending: PendingTrailingExit[], nextCloseAt, ts }` |
| GET | `/api/candles` | `CandlesQuery` | `Candle[]` ascending by `ts`; `6H`, `12H`, `1D` and `1W` are UTC-aligned (OKX `6Hutc` … `1Wutc`), also on the `candle` WS message |
| GET | `/api/book` | `?instId` | `OrderBook` (top 50 each side) |
| GET | `/api/ticker` | `?instId` | `Ticker` |
| GET | `/api/risk` | – | `{ config: RiskConfig, state: RiskState }` |
| GET | `/api/signals` | `?instId&phase&equity&riskPct&maxNotionalPct&lang` (all optional; `phase` is `0` or `12`, `lang` is `en` or `zh`) | `SignalsResponse`: `{ generatedAt, equity, phases, sizingParams, reports: SignalReportRow[] }` — daily trend-framework signals, one row per instrument and daily cut; without `instId` the instruments of `INSTRUMENTS` (not the campaign's, which are tracked beside them; any tracked instrument can be asked for by `instId`); see below and `packages/shared/src/signals.ts` |
| POST | `/api/risk/kill-switch` | `KillSwitchRequest` (`{ enabled, reason?, rebase? }`) | `RiskState` (`cancelSweep` already reflects the new switch position); `409 DAILY_LOSS_ACTIVE` for a release without `rebase` while the daily loss limit is breached |
| GET | `/api/campaign` | – | `CampaignView`: the campaign's status, pot, campaigns, bankings, samples and execution errors (see "Campaign"); `status: 'disabled'` while it is not enabled |
| GET | `/api/campaign/log` | `?before&limit` (both optional; `limit` 1 to 100, default 20) | `CampaignLogPage`: `{ steps, total, next }`, the campaign's decision log newest first (see "Campaign") |
| GET | `/api/campaign/replay` | – | `CampaignReplayView`: the replay beside the pot, its other structure, the pot's start value held in BTC and the reconciliation of the ledger with the replay, as last computed (see "The replay beside the pot"); `status: 'unavailable'` while there is no pot |
| POST | `/api/campaign/replay` | – (a body, if any, is ignored) | `202` `CampaignReplayView` as it is now: a computation was started in the background (or one runs and another follows it); `200` with `status: 'unavailable'` when there is nothing to replay. The `campaign` message says when the new result is there |
| GET | `/api/campaign/signals` | `?riskPct&equity` (both optional: `riskPct` a fraction below 1, default `0.01`; `equity` a positive decimal, default the account's total equity) | `CampaignSignalsResponse`: the campaign rule read per coin for every instrument of `CAMPAIGN_INSTRUMENTS`, an `entry` or an `add` with a plan to follow it by hand (see "Campaign signals"); answers while the campaign is disabled too |
| GET | `/api/journal` | `?status&instId&source&before&limit` (all optional; `status` `open` or `closed`, `source` `manual`, `signal`, `campaign` or `external`, `before` a trade's `seq`, `limit` 1 to 200, default 50) | `JournalPage`: `{ status, reason, trades, total, next, serverTime }`, the trades of the trade journal newest first, without their fills and timeline (see "Trade journal") |
| GET | `/api/journal/:id` | – | `JournalTrade`: one trade with its fills and its timeline; `404 TRADE_NOT_FOUND` for an id the journal does not have |

Daily PnL, its baseline and what survives a restart. `RiskState.dailyPnl` is `currentEquity - dayStartEquity`.
`dayStartEquity` is the first total equity observed in the current UTC day and `baselineTs` when that was (epoch ms,
`0` while there is none): with the server running across 00:00 UTC it is within a minute of `dayStartTs`, after a
later first start of the day it is that start, so "daily" PnL then counts from `baselineTs` only (the terminal
labels it "since HH:MM UTC" when `baselineTs` is more than 5 minutes after `dayStartTs`). The kill switch, its
reason, `dayStartTs`, `dayStartEquity`, `baselineTs` and whether the halt's cancel sweep has completed are saved on every change: in the database when
`DATABASE_URL` is set, otherwise in the JSON file `STATE_FILE` (default `data/pegasus-state.json` under the
repository root; orders and fills are not in it). At start-up a state saved the same UTC day is restored whole, so
a halt and the day's loss so far survive a restart; from a state saved on an earlier day only a manual halt is
restored, an automatic daily-loss halt is cleared. A state that cannot be read or is not valid (a damaged file) fails
closed: the server starts with the kill switch on and `killSwitchReason` `"STATE_FILE_UNREADABLE: …"` naming the
file, which stays on like a manual halt until it is released; a copy of an unparseable file is kept as
`<STATE_FILE>.corrupt`, and the file itself stays in place (so every start fails closed) until the halt is saved over it.

Releasing (`enabled: false`) while the daily loss limit is still breached (`dailyPnl <= -RISK_DAILY_LOSS_LIMIT`) is
refused with `409 DAILY_LOSS_ACTIVE` (`details`: `{ dailyPnl, limit, equity }`) and the switch stays on. With
`rebase: true` the release goes through and the baseline restarts at the current equity (`dayStartEquity` =
`currentEquity`, `baselineTs` = now, `dailyPnl` = `"0"`; a `DAILY_BASELINE_REBASED` risk event is recorded), so the
limit can trip again from there. This is the deliberate override for a transfer out of the account, which the
equity-based rule cannot tell from a loss; the terminal asks for it in a second confirmation. `rebase` is ignored
when the limit is not breached and when `enabled` is true.

Positions that have outgrown their limit. The notional limits are checked when an order is placed, but a position
grows with price afterwards. `RiskState.overLimit` lists every instrument whose position notional now exceeds
`RISK_MAX_POSITION_NOTIONAL_PER_INSTRUMENT`: `Array<{ instId, notional, limit, excess }>` (decimal strings; `excess` =
`notional - limit`), `[]` while none does. Only positions count, resting orders do not; the accounting is that of
the pre-trade rule (a net position at its absolute notional, the long and short legs of long/short mode gross; a
position without a reported notional is valued at its mark price). `RiskState.totalOverLimit` is the excess of
`totalPositionNotional` over `RISK_MAX_TOTAL_POSITION_NOTIONAL`, `""` while within it. Both are recomputed on every
position and order event and sent with the risk state (`/api/risk`, `hello.risk`, every `risk` message); they are
derived, not saved. They are advisory: the server never trades or refuses anything because of them (an opening
order on such an instrument is refused by the pre-trade rule as before, a closing order is always allowed). The
terminal marks the position row with the amount to trim, in quote and in contracts rounded down to `lotSz`, and
shows one line in the risk panel.

Kill switch and its cancel sweep. While the switch is on, opening orders are refused and **all** open SWAP orders of
the account are cancelled once per engagement: resting exits and orders placed on OKX directly included, conditional
(algo) orders not. A closing order placed after that sweep rests untouched, also across a restart.
`RiskState.cancelSweep` (in `/api/risk`, `hello.risk` and every `risk` message) reports it:

```ts
interface CancelSweep {
  state: 'idle' | 'pending' | 'done' | 'failed' | 'skipped';
  message: string;         // display text; '' when idle
  ts: number;              // when state or message last changed
}
```

- `idle`: the switch is off. `pending`: a sweep is running or waiting for its retry
  (`"cancel failed: <reason>, retrying in 10 s"`). `done`: no open order is left (`"open orders cancelled"`,
  `"no open orders to cancel"`). `failed`: given up, the key was rejected or lacks the permission (OKX `50100`,
  `50101`, `50105`, `50110`, `50111`, `50113`, `50114`, `50120`, HTTP 401/403); nothing more is tried until the
  switch is engaged again. `skipped`: not attempted and no request sent, because the key is read-only or no key is
  configured; it runs after all if the key gains the trade permission while the switch is on.
- A sweep starts when the switch goes on (manually or by the daily loss limit) and at start-up when the restored
  switch is on (not for a daily-loss halt of an earlier UTC day, which is cleared before the sweep could start, and
  not when the sweep of that halt had already reached `done` before the restart: `cancelSweep` is then `done` with
  `"open orders cancelled before the restart"` and no request is sent; a sweep that was `pending`, `failed` or
  `skipped`, a halt saved by an older version, and a `STATE_FILE_UNREADABLE` halt are swept at start-up). It needs REST only, not the private stream: the open orders are listed afresh, cancelled, listed
  again, and it is `done` only when that last list is empty. Otherwise it is retried after 5 s, 10 s, 20 s, 40 s and
  then every 60 s.
- Releasing the switch (or the automatic release of a daily-loss halt at 00:00 UTC) ends the sweep at once: a
  pending retry is dropped and nothing is cancelled for a switch that is off. Of `cancelSweep` only "this halt's sweep reached `done`" is saved (with the kill switch, see
  above); it is forgotten when the switch is released or engaged anew, so every engagement sweeps once.

`/api/signals`:

- Signals are computed from confirmed daily candles (the forming bar is excluded) at the configured daily cuts (two
  by default, `SIGNAL_PHASES`), named by the UTC
  hour the bars close at: `phase: 0` uses OKX's `1Dutc` bars, `phase: 12` uses daily bars built from two consecutive
  `12Hutc` bars (noon to noon; two pages of 300 half-day bars). `phases` lists the cuts the server computes (`SIGNAL_PHASES` in `.env`, default `0,12`)
  (`[0, 12]`). `reports` holds one row per instrument and cut, ordered by instrument, then cut; every row, an error
  row (`{ instId, phase, error }`) included, carries its `phase`. A cut that fails is an error row of its own and
  leaves the instrument's other row standing. `?phase=0` or `?phase=12` returns the rows of that cut only; `phases`
  and the sizing are the same as without it.
- `indicators.asOf` is the open time of the row's last confirmed bar: a UTC midnight for `phase: 0`, a UTC noon for
  `phase: 12`; that bar closed at `asOf + 86 400 000`.
- Each cut is sized at its share of a unit, so the lots of an instrument together stay within one unit. `riskPct` and
  `maxNotionalPct` in the request are those of ONE UNIT (without them the server uses 0.0075 and 0.10; the terminal
  always sends the owner's `riskPct`, 0.005 by default). `sizingParams` (`{ riskPct, maxNotionalPct, atrStopMultiple }`)
  echoes the values of one cut's lot, as the plans were computed: the unit's values divided by `phases.length`
  (`riskPct=0.005` gives `"0.0025"` and `"0.05"`).
- `sizing` is `{ long: SizingPlan, short: SizingPlan } | null` (null without equity). Each plan carries its own
  `multiplier` and `adjustments` (for example `"short x0.5"`, `"crisis x0.5"`,
  `"crowded x0.75 (funding 0.09%/8h, OI +24% in 10d)"`); the multiplier is applied after the notional cap and before
  the minimum-order-size check. `signals.reasons` has one line per applied adjustment. The 10-day open interest change
  of the crowding cut is measured over the 10 days ending at the row's own last close (the levels at those two
  instants; unknown when either is missing), so the two rows of an instrument may differ. Funding is the same for
  both rows: the window ends at the time of the request.
- `params.allowShort` (default `false`) switches short entries: while it is false `signals.shortEntry` is never true,
  the reasons say that shorts are off and carry no `short size:` lines. `signals.shortExit` and `sizing.short` are
  computed either way; the terminal shows the short side as off.
- A plan's `rawNotional` is the notional before the cap, `targetNotional` the one aimed at after the cap and the
  multiplier, and `notional` the notional of `contracts`, the order actually proposed after rounding down to whole
  lots (`"0.00"` when `contracts` is `"0"`). `coin` and `riskQuote` describe the same rounded order.
- `indicators.shockBars` lists the bars inside the hold window (`params.crisisHoldBars` closes) whose |log return|
  exceeded `params.crisisReturnSigmas` daily sigmas, most recent first:
  `{ daysAgo, return, oiChange, crisis }`. `oiChange` is the fractional change of the instrument's open interest (in
  coin) over that bar (midnight to midnight for `phase: 0`, noon to noon for `phase: 12`), `""` when unknown. `crisis` is true when open interest fell by more than
  `params.crisisOiDrop` (default `"0.1"`) or when the change is unknown; the direction of the price move does not
  matter. `indicators.crisisDaysAgo` is the number of closes since the most recent shock bar with `crisis` set (0 =
  the last bar, null = none). `signals.reasons` has one `shock:` line per shock bar with the move, the open interest
  change and the verdict.
- `indicators.nextExitHigh` / `nextExitLow` are the exit channel including the last bar, the level the next close
  is tested against.
- `?lang=zh` words the texts of the reports in Chinese: `signals.reasons`, the plans' `note` and `adjustments`
  (`"做空 x0.5"`, `"危机 x0.5"`, `"拥挤 x0.75（…）"`). Without it, or with `lang=en`, they are in English as quoted in
  this section; any other value is refused with `VALIDATION`. The decisions and every number are the same in both
  languages. The terminal sends `lang=zh` while its page is switched to Chinese. An error row's `message` and every
  other text of the API (error messages, `RiskCheckResult.message`, `killSwitchReason`, `cancelSweep.message`) stay
  in English: the terminal explains them in Chinese from their codes and `details`.
- `dataFetchedAt` is when the candles and funding behind a report were fetched from the exchange (the older of the
  two). Candles are cached for 5 minutes per instrument and cut, never across that cut's own close (00:00 UTC for
  `phase: 0`, 12:00 UTC for `phase: 12`); funding is cached for 5 minutes per instrument, never across either close.
- `structure.book` is the visible depth/imbalance over 20 levels. `structure.openInterest` is the instrument's own open
  interest, the same block on both rows of an instrument. With `source: "history"` the level (`current`, in USD) is today's still-forming row of the history
  (cached for an hour, never across 00:00 or 12:00 UTC), while `change1d`, `change10d` and `percentile30d` are
  measured in coin on completed days only: the last completed UTC day against the day before it and against ten days
  before it. `points` is the number of completed days. With `source: "live"` only the current level is known and the
  changes are `""`.
- The history is read from OKX's `1Dutc` and `12Hutc` rows together (two calls per instrument), because only the pair
  says which instant a row refers to (`docs/okx-api-notes.md` §5.9); the level of a completed UTC day is the one at
  the following 00:00 UTC. The same levels give `shockBars[].oiChange`. When the two do not fit together, or the
  levels of the last closed daily bar of either cut are missing (00:00 to 00:00 UTC, and 12:00 to 12:00 UTC for the
  12:00 cut), the server logs a warning, reports what is known (the block falls
  back to `"live"` when yesterday's level is missing; shock bars without both levels count as crisis days) and asks again after 60 s
  instead of keeping the result for the hour. While OKX has not yet opened the row of the running day or half-day, its
  newest row is treated as still forming, so the level at the last close counts as missing until the new row appears.
- Open interest never holds a report back. A report waits at most 3 s for an instrument's history; after that it is
  sent with the rows fetched last when there are any, otherwise with the live level (and unknown per-bar changes),
  while the calls finish in the background and fill the cache for the next request. Levels at past instants do not
  change, so rows from an earlier half-day still give `shockBars[].oiChange` for every bar that had closed by then
  and, within the same UTC day, the 1-day and 10-day changes (`current` is then the live level); after a UTC
  midnight the bar that has just closed stays unknown and the block is `"live"` until the refresh arrives. Until
  they have settled, and for 60 s after a failed one, no report waits for that instrument's history again. The
  history calls go out one at a time, 400 ms apart, so right after a start, a UTC midnight or noon the last
  instruments of a full report can come back as `"live"` once.
- A row that could not be computed is `{ instId, phase, error: { code, message } }` (`SignalReportError`).

`OrderPreview` (exported from `@pegasus/shared`):

```ts
interface OrderPreview {
  instId: string;
  side: Side;
  ordType: OrdType;
  tdMode: TdMode;
  posSide: PosSide;
  /** exchange-ready size in contracts */
  sz: string;
  coin: string;            // base coin equivalent
  px: string;              // normalised limit price ('' for market)
  refPrice: string;        // price used for notional / conversions
  notionalQuote: string;   // USD(T) notional of this order
  estSlippagePct: string;  // market orders only, from the order book; '' otherwise, and for an exit while the book is not synced
  lever: string;           // leverage currently configured for the instrument/mode; '' for an exit (not looked up)
  slTriggerPx: string;     // normalised trigger of the attached stop-loss; '' when the order carries none
  stopLossQuote: string;   // quote-currency loss if the stop fills at its trigger with sz, measured from refPrice; '' without a stop
  takeProfits?: { triggerPx: string; fraction: string; sz: string; profitQuote: string }[];   // the take-profit legs as sized (see "Exit orders"); absent without takeProfits
  risk: RiskCheckResult;   // ok=false means the order would be rejected
}
```

Attached stop-loss. `PlaceOrderRequest.slTriggerPx` (optional, a positive decimal string; `POST /api/orders` and
`POST /api/orders/preview`) attaches a stop-loss to the entry order itself: the server sends it to OKX as
`attachAlgoOrds: [{ attachAlgoClOrdId, slTriggerPx, slOrdPx: "-1", slTriggerPxType: "mark" }]`, so the exchange
creates the stop once the order is **completely filled**, triggers it on the **mark price** and executes it at
market. Pegasus places no second order and does not watch the price itself.

- **A partially filled order has no stop yet.** OKX generates the attached stop only when the parent order is
  completely filled (docs/okx-api-notes.md 6.1), and none at all for a parent cancelled before any fill. While an
  order with `slTriggerPx` is `partially_filled` the filled part is a position without a stop: the open-orders
  table says so in the Stop column (`stopAwaitsFullFill` in `@pegasus/shared`). When such an order ends `canceled`
  with `accFillSz > 0` (`stopUnconfirmedAfterCancel`), the documentation does not say whether a stop is generated
  for the filled part, so the terminal raises one error notice per order (it stays until it is clicked away)
  telling the trader to check the Stops tab and place the stop on OKX by hand if it is missing.

- Only an **opening** order may carry one. On an order that closes (reduce-only in net mode, the closing direction
  of a leg in long/short mode) the request is refused with `VALIDATION` (400). In net mode the same holds for an
  order without reduce-only that goes against the open net position of the instrument (a buy while net short, a
  sell while net long): it reduces or flips that position, and its stop would protect nothing.
- The trigger is rounded to `tickSz` towards the entry (up for a buy, down for a sell: the smaller loss).
- It must lie on the losing side of **both** the order's reference price (the limit price, or the estimated fill
  of a market order: `refPrice`) and the current mark price: below both for a buy, above both for a sell. Otherwise
  `VALIDATION` (400) with `details: { slTriggerPx, refPrice, markPx }`; a mark-triggered stop on the wrong side of
  the mark would fire at once. Only the live mark price counts here: while the mark stream is stale or has not
  delivered yet, a request with `slTriggerPx` is refused with `NO_PRICE` (503) instead of being checked against the
  last price or the book mid (the same order without the stop is still accepted).
- `attachAlgoClOrdId` is `sl` followed by the last 30 characters of the order's `clOrdId`.
- The stop is not an input of the risk check and never relaxes a limit. `stopLossQuote` is information only: a gap
  through the trigger loses more.
- A retry that finds the earlier attempt at the exchange sends nothing (see below), so no second stop either; the
  answer's `order.slTriggerPx` and `preview.slTriggerPx` are those of the order OKX holds, `stopLossQuote` is `''`.
- `Order.slTriggerPx` (optional, in `POST /api/orders`, `/api/orders/open`, `/api/orders/history` rows of this
  session and the `order` message) is the trigger of the stop attached to that order, read from the `attachAlgoOrds`
  OKX echoes on the order object; absent when there is none. An echoed entry with a non-empty `failCode` (other
  than `0`) is a stop the exchange did not create: it is not reported as `slTriggerPx`, and the server logs an error
  naming the order. It is not stored in the database: an order row read back from Postgres has no `slTriggerPx`.
- `Order.slFailReason` (optional, same places) is set to `'<failCode>: <failReason>'` when the exchange did not
  create the attached stop: the position of that order has no stop. Absent when the stop exists or none was
  attached; not stored in the database either. The terminal shows one error notice per order (it stays until it is
  clicked away) telling the trader to place the stop on OKX; the notice is raised from the `order` message and from
  the open orders of `hello`, not once per push.
- Once the entry has filled, the order leaves the open orders and its stop is an algo order: it is listed, moved
  and cancelled through `/api/algo-orders` (next section). The kill switch's cancel sweep and
  `POST /api/orders/cancel-all` cancel open orders, not algo orders: an active stop keeps protecting its position;
  the stop of an entry that is still resting goes with that entry.

Stops (algo orders). An `AlgoOrder` is a take-profit / stop-loss order resting at OKX: an OKX algo order of type
`conditional` (one-way) or `oco`, of a SWAP instrument, tracked by the server or not. That covers the stops generated from
attached stops and the TP/SL orders placed on OKX itself; trigger, iceberg and TWAP orders are not read. Where the exit
orders of this stage are enabled (paper trading and the local mock, see "Exit orders") the list also holds the trailing
stops (OKX `move_order_stop`, read with a call of their own: OKX lists them on their own only).

```ts
interface AlgoOrder {
  algoId: string;
  algoClOrdId: string;          // for a stop that came from an attached stop: 'sl' + the tail of the entry's clOrdId
  instId: string;
  side: 'buy' | 'sell';         // side of the closing order it sends: sell closes a long, buy closes a short
  posSide: 'long' | 'short' | 'net';
  tdMode: 'cross' | 'isolated';
  sz: string;                   // contracts it closes; '' when closeFraction is set
  closeFraction: string;        // '1': closes the whole position whatever its size then; '' when it closes sz
  slTriggerPx: string;          // '' for a take-profit only order
  slTriggerPxType: 'last' | 'index' | 'mark' | '';
  slOrdPx: string;              // '-1': executed at market
  tpTriggerPx: string;          // '' when none
  // present only where they apply; a one-way stop-loss carries none of them
  ordType?: 'oco' | 'move_order_stop';   // absent for a one-way (conditional) order
  tpTriggerPxType?: 'last' | 'index' | 'mark';   // with a take-profit
  amendPxOnTriggerType?: true;  // the stop-loss of split take-profits that moves to the entry when the first take-profit triggers
  callbackRatio?: string;       // trailing stop: '0.05' is 5%
  callbackSpread?: string;      // trailing stop: as a price distance
  activePx?: string;            // trailing stop: the price that activates it; absent when it trailed from its placement
  moveTriggerPx?: string;       // trailing stop: the price it triggers at now ('' before it is active)
  cTime: number;
  uTime: number;
}
interface AlgoOrderList { orders: AlgoOrder[]; ts: number }   // newest first; ts: when the server read it from OKX
```

- **How the list is kept.** Algo orders are not on the private socket Pegasus uses (their channel is on the
  business socket and needs its own login), so they are read over REST (`GET /api/v5/trade/orders-algo-pending`,
  `ordType=conditional,oco`, `instType=SWAP`): with every account reconcile (60 s, and when the private socket
  becomes ready), 1 s and again 5 s after an order ended (filled or cancelled: its attached stop exists only then,
  and the closing order of a stop that fired is an order too) or a position changed size, after every amend and
  cancel made through this API, and for every `GET /api/algo-orders`. Up to 500 are read (5 pages); more is logged.
  A change made on OKX itself is therefore seen within a minute, not at once.
- Every successful read is sent to the terminals as `{ type: 'algoOrders', data: AlgoOrderList }`, changed or not,
  so `ts` says how fresh the list is. `hello.algoOrders` is the last list, `null` until the first read succeeded
  (and for good without an API key). A failed read is logged, does not fail the account reconcile and does not
  change `ConnectionStatus`: the last list is kept with its `ts`. The terminal marks the list "not refreshed
  since" once `ts` is older than 150 s.
- `GET /api/algo-orders` always reads the exchange and answers with that read; a failure is the exchange's
  (`EXCHANGE`, `EXCHANGE_UNREACHABLE`) or `NOT_CONNECTED` without an API key. It needs no trade permission.
- `POST /api/algo-orders/amend` moves the stop-loss trigger and nothing else: OKX is sent `newSlTriggerPx` only, so
  size, trigger price type and execution stay as they are (OKX refuses a change of the trigger price type, and of
  the price or size of a stop that closes a whole position).
  - The order is looked up in a fresh read first: `ALGO_NOT_FOUND` (404) when no resting algo order has that
    `algoId` and `instId` (it triggered or was cancelled); `VALIDATION` (400) for an order without a stop-loss.
  - The trigger is rounded to `tickSz` towards the price (up for a stop that closes a long, down for one that
    closes a short: the smaller loss). The tick comes from the contract spec of any SWAP known at start-up; for an
    instrument without one the price is sent as given.
  - `VALIDATION` (400) when the rounded trigger equals the current one, or, for a **mark-triggered** stop, when it
    is not on the losing side of the live mark price (`details: { slTriggerPx, markPx }`): it would fire at once.
    Without a live mark price the request is refused with `NO_PRICE` (503). For a stop triggered by the last or the
    index price the server does not check the side; the exchange decides.
  - The server does not refuse a move that widens the loss; the terminal asks for a confirmation before sending one.
- `POST /api/algo-orders` places a stop-loss for an open position that has none, or not for all of it: an OKX
  `conditional` algo order, **mark-triggered**, executed at market, on the closing side of the position. In net
  mode it is sent with `reduceOnly: true` and `cxlOnClosePos: true` (OKX cancels it when the position is fully
  closed); in long/short mode with the position's `posSide` instead.
  - The position is the one of `instId`, `mgnMode` and, in long/short mode, `posSide` (required there) in the
    server's mirror; `VALIDATION` (400) when there is none.
  - The stops are read fresh from the exchange and summed with `stopCoverage`. `sz` defaults to the contracts they
    leave uncovered; `VALIDATION` (400, `details: { covered, size }`) when nothing is uncovered or `sz` is more
    than that, so this route never creates more stop than position.
  - The trigger is rounded and checked as for a move: to `tickSz` towards the price, and on the losing side of
    the live mark price (`VALIDATION` with `details: { slTriggerPx, markPx }`; `NO_PRICE` without a live mark).
  - `algoClOrdId` is `sl` followed by a generated id.
- `POST /api/algo-orders/cancel` cancels whatever algo order rests under that `algoId`; like the cancel of an order
  it needs neither a tracked instrument nor the order in the server's list. The exchange's refusal (an unknown or
  already triggered order) is passed on as `EXCHANGE` with `details.okxCode`.
- The three writes need credentials and the trade permission (`NOT_CONNECTED`, `READ_ONLY_KEY`), not the private
  stream, and are accepted while the kill switch is on. Each is logged and recorded as a risk event
  (`STOP_PLACED`, `STOP_AMENDED` with `from` and `to`, `STOP_CANCELED`).
- Not offered: changing the size of a stop (cancel it and place a new one for the size wanted) and moving the stop
  of an entry that is still resting (cancel the entry and place it again). Take-profits and trailing stops: see
  "Exit orders" (paper trading and the local mock only).
- `stopCoverage(position, algoOrders)` in `@pegasus/shared` sums the stops of a position (same instrument, margin
  mode and leg, on the closing side; a `closeFraction` stop counts that fraction of the position) and reports
  `none`, `partial`, `full` or `over`. The positions table shows it in its Stop column: the trigger prices, and a
  tag unless the stops close exactly the position (`over`: a lot was closed and its stop was left resting).

Exits. An order that can only reduce exposure (reduce-only in net mode, the closing direction of a leg in long/short
mode) skips the leverage, slippage and exposure rules, so it is neither refused with `LEVERAGE_UNAVAILABLE` nor with
`NO_BOOK`: its preview carries `lever: ''` and, while the book is not synced, `estSlippagePct: ''` with `refPrice`
taken from the ticker or mark price. It still needs a price (`NO_PRICE`) and still passes the price band.

Exit orders: take-profits, the cost-price stop and trailing stops (paper trading and the local mock only). They are
offered only where nothing can reach an OKX account: against the paper exchange (`PAPER_EXCHANGE_URL`) or a mock
exchange on this machine (all four `OKX_*_URL` overrides on a loopback host); `AppConfig.exits.enabled` says which.
Elsewhere (live trading, OKX demo trading) every request that uses them is refused with `403 EXITS_UNAVAILABLE` and
nothing is sent; orders and stops without them work exactly as before. The OKX side is in docs/okx-api-notes.md 6.10.

New fields of `PlaceOrderRequest` (`POST /api/orders`, `POST /api/orders/preview`), all optional:

| field | |
| --- | --- |
| `takeProfits` | `{ triggerPx, fraction }[]`, 1 to 5 legs whose fractions add up to at most 1: take-profits attached to the opening order, mark-triggered, executed at market, created by the exchange once the order has **completely** filled |
| `breakevenAfterTp1` | with `slTriggerPx` and two legs or more: the stop-loss moves to the order's average fill price when the first take-profit triggers (OKX's cost-price stop) |
| `trailing` | `{ kind: 'callback', ratio, activePx? }` or `{ kind: 'channel', bars }` (2 to 100): a trailing exit for the position the order opens, placed once the order has filled (below) |
| `source` | `'manual'` (default) or `'signal'`: for the trade journal; never sent to OKX |
| `signal` | the `SignalSnapshot` a `'signal'` order follows: for the trade journal; never sent to OKX |

- **Client order ids.** An order with `source: 'signal'` gets a server-made `clOrdId` starting `ps`
  (`SIGNAL_CL_ORD_PREFIX`); one the page sends must start with `ps` too, and only a signal order's may: otherwise
  `400 VALIDATION` (the page retries under its own id, so the server does not rewrite it). Manual orders keep `pg`,
  the campaign's `pc`.
- **The legs.** Each trigger is rounded to `tickSz` towards the entry (down for a long, up for a short: the smaller
  profit). The legs are sized in whole lots of the order's size, every leg but the last at its fraction rounded down
  and the **last one takes what the others leave**: OKX refuses attached take-profits whose sizes do not add up to the
  order's (51083), so the legs always cover the whole order, also when the fractions add up to less than 1. A partial
  take-profit with the rest left to a trailing stop is set on the open position instead (`POST /api/positions/take-profits`).
  `OrderPreview.takeProfits` lists the legs as sized: `{ triggerPx, fraction, sz, profitQuote }[]` (`profitQuote`: the
  quote-currency profit if the leg fills at its trigger, measured from `refPrice`); absent without `takeProfits`.
- **What is sent.** One leg: one `attachAlgoOrds` object holding the take-profit and, with `slTriggerPx`, the stop-loss
  (OKX makes it an `oco` order). Two legs or more: split take-profits, one object per leg (`tpTriggerPx`, `tpOrdPx: "-1"`,
  `tpTriggerPxType: "mark"`, `sz`, `attachAlgoClOrdId` `tp1`…`tp5` + the tail of the `clOrdId`) and the stop-loss in an
  object of its own, with `amendPxOnTriggerType: "1"` for `breakevenAfterTp1`.
- **Refused before anything is sent:** an order that closes a position, or in net mode reduces the open net position
  (`400 VALIDATION`, as for `slTriggerPx`); a leg that comes to less than `minSz` (`400 TP_LEG_TOO_SMALL`, `details`:
  `{ leg, sz, minSz, orderSz }`); two legs with one trigger once rounded (`400 TP_TRIGGERS_NOT_DISTINCT`);
  `breakevenAfterTp1` without `slTriggerPx` or with fewer than two legs (`400 BREAKEVEN_NEEDS_SPLIT_TP`); no live mark
  price (`503 NO_PRICE`). The risk verdict (`preview.risk`, `422 RISK_REJECTED` on `POST /api/orders`) carries, once the
  order itself passes: `TP_WRONG_SIDE` (a trigger not above both the reference price and the live mark for a long, not
  below both for a short; `details`: `{ leg, triggerPx, entryPx, markPx }`), `CALLBACK_RATIO` (a `callback` ratio outside
  0.1% to 20%, `CALLBACK_RATIO_MIN` / `CALLBACK_RATIO_MAX` in `@pegasus/shared`; OKX's own bounds are not published) and
  `ACTIVE_PX_WRONG_SIDE` (an `activePx` not above both the mark and the last price for a long, not below both for a short).
  The opening order itself is checked as any other: the kill switch refuses it.
- **The trailing exit of an order** is remembered by its `clOrdId` (in `TRAILING_STATE_FILE`, so a restart keeps it) until
  the order has filled, completely or partly and then cancelled; an order cancelled before any fill drops it. Then it
  is placed for the position as it is: `callback` becomes the exchange's trailing stop for the whole position (as
  `POST /api/positions/trailing-stop`, `algoClOrdId` `tr` + the tail of the order's `clOrdId`), `channel` sets channel
  trailing for it (as `POST /api/positions/channel-trailing`, `source: 'order'`). A placement that fails for a passing
  reason is tried again every 30 s, up to 10 times; one that is refused is dropped and logged as an error.
  `TrailingView.pending` lists what waits.

Exits for an open position. Each route only reduces the position, so the kill switch does not refuse it (as with
`POST /api/algo-orders`); each needs credentials and the trade permission, not the private stream. The position is
`instId`, `mgnMode` and, in long/short mode, `posSide` (required there) in the server's mirror: `400 VALIDATION` when
there is none. A position of the campaign (an isolated one on an instrument with an open campaign) is refused with
`409 CAMPAIGN_POSITION`: its exits are the rule's. What they place is listed in `GET /api/algo-orders` and cancelled with
`POST /api/algo-orders/cancel`.

- `POST /api/positions/take-profits`: one OKX `conditional` take-profit per leg, mark-triggered, executed at market, on
  the closing side; in net mode with `reduceOnly` and `cxlOnClosePos` (the exchange cancels it with the position), in
  long/short mode with the position's `posSide`. Each leg closes its fraction of the position in whole lots, the last
  one what the others leave of the fractions' sum (so the legs may cover less than the position). Refused: a leg below
  `minSz` (`TP_LEG_TOO_SMALL`), equal triggers (`TP_TRIGGERS_NOT_DISTINCT`), legs that with the take-profits already
  resting for the position would close more than it holds (`400 TP_EXCEEDS_POSITION`, `details`: `{ existing,
  requested, size }`), `TP_WRONG_SIDE` against the position's average price and the live mark (`422 RISK_REJECTED`). The
  legs go out one after the other; when the exchange refuses one, the ones placed before it are cancelled and its
  refusal is passed on (`EXCHANGE`). `algoClOrdId`: `tp1`…`tp5` + a generated id. Risk event `TAKE_PROFITS_PLACED`.
- `POST /api/positions/trailing-stop`: the exchange's trailing stop (OKX `move_order_stop`) for `sz` contracts (whole
  lots, at least `minSz`; the whole position by default), on the closing side, reduce-only in net mode, `posSide` in
  long/short mode. It closes once the **last price** has come back `ratio` from its highest (lowest, for a short) since
  it was activated: at `activePx` (rounded to the tick towards the price), or at once without one. Refused:
  `CALLBACK_RATIO`, `ACTIVE_PX_WRONG_SIDE` (`422 RISK_REJECTED`), more than the position with the trailing stops already
  resting (`400 TRAILING_EXCEEDS_POSITION`). OKX does not amend a trailing stop: cancel it and place a new one.
  `algoClOrdId`: `tr` + a generated id. Risk event `TRAILING_STOP_PLACED`.
- `POST /api/positions/channel-trailing` (`bars` 2 to 100): channel trailing for the position. The API keeps the
  position's stop-loss at the lowest low (a long) or highest high (a short) of the last `bars` confirmed daily bars
  (OKX `1Dutc`; `channelStopLevel` in `@pegasus/shared`, the exit line of the campaign rule with 10 bars) and moves it
  after each 00:00 UTC daily close, never against the position: every stop of the position on the wrong side of the
  level is amended to it (one the exchange will not amend is cancelled and placed again for its size), and what the
  stops leave uncovered gets a stop at the level (`algoClOrdId` `ch` + a generated id); a stop already beyond the level
  stays. The level of the last close is applied at once. The clock is looked at every minute; a close whose daily bar
  is not confirmed yet is tried again at the next look. Closes missed while the API was not running are caught up with
  at the first look after a start: the best of their levels is applied. A level the mark has already passed is not
  applied (the stop would fire at once); the entry's `lastError` says so. The stop rests at the exchange; moving it needs
  the API running. Every move is logged and recorded as a risk event (`CHANNEL_STOP_MOVED`). Setting it again for a
  position replaces its `bars`.
- `POST /api/positions/channel-trailing/clear`: ends channel trailing for the position (`cleared: false` when it was not
  trailed); its stop stays where it is. Channel trailing also ends by itself when the position is closed or turns to
  the other side.
- `GET /api/trailing`: `TrailingView` (`@pegasus/shared`): `enabled`, `entries` (one `ChannelTrailingEntry` per position:
  `instId`, `mgnMode`, `posSide`, `direction`, `bars`, `source` (`order` or `route`), `clOrdId`, `since`, `level` and
  `levelClose` (the channel of the last close processed, and that close), `algoIds` (the stops it keeps), `lastMove`
  (`{ at, close, algoId, action: 'placed' | 'amended' | 'replaced', from, to }`), `lastError` (`{ at, message }`, null once
  a run completed)), `pending` (the trailing exits waiting for their order to fill), `nextCloseAt`, `ts`.
- Leftovers. OKX keeps a trailing stop when its position is fully closed (it has no `cxlOnClosePos`), and the TP/SL
  orders placed without `cxlOnClosePos` (Pegasus sends it in net mode only); they would act on the next position of that
  side. Every algo order list read is looked through for the algo orders Pegasus placed (client ids `sl…`, `ch…`,
  `tp1…`, `tr…`) that are older than 30 s and close no open position: they are cancelled, logged and recorded as a risk
  event (`EXITS_OF_CLOSED_POSITION_CANCELED`). Orders Pegasus did not place are left alone.
- Settings: `TRAILING_STATE_FILE` (default: next to `STATE_FILE`, named after it: `data/pegasus-state.paper.json` gives
  `data/pegasus-state.paper.trailing.json`), the JSON file of the channel trailing entries and the pending trailing exits,
  written whole after every change, read at start. A file that is not valid is kept aside as `<file>.corrupt` and never
  written over: channel trailing does nothing (and refuses to be set: `503 TRAILING_STATE_UNREADABLE`) and the trailing
  exits of new orders are kept in memory only, until it is repaired or moved away.

Leverage. A preview reads the leverage through a 30 s cache; `POST /api/orders` always reads it fresh from OKX, so a
change made on OKX itself is seen by the next order. A reply without a leverage row is `LEVERAGE_UNAVAILABLE`, never 1x.

Exposure rules (`RiskCheckResult.code` `MAX_POSITION_NOTIONAL`, `MAX_TOTAL_NOTIONAL`, `EXPOSURE_UNKNOWN`):

- Long/short mode: the two legs of an instrument are summed (gross). Resting orders count only when they open.
- Net mode: resting orders may fill or not, so an instrument is projected at the worse of "every resting buy fills"
  (position + buys) and "every resting sell fills" (−position + sells), with the new order on its own side. A resting
  sell therefore never makes room for more buys. Resting reduce-only orders are not counted.
- Resting orders on instruments outside `INSTRUMENTS` count too (the server keeps the contract spec of every SWAP OKX
  lists at startup). If a resting opening order still cannot be valued, opening orders are refused with
  `EXPOSURE_UNKNOWN` (`details.instId`, `details.ordId`) until it is cancelled or filled.
- An accepted opening order is reserved against the limits from its risk check until its fill shows in the positions
  (or it is cancelled unfilled, or refused by OKX), at most 10 s after the acknowledgement. Orders sent in quick
  succession, or concurrently, therefore cannot each pass on the same account snapshot; right after a fill a further
  order can be refused for up to 10 s although the limits would allow it.

`ConnectionStatus` (in `hello` and the `connection` message):

```ts
interface ConnectionStatus {
  okxPublic: ConnState;    // 'connected' | 'connecting' | 'disconnected'
  okxPrivate: ConnState;   // 'connecting' until the private socket is logged in
  okxBusiness: ConnState;
  account: AccountStatus;  // see below
  demo: boolean;
  dataAgeMs: number;       // ms since the stalest watched stream last delivered anything; -1 before the first frame
  staleStreams: string[];  // "<instId>:<ticker|book|mark>", e.g. "SOL-USDT-SWAP:book"
}
```

`AccountConfig` and `AccountStatus`:

```ts
interface AccountConfig {
  posMode: 'net_mode' | 'long_short_mode';
  acctLv: string;
  canTrade: boolean;       // false when the API key lacks OKX's trade permission (perm of GET /account/config)
}

interface AccountStatus {
  state: 'disabled' | 'starting' | 'ok' | 'error';
  error: { code: string; message: string; ts: number } | null;
  lastSyncAt: number | null;  // server time of the last successful REST reconcile or private push
  readOnly: boolean;          // the key is known to lack the trade permission
}
```

Account status. `disabled` means no API key is configured (market data only); `starting` that the first load is
still running; `error` that the last start attempt, the last reconcile or the login of the private socket failed.
`error.code` is OKX's own code (for example `50105`, `50110`, `60009`) and `error.message` its text verbatim;
`code` is `''` when the failure did not come from the exchange (network, timeout). The start is retried for ever
(5 s, 10 s … 60 s apart) and the account is reconciled every 60 s; the config (position mode, permissions) is
re-read with every reconcile, so a change made on OKX is picked up within a minute and announced with the
`account` message. Until the config was loaded once the position mode is unknown: `config` / `hello.account` are
null and previews, writes and `GET /api/account/leverage` answer `NOT_CONNECTED`. Placing an order
(`POST /api/orders`) also needs the private stream, because its risk checks read the live account; it is the only
route that does. Cancels, `/api/positions/close` and reading or setting the leverage are plain REST calls and work
while the stream is down. With a key that cannot trade (`canTrade` false) every write
(`POST /api/orders`, `/api/orders/cancel`, `/api/orders/cancel-all`, `/api/positions/close`,
`POST /api/account/leverage`) answers `READ_ONLY_KEY` before anything is sent to the exchange; previews and
`GET /api/account/leverage` keep working.
When `perm` is missing or empty the key is assumed to be able to trade and the exchange decides.

Account mirror. An open order that a reconcile no longer finds among OKX's pending orders is looked up; if OKX
answers that it does not exist (`51603`, a cancelled order it has purged) the order is removed and sent as an
`order` message with `state: 'canceled'` once it was missing from two reconciles in a row or is older than two
minutes. Its real final state is unknown; it is reported as cancelled. A balance push without a total equity keeps
the last `totalEq` (the risk engine never sees an empty equity as zero).

Stale market data. The server watches the ticker, order book and mark price of every tracked instrument by the
local time of their last frame. A stream is stale when the public socket is ready and nothing arrived for 30 s
(mark price), 90 s (order book) or 120 s (ticker), counted from the later of its last frame and the moment the
socket became ready; a book whose resync is backing off is stale too, and while the public socket is not ready
every stream is. A book that was resubscribed after falling out of sync and has no snapshot 10 s later counts as
one more failed resync and is retried under the same backoff. Stale data is never used as a price: `/api/book` answers `NO_DATA` and order previews fail
with `NO_PRICE` / `NO_BOOK` until fresh frames arrive (values received before a reconnect do not count as fresh).
`/api/ticker` and the `ticker` / `markPrice` messages keep the last value for display. A watchdog re-subscribes
a stale stream (once per 5 minutes per stream, at most 20 per hour) and reconnects the public socket when three
or more streams are stale or a re-subscribe did not help within 60 s (at most once per 10 minutes, 6 per hour).

`reduceOnly` is only forwarded to OKX in net position mode; in long/short mode it is ignored and a
position is closed by sending the opposite side with the position's `posSide`. The terminal's ticket has no
free position-side control in long/short mode: it derives `posSide` from the side button and its "Close / reduce
existing position" checkbox (opening: buy → long, sell → short; closing: buy → short, sell → long).

The terminal sends its own `clOrdId` (`pgw…`) with every `POST /api/orders`. When the outcome of a submit is
unknown (`NETWORK`, `INTERNAL`, `EXCHANGE_UNREACHABLE`, `ORDER_STATUS_UNKNOWN`, or any other 5xx that is not an
explicit refusal) a retry of the identical order reuses that id and carries `retry: true` (an optional field of
`PlaceOrderRequest`, never forwarded to OKX). OKX refuses a reused id as a duplicate (`EXCHANGE`,
`details.okxCode` = `51016`) only while the first order still rests; a filled or cancelled order frees its id. The
server therefore remembers the `clOrdId` of every order it sent that was not definitely refused (the newest 200,
in memory, lost on a restart). A `POST /api/orders` that carries `retry: true` with a `clOrdId`, or whose `clOrdId`
the server remembers for the same instrument, is first looked up at OKX (`GET /trade/order`, one request): if the
earlier order exists, nothing is sent and the answer is that order in its current state (`filled`, `live`, ...)
with a `preview` built from it; if OKX says it does not exist (`51603`) the order is submitted normally; if the
lookup fails, nothing is sent and the answer is `ORDER_STATUS_UNKNOWN`. Other orders are not looked up. A retry
made after the page was reloaded is a new order under a new id and is not protected: check Positions, Fills and
Open orders first.

`Position.margin` is the posted margin of an isolated position and the initial margin requirement (`imr`) of a
cross position; `""` when OKX reports neither. `Position.lever` is the leverage set for the position: an isolated
position runs at `notionalUsd / margin`, which a margin added or taken out by hand changes (a campaign's position is set
to the instrument's highest leverage and runs at 10x, see "Campaign"). `liqPx` is the exchange's estimated liquidation
price (`""` when it reports none). `mgnRatio`, the margin level (`"1"` is 100%: an isolated position is liquidated at 1
or below), and `mmr`, the maintenance margin requirement in the margin currency, are optional: absent when OKX reports
none, never `"0"`.

Liquidations. The exchange closes a liquidated isolated position with an order of its own. It reaches the terminal as
an `order` message (and a row of `/api/orders/history`) with `category: 'full_liquidation'` (`'partial_liquidation'`
for a partial one; `isLiquidationOrder` in `@pegasus/shared`), `clOrdId: ''` and `state: 'filled'`; its `pnl` and
`fee` together are the lost margin. Its `fill` message carries `tradeId: '0'` (OKX's own list of fills, `/api/fills`,
gives it a negative id), so a fill is identified by `ordId` together with `tradeId`: two liquidations of one
instrument are two fills, in the terminal and in the journal (whose key is `(instId, tradeId, ordId)`). A `positions`
message without the position and a `balance` without its margin follow. `Order.category` is optional: OKX's category
of the order (`normal` for an order of the trader; also `adl`, `twap`, `delivery`, `ddh`, `auto_conversion`), absent
until the exchange has reported the order (the row `POST /api/orders` answers with), for a category the server does
not know, and on rows read back from the database. A liquidation is not an order of the server: no rule can stop it.
The daily loss limit sees it through the equity like any other loss (the open loss while the mark falls, the rest when
the margin is taken), and a position cannot lose more than its margin.

Paper trading. With `PAPER_EXCHANGE_URL` set (the launcher's `--paper`, or `PAPER_TRADING=1` in `.env`) the API
keeps reading market data from OKX's live hosts (`OKX_DEMO` is ignored, `demo` is `false`) and sends every signed
REST request and its private WebSocket to the paper exchange at that URL (`packages/paper`), which speaks the same
OKX protocol. The contract of this document does not change: routes, messages and error codes are the same, an
`EXCHANGE` error carries the paper exchange's code. What differs:

- `hello.paper` and `GET /api/health` `paper` are `true`; the terminal shows the badge PAPER.
- No OKX key is used. Credentials in the environment are ignored (the API signs with a placeholder and the paper
  exchange checks no signature), so one or two of the three being set is not an error in this mode.
- The account is the paper account in `PAPER_STATE_FILE` (default `data/paper-account.json`): balance, positions,
  orders, stops and a funding ledger. Matching, the replay of the time it was not running, funding and what is
  not simulated (queue position, take-profit) are described in the README ("纸面交易") and in the headers of
  `packages/paper/src/replay.ts`, `funding.ts` and `live-market.ts`. Isolated margin is simulated, the liquidation of
  isolated positions on the mark price included (tier 1 only, in full); cross positions are not liquidated. Its rules
  are in the header of `packages/mock-okx/src/engine/margin.ts`.
- The launcher gives the API its own `STATE_FILE` (`data/pegasus-state.paper.json`) and no `DATABASE_URL`, so the
  kill switch, the day baseline and the journal of the paper account are not mixed with a real account's. With
  `--campaign` the paper account is the campaign pot's own (`data/paper-campaign.json`) and the API's state file
  `data/pegasus-state.campaign.json` (see "Campaign").
- The launcher gives every account its own trade journal (see "Trade journal"): `JOURNAL_FILE` is
  `data/journal.paper.json` with `--paper`, `data/journal.mock.json` with `--mock` and `data/journal.campaign.json`
  with `--campaign` (`data/journal.json`, the default, otherwise). `--campaign` also runs on ports of its own, API
  8788, paper exchange 9201 and page 5175 (`CAMPAIGN_API_PORT`, `CAMPAIGN_PAPER_PORT` and `CAMPAIGN_WEB_PORT` in the
  environment or `.env` move them; `API_PORT` and `PAPER_PORT` are the other stack's), with `WEB_ORIGINS`
  `http://localhost:5175,http://127.0.0.1:5175`, its log files in `logs/campaign` and its page built into
  `apps/web/dist-campaign`, so that it runs beside `pnpm start` or `pnpm start --paper`. Every page reaches the API
  of its own stack same-origin, through the proxy of its page server (`scripts/vite.stack.config.mjs`: the web app's
  `vite.config.ts` with the stack's ports); the API checks the page's `Origin` against its `WEB_ORIGINS` and the
  token. Both APIs read `API_TOKEN` from the same `.env`; a page on another port keeps its own copy of the token, so
  it asks for it once.
- While `CAMPAIGN_ENABLED=1` the paper exchange trades the campaign's instruments (`CAMPAIGN_INSTRUMENTS`) besides its
  own (`PAPER_INSTRUMENTS`, the ten of the campaign by default) and `INSTRUMENTS`.
- Order and fill times of events that were replayed are the times they happened at (the end of their candle),
  not the time the program was started again.

Campaign (paper trading only). The API can run the campaign rule of `packages/shared/src/campaign.ts`: isolated longs
at 10x on a hard-capped pot. Settings (`.env`):

| variable | default | |
| --- | --- | --- |
| `CAMPAIGN_ENABLED` | `0` | `1` enables it. The API refuses to start with it (`invalid configuration: CAMPAIGN_ENABLED=1 is refused: this stage of the campaign is paper only …`) unless it runs against the paper exchange (`PAPER_EXCHANGE_URL`, which `pnpm start --paper`, `pnpm start --campaign` and `PAPER_TRADING=1` set): in that mode no OKX key is used at all |
| `CAMPAIGN_INSTRUMENTS` | `BTC`, `ETH`, `LTC`, `XRP`, `BCH`, `ETC`, `LINK`, `ADA`, `DOT`, `TRX` `-USDT-SWAP` (`CAMPAIGN_INSTRUMENTS` of `@pegasus/shared`, also the paper exchange's and the backtest's default list) | USDT swaps only. While the campaign is enabled they are tracked after `INSTRUMENTS` so that their markets are subscribed: market data, `hello.instruments`, `/api/instruments`; the paper exchange trades them too. The SIGNALS tab and the default list of `/api/signals` stay `INSTRUMENTS` |
| `CAMPAIGN_POT_START` | `56` | what the pot starts with, USDT |
| `CAMPAIGN_MIN_STAKE` | `5.6` | the smallest stake; one above `CAMPAIGN_POT_START` is refused |
| `CAMPAIGN_STRUCTURE` | `pyramid` | `pyramid` (a campaign that works adds to itself) or `noadd` |
| `CAMPAIGN_STATE_FILE` | `data/campaign-ledger.json` | the campaign's ledger (below), under the repository root unless the path is absolute; kept in this file whichever store the API uses. It belongs to the paper account the pot runs on: a new paper account wants a new ledger |

The campaign's leverage (10) and the fee rate it sizes with are the rule's (`DEFAULT_CAMPAIGN_PARAMS`), not settings.
A pot runs the structure, start and minimum stake it was started with; a later change of the settings applies to a
new pot only.

`pnpm start --campaign` (or `start-campaign.bat`) is paper trading on the pot's own paper account: the paper exchange
keeps it in `data/paper-campaign.json` (a new account opens with `CAMPAIGN_POT_START` USDT, 56 unless `.env` says
otherwise; an existing one keeps its balance) and trades the campaign's instruments, the API runs with
`CAMPAIGN_ENABLED=1`, the ledger in `data/campaign-ledger.json` and its kill switch and day baseline in
`data/pegasus-state.campaign.json`. Those win over `.env` for that run; the owner's paper account
(`data/paper-account.json`) and the plain paper mode's state file are not touched. It cannot be combined with `--mock`.

The campaign service (`apps/api/src/services/campaign.ts`; its header gives the live counterparts of the replay's
timing rules C1-C13, the decisions are `campaign-step.ts`'s) runs the rule by itself:

- The pot needs a paper account of its own. With a new ledger it starts only on an account whose total equity is
  within 1% of `CAMPAIGN_POT_START` and that holds no position and no open order. Otherwise the status is `blocked`
  (`ACCOUNT_NOT_DEDICATED`) and the message says to start the paper exchange on a new `PAPER_STATE_FILE` with
  `PAPER_BALANCE` equal to the pot; the account is looked at again every 15 s and the API keeps running either way.
  At the start the ledger records the time, the account's total equity and the mark price of `BTC-USDT-SWAP`.
- At every 00:00 and 12:00 UTC close it polls the instruments' UTC bars (OKX `12Hutc`, and `1Dutc` at 00:00) every
  5 s until the bar that closed is confirmed, for up to 10 minutes; an instrument still unconfirmed then gives no
  signal at that close. Then, in this order: the liquidations, the ladder on the pot, the harvest sales, the exits,
  the adds, the entries in `sameCloseOrder`. Entries and exits are read at 00:00 only, adds and the ladder at both
  closes. The quantities are computed when an order is sent, at the open of the 12-hour bar after the close, with the
  free cash left then; a stake below the minimum stake or the minimum order is a skip.
- The pot's free cash is the account's available USDT less the ledger's banked amount; its value is the free cash
  plus the equity of the open campaigns at the mark. Banking is a ledger entry: nothing is transferred on the paper
  exchange. What an open, a sale and an exit took or returned is measured from the available balance before and after.
- A liquidation ends its campaign as soon as the account service reports the order of category `full_liquidation`.
  Every step also ends a campaign whose position is gone, as the exchange's order history explains it: a liquidation;
  a close by an order that is not the campaign's (its client order id does not start with `pc`), which ends the
  campaign `external`; or unknown, an execution error. A position on a campaign instrument that the ledger does not
  know is reported (`foreign`), never touched, and no entry is made on that instrument.
- Exits and harvest sales are retried while the failure is transient (`NOT_CONNECTED`, the exchange unreachable or
  busy, an answer that was lost: the position is read before a retry, so an order that went through is not sent
  again) for up to 30 minutes; an exit still not carried out is attempted again at every later step. Entries and adds
  are retried on a transient failure within the 10 minutes after the close. Under the kill switch entries and adds
  are skipped, logged; exits and sales go on.
- A close the service could not process within 10 minutes (it was not running, the account could not be read) is
  missed. At the next start or step an exit signal at a missed close is carried out then, late (`end.delayMs`); adds
  and entries that were due are only logged (outcome `missed`), and the add reference moves as if the add had been
  made; the ladder is looked at on the pot as it is then. `missedCloses` counts them.
- Execution errors are counted exactly (`errorCount`): an action the rule decided that was not carried out as decided
  (`RISK_REJECTED`, `EXCHANGE`, the order operations' `CAMPAIGN_…` codes; an exit that still fails after its retries
  counts once at every step it fails at), one that left a position in a state the rule does not have
  (`CAMPAIGN_OPEN_UNCONFIRMED`, whose position becomes the campaign's; `CAMPAIGN_MARGIN_FAILED`;
  `CAMPAIGN_MARGIN_UNRESTORED`), an order the book filled only in part (`CAMPAIGN_PARTIAL_FILL`: the entry, add or sale
  is kept as filled; an exit instead sells the rest again, up to three orders at a step, and only one that still leaves
  part of the position is an error, `CAMPAIGN_EXIT_INCOMPLETE`, carried on at the next step with what it returned so
  far), and a position gone without explanation (`CAMPAIGN_POSITION_UNEXPLAINED`, or `CAMPAIGN_CLOSE_UNRECORDED` for a
  close of the campaign's own that the ledger did not record). Skips the rule foresees (`cash`, `min-size`, `add-cap`,
  `kill-switch`, `foreign-position`, and `position-gone` for an add whose position is gone already, which the next
  step's reconcile explains), retries that succeeded, liquidations and `external` ends are not errors.
- After a step that leaves no campaign open and less free cash than the minimum stake the pot is `finished`
  (`POT_FINISHED`) for good; no other pot is started.

The ledger (`CAMPAIGN_STATE_FILE`) is JSON with a schema version (`version: 1`), written whole after every change
through a temporary file and a rename, and read at start. A file that cannot be read or is not valid is never written
over: the status is `blocked` (`LEDGER_UNREADABLE`), nothing is traded, and a copy is kept as `<file>.corrupt`. It
holds the pot, every campaign, the bankings, one sample per close processed, the decision log of the last 1,000 steps,
the execution errors (the last 500 with their details, all of them in the count), the closes missed and the last close
processed. Its types and the ones of the routes are in `packages/shared/src/campaign-api.ts`.

`GET /api/campaign` answers a `CampaignView` (also the `campaign` WebSocket message):

```ts
interface CampaignView {
  status: 'disabled' | 'blocked' | 'running' | 'finished';
  reason: { code: string; message: string } | null; // CAMPAIGN_DISABLED, LEDGER_UNREADABLE, ACCOUNT_NOT_DEDICATED, ACCOUNT_UNAVAILABLE, POT_FINISHED; null while running
  params: CampaignParamsView;      // instruments, potStart, minStake, structure, leverage, feeRate, addStep, entryChannel, exitChannel, stakeFraction, rungFactor, bankFraction
  pot: CampaignPotView | null;     // null until it started: startedAt, startValue, btcMarkAtStart, structure, start, minStake, banked, rungs,
                                   // peak { ts, value }, finishedAt; from the account now: freeCash, openEquity, value (null while unknown); nextRung
  campaigns: CampaignRecordView[]; // newest first: the ledger's record, its position now (position, null once ended) and valueMultiple
  bankings: CampaignBankingRecord[]; // oldest first: { closeTs, rungs, value, target, fromCash, fraction, fromSales, amount }
  samples: CampaignSampleRecord[];   // one per close processed, oldest first: { ts, freeCash, openEquity, banked, value, open }
  errorCount: number;
  errors: CampaignErrorRecord[];     // the last 50, newest first: { ts, closeTs, campaignId, instId, action, code, message, details }
  missedCloses: number;
  foreign: string[];                 // '<instId> <mgnMode> <posSide> <pos>' as the last step found them
  lastStep: { seq: number; kind: 'close' | 'catch-up'; closeTs: number; startedAt: number; endedAt: number | null; errors: number } | null;
  nextStep: { closeTs: number; daily: boolean } | null; // null unless running
  replay: { status: 'unavailable' | 'running' | 'ready' | 'failed'; computedAt: number | null; mismatches: number | null } | null;
                                   // the replay beside the pot (below): enough to know when to fetch GET /api/campaign/replay again; null while disabled
  serverTime: number;
}
```

A campaign record (`CampaignRecord`): `id` (`<instId>@<close of the entry>`), `instId`, `signalTs`, `entry` (its order,
the `stake` measured from the balance, the position's `margin`, the `price` it was sized at), `adds`, `sales` (each
with its order; a sale also with the contracts `held` before it and the `proceeds` banked), `addRef`, `addUnit` (base
coin), `stake`, `basis`, `harvested`, `peak`, `pendingExit`, `end` and `multiple`. `end.kind` is `exit`, `liquidated`,
`harvest` (a harvest sold all of it), `external` or `unknown`; `end.proceeds` is `''` when it was not measured
(`external`, `unknown`), and an exit carries the `closeTs` of its signal and `delayMs`. `multiple` is
(harvested + end.proceeds) / stake, null while open or not measured. Fees are positive when paid; the times of orders
are the exchange's, the closes and the steps the service's.

`GET /api/campaign/log` answers `{ steps, total, next }`: `limit` steps, newest first, older than the step `before`
(its `seq`); `next` is the `before` of the next page, null at the end; `total` is the number of steps kept. A step:
`{ seq, kind, closeTs, closes, startedAt, endedAt, before, inputs, actions, errors, notes }`, where `before` is the
pot as the step found it, `inputs` what each instrument's bars said at each close (the 12-hour bar, the price, the
daily close with the channel levels and the signals) and an action is `{ kind, closeTs, instId, campaignId, plan,
outcome, reason, result, attempts, error, ts }`: `kind` `bank`, `sell`, `exit`, `add`, `enter`, or what a step found,
`liquidated`, `gone`, `foreign`; `outcome` `done`, `skipped`, `missed`, `failed` (an execution error, `error` true) or
`noted`.

While the campaign is disabled the routes answer: `status: 'disabled'` with the settings (`replay: null`), an empty
log, and a replay `unavailable` (`CAMPAIGN_DISABLED`), to a POST too.

The replay beside the pot (`apps/api/src/services/campaign-replay.ts`, the library `@pegasus/backtest/campaign`,
`packages/backtest/src/campaign/pot.ts`). The campaign replay of the backtest is run on OKX's bars from the pot's
start with the pot's own rule (its structure, start and minimum stake, the service's other parameters), its free cash
starting at the pot's `startValue`, within the exchange's limits (adds cut to `maxLever` x margin, liquidation at the
first maintenance tier plus the fee, the modelled slippage) and with OKX's own funding history (what the paper
exchange charged). It starts at the first 12-hour close after the pot's start (`startedAt`), the first one the service
looks at, and ends (`through`) at the last 12-hour close every instrument's confirmed bars have, never after now (an
instrument whose bars end more than a day earlier does not hold the others back). What the last close decided is
filled at the open of the bar running after it, as the live service trades right after a close (rule C14 of
`packages/backtest/src/campaign/engine.ts`). The same pot is replayed with the other structure (`noadd` beside
`pyramid`, and the reverse), and the pot's start value is held in BTC: `startValue` x the `BTC-USDT-SWAP` 12-hour
close over the price at the start (`btcMarkAtStart`, or when that is empty the close of the last 12-hour bar before
the start).

It is computed in the background, never in a step's way: after every step that processed a 00:00 UTC close, once at
start when a pot exists, when the pot starts, and on `POST /api/campaign/replay`. One computation at a time (one asked
for while another runs follows it, once); one that takes more than 5 minutes is given up (`REPLAY_TIMEOUT`) and the
next one waits for it to end. What it reads from OKX's public endpoints (history candles, the newest candles for the
running bar's open, the funding rate history) is kept in `data/campaign-replay/` under the repository root
(git-ignored), so after the first computation only the newest rows are read. A failure (`REPLAY_FAILED`, with OKX's
message) or a timeout leaves the last result in place with `status: 'failed'` and the `reason`; the next computation
that succeeds clears it. When the summary changes (`status`, `computedAt`, `mismatches`) the `campaign` message is sent.

```ts
interface CampaignReplayView {
  status: 'unavailable' | 'running' | 'ready' | 'failed';
  // unavailable: CAMPAIGN_DISABLED, POT_NOT_STARTED, LEDGER_UNREADABLE; failed: REPLAY_FAILED, REPLAY_TIMEOUT; null otherwise
  reason: { code: string; message: string } | null;
  computedAt: number | null;        // when the result given was computed (server time)
  through: number | null;           // the last 12-hour close it covers
  same: CampaignReplayRun | null;   // the pot's own structure
  other: CampaignReplayRun | null;  // the other structure, same start, same pot
  heldBtc: Array<{ ts: number; value: string }>; // one per 12-hour close from the first after the start to `through`
  reconciliation: CampaignReconciliation | null; // the ledger against `same`
}
interface CampaignReplayRun {
  structure: 'pyramid' | 'noadd';
  samples: Array<{ ts: number; value: string; banked: string }>; // one per 12-hour close, after its fills: free cash + open equity, and what was banked so far
  campaigns: CampaignReplayCampaign[]; // oldest entry first
  bankings: Array<{ closeTs: number; amount: string }>;
  value: string; banked: string;    // at `through` (at the close it finished at, when `finished`)
  finished: boolean;
}
interface CampaignReplayCampaign {
  instId: string;
  signalTs: number;                 // open time of the daily bar whose close gave the entry signal, as CampaignRecord.signalTs
  entryTs: number;                  // the open it was filled at: the close after the signal
  entryPx: string;                  // the fill: that open x (1 + slippage)
  stake: string; adds: number;
  end: 'exit' | 'liquidated' | 'open'; // a campaign the sale of a harvest closed is listed as 'exit' (its multiple holds what the harvests banked)
  endTs: number | null;             // open time of the 12-hour bar it ended in (an exit: the open it was filled at, the close of its signal)
  multiple: string | null;          // all it returned over its stake; null while open
}
```

The reconciliation compares the ledger's campaigns with `same`'s, keyed by instrument and `signalTs`, which means the
same on both sides and in the rows: the open time of the daily bar whose close gave the entry signal (the signal close
is `signalTs` + 1 day, the ledger's `entry.closeTs`). Only what both
sides can have by `through` counts: a ledger campaign entered at a later close is left out, and its adds, harvest
sales and end after `through` count as not made yet (an exit or a harvest belongs to the close it was decided at; a
liquidation, or a close by another order, to the 12-hour bar it happened in, and one in the bar running after
`through` is not seen yet). A row is `match`, `differs`, `live-only` (the ledger has a campaign the replay has not:
`campaignId` is the ledger's) or `replay-only` (`campaignId` null). Rows are oldest signal first; `matched`,
`differing`, `liveOnly` and `replayOnly` count them, and `mismatches` in the `campaign` view is the last three
together. `differences` lists `{ field, live, replay }` (empty for a match and for a one-sided row):

| field | live | replay | compared |
| --- | --- | --- | --- |
| `entryClose` | `entry.closeTs` | the open the entry was filled at | exactly (epoch ms as a string) |
| `entryPx` | `entry.avgPx`, the fill | open x (1 + slippage) | within `tolerances.entryPx` of the replay's, relative; null when the ledger has no fill price |
| `adds` | adds made by `through` | adds made | exactly (a count) |
| `sales` | harvest sales by `through` | harvest sales | exactly (a count) |
| `end` | `exit`, `liquidated`, `harvest`, `external`, `unknown`, or `open` | `exit`, `liquidated`, `harvest`, or `open` | exactly |
| `endClose` | an exit's signal close (`end.closeTs`), a harvest's close, else the open of the 12-hour bar of `end.ts` | `endTs` | exactly (epoch ms as a string), when both ended |
| `multiple` | `multiple` | `multiple` | within `tolerances.multiple` x the larger of 1 and the replay's multiple, when both ended (the ledger has none while open) |

`tolerances` is `{ entryPx: '0.01', multiple: '0.1' }` (fractions; `DEFAULT_RECONCILE_TOLERANCES`). Why: the replay fills
at the open of the bar after the close times 1 + slippage (0.05% on BTC and ETH, 0.10% on the others), while the live
service buys seconds to minutes after that close at the book's prices, walking the real book, and may fill later
still within the close's 10-minute window: 1% covers that drift and still catches a fill at the wrong bar or price.
At 10x every 0.1% between the live and the replayed fills of an entry and an exit moves a multiple by about 0.01 of
the stake, and partial fills (a campaign that holds less than the rule's quantity, its adds and sales sized on what
the book left), the live funding and a late exit after a missed close add to it: 0.1 of the stake (of the replay's
multiple above 1). A liquidation is the exchange's, on its mark price and its own tiers, where the replay liquidates on
the bar's traded low at the first tier: it can come a bar apart or not at all, which `end` and `endClose` show.

`pnpm backtest:campaign --reconcile <ledger file>` prints the same from the command line (`--json` prints the view);
see `pnpm backtest:campaign --help`.

What the rest of the API shows of the campaign's orders (`apps/api/src/services/campaign-orders.ts`, whose header
gives their steps: open, margin-neutral add, reduce, close):

- A campaign's position is an isolated long whose leverage set is the instrument's highest (so that an add posts as
  little margin as possible) while its margin keeps it at 10x: `Position.lever` shows the setting (`100` for BTC), the
  margin is moved with OKX's `POST /api/v5/account/position/margin-balance`. An isolated order of the terminal on
  that instrument would go into the same position; it is checked against the setting as always, so it is refused with
  `MAX_LEVERAGE` while `RISK_MAX_LEVERAGE` is below it. Cross orders are a position of their own and not affected.
- The campaign's orders pass the risk engine like any other, with one difference for the opening ones: `MAX_LEVERAGE`
  measures the leverage the isolated position will run at, its notional over its margin plus open P&L at the
  reference price, against the campaign's leverage (`RISK_MAX_LEVERAGE` when that is lower) plus 1% for rounding;
  the leverage set is not looked at (`details`: `lever`, `limit`, `notional`, `equity`, `setting`). Every other rule,
  the kill switch included, applies unchanged, and exits pass as always. A request of the terminal never carries
  this context.
- Taking margin out of an isolated position (the first step of a margin-neutral add) is refused while the kill
  switch is on; adding margin never is.
- The client order ids of its orders start with `pc`; the margin moves are recorded as `MARGIN_MOVED` risk events.
- Their error codes (no route returns them; the service records them as execution errors): `CAMPAIGN_PAPER_ONLY` (403); `CAMPAIGN_BUSY`,
  `CAMPAIGN_POSITION_EXISTS`, `CAMPAIGN_NO_POSITION`, `CAMPAIGN_POSITION_CONFLICT`, `CAMPAIGN_RESTING_ORDERS`,
  `CAMPAIGN_LEVERAGE`, `CAMPAIGN_INSUFFICIENT_BALANCE`, `CAMPAIGN_ADD_CAP`, `CAMPAIGN_NOT_FILLED`,
  `CAMPAIGN_POSITION_GONE` (409); `CAMPAIGN_MARGIN_FAILED` (`details.closed`), `CAMPAIGN_MARGIN_UNRESTORED`,
  `CAMPAIGN_BALANCE_UNKNOWN` (502); `CAMPAIGN_OPEN_UNCONFIRMED`, `CAMPAIGN_ORDER_UNKNOWN` (504); besides
  `RISK_REJECTED`, `EXCHANGE`, `SIZING`, `NO_BOOK` and `LEVERAGE_UNAVAILABLE`.

Campaign signals (`apps/api/src/services/campaign-signals.ts`, the rules in `campaign-signals-plan.ts`; types in
`packages/shared/src/campaign-signals.ts`). `GET /api/campaign/signals` reads the campaign rule of
`packages/shared/src/campaign.ts` coin by coin for every instrument of `CAMPAIGN_INSTRUMENTS` (the ten of
`@pegasus/shared` by default), in that order, whether the campaign is enabled or not, with the rule's parameters (the
pot's own while a pot runs, the settings otherwise). Its texts are codes with their figures (`params`), translated
by the page.

- Bars: the exchange's confirmed UTC bars (OKX `1Dutc` and `12Hutc`; through the market data service for a tracked
  instrument, the public candles otherwise), cached for 5 minutes and never across a 00:00 or 12:00 UTC close (15 s
  while the bar that closed there is not confirmed yet). A bar that is not confirmed is never read. The mark price is
  the live stream's, else OKX's public mark price (cached 10 s).
- Per coin (`CampaignSignalRow`): the last confirmed daily bar (`daily`: `barTs` its open time, the campaign's
  `signalTs`; `closeTs`; `close`) and 12-hour bar (`halfDay`); `levels`: `entry`, the highest high of the
  `entryChannel` (20) daily bars before the last one, and `exit`, the lowest low of the `exitChannel` (10) bars before
  it (what the last close was measured against), `nextEntry` and `nextExit`, the same channels ending with the last
  bar (what the next daily close is measured against); `markPx`; `entryDistancePct`, `nextEntry / markPx - 1` (the rise
  to the level the next close must beat; negative above it); `tracked` (an order needs the instrument tracked).
- `state`, by priority. With a long held on the coin (any margin mode; `holding` gives its contracts, average price,
  margin, leverage set, liquidation price, `trailingLine` = `nextExit`, the add reference and `addTrigger` = add
  reference x (1 + `addStep`)): `exit` when the last daily close was below `exit`, else `add` when the last
  confirmed 12-hour close, one that closed after the last opening fill, reached `addTrigger` (never in the `noadd`
  structure), else `holding`. The add reference is the average price of the last order that opened or added to the
  journal's trade of that long (`addRefSource: 'journal'`, `addRefTs` its first fill), else the position's average
  price (`'position'`). Without one: `entry` when the last daily close was above `entry`, else `near` when the mark is
  at most 3% below `nextEntry` or above it, else `none`. `unavailable` when the bars could not be read or there are
  fewer than 21 confirmed daily bars.
- `reasons` (codes and their `params`): `CLOSE_ABOVE_ENTRY` { close, level }, `NEAR_ENTRY` { markPx, level,
  distancePct, nearPct }, `MARK_ABOVE_ENTRY` { markPx, level }, `BELOW_ENTRY` { markPx, level, distancePct },
  `HOLDING` { contracts, trailingLine, addTrigger }, `CLOSE_BELOW_EXIT` { close, level }, `ADD_TRIGGER_REACHED`
  { close, trigger, addRef, barTs }, `ADDS_OFF` {}, `ADD_REF_FROM_POSITION` { avgPx }, `SHORT_HELD` { contracts } (a
  short on the coin: the rule is long only), `NOT_ENOUGH_BARS` { have, need }, `BARS_UNAVAILABLE` { message },
  `NO_MARK_PRICE` {}.
- `signal`: for `entry` and `add`, the `SignalSnapshot` to send as `PlaceOrderRequest.signal` with `source: 'signal'`
  (`kind`, `barTs` the bar whose close gave it, `close`, `entryLevel`, `exitLevel`).
- `plan` (`CampaignFollowPlan`), for `entry` and `add`: an isolated market buy at about the mark (`entryPx`), its stop
  `stopPx` at the exit line `nextExit` (what the next daily close is measured against, and where the channel
  trailing exit keeps the stop), `trailing` `{ kind: 'channel', bars: exitChannel }` and `takeProfits` `[]` (the rule
  exits on the channel only). Sized so that a fill at `entryPx` stopped at `stopPx` loses `riskTarget` = equity x
  `riskPct`: `contracts` in whole lots rounded down, at least the minimum order (`riskAmount` is what they risk),
  `coin`, `notional`, `margin` = notional / leverage. `leverage` for an entry: the highest whole number up to the
  campaign's leverage (10), `RISK_MAX_LEVERAGE` and the instrument's maximum that keeps the estimated isolated
  liquidation price (`isolatedLongLiquidationPrice` with `campaignMaintenanceRate`: the first tier's maintenance rate
  plus the taker fee, `maintenanceRate`) at or below `stopPx` x (1 - 0.01); `liqPx` is that estimate. An add posts at
  the position's own leverage setting and `after` estimates the position after it (contracts, average, margin and
  liquidation price of an isolated position). Linear contracts only. Without equity the size fields are null.
- `warnings` (codes and their `params`): `STOP_NOT_BELOW_ENTRY` { stopPx, entryPx } (no size), `STOP_TOO_WIDE` /
  `STOP_TOO_NARROW` { stopDistancePct, limit } (more than 20% / less than 2%), `BELOW_MIN_ORDER` { sized, minSz,
  riskAmount }, `OVER_ORDER_NOTIONAL` { notional, limit }, `OVER_POSITION_NOTIONAL` { projected, limit },
  `OVER_TOTAL_NOTIONAL` { projected, limit } (the risk limits, counted on the positions held now: the risk engine would
  refuse the order), `SIGNAL_STALE` { barTs, closedAt, ageMs } (the signal's bar closed more than one bar ago),
  `PRICE_FAR_ABOVE_SIGNAL` { markPx, close, risePct, limit } (more than 5% above the signal's close),
  `EQUITY_UNKNOWN` {}, `LINEAR_ONLY` {}, `LEVERAGE_REDUCED` { leverage, maxLeverage }, `LIQUIDATION_NEAR_STOP` { liqPx,
  stopPx } (an add), `NOT_TRACKED` {} (an order on it is refused with `UNKNOWN_INSTRUMENT` until it is in
  `INSTRUMENTS`), `CAMPAIGN_ACCOUNT` {}, `KILL_SWITCH` {}.
- The response: `{ generatedAt, params, thresholds, riskPct, equity, equitySource, campaign, rows }`. `thresholds`:
  `{ nearPct: '0.03', stopWidePct: '0.2', stopNarrowPct: '0.02', farAbovePct: '0.05', liqBufferPct: '0.01' }`.
  `equitySource` is `request`, `account` or null. `campaign`: `{ enabled, status, ownAccount }`; `ownAccount` is true
  while the campaign service runs on this API (`CAMPAIGN_ENABLED=1`, `pnpm start --campaign`): the positions on its
  coins are then the pot's, following a signal there would disturb the pot, and every plan warns `CAMPAIGN_ACCOUNT`.

Trade journal (`apps/api/src/services/journal.ts`, the bookkeeping and its rules in `journal-book.ts`, the file in
`journal-file.ts`; types in `packages/shared/src/journal.ts`). The API records every trade of the account, whoever
placed it. A trade is one position's life on one instrument, margin mode and position leg (net in net mode, long or
short in long/short mode), from flat to flat: the opening fills, the adds and partial closes, and the final close or
a liquidation. A net-mode order larger than the position closes the trade and opens the next one, the other way.

- `source`: `campaign` (client order id `pc`), `signal` or `manual` (an order Pegasus placed:
  `PlaceOrderRequest.source`, `manual` when absent; for an order whose request the journal has not seen, the client
  order id: `ps` signal, `pg` manual, which the terminal's own ids start with), `external` (anything else, and a
  position the journal found open without having seen it open: `adopted`).
- `plan`: the opening order's `slTriggerPx` (as rounded), `takeProfits`, `breakevenAfterTp1`, `trailing` and `signal`
  (`PlaceOrderRequest.signal`, which only goes with `source: 'signal'`); null for the campaign's orders and the ones
  Pegasus did not place.
- `entry`: the average price of all the opening fills, their contracts, base coin and notional, the largest size
  (`maxContracts`), the margin the exchange reported while the position held only its opening order, the leverage the
  position ran at (the opening order's notional over that margin, else the leverage set) and the margin mode.
- `exits`, one per closing order, oldest first: `{ ts, reason, leg, ordId, clOrdId, algoId, px, contracts, coin, pnl,
  fee }`. `reason`: `liquidation` and `adl` (the order's category); `campaign` (`pc`); `manual` (an order Pegasus
  placed: the ticket, a close button, a signal followed); otherwise the algo orders last listed on the position are
  matched by price, the fill's own and the mark price when it filled (OKX's `fillMarkPx`, read from
  `GET /api/v5/trade/fills`: a stop triggers on the mark): a stop-loss whose trigger the price reached (within 1%),
  `stop`, or `trailing` when Pegasus's channel trailing placed it (client id `ch`) or the plan has a channel trailing
  exit and the stop was not the opening order's or was moved since; a take-profit, `take_profit` with its `leg` (the
  one its client id names, `tp<n>`, else the plan's by the nearest trigger); the exchange's trailing stop
  (`move_order_stop`), `trailing`; no match, `trailing` when the plan has a callback trailing exit, else
  `external`. `closeReason` is the reason of the exit that took the position to flat; `unknown` when the position was
  gone and the exchange's fills did not say how (no exit is recorded then). An algo order placed and triggered between
  two reads of the list was never seen: its close is `external`.
- Figures: `realisedPnl` (the exits', from the position's running average: an add after a partial close moves it, a
  close does not), `fees` (all fills', positive when paid), `funding` (the position's accumulated `fundingFee` as the
  exchange last reported it while the position was open, read every 5 minutes; null when it reports none),
  `netPnl` = realisedPnl - fees + funding, `exitPx`, `initialStop` (the plan's stop, else the first stop-loss listed
  on the position before any of it was closed), `initialRisk` (the opening order's contracts from their average price
  to the initial stop), `rMultiple` (netPnl / initialRisk once closed), `durationMs` (once closed), `updatedAt`.
- `timeline` (`GET /api/journal/:id`), oldest first: `order_placed` (with `source` and the `plan` of an order Pegasus
  placed), `order_cancelled`, `fill` (`role` `open`, `add`, `reduce` or `close`, `px`, `contracts`, `fee`, and `pnl`
  and `reason` for a close), `stop_` / `tp_` / `trailing_` `placed`, `moved` (`fromPx` to `px`), `triggered` and
  `cancelled` (code `POSITION_CLOSED` when the position was closed by then), `liquidation`, `adopted`
  (`POSITION_ADOPTED`) and `reconciled` (`POSITION_GONE`, `SIZE_CORRECTED`). The price of an exchange trailing stop
  follows the market and is not logged as a move. `fills` lists every fill with its `role` and the size after it.
- The file `JOURNAL_FILE` (default `data/journal.json` under the repository root unless the path is absolute; the
  launcher gives every account its own, see "Paper trading") holds it whichever store the API uses: JSON with a schema
  version (`version: 1`), written whole after every change through a temporary file and a rename, read at start. The
  2,000 newest closed trades are kept (all open ones). A file that cannot be read or is not valid is never written
  over: the journal is `blocked` (`JOURNAL_UNREADABLE`, naming the file), records nothing, and a copy is kept as
  `<file>.corrupt`.
- Start. While `starting` (`JOURNAL_STARTING`) what the account reports is held back; the exchange's fills since the
  newest one the file recorded (less 5 minutes) are read (`GET /api/v5/trade/fills`, the last three days on OKX, the
  paper exchange's newest 100) and applied in the order they happened, with their orders, so a trade closed while the
  API was not running (a stop the paper exchange's replay triggered) is closed too; then the journal is `ready`. A
  failed read is tried again every 15 s. A new file reads no history (the exchange's fills before it cannot say where
  a position started): the positions open then are adopted. `disabled` (`JOURNAL_DISABLED`): no account (no API key).
- Every minute the open trades are compared with the account's positions, a leg only once neither has changed for
  10 s; a difference is first looked for in the exchange's fills (a push can be lost), and one that remains is settled
  from the position: closed `unknown` (`POSITION_GONE`), the exchange's size (`SIZE_CORRECTED`), or adopted (its
  `source` from the client order id of the newest fill that opened its leg).
- `JournalPage`: `trades` newest first (highest `seq` first), at most `limit`, older than the trade `before`; `next`
  is the `before` of the next page, null at the end; `total` counts the trades that match the filter. A trade's `id`
  is `<seq>-<instId>`.

Error codes returned by the API:

| code | meaning |
| --- | --- |
| `UNAUTHORIZED` | missing/invalid token |
| `FORBIDDEN_HOST` | the `Host` header does not name this machine (403) |
| `FORBIDDEN_ORIGIN` | the `Origin` header is not one of `WEB_ORIGINS` (403) |
| `VALIDATION` | request body failed schema validation (`details.issues`); or an attached stop-loss was refused: on a closing order, on a net-mode order against the open net position, or on the wrong side of the order price or the mark price (`details`: `slTriggerPx`, `refPrice`, `markPx`); take-profits or a trailing exit on such an order; a `clOrdId` whose `ps` prefix does not fit the order's `source`; an exit route without an open position |
| `UNKNOWN_INSTRUMENT` | instId not tracked |
| `SIZING` | size/price could not be normalised (`details.code` = `SizingError.code`) |
| `RISK_REJECTED` | risk engine rejected (`details` = `RiskCheckResult`). While the kill switch is on only orders that reduce exposure (reduce-only in net mode, the closing direction of a leg in long/short mode) are accepted, and the exits of an open position. The exit rules add `details.code` `TP_WRONG_SIDE`, `CALLBACK_RATIO` and `ACTIVE_PX_WRONG_SIDE` (see "Exit orders") |
| `EXCHANGE` | OKX returned an error (`details.okxCode`, `details.okxMsg`) |
| `EXCHANGE_UNREACHABLE` | OKX could not be reached (502) or did not answer in time (504, `details.timedOut` = true); after a timeout the request may or may not have been processed |
| `NOT_CONNECTED` | no API key configured, the account config (position mode) not loaded yet, or, for `POST /api/orders` only, the private stream not ready (503) |
| `READ_ONLY_KEY` | the API key has no trade permission; nothing was sent to the exchange (403) |
| `DAILY_LOSS_ACTIVE` | the kill switch was not released because the daily loss limit is still breached; repeat with `rebase: true` to release and restart the baseline (409, `details`: `dailyPnl`, `limit`, `equity`) |
| `NO_PRICE` | no reference price for the instrument yet, or its market data is stale (503); also an order with an attached stop-loss, or a move of a mark-triggered stop, while there is no live mark price |
| `ALGO_NOT_FOUND` | `POST /api/algo-orders/amend`: no resting algo order with that `algoId` and `instId` in a fresh read of the exchange (404) |
| `EXITS_UNAVAILABLE` | take-profits, the cost-price stop, trailing exits and the routes of "Exit orders" outside paper trading and the local mock; nothing was sent (403) |
| `TP_LEG_TOO_SMALL` | a take-profit leg comes to less than the instrument's `minSz` (400, `details`: `{ leg, sz, minSz, orderSz }` or `{ leg, sz, minSz, size }`) |
| `TP_TRIGGERS_NOT_DISTINCT` | two take-profit legs have the same trigger once rounded to the tick (400, `details.triggers`) |
| `BREAKEVEN_NEEDS_SPLIT_TP` | `breakevenAfterTp1` without `slTriggerPx` or with fewer than two take-profit legs (400) |
| `TP_EXCEEDS_POSITION` | `POST /api/positions/take-profits`: with the take-profits already resting the legs would close more than the position (400, `details`: `{ existing, requested, size }`) |
| `TRAILING_EXCEEDS_POSITION` | `POST /api/positions/trailing-stop`: with the trailing stops already resting it would close more than the position (400, `details`: `{ existing, requested, size }`) |
| `CAMPAIGN_POSITION` | an exit route or channel trailing for a position of the campaign, whose exits are the rule's (409) |
| `TRAILING_STATE_UNREADABLE` | `POST /api/positions/channel-trailing` while `TRAILING_STATE_FILE` cannot be read or is not valid (503) |
| `NO_BOOK` | opening market order refused because the order book is not synced or is stale, so slippage cannot be estimated (503) |
| `NO_DATA` | `/api/ticker` or `/api/book` has nothing yet for the instrument, or the book is stale (503) |
| `LEVERAGE_UNAVAILABLE` | the leverage lookup failed or returned nothing; an opening order is refused rather than checked against an unknown leverage (503) |
| `CAMPAIGN_…` | the campaign's order operations and the execution errors of its ledger; no route returns them, they are in `GET /api/campaign` `errors` (see "Campaign") |
| `ORDER_STATUS_UNKNOWN` | the exchange did not acknowledge the order (no answer, or OKX's own timeout codes `50004` / `51149`) and it could not be found by `clOrdId`, or a retry under an already used `clOrdId` could not be looked up and was not sent; the order may have filled or still be live, check positions, fills and open orders before retrying (504) |
| `NOT_FOUND` | unknown route (404) |
| `TRADE_NOT_FOUND` | `GET /api/journal/:id`: the journal has no trade with that id (404, `details.id`) |
| `INTERNAL` | anything else (500) |

## WebSocket `/ws?token=<API_TOKEN>`

Protocol types are in `packages/shared/src/ws-protocol.ts`. The upgrade request passes the same `Host` and
`Origin` checks as every other request (a browser always sends `Origin` on a WebSocket handshake).

1. On connect the server sends `hello` with `demo`, `paper` (see "Paper trading"), instruments, account config, risk config/state,
   connection status, balance, positions, open orders and the algo orders (`algoOrders`, null until they were
   read from the exchange once). `hello.account` is null while the account config
   is not loaded; `{ type: 'account', data: AccountConfig }` follows when it loads and whenever it changes.
2. The client sends `{ type: 'subscribe', instId, bar? }` to start receiving `ticker`,
   `book` (top 50, throttled to ~10/s), `trades`, `candle`, `markPrice`, `fundingRate`
   for that instrument. `setBar` switches the candle interval; `unsubscribe` stops market data.
3. Private pushes (`order`, `fill`, `positions`, `algoOrders`, `balance`, `account`, `risk`, `connection`) are
   sent to every authenticated client regardless of subscriptions. `algoOrders` carries the whole list after
   every read of the exchange (see "Stops" above).
4. `connection` is sent every 5 s and at once when a socket state, the set of stale streams or the account
   status changes, so a client always hears from the server within 5 s. The terminal treats 20 s of silence on
   an open socket as a dead connection and reconnects, and shows a banner while the socket is down, an OKX feed
   is not connected, `staleStreams` is not empty, `account.state` is `error`, or `account.state` is `ok` and
   `okxPrivate` has not been `connected` for more than 10 s (the account is then only refreshed by the 60 s
   reconcile). The `error` banner says "not updating since HH:MM:SS" only when `account.lastSyncAt` is older than
   90 s; while it is recent it says which half is missing (the live stream or the last refresh). It labels account
   data "as of HH:MM:SS" once `account.lastSyncAt` is older than 90 s and disables order entry, Close and Cancel
   while `hello.account` is null or `canTrade` is false. Empty positions, orders and balance read as a flat account
   only when the last `hello` or a later `connection` carried a non-null `account.lastSyncAt`.
5. While the campaign is enabled: `{ type: 'campaign', data: CampaignView }` (see "Campaign") right after `hello` and
   after every change of its ledger or of the summary of its replay (`replay`: its `status`, `computedAt` or
   `mismatches`), to every authenticated client. It is a member of `ServerMessage` (`CampaignMessage`, exported next to
   it); `ServerPush`, everything the server sends, is an alias of `ServerMessage`. A client that does not know the type
   ignores it.
6. The client may send `{ type: 'ping' }` (the terminal does every 15 s); the server answers `pong`.
   Liveness is checked with WebSocket protocol pings: the server pings every client every 15 s and
   terminates one that did not answer the previous ping. Browsers answer those on their own, also for a hidden tab.
7. `{ type: 'journal', data: JournalUpdate }` after every change of the trade journal (see "Trade journal"), to every
   authenticated client: `{ status, reason, trades, serverTime }`, `trades` the summaries of the trades that changed
   (newest first; empty when only the status changed). Nothing is sent on connect: a page reads `GET /api/journal`
   and keeps each trade's newest version by `updatedAt`. It is a member of `ServerMessage` (`JournalMessage`).
