import { describe, expect, it } from 'vitest';
import {
  atr,
  barOiChanges,
  buildSignalReport,
  classifyRegime,
  computeIndicators,
  dailyBarsFromHalfDays,
  DEFAULT_TREND_PARAMS,
  efficiencyRatio,
  evaluateTrendSignals,
  phaseDayStart,
  planSize,
  previousChannel,
  realizedVol,
  sizeAdjustment,
  sma,
  splitSizingAcrossPhases,
  summarizeFunding,
  trailingChannel,
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
      // the settlement interval shortens to 4h after this record, which itself still covers the 8h before it
      { fundingRate: '0.0003', fundingTime: now - 48 * h },
      // capped period: 0.0003 per 4h = 0.0006 per 8h
      { fundingRate: '0.0003', fundingTime: now - 44 * h },
      { fundingRate: '0.0003', fundingTime: now - 40 * h },
    ];
    const s = summarizeFunding(records, now, 72)!;
    expect(s.samples).toBe(6);
    // each record is scaled by the gap to the PREVIOUS settlement (the period it covers):
    // 0.0001 (first, uses the next gap), 0.0001, 0.0002, 0.0003, 0.0006, 0.0006 -> avg 0.00031666...
    expect(Number(s.avg8h)).toBeCloseTo(0.00031667, 7);
    expect(Number(s.latest8h)).toBeCloseTo(0.0006, 9);
    expect(Number(s.annualized)).toBeCloseTo(0.00031667 * 3 * 365, 3);
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
    // only extreme funding (above 0.1%/8h) blocks the long; 0.08%/8h is still allowed
    expect(evaluateTrendSignals(ind, regime, { avg8h: '0.0008', latest8h: '0.0008', samples: 9, annualized: '0.9' }).longEntry).toBe(true);
    const blocked = evaluateTrendSignals(ind, regime, { avg8h: '0.0012', latest8h: '0.0012', samples: 9, annualized: '1.3' });
    expect(blocked.longEntry).toBe(false);
    expect(blocked.reasons.some((r) => r.includes('long blocked'))).toBe(true);
    // the gates are strict: exactly 0.1%/8h is not "below 0.1%"
    expect(evaluateTrendSignals(ind, regime, { avg8h: '0.001', latest8h: '0.001', samples: 9, annualized: '1.095' }).longEntry).toBe(false);
    // the range filter is off by default and blocks entries only when enabled
    expect(evaluateTrendSignals(ind, 'range', null).longEntry).toBe(true);
    expect(evaluateTrendSignals(ind, 'range', null, { ...DEFAULT_TREND_PARAMS, useRangeFilter: true }).longEntry).toBe(false);
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

