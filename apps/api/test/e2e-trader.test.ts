/**
 * End-to-end: the Claude auto trader (services/trader.ts) on an API in paper mode against the in-process mock exchange,
 * with a scripted model and synthetic candles. Covers an hourly call that opens a long with its stop, the quiet
 * 15-minute closes in between (no call), a close by the model and its result, a decision the guardrails refuse, the
 * day's trade cap, the coin-flip control, the routes, and the session window.
 */
import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { pino } from 'pino';
import { startMockOkx, type MockOkxHandle } from '@pegasus/mock-okx';
import { D, type Candle, type TraderBar, type TraderDecision, type TraderDossier, type TraderLogRecord, type TraderView } from '@pegasus/shared';
import type { FastifyInstance } from 'fastify';
import { loadConfig, type AppConfig } from '../src/config.js';
import { MemoryStore } from '../src/db/store.js';
import type { Deps } from '../src/deps.js';
import { createOkxClients, syncClock } from '../src/okx/clients.js';
import { buildServer } from '../src/server.js';
import { AccountService } from '../src/services/account.js';
import { MarketDataService } from '../src/services/market-data.js';
import { OrderService } from '../src/services/order-service.js';
import { RiskEngine } from '../src/services/risk-engine.js';
import { SignalsService } from '../src/services/signals.js';
import { TraderService } from '../src/services/trader.js';
import type { TraderDossierSources } from '../src/services/trader-dossier.js';
import type { TraderModel, TraderModelAnswer } from '../src/services/trader-model.js';
import { Hub } from '../src/ws/hub.js';

const TOKEN = 'test-token';
const BTC = 'BTC-USDT-SWAP';
const log = pino({ level: process.env['E2E_LOG'] ?? 'silent' });
const H = 3_600_000;
const M15 = 15 * 60_000;
/** 2026-10-19, a Monday: 14:00 UTC is inside the session (13 to 21) and an hourly close */
const DAY = Date.UTC(2026, 9, 19);
const PRICE = 60000;

/** A model that answers from a queue; `flat` when the queue is empty. */
class ScriptedModel implements TraderModel {
  readonly name = 'scripted';
  queue: TraderDecision[] = [];
  calls = 0;
  dossiers: TraderDossier[] = [];
  async decide(dossier: TraderDossier): Promise<TraderModelAnswer> {
    this.calls += 1;
    this.dossiers.push(dossier);
    const decision = this.queue.shift() ?? decide({ action: 'flat' });
    return { decision, usage: { inputTokens: 5000, outputTokens: 800, cacheReadTokens: 2500, ms: 1200, model: this.name }, problem: null };
  }
}

const decide = (over: Partial<TraderDecision>): TraderDecision => ({ action: 'flat', entryType: 'market', limitPrice: null, stopPx: null, targetPx: null, confidence: 0.55, reasons: ['测试'], invalidation: '测试', oneLiner: '测试', ...over });

/** Flat synthetic candles around PRICE, confirmed up to the clock; the forming bar last. */
function sources(clock: { now: number }, mark: () => string | null): TraderDossierSources {
  const durations: Record<TraderBar | '1D', number> = { '15m': M15, '1H': H, '4H': 4 * H, '1D': 24 * H };
  return {
    async candles(_instId, bar, limit) {
      const d = durations[bar];
      const forming = Math.floor(clock.now / d) * d;
      const out: Candle[] = [];
      for (let i = limit - 1; i >= 0; i--) {
        const ts = forming - i * d;
        const wiggle = (i % 7) - 3;
        const close = PRICE + wiggle;
        out.push({ ts, open: String(close - 1), high: String(close + 5), low: String(close - 5), close: String(close), vol: '10', volCcy: '0', confirm: ts < forming });
      }
      return out;
    },
    mark: () => mark(),
    funding: async () => ({ rate: '0.0001', mean72h: '0.0001' }),
    openInterest: async () => ({ oi: '1000', change24hPct: '1.5' }),
  };
}

