import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { pino } from 'pino';
import type { Instrument, Order, Position, RiskConfig } from '@pegasus/shared';
import { MemoryStore } from '../src/db/store.js';
import { RiskEngine, type RiskCheckInput } from '../src/services/risk-engine.js';

const log = pino({ level: 'silent' });

const BTC: Instrument = {
  instId: 'BTC-USDT-SWAP', instType: 'SWAP', uly: 'BTC-USDT', baseCcy: 'BTC', quoteCcy: 'USDT', settleCcy: 'USDT',
  ctVal: '0.01', ctValCcy: 'BTC', ctMult: '1', ctType: 'linear', lotSz: '0.1', minSz: '0.1', tickSz: '0.1',
  maxLmtSz: '100000', maxMktSz: '12000', maxLever: '100', state: 'live',
};

const config: RiskConfig = {
  maxOrderNotional: '5000',
  maxPositionNotionalPerInstrument: '20000',
  maxTotalPositionNotional: '30000',
  maxLeverage: '10',
  dailyLossLimit: '1000',
  maxOpenOrders: 3,
  priceBandPct: '0.05',
  maxSlippagePct: '0.005',
};

function position(instId: string, notionalUsd: string, posSide: Position['posSide'] = 'net', pos = '1'): Position {
  return { instId, posSide, mgnMode: 'cross', pos, avgPx: '50000', markPx: '50000', upl: '0', uplRatio: '0', lever: '5', liqPx: '', margin: '0', notionalUsd, cTime: 0, uTime: 0 };
}

const ETH: Instrument = { ...BTC, instId: 'ETH-USDT-SWAP', uly: 'ETH-USDT', baseCcy: 'ETH', ctVal: '0.1', ctValCcy: 'ETH', tickSz: '0.01' };
const INSTRUMENTS = new Map([[BTC.instId, BTC], [ETH.instId, ETH]]);

function resting(instId: string, side: Order['side'], px: string, sz: string, overrides: Partial<Order> = {}): Order {
  return {
    ordId: `o-${instId}-${px}-${side}`, clOrdId: '', instId, side, posSide: 'net', tdMode: 'cross', ordType: 'limit', px, sz, accFillSz: '0', avgPx: '',
    state: 'live', reduceOnly: false, lever: '5', fee: '0', feeCcy: '', pnl: '0', cTime: 0, uTime: 0, ...overrides,
  };
}

function input(overrides: Partial<RiskCheckInput> = {}): RiskCheckInput {
  return {
    inst: BTC, side: 'buy', posSide: 'net', ordType: 'limit', contracts: '2', notional: '1000', px: '50000', refPrice: '50000', lever: '5',
    estSlippagePct: '', reduceOnly: false, positions: [], openOrders: [], reservations: [], instrumentOf: (id) => INSTRUMENTS.get(id), ...overrides,
  };
}

