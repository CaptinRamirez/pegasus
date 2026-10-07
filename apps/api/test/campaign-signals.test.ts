/** The campaign rule read per coin (services/campaign-signals-plan.ts, campaign-signals.ts): the states, the plan and the service. */
import { describe, expect, it } from 'vitest';
import { pino } from 'pino';
import { D, DEFAULT_CAMPAIGN_PARAMS, type AccountConfig, type Balance, type CampaignView, type Candle, type Instrument, type Position, type RiskConfig, type SignalSnapshot } from '@pegasus/shared';
import { loadConfig } from '../src/config.js';
import type { AccountService } from '../src/services/account.js';
import { disabledCampaignView } from '../src/services/campaign.js';
import { CampaignSignalsService } from '../src/services/campaign-signals.js';
import { DAY_MS, evaluateCampaignSignal, followLeverage, HALF_DAY_MS, planCampaignFollow, type HeldLong, type PlanInput } from '../src/services/campaign-signals-plan.js';
import type { MarketDataService } from '../src/services/market-data.js';
import type { RiskEngine } from '../src/services/risk-engine.js';

const log = pino({ level: 'silent' });
const DAY0 = Date.UTC(2026, 8, 1);

/** 29 quiet days (high 100, low 90, close 95) and a last one; confirmed unless said otherwise. */
function days(last: Partial<Candle> = {}, count = 30): Candle[] {
  const out: Candle[] = [];
  for (let i = 0; i < count - 1; i++) out.push({ ts: DAY0 + i * DAY_MS, open: '95', high: '100', low: '90', close: '95', vol: '1', volCcy: '1', confirm: true });
  out.push({ ts: DAY0 + (count - 1) * DAY_MS, open: '95', high: '99', low: '91', close: '96', vol: '1', volCcy: '1', confirm: true, ...last });
  return out;
}

const lastDay = DAY0 + 29 * DAY_MS;
const halfDays = (close: string, ts = lastDay + DAY_MS): Candle[] => [
  { ts: ts - HALF_DAY_MS, open: '95', high: '99', low: '94', close: '96', vol: '1', volCcy: '1', confirm: true },
  { ts, open: '96', high: '110', low: '95', close, vol: '1', volCcy: '1', confirm: true },
  // the forming bar is never used
  { ts: ts + HALF_DAY_MS, open: '96', high: '300', low: '1', close: '300', vol: '1', volCcy: '1', confirm: false },
];

const held = (more: Partial<HeldLong> = {}): HeldLong => ({ contracts: '2', avgPx: '100', mgnMode: 'isolated', lever: '10', margin: '20', liqPx: '90', addRef: '100', addRefTs: lastDay, addRefSource: 'journal', tradeId: '3-LINK-USDT-SWAP', ...more });
const read = (more: Partial<Parameters<typeof evaluateCampaignSignal>[0]> = {}) => evaluateCampaignSignal({ instId: 'LINK-USDT-SWAP', daily: days(), halfDay: halfDays('96'), markPx: '96', params: DEFAULT_CAMPAIGN_PARAMS, held: null, shortContracts: null, ...more });

