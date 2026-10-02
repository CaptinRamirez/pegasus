# Pegasus API contract (web ⇄ api)

All routes live under `/api`. Every route except `GET /api/health` requires
`Authorization: Bearer <API_TOKEN>`. Responses use the envelope from
`@pegasus/shared` (`ApiResponse<T>`):

```json
{ "ok": true, "data": ... }
{ "ok": false, "error": { "code": "RISK_REJECTED", "message": "...", "details": { } } }
```

Numeric values are decimal strings. Timestamps are epoch milliseconds.
Request bodies are validated with the zod schemas in `packages/shared/src/schemas.ts`.

| Method | Path | Body / query | Returns |
| --- | --- | --- | --- |
| GET | `/api/health` | – | `{ ok: true, demo, connection: ConnectionStatus, serverTime }` (no auth) |
| GET | `/api/instruments` | – | `Instrument[]` (tracked instruments) |
| GET | `/api/account` | – | `{ config: AccountConfig, balance: Balance \| null }` |
| GET | `/api/account/leverage` | `?instId&mgnMode` | `{ instId, mgnMode, posSide, lever }[]` |
| POST | `/api/account/leverage` | `SetLeverageRequest` | `{ instId, mgnMode, posSide, lever }[]` |
| GET | `/api/positions` | – | `Position[]` |
| POST | `/api/positions/close` | `ClosePositionRequest` | `{ instId, posSide }` |
| GET | `/api/orders/open` | – | `Order[]` |
| GET | `/api/orders/history` | `OrdersHistoryQuery` | `Order[]` newest first |
| GET | `/api/fills` | `FillsQuery` | `Fill[]` newest first |
| POST | `/api/orders/preview` | `PlaceOrderRequest` | `OrderPreview` (see below) |
| POST | `/api/orders` | `PlaceOrderRequest` | `{ order: Order, preview: OrderPreview }` |
| POST | `/api/orders/cancel` | `CancelOrderRequest` | `{ ordId, clOrdId }` |
| POST | `/api/orders/cancel-all` | `CancelAllRequest` | `{ canceled: number }` |
| GET | `/api/candles` | `CandlesQuery` | `Candle[]` ascending by `ts` |
| GET | `/api/book` | `?instId` | `OrderBook` (top 50 each side) |
| GET | `/api/ticker` | `?instId` | `Ticker` |
| GET | `/api/risk` | – | `{ config: RiskConfig, state: RiskState }` |
| POST | `/api/risk/kill-switch` | `KillSwitchRequest` | `RiskState` |

`OrderPreview`:

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
  estSlippagePct: string;  // market orders only, from the order book; '' otherwise
  risk: RiskCheckResult;   // ok=false means the order would be rejected
}
```

Error codes returned by the API:

| code | meaning |
| --- | --- |
| `UNAUTHORIZED` | missing/invalid token |
| `VALIDATION` | request body failed schema validation (`details.issues`) |
| `UNKNOWN_INSTRUMENT` | instId not tracked |
| `SIZING` | size/price could not be normalised (`details.code` = `SizingError.code`) |
| `RISK_REJECTED` | risk engine rejected (`details` = `RiskCheckResult`) |
| `EXCHANGE` | OKX returned an error (`details.okxCode`, `details.okxMsg`) |
| `NOT_CONNECTED` | private stream not ready |
| `INTERNAL` | anything else |

## WebSocket `/ws?token=<API_TOKEN>`

Protocol types are in `packages/shared/src/ws-protocol.ts`.

1. On connect the server sends `hello` with instruments, account config, risk config/state,
   connection status, balance, positions and open orders.
2. The client sends `{ type: 'subscribe', instId, bar? }` to start receiving `ticker`,
   `book` (top 50, throttled to ~10/s), `trades`, `candle`, `markPrice`, `fundingRate`
   for that instrument. `setBar` switches the candle interval; `unsubscribe` stops market data.
3. Private pushes (`order`, `fill`, `positions`, `balance`, `risk`, `connection`) are sent to
   every authenticated client regardless of subscriptions.
4. The client should send `{ type: 'ping' }` every 15 s; the server answers `pong`.
   The server closes sockets idle for 60 s.