describe('crisis detection', () => {
  /** Zigzag of ±1% around a flat price with one shock of `shock` (fraction) `daysAgo` closes before the last. */
  function shocked(daysAgo: number, shock = -0.04): Candle[] {
    const candles = series(130, 50_000, 0, 0.01);
    const at = candles.length - 1 - daysAgo;
    let close = 0;
    for (let i = at; i < candles.length; i++) {
      const c = candles[i]!;
      const open = i === at ? Number(c.open) : close;
      const ret = i === at ? shock : i % 2 === 0 ? 0.01 : -0.01;
      close = open * (1 + ret);
      candles[i] = { ...c, open: open.toFixed(1), close: close.toFixed(1), high: (Math.max(open, close) * 1.004).toFixed(1), low: (Math.min(open, close) * 0.996).toFixed(1) };
    }
    return candles;
  }

  it('measures the last return against the sigma of the bars BEFORE it', () => {
    // -4% against a prior 20-day sigma of about 1% is a 4-sigma day; with the shock inside the window
    // the sigma would rise to about 1.36% and 3 sigmas (4.07%) would hide it
    const ind = computeIndicators(shocked(0));
    expect(Number(ind.dailySigma)).toBeCloseTo(0.0103, 3);
    expect(Math.abs(Number(ind.dailyReturn))).toBeGreaterThan(3 * Number(ind.dailySigma));
    expect(Number(ind.volRatio)).toBeLessThan(2);
    expect(ind.crisisDaysAgo).toBe(0);
    expect(classifyRegime(ind)).toBe('crisis');
  });

  it('keeps the crisis regime for crisisHoldBars closes and says so', () => {
    const three = computeIndicators(shocked(3));
    expect(three.crisisDaysAgo).toBe(3);
    expect(classifyRegime(three)).toBe('crisis');
    const sig = evaluateTrendSignals(three, 'crisis', null);
    expect(sig.reasons.some((r) => /regime crisis: .*3 closes ago.*half size.*1 more close/.test(r))).toBe(true);
    expect(sig.reasons.some((r) => r.includes('new entries allowed'))).toBe(false);
    const four = computeIndicators(shocked(4));
    expect(four.crisisDaysAgo).toBe(4);
    expect(classifyRegime(four)).toBe('crisis');
    // default hold is 5 bars, the crisis bar included
    const five = computeIndicators(shocked(5));
    expect(five.crisisDaysAgo).toBeNull();
    expect(classifyRegime(five)).not.toBe('crisis');
    const longer = { ...DEFAULT_TREND_PARAMS, crisisHoldBars: 10 };
    expect(classifyRegime(computeIndicators(shocked(5), longer), longer)).toBe('crisis');
  });

  it('does not call a 3-sigma UP breakout with rising open interest a crisis', () => {
    const candles = shocked(0, 0.06);
    const last = candles[candles.length - 1]!;
    const ind = computeIndicators(candles, DEFAULT_TREND_PARAMS, [{ ts: last.ts, change: '0.04' }]);
    expect(Number(ind.dailyReturn)).toBeGreaterThan(3 * Number(ind.dailySigma));
    expect(ind.shockBars).toEqual([{ daysAgo: 0, return: ind.dailyReturn, oiChange: '0.04', crisis: false }]);
    expect(ind.crisisDaysAgo).toBeNull();
    const regime = classifyRegime(ind);
    expect(regime).not.toBe('crisis');
    const sig = evaluateTrendSignals(ind, regime, null);
    expect(sig.longEntry).toBe(true);
    expect(sig.reasons).toContain('shock: the last bar moved +6.00% (more than 3 sigma); OI +4.0%: not a deleveraging day');
    expect(sizeAdjustment('long', regime, null, null).multiplier).toBe('1');
    // the direction of the move does not matter: the same bar with open interest down 12% is a crisis day
    const forced = computeIndicators(candles, DEFAULT_TREND_PARAMS, [{ ts: last.ts, change: '-0.12' }]);
    expect(forced.crisisDaysAgo).toBe(0);
    // a fall of exactly 10% is not "more than 10%"
    expect(computeIndicators(candles, DEFAULT_TREND_PARAMS, [{ ts: last.ts, change: '-0.1' }]).crisisDaysAgo).toBeNull();
    expect(computeIndicators(candles, { ...DEFAULT_TREND_PARAMS, crisisOiDrop: '0.05' }, [{ ts: last.ts, change: '-0.1' }]).crisisDaysAgo).toBe(0);
  });

  it('holds a 3-sigma bar with open interest down 12% as a crisis for exactly the hold window', () => {
    for (let ago = 0; ago <= 5; ago++) {
      const candles = shocked(ago);
      const bar = candles[candles.length - 1 - ago]!;
      const ind = computeIndicators(candles, DEFAULT_TREND_PARAMS, [{ ts: bar.ts, change: '-0.12' }]);
      if (ago < 5) {
        expect(ind.shockBars).toHaveLength(1);
        expect(ind.shockBars[0]).toMatchObject({ daysAgo: ago, oiChange: '-0.12', crisis: true });
        expect(ind.crisisDaysAgo).toBe(ago);
        expect(classifyRegime(ind)).toBe('crisis');
      } else {
        expect(ind.shockBars).toEqual([]);
        expect(ind.crisisDaysAgo).toBeNull();
        expect(classifyRegime(ind)).not.toBe('crisis');
      }
    }
    const two = shocked(2);
    const sig = evaluateTrendSignals(computeIndicators(two, DEFAULT_TREND_PARAMS, [{ ts: two[two.length - 3]!.ts, change: '-0.12' }]), 'crisis', null);
    expect(sig.reasons.some((r) => /regime crisis: the bar 2 closes ago was a crisis day; .*half size.*2 more closes/.test(r))).toBe(true);
    expect(sig.reasons).toContain('shock: the bar 2 closes ago moved -4.00% (more than 3 sigma); OI -12.0%: crisis');
  });

  it('counts a shock bar whose open interest change is unknown as a crisis and says so', () => {
    const candles = shocked(1);
    // changes are known for other bars, not for the shock bar
    const ind = computeIndicators(candles, DEFAULT_TREND_PARAMS, [{ ts: candles[candles.length - 1]!.ts, change: '0.01' }]);
    expect(ind.shockBars).toEqual([{ daysAgo: 1, return: ind.shockBars[0]!.return, oiChange: '', crisis: true }]);
    expect(ind.crisisDaysAgo).toBe(1);
    const sig = evaluateTrendSignals(ind, classifyRegime(ind), null);
    expect(sig.reasons).toContain('shock: the bar 1 close ago moved -4.00% (more than 3 sigma); OI change unavailable, counted as crisis');
    expect(computeIndicators(candles, DEFAULT_TREND_PARAMS, null).crisisDaysAgo).toBe(1);
  });

  it('reports every shock bar and takes the most recent crisis one', () => {
    const candles = shocked(3);
    // a second shock on the last bar, with rising open interest; the older one was a deleveraging day
    const last = candles[candles.length - 1]!;
    const up = Number(last.open) * 1.07;
    candles[candles.length - 1] = { ...last, close: up.toFixed(1), high: (up * 1.004).toFixed(1) };
    const ind = computeIndicators(candles, DEFAULT_TREND_PARAMS, [{ ts: last.ts, change: '0.03' }, { ts: candles[candles.length - 4]!.ts, change: '-0.15' }]);
    expect(ind.shockBars.map((b) => [b.daysAgo, b.crisis])).toEqual([[0, false], [3, true]]);
    expect(ind.crisisDaysAgo).toBe(3);
    const reasons = evaluateTrendSignals(ind, classifyRegime(ind), null).reasons;
    expect(reasons.filter((r) => r.startsWith('shock: '))).toHaveLength(2);
  });
});

