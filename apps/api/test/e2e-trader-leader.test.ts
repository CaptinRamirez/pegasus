/**
 * End-to-end: the lead-trader style as the owner freed it on 2026-11-14, on the real order path. The mock exchange
 * stands in for the paper exchange (the same engine); the account, the risk engine with the trader stack's limits
 * (scripts/launch-options.mjs, traderEnv) and the order service are the real ones; only the model is scripted. What the
 * unit test (trader-leader.test.ts) shows on a fake order service is shown here on the exchange: a short and a long of
 * the sizes the model names, the cap of three times the equity, the other side refused, a close at a loss, an order the
 * exchange refuses for margin, and the liquidation.
 */
import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { pino } from 'pino';
import { startMockOkx, type MockOkxHandle } from '@pegasus/mock-okx';
import { D, type Candle, type LeaderDecision, type TraderBar, type TraderDossier, type TraderLogRecord } from '@pegasus/shared';
import { loadConfig } from '../src/config.js';
import { MemoryStore } from '../src/db/store.js';
import { createOkxClients, syncClock } from '../src/okx/clients.js';
import { AccountService } from '../src/services/account.js';
import { MarketDataService } from '../src/services/market-data.js';
import { OrderService } from '../src/services/order-service.js';
import { RiskEngine } from '../src/services/risk-engine.js';
import type { TraderDossierSources } from '../src/services/trader-dossier.js';
import { LeaderTraderService } from '../src/services/trader-leader.js';
import type { LeaderModel, ModelAnswer } from '../src/services/trader-model.js';

const BTC = 'BTC-USDT-SWAP';
const ETH = 'ETH-USDT-SWAP';
const PRICES: Record<string, number> = { [BTC]: 60000, [ETH]: 2000 };
const log = pino({ level: process.env['E2E_LOG'] ?? 'silent' });
const H = 3_600_000;
const M15 = 15 * 60_000;
const DAY = Date.UTC(2026, 10, 9);

const answer = (action: LeaderDecision['action'], lotShare = 0): LeaderDecision => ({ action, lotShare, confidence: 0.6, reasons: ['测试'], invalidation: '测试', oneLiner: '测试', recheckMinutes: 240, wakeAbove: null, wakeBelow: null });

