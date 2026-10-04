/**
 * End-to-end: paper trading. The API takes its market data from "OKX" (here the mock exchange stands in for it)
 * and its account from the paper exchange. Nothing private may reach the market-data side.
 */
import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { pino } from 'pino';
import { startMockOkx, type MockOkxHandle } from '@pegasus/mock-okx';
import { startExchangeServer, type ExchangeServerHandle, type OkxInstrument } from '@pegasus/mock-okx/engine';
import { PaperExchange, type BarSource, type FundingSource } from '@pegasus/paper';
import { D, type AlgoOrderList, type ApiResponse, type Order } from '@pegasus/shared';
import type { FastifyInstance, InjectOptions } from 'fastify';
import { loadConfig } from '../src/config.js';
import { MemoryStore } from '../src/db/store.js';
import type { Deps } from '../src/deps.js';
import { createOkxClients, syncClock } from '../src/okx/clients.js';
import { buildServer } from '../src/server.js';
import { AccountService } from '../src/services/account.js';
import { MarketDataService } from '../src/services/market-data.js';
import { OrderService } from '../src/services/order-service.js';
import { RiskEngine } from '../src/services/risk-engine.js';
import { SignalsService } from '../src/services/signals.js';
import { Hub } from '../src/ws/hub.js';

const TOKEN = 'test-token';
const BTC = 'BTC-USDT-SWAP';
const log = pino({ level: process.env['E2E_LOG'] ?? 'silent' });

let okx: MockOkxHandle;
let paper: PaperExchange;
let paperServer: ExchangeServerHandle;
let stateFile: string;
let app: FastifyInstance;
let deps: Deps;

const noHistory: BarSource & FundingSource = {
  tradeBars: async () => [],
  markBars: async () => [],
  settlements: async () => [],
  markAt: async () => null,
};

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

/** Feeds the paper exchange a five-level book one tick apart around `mid`, with the mark and the last price on it. */
function quote(mid: number): void {
  const levels = (start: number, step: number): string[][] => Array.from({ length: 5 }, (_, i) => [(start + i * step).toFixed(1), '500', '0', '1']);
  paper.onBook(BTC, levels(mid - 0.1, -0.1), levels(mid + 0.1, 0.1));
  paper.onMark(BTC, mid.toFixed(1));
  paper.onLast(BTC, mid.toFixed(1));
}

beforeAll(async () => {
  // "OKX": only its public side is used. The price stands still so that both sides quote the same market.
  okx = await startMockOkx({ port: 0, seed: 42, tickIntervalMs: 50, volatility: 0, initialPrices: { [BTC]: '50000', 'ETH-USDT-SWAP': '3000' } });
  const specs = (await (await fetch(`${okx.restUrl}/api/v5/public/instruments?instType=SWAP`)).json()) as { data: OkxInstrument[] };
  stateFile = join(mkdtempSync(join(tmpdir(), 'pegasus-e2e-paper-')), 'paper-account.json');
  paper = new PaperExchange(
    { stateFile, initialBalance: '20000', posMode: 'net_mode', takerFeeRate: '0.0005', makerFeeRate: '0.0002', defaultLever: '3' },
    { instruments: specs.data.filter((i) => i.instId === BTC), bars: noHistory, funding: noHistory, log: () => {} },
  );
  await paper.catchUp();
  paperServer = await startExchangeServer(paper.engine, { onWrite: () => paper.save() });

  const config = loadConfig({
    PAPER_EXCHANGE_URL: paperServer.restUrl,
    // a key in .env must not matter
    OKX_API_KEY: 'live-key',
    OKX_API_SECRET: 'live-secret',
    OKX_API_PASSPHRASE: 'live-pass',
    OKX_REST_URL: okx.restUrl,
    OKX_WS_PUBLIC_URL: okx.wsPublicUrl,
    OKX_WS_PRIVATE_URL: okx.wsPrivateUrl,
    OKX_WS_BUSINESS_URL: okx.wsBusinessUrl,
    API_TOKEN: TOKEN,
    INSTRUMENTS: BTC,
    RISK_MAX_ORDER_NOTIONAL: '20000',
    RISK_MAX_POSITION_NOTIONAL_PER_INSTRUMENT: '30000',
    RISK_MAX_TOTAL_POSITION_NOTIONAL: '50000',
    RISK_MAX_LEVERAGE: '5',
    RISK_DAILY_LOSS_LIMIT: '5000',
  });
  const store = new MemoryStore();
  const clients = createOkxClients(config, log);
  await syncClock(clients, log);
  const market = new MarketDataService(clients, log, { bookDepth: 50, bookThrottleMs: 20 });
  await market.loadInstruments(config.instruments);
  const account = new AccountService(clients, store, log);
  const risk = new RiskEngine(config.risk, store, log);
  await risk.init();
  const orders = new OrderService(clients, market, account, risk, store, log, { defaultTdMode: config.defaultTdMode, wsTrading: config.okx.wsTrading });
  const signals = new SignalsService(clients, market, account, log);
  const hub = new Hub(config, market, account, risk, log);
  deps = { config, log, clients, store, market, account, risk, orders, signals, hub };
  account.on('balance', (b) => risk.updateEquity(b.totalEq));
  hub.wire();
  app = await buildServer(deps);
  await market.start();
  await account.start();
  await waitFor(() => market.book(BTC) && market.liveMarkPrice(BTC) && account.ready && account.balance, 10_000, 'market data + paper account stream');
}, 30_000);