describe('the state of a coin', () => {
  it('entry: the last daily close above the entry level, with the signal to send', () => {
    const r = read({ daily: days({ high: '106', close: '105' }), markPx: '105.5' });
    expect(r.state).toBe('entry');
    expect(r.reasons[0]).toEqual({ code: 'CLOSE_ABOVE_ENTRY', params: { close: '105', level: '100' } });
    expect(r.levels).toEqual({ entry: '100', exit: '90', nextEntry: '106', nextExit: '90' });
    expect(r.daily).toEqual({ barTs: lastDay, closeTs: lastDay + DAY_MS, close: '105' });
    expect(r.signal).toEqual({ rule: 'campaign', kind: 'entry', barTs: lastDay, close: '105', entryLevel: '100', exitLevel: '90' });
    // unconfirmed bars are not read: the confirmed one before the forming bar is the last
    const forming = [...days({ high: '106', close: '105' }), { ts: lastDay + DAY_MS, open: '105', high: '500', low: '1', close: '1', vol: '1', volCcy: '1', confirm: false }];
    expect(read({ daily: forming, markPx: '105' }).state).toBe('entry');
  });

  it('near within 3% below the next entry level, or above it; none further away', () => {
    const near = read({ markPx: '98' });
    expect(near.state).toBe('near');
    expect(near.reasons[0]).toMatchObject({ code: 'NEAR_ENTRY', params: { level: '100', nearPct: '0.03' } });
    expect(D(near.entryDistancePct ?? '0').toFixed(4)).toBe('0.0204');
    expect(read({ markPx: '101' }).reasons[0]).toEqual({ code: 'MARK_ABOVE_ENTRY', params: { markPx: '101', level: '100' } });
    const none = read({ markPx: '90' });
    expect(none.state).toBe('none');
    expect(none.reasons[0]?.code).toBe('BELOW_ENTRY');
    expect(none.signal).toBeNull();
    // without a mark: no distance, never near
    expect(read({ markPx: null })).toMatchObject({ state: 'none', entryDistancePct: null });
    expect(read({ markPx: null }).reasons.map((r) => r.code)).toContain('NO_MARK_PRICE');
  });

  it('holding: exit below the exit level first, then an add at the trigger, then holding with the trailing line', () => {
    const exit = read({ daily: days({ low: '84', close: '85' }), held: held() });
    expect(exit.state).toBe('exit');
    expect(exit.reasons[0]).toEqual({ code: 'CLOSE_BELOW_EXIT', params: { close: '85', level: '90' } });
    // the exit wins over an add that is due at the same time
    expect(read({ daily: days({ low: '84', close: '85' }), halfDay: halfDays('106'), held: held() }).state).toBe('exit');

    const add = read({ halfDay: halfDays('106'), held: held() });
    expect(add.state).toBe('add');
    expect(add.reasons[0]).toEqual({ code: 'ADD_TRIGGER_REACHED', params: { close: '106', trigger: '105', addRef: '100', barTs: lastDay + DAY_MS } });
    expect(add.signal).toEqual({ rule: 'campaign', kind: 'add', barTs: lastDay + DAY_MS, close: '106', entryLevel: '100', exitLevel: '90' });
    expect(add.holding).toMatchObject({ trailingLine: '90', addTrigger: '105', addRef: '100', tradeId: '3-LINK-USDT-SWAP' });
    // a 12-hour close before the last opening fill does not count
    expect(read({ halfDay: halfDays('106'), held: held({ addRefTs: lastDay + DAY_MS + HALF_DAY_MS }) }).state).toBe('holding');

    const holding = read({ halfDay: halfDays('103'), held: held() });
    expect(holding.state).toBe('holding');
    expect(holding.reasons[0]).toEqual({ code: 'HOLDING', params: { contracts: '2', trailingLine: '90', addTrigger: '105' } });
    // the noadd structure never adds
    const noadd = read({ halfDay: halfDays('106'), held: held(), params: { ...DEFAULT_CAMPAIGN_PARAMS, structure: 'noadd' } });
    expect(noadd.state).toBe('holding');
    expect(noadd.holding?.addTrigger).toBeNull();
    expect(noadd.reasons.map((r) => r.code)).toContain('ADDS_OFF');
    // an add reference from the position when the journal has none
    expect(read({ held: held({ addRefSource: 'position', addRefTs: null }) }).reasons.map((r) => r.code)).toContain('ADD_REF_FROM_POSITION');
  });

  it('is unavailable with too few confirmed bars; a short held is said, not counted as holding', () => {
    expect(read({ daily: days({}, 15) })).toMatchObject({ state: 'unavailable', reasons: [{ code: 'NOT_ENOUGH_BARS', params: { have: 15, need: 21 } }] });
    const short = read({ shortContracts: '4', markPx: '90' });
    expect(short.state).toBe('none');
    expect(short.reasons).toContainEqual({ code: 'SHORT_HELD', params: { contracts: '4' } });
  });
});

const LINK: Instrument = { instId: 'LINK-USDT-SWAP', instType: 'SWAP', uly: 'LINK-USDT', baseCcy: 'LINK', quoteCcy: 'USDT', settleCcy: 'USDT', ctVal: '1', ctValCcy: 'LINK', ctMult: '1', ctType: 'linear', lotSz: '1', minSz: '1', tickSz: '0.001', maxLmtSz: '100000', maxMktSz: '10000', maxLever: '50', state: 'live' };
const RISK: RiskConfig = { maxOrderNotional: '5000', maxPositionNotionalPerInstrument: '20000', maxTotalPositionNotional: '50000', maxLeverage: '10', dailyLossLimit: '1000', maxOpenOrders: 20, priceBandPct: '0.05', maxSlippagePct: '0.005' };
const SIGNAL: SignalSnapshot = { rule: 'campaign', kind: 'entry', barTs: lastDay, close: '99', entryLevel: '98', exitLevel: '90' };

