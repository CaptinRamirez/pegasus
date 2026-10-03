import { describe, expect, it } from 'vitest';
import {
  atr,
  buildSignalReport,
  classifyRegime,
  computeIndicators,
  DEFAULT_TREND_PARAMS,
  efficiencyRatio,
  evaluateTrendSignals,
  planSize,
  previousChannel,
  realizedVol,
  sma,
  summarizeFunding,
  type Candle,
  type Instrument,
} from '../src/index.js';

const BTC: Instrument = {
  instId: 'BTC-USDT-SWAP', instType: 'SWAP', uly: 'BTC-USDT', baseCcy: 'BTC', quoteCcy: 'USDT', settleCcy: 'USDT',
  ctVal: '0.01', ctValCcy: 'BTC', ctMult: '1', ctType: 'linear', lotSz: '0.1', minSz: '0.1', tickSz: '0.1',
  maxLmtSz: '100000', maxMktSz: '12000', maxLever: '100', state: 'live',
};

const DAY = 86_400_000;

/** Deterministic synthetic daily series: a slow drift plus a small zigzag, no randomness. */
function series(n: number, start = 50_000, drift = 0.002, wiggle = 0.01): Candle[] {
  const out: Candle[] = [];
  let close = start;
  for (let i = 0; i < n; i++) {
    const open = close;
    const zig = (i % 2 === 0 ? 1 : -1) * wiggle;
    close = open * (1 + drift + zig);
    const high = Math.max(open, close) * 1.004;
    const low = Math.min(open, close) * 0.996;
    out.push({ ts: 1_700_000_000_000 + i * DAY, open: open.toFixed(1), high: high.toFixed(1), low: low.toFixed(1), close: close.toFixed(1), vol: '1', volCcy: '1', confirm: true });
  }
  return out;
}

describe('indicators', () => {
  it('sma, channel, atr and efficiency ratio match hand calculations', () => {
    const closes = ['1', '2', '3', '4', '5'];
    expect(sma(closes, 3).toFixed()).toBe('4');
    const candles: Candle[] = [
      { ts: 1, open: '10', high: '12', low: '9', close: '11', vol: '0', volCcy: '0', confirm: true },
      { ts: 2, open: '11', high: '15', low: '10', close: '14', vol: '0', volCcy: '0', confirm: true },
      { ts: 3, open: '14', high: '14', low: '8', close: '9', vol: '0', volCcy: '0', confirm: true },
      { ts: 4, open: '9', high: '13', low: '9', close: '12', vol: '0', volCcy: '0', confirm: true },
    ];
    // previous 2 bars before the last: highs 15,14 -> 15; lows 10,8 -> 8
    const ch = previousChannel(candles, 2);
    expect(ch.high.toFixed()).toBe('15');
    expect(ch.low.toFixed()).toBe('8');
    // true ranges: bar2 max(5, |15-11|=4, |10-11|=1)=5; bar3 max(6, |14-14|=0, |8-14|=6)=6; bar4 max(4, |13-9|=4, |9-9|=0)=4 -> atr(3) = 5
    expect(atr(candles, 3).toFixed()).toBe('5');
    // efficiency over 3 moves from 11 -> 12: net 1, path 3+5+3 = 11
    expect(efficiencyRatio(['11', '14', '9', '12'], 3).toFixed(6)).toBe('0.090909');
    expect(efficiencyRatio(['1', '2', '3', '4'], 3).toFixed()).toBe('1');
  });

  it('annualises realised volatility with sqrt(365)', () => {
    const closes = ['100', '110', '100', '110', '100', '110'];
    const vol = realizedVol(closes, 5);
    // daily sigma of alternating ±ln(1.1): sample stdev ≈ 0.10445
    expect(vol.div(Math.sqrt(365)).toNumber()).toBeCloseTo(0.10445, 3);
  });

  it('requires enough confirmed bars and sorted input', () => {
    expect(() => computeIndicators(series(50))).toThrow(/at least/);
    const bad = series(120);
    bad[5]!.ts = bad[4]!.ts;
    expect(() => computeIndicators(bad)).toThrow(/sorted/);
  });
});

describe('funding normalisation', () => {
  it('scales shortened settlement intervals to an 8h basis and averages the window', () => {
    const now = 1_700_000_000_000;
    const h = 3_600_000;
    const records = [
      { fundingRate: '0.0001', fundingTime: now - 72 * h }, // outside window (older than 72h)? exactly at the edge counts
      { fundingRate: '0.0001', fundingTime: now - 64 * h },
      { fundingRate: '0.0002', fundingTime: now - 56 * h },
      // capped period: 4h intervals at 0.0003 per 4h = 0.0006 per 8h
      { fundingRate: '0.0003', fundingTime: now - 48 * h },
      { fundingRate: '0.0003', fundingTime: now - 44 * h },
      { fundingRate: '0.0003', fundingTime: now - 40 * h },
    ];
    const s = summarizeFunding(records, now, 72)!;
    expect(s.samples).toBe(6);
    // 8h-normalised: 0.0001, 0.0001, 0.0002, 0.0006, 0.0006, 0.0006(last uses prev gap 4h) -> avg 0.00036666...
    expect(Number(s.avg8h)).toBeCloseTo(0.0003667, 6);
    expect(Number(s.latest8h)).toBeCloseTo(0.0006, 9);
    expect(Number(s.annualized)).toBeCloseTo(0.0003667 * 3 * 365, 3);
    expect(summarizeFunding([], now)).toBeNull();
  });
});