describe('RiskEngine.check', () => {
  const engine = () => new RiskEngine(config, new MemoryStore(), log, () => Date.UTC(2026, 0, 1, 12));

  it('passes a plain order', () => {
    expect(engine().check(input()).ok).toBe(true);
  });
  it('rejects when the kill switch is on, but lets exits through', () => {
    const e = engine();
    e.setKillSwitch(true, 'test');
    expect(e.check(input()).code).toBe('KILL_SWITCH');
    // net mode: reduce-only exits pass; long/short mode: the closing direction passes
    expect(e.check(input({ reduceOnly: true, side: 'sell' })).ok).toBe(true);
    expect(e.check(input({ posSide: 'long', side: 'sell' })).ok).toBe(true);
    expect(e.check(input({ posSide: 'short', side: 'buy' })).ok).toBe(true);
    expect(e.check(input({ posSide: 'long', side: 'buy' })).code).toBe('KILL_SWITCH');
    // exits still go through the fat-finger band
    expect(e.check(input({ reduceOnly: true, side: 'sell', px: '40000' })).code).toBe('PRICE_BAND');
    e.setKillSwitch(false, '');
    expect(e.check(input()).ok).toBe(true);
  });
  it('enforces the per-order notional', () => {
    expect(engine().check(input({ notional: '5000.01' })).code).toBe('MAX_ORDER_NOTIONAL');
    expect(engine().check(input({ notional: '5000' })).ok).toBe(true);
  });
  it('enforces leverage', () => {
    expect(engine().check(input({ lever: '20' })).code).toBe('MAX_LEVERAGE');
  });
  it('enforces open order count for resting orders only', () => {
    const three = [resting('BTC-USDT-SWAP', 'buy', '49000', '0.1'), resting('BTC-USDT-SWAP', 'buy', '48000', '0.1'), resting('BTC-USDT-SWAP', 'buy', '47000', '0.1')];
    expect(engine().check(input({ openOrders: three })).code).toBe('MAX_OPEN_ORDERS');
    expect(engine().check(input({ openOrders: three, ordType: 'market', px: '' })).ok).toBe(true);
  });
  it('counts the unfilled size of resting orders as exposure', () => {
    // 19,000 USD of resting buys + 1,000 USD of positions + this 1,000 USD order -> 21,000 > 20,000
    const orders = [resting('BTC-USDT-SWAP', 'buy', '50000', '38')]; // 38 contracts * 0.01 BTC * 50,000 = 19,000
    const positions = [position('BTC-USDT-SWAP', '1000')];
    expect(engine().check(input({ notional: '1000', openOrders: orders, positions })).code).toBe('MAX_POSITION_NOTIONAL');
    // half filled: 19 contracts remain -> 9,500 + 1,000 + 1,000 = 11,500 -> ok
    const half = [resting('BTC-USDT-SWAP', 'buy', '50000', '38', { accFillSz: '19' })];
    expect(engine().check(input({ notional: '1000', openOrders: half, positions })).ok).toBe(true);
    // resting sells do not offset a long in net mode: they may never fill, so the buy is judged without them
    const sells = [resting('BTC-USDT-SWAP', 'sell', '50000', '38')];
    expect(engine().check(input({ notional: '1000', openOrders: sells, positions: [position('BTC-USDT-SWAP', '19500')] })).code).toBe('MAX_POSITION_NOTIONAL');
    expect(engine().check(input({ notional: '500', openOrders: sells, positions: [position('BTC-USDT-SWAP', '19500')] })).ok).toBe(true);
    // other instruments count towards the total with their own contract value
    const ethOrders = [resting('ETH-USDT-SWAP', 'buy', '3000', '95')]; // 95 * 0.1 ETH * 3000 = 28,500
    expect(engine().check(input({ notional: '1000', openOrders: ethOrders, positions: [position('BTC-USDT-SWAP', '1000')] })).code).toBe('MAX_TOTAL_NOTIONAL');
  });
  it('long/short mode: legs are gross, opening adds to a leg, closing never reduces the other leg', () => {
    const hedged = [position('BTC-USDT-SWAP', '12000', 'long', '24'), position('BTC-USDT-SWAP', '7500', 'short', '15')];
    // gross 19,500 + opening long 1,000 -> 20,500 > 20,000
    expect(engine().check(input({ notional: '1000', side: 'buy', posSide: 'long', positions: hedged })).code).toBe('MAX_POSITION_NOTIONAL');
    // opening a short of 1,000 also grows gross exposure
    expect(engine().check(input({ notional: '1000', side: 'sell', posSide: 'short', positions: hedged })).code).toBe('MAX_POSITION_NOTIONAL');
    // closing part of the long reduces it: 11,000 + 7,500 -> ok
    expect(engine().check(input({ notional: '1000', side: 'sell', posSide: 'long', positions: hedged })).ok).toBe(true);
    // over-closing clamps at zero rather than going negative (order stays under the per-order cap)
    const smallLong = [position('BTC-USDT-SWAP', '3000', 'long', '6'), position('BTC-USDT-SWAP', '7500', 'short', '15')];
    expect(engine().check(input({ notional: '4000', side: 'sell', posSide: 'long', positions: smallLong })).ok).toBe(true);
    // resting opening orders on a leg count; closing orders do not
    const restingOpen = [resting('BTC-USDT-SWAP', 'buy', '50000', '2', { posSide: 'long' })]; // 1,000
    expect(engine().check(input({ notional: '500', side: 'buy', posSide: 'long', positions: hedged, openOrders: restingOpen })).code).toBe('MAX_POSITION_NOTIONAL');
    const restingClose = [resting('BTC-USDT-SWAP', 'sell', '50000', '2', { posSide: 'long' })];
    expect(engine().check(input({ notional: '400', side: 'buy', posSide: 'long', positions: hedged, openOrders: restingClose })).ok).toBe(true);
  });
  it('net mode: projects the worst case of each side, so a resting sell never makes room for more buys', () => {
    const positions = [position('BTC-USDT-SWAP', '15000')];
    const sell = [resting('BTC-USDT-SWAP', 'sell', '50000', '40')]; // 20,000 resting on the other side
    // long 15,000 + this buy 5,000 = 20,000 -> at the limit
    expect(engine().check(input({ notional: '5000', openOrders: sell, positions })).ok).toBe(true);
    const moreBuys = [...sell, resting('BTC-USDT-SWAP', 'buy', '49000', '10')]; // + 4,900 resting buys
    const res = engine().check(input({ notional: '1000', openOrders: moreBuys, positions }));
    expect(res.code).toBe('MAX_POSITION_NOTIONAL');
    expect(res.details).toMatchObject({ current: '19900.00', projected: '20900.00' });
    // the short side is judged the same way: -15,000 + resting sells 20,000 + this sell 4,000 = 9,000
    expect(engine().check(input({ notional: '4000', side: 'sell', openOrders: sell, positions })).ok).toBe(true);
    // ... and with 12,240 more resting sells it is 21,240
    expect(engine().check(input({ notional: '4000', side: 'sell', openOrders: [...sell, resting('BTC-USDT-SWAP', 'sell', '51000', '24')], positions })).code).toBe('MAX_POSITION_NOTIONAL');
  });
  it('fails closed when the contract value of a resting opening order is unknown', () => {
    const foreign = [resting('PEPE-USDT-SWAP', 'buy', '0.00001', '1000')];
    const res = engine().check(input({ openOrders: foreign }));
    expect(res).toMatchObject({ ok: false, code: 'EXPOSURE_UNKNOWN', details: { instId: 'PEPE-USDT-SWAP' } });
    // an exit on that instrument adds no exposure, so it does not need the spec
    expect(engine().check(input({ openOrders: [resting('PEPE-USDT-SWAP', 'sell', '0.00001', '1000', { reduceOnly: true })] })).ok).toBe(true);
    expect(engine().check(input({ posSide: 'long', openOrders: [resting('PEPE-USDT-SWAP', 'sell', '0.00001', '1000', { posSide: 'long' })] })).ok).toBe(true);
    // with the spec it is counted like any other instrument: 1000 * 10^7 * 0.00001 = 100,000
    const PEPE: Instrument = { ...BTC, instId: 'PEPE-USDT-SWAP', ctVal: '10000000', ctValCcy: 'PEPE', tickSz: '0.000000001' };
    const known = input({ openOrders: foreign, instrumentOf: (id) => (id === PEPE.instId ? PEPE : INSTRUMENTS.get(id)) });
    expect(engine().check(known).code).toBe('MAX_TOTAL_NOTIONAL');
  });
  it('long/short mode: a resting exit on another instrument adds no exposure', () => {
    const positions = [position('ETH-USDT-SWAP', '20000', 'long', '66')];
    const takeProfit = [resting('ETH-USDT-SWAP', 'sell', '3100', '66', { posSide: 'long' })]; // 20,460 if it were counted
    expect(engine().check(input({ notional: '5000', posSide: 'long', positions, openOrders: takeProfit })).ok).toBe(true);
    // a resting opening order on the other instrument still counts: 20,000 + 9,000 + 5,000 > 30,000
    const opening = [resting('ETH-USDT-SWAP', 'buy', '3000', '30', { posSide: 'long' })];
    expect(engine().check(input({ notional: '5000', posSide: 'long', positions, openOrders: opening })).code).toBe('MAX_TOTAL_NOTIONAL');
  });
  it('counts accepted orders the mirror does not show yet (reservations)', () => {
    const reserved = (overrides: Partial<RiskCheckInput['reservations'][number]> = {}) => ({ clOrdId: 'c1', instId: 'BTC-USDT-SWAP', side: 'buy' as const, posSide: 'net' as const, notional: '19500', ...overrides });
    expect(engine().check(input({ notional: '1000', reservations: [reserved()] })).code).toBe('MAX_POSITION_NOTIONAL');
    expect(engine().check(input({ notional: '500', reservations: [reserved()] })).ok).toBe(true);
    // long/short mode: the reservation sits on its own leg and the legs are gross
    expect(engine().check(input({ notional: '1000', posSide: 'short', side: 'sell', reservations: [reserved({ posSide: 'long' })] })).code).toBe('MAX_POSITION_NOTIONAL');
    // another instrument: it counts towards the total only
    expect(engine().check(input({ notional: '5000', reservations: [reserved({ instId: 'ETH-USDT-SWAP', notional: '26000' })] })).code).toBe('MAX_TOTAL_NOTIONAL');
    // once the order rests in the mirror only the part that is no longer resting stays reserved
    const mirrored = [resting('BTC-USDT-SWAP', 'buy', '50000', '39', { clOrdId: 'c1', accFillSz: '19' })]; // 10,000 still resting of 19,500
    const res = engine().check(input({ notional: '1000', openOrders: mirrored, reservations: [reserved()] }));
    expect(res.details).toMatchObject({ current: '19500.00', projected: '20500.00' });
  });
  it('enforces the price band against the reference price', () => {
    expect(engine().check(input({ px: '52600', refPrice: '50000' })).code).toBe('PRICE_BAND');
    expect(engine().check(input({ px: '52400', refPrice: '50000' })).ok).toBe(true);
    expect(engine().check(input({ px: '47400', refPrice: '50000' })).code).toBe('PRICE_BAND');
  });
  it('enforces market slippage', () => {
    expect(engine().check(input({ ordType: 'market', px: '', estSlippagePct: '0.006' })).code).toBe('MAX_SLIPPAGE');
    expect(engine().check(input({ ordType: 'market', px: '', estSlippagePct: '0.004' })).ok).toBe(true);
  });
  it('projects per-instrument exposure in the order direction', () => {
    const positions = [position('BTC-USDT-SWAP', '19500')];
    expect(engine().check(input({ notional: '1000', positions })).code).toBe('MAX_POSITION_NOTIONAL');
    // selling reduces a long: projected |19500 - 1000| = 18500 -> ok
    expect(engine().check(input({ notional: '1000', side: 'sell', positions })).ok).toBe(true);
    // a short position (net mode, negative pos) counts as negative exposure
    const short = [position('BTC-USDT-SWAP', '19500', 'net', '-1')];
    expect(engine().check(input({ notional: '1000', side: 'buy', positions: short })).ok).toBe(true);
    expect(engine().check(input({ notional: '1000', side: 'sell', positions: short })).code).toBe('MAX_POSITION_NOTIONAL');
  });
  it('projects total exposure across instruments', () => {
    const positions = [position('ETH-USDT-SWAP', '15000'), position('BTC-USDT-SWAP', '14500')];
    expect(engine().check(input({ notional: '1000', positions })).code).toBe('MAX_TOTAL_NOTIONAL');
    expect(engine().check(input({ notional: '500', positions })).ok).toBe(true);
  });
  it('skips exposure and notional limits for reduce-only orders', () => {
    const positions = [position('BTC-USDT-SWAP', '19500')];
    expect(engine().check(input({ notional: '5000', side: 'sell', reduceOnly: true, positions })).ok).toBe(true);
    expect(engine().check(input({ notional: '9000', side: 'sell', reduceOnly: true, positions })).ok).toBe(true);
    // closing a hedged leg is also exempt
    expect(engine().check(input({ notional: '9000', side: 'sell', posSide: 'long', positions: [position('BTC-USDT-SWAP', '19500', 'long', '39')] })).ok).toBe(true);
  });
});

