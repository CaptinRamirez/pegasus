/**
 * Statistics of a finished backtest.
 *
 * Everything here is computed FROM the resulting series (R per trade, daily equity, daily closes) and
 * uses plain numbers: means, deviations, a regression and a bootstrap are estimates, not money. The
 * money itself (prices, sizes, fees, funding, P&L, equity) is decimal arithmetic in engine.ts and
 * arrives here already computed.
 */

const DAYS_PER_YEAR = 365;

export function mean(xs: readonly number[]): number {
  if (xs.length === 0) return 0;
  let acc = 0;
  for (const x of xs) acc += x;
  return acc / xs.length;
}

/** Sample standard deviation; 0 for fewer than two values. */
export function stdev(xs: readonly number[]): number {
  if (xs.length < 2) return 0;
  const m = mean(xs);
  let ss = 0;
  for (const x of xs) ss += (x - m) ** 2;
  return Math.sqrt(ss / (xs.length - 1));
}

export function median(xs: readonly number[]): number {
  if (xs.length === 0) return 0;
  const sorted = [...xs].sort((a, b) => a - b);
  const mid = sorted.length >> 1;
  return sorted.length % 2 === 1 ? (sorted[mid] as number) : ((sorted[mid - 1] as number) + (sorted[mid] as number)) / 2;
}

export interface RStats {
  count: number;
  /** Share of trades with R > 0 */
  winRate: number;
  mean: number;
  median: number;
  /** Sum of the winning R over the sum of the losing R; null without a loss */
  profitFactor: number | null;
  total: number;
  /** Mean over its standard error; null for fewer than two trades or no dispersion */
  tStat: number | null;
  /** The two largest R, largest first */
  largest: number[];
  totalWithoutLargest: number;
  /** Trades that lost more than 1.5R (docs/archive/strategy-breakout.md section 5) */
  lossesBeyond1_5R: number;
}

export function rStats(rs: readonly number[]): RStats {
  const total = rs.reduce((a, b) => a + b, 0);
  const wins = rs.filter((r) => r > 0).reduce((a, b) => a + b, 0);
  const losses = rs.filter((r) => r < 0).reduce((a, b) => a - b, 0);
  const sd = stdev(rs);
  const largest = [...rs].sort((a, b) => b - a).slice(0, 2);
  return {
    count: rs.length,
    winRate: rs.length === 0 ? 0 : rs.filter((r) => r > 0).length / rs.length,
    mean: mean(rs),
    median: median(rs),
    profitFactor: losses > 0 ? wins / losses : null,
    total,
    tStat: rs.length >= 2 && sd > 0 ? mean(rs) / (sd / Math.sqrt(rs.length)) : null,
    largest,
    totalWithoutLargest: total - largest.reduce((a, b) => a + b, 0),
    lossesBeyond1_5R: rs.filter((r) => r < -1.5).length,
  };
}

/** Simple returns of a level series. */
export function returnsOf(levels: readonly number[]): number[] {
  const out: number[] = [];
  for (let i = 1; i < levels.length; i++) out.push((levels[i] as number) / (levels[i - 1] as number) - 1);
  return out;
}

/** Largest peak-to-trough fall of a level series, as a positive fraction. */
export function maxDrawdown(levels: readonly number[]): number {
  let peak = Number.NEGATIVE_INFINITY;
  let worst = 0;
  for (const v of levels) {
    if (v > peak) peak = v;
    if (peak > 0) worst = Math.max(worst, 1 - v / peak);
  }
  return worst;
}

export interface SeriesStats {
  /** Daily steps in the series */
  days: number;
  totalReturn: number;
  cagr: number;
  /** Standard deviation of the daily returns x sqrt(365) */
  vol: number;
  /** Zero rate, 365 days; null without dispersion */
  sharpe: number | null;
  maxDrawdown: number;
  /** CAGR over the maximum drawdown; null without a drawdown */
  mar: number | null;
}