describe('regime and signals', () => {
  it('flags an upside breakout above the MA with benign funding as a long entry', () => {
    const candles = series(131, 50_000, 0.003, 0.002);
    const ind = computeIndicators(candles);
    expect(Number(ind.close)).toBeGreaterThan(Number(ind.entryHigh));
    expect(Number(ind.close)).toBeGreaterThan(Number(ind.ma));
    const regime = classifyRegime(ind);
    expect(['trend', 'neutral']).toContain(regime);
    const sig = evaluateTrendSignals(ind, regime, { avg8h: '0.0001', latest8h: '0.0001', samples: 9, annualized: '0.1' });
    expect(sig.longEntry).toBe(true);
    expect(sig.shortEntry).toBe(false);
    expect(sig.longExit).toBe(false);
    // crowded funding blocks the long
    const blocked = evaluateTrendSignals(ind, regime, { avg8h: '0.0008', latest8h: '0.0008', samples: 9, annualized: '0.9' });
    expect(blocked.longEntry).toBe(false);
    expect(blocked.reasons.some((r) => r.includes('long blocked'))).toBe(true);
    // a ranging regime blocks new entries
    expect(evaluateTrendSignals(ind, 'range', null).longEntry).toBe(false);
  });

  it('classifies a flat zigzag near the MA as range and a 3-sigma day as crisis', () => {
    const flat = series(130, 50_000, 0, 0.003);
    const ind = computeIndicators(flat);
    expect(Number(ind.efficiencyRatio)).toBeLessThan(0.15);
    expect(classifyRegime(ind)).toBe('range');
    const crash = series(130, 50_000, 0, 0.003);
    const last = crash[crash.length - 1]!;
    const shocked = { ...last, close: (Number(last.open) * 0.85).toFixed(1), low: (Number(last.open) * 0.84).toFixed(1) };
    crash[crash.length - 1] = shocked;
    expect(classifyRegime(computeIndicators(crash))).toBe('crisis');
  });

  it('long exit fires when the close drops below the 20-day low', () => {
    const candles = series(131, 50_000, 0.003, 0.002);
    const last = candles[candles.length - 1]!;
    candles[candles.length - 1] = { ...last, close: (Number(candles[100]!.low) * 0.9).toFixed(1), low: (Number(candles[100]!.low) * 0.89).toFixed(1) };
    const ind = computeIndicators(candles);
    const sig = evaluateTrendSignals(ind, classifyRegime(ind), null);
    expect(sig.longExit).toBe(true);
  });
});

describe('sizing', () => {
  it('sizes from the stop distance and caps at 10% of equity', () => {
    // equity 100k, risk 0.75%, ATR 1500 at 50k -> stop 3750 = 7.5% -> notional 10,000 = exactly the cap
    const plan = planSize('100000', '50000', '1500', BTC);
    expect(plan.stopDistancePct).toBe('0.075');
    expect(plan.rawNotional).toBe('10000.00');
    expect(plan.capped).toBe(false);
    expect(plan.contracts).toBe('20'); // 10,000 / (0.01 BTC × 50,000) = 20
    expect(plan.coin).toBe('0.2');
    expect(plan.riskQuote).toBe('750.00');
    expect(plan.stopLong).toBe('46250');
    expect(plan.stopShort).toBe('53750');
    // low volatility: ATR 800 -> stop 4% -> raw 18,750 -> capped to 10,000
    const low = planSize('100000', '50000', '800', BTC);
    expect(low.capped).toBe(true);
    expect(low.notional).toBe('10000.00');
    expect(low.contracts).toBe('20');
    expect(Number(low.riskQuote)).toBeLessThan(750);
  });
  it('refuses when the minimum order size already exceeds the risk budget', () => {
    // equity 500 at 0.5%: budget 2.5 USDT; minSz 0.1 contracts (50 USDT) at a 7.5% stop risks 3.75
    const plan = planSize('500', '50000', '1500', BTC, { riskPct: '0.005', maxNotionalPct: '0.10', atrStopMultiple: '2.5' });
    expect(plan.contracts).toBe('0');
    expect(plan.minUnitRiskQuote).toBe('3.75');
    expect(plan.note).toMatch(/exceeds the budget/);
    // equity 1,000: budget 5 -> 0.1 contracts fits
    expect(planSize('1000', '50000', '1500', BTC, { riskPct: '0.005', maxNotionalPct: '0.10', atrStopMultiple: '2.5' }).contracts).toBe('0.1');
  });
});

describe('buildSignalReport', () => {
  it('ignores the forming bar and assembles the report', () => {
    const candles = series(131, 50_000, 0.003, 0.002);
    const forming: Candle = { ...candles[candles.length - 1]!, ts: candles[candles.length - 1]!.ts + DAY, close: '1', low: '1', confirm: false };
    const report = buildSignalReport('BTC-USDT-SWAP', [...candles, forming], null, Date.now(), BTC, '100000');
    expect(report.indicators.bars).toBe(131);
    expect(report.sizing?.contracts).not.toBe('0');
    expect(report.params).toEqual(DEFAULT_TREND_PARAMS);
    expect(report.signals.longEntry).toBe(true);
  });
});