describe('RiskEngine.updateExposure: positions that have outgrown the limits', () => {
  const engine = () => new RiskEngine(config, new MemoryStore(), log, () => Date.UTC(2026, 0, 1, 12));
  const instrumentOf = (id: string): Instrument | undefined => INSTRUMENTS.get(id);
  const total = (positions: Position[]): string => positions.reduce((acc, p) => acc + Math.abs(Number(p.notionalUsd || '0')), 0).toString();
  const feed = (e: RiskEngine, positions: Position[], totalNotional = total(positions)): void => e.updateExposure(0, totalNotional, positions, instrumentOf);

  it('starts with nothing over the limit, and a position at the limit is not over it', () => {
    const e = engine();
    expect(e.state.overLimit).toEqual([]);
    expect(e.state.totalOverLimit).toBe('');
    feed(e, [position(BTC.instId, '20000'), position(ETH.instId, '10000')]);
    expect(e.state.overLimit).toEqual([]);
    expect(e.state.totalOverLimit).toBe('');
  });

  it('lists an instrument whose position grew past the per-instrument limit, long or short, and fans it out', () => {
    const e = engine();
    const states: string[] = [];
    e.on('state', (s) => states.push(JSON.stringify(s.overLimit)));
    feed(e, [position(BTC.instId, '26500.5'), position(ETH.instId, '-21000', 'net', '-1')]);
    expect(e.state.overLimit).toEqual([
      { instId: BTC.instId, notional: '26500.5', limit: '20000', excess: '6500.5' },
      { instId: ETH.instId, notional: '21000', limit: '20000', excess: '1000' },
    ]);
    expect(states).toHaveLength(1);
    expect(states[0]).toContain('6500.5');
    // trimmed back: the entry goes away
    feed(e, [position(BTC.instId, '20000')]);
    expect(e.state.overLimit).toEqual([]);
  });

  it('long/short mode counts the gross of both legs, like the pre-trade rule', () => {
    const e = engine();
    feed(e, [position(BTC.instId, '12000', 'long', '24'), position(BTC.instId, '11000', 'short', '22')]);
    expect(e.state.overLimit).toEqual([{ instId: BTC.instId, notional: '23000', limit: '20000', excess: '3000' }]);
  });

  it('values a position without a reported notional at its mark price; resting orders are not counted', () => {
    const e = engine();
    // 50 contracts x 0.01 BTC x 50,000 = 25,000
    e.updateExposure(3, '0', [position(BTC.instId, '', 'net', '50')], instrumentOf);
    expect(e.state.openOrders).toBe(3);
    expect(e.state.overLimit).toEqual([{ instId: BTC.instId, notional: '25000', limit: '20000', excess: '5000' }]);
  });

  it('reports the excess of the total over the total limit', () => {
    const e = engine();
    feed(e, [position(BTC.instId, '18000'), position(ETH.instId, '-15000.25', 'net', '-1')]);
    expect(e.state.overLimit).toEqual([]);
    expect(e.state.totalOverLimit).toBe('3000.25');
    feed(e, [position(BTC.instId, '18000')]);
    expect(e.state.totalOverLimit).toBe('');
  });

  it('is advisory: no halt, opening orders elsewhere and closing orders still pass, and it is not persisted', async () => {
    const store = new MemoryStore();
    const e = new RiskEngine(config, store, log, () => Date.UTC(2026, 0, 1, 12));
    const positions = [position(BTC.instId, '26000')];
    feed(e, positions);
    expect(e.state.killSwitch).toBe(false);
    expect(e.check(input({ side: 'sell', reduceOnly: true, notional: '6000', positions })).ok).toBe(true);
    expect(e.check(input({ inst: ETH, px: '3000', refPrice: '3000', positions })).ok).toBe(true);
    await new Promise((r) => setTimeout(r, 0));
    expect(await store.getSetting<unknown>('risk.state')).toBeNull();
  });
});

