import { describe, expect, it } from 'vitest';
import { runBacktest } from '../src/engine.js';
import { buildSummary, equityCsv, formatSummary, tradesCsv } from '../src/report.js';
import { bootstrapPercentile, maxDrawdown, median, regress, returnsOf, rStats, seededRandom, seriesStats, stdev } from '../src/stats.js';
import { config, instrumentData, trendBars } from './helpers.js';

describe('R statistics', () => {
  it('summarises a known R series', () => {
    const s = rStats([2, -1, -1, 4, -2]);
    expect(s.count).toBe(5);
    expect(s.winRate).toBeCloseTo(0.4, 12);
    expect(s.mean).toBeCloseTo(0.4, 12);
    expect(s.median).toBe(-1);
    expect(s.profitFactor).toBeCloseTo(1.5, 12);
    expect(s.total).toBeCloseTo(2, 12);
    // sd = sqrt(25.2 / 4); t = 0.4 / (sd / sqrt(5))
    expect(s.tStat).toBeCloseTo(0.4 / (Math.sqrt(6.3) / Math.sqrt(5)), 12);
    expect(s.largest).toEqual([4, 2]);
    expect(s.totalWithoutLargest).toBeCloseTo(-4, 12);
    expect(s.lossesBeyond1_5R).toBe(1);
  });

  it('copes with no trades, one trade and no losses', () => {
    expect(rStats([])).toMatchObject({ count: 0, winRate: 0, mean: 0, profitFactor: null, tStat: null, largest: [] });
    expect(rStats([1.5])).toMatchObject({ count: 1, mean: 1.5, tStat: null, profitFactor: null, totalWithoutLargest: 0 });
    expect(median([3, 1, 2, 10])).toBe(2.5);
    expect(stdev([1])).toBe(0);
  });
});

describe('series statistics', () => {
  it('computes return, drawdown, volatility and Sharpe of a daily series', () => {
    const levels = [100, 110, 99, 121];
    const s = seriesStats(levels);
    expect(s.days).toBe(3);
    expect(s.totalReturn).toBeCloseTo(0.21, 12);
    expect(s.cagr / (1.21 ** (365 / 3) - 1)).toBeCloseTo(1, 9);
    expect(s.maxDrawdown).toBeCloseTo(0.1, 12);
    const rets = returnsOf(levels);
    expect(rets[0]).toBeCloseTo(0.1, 12);
    expect(s.vol).toBeCloseTo(stdev(rets) * Math.sqrt(365), 12);
    expect(s.sharpe).toBeCloseTo(((rets[0]! + rets[1]! + rets[2]!) / 3 / stdev(rets)) * Math.sqrt(365), 12);
    expect((s.mar ?? 0) / (s.cagr / 0.1)).toBeCloseTo(1, 9);
    expect(maxDrawdown([1, 2, 1, 3, 1.5])).toBeCloseTo(0.5, 12);
    expect(seriesStats([100])).toMatchObject({ days: 0, sharpe: null, mar: null });
  });

  it('regresses one return series on another', () => {
    const x = [0.01, -0.02, 0.03, 0.0, -0.01, 0.02];
    const noise = [0.001, -0.001, 0.0005, -0.0005, 0.001, -0.001];
    const y = x.map((v, i) => 0.002 + 0.5 * v + (noise[i] as number));
    const r = regress(y, x);
    expect(r?.n).toBe(6);
    expect(r?.beta).toBeCloseTo(0.5, 1);
    expect(r?.alphaAnnual).toBeCloseTo(0.002 * 365, 0);
    expect(r?.r2).toBeGreaterThan(0.9);
    expect(r?.alphaT).toBeGreaterThan(2);
    // An exact line: beta and alpha are recovered, nothing is left over.
    const exact = regress(x.map((v) => 0.001 + 2 * v), x);
    expect(exact?.beta).toBeCloseTo(2, 10);
    expect(exact?.alphaAnnual).toBeCloseTo(0.365, 10);
    expect(exact?.r2).toBeCloseTo(1, 10);
    expect(regress([1, 2], [1, 2])).toBeNull();
  });

  it('gives the hand-computed estimates on a small noisy input', () => {
    // mx = my = 2.5, sxx = 5, sxy = 3, syy = 5: beta 0.6, alpha 1, sse = 5 - 0.6 x 3 = 3.2, R2 = 0.36,
    // s2 = 3.2 / 2 = 1.6, se(alpha) = sqrt(1.6 x (1/4 + 2.5^2 / 5)) = sqrt(2.4).
    const r = regress([2, 1, 4, 3], [1, 2, 3, 4]);
    expect(r?.n).toBe(4);
    expect(r?.beta).toBeCloseTo(0.6, 9);
    expect(r?.alphaAnnual).toBeCloseTo(365, 9);
    expect(r?.r2).toBeCloseTo(0.36, 9);
    expect(r?.alphaT).toBeCloseTo(1 / Math.sqrt(2.4), 9);
  });
});