/** Statistics of a level series sampled once a day. */
export function seriesStats(levels: readonly number[]): SeriesStats {
  const first = levels[0];
  const last = levels[levels.length - 1];
  const days = Math.max(0, levels.length - 1);
  if (first === undefined || last === undefined || days === 0 || !(first > 0)) return { days, totalReturn: 0, cagr: 0, vol: 0, sharpe: null, maxDrawdown: 0, mar: null };
  const rets = returnsOf(levels);
  const sd = stdev(rets);
  const growth = last / first;
  const cagr = growth > 0 ? growth ** (DAYS_PER_YEAR / days) - 1 : -1;
  const dd = maxDrawdown(levels);
  return {
    days,
    totalReturn: growth - 1,
    cagr,
    vol: sd * Math.sqrt(DAYS_PER_YEAR),
    sharpe: sd > 0 ? (mean(rets) / sd) * Math.sqrt(DAYS_PER_YEAR) : null,
    maxDrawdown: dd,
    mar: dd > 0 ? cagr / dd : null,
  };
}

export interface Regression {
  n: number;
  beta: number;
  /** Intercept per day x 365 */
  alphaAnnual: number;
  /** Intercept over its standard error; null when it cannot be estimated */
  alphaT: number | null;
  r2: number;
}

/** Ordinary least squares of y on x with an intercept. */
export function regress(y: readonly number[], x: readonly number[]): Regression | null {
  const n = Math.min(y.length, x.length);
  if (n < 3) return null;
  const mx = mean(x.slice(0, n));
  const my = mean(y.slice(0, n));
  let sxx = 0;
  let sxy = 0;
  let syy = 0;
  for (let i = 0; i < n; i++) {
    const dx = (x[i] as number) - mx;
    const dy = (y[i] as number) - my;
    sxx += dx * dx;
    sxy += dx * dy;
    syy += dy * dy;
  }
  if (!(sxx > 0)) return null;
  const beta = sxy / sxx;
  const alpha = my - beta * mx;
  const sse = Math.max(0, syy - beta * sxy);
  const s2 = sse / (n - 2);
  const seAlpha = Math.sqrt(s2 * (1 / n + (mx * mx) / sxx));
  return { n, beta, alphaAnnual: alpha * DAYS_PER_YEAR, alphaT: seAlpha > 0 ? alpha / seAlpha : null, r2: syy > 0 ? 1 - sse / syy : 0 };
}

/** Small seeded generator (mulberry32): the bootstrap gives the same answer on every run. */
export function seededRandom(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4_294_967_296;
  };
}

export interface BootstrapResult {
  /** Trades in the live sample */
  n: number;
  liveSum: number;
  draws: number;
  /** Share of the bootstrap sums at or below the live sum, 0..100 */
  percentile: number;
  /** 10th percentile of the bootstrap sums: below it the system may have stopped working (docs/archive/strategy-breakout.md section 5) */
  p10: number;
  median: number;
}

/**
 * Where the sum of the live R values falls among `draws` sums of as many values drawn with replacement
 * from the backtest's R values.
 */
export function bootstrapPercentile(backtestR: readonly number[], liveR: readonly number[], draws = 1000, seed = 1): BootstrapResult | null {
  if (backtestR.length === 0 || liveR.length === 0) return null;
  const random = seededRandom(seed);
  const liveSum = liveR.reduce((a, b) => a + b, 0);
  const sums: number[] = [];
  for (let d = 0; d < draws; d++) {
    let acc = 0;
    for (let k = 0; k < liveR.length; k++) acc += backtestR[Math.floor(random() * backtestR.length)] as number;
    sums.push(acc);
  }
  sums.sort((a, b) => a - b);
  return {
    n: liveR.length,
    liveSum,
    draws,
    percentile: (sums.filter((s) => s <= liveSum).length / draws) * 100,
    p10: sums[Math.floor(draws * 0.1)] as number,
    median: median(sums),
  };
}
