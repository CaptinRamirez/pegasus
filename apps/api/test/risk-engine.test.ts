import { describe, expect, it } from 'vitest';
import { pino } from 'pino';
import type { Instrument, Position, RiskConfig } from '@pegasus/shared';
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

function input(overrides: Partial<RiskCheckInput> = {}): RiskCheckInput {
  return {
    inst: BTC, side: 'buy', ordType: 'limit', contracts: '2', notional: '1000', px: '50000', refPrice: '50000', lever: '5',
    estSlippagePct: '', reduceOnly: false, positions: [], openOrders: 0, ...overrides,
  };
}

describe('RiskEngine.check', () => {
  const engine = () => new RiskEngine(config, new MemoryStore(), log, () => Date.UTC(2026, 0, 1, 12));

  it('passes a plain order', () => {
    expect(engine().check(input()).ok).toBe(true);
  });
  it('rejects when the kill switch is on', () => {
    const e = engine();
    e.setKillSwitch(true, 'test');
    expect(e.check(input()).code).toBe('KILL_SWITCH');
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
    expect(engine().check(input({ openOrders: 3 })).code).toBe('MAX_OPEN_ORDERS');
    expect(engine().check(input({ openOrders: 3, ordType: 'market', px: '' })).ok).toBe(true);
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
  it('skips exposure limits for reduce-only orders', () => {
    const positions = [position('BTC-USDT-SWAP', '19500')];
    expect(engine().check(input({ notional: '5000', side: 'sell', reduceOnly: true, positions })).ok).toBe(true);
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
