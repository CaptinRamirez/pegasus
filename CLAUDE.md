# Pegasus — notes for contributors and AI agents

Single-user OKX perpetual-swap manual trading terminal. pnpm monorepo, TypeScript ESM everywhere, Node 22.

## Layout
- `packages/shared` — domain types, zod schemas, web⇄api WS protocol, contract sizing (`sizing.ts`), decimal helpers. Both apps import from here; never duplicate these types.
- `packages/okx` — OKX v5 REST/WS client (signing, login, ping/pong, reconnect, resubscribe, book checksum). Pure exchange wire concerns; no domain logic.
- `packages/mock-okx` — local simulated OKX exchange used by `pnpm dev:mock` and the API e2e tests.
- `apps/api` — Fastify server: `services/market-data.ts` (public/business sockets), `services/account.ts` (private socket + REST reconcile), `services/risk-engine.ts`, `services/order-service.ts`, `ws/hub.ts` (fan-out to terminals), `routes/*`, `db/*` (memory or Postgres store).
- `apps/web` — React 19 + Vite terminal. Zustand store with pure reducers in `src/store/reducers.ts`.
- `docs/api.md` — the HTTP/WS contract between web and api. Update it when routes or messages change.

## Rules
- Money math only via decimal.js / `@pegasus/shared` helpers; values cross boundaries as decimal strings. Never `parseFloat` for arithmetic.
- OKX `sz` is in contracts. Convert through `sizeToContracts` / `notionalQuote`; respect `lotSz`, `minSz`, `tickSz`.
- Risk checks are enforced server-side in `RiskEngine.check`; the UI only previews.
- Only send `posSide` in long/short position mode; only send `reduceOnly` in net mode.
- Keep strict TS clean: `noUncheckedIndexedAccess`, `exactOptionalPropertyTypes`, `verbatimModuleSyntax` (use `import type`). Build optional fields conditionally instead of assigning `undefined`.

## Commands
- `pnpm typecheck` / `pnpm test` / `pnpm build` at the root run every package.
- `pnpm --filter @pegasus/api test` runs unit tests plus the e2e suite against the in-process mock exchange (`test/e2e.test.ts`).
- `TEST_DATABASE_URL=postgres://... pnpm --filter @pegasus/api exec vitest run test/pg-store.test.ts` exercises the Postgres store (skipped without the variable).
- `pnpm dev:mock`, `pnpm dev:api`, `pnpm dev:web` for local development (see README for the env overrides that point the api at the mock).
