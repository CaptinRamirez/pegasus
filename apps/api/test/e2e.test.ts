/**
 * End-to-end: the API server wired to the local mock OKX exchange.
 * Exercises boot, market data, previews, order placement/fill/cancel,
 * risk rejection, the kill switch and the terminal WebSocket.
 */
import { once } from 'node:events';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { pino } from 'pino';
import WebSocket from 'ws';
import { startMockOkx, type MockOkxHandle } from '@pegasus/mock-okx';
import { OkxTransportError, type OkxRestClient } from '@pegasus/okx';
import { D, decodeServerMessage, type AlgoOrderList, type ApiResponse, type CampaignReplayView, type CampaignView, type Order, type Position, type ServerMessage } from '@pegasus/shared';
import type { FastifyInstance, InjectOptions } from 'fastify';
import { loadConfig, type AppConfig } from '../src/config.js';
import { MemoryStore } from '../src/db/store.js';
import type { Deps } from '../src/deps.js';
import { createOkxClients, syncClock } from '../src/okx/clients.js';
import { buildServer } from '../src/server.js';
import { AccountService } from '../src/services/account.js';
import { KillSwitchSweeper } from '../src/services/kill-switch-sweeper.js';
import { MarketDataService } from '../src/services/market-data.js';
import { OrderService } from '../src/services/order-service.js';
import { RiskEngine } from '../src/services/risk-engine.js';
import { SignalsService } from '../src/services/signals.js';
import { Hub } from '../src/ws/hub.js';

const TOKEN = 'test-token';
const CREDS = { apiKey: 'k', apiSecret: 's', passphrase: 'p' };
const log = pino({ level: process.env['E2E_LOG'] ?? 'silent' });

let mock: MockOkxHandle;
let app: FastifyInstance;
let deps: Deps;
let baseUrl: string;

async function api<T>(method: 'GET' | 'POST', path: string, body?: unknown): Promise<{ status: number; body: ApiResponse<T> }> {
  const opts: InjectOptions = { method, url: path, headers: { authorization: `Bearer ${TOKEN}`, 'content-type': 'application/json' } };
  if (body !== undefined) opts.payload = JSON.stringify(body);
  const res = await app.inject(opts);
  return { status: res.statusCode, body: res.json() as ApiResponse<T> };
}

function data<T>(r: { status: number; body: ApiResponse<T> }): T {
  if (!r.body.ok) throw new Error(`api error ${r.status}: ${JSON.stringify(r.body.error)}`);
  return r.body.data;
}

async function waitFor<T>(fn: () => T | undefined | null | false, timeoutMs = 5000, label = 'condition'): Promise<T> {
  const start = Date.now();
  for (;;) {
    const v = fn();
    if (v) return v;
    if (Date.now() - start > timeoutMs) throw new Error(`timeout waiting for ${label}`);
    await new Promise((r) => setTimeout(r, 25));
  }
}

beforeAll(async () => {
  mock = await startMockOkx({ port: 0, credentials: CREDS, seed: 42, tickIntervalMs: 50, initialPrices: { 'BTC-USDT-SWAP': '50000', 'ETH-USDT-SWAP': '3000' }, initialBalanceUsdt: '100000' });
  const config: AppConfig = loadConfig({
    OKX_API_KEY: CREDS.apiKey,
    OKX_API_SECRET: CREDS.apiSecret,
    OKX_API_PASSPHRASE: CREDS.passphrase,
    OKX_DEMO: '1',
    OKX_REST_URL: mock.restUrl,
    OKX_WS_PUBLIC_URL: mock.wsPublicUrl,
    OKX_WS_PRIVATE_URL: mock.wsPrivateUrl,
    OKX_WS_BUSINESS_URL: mock.wsBusinessUrl,
    API_TOKEN: TOKEN,
    PEGASUS_VERSION: 'e2e1234',
    INSTRUMENTS: 'BTC-USDT-SWAP,ETH-USDT-SWAP',
    RISK_MAX_ORDER_NOTIONAL: '20000',
    RISK_MAX_POSITION_NOTIONAL_PER_INSTRUMENT: '30000',
    RISK_MAX_TOTAL_POSITION_NOTIONAL: '50000',
    RISK_MAX_LEVERAGE: '20',
    RISK_DAILY_LOSS_LIMIT: '1000',
    RISK_MAX_OPEN_ORDERS: '5',
    RISK_PRICE_BAND_PCT: '0.05',
    RISK_MAX_SLIPPAGE_PCT: '0.01',
  });
  const store = new MemoryStore();
  const clients = createOkxClients(config, log);
  await syncClock(clients, log);
  const market = new MarketDataService(clients, log, { bookDepth: 50, bookThrottleMs: 20 });
  await market.loadInstruments(config.instruments);
  const account = new AccountService(clients, store, log);
  const risk = new RiskEngine(config.risk, store, log);
  await risk.init();
  // REST, like the real server: OKX_WS_TRADING=1 is refused at start-up.
  const orders = new OrderService(clients, market, account, risk, store, log, { defaultTdMode: config.defaultTdMode, wsTrading: config.okx.wsTrading });
  const signals = new SignalsService(clients, market, account, log);
  const hub = new Hub(config, market, account, risk, log);
  deps = { config, log, clients, store, market, account, risk, orders, signals, hub };
  account.on('balance', (b) => risk.updateEquity(b.totalEq));
  account.on('positions', () => risk.updateExposure(account.openOrders.size, account.totalPositionNotional(), account.positionList(), (id) => deps.market.specOf(id)));
  account.on('order', () => risk.updateExposure(account.openOrders.size, account.totalPositionNotional(), account.positionList(), (id) => deps.market.specOf(id)));
  new KillSwitchSweeper(risk, account, orders, log).start();
  hub.wire();
  app = await buildServer(deps);
  await market.start();
  await account.start();
  await app.listen({ host: '127.0.0.1', port: 0 });
  const addr = app.server.address();
  baseUrl = typeof addr === 'object' && addr ? `127.0.0.1:${addr.port}` : '';
  await waitFor(() => market.book('BTC-USDT-SWAP') && market.ticker('BTC-USDT-SWAP') && account.ready && account.balance, 10_000, 'market data + private stream');
}, 30_000);