describe('open interest change per bar', () => {
  it('needs the level at both ends of a bar and leaves the others out', () => {
    // real BTC-USDT-SWAP levels around the 2025-10-10 cascade
    const d = Date.UTC(2025, 9, 9);
    const snaps = [{ ts: d, value: '28266.2' }, { ts: d + DAY, value: '28199.1' }, { ts: d + 2 * DAY, value: '22513.2' }, { ts: d + 4 * DAY, value: '21000' }, { ts: d + 5 * DAY, value: '' }];
    const changes = barOiChanges(snaps, [d - DAY, d, d + DAY, d + 2 * DAY, d + 3 * DAY, d + 4 * DAY]);
    expect(changes).toEqual([{ ts: d, change: '-0.002374' }, { ts: d + DAY, change: '-0.201634' }]);
    // a level 12 hours off is not the level at the close
    expect(barOiChanges([{ ts: d, value: '100' }, { ts: d + DAY + 12 * 3_600_000, value: '90' }], [d])).toEqual([]);
    expect(barOiChanges([{ ts: d, value: '100' }, { ts: d + 12 * 3_600_000, value: '90' }], [d], 12 * 3_600_000)).toEqual([{ ts: d, change: '-0.100000' }]);
  });
});

describe('short entries', () => {
  /** Falling series on a 55-day low below the MA. */
  const falling = series(130, 50_000, -0.003, 0.002);

  it('are off by default; the short exit is still evaluated', () => {
    const ind = computeIndicators(falling);
    expect(Number(ind.close)).toBeLessThan(Number(ind.entryLow));
    expect(DEFAULT_TREND_PARAMS.allowShort).toBe(false);
    const off = evaluateTrendSignals(ind, classifyRegime(ind), null);
    expect(off.shortEntry).toBe(false);
    expect(off.reasons).toContain('shorts off (allowShort = false): no short entries; the short exit is still evaluated');
    const on = evaluateTrendSignals(ind, classifyRegime(ind), null, { ...DEFAULT_TREND_PARAMS, allowShort: true });
    expect(on.shortEntry).toBe(true);
    expect(on.reasons.some((r) => r.startsWith('shorts off'))).toBe(false);
    const rising = computeIndicators(series(131, 50_000, 0.003, 0.002));
    expect(evaluateTrendSignals(rising, 'trend', null).shortExit).toBe(true);
  });

  it('keep the short plan but not its size lines while off', () => {
    const report = buildSignalReport('BTC-USDT-SWAP', falling, null, Date.now(), BTC, '100000');
    expect(report.signals.shortEntry).toBe(false);
    expect(report.sizing?.short.multiplier).toBe('0.5');
    expect(report.signals.reasons.some((r) => r.startsWith('short size:'))).toBe(false);
    const on = buildSignalReport('BTC-USDT-SWAP', falling, null, Date.now(), BTC, '100000', { ...DEFAULT_TREND_PARAMS, allowShort: true });
    expect(on.signals.shortEntry).toBe(true);
    expect(on.signals.reasons).toContain('short size: short x0.5');
  });
});