describe('RiskEngine daily loss', () => {
  it('trips the kill switch when equity drops by the limit and resets on a new day', async () => {
    let now = Date.UTC(2026, 0, 1, 12);
    const store = new MemoryStore();
    const e = new RiskEngine(config, store, log, () => now);
    e.updateEquity('10000');
    expect(e.state.dayStartEquity).toBe('10000');
    e.updateEquity('9200');
    expect(e.state.killSwitch).toBe(false);
    expect(e.state.dailyPnl).toBe('-800');
    e.updateEquity('9000');
    expect(e.state.killSwitch).toBe(true);
    expect(e.state.killSwitchReason).toMatch(/DAILY_LOSS_LIMIT/);
    // same day: equity recovery does not clear it
    e.updateEquity('9500');
    expect(e.state.killSwitch).toBe(true);
    // next UTC day: baseline resets and the automatic halt clears
    now = Date.UTC(2026, 0, 2, 0, 0, 1);
    e.updateEquity('9500');
    expect(e.state.killSwitch).toBe(false);
    expect(e.state.dayStartEquity).toBe('9500');
    expect(e.state.dailyPnl).toBe('0');
    // state was persisted
    await new Promise((r) => setTimeout(r, 0));
    const saved = await store.getSetting<{ dayStartEquity: string }>('risk.state');
    expect(saved?.dayStartEquity).toBe('9500');
  });

  it('ignores an empty equity instead of reading it as zero', () => {
    const e = new RiskEngine(config, new MemoryStore(), log, () => Date.UTC(2026, 0, 1, 12));
    e.updateEquity('');
    expect(e.state.dayStartEquity).toBe('');
    e.updateEquity('10000');
    e.updateEquity('');
    expect(e.state).toMatchObject({ currentEquity: '10000', dailyPnl: '0', killSwitch: false, dayStartEquity: '10000' });
  });

  it('keeps a manual kill switch across days and restores it from the store', async () => {
    let now = Date.UTC(2026, 0, 1, 12);
    const store = new MemoryStore();
    const e = new RiskEngine(config, store, log, () => now);
    e.updateEquity('10000');
    e.setKillSwitch(true, 'MANUAL: lunch');
    now = Date.UTC(2026, 0, 2, 1);
    e.updateEquity('10000');
    expect(e.state.killSwitch).toBe(true);
    await new Promise((r) => setTimeout(r, 0));
    const e2 = new RiskEngine(config, store, log, () => now);
    await e2.init();
    expect(e2.state.killSwitch).toBe(true);
    expect(e2.state.killSwitchReason).toBe('MANUAL: lunch');
  });

  it('reports when the baseline was taken', () => {
    let now = Date.UTC(2026, 0, 1, 9, 12);
    const e = new RiskEngine(config, new MemoryStore(), log, () => now);
    expect(e.state.baselineTs).toBe(0);
    e.updateEquity('10000');
    expect(e.state.baselineTs).toBe(Date.UTC(2026, 0, 1, 9, 12));
    now = Date.UTC(2026, 0, 1, 15);
    e.updateEquity('10100');
    expect(e.state.baselineTs).toBe(Date.UTC(2026, 0, 1, 9, 12));
    now = Date.UTC(2026, 0, 2, 0, 0, 20);
    e.updateEquity('10100');
    expect(e.state).toMatchObject({ dayStartTs: Date.UTC(2026, 0, 2), baselineTs: Date.UTC(2026, 0, 2, 0, 0, 20) });
  });
});