afterAll(async () => {
  await deps.hub.close();
  await app.close();
  await deps.market.stop();
  await deps.account.stop();
  await mock.close();
});

describe('api e2e against mock OKX', () => {
  it('rejects requests without the token', async () => {
    const res = await app.inject({ method: 'GET', url: '/api/instruments' });
    expect(res.statusCode).toBe(401);
    const health = await app.inject({ method: 'GET', url: '/api/health' });
    expect(health.statusCode).toBe(200);
    // the commit the stack was started from, as the launcher passed it
    expect(health.json()).toMatchObject({ ok: true, version: 'e2e1234' });
  });

  it('serves instruments, ticker, book and candles', async () => {
    const instruments = data(await api<Array<{ instId: string; ctVal: string }>>('GET', '/api/instruments'));
    expect(instruments.map((i) => i.instId).sort()).toEqual(['BTC-USDT-SWAP', 'ETH-USDT-SWAP']);
    const book = data(await api<{ bids: string[][]; asks: string[][] }>('GET', '/api/book?instId=BTC-USDT-SWAP'));
    expect(book.bids.length).toBeGreaterThan(5);
    expect(D(book.asks[0]![0]!).gt(book.bids[0]![0]!)).toBe(true);
    const candles = data(await api<Array<{ ts: number; close: string }>>('GET', '/api/candles?instId=BTC-USDT-SWAP&bar=1m&limit=50'));
    expect(candles.length).toBeGreaterThan(10);
    expect(candles[0]!.ts).toBeLessThan(candles[candles.length - 1]!.ts);
    const ticker = data(await api<{ last: string }>('GET', '/api/ticker?instId=BTC-USDT-SWAP'));
    expect(D(ticker.last).gt(0)).toBe(true);
  });

  it('computes daily signal reports with indicators, regime and sizing', async () => {
    type Plan = { contracts: string; riskQuote: string; multiplier: string };
    const res = data(await api<{ equity: string | null; sizingParams: { riskPct: string; maxNotionalPct: string }; phases: number[]; reports: Array<{ instId: string; phase: number; indicators?: { asOf: number; bars: number; atr: string; entryHigh: string }; regime?: string; funding?: { avg8h: string; samples: number } | null; sizing?: { long: Plan; short: Plan } | null; signals?: { reasons: string[] }; dataFetchedAt?: number | null; error?: { code: string; message: string } }> }>('GET', '/api/signals?equity=100000'));
    // one row per instrument and daily cut, ordered by instrument, then cut
    expect(res.reports.map((r) => r.phase)).toEqual([0, 12, 0, 12]);
    expect(res.reports[0]!.instId).toBe(res.reports[1]!.instId);
    expect(res.phases).toEqual([0, 12]);
    expect(res.equity).toBe('100000');
    // each cut is sized at half a unit
    expect(res.sizingParams).toMatchObject({ riskPct: '0.00375', maxNotionalPct: '0.05' });
    for (const r of res.reports) {
      expect(r.error).toBeUndefined();
      // the daily bar opens at the cut in UTC (OKX 1Dutc, or two 12Hutc bars from noon), not on OKX's default UTC+8 day that opens at 16:00 UTC
      expect(r.indicators!.asOf % 86_400_000).toBe(r.phase * 3_600_000);
      expect(r.dataFetchedAt).toBeGreaterThan(0);
      expect(r.indicators!.bars).toBeGreaterThanOrEqual(100);
      expect(D(r.indicators!.atr).gt(0)).toBe(true);
      expect(['trend', 'neutral', 'range', 'crisis']).toContain(r.regime);
      expect(r.funding).not.toBeNull();
      expect(r.funding!.samples).toBeGreaterThanOrEqual(9); // three days of 8h settlements
      expect(D(r.funding!.avg8h).eq('0.0001')).toBe(true);
      expect(r.sizing).not.toBeNull();
      expect(D(r.sizing!.long.riskQuote).lte('375')).toBe(true); // half of 0.75% of 100k at most
      expect(D(r.sizing!.short.multiplier).lte('0.5')).toBe(true); // shorts are sized at half at most
      expect(D(r.sizing!.short.riskQuote).lte(D(r.sizing!.long.riskQuote))).toBe(true);
      expect(r.signals!.reasons.length).toBeGreaterThan(3);
      const st = (r as { structure?: { book: { imbalance: string; levels: number } | null; openInterest: { current: string; points: number; source: string; change10d: string } | null } }).structure;
      expect(st?.book).not.toBeNull();
      expect(st!.book!.levels).toBeGreaterThan(5);
      expect(Math.abs(Number(st!.book!.imbalance))).toBeLessThanOrEqual(1);
      expect(st?.openInterest).not.toBeNull();
      expect(D(st!.openInterest!.current).gt(0)).toBe(true);
      // the per-instrument daily history, not the live single point
      expect(st!.openInterest!.source).toBe('history');
      expect(st!.openInterest!.points).toBeGreaterThanOrEqual(30);
      expect(st!.openInterest!.change10d).not.toBe('');
    }
    const half = data(await api<{ sizingParams: { riskPct: string } }>('GET', '/api/signals?equity=100000&riskPct=0.005'));
    expect(half.sizingParams.riskPct).toBe('0.0025');
    const one = data(await api<{ reports: Array<{ instId: string; phase: number }> }>('GET', '/api/signals?instId=ETH-USDT-SWAP'));
    expect(one.reports.map((r) => [r.instId, r.phase])).toEqual([['ETH-USDT-SWAP', 0], ['ETH-USDT-SWAP', 12]]);
    // ?phase filters the rows; the sizing stays that of one of the two cuts
    const noon = data(await api<{ phases: number[]; sizingParams: { riskPct: string }; reports: Array<{ instId: string; phase: number }> }>('GET', '/api/signals?instId=ETH-USDT-SWAP&phase=12'));
    expect(noon.reports.map((r) => [r.instId, r.phase])).toEqual([['ETH-USDT-SWAP', 12]]);
    expect(noon.phases).toEqual([0, 12]);
    expect(noon.sizingParams.riskPct).toBe('0.00375');
    expect((await api('GET', '/api/signals?phase=6')).status).toBe(400);
    // ?lang words the reasons and the sizing notes in Chinese; English is the default
    const zh = data(await api<{ reports: Array<{ signals?: { reasons: string[] } }> }>('GET', '/api/signals?instId=ETH-USDT-SWAP&phase=0&equity=100000&lang=zh'));
    expect(zh.reports[0]?.signals?.reasons[0]).toMatch(/^收盘价 /);
    expect((await api('GET', '/api/signals?lang=fr')).status).toBe(400);
  });

  it('answers the campaign routes while the campaign is disabled: no pot, nothing to replay', async () => {
    expect(data(await api<CampaignView>('GET', '/api/campaign'))).toMatchObject({ status: 'disabled', replay: null });
    const nothing = { status: 'unavailable', reason: { code: 'CAMPAIGN_DISABLED', message: expect.stringContaining('CAMPAIGN_ENABLED=1') as string }, computedAt: null, through: null, same: null, other: null, heldBtc: [], reconciliation: null };
    expect(await api<CampaignReplayView>('GET', '/api/campaign/replay')).toEqual({ status: 200, body: { ok: true, data: nothing } });
    expect(await api<CampaignReplayView>('POST', '/api/campaign/replay', {})).toEqual({ status: 200, body: { ok: true, data: nothing } });
  });

  it('previews a limit order with sizing in coin and risk ok', async () => {
    const preview = data(await api<{ sz: string; coin: string; notionalQuote: string; risk: { ok: boolean; code: string } }>('POST', '/api/orders/preview', {
      instId: 'BTC-USDT-SWAP', side: 'buy', ordType: 'limit', px: '49000', size: { unit: 'coin', value: '0.05' },
    }));
    expect(preview.sz).toBe('5');
    expect(preview.coin).toBe('0.05');
    expect(preview.notionalQuote).toBe('2450');
    expect(preview.risk.ok).toBe(true);
  });

  it('rejects an order outside the price band and one over the notional limit', async () => {
    const far = await api<unknown>('POST', '/api/orders', { instId: 'BTC-USDT-SWAP', side: 'buy', ordType: 'limit', px: '40000', size: { unit: 'contracts', value: '1' } });
    expect(far.status).toBe(422);
    expect(far.body.ok).toBe(false);
    if (!far.body.ok) expect(far.body.error.details?.['code']).toBe('PRICE_BAND');
    const big = await api<unknown>('POST', '/api/orders', { instId: 'BTC-USDT-SWAP', side: 'buy', ordType: 'market', size: { unit: 'quote', value: '25000' } });
    expect(big.status).toBe(422);
    if (!big.body.ok) expect(big.body.error.details?.['code']).toBe('MAX_ORDER_NOTIONAL');
  });

  it('rejects sizes below the minimum with a SIZING error', async () => {
    const res = await api<unknown>('POST', '/api/orders/preview', { instId: 'BTC-USDT-SWAP', side: 'buy', ordType: 'limit', px: '49500', size: { unit: 'coin', value: '0.0001' } });
    expect(res.status).toBe(400);
    if (!res.body.ok) expect(res.body.error.code).toBe('SIZING');
  });

  it('places a resting limit order, sees it open, then cancels it', async () => {
    const placed = data(await api<{ order: Order }>('POST', '/api/orders', { instId: 'BTC-USDT-SWAP', side: 'buy', ordType: 'limit', px: '48000', size: { unit: 'contracts', value: '2' } }));
    expect(placed.order.ordId).toBeTruthy();
    expect(placed.order.clOrdId.startsWith('pg')).toBe(true);
    const open = await waitFor(() => {
      const list = deps.account.openOrderList();
      return list.find((o) => o.ordId === placed.order.ordId && o.state === 'live') ? list : undefined;
    }, 5000, 'order live');
    expect(open.some((o) => o.ordId === placed.order.ordId)).toBe(true);
    const canceled = data(await api<{ ordId: string }>('POST', '/api/orders/cancel', { instId: 'BTC-USDT-SWAP', ordId: placed.order.ordId }));
    expect(canceled.ordId).toBe(placed.order.ordId);
    await waitFor(() => !deps.account.openOrders.has(placed.order.ordId), 5000, 'order removed');
  });

  it('answers EXCHANGE_UNREACHABLE when OKX cannot be reached or does not answer in time', async () => {
    const spy = vi.spyOn(deps.clients.rest, 'getCandles');
    try {
      spy.mockRejectedValueOnce(new OkxTransportError('/api/v5/market/candles', 'OKX did not answer within 10000 ms', true));
      const slow = await api<unknown>('GET', '/api/candles?instId=BTC-USDT-SWAP&bar=1m&limit=50');
      expect(slow.status).toBe(504);
      if (!slow.body.ok) expect(slow.body.error).toMatchObject({ code: 'EXCHANGE_UNREACHABLE', details: { timedOut: true } });
      spy.mockRejectedValueOnce(new OkxTransportError('/api/v5/market/candles', 'could not reach OKX (ENOTFOUND)', false));
      const down = await api<unknown>('GET', '/api/candles?instId=BTC-USDT-SWAP&bar=1m&limit=50');
      expect(down.status).toBe(502);
      expect(down.body.ok).toBe(false);
      if (!down.body.ok) {
        expect(down.body.error.code).toBe('EXCHANGE_UNREACHABLE');
        expect(down.body.error.message).not.toMatch(/fetch failed|aborted/);
      }
    } finally {
      spy.mockRestore();
    }
  });

  it('never resends an order whose REST outcome is unknown: it is looked up by clOrdId', async () => {
    // A REST-only order service whose placeOrder loses the response (or the request) to a transport failure.
    const real = deps.clients.rest;
    const lost = new OkxTransportError('/api/v5/trade/order', 'OKX did not answer within 10000 ms', true);
    let reachExchange = true;
    let attempts = 0;
    const rest: OkxRestClient = Object.create(real) as OkxRestClient;
    rest.placeOrder = async (params) => {
      attempts++;
      if (reachExchange) await real.placeOrder(params);
      throw lost;
    };
    const orders = new OrderService({ ...deps.clients, rest }, deps.market, deps.account, deps.risk, deps.store, log, { defaultTdMode: deps.config.defaultTdMode, wsTrading: false });
    const req = { instId: 'BTC-USDT-SWAP', side: 'buy', ordType: 'limit', px: '48000', size: { unit: 'contracts', value: '1' } } as const;

    // the exchange accepted it but the answer never arrived: found by clOrdId, not placed twice
    const placed = await orders.place(req);
    expect(attempts).toBe(1);
    expect(placed.order.ordId).toBeTruthy();
    await waitFor(() => deps.account.openOrders.has(placed.order.ordId), 5000, 'order open');
    expect(deps.account.openOrderList().filter((o) => o.clOrdId === placed.order.clOrdId)).toHaveLength(1);
    data(await api<unknown>('POST', '/api/orders/cancel', { instId: 'BTC-USDT-SWAP', ordId: placed.order.ordId }));
    await waitFor(() => !deps.account.openOrders.has(placed.order.ordId), 5000, 'order removed');

    // the request never arrived: still a single attempt, reported as unknown instead of retried
    reachExchange = false;
    attempts = 0;
    const err = await orders.place(req).catch((e: unknown) => e);
    expect(attempts).toBe(1);
    expect(err).toMatchObject({ code: 'ORDER_STATUS_UNKNOWN', status: 504 });
  }, 15_000);

  it('the WebSocket order branch still places and cancels against the mock (not reachable through the configuration)', async () => {
    const orders = new OrderService(deps.clients, deps.market, deps.account, deps.risk, deps.store, log, { defaultTdMode: deps.config.defaultTdMode, wsTrading: true });
    const ws = deps.clients.wsPrivate!;
    const request = vi.spyOn(ws, 'request');
    const restPlace = vi.spyOn(deps.clients.rest, 'placeOrder');
    const restCancel = vi.spyOn(deps.clients.rest, 'cancelOrder');
    try {
      const placed = await orders.place({ instId: 'BTC-USDT-SWAP', side: 'buy', ordType: 'limit', px: '48200', size: { unit: 'contracts', value: '1' } });
      expect(placed.order.ordId).toBeTruthy();
      await waitFor(() => deps.account.openOrders.has(placed.order.ordId), 5000, 'order open');
      expect(await orders.cancel({ instId: 'BTC-USDT-SWAP', ordId: placed.order.ordId })).toMatchObject({ ordId: placed.order.ordId, sCode: '0' });
      await waitFor(() => !deps.account.openOrders.has(placed.order.ordId), 5000, 'order removed');
      expect(request.mock.calls.map(([op]) => op)).toEqual(['order', 'cancel-order']);
      expect(restPlace).not.toHaveBeenCalled();
      expect(restCancel).not.toHaveBeenCalled();
    } finally {
      request.mockRestore();
      restPlace.mockRestore();
      restCancel.mockRestore();
    }
  });

  it('fills a market order, updates positions and balance, and closes the position', async () => {
    const fills: unknown[] = [];
    deps.account.on('fill', (f) => fills.push(f));
    const balanceBefore = deps.account.balance!.totalEq;
    const placed = data(await api<{ order: Order; preview: { estSlippagePct: string } }>('POST', '/api/orders', { instId: 'ETH-USDT-SWAP', side: 'buy', ordType: 'market', size: { unit: 'coin', value: '1' } }));
    expect(placed.order.sz).toBe('10');
    const pos = await waitFor(() => deps.account.positionList().find((p) => p.instId === 'ETH-USDT-SWAP'), 5000, 'position');
    expect(D(pos.pos).eq(10)).toBe(true);
    await waitFor(() => fills.length > 0, 5000, 'fill event');
    await waitFor(() => deps.account.balance && deps.account.balance.totalEq !== balanceBefore, 5000, 'balance change');
    const positions = data(await api<Position[]>('GET', '/api/positions'));
    expect(positions.some((p) => p.instId === 'ETH-USDT-SWAP')).toBe(true);
    data(await api<unknown>('POST', '/api/positions/close', { instId: 'ETH-USDT-SWAP', mgnMode: 'cross' }));
    await waitFor(() => !deps.account.positionList().some((p) => p.instId === 'ETH-USDT-SWAP'), 5000, 'position closed');
  });

  it('a marked retry of a market order that already filled is answered with that order and executes nothing', async () => {
    // The first attempt goes out through another order service, as if the API had been restarted since: the
    // server under test has never seen the id, and the mock (like OKX) frees the id of a filled order.
    const before = new OrderService(deps.clients, deps.market, deps.account, deps.risk, deps.store, log, { defaultTdMode: deps.config.defaultTdMode, wsTrading: false });
    const req = { instId: 'ETH-USDT-SWAP', side: 'buy', ordType: 'market', size: { unit: 'contracts', value: '10' }, clOrdId: 'pgwretry1' } as const;
    const first = await before.place(req);
    const pos = await waitFor(() => deps.account.positionList().find((p) => p.instId === 'ETH-USDT-SWAP'), 5000, 'position');
    expect(D(pos.pos).eq(10)).toBe(true);

    const restPlace = vi.spyOn(deps.clients.rest, 'placeOrder');
    try {
      const retried = data(await api<{ order: Order }>('POST', '/api/orders', { ...req, retry: true }));
      expect(retried.order).toMatchObject({ ordId: first.order.ordId, clOrdId: 'pgwretry1', state: 'filled' });
      expect(restPlace).not.toHaveBeenCalled();
    } finally {
      restPlace.mockRestore();
    }
    // the exchange itself still holds 10 contracts, not 20
    const held = await deps.clients.rest.getPositions('SWAP', 'ETH-USDT-SWAP');
    expect(held.filter((p) => !D(p.pos).isZero()).map((p) => D(p.pos).toFixed())).toEqual(['10']);

    data(await api<unknown>('POST', '/api/positions/close', { instId: 'ETH-USDT-SWAP', mgnMode: 'cross' }));
    await waitFor(() => !deps.account.positionList().some((p) => p.instId === 'ETH-USDT-SWAP'), 5000, 'position closed');
  });

  it('kill switch blocks new orders and cancels open ones', async () => {
    const placed = data(await api<{ order: Order }>('POST', '/api/orders', { instId: 'BTC-USDT-SWAP', side: 'sell', ordType: 'limit', px: '52000', size: { unit: 'contracts', value: '1' } }));
    await waitFor(() => deps.account.openOrders.has(placed.order.ordId), 5000, 'order open');
    const engaged = data(await api<{ cancelSweep: { state: string } }>('POST', '/api/risk/kill-switch', { enabled: true, reason: 'test' }));
    expect(engaged.cancelSweep.state).toBe('pending');
    const blocked = await api<unknown>('POST', '/api/orders', { instId: 'BTC-USDT-SWAP', side: 'buy', ordType: 'limit', px: '49000', size: { unit: 'contracts', value: '1' } });
    expect(blocked.status).toBe(422);
    if (!blocked.body.ok) expect(blocked.body.error.details?.['code']).toBe('KILL_SWITCH');
    await waitFor(() => !deps.account.openOrders.has(placed.order.ordId), 5000, 'order canceled by kill switch');
    await waitFor(() => deps.risk.state.cancelSweep.state === 'done', 5000, 'cancel sweep done');
    expect(mock.getState().orders.filter((o) => o.state === 'live' || o.state === 'partially_filled')).toEqual([]);
    const released = data(await api<{ cancelSweep: { state: string } }>('POST', '/api/risk/kill-switch', { enabled: false }));
    expect(released.cancelSweep.state).toBe('idle');
  });

  it('attaches a mark-triggered stop to an entry; the exchange closes the position when the mark reaches it', async () => {
    const ETH = 'ETH-USDT-SWAP';
    type Placed = { order: Order; preview: { slTriggerPx: string; stopLossQuote: string } };
    try {
      // a stop on the wrong side is refused before anything is sent
      const wrong = await api<unknown>('POST', '/api/orders', { instId: ETH, side: 'buy', ordType: 'market', size: { unit: 'contracts', value: '10' }, slTriggerPx: '3300' });
      expect(wrong.status).toBe(400);
      if (!wrong.body.ok) expect(wrong.body.error).toMatchObject({ code: 'VALIDATION', details: { slTriggerPx: '3300' } });
      expect(mock.getState().positions).toEqual([]);

      // a resting entry shows its stop in the order mirror, from the exchange's own order object
      const resting = data(await api<Placed>('POST', '/api/orders', { instId: 'BTC-USDT-SWAP', side: 'buy', ordType: 'limit', px: '48000', size: { unit: 'contracts', value: '1' }, slTriggerPx: '46000.04' }));
      expect(resting.order.slTriggerPx).toBe('46000.1');
      await deps.account.refresh();
      expect(deps.account.openOrders.get(resting.order.ordId)).toMatchObject({ state: 'live', slTriggerPx: '46000.1' });
      // nothing has filled: there is no stop yet
      expect(mock.getState().stops).toEqual([]);
      data(await api<unknown>('POST', '/api/orders/cancel', { instId: 'BTC-USDT-SWAP', ordId: resting.order.ordId }));
      await waitFor(() => !deps.account.openOrders.has(resting.order.ordId), 5000, 'order removed');

      const placed = data(await api<Placed>('POST', '/api/orders', { instId: ETH, side: 'buy', ordType: 'market', size: { unit: 'contracts', value: '10' }, slTriggerPx: '2700.004' }));
      // rounded to the tick towards the entry
      expect(placed.order.slTriggerPx).toBe('2700.01');
      expect(placed.preview.slTriggerPx).toBe('2700.01');
      expect(D(placed.preview.stopLossQuote).gt(200)).toBe(true); // 1 ETH, some 300 below the fill
      await waitFor(() => deps.account.positionList().find((p) => p.instId === ETH), 5000, 'position');
      expect(mock.getState().stops).toMatchObject([{ ordId: placed.order.ordId, algoClOrdId: `sl${placed.order.clOrdId}`, instId: ETH, side: 'sell', sz: '10', slTriggerPx: '2700.01', slTriggerPxType: 'mark' }]);

      // the mark comes down but stays above the trigger
      mock.setMarkPrice(ETH, '2750');
      await waitFor(() => deps.market.markPrice(ETH)?.markPx === '2750', 5000, 'mark push');
      expect(mock.getState().stops).toHaveLength(1);
      expect(deps.account.positionList().some((p) => p.instId === ETH)).toBe(true);

      mock.setMarkPrice(ETH, '2700');
      await waitFor(() => !deps.account.positionList().some((p) => p.instId === ETH), 5000, 'position closed by the stop');
      expect(mock.getState().stops).toEqual([]);
      expect(mock.getState().positions).toEqual([]);
    } finally {
      mock.setMarkPrice(ETH, null);
    }
    await waitFor(() => D(deps.market.markPrice(ETH)?.markPx ?? '0').gt(2900), 5000, 'mark released');
  });

  it('lists the stop of a filled entry, moves it and cancels it; the page hears every read', async () => {
    const ETH = 'ETH-USDT-SWAP';
    const heard: AlgoOrderList[] = [];
    const onList = (l: AlgoOrderList): void => void heard.push(l);
    deps.account.on('algoOrders', onList);
    try {
      expect(data(await api<AlgoOrderList>('GET', '/api/algo-orders')).orders).toEqual([]);
      const entry = data(await api<{ order: Order }>('POST', '/api/orders', { instId: ETH, side: 'buy', ordType: 'market', size: { unit: 'contracts', value: '10' }, slTriggerPx: '2700' }));
      // no request from the page: the fill itself makes the server read the stops again
      const stop = await waitFor(() => deps.account.algoOrders?.orders.find((a) => a.instId === ETH), 5000, 'stop in the mirror');
      expect(stop).toMatchObject({ algoClOrdId: `sl${entry.order.clOrdId}`, instId: ETH, side: 'sell', posSide: 'net', tdMode: 'cross', sz: '10', closeFraction: '', slTriggerPx: '2700', slTriggerPxType: 'mark', slOrdPx: '-1', tpTriggerPx: '' });
      expect(heard.length).toBeGreaterThan(0);
      expect(deps.hub.hello().algoOrders?.orders.map((a) => a.algoId)).toEqual([stop.algoId]);

      // a move on the wrong side of the mark, to where it already is, or of an unknown stop is refused before the exchange
      const mark = Number(deps.market.liveMarkPrice(ETH));
      const wrong = await api<unknown>('POST', '/api/algo-orders/amend', { instId: ETH, algoId: stop.algoId, slTriggerPx: String(Math.ceil(mark) + 100) });
      expect(wrong.status).toBe(400);
      if (!wrong.body.ok) expect(wrong.body.error.code).toBe('VALIDATION');
      expect((await api<unknown>('POST', '/api/algo-orders/amend', { instId: ETH, algoId: stop.algoId, slTriggerPx: '2700' })).status).toBe(400);
      const unknown = await api<unknown>('POST', '/api/algo-orders/amend', { instId: ETH, algoId: '999', slTriggerPx: '2800' });
      expect(unknown.status).toBe(404);
      if (!unknown.body.ok) expect(unknown.body.error.code).toBe('ALGO_NOT_FOUND');
      expect(mock.getState().stops).toMatchObject([{ algoId: stop.algoId, slTriggerPx: '2700' }]);

      // the move: rounded to the tick towards the price, only the trigger changes
      const moved = data(await api<{ algoId: string; slTriggerPx: string; previous: string }>('POST', '/api/algo-orders/amend', { instId: ETH, algoId: stop.algoId, slTriggerPx: '2800.004' }));
      expect(moved).toEqual({ algoId: stop.algoId, instId: ETH, slTriggerPx: '2800.01', previous: '2700' });
      expect(mock.getState().stops).toMatchObject([{ algoId: stop.algoId, sz: '10', slTriggerPx: '2800.01', slTriggerPxType: 'mark' }]);
      expect(deps.account.algoOrders?.orders).toMatchObject([{ algoId: stop.algoId, slTriggerPx: '2800.01' }]);

      // the cancel: the stop is gone at the exchange and in the mirror, the position stays
      const before = heard.length;
      expect(data(await api<{ algoId: string }>('POST', '/api/algo-orders/cancel', { instId: ETH, algoId: stop.algoId }))).toEqual({ algoId: stop.algoId, instId: ETH });
      expect(mock.getState().stops).toEqual([]);
      expect(deps.account.algoOrders?.orders).toEqual([]);
      expect(heard.length).toBeGreaterThan(before);
      expect(deps.account.positionList().some((p) => p.instId === ETH)).toBe(true);
      // cancelling it again is the exchange's refusal, passed on with its code
      const again = await api<unknown>('POST', '/api/algo-orders/cancel', { instId: ETH, algoId: stop.algoId });
      expect(again.status).toBe(502);
      if (!again.body.ok) expect(again.body.error).toMatchObject({ code: 'EXCHANGE', details: { okxCode: '51400' } });
    } finally {
      deps.account.off('algoOrders', onList);
      data(await api<unknown>('POST', '/api/positions/close', { instId: ETH, mgnMode: 'cross' }));
      await waitFor(() => !deps.account.positionList().some((p) => p.instId === ETH), 5000, 'position closed');
    }
  });

  it('places a stop for a position that has none, only for what its stops leave uncovered and only on the losing side of the mark', async () => {
    const ETH = 'ETH-USDT-SWAP';
    type Placed = { algoId: string; instId: string; slTriggerPx: string; sz: string };
    try {
      // no position: nothing to protect
      const none = await api<unknown>('POST', '/api/algo-orders', { instId: ETH, mgnMode: 'cross', slTriggerPx: '2700' });
      expect(none.status).toBe(400);
      if (!none.body.ok) expect(none.body.error.message).toContain('no open cross position in ETH-USDT-SWAP');

      data(await api<unknown>('POST', '/api/orders', { instId: ETH, side: 'buy', ordType: 'market', size: { unit: 'contracts', value: '10' } }));
      await waitFor(() => deps.account.positionList().find((p) => p.instId === ETH), 5000, 'position');
      expect(mock.getState().stops).toEqual([]);

      const mark = Number(deps.market.liveMarkPrice(ETH));
      const wrong = await api<unknown>('POST', '/api/algo-orders', { instId: ETH, mgnMode: 'cross', slTriggerPx: String(Math.ceil(mark) + 100) });
      expect(wrong.status).toBe(400);
      if (!wrong.body.ok) expect(wrong.body.error).toMatchObject({ code: 'VALIDATION', details: { markPx: deps.market.liveMarkPrice(ETH) } });
      const tooMany = await api<unknown>('POST', '/api/algo-orders', { instId: ETH, mgnMode: 'cross', slTriggerPx: '2700', sz: '11' });
      expect(tooMany.status).toBe(400);
      expect(mock.getState().stops).toEqual([]);

      // part of the position first, then the rest without naming a size; the trigger is rounded towards the price
      const first = await api<Placed>('POST', '/api/algo-orders', { instId: ETH, mgnMode: 'cross', slTriggerPx: '2700.004', sz: '4' });
      expect(first.status).toBe(201);
      expect(data(first)).toMatchObject({ instId: ETH, slTriggerPx: '2700.01', sz: '4' });
      expect(mock.getState().stops).toMatchObject([{ algoId: data(first).algoId, ordId: '', side: 'sell', posSide: 'net', sz: '4', slTriggerPx: '2700.01', slTriggerPxType: 'mark' }]);
      expect(mock.getState().stops[0]?.algoClOrdId).toMatch(/^sl[a-z0-9]+$/);
      const rest = data(await api<Placed>('POST', '/api/algo-orders', { instId: ETH, mgnMode: 'cross', slTriggerPx: '2650' }));
      expect(rest.sz).toBe('6');
      expect(deps.account.algoOrders?.orders.map((a) => [a.sz, a.slTriggerPx]).sort()).toEqual([['4', '2700.01'], ['6', '2650']]);

      // fully covered: one more is refused before the exchange
      const covered = await api<unknown>('POST', '/api/algo-orders', { instId: ETH, mgnMode: 'cross', slTriggerPx: '2600' });
      expect(covered.status).toBe(400);
      if (!covered.body.ok) expect(covered.body.error).toMatchObject({ code: 'VALIDATION', details: { covered: '10', size: '10' } });
      expect(mock.getState().stops).toHaveLength(2);

      // allowed while the kill switch is on: a stop only takes risk away
      data(await api<unknown>('POST', '/api/algo-orders/cancel', { instId: ETH, algoId: rest.algoId }));
      data(await api<unknown>('POST', '/api/risk/kill-switch', { enabled: true, reason: 'test' }));
      try {
        expect((await api<Placed>('POST', '/api/algo-orders', { instId: ETH, mgnMode: 'cross', slTriggerPx: '2650' })).status).toBe(201);
      } finally {
        data(await api<unknown>('POST', '/api/risk/kill-switch', { enabled: false }));
      }
    } finally {
      data(await api<unknown>('POST', '/api/positions/close', { instId: ETH, mgnMode: 'cross' }));
      await waitFor(() => !deps.account.positionList().some((p) => p.instId === ETH), 5000, 'position closed');
    }
    expect(mock.getState().stops).toEqual([]);
  });

  it('the kill switch cancel sweep leaves an active attached stop alone', async () => {
    const ETH = 'ETH-USDT-SWAP';
    const entry = data(await api<{ order: Order }>('POST', '/api/orders', { instId: ETH, side: 'buy', ordType: 'market', size: { unit: 'contracts', value: '10' }, slTriggerPx: '2700' }));
    await waitFor(() => deps.account.positionList().find((p) => p.instId === ETH), 5000, 'position');
    const resting = data(await api<{ order: Order }>('POST', '/api/orders', { instId: 'BTC-USDT-SWAP', side: 'sell', ordType: 'limit', px: '52000', size: { unit: 'contracts', value: '1' } }));
    await waitFor(() => deps.account.openOrders.has(resting.order.ordId), 5000, 'order open');
    expect(mock.getState().stops).toHaveLength(1);

    data(await api<unknown>('POST', '/api/risk/kill-switch', { enabled: true, reason: 'test' }));
    try {
      await waitFor(() => deps.risk.state.cancelSweep.state === 'done', 5000, 'cancel sweep done');
      // the open order is gone; the stop is an algo order and still protects the position
      expect(mock.getState().orders.filter((o) => o.state === 'live' || o.state === 'partially_filled')).toEqual([]);
      expect(mock.getState().stops).toMatchObject([{ ordId: entry.order.ordId, instId: ETH, sz: '10', slTriggerPx: '2700' }]);
      expect(deps.account.positionList().some((p) => p.instId === ETH)).toBe(true);

      // closing is allowed under the halt, and the stop goes with its position
      data(await api<unknown>('POST', '/api/positions/close', { instId: ETH, mgnMode: 'cross' }));
      await waitFor(() => !deps.account.positionList().some((p) => p.instId === ETH), 5000, 'position closed');
      expect(mock.getState().stops).toEqual([]);
    } finally {
      data(await api<unknown>('POST', '/api/risk/kill-switch', { enabled: false }));
    }
  });

  it('streams hello, market data and private updates over /ws', async () => {
    const unauth = new WebSocket(`ws://${baseUrl}/ws?token=wrong`);
    const unauthResult = await Promise.race([
      once(unauth, 'open').then(() => 'open'),
      new Promise<string>((resolve) => unauth.once('error', (e) => resolve(`error:${e.message}`))),
      new Promise<string>((resolve) => unauth.once('close', (code) => resolve(`close:${code}`))),
    ]);
    expect(unauthResult).not.toBe('open');

    const ws = new WebSocket(`ws://${baseUrl}/ws?token=${TOKEN}`);
    const received: ServerMessage[] = [];
    // Register before 'open': the server sends `hello` immediately and ws may deliver it in the same tick.
    ws.on('message', (raw) => received.push(decodeServerMessage(raw.toString())));
    await once(ws, 'open');
    const hello = await waitFor(() => received.find((m) => m.type === 'hello'), 5000, 'hello');
    expect(hello.type === 'hello' && hello.data.instruments.length).toBe(2);
    ws.send(JSON.stringify({ type: 'subscribe', instId: 'BTC-USDT-SWAP', bar: '1m' }));
    await waitFor(() => received.some((m) => m.type === 'subscribed'), 5000, 'subscribed');
    await waitFor(() => received.some((m) => m.type === 'book') && received.some((m) => m.type === 'ticker'), 5000, 'book+ticker');
    await waitFor(() => received.some((m) => m.type === 'candle'), 5000, 'candle push');
    ws.send(JSON.stringify({ type: 'ping' }));
    await waitFor(() => received.some((m) => m.type === 'pong'), 2000, 'pong');
    // a private update reaches the terminal
    const placed = data(await api<{ order: Order }>('POST', '/api/orders', { instId: 'BTC-USDT-SWAP', side: 'buy', ordType: 'limit', px: '48500', size: { unit: 'contracts', value: '1' } }));
    await waitFor(() => received.some((m) => m.type === 'order' && m.data.ordId === placed.order.ordId), 5000, 'order push');
    data(await api<unknown>('POST', '/api/orders/cancel-all', {}));
    await waitFor(() => received.some((m) => m.type === 'order' && m.data.ordId === placed.order.ordId && m.data.state === 'canceled'), 5000, 'cancel push');
    ws.close();
  }, 20_000);
});