describe('second daily cut', () => {
  const H = 3_600_000;
  const day = Date.UTC(2026, 9, 3);

  it('phaseDayStart floors to phase:00 UTC', () => {
    expect(phaseDayStart(day + 5 * H, 0)).toBe(day);
    expect(phaseDayStart(day, 0)).toBe(day);
    expect(phaseDayStart(day + 23 * H, 0)).toBe(day);
    // the 12:00 day runs from noon to noon
    expect(phaseDayStart(day + 5 * H, 12)).toBe(day - 12 * H);
    expect(phaseDayStart(day + 12 * H, 12)).toBe(day + 12 * H);
    expect(phaseDayStart(day + 13 * H, 12)).toBe(day + 12 * H);
    expect(phaseDayStart(day + 12 * H - 1, 12)).toBe(day - 12 * H);
  });

  it('dailyBarsFromHalfDays joins the two halves of each phase-day', () => {
    const half = (ts: number, open: string, high: string, low: string, close: string, confirm = true): Candle => ({ ts, open, high, low, close, vol: '1.5', volCcy: '0.25', confirm });
    const halves = [
      half(day + 12 * H, '103', '108', '99', '107'),
      half(day, '100', '105', '98', '103'),
      half(day + 24 * H, '107', '109', '104', '105'),
      half(day + 36 * H, '105', '106', '101', '102', false),
      // the next day has no second half yet
      half(day + 48 * H, '102', '103', '100', '101', false),
    ];
    expect(dailyBarsFromHalfDays(halves, 0)).toEqual([
      { ts: day, open: '100', high: '108', low: '98', close: '107', vol: '3', volCcy: '0.5', confirm: true },
      { ts: day + 24 * H, open: '107', high: '109', low: '101', close: '102', vol: '3', volCcy: '0.5', confirm: false },
    ]);
    // the 12:00 cut pairs each afternoon with the next morning
    expect(dailyBarsFromHalfDays(halves, 12)).toEqual([
      { ts: day + 12 * H, open: '103', high: '109', low: '99', close: '105', vol: '3', volCcy: '0.5', confirm: true },
      { ts: day + 36 * H, open: '105', high: '106', low: '100', close: '101', vol: '3', volCcy: '0.5', confirm: false },
    ]);
    expect(dailyBarsFromHalfDays([], 12)).toEqual([]);
  });
});

describe('sizing across phases', () => {
  it('shares the risk and the notional cap of a unit equally between the cuts', () => {
    const unit = { riskPct: '0.0075', maxNotionalPct: '0.10', atrStopMultiple: '2.5' };
    expect(splitSizingAcrossPhases(unit, 1)).toEqual({ riskPct: '0.0075', maxNotionalPct: '0.1', atrStopMultiple: '2.5' });
    expect(splitSizingAcrossPhases(unit, 2)).toEqual({ riskPct: '0.00375', maxNotionalPct: '0.05', atrStopMultiple: '2.5' });
    expect(() => splitSizingAcrossPhases(unit, 0)).toThrow(/phaseCount/);
    expect(() => splitSizingAcrossPhases(unit, 1.5)).toThrow(/phaseCount/);
  });

  it('two half lots never risk or hold more than one unit', () => {
    const half = splitSizingAcrossPhases({ riskPct: '0.0075', maxNotionalPct: '0.10', atrStopMultiple: '2.5' }, 2);
    // stop distance 2.5 x 1500 / 50000 = 7.5%: one unit is 10% of equity, one phase's lot 5%
    const lot = planSize('100000', '50000', '1500', BTC, half);
    expect(lot.rawNotional).toBe('5000.00');
    expect(lot.capped).toBe(false);
    // a quiet market (stop distance 5%) hits the cap of the lot: 5% of equity, not 10%
    const quiet = planSize('100000', '50000', '1000', BTC, half);
    expect(quiet.capped).toBe(true);
    expect(quiet.targetNotional).toBe('5000.00');
  });
});

