/**
 * End-to-end: the campaign's order operations (services/campaign-orders.ts) on an API that runs in paper mode
 * against the in-process mock exchange, which stands in for both OKX's market data and the paper exchange. Covers
 * the open (leverage set to the highest, the buy, the margin topped up), the margin-neutral add and its refusal at
 * the exchange's cap, the partial and the full close in net and in long/short mode, a margin top-up that keeps
 * failing, the kill switch, and liquidations reaching the terminal with their category.
 */
import { once } from 'node:events';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { pino } from 'pino';
import WebSocket from 'ws';
import { startMockOkx, type MockOkxHandle } from '@pegasus/mock-okx';
import { OkxApiError, OkxTransportError, type OkxLeverageInfo, type OkxMarginBalanceParams } from '@pegasus/okx';
import { D, Decimal, decodeServerMessage, isLiquidationOrder, type Fill, type Order, type Position, type ServerMessage, type SignalsResponse } from '@pegasus/shared';
import type { FastifyInstance } from 'fastify';
import { loadConfig, type AppConfig } from '../src/config.js';
import { MemoryStore } from '../src/db/store.js';
import type { Deps } from '../src/deps.js';
import { createOkxClients, syncClock } from '../src/okx/clients.js';
import { buildServer } from '../src/server.js';
import { AccountService } from '../src/services/account.js';
import { CAMPAIGN_CL_ORD_PREFIX, CampaignOrders } from '../src/services/campaign-orders.js';
import { MarketDataService } from '../src/services/market-data.js';
import { OrderService } from '../src/services/order-service.js';
import { RiskEngine } from '../src/services/risk-engine.js';
import { SignalsService } from '../src/services/signals.js';
import { Hub } from '../src/ws/hub.js';

const TOKEN = 'test-token';
const BTC = 'BTC-USDT-SWAP';
const ETH = 'ETH-USDT-SWAP';
const log = pino({ level: process.env['E2E_LOG'] ?? 'silent' });