describe('RiskEngine across a restart with a state file', () => {
  const DAY1 = Date.UTC(2026, 0, 1, 12);
  let dir: string;
  let file: string;
  let now: number;
  /** A fresh process: a new store reading the same file, and a new engine. */
  const boot = async (): Promise<RiskEngine> => {
    const e = new RiskEngine(config, new MemoryStore(file), log, () => now);
    await e.init();
    return e;
  };

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'pegasus-risk-'));
    file = join(dir, 'state.json');
    now = DAY1;
  });
  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it('restores the daily-loss halt and the day baseline on the same UTC day', async () => {
    const e = await boot();
    e.updateEquity('100000');
    now = DAY1 + 3_600_000;
    e.updateEquity('98900');
    expect(e.state.killSwitch).toBe(true);

    now = DAY1 + 2 * 3_600_000;
    const e2 = await boot();
    expect(e2.state).toMatchObject({ killSwitch: true, dayStartEquity: '100000', baselineTs: DAY1 });
    expect(e2.state.killSwitchReason).toMatch(/^DAILY_LOSS_LIMIT/);
    e2.updateEquity('98900');
    expect(e2.state).toMatchObject({ killSwitch: true, dayStartEquity: '100000', dailyPnl: '-1100' });
    expect(e2.check(input()).code).toBe('KILL_SWITCH');
  });

  it('restores the baseline without a halt, so the loss before the restart still counts', async () => {
    const e = await boot();
    e.updateEquity('100000');
    e.updateEquity('99500');
    const e2 = await boot();
    expect(e2.state.killSwitch).toBe(false);
    e2.updateEquity('99000');
    expect(e2.state).toMatchObject({ killSwitch: true, dailyPnl: '-1000' });
  });

  it('a new UTC day clears an automatic halt at start-up but never a manual one', async () => {
    const e = await boot();
    e.updateEquity('100000');
    e.updateEquity('98900');
    now = Date.UTC(2026, 0, 2, 9);
    const next = await boot();
    // already at start-up, before the first equity: the cancel sweep must not run for yesterday's halt
    expect(next.state).toMatchObject({ killSwitch: false, killSwitchReason: '', dayStartEquity: '' });
    next.updateEquity('98900');
    expect(next.state).toMatchObject({ killSwitch: false, dayStartEquity: '98900', dailyPnl: '0', baselineTs: now });
    // and it stays cleared for the next start
    expect((await boot()).state.killSwitch).toBe(false);

    next.setKillSwitch(true, 'manual (terminal)');
    now = Date.UTC(2026, 0, 3, 9);
    const later = await boot();
    expect(later.state).toMatchObject({ killSwitch: true, killSwitchReason: 'manual (terminal)' });
    later.updateEquity('98900');
    expect(later.state.killSwitch).toBe(true);
  });

  it('fails closed on a state file that cannot be read: the kill switch is on and the reason names the file', async () => {
    for (const text of ['{"settings": {"risk.state": {"killSw', '{"settings": {"risk.state": {"killSwitch": "no"}}}']) {
      writeFileSync(file, text);
      const errors: string[] = [];
      const e = new RiskEngine(config, new MemoryStore(file), pino({ level: 'error' }, { write: (line: string) => errors.push(line) }), () => now);
      await e.init();
      expect(e.state.killSwitch).toBe(true);
      expect(e.state.killSwitchReason).toMatch(/^STATE_FILE_UNREADABLE/);
      expect(e.state.killSwitchReason).toContain('state.json');
      expect(errors).toHaveLength(1);
      expect(e.check(input()).code).toBe('KILL_SWITCH');
      // it is a halt like a manual one: kept across restarts and days until it is released by hand
      now += 86_400_000;
      const e2 = await boot();
      e2.updateEquity('100000');
      expect(e2.state.killSwitchReason).toMatch(/^STATE_FILE_UNREADABLE/);
      e2.setKillSwitch(false, '');
      expect((await boot()).state.killSwitch).toBe(false);
    }
  });

  it('still fails closed when the first start after the damage ended before the engine started', async () => {
    const text = '{"settings": {"risk.state": {"killSw';
    writeFileSync(file, text);
    new MemoryStore(file); // a start that died early: OKX unreachable, the window closed
    const e = await boot();
    expect(e.state.killSwitch).toBe(true);
    expect(e.state.killSwitchReason).toMatch(/^STATE_FILE_UNREADABLE/);
    expect(readFileSync(`${file}.corrupt`, 'utf8')).toBe(text);
    // the halt is now saved in a readable file and restored like any other
    const e2 = await boot();
    expect(e2.state.killSwitch).toBe(true);
    expect(e2.state.killSwitchReason).toBe(e.state.killSwitchReason);
  });

  it('remembers a completed cancel sweep with the halt, and forgets it when the halt ends', async () => {
    const saved = (): unknown => (JSON.parse(readFileSync(file, 'utf8')) as { settings: Record<string, unknown> }).settings['risk.state'];
    const e = await boot();
    e.setKillSwitch(true, 'manual (terminal)');
    e.setCancelSweep('pending', 'cancelling open orders');
    expect(saved()).toMatchObject({ killSwitch: true, sweepDone: false });
    expect((await boot()).state.cancelSweep.state).toBe('idle');

    e.setCancelSweep('done', 'open orders cancelled');
    expect(saved()).toMatchObject({ killSwitch: true, sweepDone: true });
    const e2 = await boot();
    expect(e2.state.killSwitch).toBe(true);
    expect(e2.state.cancelSweep).toMatchObject({ state: 'done', message: 'open orders cancelled before the restart' });

    e2.setKillSwitch(false, '');
    expect(saved()).toMatchObject({ killSwitch: false, sweepDone: false });
    e2.setKillSwitch(true, 'again');
    expect(saved()).toMatchObject({ killSwitch: true, sweepDone: false });
    expect((await boot()).state.cancelSweep.state).toBe('idle');
  });

  it('a daily-loss halt keeps its completed sweep on the same day only, and a new trip starts without one', async () => {
    const e = await boot();
    e.updateEquity('100000');
    e.updateEquity('98900');
    e.setCancelSweep('done', 'open orders cancelled');
    expect((await boot()).state.cancelSweep.state).toBe('done');

    now = Date.UTC(2026, 0, 2, 9);
    const next = await boot();
    expect(next.state).toMatchObject({ killSwitch: false, cancelSweep: { state: 'idle' } });
    next.updateEquity('98900');
    next.updateEquity('97800');
    expect(next.state.killSwitch).toBe(true);
    expect((await boot()).state.cancelSweep.state).toBe('idle');
  });

  it('accepts a state saved before the sweep was recorded, and rejects one where it is not a boolean', async () => {
    writeFileSync(file, JSON.stringify({ settings: { 'risk.state': { killSwitch: true, killSwitchReason: 'manual (terminal)', dayStartTs: Date.UTC(2026, 0, 1), dayStartEquity: '100000' } } }));
    const e = await boot();
    expect(e.state).toMatchObject({ killSwitch: true, killSwitchReason: 'manual (terminal)', cancelSweep: { state: 'idle' } });

    writeFileSync(file, JSON.stringify({ settings: { 'risk.state': { killSwitch: false, killSwitchReason: '', dayStartTs: Date.UTC(2026, 0, 1), dayStartEquity: '', sweepDone: 'yes' } } }));
    expect((await boot()).state.killSwitchReason).toMatch(/^STATE_FILE_UNREADABLE/);
  });
});

