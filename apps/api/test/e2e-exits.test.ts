/**
 * End-to-end: the exits of this stage (take-profits, the cost-price stop, the exchange's trailing stop, channel
 * trailing) through the API against the in-process mock OKX, in net mode and in long/short mode.
 */
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { pino } from 'pino';
import { startMockOkx, type MockOkxHandle } from '@pegasus/mock-okx';
import type { OkxPlaceOrderParams } from '@pegasus/okx';
import { D, type AlgoOrderList, type ApiResponse, type Candle, type ChannelTrailingEntry, type Order, type OrderPreview, type PlaceTakeProfitsResult, type PlaceTrailingStopResult, type TrailingView } from '@pegasus/shared';
import type { FastifyInstance, InjectOptions } from 'fastify';
import { loadConfig } from '../src/config.js';
import { MemoryStore } from '../src/db/store.js';
import type { Deps } from '../src/deps.js';
import { createOkxClients, syncClock } from '../src/okx/clients.js';
import { buildServer } from '../src/server.js';
import { AccountService } from '../src/services/account.js';
import { ChannelTrailingService } from '../src/services/channel-trailing.js';
import { ExitFollowUp } from '../src/services/exit-orders.js';
import { ExitStateFile } from '../src/services/exit-state.js';
import { MarketDataService } from '../src/services/market-data.js';
import { OrderService } from '../src/services/order-service.js';
import { RiskEngine } from '../src/services/risk-engine.js';
import { SignalsService } from '../src/services/signals.js';
import { Hub } from '../src/ws/hub.js';

const TOKEN = 'test-token';
const CREDS = { apiKey: 'k', apiSecret: 's', passphrase: 'p' };
const BTC = 'BTC-USDT-SWAP';
const DAY = 86_400_000;
const log = pino({ level: process.env['E2E_LOG'] ?? 'silent' });
vi.setConfig({ testTimeout: 30_000 });

interface Ctx {
  mock: MockOkxHandle;
  app: FastifyInstance;
  deps: Deps;
  /** The clock of channel trailing */
  clock: { now: number };
  /** The daily bars channel trailing reads */
  candles: { rows: Candle[] };
  sent: OkxPlaceOrderParams[];
}

async function waitFor<T>(fn: () => T | undefined | null | false | Promise<T | undefined | null | false>, timeoutMs = 8000, label = 'condition'): Promise<T> {
  const start = Date.now();
  for (;;) {
    const v = await fn();
    if (v) return v;
    if (Date.now() - start > timeoutMs) throw new Error(`timeout waiting for ${label}`);
    await new Promise((r) => setTimeout(r, 25));
  }
}

/** Ten daily bars before `close`, the last one closing at it: lows `low + i * step`, highs `high + i * step`. */
function dailyBars(close: number, low: number, high: number, step: number): Candle[] {
  return Array.from({ length: 10 }, (_, i) => ({ ts: close - (10 - i) * DAY, open: String(low + 300 + i * step), high: String(high + i * step), low: String(low + i * step), close: String(low + 500 + i * step), vol: '1', volCcy: '1', confirm: true }));
}

