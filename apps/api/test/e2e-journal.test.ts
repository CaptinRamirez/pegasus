/**
 * End-to-end: the trade journal and the per-coin campaign signals of the API, wired to the local mock OKX exchange.
 * A signal order with its plan, its stop placed and triggered, a liquidation, the trades closed while the journal was
 * not running, the `journal` WebSocket message, GET /api/journal and GET /api/campaign/signals.
 */
import { once } from 'node:events';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { pino } from 'pino';
import WebSocket from 'ws';
import { startMockOkx, type MockOkxHandle } from '@pegasus/mock-okx';
import { D, decodeServerMessage, type ApiResponse, type CampaignSignalsResponse, type JournalPage, type JournalTrade, type Order, type ServerMessage, type SignalSnapshot } from '@pegasus/shared';
import type { FastifyInstance, InjectOptions } from 'fastify';
import { loadConfig, type AppConfig } from '../src/config.js';
import { MemoryStore } from '../src/db/store.js';
import type { Deps } from '../src/deps.js';
import { createOkxClients, syncClock } from '../src/okx/clients.js';
import { buildServer } from '../src/server.js';
import { AccountService } from '../src/services/account.js';
import { JournalService } from '../src/services/journal.js';
import { MarketDataService } from '../src/services/market-data.js';
import { OrderService } from '../src/services/order-service.js';
import { RiskEngine } from '../src/services/risk-engine.js';
import { SignalsService } from '../src/services/signals.js';
import { Hub } from '../src/ws/hub.js';

const TOKEN = 'test-token';
const CREDS = { apiKey: 'k', apiSecret: 's', passphrase: 'p' };
const log = pino({ level: process.env['E2E_LOG'] ?? 'silent' });
const ETH = 'ETH-USDT-SWAP';
const BTC = 'BTC-USDT-SWAP';

let mock: MockOkxHandle;
let app: FastifyInstance;
let deps: Deps;
let baseUrl: string;
let journalFile: string;

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

async function waitFor<T>(fn: () => T | undefined | null | false | Promise<T | undefined | null | false>, timeoutMs = 8000, label = 'condition'): Promise<T> {
  const start = Date.now();
  for (;;) {
    const v = await fn();
    if (v) return v;
    if (Date.now() - start > timeoutMs) throw new Error(`timeout waiting for ${label}`);
    await new Promise((r) => setTimeout(r, 25));
  }
}

function newJournal(): JournalService {
  const journal = new JournalService({ clients: deps.clients, market: deps.market, account: deps.account, onPlaced: (listener) => deps.orders.onPlaced(listener), log }, { file: journalFile, checkEveryMs: 0, fundingEveryMs: 0, flushMs: 10 });
  journal.on('change', (update) => deps.hub.broadcast({ type: 'journal', data: update }));
  return journal;
}

async function trade(id: string): Promise<JournalTrade> {
  return data(await api<JournalTrade>('GET', `/api/journal/${id}`));
}

/** The journal's open trade on an instrument, once it is there. */
async function openTradeOn(instId: string): Promise<JournalTrade> {
  const page = await waitFor(async () => {
    const p = data(await api<JournalPage>('GET', `/api/journal?status=open&instId=${instId}`));
    return p.trades.length > 0 ? p : null;
  }, 8000, `the open trade on ${instId}`);
  return trade(page.trades[0]?.id ?? '');
}

beforeAll(async () => {
  mock = await startMockOkx({ port: 0, credentials: CREDS, seed: 7, tickIntervalMs: 50, initialPrices: { [BTC]: '50000', [ETH]: '3000' }, initialBalanceUsdt: '100000' });
  journalFile = join(mkdtempSync(join(tmpdir(), 'pegasus-e2e-journal-')), 'journal.json');
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
    INSTRUMENTS: `${BTC},${ETH}`,
    CAMPAIGN_INSTRUMENTS: `${BTC},${ETH}`,
    JOURNAL_FILE: journalFile,
    RISK_MAX_ORDER_NOTIONAL: '20000',
    RISK_MAX_POSITION_NOTIONAL_PER_INSTRUMENT: '30000',
    RISK_MAX_TOTAL_POSITION_NOTIONAL: '50000',
    RISK_MAX_LEVERAGE: '20',
    RISK_DAILY_LOSS_LIMIT: '100000',
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
  const orders = new OrderService(clients, market, account, risk, store, log, { defaultTdMode: config.defaultTdMode, wsTrading: config.okx.wsTrading });
  const signals = new SignalsService(clients, market, account, log);
  const hub = new Hub(config, market, account, risk, log);
  deps = { config, log, clients, store, market, account, risk, orders, signals, hub };
  deps.journal = newJournal();
  account.on('balance', (b) => risk.updateEquity(b.totalEq));
  account.on('positions', () => risk.updateExposure(account.openOrders.size, account.totalPositionNotional(), account.positionList(), (id) => deps.market.specOf(id)));
  hub.wire();
  app = await buildServer(deps);
  await market.start();
  await deps.journal.start();
  await account.start();
  await app.listen({ host: '127.0.0.1', port: 0 });
  const addr = app.server.address();
  baseUrl = typeof addr === 'object' && addr ? `127.0.0.1:${addr.port}` : '';
  await waitFor(() => market.book(BTC) && market.book(ETH) && market.liveMarkPrice(ETH) && account.ready && account.balance, 10_000, 'market data + private stream');
  await waitFor(() => deps.journal?.status.status === 'ready', 10_000, 'journal ready');
}, 30_000);