class ScriptedModel implements LeaderModel {
  readonly name = 'scripted';
  /** What to answer next for each coin; hold when there is nothing */
  next: Record<string, LeaderDecision | undefined> = {};
  dossiers: TraderDossier[] = [];
  async decide(dossier: TraderDossier): Promise<ModelAnswer<LeaderDecision>> {
    this.dossiers.push(dossier);
    const decision = this.next[dossier.instId] ?? answer('hold');
    this.next[dossier.instId] = undefined;
    return { decision, usage: { inputTokens: 1, outputTokens: 1, cacheReadTokens: 0, ms: 1, model: this.name }, problem: null };
  }
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

let mock: MockOkxHandle;
let market: MarketDataService;
let account: AccountService;
let service: LeaderTraderService;
let dir: string;
const clock = { now: DAY + 10_000 };
const model = new ScriptedModel();

const position = (instId: string) => account.positionList().find((p) => p.instId === instId && !D(p.pos || '0').isZero());
const equity = (): string => account.balance?.totalEq ?? '0';
const coin = (instId: string) => service.stateCopy().coins.find((c) => c.instId === instId);
const records = (): TraderLogRecord[] => readFileSync(join(dir, 'trader-log.jsonl'), 'utf8').split('\n').filter((l) => l !== '').map((l) => JSON.parse(l) as TraderLogRecord);
/** The clock reaches `ts` plus a few seconds and the trader looks. */
async function lookAt(ts: number): Promise<void> {
  clock.now = ts + 5_000;
  await service.tick();
}

beforeAll(async () => {
  dir = mkdtempSync(join(tmpdir(), 'pegasus-leader-e2e-'));
  mock = await startMockOkx({ port: 0, seed: 7, tickIntervalMs: 50, volatility: 0, posMode: 'net_mode', initialPrices: { [BTC]: String(PRICES[BTC]), [ETH]: String(PRICES[ETH]) }, initialBalanceUsdt: '1124' });
  const config = loadConfig({
    PAPER_EXCHANGE_URL: mock.restUrl,
    OKX_REST_URL: mock.restUrl,
    OKX_WS_PUBLIC_URL: mock.wsPublicUrl,
    OKX_WS_PRIVATE_URL: mock.wsPrivateUrl,
    OKX_WS_BUSINESS_URL: mock.wsBusinessUrl,
    API_TOKEN: 'test-token',
    INSTRUMENTS: `${BTC},${ETH}`,
    // the trader stack's limits (traderEnv with the balance of 1,124)
    RISK_MAX_LEVERAGE: '10',
    RISK_MAX_ORDER_NOTIONAL: '11240',
    RISK_MAX_POSITION_NOTIONAL_PER_INSTRUMENT: '11240',
    RISK_MAX_TOTAL_POSITION_NOTIONAL: '11240',
    RISK_DAILY_LOSS_LIMIT: '1124',
    TRADER_ENABLED: '1',
    TRADER_STATE_FILE: join(dir, 'trader-state.json'),
    TRADER_LOG_FILE: join(dir, 'trader-log.jsonl'),
  });
  expect(config.trader.style).toBe('leader');
  const store = new MemoryStore();
  const clients = createOkxClients(config, log);
  await syncClock(clients, log);
  market = new MarketDataService(clients, log, { bookDepth: 50, bookThrottleMs: 20 });
  await market.loadInstruments(config.instruments);
  account = new AccountService(clients, store, log, { readTrailingStops: true });
  const risk = new RiskEngine(config.risk, store, log);
  await risk.init();
  const orders = new OrderService(clients, market, account, risk, store, log, { defaultTdMode: config.defaultTdMode, wsTrading: config.okx.wsTrading, exits: true });
  account.on('balance', (b) => risk.updateEquity(b.totalEq));
  await market.start();
  await account.start();
  await waitFor(() => market.liveMarkPrice(BTC) && market.liveMarkPrice(ETH) && market.book(BTC) && market.book(ETH) && account.ready && account.balance, 10_000, 'market data + paper account stream');
  const durations: Record<TraderBar, number> = { '15m': M15, '1H': H, '4H': 4 * H, '1D': 24 * H, '1W': 7 * 24 * H };
  const sources: TraderDossierSources = {
    async candles(instId, bar, limit) {
      const d = durations[bar];
      const forming = Math.floor(clock.now / d) * d;
      const px = PRICES[instId] ?? 1;
      const out: Candle[] = [];
      for (let i = limit - 1; i >= 0; i--) {
        const ts = forming - i * d;
        out.push({ ts, open: String(px), high: String(px * 1.01), low: String(px * 0.99), close: String(px), vol: '10', volCcy: '0', confirm: ts < forming });
      }
      return out;
    },
    mark: (instId) => market.liveMarkPrice(instId) ?? null,
    funding: async () => ({ rate: '0.0001', mean72h: '0.0001' }),
    openInterest: async () => ({ oi: '1000', change24hPct: '1.5' }),
  };
  service = new LeaderTraderService(config.trader, { clients, market, account, risk, orders, log }, {
    now: () => clock.now,
    // short but real: the wait for a market order's fill must let the exchange's position report arrive
    sleep: async (ms) => {
      await new Promise((r) => setTimeout(r, Math.min(ms, 5)));
    },
    model,
    sources,
    macro: { read: async () => ({ calendar: [], headlines: [], notes: [] }) },
    checkEveryMs: 0,
    pollMs: 1,
    pollAttempts: 2,
  });
}, 30_000);

afterAll(async () => {
  service.stop();
  await market.stop();
  await account.stop();
  await mock.close();
});

describe('the freed lead-trader style on the exchange', () => {
  it('opens a short and a long of the sizes the model names, up to three times the equity', async () => {
    // 1,124 x 1.5 at 60,000 = 0.0281 BTC = 2.8 contracts of 0.01 BTC (the mock trades tenths of a contract); 1,124 x 1.4 at 2,000 = 7.8 contracts of 0.1 ETH
    model.next = { [BTC]: answer('short', 1.5), [ETH]: answer('buy', 1.4) };
    await service.start();
    const btc = await waitFor(() => position(BTC), 5000, 'the BTC short on the exchange');
    const eth = await waitFor(() => position(ETH), 5000, 'the ETH long on the exchange');
    expect(D(btc.pos).toFixed()).toBe('-2.8');
    expect(D(eth.pos).toFixed()).toBe('7.8');
    expect(btc.mgnMode).toBe('cross');
    expect(coin(BTC)).toMatchObject({ side: 'short', lots: [{ contracts: '2.8' }] });
    expect(coin(ETH)).toMatchObject({ side: 'long', lots: [{ contracts: '7.8' }] });
    // booked at the fills the exchange reports, within a tick or two of the marks
    expect(Math.abs(Number(coin(BTC)?.lots[0]?.entryPx) - 60000)).toBeLessThan(5);
    expect(Math.abs(Number(coin(ETH)?.lots[0]?.entryPx) - 2000)).toBeLessThan(1);
    const view = service.view();
    // 1,680 + 1,560 at the marks: 2.88 times the equity
    expect(Number(view.leader?.exposure)).toBeGreaterThan(3200);
    expect(Number(view.leader?.exposure)).toBeLessThan(3280);
    expect(Number(view.leader?.exposurePct)).toBeGreaterThan(2.8);
    expect(view.status).toBe('holding');
  });

  it('refuses the other side while lots are held, and a lot that would pass three times the equity', async () => {
    model.next = { [BTC]: answer('buy', 0.1), [ETH]: answer('buy', 0.5) };
    await lookAt(DAY + 4 * H);
    expect(coin(BTC)?.recentDecisions[0]).toMatchObject({ action: 'buy', verdict: expect.stringContaining('close them before opening a long lot') });
    expect(coin(ETH)?.recentDecisions[0]).toMatchObject({ action: 'buy', verdict: expect.stringContaining('above 3 times the equity') });
    expect(D(position(BTC)?.pos ?? '0').toFixed()).toBe('-2.8');
    expect(D(position(ETH)?.pos ?? '0').toFixed()).toBe('7.8');
    const last = model.dossiers.at(-1);
    expect(last?.leader).toMatchObject({ coin: { instId: ETH, side: 'long' }, openRefused: null });
    expect(Number(last?.leader?.room)).toBeLessThan(200);
  });

  it('closes the short at a loss when the model says close, and books it', async () => {
    mock.setPrice(BTC, '61000');
    await waitFor(() => D(market.liveMarkPrice(BTC) ?? '0').gte(60990), 5000, 'the BTC mark at 61,000');
    model.next = { [BTC]: answer('close') };
    await lookAt(DAY + 8 * H);
    await waitFor(() => !position(BTC), 5000, 'the BTC short gone from the exchange');
    expect(coin(BTC)?.recentDecisions[0]).toMatchObject({ action: 'close', verdict: expect.stringMatching(/^1 lots, 2\.8 contracts short, closed at the market/) });
    await lookAt(DAY + 8 * H + M15);
    const result = service.stateCopy().recent[0];
    // 0.028 BTC, about 1,000 against: about -28, less the fees
    expect(result).toMatchObject({ instId: BTC, side: 'short', contracts: '2.8', end: 'close' });
    expect(Number(result?.pnl)).toBeLessThan(-27);
    expect(Number(result?.pnl)).toBeGreaterThan(-32);
    expect(coin(BTC)?.lots).toEqual([]);
    // the account lost about that much
    expect(Number(equity())).toBeLessThan(1124 - 27);
    expect(Number(equity())).toBeGreaterThan(1124 - 40);
  });

  it('goes on after an order the exchange refuses for margin', async () => {
    // at 1x cross on BTC a lot of the whole equity needs more margin than the ETH position leaves
    await account.setLeverage({ instId: BTC, lever: '1', mgnMode: 'cross' });
    model.next = { [BTC]: answer('buy', 1) };
    await lookAt(DAY + 12 * H);
    expect(coin(BTC)?.recentDecisions[0]).toMatchObject({ action: 'buy', verdict: expect.stringMatching(/^execution failed: /) });
    expect(coin(BTC)?.lots).toEqual([]);
    expect(position(BTC)).toBeUndefined();
    // at the 10x the trader stack gives a new position, the same lot is taken
    await account.setLeverage({ instId: BTC, lever: '10', mgnMode: 'cross' });
    model.next = { [BTC]: answer('buy', 1) };
    await lookAt(DAY + 16 * H);
    await waitFor(() => position(BTC), 5000, 'the BTC long on the exchange');
    expect(coin(BTC)).toMatchObject({ side: 'long', lots: [{ contracts: expect.stringMatching(/^1\.[78]$/) }] });
    expect(service.view().status).toBe('holding');
  });

  it('is liquidated where the exchange would do it, closes everything and stops', async () => {
    // a 40% loss changes nothing: there is no breaker
    mock.setPrice(ETH, '1450');
    await waitFor(() => D(equity()).lt(720), 5000, 'the equity after ETH at 1,450');
    await lookAt(DAY + 16 * H + M15);
    expect(service.view()).toMatchObject({ status: 'holding', leader: { halted: null } });
    expect(position(ETH)).toBeDefined();
    // ETH at 590: 0.78 ETH has lost about 1,100, the equity is under 0.5% of the positions
    mock.setPrice(ETH, '590');
    await waitFor(() => D(equity()).lt(5), 5000, 'the equity after ETH at 590');
    clock.now = DAY + 16 * H + M15 + 60_000;
    await service.tick();
    await waitFor(() => !position(ETH) && !position(BTC), 5000, 'every position closed');
    expect(service.view()).toMatchObject({ status: 'blocked', reason: { code: 'LIQUIDATED' } });
    await lookAt(DAY + 16 * H + 2 * M15);
    const ends = service.stateCopy().recent.slice(0, 2).map((r) => [r.instId, r.side, r.end]);
    expect(ends).toEqual(expect.arrayContaining([[ETH, 'long', 'liquidation'], [BTC, 'long', 'liquidation']]));
    // stopped for good: nothing is asked any more
    const asked = model.dossiers.length;
    model.next = { [BTC]: answer('buy', 0.1), [ETH]: answer('buy', 0.1) };
    await lookAt(DAY + 24 * H);
    expect(model.dossiers.length).toBe(asked);
    expect(records().filter((r) => r.kind === 'error').some((r) => (r.error ?? '').startsWith('liquidated: '))).toBe(true);
  });
});