async function setup(posMode: 'net_mode' | 'long_short_mode'): Promise<Ctx> {
  const mock = await startMockOkx({ port: 0, credentials: CREDS, seed: 42, tickIntervalMs: 50, volatility: 0, posMode, initialPrices: { [BTC]: '50000', 'ETH-USDT-SWAP': '3000' }, initialBalanceUsdt: '100000' });
  const dir = mkdtempSync(join(tmpdir(), 'pegasus-e2e-exits-'));
  const config = loadConfig({
    OKX_API_KEY: CREDS.apiKey, OKX_API_SECRET: CREDS.apiSecret, OKX_API_PASSPHRASE: CREDS.passphrase, OKX_DEMO: '1',
    OKX_REST_URL: mock.restUrl, OKX_WS_PUBLIC_URL: mock.wsPublicUrl, OKX_WS_PRIVATE_URL: mock.wsPrivateUrl, OKX_WS_BUSINESS_URL: mock.wsBusinessUrl,
    API_TOKEN: TOKEN, INSTRUMENTS: `${BTC},ETH-USDT-SWAP`, TRAILING_STATE_FILE: join(dir, 'trailing.json'),
    RISK_MAX_ORDER_NOTIONAL: '20000', RISK_MAX_POSITION_NOTIONAL_PER_INSTRUMENT: '30000', RISK_MAX_TOTAL_POSITION_NOTIONAL: '50000', RISK_MAX_LEVERAGE: '20',
    RISK_DAILY_LOSS_LIMIT: '5000', RISK_MAX_OPEN_ORDERS: '5', RISK_PRICE_BAND_PCT: '0.05', RISK_MAX_SLIPPAGE_PCT: '0.01',
  });
  // a mock on this machine: the exits are offered
  expect(config.exits.enabled).toBe(true);
  const store = new MemoryStore();
  const clients = createOkxClients(config, log);
  await syncClock(clients, log);
  const sent: OkxPlaceOrderParams[] = [];
  const placeOrder = clients.rest.placeOrder.bind(clients.rest);
  vi.spyOn(clients.rest, 'placeOrder').mockImplementation((params) => {
    sent.push(params);
    return placeOrder(params);
  });
  const market = new MarketDataService(clients, log, { bookDepth: 50, bookThrottleMs: 20 });
  await market.loadInstruments(config.instruments);
  const account = new AccountService(clients, store, log, { readTrailingStops: true });
  const risk = new RiskEngine(config.risk, store, log);
  await risk.init();
  const orders = new OrderService(clients, market, account, risk, store, log, { defaultTdMode: config.defaultTdMode, wsTrading: false, exits: true });
  const signals = new SignalsService(clients, market, account, log);
  const hub = new Hub(config, market, account, risk, log);
  const clock = { now: Date.UTC(2026, 9, 5, 0, 5) };
  const candles = { rows: [] as Candle[] };
  const state = new ExitStateFile(config.exits.stateFile);
  const trailing = new ChannelTrailingService({ clients, account, orders, market, store, log }, { enabled: true, state, now: () => clock.now, candles: async () => candles.rows, checkEveryMs: 0 });
  const exitFollowUp = new ExitFollowUp({ clients, account, orders, channel: trailing, store, log }, { enabled: true, state, retryMs: 0, orphanAgeMs: 0 });
  const deps: Deps = { config, log, clients, store, market, account, risk, orders, signals, hub, trailing, exitFollowUp };
  account.on('balance', (b) => risk.updateEquity(b.totalEq));
  hub.wire();
  exitFollowUp.start();
  trailing.start();
  const app = await buildServer(deps);
  await market.start();
  await account.start();
  await waitFor(() => market.book(BTC) && market.ticker(BTC) && market.liveMarkPrice(BTC) && account.ready && account.balance, 10_000, 'market data + private stream');
  return { mock, app, deps, clock, candles, sent };
}

async function teardown(c: Ctx): Promise<void> {
  await c.deps.trailing?.stop();
  c.deps.exitFollowUp?.stop();
  await c.deps.hub.close();
  await c.app.close();
  await c.deps.market.stop();
  await c.deps.account.stop();
  await c.mock.close();
}

function client(c: () => Ctx) {
  const api = async <T>(method: 'GET' | 'POST', path: string, body?: unknown): Promise<{ status: number; body: ApiResponse<T> }> => {
    const opts: InjectOptions = { method, url: path, headers: { authorization: `Bearer ${TOKEN}`, 'content-type': 'application/json' } };
    if (body !== undefined) opts.payload = JSON.stringify(body);
    const res = await c().app.inject(opts);
    return { status: res.statusCode, body: res.json() as ApiResponse<T> };
  };
  const data = <T>(r: { status: number; body: ApiResponse<T> }): T => {
    if (!r.body.ok) throw new Error(`api error ${r.status}: ${JSON.stringify(r.body.error)}`);
    return r.body.data;
  };
  const position = (posSide = 'net') => c().deps.account.positionList().find((p) => p.instId === BTC && p.posSide === posSide);
  const mark = (): number => Number(c().deps.market.liveMarkPrice(BTC));
  /** Pins the mark and waits until the API has it. */
  const pinMark = async (px: string | null): Promise<void> => {
    c().mock.setMarkPrice(BTC, px);
    if (px !== null) await waitFor(() => c().deps.market.liveMarkPrice(BTC) === px, 5000, `mark ${px}`);
  };
  const flat = async (posSide: 'net' | 'long' | 'short' = 'net'): Promise<void> => {
    if (position(posSide)) data(await api('POST', '/api/positions/close', { instId: BTC, mgnMode: 'cross', ...(posSide === 'net' ? {} : { posSide }) }));
    await waitFor(() => !position(posSide), 5000, 'flat');
  };
  return { api, data, position, mark, pinMark, flat };
}