interface Stack {
  mock: MockOkxHandle;
  deps: Deps;
  campaign: CampaignOrders;
  store: MemoryStore;
  app: FastifyInstance;
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

const settle = <T>(p: Promise<T>): Promise<T | { code: string; status: number; message: string; details?: Record<string, unknown> }> => p.catch((e: { code: string; status: number; message: string }) => e);

/** The API in paper mode on a mock exchange that stands still (volatility 0), so that its prices only move when a test moves them. */
async function startStack(posMode: 'net_mode' | 'long_short_mode'): Promise<Stack> {
  const mock = await startMockOkx({ port: 0, seed: 7, tickIntervalMs: 50, volatility: 0, posMode, initialPrices: { [BTC]: '60000', [ETH]: '3000' }, initialBalanceUsdt: '1000' });
  const config: AppConfig = loadConfig({
    // the mock is the paper exchange too: the campaign may only run in paper mode
    PAPER_EXCHANGE_URL: mock.restUrl,
    OKX_REST_URL: mock.restUrl,
    OKX_WS_PUBLIC_URL: mock.wsPublicUrl,
    OKX_WS_PRIVATE_URL: mock.wsPrivateUrl,
    OKX_WS_BUSINESS_URL: mock.wsBusinessUrl,
    API_TOKEN: TOKEN,
    INSTRUMENTS: BTC,
    CAMPAIGN_ENABLED: '1',
    CAMPAIGN_INSTRUMENTS: `${BTC},${ETH}`,
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
  const campaign = new CampaignOrders(clients, market, account, orders, risk, store, log, { leverage: config.campaign.leverage, feeRate: config.campaign.feeRate, paper: config.okx.paper, retryDelaysMs: [10, 10], pollMs: 20, pollAttempts: 50 });
  const deps: Deps = { config, log, clients, store, market, account, risk, orders, signals, hub, campaignOrders: campaign };
  account.on('balance', (b) => risk.updateEquity(b.totalEq));
  hub.wire();
  const app = await buildServer(deps);
  await market.start();
  await account.start();
  await app.listen({ host: '127.0.0.1', port: 0 });
  await waitFor(() => market.book(BTC) && market.book(ETH) && market.liveMarkPrice(ETH) && account.ready && account.balance, 10_000, 'market data + paper account stream');
  return { mock, deps, campaign, store, app };
}

async function stopStack(s: Stack): Promise<void> {
  await s.deps.hub.close();
  await s.app.close();
  await s.deps.market.stop();
  await s.deps.account.stop();
  await s.mock.close();
}

/** The available USDT of the account, read from the exchange. */
async function available(s: Stack): Promise<string> {
  const detail = (await s.deps.clients.rest.getBalance('USDT')).details.find((d) => d.ccy === 'USDT');
  return detail?.availEq ?? '';
}

async function isolatedLever(s: Stack, instId: string): Promise<Array<[string, string]>> {
  return (await s.deps.clients.rest.getLeverageInfo(instId, 'isolated')).map((l: OkxLeverageInfo) => [l.posSide, l.lever]);
}

/** Moves the mid (and with it the book and the mark) and waits until the API's own market data has it. */
async function moveTo(s: Stack, instId: string, mid: string, tick: string): Promise<void> {
  s.mock.setPrice(instId, mid);
  await waitFor(() => s.deps.market.liveMarkPrice(instId) === mid && s.deps.market.bestPrice(instId, 'buy') === D(mid).plus(tick).toFixed(), 5000, `${instId} at ${mid}`);
}

describe('campaign orders in net mode', () => {
  let s: Stack;
  beforeAll(async () => {
    s = await startStack('net_mode');
  }, 30_000);
  afterAll(async () => {
    await stopStack(s);
  });

  it('runs on the paper exchange with its instruments tracked; outside paper trading every operation is refused', async () => {
    expect(s.deps.config.okx.paper).toBe(true);
    expect(s.deps.hub.hello().instruments.map((i) => i.instId)).toEqual([BTC, ETH]);
    // the signals stay the terminal's own instruments (INSTRUMENTS), not the campaign's tracked beside them, which are asked for by name
    const headers = { authorization: `Bearer ${TOKEN}` };
    const signals = await s.app.inject({ method: 'GET', url: '/api/signals?phase=0', headers });
    expect(signals.statusCode).toBe(200);
    expect((signals.json() as { data: SignalsResponse }).data.reports.map((r) => r.instId)).toEqual([BTC]);
    const eth = await s.app.inject({ method: 'GET', url: `/api/signals?phase=0&instId=${ETH}`, headers });
    expect((eth.json() as { data: SignalsResponse }).data.reports.map((r) => r.instId)).toEqual([ETH]);
    const elsewhere = new CampaignOrders(s.deps.clients, s.deps.market, s.deps.account, s.deps.orders, s.deps.risk, s.store, log, { leverage: '10', feeRate: '0.0005', paper: false });
    expect(await settle(elsewhere.openLong({ instId: BTC, contracts: '1', margin: '60' }))).toMatchObject({ code: 'CAMPAIGN_PAPER_ONLY', status: 403 });
    expect(s.mock.getState().orders).toEqual([]);
  });

  it('refuses an entry the risk engine refuses before anything is sent: neither the leverage nor an order', async () => {
    // 0.2 ETH (about 600) on a margin of 50 would run at 12x
    const refused = await settle(s.campaign.openLong({ instId: ETH, contracts: '2', margin: '50' }));
    expect(refused).toMatchObject({ code: 'RISK_REJECTED', status: 422, details: { code: 'MAX_LEVERAGE', details: { limit: '10.1', equity: '50', setting: '10' } } });
    // more than the balance has: a position that could not be topped up is never bought
    expect(await settle(s.campaign.openLong({ instId: ETH, contracts: '2', margin: '2000' }))).toMatchObject({ code: 'CAMPAIGN_INSUFFICIENT_BALANCE', status: 409 });
    expect(await isolatedLever(s, ETH)).toEqual([['net', '10']]);
    expect(s.mock.getState().orders).toEqual([]);
  });

  it('a: opens an isolated long whose margin ends at M while the leverage set is the highest', async () => {
    const before = D(await available(s));
    const opened = await s.campaign.openLong({ instId: BTC, contracts: '1', margin: '60' });
    expect(opened.fill).toMatchObject({ contracts: '1', avgPx: '60000.1' });
    expect(opened.fill.clOrdId.startsWith(CAMPAIGN_CL_ORD_PREFIX)).toBe(true);
    expect(D(opened.fill.fee).lt(0)).toBe(true);
    expect(opened.position).toMatchObject({ instId: BTC, mgnMode: 'isolated', posSide: 'net', pos: '1', avgPx: '60000.1', lever: '100', margin: '60' });
    // the leverage it runs at is the campaign's, the one set is the instrument's highest
    expect(D(opened.position.notionalUsd).div(opened.position.margin).toDecimalPlaces(4).toFixed()).toBe('10');
    expect(await isolatedLever(s, BTC)).toEqual([['net', '100']]);
    // about 9.6% below the entry, like a 10x position
    expect(D(opened.position.liqPx).div(opened.position.avgPx).toNumber()).toBeCloseTo(0.9 / 0.9955, 3);
    // the balance paid the margin and the fee, nothing else
    expect(before.minus(await available(s)).toFixed()).toBe(D(60).minus(opened.fill.fee).toFixed());
    expect(s.mock.getState().positions).toMatchObject([{ instId: BTC, mgnMode: 'isolated', pos: '1', margin: '60', lever: '100' }]);
    // the mirror and the terminals have it too, with what it is liquidated by
    const mirrored = await waitFor(() => s.deps.account.positionList().find((p) => p.instId === BTC && p.margin === '60'), 5000, 'position in the mirror');
    expect(mirrored).toMatchObject({ mgnMode: 'isolated', liqPx: opened.position.liqPx });
    expect(mirrored.mgnRatio).toBeDefined();
    expect(mirrored.mmr).toBeDefined();

    // one campaign per instrument
    expect(await settle(s.campaign.openLong({ instId: BTC, contracts: '1', margin: '60' }))).toMatchObject({ code: 'CAMPAIGN_POSITION_EXISTS', status: 409 });
  });

  it('b: adds out of the position margin: the position pays the fee, the balance outside it is where it was', async () => {
    await moveTo(s, BTC, '63000', '0.1');
    const before = await available(s);
    const added = await s.campaign.addLong({ instId: BTC, contracts: '0.4' });
    expect(added.marginBefore).toBe('60');
    expect(added.fill).toMatchObject({ contracts: '0.4', avgPx: '63000.1' });
    expect(added.position).toMatchObject({ pos: '1.4', lever: '100', margin: D(60).plus(added.fill.fee).toFixed() });
    expect(await available(s)).toBe(before);
    // what went in and out of the margin, as the exchange booked it: out first, then back
    const moves = s.store.riskEvents.filter((e) => e.type === 'MARGIN_MOVED' && e.detail['instId'] === BTC).map((e) => e.detail['type']);
    expect(moves.slice(-2)).toEqual(['reduce', 'add']);
  });

  it('the kill switch halts an add before any margin moves, and lets a reduction through', async () => {
    s.deps.risk.setKillSwitch(true, 'test');
    try {
      const margin = s.mock.getState().positions.find((p) => p.instId === BTC)?.margin;
      const orders = s.mock.getState().orders.length;
      expect(await settle(s.campaign.addLong({ instId: BTC, contracts: '0.1' }))).toMatchObject({ code: 'RISK_REJECTED', details: { code: 'KILL_SWITCH' } });
      expect(s.mock.getState().positions.find((p) => p.instId === BTC)?.margin).toBe(margin);
      expect(s.mock.getState().orders).toHaveLength(orders);

      // c: a partial close, reduce-only in net mode
      const reduced = await s.campaign.reduceLong({ instId: BTC, contracts: '0.4' });
      expect(reduced.fill).toMatchObject({ contracts: '0.4', avgPx: '63000' });
      expect(D(reduced.fill.pnl).gt(0)).toBe(true);
      expect(reduced.position).toMatchObject({ pos: '1' });
      expect(s.mock.getState().orders.find((o) => o.ordId === reduced.fill.ordId)).toMatchObject({ side: 'sell', posSide: 'net', tdMode: 'isolated', reduceOnly: 'true' });
    } finally {
      s.deps.risk.setKillSwitch(false, '');
    }
  });

  it('c: closes the whole position; more than it holds is refused', async () => {
    expect(await settle(s.campaign.reduceLong({ instId: BTC, contracts: '1.1' }))).toMatchObject({ code: 'VALIDATION' });
    const closed = await s.campaign.closeLong({ instId: BTC });
    expect(closed.fill).toMatchObject({ contracts: '1' });
    expect(closed.position).toBeNull();
    expect(s.mock.getState().positions.filter((p) => p.instId === BTC)).toEqual([]);
    expect(s.mock.getState().orders.find((o) => o.ordId === closed.fill.ordId)).toMatchObject({ side: 'sell', reduceOnly: 'true' });
    expect(await settle(s.campaign.closeLong({ instId: BTC }))).toMatchObject({ code: 'CAMPAIGN_NO_POSITION' });
  });

  it('b: refuses an add beyond what the margin can spare at the leverage set, before anything moves', async () => {
    const opened = await s.campaign.openLong({ instId: ETH, contracts: '2', margin: '60' });
    expect(opened.position).toMatchObject({ pos: '2', lever: '75', margin: '60' });
    await moveTo(s, ETH, '6000', '0.01');
    // doubled: 1,200 held on 60 of margin, which can spare 60 - 1,200 / 75 = 44. Six contracts more (3,600) would
    // need 48 and the fee; the risk rule allows them (the open profit carries them), the exchange would not.
    const orders = s.mock.getState().orders.length;
    const capped = await settle(s.campaign.addLong({ instId: ETH, contracts: '6' }));
    expect(capped).toMatchObject({ code: 'CAMPAIGN_ADD_CAP', status: 409, details: { spare: '44' } });
    expect(s.mock.getState().orders).toHaveLength(orders);
    expect(s.mock.getState().positions.find((p) => p.instId === ETH)).toMatchObject({ pos: '2', margin: '60' });
    // five fit
    const added = await s.campaign.addLong({ instId: ETH, contracts: '5' });
    expect(added.position).toMatchObject({ pos: '7', margin: D(60).plus(added.fill.fee).toFixed() });
  });

  it('b: an add the exchange refuses after the margin was taken out gets the margin back where it was', async () => {
    const before = s.mock.getState().positions.find((p) => p.instId === ETH);
    const avail = await available(s);
    const refused = vi.spyOn(s.deps.clients.rest, 'placeOrder').mockRejectedValueOnce(new OkxApiError('51008', 'Order failed. Insufficient USDT margin in account.', '/api/v5/trade/order'));
    try {
      expect(await settle(s.campaign.addLong({ instId: ETH, contracts: '0.1' }))).toMatchObject({ code: 'EXCHANGE', details: { okxCode: '51008' } });
    } finally {
      refused.mockRestore();
    }
    expect(s.mock.getState().positions.find((p) => p.instId === ETH)).toMatchObject({ pos: before?.pos, margin: before?.margin });
    expect(await available(s)).toBe(avail);
    const moves = s.store.riskEvents.filter((e) => e.type === 'MARGIN_MOVED' && e.detail['instId'] === ETH).slice(-2);
    expect(moves.map((e) => e.detail['type'])).toEqual(['reduce', 'add']);
    expect(moves[0]?.detail['amt']).toBe(moves[1]?.detail['amt']);
  });

  it('a liquidation reaches the terminal as an order of category full_liquidation with its fill; a second one of the instrument is a fill of its own', async () => {
    const addr = s.app.server.address();
    const ws = new WebSocket(`ws://127.0.0.1:${typeof addr === 'object' && addr ? addr.port : 0}/ws?token=${TOKEN}`);
    const received: ServerMessage[] = [];
    ws.on('message', (raw) => received.push(decodeServerMessage(raw.toString())));
    await once(ws, 'open');
    await waitFor(() => received.find((m) => m.type === 'hello'), 5000, 'hello');
    const liquidations = (): Order[] => received.flatMap((m) => (m.type === 'order' && m.data.instId === ETH && isLiquidationOrder(m.data) ? [m.data] : []));
    const fills = (): Fill[] => received.flatMap((m) => (m.type === 'fill' && m.data.instId === ETH && m.data.tradeId === '0' ? [m.data] : []));
    try {
      const held = s.mock.getState().positions.find((p) => p.instId === ETH);
      if (!held) throw new Error('no ETH position');
      // the mark one cent below the liquidation price; the last price stays where it was
      s.mock.setMarkPrice(ETH, D(held.liqPx).minus('0.01').toDecimalPlaces(2, Decimal.ROUND_FLOOR).toFixed(2));
      const first = await waitFor(() => liquidations().find((o) => o.state === 'filled'), 5000, 'the liquidation order');
      expect(first).toMatchObject({ instId: ETH, tdMode: 'isolated', side: 'sell', clOrdId: '', category: 'full_liquidation', sz: '7', accFillSz: '7' });
      await waitFor(() => fills().length === 1, 5000, 'the liquidation fill');
      expect(fills()[0]).toMatchObject({ ordId: first.ordId, fillSz: '7' });
      await waitFor(() => received.some((m) => m.type === 'positions' && !m.data.some((p: Position) => p.instId === ETH)), 5000, 'positions without ETH');
      expect(s.deps.account.positionList().some((p) => p.instId === ETH)).toBe(false);

      // the mark follows the market again; a new campaign on the instrument is liquidated as well
      s.mock.setMarkPrice(ETH, null);
      await moveTo(s, ETH, '3000', '0.01');
      const again = await s.campaign.openLong({ instId: ETH, contracts: '2', margin: '60' });
      s.mock.setMarkPrice(ETH, D(again.position.liqPx).minus('0.01').toDecimalPlaces(2, Decimal.ROUND_FLOOR).toFixed(2));
      await waitFor(() => fills().length === 2, 5000, 'the second liquidation fill');
      const [one, two] = fills();
      expect(one?.ordId).not.toBe(two?.ordId);
      expect(liquidations().filter((o) => o.state === 'filled')).toHaveLength(2);
      // both journaled, although both carry trade id 0
      const journaled = (await s.store.listFills({ instId: ETH, limit: 50 })).filter((f) => f.tradeId === '0');
      expect(journaled.map((f) => f.ordId).sort()).toEqual([one?.ordId, two?.ordId].sort());
    } finally {
      ws.close();
      s.mock.setMarkPrice(ETH, null);
    }
  }, 20_000);

  it('a: a margin top-up that keeps failing is retried, then the position is closed and the open fails, saying so', async () => {
    const refusal = new OkxApiError('50001', 'Service temporarily unavailable', '/api/v5/account/position/margin-balance');
    const spy = vi.spyOn(s.deps.clients.rest, 'adjustMargin').mockRejectedValue(refusal);
    try {
      // BTC is at 63,000 since the add: one contract is 630
      const failed = await settle(s.campaign.openLong({ instId: BTC, contracts: '1', margin: '63' }));
      expect(failed).toMatchObject({ code: 'CAMPAIGN_MARGIN_FAILED', status: 502, details: { instId: BTC, margin: '63', closed: true } });
      // one attempt and two retries, every one an add of what the position lacked
      expect(spy).toHaveBeenCalledTimes(3);
      for (const [params] of spy.mock.calls) expect(params).toMatchObject({ instId: BTC, posSide: 'net', type: 'add' } satisfies Partial<OkxMarginBalanceParams>);
      expect(s.mock.getState().positions.filter((p) => p.instId === BTC)).toEqual([]);
      expect(s.store.riskEvents.some((e) => e.type === 'CAMPAIGN_MARGIN_FAILED' && e.detail['closed'] === true)).toBe(true);
    } finally {
      spy.mockRestore();
    }
  });

  it('a: a buy whose answer is lost but that went through still gets its margin, and the open says it was not confirmed', async () => {
    const rest = s.deps.clients.rest;
    const placeOrder = rest.placeOrder.bind(rest);
    const sent = vi.spyOn(rest, 'placeOrder').mockImplementation(async (params) => {
      await placeOrder(params);
      throw new OkxTransportError('/api/v5/trade/order', 'OKX did not answer within 10000 ms', true);
    });
    const lookups = vi.spyOn(rest, 'getOrder').mockRejectedValue(new OkxTransportError('/api/v5/trade/order', 'could not reach OKX (ECONNRESET)', false));
    try {
      const unconfirmed = await settle(s.campaign.openLong({ instId: BTC, contracts: '1', margin: '63' }));
      expect(unconfirmed).toMatchObject({ code: 'CAMPAIGN_OPEN_UNCONFIRMED', status: 504, details: { pos: '1', margin: '63' } });
      expect(sent).toHaveBeenCalledTimes(1);
      expect(s.mock.getState().positions.find((p) => p.instId === BTC)).toMatchObject({ pos: '1', margin: '63', lever: '100' });
    } finally {
      sent.mockRestore();
      lookups.mockRestore();
    }
    expect((await s.campaign.closeLong({ instId: BTC })).position).toBeNull();
  }, 15_000);
});

describe('campaign orders in long/short mode', () => {
  let s: Stack;
  beforeAll(async () => {
    s = await startStack('long_short_mode');
  }, 30_000);
  afterAll(async () => {
    await stopStack(s);
  });

  it('sets the leverage of the long side only, moves the margin of the long position and reduces with posSide long, never reduceOnly', async () => {
    const moved = vi.spyOn(s.deps.clients.rest, 'adjustMargin');
    try {
      const opened = await s.campaign.openLong({ instId: BTC, contracts: '1', margin: '60' });
      expect(opened.position).toMatchObject({ posSide: 'long', pos: '1', lever: '100', margin: '60' });
      expect(await isolatedLever(s, BTC)).toEqual([['long', '100'], ['short', '10']]);
      expect(moved.mock.calls.map(([params]) => params.posSide)).toEqual(['long']);
      expect(s.mock.getState().orders.find((o) => o.ordId === opened.fill.ordId)).toMatchObject({ side: 'buy', posSide: 'long', tdMode: 'isolated' });

      const reduced = await s.campaign.reduceLong({ instId: BTC, contracts: '0.5' });
      expect(reduced.position).toMatchObject({ posSide: 'long', pos: '0.5' });
      expect(s.mock.getState().orders.find((o) => o.ordId === reduced.fill.ordId)).toMatchObject({ side: 'sell', posSide: 'long', reduceOnly: 'false' });
      const closed = await s.campaign.closeLong({ instId: BTC });
      expect(closed.position).toBeNull();
      expect(s.mock.getState().orders.find((o) => o.ordId === closed.fill.ordId)).toMatchObject({ side: 'sell', posSide: 'long', reduceOnly: 'false' });
      expect(s.mock.getState().positions).toEqual([]);
    } finally {
      moved.mockRestore();
    }
  });
});
