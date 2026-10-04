# Pegasus — notes for contributors and AI agents

Single-user OKX perpetual-swap manual trading terminal. pnpm monorepo, TypeScript ESM everywhere, Node 22.

## Layout
- `packages/shared` — domain types, zod schemas, web⇄api WS protocol, contract sizing (`sizing.ts`), signal and sizing-plan arithmetic and the `/api/signals` response types (`signals.ts`), decimal helpers. Both apps import from here; never duplicate these types.
- `packages/okx` — OKX v5 REST/WS client (signing, login, ping/pong, reconnect, resubscribe, order-book continuity by `seqId`/`prevSeqId`; OKX retired the book checksum and it is not verified). Pure exchange wire concerns; no domain logic.
- `packages/mock-okx` — local simulated OKX exchange used by `pnpm start --mock`, `pnpm dev:mock` and the API e2e tests (BTC and ETH swaps only).
- `packages/backtest` — backtester run from source (`pnpm backtest`): replays OKX history (daily and 12-hour candles, open interest) with Binance funding as the proxy and takes every decision from `buildSignalReport` in `packages/shared`, so a rule change is tested with the code the SIGNALS tab runs. The engine only keeps the book; its timing rules are in the header of `src/engine.ts`. Cache and output directories are git-ignored.
- `apps/api` — Fastify server: `services/market-data.ts` (public/business sockets, stale-stream watchdog), `services/account.ts` (private socket + REST reconcile), `services/risk-engine.ts`, `services/order-service.ts`, `services/signals.ts`, `services/kill-switch-sweeper.ts`, `ws/hub.ts` (fan-out to terminals), `routes/*`, `server.ts` (Host/Origin and token checks), `db/*` (Postgres store, or memory store that saves the kill switch and day baseline to `STATE_FILE`), `logger.ts` (console plus daily files in `LOG_DIR`).
- `apps/web` — React 19 + Vite terminal, including the SIGNALS tab and the status banner. Zustand store with pure reducers in `src/store/reducers.ts`.
- `scripts/start.mjs`, `scripts/launch-options.mjs`, `start.bat` — one-command launcher: builds the web app, starts the api and serves the built page on port 5174.
- `docs/api.md` — the HTTP/WS contract between web and api. Update it when routes, error codes, settings or messages change. `docs/okx-api-notes.md` is the reference for OKX wire behaviour; `docs/strategy.md` is the trading framework the SIGNALS tab implements.

## Rules
- Money math only via decimal.js / `@pegasus/shared` helpers; values cross boundaries as decimal strings. Never `parseFloat` for arithmetic.
- OKX `sz` is in contracts. Convert through `sizeToContracts` / `notionalQuote`; respect `lotSz`, `minSz`, `tickSz`.
- Risk checks are enforced server-side in `RiskEngine.check`; the UI only previews.
- Only send `posSide` in long/short position mode; only send `reduceOnly` in net mode.
- Keep strict TS clean: `noUncheckedIndexedAccess`, `exactOptionalPropertyTypes`, `verbatimModuleSyntax` (use `import type`). Build optional fields conditionally instead of assigning `undefined`.
- Bars of 6H and longer are UTC-aligned: OKX's plain `6H`/`12H`/`1D`/`1W` bars open on UTC+8 boundaries, so they are mapped to its `…utc` bars at the wire boundary. Signals are computed on confirmed daily bars only, at the cuts listed in `SIGNAL_PHASES` (default both: 00:00 UTC from OKX `1Dutc` bars and 12:00 UTC built from `12Hutc` bars), each sized at 1/n of a unit.
- The API denies by default: `server.ts` decides authentication on the matched route (only `/api/health` and `/ws` are exempt from the bearer token) and refuses any request whose Host is not local or whose Origin is not listed in `WEB_ORIGINS`.

## Commands
- `pnpm typecheck` / `pnpm test` / `pnpm build` at the root run every package.
- `pnpm start` (or double-clicking `start.bat` on Windows) builds the web app and starts the whole stack from one snapshot; `--mock` runs it against the local mock exchange without touching `.env`, `--dev` uses the Vite dev server, `--no-open` does not open the browser.
- `pnpm --filter @pegasus/api test` runs unit tests plus the e2e suites against the in-process mock exchange (`test/e2e.test.ts`, `test/e2e-long-short.test.ts`, `test/e2e-read-only.test.ts`).
- `TEST_DATABASE_URL=postgres://... pnpm --filter @pegasus/api exec vitest run test/pg-store.test.ts` exercises the Postgres store (skipped without the variable).
- `pnpm backtest` runs the documented framework on BTC and ETH history (about two minutes; needs the network on the first run, then extends its cache); `pnpm backtest --help` lists the flags, `pnpm -s backtest --json` prints the summary object.
- `pnpm dev:mock`, `pnpm dev:api`, `pnpm dev:web` run one service each for debugging (README shows the variables that point a stand-alone api at the mock; all four `OKX_*_URL` overrides must be set together). The page must be opened at an origin listed in `WEB_ORIGINS` (default `http://localhost:5174` and `http://127.0.0.1:5174`).