describe('exits e2e, net mode', () => {
  let ctx: Ctx;
  const { api, data, position, mark, pinMark, flat } = client(() => ctx);
  beforeAll(async () => {
    ctx = await setup('net_mode');
  }, 30_000);
  afterAll(async () => {
    await teardown(ctx);
  });

  it('split take-profits with the cost-price stop: sized as previewed, the first closes its leg and moves the stop to the entry', async () => {
    const m = mark();
    const body = { instId: BTC, side: 'buy', ordType: 'market', size: { unit: 'contracts', value: '10' }, slTriggerPx: String(m - 1000), takeProfits: [{ triggerPx: String(m + 500), fraction: '0.4' }, { triggerPx: String(m + 1000), fraction: '0.6' }], breakevenAfterTp1: true };
    const preview = data(await api<OrderPreview>('POST', '/api/orders/preview', body));
    expect(preview.takeProfits?.map((l) => [l.triggerPx, l.sz])).toEqual([[String(m + 500), '4'], [String(m + 1000), '6']]);
    const placed = data(await api<{ order: Order; preview: OrderPreview }>('POST', '/api/orders', body));
    expect(ctx.sent.at(-1)?.attachAlgoOrds).toHaveLength(3);
    await waitFor(() => position(), 5000, 'position');
    const stops = await waitFor(() => (ctx.mock.getState().stops.length === 3 ? ctx.mock.getState().stops : null), 5000, 'the attached orders');
    expect(stops.map((s) => [s.sz, s.tpTriggerPx ?? '', s.slTriggerPx, s.amendPxOnTriggerType ?? false])).toEqual([
      ['4', String(m + 500), '', false],
      ['6', String(m + 1000), '', false],
      ['10', '', String(m - 1000), true],
    ]);
    // the server lists them with their legs
    const list = data(await api<AlgoOrderList>('GET', '/api/algo-orders'));
    expect(list.orders.filter((a) => a.tpTriggerPx !== '').map((a) => [a.sz, a.tpTriggerPxType])).toEqual(expect.arrayContaining([['4', 'mark'], ['6', 'mark']]));
    expect(list.orders.find((a) => a.slTriggerPx !== '')).toMatchObject({ amendPxOnTriggerType: true, algoClOrdId: `sl${placed.order.clOrdId.slice(-30)}` });

    const avgPx = await waitFor(() => position()?.avgPx, 5000, 'avgPx');
    try {
      await pinMark(String(m + 500));
      await waitFor(() => position()?.pos === '6', 5000, 'the first take-profit');
      expect(ctx.mock.getState().stops.find((s) => s.slTriggerPx !== '')).toMatchObject({ sz: '10', slTriggerPx: avgPx });
      // the mark on the tick at or below the entry (the fill price is an average of book levels)
      await pinMark(D(avgPx).toDecimalPlaces(1, 1).toFixed());
      await waitFor(() => !position(), 5000, 'the cost-price stop');
      expect(ctx.mock.getState().stops).toEqual([]);
    } finally {
      await pinMark(null);
    }
  });

  it('an order that follows a signal carries ps; source and signal never reach the exchange; a take-profit on the wrong side is the risk engine\'s refusal', async () => {
    const m = mark();
    const signal = { rule: 'campaign', kind: 'entry', barTs: Date.UTC(2026, 9, 4), close: String(m), entryLevel: String(m - 100), exitLevel: String(m - 2000) };
    const placed = data(await api<{ order: Order }>('POST', '/api/orders', { instId: BTC, side: 'buy', ordType: 'market', size: { unit: 'contracts', value: '2' }, source: 'signal', signal }));
    expect(placed.order.clOrdId).toMatch(/^ps/);
    expect(ctx.sent.at(-1)).not.toHaveProperty('source');
    expect(ctx.sent.at(-1)).not.toHaveProperty('signal');
    await waitFor(() => position(), 5000, 'position');
    const wrong = await api<unknown>('POST', '/api/orders', { instId: BTC, side: 'buy', ordType: 'market', size: { unit: 'contracts', value: '2' }, takeProfits: [{ triggerPx: String(m - 500), fraction: '1' }] });
    expect(wrong.status).toBe(422);
    if (!wrong.body.ok) expect(wrong.body.error).toMatchObject({ code: 'RISK_REJECTED', details: { code: 'TP_WRONG_SIDE' } });
    const small = await api<unknown>('POST', '/api/orders', { instId: BTC, side: 'buy', ordType: 'market', size: { unit: 'contracts', value: '0.2' }, takeProfits: [{ triggerPx: String(m + 500), fraction: '0.3' }, { triggerPx: String(m + 600), fraction: '0.7' }] });
    expect(small.status).toBe(400);
    if (!small.body.ok) expect(small.body.error).toMatchObject({ code: 'TP_LEG_TOO_SMALL', details: { leg: 1 } });
    await flat();
  });

  it('a callback trailing exit is placed once its order has filled, sized to the position, and closes it on the way back', async () => {
    const placed = data(await api<{ order: Order }>('POST', '/api/orders', { instId: BTC, side: 'buy', ordType: 'market', size: { unit: 'contracts', value: '10' }, trailing: { kind: 'callback', ratio: '0.01' } }));
    const trail = await waitFor(() => ctx.mock.getState().stops.find((s) => s.ordType === 'move_order_stop'), 8000, 'the trailing stop');
    expect(trail).toMatchObject({ side: 'sell', sz: '10', callbackRatio: '0.01', algoClOrdId: `tr${placed.order.clOrdId.slice(-30)}` });
    // the pending exit is dropped once the placement has been answered
    await waitFor(async () => data(await api<TrailingView>('GET', '/api/trailing')).pending.length === 0, 8000, 'nothing pending');
    const listed = await waitFor(() => ctx.deps.account.algoOrders?.orders.find((a) => a.ordType === 'move_order_stop'), 8000, 'listed');
    expect(listed).toMatchObject({ callbackRatio: '0.01', sz: '10' });
    // the price rises 2%, then comes back 1% from its high
    const m = mark();
    ctx.mock.setPrice(BTC, String(Math.round(m * 1.02)));
    await waitFor(() => position(), 2000, 'still open');
    ctx.mock.setPrice(BTC, String(Math.round(m * 1.02 * 0.985)));
    await waitFor(() => !position(), 5000, 'closed by the trailing stop');
    expect(ctx.mock.getState().stops).toEqual([]);
    ctx.mock.setPrice(BTC, String(m));
  });

  it('exits for an open position: take-profit legs and a trailing stop pass under the kill switch; channel trailing places and moves the stop; leftovers are cancelled with the position', async () => {
    await flat();
    ctx.clock.now = Date.UTC(2026, 9, 5, 0, 5);
    data(await api('POST', '/api/orders', { instId: BTC, side: 'buy', ordType: 'market', size: { unit: 'contracts', value: '10' } }));
    await waitFor(() => position(), 5000, 'position');
    const m = mark();
    data(await api('POST', '/api/risk/kill-switch', { enabled: true, reason: 'test' }));
    try {
      const tps = await api<PlaceTakeProfitsResult>('POST', '/api/positions/take-profits', { instId: BTC, mgnMode: 'cross', takeProfits: [{ triggerPx: String(m + 800), fraction: '0.5' }] });
      expect(tps.status).toBe(201);
      expect(data(tps).legs).toMatchObject([{ triggerPx: String(m + 800), sz: '5' }]);
      const tr = await api<PlaceTrailingStopResult>('POST', '/api/positions/trailing-stop', { instId: BTC, mgnMode: 'cross', ratio: '0.05' });
      expect(tr.status).toBe(201);
      expect(data(tr)).toMatchObject({ sz: '10', callbackRatio: '0.05', activePx: '' });
      // more than the position is refused before the exchange
      const more = await api<unknown>('POST', '/api/positions/trailing-stop', { instId: BTC, mgnMode: 'cross', ratio: '0.05', sz: '1' });
      expect(more.status).toBe(400);
      if (!more.body.ok) expect(more.body.error.code).toBe('TRAILING_EXCEEDS_POSITION');

      // channel trailing: ten closed days whose lows climb from m - 3000; the channel of 3 is the low of the last three
      ctx.candles.rows = dailyBars(Date.UTC(2026, 9, 5), m - 3000, m - 1000, 100);
      const entry = data(await api<ChannelTrailingEntry>('POST', '/api/positions/channel-trailing', { instId: BTC, mgnMode: 'cross', bars: 3 }));
      expect(entry).toMatchObject({ direction: 'long', bars: 3, source: 'route', level: String(m - 2300), lastMove: { action: 'placed', to: String(m - 2300) } });
      expect(ctx.mock.getState().stops.find((s) => s.slTriggerPx === String(m - 2300))).toMatchObject({ sz: '10', algoClOrdId: expect.stringMatching(/^ch/) });
      // the next daily close: the lows rose by 100
      ctx.clock.now += DAY;
      ctx.candles.rows = dailyBars(Date.UTC(2026, 9, 6), m - 2900, m - 900, 100);
      await ctx.deps.trailing?.tick();
      expect(ctx.mock.getState().stops.filter((s) => s.slTriggerPx !== '').map((s) => s.slTriggerPx)).toEqual([String(m - 2200)]);
      expect(data(await api<TrailingView>('GET', '/api/trailing')).entries).toMatchObject([{ level: String(m - 2200), lastMove: { action: 'amended', from: String(m - 2300), to: String(m - 2200) } }]);
      expect(data(await api<{ cleared: boolean }>('POST', '/api/positions/channel-trailing/clear', { instId: BTC, mgnMode: 'cross' }))).toMatchObject({ cleared: true });
      expect(data(await api<TrailingView>('GET', '/api/trailing')).entries).toEqual([]);
    } finally {
      data(await api('POST', '/api/risk/kill-switch', { enabled: false }));
    }
    // closing the position: the take-profit (cxlOnClosePos) and the stop go with it at the exchange; the trailing stop
    // stays there (OKX has no such flag for it) and is cancelled by the server
    await flat();
    await waitFor(() => ctx.mock.getState().stops.length === 0, 8000, 'the leftover trailing stop cancelled');
  });

  it('channel trailing from an opening order: set once the order has filled', async () => {
    await flat();
    ctx.clock.now = Date.UTC(2026, 9, 6, 0, 5);
    const m = mark();
    ctx.candles.rows = dailyBars(Date.UTC(2026, 9, 6), m - 2900, m - 900, 100);
    const placed = data(await api<{ order: Order }>('POST', '/api/orders', { instId: BTC, side: 'buy', ordType: 'market', size: { unit: 'contracts', value: '3' }, trailing: { kind: 'channel', bars: 3 } }));
    const entry = await waitFor(async () => data(await api<TrailingView>('GET', '/api/trailing')).entries.find((e) => e.level !== null), 8000, 'the entry');
    expect(entry).toMatchObject({ source: 'order', clOrdId: placed.order.clOrdId, level: String(m - 2200) });
    expect(ctx.mock.getState().stops).toMatchObject([{ sz: '3', slTriggerPx: String(m - 2200) }]);
    await flat();
    await ctx.deps.trailing?.tick();
    expect(data(await api<TrailingView>('GET', '/api/trailing')).entries).toEqual([]);
  });
});