afterAll(async () => {
  await deps.journal?.stop();
  await deps.hub.close();
  await app.close();
  await deps.market.stop();
  await deps.account.stop();
  await mock.close();
});

describe('the trade journal against mock OKX', () => {
  it('records a signal order with its plan, its stop placed and triggered, and sends a journal message for it', async () => {
    const ws = new WebSocket(`ws://${baseUrl}/ws?token=${TOKEN}`);
    const received: ServerMessage[] = [];
    ws.on('message', (raw) => received.push(decodeServerMessage(raw.toString())));
    await once(ws, 'open');
    const mark = D(deps.market.liveMarkPrice(ETH) ?? '3000');
    const stop = mark.mul('0.97').toDecimalPlaces(2).toFixed();
    const signal: SignalSnapshot = { rule: 'campaign', kind: 'entry', barTs: Date.UTC(2026, 9, 4), close: mark.toFixed(), entryLevel: mark.mul('0.99').toDecimalPlaces(2).toFixed(), exitLevel: stop };
    try {
      const placed = data(await api<{ order: Order }>('POST', '/api/orders', { instId: ETH, side: 'buy', ordType: 'market', tdMode: 'isolated', size: { unit: 'contracts', value: '10' }, slTriggerPx: stop, source: 'signal', signal, clOrdId: 'psE2e0001' }));
      let t = await openTradeOn(ETH);
      expect(t).toMatchObject({ source: 'signal', direction: 'long', mgnMode: 'isolated', size: '10', initialStop: stop });
      expect(t.plan).toMatchObject({ slTriggerPx: stop, signal, takeProfits: [], trailing: null });
      expect(t.timeline[0]).toMatchObject({ kind: 'order_placed', ordId: placed.order.ordId, clOrdId: 'psE2e0001', source: 'signal' });
      expect(D(t.initialRisk ?? '0').gt(0)).toBe(true);
      // the stop the exchange created when the order filled
      t = await waitFor(async () => {
        const x = await trade(t.id);
        return x.timeline.some((e) => e.kind === 'stop_placed') ? x : null;
      }, 8000, 'stop_placed');
      expect(t.timeline.find((e) => e.kind === 'stop_placed')).toMatchObject({ px: stop });
      // the margin of the isolated position
      await waitFor(async () => (await trade(t.id)).entry.margin !== null, 8000, 'the entry margin');

      mock.setMarkPrice(ETH, D(stop).minus('1').toFixed());
      t = await waitFor(async () => {
        const x = await trade(t.id);
        return x.status === 'closed' ? x : null;
      }, 8000, 'the trade closed by its stop');
      expect(t).toMatchObject({ closeReason: 'stop', size: '0' });
      expect(t.exits).toHaveLength(1);
      expect(t.exits[0]).toMatchObject({ reason: 'stop', contracts: '10' });
      // the mock fills the stop's market order at its book, which the pinned mark does not move: the figures add up
      expect(D(t.realisedPnl).eq(t.exits[0]?.pnl ?? 'NaN')).toBe(true);
      expect(D(t.fees).gt(0)).toBe(true);
      expect(D(t.netPnl).eq(D(t.realisedPnl).minus(t.fees).plus(t.funding ?? '0'))).toBe(true);
      expect(t.rMultiple).not.toBeNull();
      expect(t.timeline.map((e) => e.kind)).toEqual(expect.arrayContaining(['order_placed', 'fill', 'stop_placed', 'stop_triggered']));
      // every change reached the terminals
      await waitFor(() => received.some((m) => m.type === 'journal' && m.data.trades.some((x) => x.id === t.id && x.status === 'closed')), 8000, 'the journal message');
    } finally {
      mock.setMarkPrice(ETH, null);
      ws.close();
    }
    await waitFor(() => D(deps.market.markPrice(ETH)?.markPx ?? '0').gt(2900), 8000, 'mark released');
  }, 30_000);

  it('records a liquidation', async () => {
    try {
      data(await api<{ order: Order }>('POST', '/api/orders', { instId: BTC, side: 'buy', ordType: 'market', tdMode: 'isolated', size: { unit: 'contracts', value: '1' } }));
      const open = await openTradeOn(BTC);
      expect(open).toMatchObject({ source: 'manual', plan: { slTriggerPx: null } });
      mock.setMarkPrice(BTC, '40000');
      const t = await waitFor(async () => {
        const x = await trade(open.id);
        return x.status === 'closed' ? x : null;
      }, 8000, 'the liquidation');
      expect(t).toMatchObject({ closeReason: 'liquidation' });
      expect(t.timeline.some((e) => e.kind === 'liquidation')).toBe(true);
      expect(D(t.realisedPnl).lt(0)).toBe(true);
    } finally {
      mock.setMarkPrice(BTC, null);
    }
    await waitFor(() => D(deps.market.markPrice(BTC)?.markPx ?? '0').gt(45000), 8000, 'mark released');
  }, 30_000);

  it('a trade closed while the journal was not running is closed by the next start, from the exchange fills', async () => {
    const mark = D(deps.market.liveMarkPrice(ETH) ?? '3000');
    const stop = mark.mul('0.97').toDecimalPlaces(2).toFixed();
    data(await api<{ order: Order }>('POST', '/api/orders', { instId: ETH, side: 'buy', ordType: 'market', tdMode: 'isolated', size: { unit: 'contracts', value: '5' }, slTriggerPx: stop }));
    const open = await openTradeOn(ETH);
    await waitFor(async () => (await trade(open.id)).timeline.some((e) => e.kind === 'stop_placed'), 8000, 'stop_placed');
    // the journal stops; the stop fires meanwhile
    await deps.journal?.stop();
    try {
      mock.setMarkPrice(ETH, D(stop).minus('1').toFixed());
      await waitFor(() => !deps.account.positionList().some((p) => p.instId === ETH), 8000, 'the position closed by its stop');
    } finally {
      mock.setMarkPrice(ETH, null);
    }
    deps.journal = newJournal();
    await deps.journal.start();
    await waitFor(() => deps.journal?.status.status === 'ready', 10_000, 'journal ready again');
    const t = await waitFor(async () => {
      const x = await trade(open.id);
      return x.status === 'closed' ? x : null;
    }, 8000, 'the trade closed from the exchange fills');
    expect(t).toMatchObject({ closeReason: 'stop', size: '0' });
    await waitFor(() => D(deps.market.markPrice(ETH)?.markPx ?? '0').gt(2900), 8000, 'mark released');
  }, 30_000);

  it('lists the trades newest first with filters and pages; one trade by id; an unknown id is 404', async () => {
    const all = data(await api<JournalPage>('GET', '/api/journal'));
    expect(all).toMatchObject({ status: 'ready', reason: null, total: 3, next: null });
    expect(all.trades.map((t) => t.seq)).toEqual([3, 2, 1]);
    expect(data(await api<JournalPage>('GET', '/api/journal?source=signal')).trades.map((t) => t.seq)).toEqual([1]);
    expect(data(await api<JournalPage>(`GET`, `/api/journal?instId=${BTC}&status=closed`)).trades.map((t) => t.closeReason)).toEqual(['liquidation']);
    const page = data(await api<JournalPage>('GET', '/api/journal?limit=2'));
    expect(page).toMatchObject({ next: 2 });
    expect(data(await api<JournalPage>('GET', '/api/journal?limit=2&before=2')).trades.map((t) => t.seq)).toEqual([1]);
    const missing = await api<unknown>('GET', '/api/journal/99-BTC-USDT-SWAP');
    expect(missing.status).toBe(404);
    if (!missing.body.ok) expect(missing.body.error.code).toBe('TRADE_NOT_FOUND');
    expect((await api<unknown>('GET', '/api/journal?status=gone')).status).toBe(400);
    // without the token
    expect((await app.inject({ method: 'GET', url: '/api/journal' })).statusCode).toBe(401);
  });

  it('reads the campaign rule per coin; a long held is holding with the add reference of the journal', async () => {
    const res = data(await api<CampaignSignalsResponse>('GET', '/api/campaign/signals'));
    expect(res.rows.map((r) => r.instId)).toEqual([BTC, ETH]);
    expect(res).toMatchObject({ riskPct: '0.01', equitySource: 'account', campaign: { enabled: false, ownAccount: false } });
    for (const row of res.rows) {
      expect(['entry', 'near', 'none']).toContain(row.state);
      expect(row.tracked).toBe(true);
      expect(row.levels.entry).not.toBeNull();
      expect(row.daily?.closeTs).toBe((row.daily?.barTs ?? 0) + 86_400_000);
      expect(row.markPx).not.toBeNull();
    }
    data(await api<{ order: Order }>('POST', '/api/orders', { instId: ETH, side: 'buy', ordType: 'market', tdMode: 'isolated', size: { unit: 'contracts', value: '3' } }));
    const open = await openTradeOn(ETH);
    const held = data(await api<CampaignSignalsResponse>('GET', '/api/campaign/signals?riskPct=0.02&equity=5000'));
    const eth = held.rows[1];
    expect(['holding', 'add', 'exit']).toContain(eth?.state);
    expect(eth?.holding).toMatchObject({ contracts: '3', addRefSource: 'journal', tradeId: open.id, addRef: open.entry.avgPx });
    expect(held).toMatchObject({ riskPct: '0.02', equity: '5000', equitySource: 'request' });
    expect((await api<unknown>('GET', '/api/campaign/signals?riskPct=2')).status).toBe(400);
    expect((await api<unknown>('GET', '/api/campaign/signals?equity=-5')).status).toBe(400);
  }, 20_000);
});
