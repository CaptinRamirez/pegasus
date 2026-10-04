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
| GET | `/api/health` | – | `{ ok: true, version, demo, connection: { okxPublic, okxPrivate, okxBusiness }, serverTime }` (no auth, so only the three socket states; the full `ConnectionStatus` is sent over `/ws`). `version` is the short git commit the launcher started the stack from (`PEGASUS_VERSION`), `"unknown"` when the API was started another way |
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
| POST | `/api/orders/cancel-all` | `CancelAllRequest` | `{ canceled: number }` |
| GET | `/api/candles` | `CandlesQuery` | `Candle[]` ascending by `ts`; `6H`, `12H`, `1D` and `1W` are UTC-aligned (OKX `6Hutc` … `1Wutc`), also on the `candle` WS message |
| GET | `/api/book` | `?instId` | `OrderBook` (top 50 each side) |
| GET | `/api/ticker` | `?instId` | `Ticker` |
| GET | `/api/risk` | – | `{ config: RiskConfig, state: RiskState }` |
| GET | `/api/signals` | `?instId&equity&riskPct&maxNotionalPct` (all optional) | `SignalsResponse`: `{ generatedAt, equity, sizingParams, reports: SignalReportRow[] }` — daily trend-framework signals; see below and `packages/shared/src/signals.ts` |
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

- Signals are computed from confirmed **UTC** daily candles (OKX `1Dutc`; the forming bar is excluded). `indicators.asOf` is the
  open time of the last confirmed bar, always a UTC midnight; that bar closed at `asOf + 86 400 000`.
- `sizingParams` (`{ riskPct, maxNotionalPct, atrStopMultiple }`) echoes the sizing actually used. Without `riskPct` the
  server uses 0.0075; the terminal always sends the owner's choice (0.005 by default).
- `sizing` is `{ long: SizingPlan, short: SizingPlan } | null` (null without equity). Each plan carries its own
  `multiplier` and `adjustments` (for example `"short x0.5"`, `"crisis x0.5"`,
  `"crowded x0.75 (funding 0.09%/8h, OI +24% in 10d)"`); the multiplier is applied after the notional cap and before
  the minimum-order-size check. `signals.reasons` has one line per applied adjustment.
- A plan's `rawNotional` is the notional before the cap, `targetNotional` the one aimed at after the cap and the
  multiplier, and `notional` the notional of `contracts`, the order actually proposed after rounding down to whole
  lots (`"0.00"` when `contracts` is `"0"`). `coin` and `riskQuote` describe the same rounded order.
- `indicators.crisisDaysAgo` is the number of closes since the most recent crisis day inside the hold window (0 = the
  last bar, null = none); `indicators.nextExitHigh` / `nextExitLow` are the exit channel including the last bar, the
  level the next close is tested against.
- `dataFetchedAt` is when the candles and funding behind a report were fetched from the exchange. Exchange data is
  cached for 5 minutes, never across a UTC midnight.
- `structure.book` is the visible depth/imbalance over 20 levels. `structure.openInterest` is the instrument's own open
  interest. With `source: "history"` the level (`current`, in USD) is today's still-forming row of the daily history
  (UTC days, cached for an hour), while `change1d`, `change10d` and `percentile30d` are measured in coin on completed
  days only: the last completed UTC day against the day before it and against ten days before it. `points` is the
  number of completed days. With `source: "live"` only the current level is known and the changes are `""`.
- Open interest never holds a report back. A report waits at most 3 s for an instrument's history; after that it is
  sent with the changes of the rows fetched earlier the same UTC day when there are any, otherwise with the live
  level, while the call finishes in the background and fills the cache for the next request. Until that call has
  settled, and for 60 s after a failed one, no report waits for that instrument's history again. The history calls
  go out one at a time, 400 ms apart, so right after a start or a UTC midnight the last instruments of a full
  report can come back as `"live"` once.
- A row that could not be computed is `{ instId, error: { code, message } }` (`SignalReportError`).

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
  risk: RiskCheckResult;   // ok=false means the order would be rejected
}
```

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

Error codes returned by the API:

| code | meaning |
| --- | --- |
| `UNAUTHORIZED` | missing/invalid token |
| `FORBIDDEN_HOST` | the `Host` header does not name this machine (403) |
| `FORBIDDEN_ORIGIN` | the `Origin` header is not one of `WEB_ORIGINS` (403) |
| `VALIDATION` | request body failed schema validation (`details.issues`) |
| `UNKNOWN_INSTRUMENT` | instId not tracked |
| `SIZING` | size/price could not be normalised (`details.code` = `SizingError.code`) |
| `RISK_REJECTED` | risk engine rejected (`details` = `RiskCheckResult`). While the kill switch is on only orders that reduce exposure (reduce-only in net mode, the closing direction of a leg in long/short mode) are accepted |
| `EXCHANGE` | OKX returned an error (`details.okxCode`, `details.okxMsg`) |
| `EXCHANGE_UNREACHABLE` | OKX could not be reached (502) or did not answer in time (504, `details.timedOut` = true); after a timeout the request may or may not have been processed |
| `NOT_CONNECTED` | no API key configured, the account config (position mode) not loaded yet, or, for `POST /api/orders` only, the private stream not ready (503) |
| `READ_ONLY_KEY` | the API key has no trade permission; nothing was sent to the exchange (403) |
| `DAILY_LOSS_ACTIVE` | the kill switch was not released because the daily loss limit is still breached; repeat with `rebase: true` to release and restart the baseline (409, `details`: `dailyPnl`, `limit`, `equity`) |
| `NO_PRICE` | no reference price for the instrument yet, or its market data is stale (503) |
| `NO_BOOK` | opening market order refused because the order book is not synced or is stale, so slippage cannot be estimated (503) |
| `NO_DATA` | `/api/ticker` or `/api/book` has nothing yet for the instrument, or the book is stale (503) |
| `LEVERAGE_UNAVAILABLE` | the leverage lookup failed or returned nothing; an opening order is refused rather than checked against an unknown leverage (503) |
| `ORDER_STATUS_UNKNOWN` | the exchange did not acknowledge the order (no answer, or OKX's own timeout codes `50004` / `51149`) and it could not be found by `clOrdId`, or a retry under an already used `clOrdId` could not be looked up and was not sent; the order may have filled or still be live, check positions, fills and open orders before retrying (504) |
| `NOT_FOUND` | unknown route (404) |
| `INTERNAL` | anything else (500) |

## WebSocket `/ws?token=<API_TOKEN>`

Protocol types are in `packages/shared/src/ws-protocol.ts`. The upgrade request passes the same `Host` and
`Origin` checks as every other request (a browser always sends `Origin` on a WebSocket handshake).

1. On connect the server sends `hello` with instruments, account config, risk config/state,
   connection status, balance, positions and open orders. `hello.account` is null while the account config
   is not loaded; `{ type: 'account', data: AccountConfig }` follows when it loads and whenever it changes.
2. The client sends `{ type: 'subscribe', instId, bar? }` to start receiving `ticker`,
   `book` (top 50, throttled to ~10/s), `trades`, `candle`, `markPrice`, `fundingRate`
   for that instrument. `setBar` switches the candle interval; `unsubscribe` stops market data.
3. Private pushes (`order`, `fill`, `positions`, `balance`, `account`, `risk`, `connection`) are sent to
   every authenticated client regardless of subscriptions.
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