describe('exits e2e, long/short mode', () => {
  let ctx: Ctx;
  const { api, data, position, mark, pinMark, flat } = client(() => ctx);
  beforeAll(async () => {
    ctx = await setup('long_short_mode');
  }, 30_000);
  afterAll(async () => {
    await teardown(ctx);
  });

  it('split take-profits of a short close its leg only; the long leg is untouched', async () => {
    data(await api('POST', '/api/orders', { instId: BTC, side: 'buy', posSide: 'long', ordType: 'market', size: { unit: 'contracts', value: '2' } }));
    const m = mark();
    data(await api('POST', '/api/orders', { instId: BTC, side: 'sell', posSide: 'short', ordType: 'market', size: { unit: 'contracts', value: '10' }, slTriggerPx: String(m + 1000), takeProfits: [{ triggerPx: String(m - 500), fraction: '0.5' }, { triggerPx: String(m - 1000), fraction: '0.5' }] }));
    await waitFor(() => position('short') && position('long'), 5000, 'both legs');
    const stops = await waitFor(() => (ctx.mock.getState().stops.length === 3 ? ctx.mock.getState().stops : null), 5000, 'the attached orders');
    expect(stops.map((s) => [s.posSide, s.side, s.sz])).toEqual([['short', 'buy', '5'], ['short', 'buy', '5'], ['short', 'buy', '10']]);
    try {
      await pinMark(String(m - 500));
      await waitFor(() => position('short')?.pos === '5', 5000, 'the first take-profit');
      expect(position('long')?.pos).toBe('2');
    } finally {
      await pinMark(null);
    }
    await flat('short');
    await flat('long');
  });

  it('a trailing stop and channel trailing for a short, take-profits for a long; the take-profits a closed leg leaves are cancelled by the server', async () => {
    await flat('short');
    await flat('long');
    data(await api('POST', '/api/orders', { instId: BTC, side: 'sell', posSide: 'short', ordType: 'market', size: { unit: 'contracts', value: '4' } }));
    data(await api('POST', '/api/orders', { instId: BTC, side: 'buy', posSide: 'long', ordType: 'market', size: { unit: 'contracts', value: '6' } }));
    await waitFor(() => position('short') && position('long'), 5000, 'both legs');
    const m = mark();
    const noSide = await api<unknown>('POST', '/api/positions/trailing-stop', { instId: BTC, mgnMode: 'cross', ratio: '0.02' });
    expect(noSide.status).toBe(400);
    // the activation price of a short's trailing stop must be below the price
    const wrongActive = await api<unknown>('POST', '/api/positions/trailing-stop', { instId: BTC, mgnMode: 'cross', posSide: 'short', ratio: '0.02', activePx: String(m + 300) });
    expect(wrongActive.status).toBe(422);
    if (!wrongActive.body.ok) expect(wrongActive.body.error.details).toMatchObject({ code: 'ACTIVE_PX_WRONG_SIDE' });
    expect(data(await api<PlaceTrailingStopResult>('POST', '/api/positions/trailing-stop', { instId: BTC, mgnMode: 'cross', posSide: 'short', ratio: '0.02', activePx: String(m - 300) }))).toMatchObject({ posSide: 'short', sz: '4', activePx: String(m - 300) });
    expect(ctx.mock.getState().stops.find((s) => s.ordType === 'move_order_stop')).toMatchObject({ posSide: 'short', side: 'buy', activePx: String(m - 300) });

    // channel trailing of the short: the highest high of the last 3 days
    ctx.candles.rows = dailyBars(Date.UTC(2026, 9, 5), m - 1000, m + 3000, -100);
    const entry = data(await api<ChannelTrailingEntry>('POST', '/api/positions/channel-trailing', { instId: BTC, mgnMode: 'cross', posSide: 'short', bars: 3 }));
    expect(entry).toMatchObject({ direction: 'short', posSide: 'short', level: String(m + 2300) });
    expect(ctx.mock.getState().stops.find((s) => s.slTriggerPx !== '')).toMatchObject({ posSide: 'short', side: 'buy', sz: '4', slTriggerPx: String(m + 2300) });

    const tps = data(await api<PlaceTakeProfitsResult>('POST', '/api/positions/take-profits', { instId: BTC, mgnMode: 'cross', posSide: 'long', takeProfits: [{ triggerPx: String(m + 700), fraction: '0.5' }, { triggerPx: String(m + 900), fraction: '0.5' }] }));
    expect(tps).toMatchObject({ posSide: 'long', legs: [{ sz: '3' }, { sz: '3' }] });
    // closing the long leg: in long/short mode its take-profits stay at the exchange; the server cancels them
    await flat('long');
    await waitFor(() => !ctx.mock.getState().stops.some((s) => s.posSide === 'long'), 8000, 'the take-profits of the closed leg cancelled');
    expect(ctx.mock.getState().stops.filter((s) => s.posSide === 'short')).toHaveLength(2);
    await flat('short');
    await waitFor(() => ctx.mock.getState().stops.length === 0, 8000, 'everything of the short cancelled');
    await ctx.deps.trailing?.tick();
    expect(data(await api<TrailingView>('GET', '/api/trailing')).entries).toEqual([]);
  });

  it('take-profits on a closing order are refused', async () => {
    await flat('long');
    data(await api('POST', '/api/orders', { instId: BTC, side: 'buy', posSide: 'long', ordType: 'market', size: { unit: 'contracts', value: '1' } }));
    await waitFor(() => position('long'), 5000, 'long');
    const m = mark();
    const closing = await api<unknown>('POST', '/api/orders', { instId: BTC, side: 'sell', posSide: 'long', ordType: 'market', size: { unit: 'contracts', value: '1' }, takeProfits: [{ triggerPx: String(m - 500), fraction: '1' }] });
    expect(closing.status).toBe(400);
    if (!closing.body.ok) expect(closing.body.error.code).toBe('VALIDATION');
    expect(D(position('long')?.pos ?? '0').eq(1)).toBe(true);
    await flat('long');
  });
});
