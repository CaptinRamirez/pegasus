import { describe, expect, it } from 'vitest';
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
    estSlippagePct: '', reduceOnly: false, positions: [], openOrders: [], instrumentOf: (id) => INSTRUMENTS.get(id), ...overrides,
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
    // resting sells net against a long in net mode
    const sells = [resting('BTC-USDT-SWAP', 'sell', '50000', '38')];
    expect(engine().check(input({ notional: '1000', openOrders: sells, positions: [position('BTC-USDT-SWAP', '19500')] })).ok).toBe(true);
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
});