describe('next-session exit channel', () => {
  it('includes the last bar, unlike the channel the last close was tested against', () => {
    const candles = series(131, 50_000, 0.003, 0.002);
    const ind = computeIndicators(candles);
    const last = candles[candles.length - 1]!;
    // rising series: the last bar holds the highest high, so the two channels differ
    expect(Number(ind.nextExitHigh)).toBe(Number(last.high));
    expect(Number(ind.nextExitHigh)).toBeGreaterThan(Number(ind.exitHigh));
    expect(Number(ind.nextExitLow)).toBe(Number(candles[candles.length - 20]!.low));
    expect(Number(ind.nextExitLow)).toBeGreaterThan(Number(ind.exitLow));
    expect(trailingChannel(candles, 20).high.toFixed()).toBe(ind.nextExitHigh);
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
  it('reports the notional of the rounded order and keeps the target it was rounded down from', () => {
    // target = the 10,000 cap; one contract is 0.01 BTC x 51,234.5 = 512.345, so 19.51 contracts round down to 19.5
    const plan = planSize('100000', '51234.5', '1500', BTC);
    expect(plan.capped).toBe(true);
    expect(plan.targetNotional).toBe('10000.00');
    expect(plan.contracts).toBe('19.5');
    expect(plan.notional).toBe('9990.73');
    expect(plan.coin).toBe('0.195');
    // the risk shown is the risk of the same rounded order
    expect(Number(plan.riskQuote)).toBeCloseTo(9990.7275 * Number(plan.stopDistancePct), 2);
    // nothing to order: no notional either, the target stays for the explanation
    const none = planSize('500', '50000', '1500', BTC, { riskPct: '0.005', maxNotionalPct: '0.10', atrStopMultiple: '2.5' });
    expect(none.notional).toBe('0.00');
    expect(none.targetNotional).toBe('33.33');
  });
});

describe('size adjustments', () => {
  const benign = { avg8h: '0.0001', latest8h: '0.0001', samples: 9, annualized: '0.1' };
  const hot = { avg8h: '0.0009', latest8h: '0.0009', samples: 9, annualized: '0.98' };
  const cold = { avg8h: '-0.0009', latest8h: '-0.0009', samples: 9, annualized: '-0.98' };

  it('halves shorts, halves both sides in a crisis and stacks the cuts', () => {
    expect(sizeAdjustment('long', 'trend', benign, null)).toEqual({ multiplier: '1', adjustments: [] });
    expect(sizeAdjustment('short', 'trend', benign, null)).toEqual({ multiplier: '0.5', adjustments: ['short x0.5'] });
    expect(sizeAdjustment('long', 'crisis', benign, null)).toEqual({ multiplier: '0.5', adjustments: ['crisis x0.5'] });
    expect(sizeAdjustment('short', 'crisis', null, null)).toEqual({ multiplier: '0.25', adjustments: ['short x0.5', 'crisis x0.5'] });
  });

  it('cuts the crowded side to three quarters: extreme funding plus a 10-day OI build-up', () => {
    const long = sizeAdjustment('long', 'trend', hot, '0.24');
    expect(long.multiplier).toBe('0.75');
    expect(long.adjustments).toEqual(['crowded x0.75 (funding 0.09%/8h, OI +24% in 10d)']);
    // positive funding crowds the longs, not the shorts
    expect(sizeAdjustment('short', 'trend', hot, '0.24').adjustments).toEqual(['short x0.5']);
    expect(sizeAdjustment('short', 'trend', cold, '0.24').multiplier).toBe('0.375');
    expect(sizeAdjustment('long', 'trend', cold, '0.24').multiplier).toBe('1');
    // both conditions are needed and both are strict
    expect(sizeAdjustment('long', 'trend', hot, '0.2').multiplier).toBe('1');
    expect(sizeAdjustment('long', 'trend', hot, '0.05').multiplier).toBe('1');
    expect(sizeAdjustment('long', 'trend', { ...hot, avg8h: '0.0008' }, '0.24').multiplier).toBe('1');
    // funding beyond the threshold but no OI history: the smaller size wins, and the text says why
    const blind = sizeAdjustment('long', 'trend', hot, null);
    expect(blind.multiplier).toBe('0.75');
    expect(blind.adjustments).toEqual(['crowded x0.75 (funding 0.09%/8h, 10d OI change unavailable)']);
  });

  it('applies the multiplier to the capped notional and checks the minimum size afterwards', () => {
    const full = planSize('100000', '50000', '1500', BTC);
    expect(full.multiplier).toBe('1');
    expect(full.adjustments).toEqual([]);
    const half = planSize('100000', '50000', '1500', BTC, undefined, { multiplier: '0.5', adjustments: ['short x0.5'] });
    expect(half.contracts).toBe('10');
    expect(half.notional).toBe('5000.00');
    expect(half.riskQuote).toBe('375.00');
    expect(half.multiplier).toBe('0.5');
    expect(half.adjustments).toEqual(['short x0.5']);
    expect(half.note).toContain('short x0.5');
    // capped first, then reduced: ATR 800 -> raw 18,750 -> cap 10,000 -> x0.25 = 2,500 = 5 contracts
    const quarter = planSize('100000', '50000', '800', BTC, undefined, { multiplier: '0.25', adjustments: ['short x0.5', 'crisis x0.5'] });
    expect(quarter.capped).toBe(true);
    expect(quarter.contracts).toBe('5');
    // equity 1,000 at 0.5%: 0.1 contracts fit at full size, but the halved size rounds below minSz
    const tiny = planSize('1000', '50000', '1500', BTC, { riskPct: '0.005', maxNotionalPct: '0.10', atrStopMultiple: '2.5' }, { multiplier: '0.5', adjustments: ['short x0.5'] });
    expect(tiny.contracts).toBe('0');
    expect(tiny.note).toMatch(/exceeds the budget 2\.50/);
  });
});

describe('buildSignalReport', () => {
  it('ignores the forming bar and assembles the report', () => {
    const candles = series(131, 50_000, 0.003, 0.002);
    const forming: Candle = { ...candles[candles.length - 1]!, ts: candles[candles.length - 1]!.ts + DAY, close: '1', low: '1', confirm: false };
    const report = buildSignalReport('BTC-USDT-SWAP', [...candles, forming], null, Date.now(), BTC, '100000');
    expect(report.indicators.bars).toBe(131);
    expect(report.sizing?.long.contracts).not.toBe('0');
    expect(report.sizing?.long.multiplier).toBe('1');
    // one plan per side: the short side is always at half size
    expect(report.sizing?.short.multiplier).toBe('0.5');
    expect(Number(report.sizing?.short.contracts)).toBeLessThanOrEqual(Number(report.sizing?.long.contracts) / 2);
    // shorts are off by default: the plan is there, its size lines are not
    expect(report.signals.reasons.some((r) => r.startsWith('short size:'))).toBe(false);
    expect(report.params).toEqual(DEFAULT_TREND_PARAMS);
    expect(report.signals.longEntry).toBe(true);
    expect(report.dataFetchedAt).toBeNull();
    // the 00:00 UTC cut unless the caller names another
    expect(report.phase).toBe(0);
  });

  it('carries the daily cut its bars close at', () => {
    const H = 3_600_000;
    // 262 half-days from a UTC midnight: 130 noon-to-noon days, the first and the last half-day belong to none
    const halves = series(262, 50_000, 0.0015, 0.001).map((c, i) => ({ ...c, ts: Date.UTC(2026, 0, 1) + i * 12 * H }));
    const days = dailyBarsFromHalfDays(halves, 12);
    expect(days).toHaveLength(130);
    const half = splitSizingAcrossPhases({ riskPct: '0.0075', maxNotionalPct: '0.10', atrStopMultiple: '2.5' }, 2);
    const noon = buildSignalReport('BTC-USDT-SWAP', days, null, Date.now(), BTC, '100000', DEFAULT_TREND_PARAMS, half, null, null, 12);
    expect(noon.phase).toBe(12);
    expect(noon.indicators.asOf).toBe(days[days.length - 1]!.ts);
    expect(noon.indicators.asOf % DAY).toBe(12 * H);
    // sized with the parameters of one cut's lot
    const unit = buildSignalReport('BTC-USDT-SWAP', days, null, Date.now(), BTC, '100000');
    expect(Number(noon.sizing?.long.rawNotional)).toBeCloseTo(Number(unit.sizing?.long.rawNotional) / 2, 1);
    expect(noon.sizing?.long.stopLong).toBe(unit.sizing?.long.stopLong);
  });

  it('sizes a short entry in a crisis regime at a quarter and the crowded long at three quarters', () => {
    // falling series with a -12% last bar: 55-day low breakout below the MA, and a crisis day (shorts switched on)
    const shorts = { ...DEFAULT_TREND_PARAMS, allowShort: true };
    const candles = series(131, 50_000, -0.003, 0.002);
    const last = candles[candles.length - 1]!;
    candles[candles.length - 1] = { ...last, close: (Number(last.open) * 0.88).toFixed(1), low: (Number(last.open) * 0.87).toFixed(1) };
    const full = planSize('100000', candles[candles.length - 1]!.close, computeIndicators(candles).atr, BTC);
    const report = buildSignalReport('BTC-USDT-SWAP', candles, null, Date.now(), BTC, '100000', shorts);
    expect(report.regime).toBe('crisis');
    expect(report.signals.shortEntry).toBe(true);
    expect(report.sizing?.short.multiplier).toBe('0.25');
    expect(report.sizing?.short.adjustments).toEqual(['short x0.5', 'crisis x0.5']);
    expect(Number(report.sizing?.short.targetNotional)).toBeCloseTo(Number(full.targetNotional) / 4, 1);
    expect(report.sizing?.long.multiplier).toBe('0.5');
    expect(report.signals.reasons).toContain('short size: crisis x0.5');
    expect(report.signals.reasons.some((r) => r.includes('new entries allowed'))).toBe(false);

    const now = 1_700_000_000_000 + 131 * DAY;
    const hot = Array.from({ length: 9 }, (_, i) => ({ fundingRate: '0.0009', fundingTime: now - (i + 1) * 8 * 3_600_000 }));
    const rising = series(131, 50_000, 0.003, 0.002);
    const crowded = buildSignalReport('BTC-USDT-SWAP', rising, hot, now, BTC, '100000', DEFAULT_TREND_PARAMS, undefined, '0.24');
    expect(crowded.signals.longEntry).toBe(true);
    expect(crowded.sizing?.long.multiplier).toBe('0.75');
    expect(crowded.sizing?.short.multiplier).toBe('0.5');
    expect(buildSignalReport('BTC-USDT-SWAP', rising, hot, now, BTC, '100000', DEFAULT_TREND_PARAMS, undefined, '0.1').sizing?.long.multiplier).toBe('1');
  });

  it('passes the open interest change per bar through to the crisis rule', () => {
    // a quiet rising series whose last bar jumps 1.2%: a breakout and a 3-sigma day, the vol ratio still below 2
    const candles = series(131, 50_000, 0.003, 0.002);
    const last = candles[candles.length - 1]!;
    const close = Number(last.open) * 1.012;
    candles[candles.length - 1] = { ...last, close: close.toFixed(1), high: (close * 1.004).toFixed(1) };
    const unknown = buildSignalReport('BTC-USDT-SWAP', candles, null, Date.now(), BTC, '100000');
    expect(unknown.regime).toBe('crisis');
    expect(unknown.sizing?.long.multiplier).toBe('0.5');
    const snaps = [{ ts: last.ts, value: '1000' }, { ts: last.ts + DAY, value: '1040' }];
    const known = buildSignalReport('BTC-USDT-SWAP', candles, null, Date.now(), BTC, '100000', DEFAULT_TREND_PARAMS, undefined, null, barOiChanges(snaps, candles.map((c) => c.ts)));
    expect(known.signals.longEntry).toBe(true);
    expect(known.regime).not.toBe('crisis');
    expect(known.indicators.shockBars).toMatchObject([{ daysAgo: 0, oiChange: '0.040000', crisis: false }]);
    expect(known.sizing?.long.multiplier).toBe('1');
    expect(known.signals.reasons.some((r) => r.includes('OI +4.0%: not a deleveraging day'))).toBe(true);
  });
});

describe('market structure', () => {
  it('measures spread, depth notional and imbalance over the top levels', async () => {
    const { computeBookMetrics, computeOpenInterestMetrics } = await import('../src/index.js');
    const book = {
      bids: [['50000', '10'], ['49990', '20'], ['49980', '30']] as Array<[string, string]>,
      asks: [['50010', '5'], ['50020', '5'], ['50030', '5']] as Array<[string, string]>,
      ts: 1,
    };
    const m = computeBookMetrics(book, BTC, 2)!;
    // mid 50005, spread 10 -> 10 / 50005
    expect(Number(m.spreadPct)).toBeCloseTo(10 / 50005, 9);
    // bid notional: 10*0.01*50000 + 20*0.01*49990 = 5000 + 9998 = 14998; ask: 5*0.01*50010 + 5*0.01*50020 = 2500.5 + 2501 = 5001.5
    expect(m.bidNotional).toBe('14998.00');
    expect(m.askNotional).toBe('5001.50');
    expect(Number(m.imbalance)).toBeCloseTo((14998 - 5001.5) / (14998 + 5001.5), 3);
    expect(m.levels).toBe(2);
    expect(computeBookMetrics({ bids: [], asks: [], ts: 1 }, BTC)).toBeNull();
  });
  it('computes open interest changes and percentile from a daily history', async () => {
    const { computeOpenInterestMetrics } = await import('../src/index.js');
    const hist = Array.from({ length: 30 }, (_, i) => ({ ts: i, value: String(1000 + i * 10) }));
    const m = computeOpenInterestMetrics(hist)!;
    expect(m.current).toBe('1290');
    expect(Number(m.change1d)).toBeCloseTo(10 / 1280, 5);
    expect(Number(m.change10d)).toBeCloseTo(100 / 1190, 5);
    expect(m.percentile30d).toBe('1.000');
    expect(m.points).toBe(30);
    expect(m.source).toBe('history');
    expect(computeOpenInterestMetrics([{ ts: 1, value: '5' }])!.change1d).toBe('');
    // changes on the coin column, level shown in USD: a price move alone must not show up as an OI change
    const flat = Array.from({ length: 12 }, (_, i) => ({ ts: i, value: '1000', usd: String(50_000_000 + i * 1_000_000) }));
    const f = computeOpenInterestMetrics(flat)!;
    expect(f.current).toBe('61000000');
    expect(f.unit).toBe('usd');
    expect(Number(f.change10d)).toBe(0);
    const live = computeOpenInterestMetrics([{ ts: 1, value: '5' }], 'contracts', 'live')!;
    expect(live).toMatchObject({ current: '5', unit: 'contracts', source: 'live', change1d: '', change10d: '' });
    expect(computeOpenInterestMetrics([])).toBeNull();
  });
  it('measures open interest changes on completed days only: the forming row is the level, never a reference', async () => {
    const { computeOpenInterestMetrics } = await import('../src/index.js');
    // 30 completed UTC days plus today's row, which OKX keeps rewriting until the day ends
    const completed = Array.from({ length: 30 }, (_, i) => ({ ts: i * DAY, value: String(1000 + i * 10), usd: String(2000 + i) }));
    const forming = { ts: 30 * DAY, value: '1291', usd: '5000' };
    const m = computeOpenInterestMetrics([...completed, forming], 'usd', 'history', 30 * DAY)!;
    expect(m.current).toBe('5000');
    // yesterday against the day before, and against ten days before: not today's first minutes against yesterday
    expect(Number(m.change1d)).toBeCloseTo(10 / 1280, 5);
    expect(Number(m.change10d)).toBeCloseTo(100 / 1190, 5);
    expect(m.percentile30d).toBe('1.000');
    expect(m.points).toBe(30);
    // without the parameter every row counts as completed, as before
    expect(Number(computeOpenInterestMetrics([...completed, forming])!.change1d)).toBeCloseTo(1 / 1290, 5);
    // the forming row has not appeared yet: the last completed day is the level
    expect(computeOpenInterestMetrics(completed, 'usd', 'history', 30 * DAY)).toMatchObject({ current: '2029', points: 30 });
    // only the forming row: a level without changes
    expect(computeOpenInterestMetrics([forming], 'usd', 'history', 30 * DAY)).toMatchObject({ current: '5000', change1d: '', change10d: '', percentile30d: '', points: 0 });
  });
});
