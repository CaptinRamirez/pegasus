/**
 * End-to-end: the campaign service (services/campaign.ts) on an API that runs in paper mode against the in-process
 * mock exchange, which stands in for both OKX's market data and the paper exchange. The clock and the candles are the
 * test's; the orders, the positions and the balance are the exchange's. Covers a whole campaign (entry, add, harvest,
 * an add held by the kill switch, exit) with the ledger checked against the exchange's balance, a liquidation, a
 * restart that catches up a missed exit, the guard that wants a paper account of its own, an unreadable ledger, the
 * routes and the WebSocket push.
 */
import { once } from 'node:events';
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { pino } from 'pino';
import WebSocket from 'ws';
import { startMockOkx, type MockOkxHandle } from '@pegasus/mock-okx';
import { MemoryCache, type Fetchers } from '@pegasus/backtest/campaign';
import {
  D,
  Decimal,
  DEFAULT_CAMPAIGN_PARAMS,
  DEFAULT_POT_PARAMS,
  dailyBarsFromHalfDays,
  harvestContracts,
  keptAfterHarvest,
  sameCloseOrder,
  type CampaignLogPage,
  type CampaignParams,
  type CampaignRecord,
  type CampaignReplayView,
  type CampaignView,
  type Candle,
  type PotParams,
} from '@pegasus/shared';
import type { FastifyInstance } from 'fastify';
import { loadConfig, type AppConfig } from '../src/config.js';
import { MemoryStore } from '../src/db/store.js';
import type { Deps } from '../src/deps.js';
import { AppError, NotConnectedError, RiskRejectedError } from '../src/errors.js';
import { createOkxClients, syncClock } from '../src/okx/clients.js';
import { buildServer } from '../src/server.js';
import { AccountService } from '../src/services/account.js';
import { CampaignService, type CampaignCandleSource } from '../src/services/campaign.js';
import { CampaignOrders } from '../src/services/campaign-orders.js';
import { HALF_DAY_MS } from '../src/services/campaign-step.js';
import { MarketDataService } from '../src/services/market-data.js';
import { OrderService } from '../src/services/order-service.js';
import { RiskEngine } from '../src/services/risk-engine.js';
import { SignalsService } from '../src/services/signals.js';
import { Hub } from '../src/ws/hub.js';

const TOKEN = 'test-token';
const BTC = 'BTC-USDT-SWAP';
const ETH = 'ETH-USDT-SWAP';
const log = pino({ level: process.env['E2E_LOG'] ?? 'silent' });
const T0 = Date.UTC(2026, 0, 1);
const DAY = 86_400_000;
const day = (n: number): number => T0 + n * DAY;
/** Channels of 3 and 2 days keep the scenarios short; everything else is the approved rule. */
const SHORT: CampaignParams = { ...DEFAULT_CAMPAIGN_PARAMS, entryChannel: 3, exitChannel: 2 };

type Row = readonly [open: number, high: number, low: number, close: number];

/** The test's candles: confirmed 12-hour bars as the test adds them, the bar running after the last one opening at its close. */
class Bars implements CampaignCandleSource {
  private readonly rows = new Map<string, Candle[]>();

  /** Confirmed 12-hour bars of `instId` from `from` on. */
  add(instId: string, from: number, rows: readonly Row[]): void {
    const list = this.rows.get(instId) ?? [];
    rows.forEach(([open, high, low, close], i) => list.push({ ts: from + i * HALF_DAY_MS, open: String(open), high: String(high), low: String(low), close: String(close), vol: '0', volCcy: '0', confirm: true }));
    this.rows.set(instId, list);
  }

  async halfDay(instId: string): Promise<Candle[]> {
    const list = this.rows.get(instId) ?? [];
    const last = list[list.length - 1];
    if (!last) return [];
    return [...list, { ...last, ts: last.ts + HALF_DAY_MS, open: last.close, high: last.close, low: last.close, confirm: false }];
  }

  async daily(instId: string): Promise<Candle[]> {
    return dailyBarsFromHalfDays(this.rows.get(instId) ?? [], 0);
  }
}

/** n quiet 12-hour bars at `px`, half a percent either way. */
const flat = (px: number, n: number): Row[] => Array.from({ length: n }, () => [px, D(px).mul('1.005').toNumber(), D(px).mul('0.995').toNumber(), px] as const);

