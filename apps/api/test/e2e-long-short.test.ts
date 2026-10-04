/**
 * End-to-end in long/short (hedge) position mode: the API server wired to a mock OKX
 * whose account keeps a separate long and short leg per instrument. Exercises opening
 * each leg, gross exposure, the kill switch (exits pass, opening orders do not) and
 * closing a position per leg.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { pino } from 'pino';
import { startMockOkx, type MockOkxHandle } from '@pegasus/mock-okx';
import { D, type ApiResponse, type Order, type OrderPreview, type Position } from '@pegasus/shared';
import type { FastifyInstance, InjectOptions } from 'fastify';
import { loadConfig } from '../src/config.js';
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
const BTC = 'BTC-USDT-SWAP';
const log = pino({ level: process.env['E2E_LOG'] ?? 'silent' });

let mock: MockOkxHandle;
let app: FastifyInstance;
let deps: Deps;

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

async function waitFor<T>(fn: () => T | undefined | null | false, timeoutMs: number, label: string): Promise<T> {
  const start = Date.now();
  for (;;) {
    const v = fn();
    if (v) return v;
    if (Date.now() - start > timeoutMs) throw new Error(`timeout waiting for ${label}`);
    await new Promise((r) => setTimeout(r, 25));
  }
}

const leg = (posSide: 'long' | 'short'): Position | undefined => deps.account.positionList().find((p) => p.instId === BTC && p.posSide === posSide);
/** 10 contracts = 0.1 BTC, about 5,000 USD */
const market = (side: 'buy' | 'sell', posSide: 'long' | 'short', contracts = '10') => ({ instId: BTC, side, posSide, ordType: 'market', size: { unit: 'contracts', value: contracts } });