interface Stack {
  mock: MockOkxHandle;
  deps: Deps;
  config: AppConfig;
  app: FastifyInstance;
  clock: { now: number };
  model: ScriptedModel;
  service: TraderService;
  dir: string;
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

async function startStack(maxTradesPerDay: string, start: number): Promise<Stack> {
  const dir = mkdtempSync(join(tmpdir(), 'pegasus-trader-'));
  const mock = await startMockOkx({ port: 0, seed: 7, tickIntervalMs: 50, volatility: 0, posMode: 'net_mode', initialPrices: { [BTC]: String(PRICE) }, initialBalanceUsdt: '5600' });
  const config = loadConfig({
    PAPER_EXCHANGE_URL: mock.restUrl,
    OKX_REST_URL: mock.restUrl,
    OKX_WS_PUBLIC_URL: mock.wsPublicUrl,
    OKX_WS_PRIVATE_URL: mock.wsPrivateUrl,
    OKX_WS_BUSINESS_URL: mock.wsBusinessUrl,
    API_TOKEN: TOKEN,
    INSTRUMENTS: BTC,
    RISK_MAX_ORDER_NOTIONAL: '100000',
    RISK_MAX_POSITION_NOTIONAL_PER_INSTRUMENT: '100000',
    RISK_MAX_TOTAL_POSITION_NOTIONAL: '200000',
    TRADER_ENABLED: '1',
    TRADER_MAX_TRADES_PER_DAY: maxTradesPerDay,
    TRADER_STATE_FILE: join(dir, 'trader-state.json'),
    TRADER_LOG_FILE: join(dir, 'trader-log.jsonl'),
  });
  const store = new MemoryStore();
  const clients = createOkxClients(config, log);
  await syncClock(clients, log);
  const market = new MarketDataService(clients, log, { bookDepth: 50, bookThrottleMs: 20 });
  await market.loadInstruments(config.instruments);
  const account = new AccountService(clients, store, log, { readTrailingStops: true });
  const risk = new RiskEngine(config.risk, store, log);
  await risk.init();
  const orders = new OrderService(clients, market, account, risk, store, log, { defaultTdMode: config.defaultTdMode, wsTrading: config.okx.wsTrading, exits: true });
  const signals = new SignalsService(clients, market, account, log);
  const hub = new Hub(config, market, account, risk, log);
  const deps: Deps = { config, log, clients, store, market, account, risk, orders, signals, hub };
  account.on('balance', (b) => risk.updateEquity(b.totalEq));
  hub.wire();
  const app = await buildServer(deps);
  await market.start();
  await account.start();
  await app.listen({ host: '127.0.0.1', port: 0 });
  await waitFor(() => market.book(BTC) && market.liveMarkPrice(BTC) && account.ready && account.balance, 10_000, 'market data + paper account stream');
  const clock = { now: start };
  const model = new ScriptedModel();
  const service = new TraderService(config.trader, { clients, market, account, risk, orders, log }, {
    now: () => clock.now,
    sleep: async () => {
      await new Promise((r) => setImmediate(r));
    },
    model,
    sources: sources(clock, () => market.liveMarkPrice(BTC) ?? null),
    checkEveryMs: 0,
    pollMs: 1,
    pollAttempts: 2,
  });
  deps.trader = service;
  await service.start();
  return { mock, deps, config, app, clock, model, service, dir };
}

async function stopStack(s: Stack): Promise<void> {
  s.service.stop();
  await s.deps.hub.close();
  await s.app.close();
  await s.deps.market.stop();
  await s.deps.account.stop();
  await s.mock.close();
}

/** The clock reaches `ts` (a 15-minute close) plus a few seconds and the trader looks. */
async function closeAt(s: Stack, ts: number): Promise<void> {
  s.clock.now = ts + 5_000;
  await s.service.tick();
}

const position = (s: Stack) => s.deps.account.positionList().find((p) => p.instId === BTC && !D(p.pos || '0').isZero());
const records = (s: Stack): TraderLogRecord[] => readFileSync(join(s.dir, 'trader-log.jsonl'), 'utf8').split('\n').filter((l) => l !== '').map((l) => JSON.parse(l) as TraderLogRecord);

async function getJson<T>(s: Stack, url: string): Promise<T> {
  const res = await s.app.inject({ method: 'GET', url, headers: { authorization: `Bearer ${TOKEN}` } });
  expect(res.statusCode).toBe(200);
  return (res.json() as { data: T }).data;
}

describe('the Claude auto trader on the paper exchange', () => {
  let s: Stack;
  beforeAll(async () => {
    s = await startStack('2', DAY + 13 * H + 45 * 60_000 + 5_000);
  }, 30_000);
  afterAll(async () => {
    await stopStack(s);
  });

  it('is idle before the first hourly close and in session after it', async () => {
    const view = s.service.view();
    expect(view).toMatchObject({ enabled: true, status: 'in-session', instId: BTC, model: 'scripted' });
    expect(view.nextCallAt).toBe(DAY + 14 * H);
  });

  it('opens a long with the stop attached at the hourly close, sized by the risk, and starts the control', async () => {
    s.model.queue.push(decide({ action: 'long', stopPx: '59700', targetPx: '60600' }));
    await closeAt(s, DAY + 14 * H);
    expect(s.model.calls).toBe(1);
    const dossier = s.model.dossiers[0] as TraderDossier;
    expect(dossier.triggers).toEqual(['hourly close']);
    expect(dossier.frames.map((f) => f.bar)).toEqual(['15m', '1H', '4H']);
    expect(dossier.session).toMatchObject({ inSession: true, minutesSinceUsOpen: 30 });
    const state = s.service.stateCopy();
    // 2% of 5600 = 112 at a stop 300 away: 0.3733 BTC = 37.3 contracts of 0.01 (the mock's lot is 0.1) at 60,000, 5x
    expect(state.position).toMatchObject({ side: 'long', contracts: '37.3', stopPx: '59700', targetPx: '60600' });
    expect(state.tradesToday).toBe(1);
    const live = await waitFor(() => position(s), 5000, 'the position on the exchange');
    expect(D(live.pos).toFixed()).toBe('37.3');
    expect(live.mgnMode).toBe('isolated');
    expect(state.control.position).toMatchObject({ contracts: '37.3' });
    expect(state.control.trades).toBe(1);
    const kinds = records(s).map((r) => r.kind);
    expect(kinds).toEqual(expect.arrayContaining(['decision', 'execution', 'control']));
    const decision = records(s).find((r) => r.kind === 'decision');
    expect(decision?.dossier?.instId).toBe(BTC);
    expect(decision?.verdict).toMatch(/^long 37\.3 contracts/);
    expect(s.service.view()).toMatchObject({ status: 'holding', usageToday: { calls: 1, inputTokens: 5000 } });
  });

  it('does not ask the model at a quiet 15-minute close', async () => {
    await closeAt(s, DAY + 14 * H + M15);
    await closeAt(s, DAY + 14 * H + 2 * M15);
    expect(s.model.calls).toBe(1);
  });

  it('closes on the model s word and books the result at the next close; the control is closed with it', async () => {
    s.model.queue.push(decide({ action: 'close' }));
    await closeAt(s, DAY + 15 * H);
    expect(s.model.calls).toBe(2);
    await waitFor(() => !position(s), 5000, 'the position closed on the exchange');
    expect(s.service.stateCopy().control.position).toBeNull();
    await closeAt(s, DAY + 15 * H + M15);
    const state = s.service.stateCopy();
    expect(state.position).toBeNull();
    expect(state.recent).toHaveLength(1);
    expect(state.recent[0]).toMatchObject({ side: 'long', end: 'close', contracts: '37.3' });
    // a round trip on a flat market: the fees
    expect(D(state.recent[0]?.pnl ?? '0').lt(0)).toBe(true);
    expect(state.pnlToday).toBe(state.recent[0]?.pnl);
    expect(state.consecutiveLosses).toBe(1);
  });

  it('refuses a decision outside the guardrails and says why', async () => {
    s.model.queue.push(decide({ action: 'long', stopPx: '60300' }));
    await closeAt(s, DAY + 16 * H);
    expect(s.model.calls).toBe(3);
    expect(s.service.view().last).toMatchObject({ executed: false, verdict: expect.stringMatching(/wrong side/) });
    expect(s.service.stateCopy().position).toBeNull();
  });

  it('stops opening positions at the day s trade cap', async () => {
    s.model.queue.push(decide({ action: 'short', stopPx: '60300', targetPx: '59100' }));
    await closeAt(s, DAY + 17 * H);
    expect(s.service.stateCopy().position).toMatchObject({ side: 'short' });
    s.model.queue.push(decide({ action: 'close' }));
    await closeAt(s, DAY + 18 * H);
    await waitFor(() => !position(s), 5000, 'the short closed');
    await closeAt(s, DAY + 18 * H + M15);
    expect(s.service.stateCopy().tradesToday).toBe(2);
    s.model.queue.push(decide({ action: 'long', stopPx: '59700' }));
    await closeAt(s, DAY + 19 * H);
    expect(s.service.view().last?.verdict).toMatch(/2 trades are done/);
    expect(s.service.stateCopy().position).toBeNull();
  });

  it('answers on the routes: the view and the log without dossiers', async () => {
    const view = await getJson<TraderView>(s, '/api/trader');
    expect(view).toMatchObject({ enabled: true, instId: BTC, today: { trades: 2 } });
    expect(view.recent).toHaveLength(2);
    const page = await getJson<{ records: TraderLogRecord[] }>(s, '/api/trader/log?limit=5');
    expect(page.records).toHaveLength(5);
    expect(page.records.every((r) => r.dossier === undefined)).toBe(true);
  });

  it('asks nothing outside the session', async () => {
    const calls = s.model.calls;
    s.model.queue.push(decide({ action: 'long', stopPx: '59700' }));
    await closeAt(s, DAY + 22 * H);
    expect(s.model.calls).toBe(calls);
    expect(s.service.view().status).toBe('idle');
  });
});