interface Stack {
  mock: MockOkxHandle;
  deps: Deps;
  config: AppConfig;
  orders: CampaignOrders;
  app: FastifyInstance;
  bars: Bars;
  clock: { now: number };
  ledgerFile: string;
  service: CampaignService;
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

/** The replay's data: the test's bars, the market's instruments, no funding history. */
function barsFetchers(bars: Bars, market: MarketDataService): Fetchers {
  return {
    instrument: async (instId) => market.requireInstrument(instId),
    candles: async (instId, bar, after) => {
      const rows = bar === '12Hutc' ? await bars.halfDay(instId) : await bars.daily(instId);
      return rows.filter((c) => c.confirm && (after === undefined || c.ts < after)).reverse();
    },
    openInterest: async () => [],
    funding: async () => [],
    fundingPageSize: Number.POSITIVE_INFINITY,
    latest: (instId) => bars.halfDay(instId),
  };
}

function newService(s: Pick<Stack, 'deps' | 'config' | 'orders' | 'bars' | 'clock' | 'ledgerFile'>, pot: PotParams, replay = false): CampaignService {
  const { deps } = s;
  return new CampaignService(s.config.campaign, { clients: deps.clients, market: deps.market, account: deps.account, risk: deps.risk, orders: s.orders, log }, {
    ...(replay ? { replay: { sources: { fetchers: barsFetchers(s.bars, deps.market), cache: new MemoryCache() } } } : {}),
    ledgerFile: s.ledgerFile,
    params: SHORT,
    pot,
    now: () => s.clock.now,
    // the test's clock goes on while the service waits
    sleep: async (ms) => {
      s.clock.now += ms;
      await new Promise((r) => setImmediate(r));
    },
    candles: s.bars,
    checkEveryMs: 0,
    pollMs: 1_000,
    retryDelaysMs: [1_000],
  });
}

/** The service is wired to the hub as index.ts does it. */
function wire(s: Stack, service: CampaignService): void {
  service.on('change', (view) => s.deps.hub.broadcast({ type: 'campaign', data: view }));
  s.deps.hub.setCampaignView(() => service.view());
  s.deps.campaign = service;
  s.service = service;
}

/** The API in paper mode on a mock exchange that stands still, with the campaign on BTC and ETH, the service started at `start`; with `replay`, the replay beside the pot on the test's bars. */
async function startStack(balance: string, pot: PotParams, start: number, replay = false): Promise<Stack> {
  const ledgerFile = join(mkdtempSync(join(tmpdir(), 'pegasus-campaign-')), 'ledger.json');
  const mock = await startMockOkx({ port: 0, seed: 7, tickIntervalMs: 50, volatility: 0, posMode: 'net_mode', initialPrices: { [BTC]: '60000', [ETH]: '3000' }, initialBalanceUsdt: balance });
  const config = loadConfig({
    PAPER_EXCHANGE_URL: mock.restUrl,
    OKX_REST_URL: mock.restUrl,
    OKX_WS_PUBLIC_URL: mock.wsPublicUrl,
    OKX_WS_PRIVATE_URL: mock.wsPrivateUrl,
    OKX_WS_BUSINESS_URL: mock.wsBusinessUrl,
    API_TOKEN: TOKEN,
    INSTRUMENTS: BTC,
    CAMPAIGN_ENABLED: '1',
    CAMPAIGN_INSTRUMENTS: `${BTC},${ETH}`,
    CAMPAIGN_STATE_FILE: ledgerFile,
  });
  const store = new MemoryStore();
  const clients = createOkxClients(config, log);
  await syncClock(clients, log);
  const market = new MarketDataService(clients, log, { bookDepth: 50, bookThrottleMs: 20 });
  await market.loadInstruments(config.instruments);
  const account = new AccountService(clients, store, log);
  const risk = new RiskEngine(config.risk, store, log);
  await risk.init();
  const orderService = new OrderService(clients, market, account, risk, store, log, { defaultTdMode: config.defaultTdMode, wsTrading: config.okx.wsTrading });
  const signals = new SignalsService(clients, market, account, log);
  const hub = new Hub(config, market, account, risk, log);
  const orders = new CampaignOrders(clients, market, account, orderService, risk, store, log, { leverage: config.campaign.leverage, feeRate: config.campaign.feeRate, paper: config.okx.paper, retryDelaysMs: [10, 10], pollMs: 20, pollAttempts: 50 });
  const deps: Deps = { config, log, clients, store, market, account, risk, orders: orderService, signals, hub, campaignOrders: orders };
  account.on('balance', (b) => risk.updateEquity(b.totalEq));
  hub.wire();
  const app = await buildServer(deps);
  await market.start();
  await account.start();
  await app.listen({ host: '127.0.0.1', port: 0 });
  await waitFor(() => market.book(BTC) && market.book(ETH) && market.liveMarkPrice(ETH) && account.ready && account.balance, 10_000, 'market data + paper account stream');
  const bars = new Bars();
  const partial = { mock, deps, config, orders, app, bars, clock: { now: start }, ledgerFile };
  const stack: Stack = { ...partial, service: newService(partial, pot, replay) };
  wire(stack, stack.service);
  return stack;
}

async function stopStack(s: Stack): Promise<void> {
  await s.service.replayIdle();
  await s.service.stop();
  await s.deps.hub.close();
  await s.app.close();
  await s.deps.market.stop();
  await s.deps.account.stop();
  await s.mock.close();
}

/** The available USDT of the account, read from the exchange. */
async function available(s: Stack): Promise<Decimal> {
  const detail = (await s.deps.clients.rest.getBalance('USDT')).details.find((d) => d.ccy === 'USDT');
  return D(detail?.availEq ?? '0');
}

/** Moves the mid (and with it the book and the mark) and waits until the API's own market data has it. */
async function moveTo(s: Stack, instId: string, mid: string): Promise<void> {
  const tick = instId === BTC ? '0.1' : '0.01';
  s.mock.setPrice(instId, mid);
  await waitFor(() => s.deps.market.liveMarkPrice(instId) === D(mid).toFixed() && s.deps.market.bestPrice(instId, 'buy') === D(mid).plus(tick).toFixed(), 5000, `${instId} at ${mid}`);
}

/** The close `closeTs` comes: the clock is a few seconds past it and the service looks. */
async function closeAt(s: Stack, closeTs: number): Promise<void> {
  s.clock.now = closeTs + 5_000;
  await s.service.tick();
}

const ledger = (s: Stack): ReturnType<CampaignService['ledgerCopy']> => s.service.ledgerCopy();
const only = (s: Stack, instId: string): CampaignRecord => {
  const found = ledger(s).campaigns.filter((c) => c.instId === instId);
  expect(found).toHaveLength(1);
  return found[0] as CampaignRecord;
};

async function getJson<T>(s: Stack, url: string): Promise<T> {
  const res = await s.app.inject({ method: 'GET', url, headers: { authorization: `Bearer ${TOKEN}` } });
  expect(res.statusCode).toBe(200);
  return (res.json() as { data: T }).data;
}

describe('a whole campaign on the paper exchange', () => {
  // A pot that stakes 90% and harvests at 1.8x its start, so that one campaign of the mock's BTC reaches a rung.
  const POT: PotParams = { ...DEFAULT_POT_PARAMS, stakeFraction: '0.9', rungFactor: '1.8' };
  let s: Stack;
  let ws: WebSocket;
  const pushed: CampaignView[] = [];
  let stake: Decimal;

  beforeAll(async () => {
    s = await startStack('56', POT, day(4) + 3_600_000, true);
    // four quiet days of history
    s.bars.add(BTC, day(0), flat(60000, 8));
    s.bars.add(ETH, day(0), flat(3000, 14));
    await s.service.start();
  }, 30_000);
  afterAll(async () => {
    ws?.close();
    await stopStack(s);
  });

  it('starts the pot on an account of its own: its value, the BTC mark, the close after which it looks', async () => {
    const view = s.service.view();
    expect(view).toMatchObject({ status: 'running', reason: null, errorCount: 0, nextStep: { closeTs: day(4) + HALF_DAY_MS, daily: false } });
    expect(view.pot).toMatchObject({ startedAt: day(4) + 3_600_000, startValue: '56', btcMarkAtStart: '60000', structure: 'pyramid', start: '56', minStake: '5.6', banked: '0', rungs: 0, nextRung: '100.8' });
    expect(ledger(s).lastClose).toBe(day(4));
    expect(existsSync(s.ledgerFile)).toBe(true);
    // the terminal gets the state right after hello
    const addr = s.app.server.address();
    ws = new WebSocket(`ws://127.0.0.1:${typeof addr === 'object' && addr ? addr.port : 0}/ws?token=${TOKEN}`);
    ws.on('message', (raw) => {
      const msg = JSON.parse(raw.toString()) as { type: string; data: unknown };
      if (msg.type === 'campaign') pushed.push(msg.data as CampaignView);
    });
    await once(ws, 'open');
    await waitFor(() => pushed.length > 0, 5000, 'the campaign state after hello');
    expect(pushed[0]?.status).toBe('running');
  });

  it('a noon close decides nothing without a campaign: no entry is read at 12:00', async () => {
    s.bars.add(BTC, day(4), [[60000, 60300, 59800, 60100]]);
    await moveTo(s, BTC, '60100');
    await closeAt(s, day(4) + HALF_DAY_MS);
    const l = ledger(s);
    expect(l.campaigns).toEqual([]);
    expect(l.lastClose).toBe(day(4) + HALF_DAY_MS);
    expect(l.samples).toEqual([{ ts: day(4) + HALF_DAY_MS, freeCash: '56', openEquity: '0', banked: '0', value: '56', open: 0 }]);
    expect(l.steps.at(-1)).toMatchObject({ kind: 'close', closeTs: day(4) + HALF_DAY_MS, actions: [], errors: 0 });
  });

  it('enters at the daily close above the 3-day high, staking campaignStake of the free cash, measured from the balance', async () => {
    s.bars.add(BTC, day(4) + HALF_DAY_MS, [[60100, 61500, 60000, 61000]]);
    await moveTo(s, BTC, '61000');
    const pushes = pushed.length;
    await closeAt(s, day(5));
    const c = only(s, BTC);
    const after = await available(s);
    stake = D(56).minus(after);
    // 90% of 56 is 50.4: 0.82 contracts at 61000, 0.8 in whole lots
    expect(c).toMatchObject({ id: `${BTC}@${day(5)}`, signalTs: day(4), addRef: '61000', addUnit: '0.008', stake: stake.toFixed(), basis: stake.toFixed(), end: null, pendingExit: null });
    expect(c.entry).toMatchObject({ closeTs: day(5), price: '61000', contracts: '0.8', qty: '0.008', avgPx: '61000.1' });
    expect(c.entry.clOrdId.startsWith('pc')).toBe(true);
    // the margin is the notional at the fill over 10, and the stake is that margin and the fee
    expect(c.entry.margin).toBe(D('0.008').mul('61000.1').div(10).toFixed());
    expect(stake.toFixed()).toBe(D(c.entry.margin).plus(c.entry.fee).toFixed());
    const step = ledger(s).steps.at(-1);
    expect(step?.inputs.find((i) => i.instId === BTC)).toMatchObject({ price: '61000', daily: { close: '61000', entryHigh: '60300', entry: true } });
    expect(step?.actions).toMatchObject([{ kind: 'enter', instId: BTC, outcome: 'done', plan: { stake: '50.4', contracts: '0.8' }, error: false }]);
    // pushed to the terminals
    await waitFor(() => pushed.slice(pushes).some((v) => v.campaigns.length === 1), 5000, 'the push of the entry');
    // the route says the same; the pot's free cash is the account's available balance less the banked amount
    const view = await getJson<CampaignView>(s, '/api/campaign');
    expect(view).toMatchObject({ status: 'running', errorCount: 0, nextStep: { closeTs: day(5) + HALF_DAY_MS, daily: false } });
    expect(view.campaigns.map((x) => x.id)).toEqual([c.id]);
    await waitFor(() => s.service.view().pot?.freeCash === after.toFixed(), 5000, 'the free cash from the account mirror');
  });

  it('adds at the noon close 5% above the entry open, out of the position margin: the balance outside it does not move', async () => {
    s.bars.add(BTC, day(5), [[61000, 64500, 60900, 64100]]);
    await moveTo(s, BTC, '64100');
    const before = await available(s);
    await closeAt(s, day(5) + HALF_DAY_MS);
    expect((await available(s)).toFixed()).toBe(before.toFixed());
    const c = only(s, BTC);
    // the cap: equity 73.6 at 64100 carries (736 - 512.8) / (64100 x 1.005) = 0.0035 coin: 0.3 contracts
    expect(c.adds).toMatchObject([{ closeTs: day(5) + HALF_DAY_MS, price: '64100', contracts: '0.3', qty: '0.003', avgPx: '64100.1' }]);
    expect(c.addRef).toBe('64100');
    const position = s.mock.getState().positions.find((p) => p.instId === BTC);
    expect(position).toMatchObject({ pos: '1.1', margin: D(c.entry.margin).minus(c.adds[0]?.fee ?? '0').toFixed() });
    expect(ledger(s).steps.at(-1)?.actions).toMatchObject([{ kind: 'add', outcome: 'done', plan: { atOpen: expect.any(String) as string, contracts: '0.3' } }]);
  });

  it('harvests at the rung: the free cash is banked at the close, a share of the campaign is sold and what it returned is banked', async () => {
    s.bars.add(BTC, day(5) + HALF_DAY_MS, [[64100, 67500, 64000, 67000]]);
    await moveTo(s, BTC, '67000');
    const before = await available(s);
    const freeCash = before;
    await closeAt(s, day(6));
    const after = await available(s);
    const l = ledger(s);
    const c = only(s, BTC);
    // the sale is the only thing that moved the balance in this step
    const proceeds = after.minus(before);
    expect(l.bankings).toHaveLength(1);
    const banking = l.bankings[0];
    expect(banking).toMatchObject({ closeTs: day(6), rungs: 1, fromCash: freeCash.toFixed(), fromSales: proceeds.toFixed(), amount: freeCash.plus(proceeds).toFixed() });
    // the pot was past 56 x 1.8 = 100.8; half of it was to go, the cash covered part, the sale of the rest is a whole lot share
    expect(D(banking?.value ?? '0').gte('100.8')).toBe(true);
    expect(D(banking?.target ?? '0').toFixed()).toBe(D(banking?.value ?? '0').div(2).toFixed());
    expect(harvestContracts('1.1', banking?.fraction ?? '0', s.deps.market.requireInstrument(BTC)).toFixed()).toBe('0.5');
    expect(c.sales).toMatchObject([{ closeTs: day(6), held: '1.1', contracts: '0.5', proceeds: proceeds.toFixed() }]);
    expect(c.harvested).toBe(proceeds.toFixed());
    expect(l.pot?.banked).toBe(freeCash.plus(proceeds).toFixed());
    // the rest keeps its add unit and stake basis less the share sold
    expect(c.addUnit).toBe(keptAfterHarvest('0.008', '1.1', '0.5').toFixed());
    expect(c.basis).toBe(keptAfterHarvest(stake, '1.1', '0.5').toFixed());
    expect(s.mock.getState().positions.find((p) => p.instId === BTC)?.pos).toBe('0.6');
    // nothing transferred: the free cash is what the account has less what was banked, 0 here
    expect(l.samples.at(-1)).toMatchObject({ ts: day(6), freeCash: '0', banked: l.pot?.banked, open: 1 });
    expect(s.service.view().pot?.nextRung).toBe(D(56).mul('3.24').toFixed());
  });

  it('under the kill switch an add that is due is skipped, its reference moving all the same', async () => {
    s.deps.risk.setKillSwitch(true, 'test');
    s.bars.add(BTC, day(6), [[67000, 68200, 66900, 68000]]);
    await moveTo(s, BTC, '68000');
    const orders = s.mock.getState().orders.length;
    await closeAt(s, day(6) + HALF_DAY_MS);
    const c = only(s, BTC);
    expect(c.adds).toHaveLength(1);
    expect(c.addRef).toBe('68000');
    expect(s.mock.getState().orders).toHaveLength(orders);
    expect(ledger(s).steps.at(-1)?.actions).toMatchObject([{ kind: 'add', outcome: 'skipped', reason: 'kill-switch', error: false }]);
    expect(ledger(s).errorCount).toBe(0);
  });

  it('exits at the daily close below the 2-day low, kill switch or not, selling again what the book did not fill; the proceeds go to the free cash', async () => {
    s.bars.add(BTC, day(6) + HALF_DAY_MS, [[68000, 68100, 59000, 59500]]);
    await moveTo(s, BTC, '59500');
    const before = await available(s);
    // the book fills 0.4 of the 0.6 contracts of the first sale
    const reduce = s.orders.reduceLong.bind(s.orders);
    const close = s.orders.closeLong.bind(s.orders);
    const partly = vi.spyOn(s.orders, 'closeLong').mockImplementationOnce((req) => reduce({ instId: req.instId, contracts: '0.4' })).mockImplementation((req) => close(req));
    let orders = 0;
    try {
      await closeAt(s, day(7));
      orders = partly.mock.calls.length;
    } finally {
      partly.mockRestore();
      s.deps.risk.setKillSwitch(false, '');
    }
    expect(orders).toBe(2);
    const after = await available(s);
    const c = only(s, BTC);
    const proceeds = after.minus(before);
    expect(proceeds.gt(0)).toBe(true);
    // one wait of the test's clock between the two orders
    expect(c.end).toMatchObject({ kind: 'exit', closeTs: day(7), proceeds: proceeds.toFixed(), delayMs: 6_000, fill: { contracts: '0.2', avgPx: '59500' } });
    expect(ledger(s).steps.at(-1)?.actions).toMatchObject([{ kind: 'exit', outcome: 'done', error: false }]);
    expect(c.pendingExit).toBeNull();
    expect(c.multiple).toBe(D(c.harvested).plus(proceeds).div(stake).toSignificantDigits(15).toFixed());
    expect(s.mock.getState().positions).toEqual([]);
    // the ledger and the exchange agree: what the account holds is the free cash and the banked money, and it is the
    // start plus everything the campaign returned less its stake
    const l = ledger(s);
    expect(l.samples.at(-1)).toMatchObject({ ts: day(7), freeCash: after.minus(l.pot?.banked ?? '0').toFixed(), openEquity: '0', open: 0 });
    expect(after.toFixed()).toBe(D(56).minus(stake).plus(c.harvested).plus(proceeds).toFixed());
    expect(D(l.pot?.banked ?? '0').plus(l.samples.at(-1)?.freeCash ?? '0').toFixed()).toBe(after.toFixed());
    expect(l.errorCount).toBe(0);
    expect(l.pot?.finishedAt).toBeNull();
    expect(l.samples.map((x) => x.ts)).toEqual([day(4) + HALF_DAY_MS, day(5), day(5) + HALF_DAY_MS, day(6), day(6) + HALF_DAY_MS, day(7)]);
  });

  it('keeps the decision log, paged newest first', async () => {
    const page = await getJson<CampaignLogPage>(s, '/api/campaign/log?limit=2');
    expect(page.total).toBe(6);
    expect(page.steps.map((x) => x.closeTs)).toEqual([day(7), day(6) + HALF_DAY_MS]);
    const older = await getJson<CampaignLogPage>(s, `/api/campaign/log?limit=10&before=${page.next ?? 0}`);
    expect(older.steps).toHaveLength(4);
    expect(older.next).toBeNull();
    const res = await s.app.inject({ method: 'GET', url: '/api/campaign/log' });
    expect(res.statusCode).toBe(401);
    // the file holds what the service holds
    expect(JSON.parse(readFileSync(s.ledgerFile, 'utf8'))).toEqual(ledger(s));
  });

  it('replays the pot beside it from its start and reconciles the ledger with it: the add the kill switch held is the difference', async () => {
    // computed in the background after the steps of the daily closes; a refresh is asked for and answered at once
    await s.service.replayIdle();
    const refresh = await s.app.inject({ method: 'POST', url: '/api/campaign/replay', headers: { authorization: `Bearer ${TOKEN}` } });
    expect(refresh.statusCode).toBe(202);
    expect((refresh.json() as { data: CampaignReplayView }).data.status).toBe('ready');
    await s.service.replayIdle();
    const view = await getJson<CampaignReplayView>(s, '/api/campaign/replay');
    expect(view).toMatchObject({ status: 'ready', reason: null, through: day(7) });
    // the pot's own structure and the other one, one sample per close from the first close after the start
    expect(view.same?.structure).toBe('pyramid');
    expect(view.other?.structure).toBe('noadd');
    expect(view.same?.samples.map((x) => x.ts)).toEqual([day(4) + HALF_DAY_MS, day(5), day(5) + HALF_DAY_MS, day(6), day(6) + HALF_DAY_MS, day(7)]);
    expect(view.same?.samples[0]).toEqual({ ts: day(4) + HALF_DAY_MS, value: '56', banked: '0' });
    // 56 held in BTC from the mark at the start, 60000
    expect(view.heldBtc.at(-1)).toEqual({ ts: day(7), value: D(56).mul(59500).div(60000).toDecimalPlaces(8).toFixed() });
    // the same campaign on both sides: entered at the same close, at the open of 61000 with the modelled slippage
    expect(view.same?.campaigns).toMatchObject([{ instId: BTC, signalTs: day(4), entryTs: day(5), entryPx: '61030.5' }]);
    expect(view.reconciliation).toMatchObject({ tolerances: { entryPx: '0.01', multiple: '0.1' }, matched: 0, differing: 1, liveOnly: 0, replayOnly: 0 });
    const row = view.reconciliation?.rows[0];
    expect(row).toMatchObject({ instId: BTC, signalTs: day(4), campaignId: `${BTC}@${day(5)}`, verdict: 'differs' });
    const fields = row?.differences.map((d) => d.field) ?? [];
    for (const same of ['entryClose', 'entryPx', 'sales']) expect(fields).not.toContain(same);
    // the replay made the add the kill switch held, and its larger position was liquidated on the drop to 59000;
    // the live one exited at the close after it
    expect(row?.differences).toContainEqual({ field: 'adds', live: '1', replay: '2' });
    expect(row?.differences).toContainEqual({ field: 'end', live: 'exit', replay: 'liquidated' });
    expect(row?.differences).toContainEqual({ field: 'endClose', live: String(day(7)), replay: String(day(6) + HALF_DAY_MS) });
    // the campaign's view carries the summary, and the terminals had it pushed
    expect(s.service.view().replay).toEqual({ status: 'ready', computedAt: view.computedAt, mismatches: 1 });
    await waitFor(() => pushed.some((v) => v.replay?.computedAt === view.computedAt), 5000, 'the push of the replay summary');
    // the token is asked for as on every route
    expect((await s.app.inject({ method: 'GET', url: '/api/campaign/replay' })).statusCode).toBe(401);
    expect((await s.app.inject({ method: 'POST', url: '/api/campaign/replay' })).statusCode).toBe(401);
  });
});

describe('a liquidation, and a restart that catches up a missed exit', () => {
  let s: Stack;

  beforeAll(async () => {
    s = await startStack('56', DEFAULT_POT_PARAMS, day(4) + 3_600_000);
    s.bars.add(BTC, day(0), flat(60000, 8));
    s.bars.add(ETH, day(0), flat(3000, 8));
    await s.service.start();
  }, 30_000);
  afterAll(async () => {
    await stopStack(s);
  });

  it('enters both signals of one close in the order of the close, each staking half of the free cash left', async () => {
    s.bars.add(BTC, day(4), [[60000, 60300, 59800, 60100], [60100, 61500, 60000, 61000]]);
    s.bars.add(ETH, day(4), [[3000, 3015, 2990, 3010], [3010, 3080, 3005, 3050]]);
    await moveTo(s, BTC, '61000');
    await moveTo(s, ETH, '3050');
    await closeAt(s, day(4) + HALF_DAY_MS);
    await closeAt(s, day(5));
    const step = ledger(s).steps.at(-1);
    const order = sameCloseOrder([BTC, ETH], day(5));
    expect(step?.actions.map((a) => a.instId)).toEqual(order);
    const [first, second] = step?.actions ?? [];
    expect(first?.plan['stake']).toBe('28');
    const firstStake = only(s, order[0] as string).stake;
    expect(second?.plan['stake']).toBe(D(56).minus(firstStake).div(2).toFixed());
    expect(ledger(s).campaigns.every((c) => c.end === null)).toBe(true);
  }, 20_000);

  it('a liquidation by the exchange ends the campaign as soon as the account service reports it; it is not an error', async () => {
    const held = s.mock.getState().positions.find((p) => p.instId === ETH);
    if (!held) throw new Error('no ETH position');
    s.mock.setMarkPrice(ETH, D(held.liqPx).minus('0.01').toDecimalPlaces(2, Decimal.ROUND_FLOOR).toFixed(2));
    try {
      const c = await waitFor(() => s.service.ledgerCopy().campaigns.find((x) => x.instId === ETH && x.end !== null), 5000, 'the liquidation in the ledger');
      expect(c.end).toMatchObject({ kind: 'liquidated', proceeds: '0', fill: { contracts: held.pos, clOrdId: '' } });
      expect(c.multiple).toBe('0');
      expect(ledger(s).errorCount).toBe(0);
    } finally {
      s.mock.setMarkPrice(ETH, null);
    }
  });

  it('after a restart the ledger is read again; closes missed meanwhile: the exit is carried out late, the add and the entry are not', async () => {
    const pot = ledger(s).pot;
    await s.service.stop();
    // While the API was down: BTC rose 5% by the noon (an add was due), then closed the day below the 2-day low (an
    // exit); ETH closed that day above its 3-day high (an entry, but its campaign was liquidated: it would be new).
    s.bars.add(BTC, day(5), [[61000, 64500, 60900, 64100], [64100, 64200, 59000, 59500]]);
    s.bars.add(ETH, day(5), [[3050, 3060, 3040, 3055], [3055, 3110, 3050, 3100]]);
    await moveTo(s, BTC, '59600');
    s.clock.now = day(6) + 3 * 3_600_000;
    const restarted = newService(s, DEFAULT_POT_PARAMS);
    wire(s, restarted);
    const before = await available(s);
    await restarted.start();
    const l = restarted.ledgerCopy();
    expect(l.pot).toEqual(pot);
    expect(l.missedCloses).toBe(2);
    expect(l.lastClose).toBe(day(6));
    const step = l.steps.at(-1);
    expect(step).toMatchObject({ kind: 'catch-up', closes: [day(5) + HALF_DAY_MS, day(6)], closeTs: day(6), errors: 0 });
    expect(step?.actions.map((a) => [a.kind, a.instId, a.outcome])).toEqual([
      ['add', BTC, 'missed'],
      ['enter', ETH, 'missed'],
      ['exit', BTC, 'done'],
    ]);
    const btc = l.campaigns.find((c) => c.instId === BTC);
    // the reference moved at the missed add, to the open after that noon
    expect(btc?.addRef).toBe('64100');
    expect(btc?.adds).toEqual([]);
    const proceeds = (await available(s)).minus(before);
    expect(btc?.end).toMatchObject({ kind: 'exit', closeTs: day(6), proceeds: proceeds.toFixed(), delayMs: 3 * 3_600_000 });
    expect(step?.actions.at(-1)?.plan).toMatchObject({ late: true });
    // no entry on ETH: only one campaign there, the liquidated one
    expect(l.campaigns.filter((c) => c.instId === ETH).map((c) => c.end?.kind)).toEqual(['liquidated']);
    expect(s.mock.getState().positions).toEqual([]);
    expect(l.errorCount).toBe(0);
    expect(restarted.view()).toMatchObject({ status: 'running', missedCloses: 2, nextStep: { closeTs: day(6) + HALF_DAY_MS } });
  }, 20_000);
});

describe('what is counted as an execution error, and what is not', () => {
  let s: Stack;

  beforeAll(async () => {
    s = await startStack('56', DEFAULT_POT_PARAMS, day(4) + 3_600_000);
    s.bars.add(BTC, day(0), [...flat(60000, 8), [60000, 60300, 59800, 60100], [60100, 61500, 60000, 61000]]);
    s.bars.add(ETH, day(0), flat(3000, 10));
    await s.service.start();
    await closeAt(s, day(4) + HALF_DAY_MS);
  }, 30_000);
  afterAll(async () => {
    vi.restoreAllMocks();
    await stopStack(s);
  });

  it('an entry whose first attempt failed for a passing reason is retried; a retry that succeeded is not an error', async () => {
    await moveTo(s, BTC, '61000');
    const open = vi.spyOn(s.orders, 'openLong').mockRejectedValueOnce(new NotConnectedError('OKX private stream'));
    await closeAt(s, day(5));
    expect(open).toHaveBeenCalledTimes(2);
    open.mockRestore();
    expect(only(s, BTC).end).toBeNull();
    expect(ledger(s).steps.at(-1)?.actions).toMatchObject([{ kind: 'enter', outcome: 'done', attempts: 2, error: false }]);
    expect(ledger(s).errorCount).toBe(0);
  });

  it('a position the ledger does not know is reported and never touched; no entry is made on its instrument', async () => {
    s.bars.add(BTC, day(5), [[61000, 61200, 60800, 61100]]);
    s.bars.add(ETH, day(5), [[3000, 3015, 2990, 3010]]);
    await moveTo(s, BTC, '61100');
    await closeAt(s, day(5) + HALF_DAY_MS);
    // a cross position opened from the terminal
    await s.deps.orders.place({ instId: ETH, side: 'buy', ordType: 'market', tdMode: 'cross', size: { unit: 'contracts', value: '0.1' } });
    await waitFor(() => s.mock.getState().positions.some((p) => p.instId === ETH), 5000, 'the cross position');
    // the day closes with an exit signal on BTC and an entry signal on ETH
    s.bars.add(BTC, day(5) + HALF_DAY_MS, [[61100, 61200, 59000, 59500]]);
    s.bars.add(ETH, day(5) + HALF_DAY_MS, [[3010, 3080, 3005, 3050]]);
    await moveTo(s, BTC, '59500');
    // the exit's answer is lost after it went through: it is not sent again
    const close = s.orders.closeLong.bind(s.orders);
    const exit = vi.spyOn(s.orders, 'closeLong').mockImplementationOnce(async (req) => {
      await close(req);
      throw new AppError('ORDER_STATUS_UNKNOWN', 'the exchange did not acknowledge the order', 504);
    });
    const before = await available(s);
    await closeAt(s, day(6));
    expect(exit).toHaveBeenCalledTimes(1);
    exit.mockRestore();
    const step = ledger(s).steps.at(-1);
    expect(step?.actions).toMatchObject([
      { kind: 'foreign', instId: ETH, outcome: 'noted', plan: { position: `${ETH} cross net 0.1` } },
      { kind: 'enter', instId: ETH, outcome: 'skipped', reason: 'foreign-position', error: false },
      { kind: 'exit', instId: BTC, outcome: 'done', error: false },
    ]);
    expect(only(s, BTC).end).toMatchObject({ kind: 'exit', proceeds: (await available(s)).minus(before).toFixed() });
    expect(s.service.view().foreign).toEqual([`${ETH} cross net 0.1`]);
    expect(s.mock.getState().positions.filter((p) => p.instId === ETH)).toMatchObject([{ mgnMode: 'cross', pos: '0.1' }]);
    expect(ledger(s).errorCount).toBe(0);
    await s.deps.orders.closePosition({ instId: ETH, mgnMode: 'cross' });
    await waitFor(() => !s.mock.getState().positions.some((p) => p.instId === ETH), 5000, 'the cross position closed');
  });

  it('an entry the risk engine refuses is an execution error, counted with its code and details', async () => {
    // BTC closes the day above its 3-day high, ETH as well
    s.bars.add(BTC, day(6), [[59500, 59600, 59400, 59500], [59500, 62000, 59400, 61800]]);
    s.bars.add(ETH, day(6), [[3050, 3060, 3040, 3055], [3055, 3110, 3050, 3100]]);
    await moveTo(s, BTC, '61800');
    await moveTo(s, ETH, '3100');
    await closeAt(s, day(6) + HALF_DAY_MS);
    const open = s.orders.openLong.bind(s.orders);
    const refused = vi.spyOn(s.orders, 'openLong').mockImplementation(async (req) => {
      if (req.instId === BTC) throw new RiskRejectedError({ ok: false, code: 'MAX_SLIPPAGE', message: 'estimated slippage 1.000% exceeds 0.500%', details: { estSlippagePct: '0.01' } });
      return open(req);
    });
    await closeAt(s, day(7));
    refused.mockRestore();
    const l = ledger(s);
    expect(l.errorCount).toBe(1);
    expect(l.errors).toMatchObject([{ closeTs: day(7), action: 'enter', instId: BTC, campaignId: null, code: 'RISK_REJECTED', details: { code: 'MAX_SLIPPAGE' } }]);
    expect(l.steps.at(-1)).toMatchObject({ errors: 1 });
    expect(l.steps.at(-1)?.actions.find((a) => a.instId === BTC)).toMatchObject({ kind: 'enter', outcome: 'failed', reason: 'RISK_REJECTED', error: true });
    // ETH was entered all the same
    expect(only(s, ETH).end).toBeNull();
    expect(s.service.view()).toMatchObject({ errorCount: 1, errors: [{ code: 'RISK_REJECTED' }] });
  });

  it('an add the exchange refuses at its cap is sized again from the margin it says the position can spare; that retry is not an error', async () => {
    // ETH closes the noon 5% above its entry open of 3100
    s.bars.add(BTC, day(7), [[61800, 61900, 61700, 61800]]);
    s.bars.add(ETH, day(7), [[3100, 3270, 3095, 3260]]);
    await moveTo(s, ETH, '3260');
    const add = s.orders.addLong.bind(s.orders);
    const capped = vi.spyOn(s.orders, 'addLong').mockRejectedValueOnce(new AppError('CAMPAIGN_ADD_CAP', 'the exchange would refuse it', 409, { spare: '1', required: '4' })).mockImplementation((req) => add(req));
    await closeAt(s, day(7) + HALF_DAY_MS);
    const sent = capped.mock.calls.map(([req]) => req.contracts);
    capped.mockRestore();
    // 1 USDT spare carries (99% of it) / (3260.01 x (1/75 + 0.0005)) = 0.0219 ETH: 0.2 contracts, not the 0.3 the rule sized
    expect(sent).toEqual(['0.3', '0.2']);
    expect(only(s, ETH).adds).toMatchObject([{ contracts: '0.2', price: '3260' }]);
    expect(ledger(s).steps.at(-1)?.actions).toMatchObject([{ kind: 'add', outcome: 'done', attempts: 2, error: false }]);
    expect(ledger(s).errorCount).toBe(1);
  });

  it('a campaign closed by an order that was not its own ends as external: reported, not an execution error', async () => {
    await s.deps.orders.closePosition({ instId: ETH, mgnMode: 'isolated' });
    await waitFor(() => !s.mock.getState().positions.some((p) => p.instId === ETH), 5000, 'ETH closed from the terminal');
    // the day closes with an entry signal on BTC (above 62000), none on ETH
    s.bars.add(BTC, day(7) + HALF_DAY_MS, [[61800, 62600, 61700, 62500]]);
    s.bars.add(ETH, day(7) + HALF_DAY_MS, [[3260, 3265, 3090, 3100]]);
    await moveTo(s, BTC, '62500');
    await closeAt(s, day(8));
    const eth = only(s, ETH);
    expect(eth.end).toMatchObject({ kind: 'external', proceeds: '' });
    expect(eth.end?.fill?.clOrdId.startsWith('pc')).toBe(false);
    expect(eth.multiple).toBeNull();
    const actions = ledger(s).steps.at(-1)?.actions ?? [];
    expect(actions[0]).toMatchObject({ kind: 'gone', instId: ETH, outcome: 'noted', reason: 'external', error: false });
    expect(actions.slice(1)).toMatchObject([{ kind: 'enter', instId: BTC, outcome: 'done' }]);
    expect(ledger(s).errorCount).toBe(1);
  });

  it('a position gone without anything in the order history to explain it is an execution error', async () => {
    await s.deps.orders.closePosition({ instId: BTC, mgnMode: 'isolated' });
    await waitFor(() => !s.mock.getState().positions.some((p) => p.instId === BTC), 5000, 'BTC closed from the terminal');
    const history = vi.spyOn(s.deps.clients.rest, 'getOrdersHistory').mockResolvedValueOnce([]);
    s.bars.add(BTC, day(8), [[62500, 62600, 62400, 62500]]);
    s.bars.add(ETH, day(8), [[3100, 3110, 3090, 3100]]);
    await closeAt(s, day(8) + HALF_DAY_MS);
    history.mockRestore();
    const btc = ledger(s).campaigns.filter((c) => c.instId === BTC).at(-1);
    expect(btc?.end).toMatchObject({ kind: 'unknown', proceeds: '' });
    const l = ledger(s);
    expect(l.errorCount).toBe(2);
    expect(l.errors.map((e) => [e.action, e.code, e.instId])).toEqual([
      ['enter', 'RISK_REJECTED', BTC],
      ['reconcile', 'CAMPAIGN_POSITION_UNEXPLAINED', BTC],
    ]);
    expect(l.steps.at(-1)?.actions).toMatchObject([{ kind: 'gone', instId: BTC, outcome: 'failed', error: true }]);
  });
});

describe('the guard and the ledger file', () => {
  let s: Stack;

  beforeAll(async () => {
    // the default paper account: 1,000 USDT
    s = await startStack('1000', DEFAULT_POT_PARAMS, day(4));
    await s.service.start();
  }, 30_000);
  afterAll(async () => {
    await stopStack(s);
  });

  it('starts no pot on an account that is not its own; the API keeps running', async () => {
    const view = await getJson<CampaignView>(s, '/api/campaign');
    expect(view).toMatchObject({ status: 'blocked', pot: null, nextStep: null, reason: { code: 'ACCOUNT_NOT_DEDICATED' } });
    expect(view.reason?.message).toMatch(/total equity is 1000 USDT, the pot starts with 56.*PAPER_STATE_FILE.*PAPER_BALANCE=56/);
    expect(existsSync(s.ledgerFile)).toBe(false);
    expect((await s.app.inject({ method: 'GET', url: '/api/health' })).statusCode).toBe(200);
    // looked at again at every tick, still blocked
    s.clock.now += DAY;
    await s.service.tick();
    expect(s.service.view().status).toBe('blocked');
    expect(s.mock.getState().orders).toEqual([]);
  });

  it('does not trade on a ledger it cannot read, and does not write over it', async () => {
    const file = join(mkdtempSync(join(tmpdir(), 'pegasus-campaign-')), 'ledger.json');
    writeFileSync(file, '{"version": 1, "pot": ');
    const broken = newService({ ...s, ledgerFile: file }, DEFAULT_POT_PARAMS);
    await broken.start();
    expect(broken.view()).toMatchObject({ status: 'blocked', reason: { code: 'LEDGER_UNREADABLE' } });
    expect(readFileSync(file, 'utf8')).toBe('{"version": 1, "pot": ');
    expect(existsSync(`${file}.corrupt`)).toBe(true);
    await broken.tick();
    expect(readFileSync(file, 'utf8')).toBe('{"version": 1, "pot": ');
    await broken.stop();
  });

  it('answers status disabled while the campaign is not enabled', async () => {
    const { campaign: _campaign, ...rest } = s.deps;
    void _campaign;
    const app = await buildServer(rest);
    try {
      const res = await app.inject({ method: 'GET', url: '/api/campaign', headers: { authorization: `Bearer ${TOKEN}` } });
      expect(res.json()).toMatchObject({ ok: true, data: { status: 'disabled', reason: { code: 'CAMPAIGN_DISABLED' }, pot: null, campaigns: [], params: { potStart: '56', structure: 'pyramid', entryChannel: 20, exitChannel: 10 } } });
      const log = await app.inject({ method: 'GET', url: '/api/campaign/log', headers: { authorization: `Bearer ${TOKEN}` } });
      expect(log.json()).toEqual({ ok: true, data: { steps: [], total: 0, next: null } });
    } finally {
      await app.close();
    }
  });
});