beforeAll(async () => {
  mock = await startMockOkx({ port: 0, credentials: CREDS, posMode: 'long_short_mode', seed: 42, tickIntervalMs: 50, initialPrices: { [BTC]: '50000' }, initialBalanceUsdt: '100000' });
  const config = loadConfig({
    OKX_API_KEY: CREDS.apiKey,
    OKX_API_SECRET: CREDS.apiSecret,
    OKX_API_PASSPHRASE: CREDS.passphrase,
    OKX_DEMO: '1',
    OKX_REST_URL: mock.restUrl,
    OKX_WS_PUBLIC_URL: mock.wsPublicUrl,
    OKX_WS_PRIVATE_URL: mock.wsPrivateUrl,
    OKX_WS_BUSINESS_URL: mock.wsBusinessUrl,
    API_TOKEN: TOKEN,
    INSTRUMENTS: BTC,
    RISK_MAX_ORDER_NOTIONAL: '25000',
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
  const marketData = new MarketDataService(clients, log, { bookDepth: 50, bookThrottleMs: 20 });
  await marketData.loadInstruments(config.instruments);
  const account = new AccountService(clients, store, log);
  const risk = new RiskEngine(config.risk, store, log);
  await risk.init();
  const orders = new OrderService(clients, marketData, account, risk, store, log, { defaultTdMode: config.defaultTdMode, wsTrading: config.okx.wsTrading });
  const signals = new SignalsService(clients, marketData, account, log);
  const hub = new Hub(config, marketData, account, risk, log);
  deps = { config, log, clients, store, market: marketData, account, risk, orders, signals, hub };
  account.on('balance', (b) => risk.updateEquity(b.totalEq));
  account.on('positions', () => risk.updateExposure(account.openOrders.size, account.totalPositionNotional()));
  account.on('order', () => risk.updateExposure(account.openOrders.size, account.totalPositionNotional()));
  new KillSwitchSweeper(risk, account, orders, log).start();
  hub.wire();
  app = await buildServer(deps);
  await marketData.start();
  await account.start();
  await waitFor(() => marketData.book(BTC) && marketData.ticker(BTC) && account.ready && account.balance, 10_000, 'market data + private stream');
}, 30_000);

afterAll(async () => {
  await deps.hub.close();
  await app.close();
  await deps.market.stop();
  await deps.account.stop();
  await mock.close();
});

describe('api e2e in long/short position mode', () => {
  it('requires a position side and opens each leg separately', async () => {
    expect(deps.account.config).toMatchObject({ posMode: 'long_short_mode', canTrade: true });
    const missing = await api<unknown>('POST', '/api/orders/preview', { instId: BTC, side: 'buy', ordType: 'market', size: { unit: 'contracts', value: '10' } });
    expect(missing.status).toBe(400);
    if (!missing.body.ok) expect(missing.body.error.code).toBe('VALIDATION');

    const long = data(await api<{ order: Order }>('POST', '/api/orders', market('buy', 'long')));
    expect(long.order).toMatchObject({ posSide: 'long', side: 'buy', sz: '10' });
    await waitFor(() => leg('long'), 5000, 'long leg');
    const short = data(await api<{ order: Order }>('POST', '/api/orders', market('sell', 'short')));
    expect(short.order).toMatchObject({ posSide: 'short', side: 'sell' });
    await waitFor(() => leg('short'), 5000, 'short leg');

    // the two legs are two positions, not one netted to zero
    expect(D(leg('long')!.pos).eq(10)).toBe(true);
    expect(D(leg('short')!.pos).eq(10)).toBe(true);
    expect(mock.getState().orders.every((o) => o.posSide === 'long' || o.posSide === 'short')).toBe(true);
  });

  it('counts exposure gross across the two legs', async () => {
    // about 5,000 long + 5,000 short: netted it would be zero
    const gross = D(deps.account.totalPositionNotional());
    expect(gross.gt(9000) && gross.lt(11000)).toBe(true);
    await waitFor(() => D(deps.risk.state.totalPositionNotional).gt(9000), 5000, 'risk exposure');

    // 44 contracts are about 22,000: with the gross 10,000 that is over the per-instrument limit of 30,000
    const mark = deps.market.refPrice(BTC)!;
    const preview = data(await api<OrderPreview>('POST', '/api/orders/preview', { instId: BTC, side: 'buy', posSide: 'long', ordType: 'limit', px: mark, size: { unit: 'contracts', value: '44' } }));
    expect(preview.risk).toMatchObject({ ok: false, code: 'MAX_POSITION_NOTIONAL' });
    const current = D(String(preview.risk.details?.['current']));
    expect(current.gt(9000) && current.lt(11000)).toBe(true);
    // the same size closing the long leg only reduces exposure
    const exit = data(await api<OrderPreview>('POST', '/api/orders/preview', { instId: BTC, side: 'sell', posSide: 'long', ordType: 'limit', px: mark, size: { unit: 'contracts', value: '10' } }));
    expect(exit).toMatchObject({ lever: '', risk: { ok: true } });
  });

  it('under the kill switch an exit is accepted and an opening order is refused', async () => {
    data(await api<unknown>('POST', '/api/risk/kill-switch', { enabled: true, reason: 'test' }));
    try {
      for (const opening of [market('buy', 'long', '1'), market('sell', 'short', '1')]) {
        const refused = await api<unknown>('POST', '/api/orders', opening);
        expect(refused.status).toBe(422);
        if (!refused.body.ok) expect(refused.body.error.details?.['code']).toBe('KILL_SWITCH');
      }
      // sell part of the long leg, buy back part of the short leg
      data(await api<{ order: Order }>('POST', '/api/orders', market('sell', 'long', '4')));
      data(await api<{ order: Order }>('POST', '/api/orders', market('buy', 'short', '3')));
      await waitFor(() => D(leg('long')?.pos ?? '0').eq(6) && D(leg('short')?.pos ?? '0').eq(7), 5000, 'both legs reduced');
    } finally {
      data(await api<unknown>('POST', '/api/risk/kill-switch', { enabled: false }));
    }
  });

  it('closes a position per leg', async () => {
    const noSide = await api<unknown>('POST', '/api/positions/close', { instId: BTC, mgnMode: 'cross' });
    expect(noSide.status).toBe(400);
    if (!noSide.body.ok) expect(noSide.body.error.code).toBe('VALIDATION');

    expect(data(await api<{ posSide: string }>('POST', '/api/positions/close', { instId: BTC, mgnMode: 'cross', posSide: 'long' }))).toMatchObject({ instId: BTC, posSide: 'long' });
    await waitFor(() => !leg('long'), 5000, 'long leg closed');
    expect(D(leg('short')!.pos).eq(7)).toBe(true);

    data(await api<unknown>('POST', '/api/positions/close', { instId: BTC, mgnMode: 'cross', posSide: 'short' }));
    await waitFor(() => deps.account.positionList().length === 0, 5000, 'short leg closed');
    expect(mock.getState().positions.filter((p) => D(p.pos).gt(0))).toEqual([]);
  });
});