const plan = (more: Partial<PlanInput> = {}) =>
  planCampaignFollow({
    kind: 'entry',
    inst: LINK,
    markPx: '100',
    stopPx: '92',
    signal: SIGNAL,
    signalCloseTs: lastDay + DAY_MS,
    barMs: DAY_MS,
    equity: '1000',
    riskPct: '0.01',
    params: DEFAULT_CAMPAIGN_PARAMS,
    risk: RISK,
    instrumentNotional: '0',
    totalNotional: '0',
    held: null,
    now: lastDay + DAY_MS + 3_600_000,
    tracked: true,
    campaignAccount: false,
    killSwitch: false,
    ...more,
  });

describe('the plan to follow a signal', () => {
  it('sizes the risk to the stop in whole lots, at the highest leverage that keeps the liquidation below the stop', () => {
    const p = plan();
    // 1% of 1000 = 10 over 8 a contract: 1.25, one whole lot
    expect(p).toMatchObject({ kind: 'entry', side: 'buy', tdMode: 'isolated', entryPx: '100', stopPx: '92', stopDistance: '8', stopDistancePct: '0.08', riskTarget: '10', riskAmount: '8', riskContracts: '1', contracts: '1', coin: '1', notional: '100', leverage: '10', margin: '10', maintenanceRate: '0.007', takeProfits: [], after: null, signal: SIGNAL });
    expect(p.trailing).toEqual({ kind: 'channel', bars: 10 });
    // the contract's spec travels with the plan, for a coin the terminal does not track
    expect(p.spec).toBe(LINK);
    // (100 - 10) / (1 - 0.007)
    expect(D(p.liqPx ?? '0').toFixed(3)).toBe('90.634');
    expect(p.warnings).toEqual([]);
  });

  it('cuts the leverage when the stop is far: the liquidation stays 1% of the stop below it', () => {
    // 9%: at 10x the liquidation (90.63) is above 91 x 0.99 = 90.09; at 9x it is 89.52
    const p = plan({ stopPx: '91' });
    expect(p.leverage).toBe('9');
    expect(D(p.liqPx ?? '0').lte(D('91').mul('0.99'))).toBe(true);
    // the warning names both liquidation prices, the stop and the line the liquidation must stay below
    const reduced = p.warnings.find((w) => w.code === 'LEVERAGE_REDUCED');
    expect(reduced?.params).toMatchObject({ leverage: 9, maxLeverage: 10, stopPx: '91', limitPx: '90.09' });
    expect(D(reduced?.params['liqPxAtMax'] ?? '0').toFixed(3)).toBe('90.634');
    // (100 - 100 / 9) / (1 - 0.007)
    expect(D(reduced?.params['liqPx'] ?? '0').toFixed(3)).toBe('89.515');
    expect(reduced?.params['liqPx']).toBe(p.liqPx);
    // never more than RISK_MAX_LEVERAGE or the instrument's maximum
    expect(plan({ risk: { ...RISK, maxLeverage: '5' } }).leverage).toBe('5');
    expect(plan({ inst: { ...LINK, maxLever: '3' } }).leverage).toBe('3');
    // the search on its own: a 30% stop leaves 3x
    const wide = followLeverage(D('100'), D('70'), 10, '0.007');
    expect(wide.leverage).toBe(3);
    expect(wide.liqPx.lte(D('70').mul('0.99'))).toBe(true);
    // a narrow stop leaves the full leverage; a stop 95% away only 1x
    expect(followLeverage(D('100'), D('99.5'), 10, '0.007').leverage).toBe(10);
    expect(followLeverage(D('100'), D('5'), 10, '0.007')).toMatchObject({ leverage: 1 });
  });

  it('warns about the stop, the minimum order, the risk limits, a stale signal, a price far above it, and the account', () => {
    const codes = (p: ReturnType<typeof plan>) => p.warnings.map((w) => w.code);
    expect(codes(plan({ stopPx: '70' }))).toContain('STOP_TOO_WIDE');
    const narrow = plan({ stopPx: '99' });
    expect(codes(narrow)).toContain('STOP_TOO_NARROW');
    expect(narrow.contracts).toBe('10');
    const small = plan({ equity: '100' });
    expect(small).toMatchObject({ contracts: '1', riskAmount: '8' });
    expect(small.warnings).toContainEqual({ code: 'BELOW_MIN_ORDER', params: { sized: '0', minSz: '1', riskAmount: '8' } });
    // a limit that leaves no room for even the minimum order: no size, as without a stop
    const over = plan({ risk: { ...RISK, maxOrderNotional: '50' } });
    expect(over).toMatchObject({ riskContracts: '1', contracts: null, notional: null, margin: null });
    // the minimum order counted as the room is: at the mark plus the slippage the engine tolerates
    expect(over.warnings).toContainEqual({ code: 'OVER_ORDER_NOTIONAL', params: { notional: '100.5', limit: '50' } });
    // a plan without a size does not also say it holds the minimum
    expect(codes(over)).not.toContain('BELOW_MIN_ORDER');
    expect(plan({ instrumentNotional: '19950' }).warnings).toContainEqual({ code: 'OVER_POSITION_NOTIONAL', params: { projected: '20050.5', limit: '20000' } });
    expect(codes(plan({ totalNotional: '49990' }))).toContain('OVER_TOTAL_NOTIONAL');
    expect(plan({ now: lastDay + 2 * DAY_MS + 1 }).warnings[0]).toMatchObject({ code: 'SIGNAL_STALE', params: { barTs: lastDay, closedAt: lastDay + DAY_MS } });
    expect(plan({ signal: { ...SIGNAL, close: '94' } }).warnings).toContainEqual({ code: 'PRICE_FAR_ABOVE_SIGNAL', params: { markPx: '100', close: '94', risePct: '0.0638297872340426', limit: '0.05' } });
    expect(codes(plan({ tracked: false, campaignAccount: true, killSwitch: true }))).toEqual(['NOT_TRACKED', 'CAMPAIGN_ACCOUNT', 'KILL_SWITCH']);
    // no equity: no size, the leverage and the liquidation still
    const unknown = plan({ equity: null });
    expect(unknown).toMatchObject({ contracts: null, riskTarget: null, notional: null, margin: null, leverage: '10' });
    expect(codes(unknown)).toContain('EQUITY_UNKNOWN');
    expect(unknown.liqPx).not.toBeNull();
    // a mark at or below the exit line: nothing to size with
    expect(plan({ stopPx: '100' })).toMatchObject({ contracts: null, warnings: [{ code: 'STOP_NOT_BELOW_ENTRY', params: { stopPx: '100', entryPx: '100' } }] });
  });

  it('cuts the size to what the risk limits allow, each contract valued at the mark plus the slippage the engine tolerates', () => {
    // 1% of 10,000 = 100 over 8 a contract: 12 contracts; the per-order limit 500 over 100 x 1.005 a contract: 4.97, so 4
    const p = plan({ equity: '10000', risk: { ...RISK, maxOrderNotional: '500' } });
    expect(p).toMatchObject({ riskTarget: '100', riskContracts: '12', contracts: '4', coin: '4', notional: '400', riskAmount: '32', margin: '40' });
    expect(p.warnings).toContainEqual({ code: 'LIMITED_BY_ORDER_NOTIONAL', params: { riskContracts: '12', contracts: '4', notional: '400', limit: '500', riskAmount: '32', perContract: '100.5', slippagePct: '0.005' } });
    expect(p.warnings.map((w) => w.code)).not.toContain('OVER_ORDER_NOTIONAL');
    // the coin's limit less what is held on it, and the total less what is held
    const coin = plan({ equity: '10000', instrumentNotional: '19300' });
    expect(coin).toMatchObject({ riskContracts: '12', contracts: '6' });
    expect(coin.warnings).toContainEqual({ code: 'LIMITED_BY_POSITION_NOTIONAL', params: { riskContracts: '12', contracts: '6', notional: '600', limit: '20000', riskAmount: '48', perContract: '100.5', slippagePct: '0.005' } });
    const total = plan({ equity: '10000', totalNotional: '49000' });
    expect(total).toMatchObject({ contracts: '9' });
    expect(total.warnings.map((w) => w.code)).toContain('LIMITED_BY_TOTAL_NOTIONAL');
    // the tightest limit speaks; within every limit nothing is said
    expect(plan({ equity: '10000', risk: { ...RISK, maxOrderNotional: '500' }, totalNotional: '49000' }).warnings.map((w) => w.code)).toEqual(['LIMITED_BY_ORDER_NOTIONAL']);
    expect(plan({ equity: '10000' })).toMatchObject({ riskContracts: '12', contracts: '12', warnings: [] });
    // an add is cut the same way, on top of what the position holds
    const add = plan({ kind: 'add', equity: '10000', held: held({ contracts: '2', avgPx: '90', margin: '18', lever: '10' }), signal: { ...SIGNAL, kind: 'add' }, instrumentNotional: '19300' });
    expect(add).toMatchObject({ contracts: '6', after: { contracts: '8' } });
  });

  it("an add posts at the position's leverage and estimates the position after it", () => {
    const p = plan({ kind: 'add', held: held({ contracts: '2', avgPx: '90', margin: '18', lever: '10' }), signal: { ...SIGNAL, kind: 'add' }, signalCloseTs: lastDay + DAY_MS, barMs: HALF_DAY_MS });
    expect(p).toMatchObject({ kind: 'add', contracts: '1', leverage: '10', margin: '10' });
    expect(p.after).toMatchObject({ contracts: '3', margin: '28' });
    expect(D(p.after?.avgPx ?? '0').toFixed(3)).toBe('93.333');
    // (3 x 93.333 - 28) / (3 x 0.993)
    expect(D(p.liqPx ?? '0').toFixed(2)).toBe('84.59');
    expect(p.warnings).toEqual([]);
    // the leverage set high posts little margin: the position's liquidation comes up to the stop
    const thin = plan({ kind: 'add', held: held({ contracts: '2', avgPx: '90', margin: '3.6', lever: '50' }), signal: { ...SIGNAL, kind: 'add' } });
    expect(thin.leverage).toBe('50');
    expect(thin.warnings.map((w) => w.code)).toContain('LIQUIDATION_NEAR_STOP');
    // a cross position: no liquidation estimate
    expect(plan({ kind: 'add', held: held({ mgnMode: 'cross', lever: '3' }), signal: { ...SIGNAL, kind: 'add' } })).toMatchObject({ liqPx: null, after: { margin: null, liqPx: null } });
  });
});

