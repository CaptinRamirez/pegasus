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
| POST | `/api/algo-orders/cancel` | `CancelAlgoOrderRequest` (`{ instId, algoId }`) | `{ algoId, instId }` |
| GET | `/api/candles` | `CandlesQuery` | `Candle[]` ascending by `ts`; `6H`, `12H`, `1D` and `1W` are UTC-aligned (OKX `6Hutc` … `1Wutc`), also on the `candle` WS message |
| GET | `/api/book` | `?instId` | `OrderBook` (top 50 each side) |
| GET | `/api/ticker` | `?instId` | `Ticker` |
| GET | `/api/risk` | – | `{ config: RiskConfig, state: RiskState }` |
| GET | `/api/signals` | `?instId&phase&equity&riskPct&maxNotionalPct&lang` (all optional; `phase` is `0` or `12`, `lang` is `en` or `zh`) | `SignalsResponse`: `{ generatedAt, equity, phases, sizingParams, reports: SignalReportRow[] }` — daily trend-framework signals, one row per instrument and daily cut; see below and `packages/shared/src/signals.ts` |
| POST | `/api/risk/kill-switch` | `KillSwitchRequest` (`{ enabled, reason?, rebase? }`) | `RiskState` (`cancelSweep` already reflects the new switch position); `409 DAILY_LOSS_ACTIVE` for a release without `rebase` while the daily loss limit is breached |

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
attached stops and the TP/SL orders placed on OKX itself; trigger, trailing, iceberg and TWAP orders are not read.

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
- Not offered: changing the size of a stop (cancel it and place a new one for the size wanted), take-profit
  orders, and moving the stop of an entry that is still resting (cancel the entry and place it again).
- `stopCoverage(position, algoOrders)` in `@pegasus/shared` sums the stops of a position (same instrument, margin
  mode and leg, on the closing side; a `closeFraction` stop counts that fraction of the position) and reports
  `none`, `partial`, `full` or `over`. The positions table shows it in its Stop column: the trigger prices, and a
  tag unless the stops close exactly the position (`over`: a lot was closed and its stop was left resting).

Exits. An order that can only reduce exposure (reduce-only in net mode, the closing direction of a leg in long/short
mode) skips the leverage, slippage and exposure rules, so it is neither refused with `LEVERAGE_UNAVAILABLE` nor with
`NO_BOOK`: its preview carries `lever: ''` and, while the book is not synced, `estSlippagePct: ''` with `refPrice`
taken from the ticker or mark price. It still needs a price (`NO_PRICE`) and still passes the price band.

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
cross position; `""` when OKX reports neither.

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
  not simulated (liquidation, queue position, take-profit) are described in the README ("纸面交易") and in the
  headers of `packages/paper/src/replay.ts`, `funding.ts` and `live-market.ts`.
- The launcher gives the API its own `STATE_FILE` (`data/pegasus-state.paper.json`) and no `DATABASE_URL`, so the
  kill switch, the day baseline and the journal of the paper account are not mixed with a real account's.
- Order and fill times of events that were replayed are the times they happened at (the end of their candle),
  not the time the program was started again.

Error codes returned by the API:

| code | meaning |
| --- | --- |
| `UNAUTHORIZED` | missing/invalid token |
| `FORBIDDEN_HOST` | the `Host` header does not name this machine (403) |
| `FORBIDDEN_ORIGIN` | the `Origin` header is not one of `WEB_ORIGINS` (403) |
| `VALIDATION` | request body failed schema validation (`details.issues`); or an attached stop-loss was refused: on a closing order, on a net-mode order against the open net position, or on the wrong side of the order price or the mark price (`details`: `slTriggerPx`, `refPrice`, `markPx`) |
| `UNKNOWN_INSTRUMENT` | instId not tracked |
| `SIZING` | size/price could not be normalised (`details.code` = `SizingError.code`) |
| `RISK_REJECTED` | risk engine rejected (`details` = `RiskCheckResult`). While the kill switch is on only orders that reduce exposure (reduce-only in net mode, the closing direction of a leg in long/short mode) are accepted |
| `EXCHANGE` | OKX returned an error (`details.okxCode`, `details.okxMsg`) |
| `EXCHANGE_UNREACHABLE` | OKX could not be reached (502) or did not answer in time (504, `details.timedOut` = true); after a timeout the request may or may not have been processed |
| `NOT_CONNECTED` | no API key configured, the account config (position mode) not loaded yet, or, for `POST /api/orders` only, the private stream not ready (503) |
| `READ_ONLY_KEY` | the API key has no trade permission; nothing was sent to the exchange (403) |
| `DAILY_LOSS_ACTIVE` | the kill switch was not released because the daily loss limit is still breached; repeat with `rebase: true` to release and restart the baseline (409, `details`: `dailyPnl`, `limit`, `equity`) |
| `NO_PRICE` | no reference price for the instrument yet, or its market data is stale (503); also an order with an attached stop-loss, or a move of a mark-triggered stop, while there is no live mark price |
| `ALGO_NOT_FOUND` | `POST /api/algo-orders/amend`: no resting algo order with that `algoId` and `instId` in a fresh read of the exchange (404) |
| `NO_BOOK` | opening market order refused because the order book is not synced or is stale, so slippage cannot be estimated (503) |
| `NO_DATA` | `/api/ticker` or `/api/book` has nothing yet for the instrument, or the book is stale (503) |
| `LEVERAGE_UNAVAILABLE` | the leverage lookup failed or returned nothing; an opening order is refused rather than checked against an unknown leverage (503) |
| `ORDER_STATUS_UNKNOWN` | the exchange did not acknowledge the order (no answer, or OKX's own timeout codes `50004` / `51149`) and it could not be found by `clOrdId`, or a retry under an already used `clOrdId` could not be looked up and was not sent; the order may have filled or still be live, check positions, fills and open orders before retrying (504) |
| `NOT_FOUND` | unknown route (404) |
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
5. The client may send `{ type: 'ping' }` (the terminal does every 15 s); the server answers `pong`.
   Liveness is checked with WebSocket protocol pings: the server pings every client every 15 s and
   terminates one that did not answer the previous ping. Browsers answer those on their own, also for a hidden tab.