describe('bootstrap of the live R', () => {
  it('is seeded: the same inputs give the same answer', () => {
    const backtest = [3, -1, -1, 0.5, -1, 6, -1, -0.8, 2, -1];
    const a = bootstrapPercentile(backtest, [1, -1, 2]);
    expect(a).toEqual(bootstrapPercentile(backtest, [1, -1, 2]));
    expect(a?.draws).toBe(1000);
    expect(a?.n).toBe(3);
    expect(a?.liveSum).toBe(2);
    expect(a?.percentile).toBeGreaterThan(0);
    expect(a?.percentile).toBeLessThan(100);
    expect(seededRandom(7)()).toBe(seededRandom(7)());
  });

  it('places a sum against the bootstrap sums', () => {
    // Every draw of three sums to 3.
    expect(bootstrapPercentile([1, 1, 1], [1, 1, 1])?.percentile).toBe(100);
    expect(bootstrapPercentile([1, 1, 1], [0, 0, 0])?.percentile).toBe(0);
    expect(bootstrapPercentile([1, 1, 1], [0, 0, 0])?.p10).toBe(3);
    expect(bootstrapPercentile([], [1])).toBeNull();
  });
});

describe('summary', () => {
  const cfg = config();
  const result = runBacktest([instrumentData(trendBars(140))], cfg);

  it('keeps open lots out of the R statistics and reports the portfolio and the benchmark', () => {
    const summary = buildSummary(result, cfg, ['a note'], [0.5, -1]);
    expect(summary.trades).toMatchObject({ closed: 0, open: 1 });
    expect(summary.r.overall.count).toBe(0);
    expect(summary.signals).toMatchObject({ entries: 1, filled: 1 });
    expect(summary.portfolio.withFunding.days).toBe(result.series.length - 1);
    expect(summary.portfolio.timeInMarket).toBeGreaterThan(0.9);
    expect(summary.portfolio.avgGross).toBeGreaterThan(0.09);
    expect(summary.benchmark?.instruments).toEqual(['AAA-USDT-SWAP']);
    // A steady rise: the basket gains, and the strategy holds a tenth of it.
    expect(summary.benchmark?.buyAndHold.totalReturn).toBeGreaterThan(0);
    expect(summary.benchmark?.regression?.beta).toBeGreaterThan(0.05);
    expect(summary.benchmark?.regression?.beta).toBeLessThan(0.15);
    expect(summary.oiCoverage).toMatchObject({ known: 0, share: 0 });
    expect(summary.notes).toEqual(['a note']);
    // No closed trade to draw from: no bootstrap.
    expect(summary.liveR).toBeUndefined();
    expect(formatSummary(summary)).toContain('1 open at the end');
  });

  it('computes exposure, time in market and the basket at the average exposure from known samples', () => {
    const sample = (day: number, equity: string, gross: string, lots: number, mark: string): (typeof result.series)[number] => ({ ts: day * 86_400_000, equity, equityNoFunding: equity, gross, lots, marks: [mark] });
    // Gross over equity: 0, 0.2, 0.4, 0. The basket returns +10%, -10%, +20%.
    const series = [sample(0, '100', '0', 0, '50'), sample(1, '100', '20', 1, '55'), sample(2, '50', '20', 2, '49.5'), sample(3, '80', '0', 0, '59.4')];
    const summary = buildSummary({ ...result, series, trades: [], signals: [], decisions: [] }, cfg);
    expect(summary.portfolio.avgGross).toBeCloseTo(0.15, 12);
    expect(summary.portfolio.maxGross).toBeCloseTo(0.4, 12);
    expect(summary.portfolio.timeInMarket).toBe(0.5);
    expect(summary.benchmark?.buyAndHold.totalReturn).toBeCloseTo(0.188, 12);
    // 15% of the money in the basket, rebalanced daily: 1.015 x 0.985 x 1.03.
    expect(summary.benchmark?.atAvgExposure.totalReturn).toBeCloseTo(1.015 * 0.985 * 1.03 - 1, 12);
    expect(summary.benchmark?.atAvgExposure.maxDrawdown).toBeCloseTo(0.015, 12);
  });

  it('writes one row per trade and per day', () => {
    expect(tradesCsv(result.trades).trim().split('\n')).toHaveLength(1 + result.trades.length);
    const equity = equityCsv(result).trim().split('\n');
    expect(equity[0]).toBe('date,equity,equityNoFunding,gross,lots,AAA-USDT-SWAP');
    expect(equity).toHaveLength(1 + result.series.length);
  });
});