afterAll(async () => {
  await deps.hub.close();
  await app.close();
  await deps.market.stop();
  await deps.account.stop();
  await paperServer.close();
  paper.close();
  await okx.close();
});

describe('api e2e in paper mode', () => {
  it('says that it is paper trading, and takes the balance from the paper account', async () => {
    expect(deps.hub.hello()).toMatchObject({ paper: true, demo: false, account: { posMode: 'net_mode', canTrade: true }, balance: { totalEq: '20000' } });
    const health = await app.inject({ method: 'GET', url: '/api/health' });
    expect(health.json()).toMatchObject({ ok: true, paper: true, demo: false });
    expect(deps.clients.wsPrivate?.isReady).toBe(true);
  });

  it('an entry with a stop is filled by the paper exchange on its quotes; the market-data side never sees an order', async () => {
    const mid = Number(deps.market.liveMarkPrice(BTC));
    quote(mid);
    const placed = data(await api<{ order: Order }>('POST', '/api/orders', { instId: BTC, side: 'buy', ordType: 'market', size: { unit: 'contracts', value: '20' }, slTriggerPx: String(mid - 1000) }));
    const position = await waitFor(() => deps.account.positionList().find((p) => p.instId === BTC), 5000, 'paper position');
    expect(position).toMatchObject({ pos: '20', lever: '3' });
    expect(D(position.avgPx).toNumber()).toBeCloseTo(mid + 0.1, 5); // the paper book's best ask
    const filled = await waitFor(() => deps.account.algoOrders?.orders.find((a) => a.instId === BTC), 5000, 'the stop');
    expect(filled).toMatchObject({ algoClOrdId: `sl${placed.order.clOrdId}`, side: 'sell', sz: '20', slTriggerPx: String(mid - 1000), slTriggerPxType: 'mark' });
    // the taker fee came out of the paper balance: 20 x 0.01 BTC x price x 0.0005
    await waitFor(() => deps.account.balance && D(deps.account.balance.totalEq).lt('20000'), 5000, 'fee in the balance');

    // nothing of this exists on the side the market data comes from
    expect(okx.getState().orders).toEqual([]);
    expect(okx.getState().positions).toEqual([]);
    expect(okx.getState().stops).toEqual([]);
    // and it is in the account file
    expect(JSON.parse(readFileSync(stateFile, 'utf8'))).toMatchObject({ version: 1, account: { positions: [{ instId: BTC, qty: '20' }] }, orders: { stops: [{ instId: BTC, sz: '20' }] } });
  });

  it('a position without a stop gets one from the terminal: the paper account has no other place to put it', async () => {
    const stop = deps.account.algoOrders?.orders.find((a) => a.instId === BTC);
    if (!stop) throw new Error('no stop');
    data(await api<unknown>('POST', '/api/algo-orders/cancel', { instId: BTC, algoId: stop.algoId }));
    expect(paper.engine.state().stops).toEqual([]);
    const mid = Number(deps.market.liveMarkPrice(BTC));
    const placed = data(await api<{ algoId: string; sz: string; slTriggerPx: string }>('POST', '/api/algo-orders', { instId: BTC, mgnMode: 'cross', slTriggerPx: String(mid - 1000) }));
    expect(placed).toMatchObject({ sz: '20', slTriggerPx: String(mid - 1000) });
    expect(paper.engine.state().stops).toMatchObject([{ algoId: placed.algoId, ordId: '', side: 'sell', sz: '20', slTriggerPxType: 'mark' }]);
    expect(deps.account.algoOrders?.orders).toMatchObject([{ algoId: placed.algoId, slTriggerPx: String(mid - 1000) }]);
    expect(okx.getState().stops).toEqual([]);
  });

  it('the stop is moved through the terminal and fires when the quoted mark reaches it', async () => {
    const mid = Number(deps.market.liveMarkPrice(BTC));
    const stop = deps.account.algoOrders?.orders.find((a) => a.instId === BTC);
    if (!stop) throw new Error('no stop');
    const moved = data(await api<{ slTriggerPx: string }>('POST', '/api/algo-orders/amend', { instId: BTC, algoId: stop.algoId, slTriggerPx: String(mid - 500) }));
    expect(moved.slTriggerPx).toBe(String(mid - 500));
    expect(data(await api<AlgoOrderList>('GET', '/api/algo-orders')).orders).toMatchObject([{ algoId: stop.algoId, slTriggerPx: String(mid - 500) }]);

    quote(mid - 499);
    expect(deps.account.positionList().some((p) => p.instId === BTC)).toBe(true);
    quote(mid - 500);
    await waitFor(() => !deps.account.positionList().some((p) => p.instId === BTC), 5000, 'position closed by the stop');
    await waitFor(() => deps.account.algoOrders?.orders.length === 0, 8000, 'stop gone from the list');
    // 20 x 0.01 BTC x about 500 lost, and two taker fees
    const equity = D(deps.account.balance?.totalEq ?? '0');
    expect(equity.lt('19900') && equity.gt('19880')).toBe(true);
    expect(okx.getState().orders).toEqual([]);
  }, 15_000);
});