describe('the campaign signals service', () => {
  const config = loadConfig({ CAMPAIGN_INSTRUMENTS: 'BTC-USDT-SWAP,LINK-USDT-SWAP,DOT-USDT-SWAP' });
  const BTC: Instrument = { ...LINK, instId: 'BTC-USDT-SWAP', baseCcy: 'BTC', ctVal: '0.01', lotSz: '0.01', minSz: '0.01', tickSz: '0.1', maxLever: '100' };

  function setup(more: { positions?: Position[]; balance?: Balance | null; campaign?: { view(): CampaignView } } = {}) {
    let barReads = 0;
    const daily: Record<string, Candle[]> = { 'BTC-USDT-SWAP': days({ high: '106', close: '105' }), 'LINK-USDT-SWAP': days() };
    const market = {
      getInstrument: (id: string) => (id === 'BTC-USDT-SWAP' ? BTC : undefined),
      liveMarkPrice: (id: string) => (id === 'BTC-USDT-SWAP' ? '105.2' : undefined),
      specOf: (id: string) => (id === 'BTC-USDT-SWAP' ? BTC : id === 'LINK-USDT-SWAP' ? LINK : undefined),
    } as unknown as MarketDataService;
    const account = {
      balance: more.balance === undefined ? { totalEq: '2000', details: [], ts: 1 } : more.balance,
      config: { posMode: 'net_mode', acctLv: '2', canTrade: true } as AccountConfig,
      positionList: () => more.positions ?? [],
      totalPositionNotional: () => '0',
    } as unknown as AccountService;
    const risk = { config: RISK, state: { killSwitch: false } } as unknown as RiskEngine;
    let now = lastDay + DAY_MS + 60_000;
    const service = new CampaignSignalsService(
      {
        config,
        clients: { rest: { getInstruments: async () => [] } } as never,
        market,
        account,
        risk,
        journal: { lastOpening: () => ({ tradeId: '7-LINK-USDT-SWAP', px: '96', ts: lastDay }) },
        campaign: more.campaign,
        disabledView: () => disabledCampaignView(config.campaign),
        log,
      },
      {
        now: () => now,
        bars: {
          daily: async (id) => {
            if (id === 'BTC-USDT-SWAP') barReads++;
            const bars = daily[id];
            if (!bars) throw new Error(`no bars for ${id}`);
            return bars;
          },
          halfDay: async () => halfDays('96'),
        },
        marks: async (ids) => new Map(ids.filter((id) => id === 'LINK-USDT-SWAP').map((id) => [id, '96.5'])),
      },
    );
    return { service, reads: () => barReads, advance: (ms: number) => (now += ms) };
  }

  it('one row per campaign coin in the configured order, with a plan for an entry sized on the account equity', async () => {
    const { service } = setup();
    const res = await service.report();
    expect(res.rows.map((r) => [r.instId, r.state, r.tracked])).toEqual([
      ['BTC-USDT-SWAP', 'entry', true],
      ['LINK-USDT-SWAP', 'none', false],
      ['DOT-USDT-SWAP', 'unavailable', false],
    ]);
    expect(res).toMatchObject({ riskPct: '0.01', equity: '2000', equitySource: 'account', campaign: { enabled: false, status: 'disabled', ownAccount: false } });
    expect(res.params).toEqual({ entryChannel: 20, exitChannel: 10, addStep: '0.05', structure: 'pyramid', leverage: '10', feeRate: '0.0005' });
    expect(res.thresholds).toEqual({ nearPct: '0.03', stopWidePct: '0.2', stopNarrowPct: '0.02', farAbovePct: '0.05', liqBufferPct: '0.01' });
    const btc = res.rows[0];
    expect(btc?.markPx).toBe('105.2');
    // 1% of 2000 over (105.2 - 90) x 0.01 coin a contract: 131.578... contracts, 131.57 in lots of 0.01
    expect(btc?.plan).toMatchObject({ kind: 'entry', entryPx: '105.2', stopPx: '90', contracts: '131.57', riskTarget: '20', notional: '138.41164' });
    expect(btc?.plan?.signal).toEqual(btc?.signal);
    expect(res.rows[1]?.markPx).toBe('96.5');
    expect(res.rows[2]?.reasons[0]).toMatchObject({ code: 'BARS_UNAVAILABLE' });
    // the request's equity and risk win
    const asked = await service.report({ equity: '500', riskPct: '0.02' });
    expect(asked).toMatchObject({ equity: '500', equitySource: 'request', riskPct: '0.02' });
    expect(asked.rows[0]?.plan?.riskTarget).toBe('10');
  });

  it('a held long: holding with the add reference of the journal; the campaign on this account is said and warned', async () => {
    const position: Position = { instId: 'LINK-USDT-SWAP', posSide: 'net', mgnMode: 'isolated', pos: '5', avgPx: '95', markPx: '96.5', upl: '7.5', uplRatio: '0.1', lever: '10', liqPx: '86', margin: '47.5', notionalUsd: '482.5', cTime: lastDay, uTime: lastDay };
    const running = { ...disabledCampaignView(config.campaign), status: 'running' as const, reason: null };
    const { service } = setup({ positions: [position], campaign: { view: () => running } });
    const res = await service.report();
    expect(res.campaign).toEqual({ enabled: true, status: 'running', ownAccount: true });
    const link = res.rows[1];
    expect(link?.state).toBe('holding');
    expect(link?.holding).toMatchObject({ contracts: '5', addRef: '96', addRefSource: 'journal', addTrigger: '100.8', trailingLine: '90', tradeId: '7-LINK-USDT-SWAP' });
    expect(res.rows[0]?.plan?.warnings.map((w) => w.code)).toContain('CAMPAIGN_ACCOUNT');
  });

  it('reads the bars again only after their cache time or across a close; no equity is said', async () => {
    const { service, reads, advance } = setup({ balance: null });
    const first = await service.report();
    expect(first).toMatchObject({ equity: null, equitySource: null });
    expect(first.rows[0]?.plan?.warnings.map((w) => w.code)).toContain('EQUITY_UNKNOWN');
    const n = reads();
    await service.report();
    expect(reads()).toBe(n);
    advance(6 * 60_000);
    await service.report();
    expect(reads()).toBeGreaterThan(n);
  });
});