describe('RiskEngine releasing the kill switch while the daily loss limit is breached', () => {
  const T0 = Date.UTC(2026, 0, 1, 12);
  function breached() {
    const clock = { now: T0 };
    const store = new MemoryStore();
    const e = new RiskEngine(config, store, log, () => clock.now);
    e.updateEquity('100000');
    e.updateEquity('98900');
    expect(e.state.killSwitch).toBe(true);
    return { e, store, clock };
  }

  it('refuses a plain release and leaves the halt on', () => {
    const { e } = breached();
    let thrown: unknown;
    try {
      e.setKillSwitch(false, '');
    } catch (err) {
      thrown = err;
    }
    expect(thrown).toMatchObject({ code: 'DAILY_LOSS_ACTIVE', status: 409, details: { dailyPnl: '-1100', limit: '1000', equity: '98900' } });
    expect(e.state.killSwitch).toBe(true);
    expect(e.state.killSwitchReason).toMatch(/^DAILY_LOSS_LIMIT/);
  });

  it('with rebase: releases, restarts the baseline at the current equity, records it, and the limit trips again from there', async () => {
    const { e, store, clock } = breached();
    clock.now = T0 + 60_000;
    const state = e.setKillSwitch(false, '', true);
    expect(state).toMatchObject({ killSwitch: false, killSwitchReason: '', dayStartEquity: '98900', dailyPnl: '0', baselineTs: T0 + 60_000, dayStartTs: Date.UTC(2026, 0, 1) });
    expect(store.riskEvents.map((ev) => ev.type)).toContain('DAILY_BASELINE_REBASED');
    expect(store.riskEvents.find((ev) => ev.type === 'DAILY_BASELINE_REBASED')?.detail).toMatchObject({ from: '100000', to: '98900', dailyPnl: '-1100' });
    expect(await store.getSetting('risk.state')).toMatchObject({ killSwitch: false, dayStartEquity: '98900', baselineTs: T0 + 60_000 });
    // the next balance event no longer re-engages it ...
    e.updateEquity('98900');
    expect(e.state.killSwitch).toBe(false);
    e.updateEquity('98000');
    expect(e.state).toMatchObject({ killSwitch: false, dailyPnl: '-900' });
    // ... until the limit is lost again from the new baseline
    e.updateEquity('97900');
    expect(e.state.killSwitch).toBe(true);
    expect(e.state.killSwitchReason).toMatch(/^DAILY_LOSS_LIMIT/);
  });

  it('a release is not refused once the loss no longer applies, and rebase then changes nothing', () => {
    const { e } = breached();
    e.updateEquity('99500');
    expect(e.state.killSwitch).toBe(true);
    e.setKillSwitch(false, '', true);
    expect(e.state).toMatchObject({ killSwitch: false, dayStartEquity: '100000', dailyPnl: '-500', baselineTs: T0 });
  });

  it('engaging is never refused, and a manual halt releases as before', () => {
    const { e } = breached();
    e.setKillSwitch(true, 'manual (terminal)', true);
    expect(e.state).toMatchObject({ killSwitch: true, killSwitchReason: 'manual (terminal)', dayStartEquity: '100000' });
    const calm = new RiskEngine(config, new MemoryStore(), log, () => T0);
    calm.updateEquity('100000');
    calm.setKillSwitch(true, 'manual (terminal)');
    expect(calm.setKillSwitch(false, '').killSwitch).toBe(false);
  });
});
