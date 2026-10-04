import { D, Decimal, ZERO, floorToStep, type DecimalInput } from './decimal.js';
import { contractsToCoin, notionalQuote } from './sizing.js';
import { utcDayStart } from './time.js';
import type { Candle, Instrument, Lang } from './types.js';

/**
 * Daily signal arithmetic for the low-frequency trend framework (docs/strategy.md).
 *
 * Everything here is a pure function of CONFIRMED daily candles sorted oldest
 * first. The forming bar must be excluded by the caller: every rule in the
 * framework is evaluated once per bar, after its close (00:00 UTC, or the
 * second daily cut at 12:00 UTC; see the 'second daily cut' section).
 *
 * Conventions: "previous N bars" means the N bars before the last one, so a
 * breakout compares today's close with the channel built from yesterday back.
 */

export type Regime = 'trend' | 'neutral' | 'range' | 'crisis';

export interface TrendParams {
  /** Breakout channel length (entry) */
  entryChannel: number;
  /** Trailing channel length (exit) */
  exitChannel: number;
  atrPeriod: number;
  atrStopMultiple: string;
  trendMaPeriod: number;
  efficiencyPeriod: number;
  /** Efficiency ratio above which the market counts as trending */
  trendEfficiency: string;
  /** Efficiency ratio below which (and near the MA) the market counts as ranging */
  rangeEfficiency: string;
  volShortPeriod: number;
  volLongPeriod: number;
  /** vol20 / vol100 above which the market counts as a crisis */
  crisisVolRatio: string;
  /** |daily return| above this many daily sigmas (of the bars before it) is a shock bar */
  crisisReturnSigmas: string;
  /**
   * A shock bar is a crisis day when open interest fell by more than this fraction over the bar
   * (a forced deleveraging), or when its open interest change is unknown.
   */
  crisisOiDrop: string;
  /**
   * Closes for which a crisis day keeps the regime at crisis, the crisis bar included.
   * The framework says 5 to 10 trading days and leaves the number to a backtest; 5 is the low end.
   */
  crisisHoldBars: number;
  /**
   * Do not open longs when the 3-day 8h-normalised funding average is above this
   * (fraction, 0.001 = 0.1%/8h ≈ 110% p.a.). Positive funding is the normal state
   * of an uptrend (the perp premium is largely explained by past returns), so only
   * the extreme tail is treated as a crowding/tail-risk gate.
   */
  maxFundingForLong: string;
  /** Do not open shorts when the 3-day 8h-normalised funding average is below this */
  minFundingForShort: string;
  /** Window for the funding average, hours */
  fundingWindowHours: number;
  /** |3-day 8h-normalised funding average| above which a side may count as crowded (fraction) */
  crowdedFunding: string;
  /** 10-day open interest increase above which, together with crowdedFunding, the paying side is crowded (fraction) */
  crowdedOiChange: string;
  /**
   * Allow short entries. Off by default: short breakouts showed no expectancy in the backtest
   * (docs/strategy.md 3.1). Short exits and the short sizing plan are computed either way.
   */
  allowShort: boolean;
  /** Size multiplier for every short entry (the cost of the positive drift) */
  shortSizeMultiplier: string;
  /** Size multiplier for new entries on either side in the crisis regime */
  crisisSizeMultiplier: string;
  /** Size multiplier for new entries on the crowded side */
  crowdedSizeMultiplier: string;
  /**
   * Block new entries in the 'range' regime (low efficiency ratio near the MA).
   * Off by default: the evidence for choppiness filters on top of a slow trend
   * filter is weak and every extra filter is a degree of freedom to overfit.
   * Turn it on only after a backtest shows it helps out of sample.
   */
  useRangeFilter: boolean;
}

export const DEFAULT_TREND_PARAMS: TrendParams = {
  entryChannel: 55,
  exitChannel: 20,
  atrPeriod: 20,
  atrStopMultiple: '2.5',
  trendMaPeriod: 100,
  efficiencyPeriod: 20,
  trendEfficiency: '0.35',
  rangeEfficiency: '0.15',
  volShortPeriod: 20,
  volLongPeriod: 100,
  crisisVolRatio: '2',
  crisisReturnSigmas: '3',
  crisisOiDrop: '0.1',
  crisisHoldBars: 5,
  maxFundingForLong: '0.001',
  minFundingForShort: '-0.0005',
  fundingWindowHours: 72,
  crowdedFunding: '0.0008',
  crowdedOiChange: '0.2',
  allowShort: false,
  shortSizeMultiplier: '0.5',
  crisisSizeMultiplier: '0.5',
  crowdedSizeMultiplier: '0.75',
  useRangeFilter: false,
};

/** Minimum number of confirmed bars the indicators need. */
export function minBarsRequired(p: TrendParams = DEFAULT_TREND_PARAMS): number {
  return Math.max(p.trendMaPeriod, p.volLongPeriod + 1, p.entryChannel + 1, p.atrPeriod + 1, p.efficiencyPeriod + 1, p.volShortPeriod + p.crisisHoldBars + 1);
}

export class SignalError extends Error {
  constructor(
    public readonly code: string,
    message: string,
  ) {
    super(message);
    this.name = 'SignalError';
  }
}

// ---- indicators ----

/** Simple moving average of the last `n` values. */
export function sma(values: readonly DecimalInput[], n: number): Decimal {
  if (n <= 0 || values.length < n) throw new SignalError('NOT_ENOUGH_DATA', `sma(${n}) needs ${n} values, got ${values.length}`);
  let acc = ZERO;
  for (let i = values.length - n; i < values.length; i++) acc = acc.plus(D(values[i] as DecimalInput));
  return acc.div(n);
}

/** True range of bar i (needs the previous close). */
export function trueRange(candles: readonly Candle[], i: number): Decimal {
  const c = candles[i];
  if (!c) throw new SignalError('NOT_ENOUGH_DATA', 'bar out of range');
  const hl = D(c.high).minus(c.low);
  const prev = candles[i - 1];
  if (!prev) return hl;
  const hc = D(c.high).minus(prev.close).abs();
  const lc = D(c.low).minus(prev.close).abs();
  return Decimal.max(hl, hc, lc);
}

/** Average true range over the last `n` bars (simple average of true ranges). */
export function atr(candles: readonly Candle[], n: number): Decimal {
  if (candles.length < n + 1) throw new SignalError('NOT_ENOUGH_DATA', `atr(${n}) needs ${n + 1} bars, got ${candles.length}`);
  let acc = ZERO;
  for (let i = candles.length - n; i < candles.length; i++) acc = acc.plus(trueRange(candles, i));
  return acc.div(n);
}

/** Highest high and lowest low of the `n` bars ending just before index `end`. */
function channelBefore(candles: readonly Candle[], n: number, end: number): { high: Decimal; low: Decimal } {
  if (n <= 0 || end - n < 0) throw new SignalError('NOT_ENOUGH_DATA', `channel(${n}) needs ${n + candles.length - end} bars, got ${candles.length}`);
  let high: Decimal | null = null;
  let low: Decimal | null = null;
  for (let i = end - n; i < end; i++) {
    const c = candles[i] as Candle;
    const h = D(c.high);
    const l = D(c.low);
    if (high === null || h.gt(high)) high = h;
    if (low === null || l.lt(low)) low = l;
  }
  return { high: high as Decimal, low: low as Decimal };
}

/**
 * Highest high and lowest low of the `n` bars BEFORE the last bar
 * (the Donchian channel today's close is compared against).
 */
export function previousChannel(candles: readonly Candle[], n: number): { high: Decimal; low: Decimal } {
  return channelBefore(candles, n, candles.length - 1);
}

/**
 * Highest high and lowest low of the last `n` bars, the last bar included:
 * the channel the NEXT close will be compared against.
 */
export function trailingChannel(candles: readonly Candle[], n: number): { high: Decimal; low: Decimal } {
  return channelBefore(candles, n, candles.length);
}

/**
 * Kaufman efficiency ratio over `n` bars: |net move| / sum of |daily moves|.
 * 1 = straight line, ~0.22 = random walk over 20 bars (≈ 1/√n), 0 = pure chop.
 */
export function efficiencyRatio(closes: readonly DecimalInput[], n: number): Decimal {
  if (closes.length < n + 1) throw new SignalError('NOT_ENOUGH_DATA', `efficiencyRatio(${n}) needs ${n + 1} closes, got ${closes.length}`);
  const last = D(closes[closes.length - 1] as DecimalInput);
  const first = D(closes[closes.length - 1 - n] as DecimalInput);
  let path = ZERO;
  for (let i = closes.length - n; i < closes.length; i++) {
    path = path.plus(D(closes[i] as DecimalInput).minus(closes[i - 1] as DecimalInput).abs());
  }
  if (path.isZero()) return ZERO;
  return last.minus(first).abs().div(path);
}

/** Daily log returns of the last `n` bars. */
export function logReturns(closes: readonly DecimalInput[], n: number): Decimal[] {
  if (closes.length < n + 1) throw new SignalError('NOT_ENOUGH_DATA', `returns(${n}) need ${n + 1} closes, got ${closes.length}`);
  const out: Decimal[] = [];
  for (let i = closes.length - n; i < closes.length; i++) {
    out.push(D(closes[i] as DecimalInput).div(closes[i - 1] as DecimalInput).ln());
  }
  return out;
}

/** Sample standard deviation. */
export function stdev(values: readonly Decimal[]): Decimal {
  if (values.length < 2) return ZERO;
  let mean = ZERO;
  for (const v of values) mean = mean.plus(v);
  mean = mean.div(values.length);
  let ss = ZERO;
  for (const v of values) ss = ss.plus(v.minus(mean).pow(2));
  return ss.div(values.length - 1).sqrt();
}

const SQRT_365 = new Decimal(365).sqrt();

/** Daily standard deviation of log returns over the last `n` bars (not annualised). */
export function dailyVol(closes: readonly DecimalInput[], n: number): Decimal {
  return stdev(logReturns(closes, n));
}

/** Annualised realised volatility (daily sigma × √365). */
export function realizedVol(closes: readonly DecimalInput[], n: number): Decimal {
  return dailyVol(closes, n).mul(SQRT_365);
}

// ---- funding ----

export interface FundingRecord {
  /** Fraction per settlement, e.g. "0.0001" = 0.01% */
  fundingRate: string;
  /** Settlement time, epoch ms */
  fundingTime: number;
}

export interface FundingSummary {
  /** Average of the 8h-normalised rates inside the window */
  avg8h: string;
  /** Latest 8h-normalised rate */
  latest8h: string;
  samples: number;
  /** Annualised equivalent of avg8h (× 3 × 365) */
  annualized: string;
}

const EIGHT_HOURS = 8 * 3_600_000;

/**
 * Normalise settlement records to an 8-hour basis and average them over the
 * window ending at `now`. OKX shortens the settlement interval (8h → 4h → 2h → 1h)
 * when funding is capped, so raw averages understate crowding; each record is
 * scaled by 8h / its own interval. A record covers the period ENDING at its
 * fundingTime, so the interval is the gap to the previous record (the oldest
 * record, which has none, borrows the gap to the next one).
 */
export function summarizeFunding(records: readonly FundingRecord[], now: number, windowHours = DEFAULT_TREND_PARAMS.fundingWindowHours): FundingSummary | null {
  const sorted = [...records].filter((r) => r.fundingRate !== '' && Number.isFinite(r.fundingTime)).sort((a, b) => a.fundingTime - b.fundingTime);
  if (sorted.length === 0) return null;
  const windowStart = now - windowHours * 3_600_000;
  const normalised: Decimal[] = [];
  let latest: Decimal | null = null;
  for (let i = 0; i < sorted.length; i++) {
    const r = sorted[i] as FundingRecord;
    const next = sorted[i + 1];
    const prev = sorted[i - 1];
    let interval = prev ? r.fundingTime - prev.fundingTime : next ? next.fundingTime - r.fundingTime : EIGHT_HOURS;
    if (!(interval > 0) || interval > EIGHT_HOURS * 1.5) interval = EIGHT_HOURS;
    const scaled = D(r.fundingRate).mul(EIGHT_HOURS / interval);
    latest = scaled;
    if (r.fundingTime >= windowStart) normalised.push(scaled);
  }
  if (normalised.length === 0 && latest !== null) normalised.push(latest);
  let acc = ZERO;
  for (const v of normalised) acc = acc.plus(v);
  const avg = acc.div(normalised.length);
  return { avg8h: avg.toFixed(), latest8h: (latest ?? ZERO).toFixed(), samples: normalised.length, annualized: avg.mul(3 * 365).toFixed() };
}

// ---- open interest per bar ----

/** Fractional open interest change over the bar that OPENS at `ts`: the level at ts + bar length over the level at ts, minus 1. */
export interface BarOiChange {
  ts: number;
  change: string;
}

/**
 * Open interest change of each bar from levels at known instants. A bar gets an entry only when the
 * levels at BOTH its open and its close exist exactly; a bar without one is left out (unknown).
 */
export function barOiChanges(snapshots: ReadonlyArray<{ ts: number; value: string }>, barOpenTimes: readonly number[], barMs = 86_400_000): BarOiChange[] {
  const levels = new Map<number, string>();
  for (const s of snapshots) {
    if (s.value !== '' && D(s.value).gt(0)) levels.set(s.ts, s.value);
  }
  const out: BarOiChange[] = [];
  for (const ts of barOpenTimes) {
    const open = levels.get(ts);
    const close = levels.get(ts + barMs);
    if (open !== undefined && close !== undefined) out.push({ ts, change: D(close).div(open).minus(1).toFixed(6) });
  }
  return out;
}

// ---- regime and signals ----

/** A bar inside the crisis hold window whose return exceeded crisisReturnSigmas. */
export interface ShockBar {
  /** Closes since the bar (0 = the last bar) */
  daysAgo: number;
  /** Log return of the bar */
  return: string;
  /** Fractional open interest change over the bar, '' when unknown */
  oiChange: string;
  /** Open interest fell by more than crisisOiDrop, or its change is unknown */
  crisis: boolean;
}

export interface IndicatorSnapshot {
  /** Open time of the last confirmed bar */
  asOf: number;
  bars: number;
  close: string;
  ma: string;
  atr: string;
  atrPct: string;
  entryHigh: string;
  entryLow: string;
  exitHigh: string;
  exitLow: string;
  /** Exit channel including the last bar: what the NEXT close is tested against (the trailing stop level for the next session) */
  nextExitHigh: string;
  nextExitLow: string;
  efficiencyRatio: string;
  volShort: string;
  volLong: string;
  volRatio: string;
  dailyReturn: string;
  /** Standard deviation of the volShortPeriod daily log returns BEFORE the last bar (the last return is not in its own yardstick) */
  dailySigma: string;
  /** Shock bars inside the hold window, most recent first; only those with `crisis` set cut the size */
  shockBars: ShockBar[];
  /** Closes since the most recent crisis bar inside the hold window (0 = the last bar); null when there is none */
  crisisDaysAgo: number | null;
  /** Distance of close from the MA in ATRs, signed */
  maDistanceAtr: string;
}

export function computeIndicators(
  candles: readonly Candle[],
  p: TrendParams = DEFAULT_TREND_PARAMS,
  /** Open interest change per bar (see barOiChanges); a bar without an entry counts as unknown */
  oiChanges: readonly BarOiChange[] | null = null,
): IndicatorSnapshot {
  const need = minBarsRequired(p);
  if (candles.length < need) throw new SignalError('NOT_ENOUGH_DATA', `need at least ${need} confirmed daily bars, got ${candles.length}`);
  for (let i = 1; i < candles.length; i++) {
    if ((candles[i] as Candle).ts <= (candles[i - 1] as Candle).ts) throw new SignalError('UNSORTED', 'candles must be sorted oldest first without duplicates');
  }
  const last = candles[candles.length - 1] as Candle;
  const prev = candles[candles.length - 2] as Candle;
  const closes = candles.map((c) => c.close);
  const close = D(last.close);
  const ma = sma(closes, p.trendMaPeriod);
  const a = atr(candles, p.atrPeriod);
  const entry = previousChannel(candles, p.entryChannel);
  const exit = previousChannel(candles, p.exitChannel);
  const nextExit = trailingChannel(candles, p.exitChannel);
  const er = efficiencyRatio(closes, p.efficiencyPeriod);
  const volShort = realizedVol(closes, p.volShortPeriod);
  const volLong = realizedVol(closes, p.volLongPeriod);
  const sigma = dailyVol(closes.slice(0, -1), p.volShortPeriod);
  const dailyReturn = close.div(prev.close).ln();
  // A shock in either direction is a crisis day only when open interest fell with it (a forced deleveraging).
  // An unknown open interest change counts as one: where the data is silent the smaller size wins.
  const oiByBar = new Map<number, string>();
  for (const c of oiChanges ?? []) oiByBar.set(c.ts, c.change);
  const shockBars: ShockBar[] = [];
  for (let ago = 0; ago < p.crisisHoldBars; ago++) {
    const i = closes.length - 1 - ago;
    const ret = D(closes[i] as string).div(closes[i - 1] as string).ln();
    const priorSigma = ago === 0 ? sigma : dailyVol(closes.slice(0, i), p.volShortPeriod);
    if (!priorSigma.gt(0) || !ret.abs().gt(priorSigma.mul(p.crisisReturnSigmas))) continue;
    const oiChange = oiByBar.get((candles[i] as Candle).ts) ?? '';
    shockBars.push({ daysAgo: ago, return: ret.toFixed(), oiChange, crisis: oiChange === '' || D(oiChange).lt(D(p.crisisOiDrop).neg()) });
  }
  const crisisDaysAgo = shockBars.find((b) => b.crisis)?.daysAgo ?? null;
  return {
    asOf: last.ts,
    bars: candles.length,
    close: close.toFixed(),
    ma: ma.toFixed(),
    atr: a.toFixed(),
    atrPct: a.div(close).toFixed(),
    entryHigh: entry.high.toFixed(),
    entryLow: entry.low.toFixed(),
    exitHigh: exit.high.toFixed(),
    exitLow: exit.low.toFixed(),
    nextExitHigh: nextExit.high.toFixed(),
    nextExitLow: nextExit.low.toFixed(),
    efficiencyRatio: er.toFixed(),
    volShort: volShort.toFixed(),
    volLong: volLong.toFixed(),
    volRatio: volLong.isZero() ? '0' : volShort.div(volLong).toFixed(),
    dailyReturn: dailyReturn.toFixed(),
    dailySigma: sigma.toFixed(),
    shockBars,
    crisisDaysAgo,
    maDistanceAtr: a.isZero() ? '0' : close.minus(ma).div(a).toFixed(),
  };
}

export function classifyRegime(ind: IndicatorSnapshot, p: TrendParams = DEFAULT_TREND_PARAMS): Regime {
  // With overlapping 20 and 100 day windows this ratio tops out near sqrt(5); kept as the framework states it.
  if (D(ind.volRatio).gt(p.crisisVolRatio) || ind.crisisDaysAgo !== null) return 'crisis';
  const er = D(ind.efficiencyRatio);
  const dist = D(ind.maDistanceAtr).abs();
  if (er.lt(p.rangeEfficiency) && dist.lte(1)) return 'range';
  if (er.gt(p.trendEfficiency) && dist.gt(1)) return 'trend';
  return 'neutral';
}

export interface TrendSignals {
  longEntry: boolean;
  shortEntry: boolean;
  longExit: boolean;
  shortExit: boolean;
  /** Human-readable explanation of every condition, true or false, in the language asked for */
  reasons: string[];
}

const REGIME_ZH: Record<Regime, string> = { trend: '趋势', neutral: '中性', range: '震荡', crisis: '危机' };

export function evaluateTrendSignals(ind: IndicatorSnapshot, regime: Regime, funding: FundingSummary | null, p: TrendParams = DEFAULT_TREND_PARAMS, lang: Lang = 'en'): TrendSignals {
  const zh = lang === 'zh';
  const close = D(ind.close);
  const reasons: string[] = [];
  const aboveMa = close.gt(ind.ma);
  const belowMa = close.lt(ind.ma);
  const breakUp = close.gt(ind.entryHigh);
  const breakDown = close.lt(ind.entryLow);
  const fundingOkLong = funding === null || D(funding.avg8h).lt(p.maxFundingForLong);
  const fundingOkShort = funding === null || D(funding.avg8h).gt(p.minFundingForShort);
  const regimeOk = !p.useRangeFilter || regime !== 'range';
  const longExit = close.lt(ind.exitLow);
  const shortExit = close.gt(ind.exitHigh);
  const shockMove = (b: ShockBar): string => {
    const move = D(b.return).exp().minus(1).mul(100);
    return `${move.gte(0) ? '+' : ''}${move.toFixed(2)}%`;
  };
  const shockOi = (b: ShockBar): string => `${D(b.oiChange).gte(0) ? '+' : ''}${D(b.oiChange).mul(100).toFixed(1)}%`;
  const fundingAvg = funding === null ? '' : D(funding.avg8h).mul(100).toFixed(4);
  if (zh) {
    const closesAgo = (ago: number): string => (ago === 0 ? '最近一根K线' : `${ago} 根之前的K线`);
    reasons.push(`收盘价 ${ind.close} 对比 ${p.entryChannel} 日高点 ${ind.entryHigh}：${breakUp ? '向上突破' : '否'}`);
    reasons.push(`收盘价对比 ${p.entryChannel} 日低点 ${ind.entryLow}：${breakDown ? '向下突破' : '否'}`);
    if (!p.allowShort) reasons.push('做空已关闭（allowShort = false）：不开空仓；空头离场信号仍会计算');
    reasons.push(`收盘价对比 MA${p.trendMaPeriod} ${ind.ma}：${aboveMa ? '高于' : belowMa ? '低于' : '等于'}`);
    if (regime === 'crisis') {
      const halfSize = `新开仓按半仓（x${p.crisisSizeMultiplier}）`;
      if (ind.crisisDaysAgo === null) {
        reasons.push(`市场状态 危机：${p.volShortPeriod} 日/${p.volLongPeriod} 日波动率比值 ${D(ind.volRatio).toFixed(2)} 高于 ${p.crisisVolRatio}；持续期间${halfSize}`);
      } else {
        const left = p.crisisHoldBars - 1 - ind.crisisDaysAgo;
        reasons.push(`市场状态 危机：${closesAgo(ind.crisisDaysAgo)}是危机日；本次收盘及之后 ${left} 次收盘${halfSize}`);
      }
    } else {
      reasons.push(`市场状态 ${REGIME_ZH[regime]}：${regimeOk ? '允许新开仓' : '不开新仓'}${p.useRangeFilter ? '' : '（震荡过滤已关闭）'}`);
    }
    for (const b of ind.shockBars) {
      const oi = b.oiChange === '' ? '持仓量变化未知，按危机处理' : `持仓量 ${shockOi(b)}：${b.crisis ? '危机' : '非去杠杆日'}`;
      reasons.push(`冲击：${closesAgo(b.daysAgo)}涨跌 ${shockMove(b)}（超过 ${p.crisisReturnSigmas} 倍标准差）；${oi}`);
    }
    const fundingShort = p.allowShort ? `，做空${fundingOkShort ? '允许' : '禁止'}` : '';
    reasons.push(funding === null ? '资金费率：无数据（已跳过过滤）' : `资金费率 3 日均值 ${fundingAvg}%/8h：做多${fundingOkLong ? '允许' : '禁止'}${fundingShort}`);
    reasons.push(`离场：收盘价对比 ${p.exitChannel} 日低点 ${ind.exitLow} → 多头离场 ${longExit ? '是' : '否'}；对比 ${p.exitChannel} 日高点 ${ind.exitHigh} → 空头离场 ${shortExit ? '是' : '否'}`);
  } else {
    const closesAgo = (ago: number): string => (ago === 0 ? 'the last bar' : `the bar ${ago} ${ago === 1 ? 'close' : 'closes'} ago`);
    reasons.push(`close ${ind.close} vs ${p.entryChannel}d high ${ind.entryHigh}: ${breakUp ? 'breakout up' : 'no'}`);
    reasons.push(`close vs ${p.entryChannel}d low ${ind.entryLow}: ${breakDown ? 'breakout down' : 'no'}`);
    if (!p.allowShort) reasons.push('shorts off (allowShort = false): no short entries; the short exit is still evaluated');
    reasons.push(`close vs MA${p.trendMaPeriod} ${ind.ma}: ${aboveMa ? 'above' : belowMa ? 'below' : 'equal'}`);
    if (regime === 'crisis') {
      const halfSize = `new entries at half size (x${p.crisisSizeMultiplier})`;
      if (ind.crisisDaysAgo === null) {
        reasons.push(`regime crisis: ${p.volShortPeriod}d/${p.volLongPeriod}d vol ratio ${D(ind.volRatio).toFixed(2)} above ${p.crisisVolRatio}; ${halfSize} while it lasts`);
      } else {
        const left = p.crisisHoldBars - 1 - ind.crisisDaysAgo;
        reasons.push(`regime crisis: ${closesAgo(ind.crisisDaysAgo)} was a crisis day; ${halfSize} for this close and ${left} more ${left === 1 ? 'close' : 'closes'}`);
      }
    } else {
      reasons.push(`regime ${regime}: ${regimeOk ? 'new entries allowed' : 'no new entries'}${p.useRangeFilter ? '' : ' (range filter off)'}`);
    }
    for (const b of ind.shockBars) {
      const oi = b.oiChange === '' ? 'OI change unavailable, counted as crisis' : `OI ${shockOi(b)}: ${b.crisis ? 'crisis' : 'not a deleveraging day'}`;
      reasons.push(`shock: ${closesAgo(b.daysAgo)} moved ${shockMove(b)} (more than ${p.crisisReturnSigmas} sigma); ${oi}`);
    }
    const fundingShort = p.allowShort ? `, short ${fundingOkShort ? 'ok' : 'blocked'}` : '';
    reasons.push(funding === null ? 'funding: no data (filter skipped)' : `funding 3d avg ${fundingAvg}%/8h: long ${fundingOkLong ? 'ok' : 'blocked'}${fundingShort}`);
    reasons.push(`exit: close vs ${p.exitChannel}d low ${ind.exitLow} → long exit ${longExit ? 'YES' : 'no'}; vs ${p.exitChannel}d high ${ind.exitHigh} → short exit ${shortExit ? 'YES' : 'no'}`);
  }
  return {
    longEntry: breakUp && aboveMa && regimeOk && fundingOkLong,
    shortEntry: p.allowShort && breakDown && belowMa && regimeOk && fundingOkShort,
    longExit,
    shortExit,
    reasons,
  };
}

// ---- sizing ----

export interface SizingParams {
  /** Fraction of equity risked per trade, e.g. "0.0075" */
  riskPct: string;
  /** Cap on a single unit's notional as a fraction of equity, e.g. "0.10" */
  maxNotionalPct: string;
  atrStopMultiple: string;
}

export const DEFAULT_SIZING: SizingParams = { riskPct: '0.0075', maxNotionalPct: '0.10', atrStopMultiple: '2.5' };

export type EntrySide = 'long' | 'short';

export interface SizeAdjustment {
  /** Product of the applied cuts, "1" when none applies */
  multiplier: string;
  /** One human-readable entry per applied cut, e.g. "short x0.5" (in Chinese "做空 x0.5") */
  adjustments: string[];
}

const NO_ADJUSTMENT: SizeAdjustment = { multiplier: '1', adjustments: [] };

/**
 * Size cuts the framework requires for a new entry on `side`: shorts at half size,
 * half size on both sides in the crisis regime, three quarters on the crowded side
 * (extreme funding together with a 10-day open interest build-up; the longs are the
 * crowded side when funding is positive). The cuts stack multiplicatively. When
 * funding is extreme but the open interest change is unknown the cut is applied
 * anyway: where the framework is silent the smaller size wins.
 */
export function sizeAdjustment(side: EntrySide, regime: Regime, funding: FundingSummary | null, oiChange10d: DecimalInput | null, p: TrendParams = DEFAULT_TREND_PARAMS, lang: Lang = 'en'): SizeAdjustment {
  const zh = lang === 'zh';
  let multiplier = D(1);
  const adjustments: string[] = [];
  if (side === 'short') {
    multiplier = multiplier.mul(p.shortSizeMultiplier);
    adjustments.push(`${zh ? '做空' : 'short'} x${p.shortSizeMultiplier}`);
  }
  if (regime === 'crisis') {
    multiplier = multiplier.mul(p.crisisSizeMultiplier);
    adjustments.push(`${zh ? '危机' : 'crisis'} x${p.crisisSizeMultiplier}`);
  }
  if (funding !== null) {
    const avg = D(funding.avg8h);
    const crowdedSide: EntrySide = avg.gt(0) ? 'long' : 'short';
    const oiKnown = oiChange10d !== null && oiChange10d !== '';
    if (avg.abs().gt(p.crowdedFunding) && crowdedSide === side && (!oiKnown || D(oiChange10d).gt(p.crowdedOiChange))) {
      multiplier = multiplier.mul(p.crowdedSizeMultiplier);
      const oiPct = oiKnown ? D(oiChange10d).mul(100).toFixed(0) : '';
      const fundingPct = avg.mul(100).toFixed(2);
      if (zh) adjustments.push(`拥挤 x${p.crowdedSizeMultiplier}（资金费率 ${fundingPct}%/8h，${oiKnown ? `持仓量 10 日 +${oiPct}%` : '10 日持仓量变化未知'}）`);
      else adjustments.push(`crowded x${p.crowdedSizeMultiplier} (funding ${fundingPct}%/8h, ${oiKnown ? `OI +${oiPct}% in 10d` : '10d OI change unavailable'})`);
    }
  }
  return { multiplier: multiplier.toFixed(), adjustments };
}

export interface SizingPlan {
  entryPx: string;
  stopLong: string;
  stopShort: string;
  /** Stop distance as a fraction of the entry price */
  stopDistancePct: string;
  /** Notional before the cap */
  rawNotional: string;
  /** Notional aimed at (after the cap and the size multiplier), before rounding down to whole lots */
  targetNotional: string;
  /** Notional of `contracts`, the order actually proposed; "0.00" when contracts is "0" */
  notional: string;
  capped: boolean;
  /** Size multiplier applied after the cap (see sizeAdjustment), "1" when none */
  multiplier: string;
  adjustments: string[];
  /** Contracts, rounded down to lotSz; "0" when the minimum order size already exceeds the risk budget */
  contracts: string;
  coin: string;
  /** Quote-currency loss if the stop is hit with `contracts` */
  riskQuote: string;
  /** Loss of the minimum order size (minSz contracts) at the stop */
  minUnitRiskQuote: string;
  note: string;
}

/**
 * Position size from the stop distance: notional = equity × risk% ÷ stop%,
 * capped at maxNotionalPct of equity, reduced by the size multiplier, converted
 * to contracts and rounded down. The minimum order size is checked last. The
 * notional, coin and risk reported are those of the rounded order.
 */
export function planSize(equity: DecimalInput, entryPx: DecimalInput, atrValue: DecimalInput, inst: Instrument, s: SizingParams = DEFAULT_SIZING, adj: SizeAdjustment = NO_ADJUSTMENT, lang: Lang = 'en'): SizingPlan {
  const zh = lang === 'zh';
  const eq = D(equity);
  const px = D(entryPx);
  const stopDist = D(atrValue).mul(s.atrStopMultiple);
  if (px.lte(0) || stopDist.lte(0)) throw new SignalError('BAD_INPUT', 'price and ATR must be positive');
  const distPct = stopDist.div(px);
  const rawNotional = eq.mul(s.riskPct).div(distPct);
  const cap = eq.mul(s.maxNotionalPct);
  const capped = rawNotional.gt(cap);
  const reduced = !D(adj.multiplier).eq(1);
  const targetNotional = (capped ? cap : rawNotional).mul(adj.multiplier);
  const unit = D(inst.ctVal).mul(inst.ctMult || '1');
  const perContractNotional = inst.ctType === 'linear' ? unit.mul(px) : unit;
  const minUnitRisk = perContractNotional.mul(inst.minSz).mul(distPct);
  let contracts = floorToStep(targetNotional.div(perContractNotional), inst.lotSz);
  const capPct = D(s.maxNotionalPct).mul(100).toFixed(0);
  const riskPct = D(s.riskPct).mul(100).toFixed(2);
  const cuts = adj.adjustments.join(zh ? '，' : ', ');
  let note: string;
  if (zh) {
    note = capped ? `名义价值封顶为权益的 ${capPct}%；实际风险低于 ${riskPct}%` : '按止损距离计算仓位';
    if (reduced) note += `；仓位 x${adj.multiplier}（${cuts}）`;
  } else {
    note = capped ? `notional capped at ${capPct}% of equity; actual risk below ${riskPct}%` : 'sized from the stop distance';
    if (reduced) note += `; size x${adj.multiplier} (${cuts})`;
  }
  if (contracts.lt(inst.minSz)) {
    contracts = ZERO;
    const budget = eq.mul(s.riskPct).mul(adj.multiplier).toFixed(2);
    note = zh
      ? `最小下单量（${inst.minSz} 张）的风险为 ${minUnitRisk.toFixed(2)}，超过预算 ${budget}${reduced ? `（已按仓位 x${adj.multiplier} 调整：${cuts}）` : ''}；当前权益下不要交易该合约`
      : `the minimum order size (${inst.minSz} contracts) would risk ${minUnitRisk.toFixed(2)} which exceeds the budget ${budget}${reduced ? ` (after size x${adj.multiplier}: ${cuts})` : ''}; do not trade this instrument at this equity`;
  }
  const notional = contracts.isZero() ? ZERO : notionalQuote(contracts, px, inst);
  const riskQuote = notional.mul(distPct);
  return {
    entryPx: px.toFixed(),
    stopLong: px.minus(stopDist).toFixed(),
    stopShort: px.plus(stopDist).toFixed(),
    stopDistancePct: distPct.toFixed(),
    rawNotional: rawNotional.toFixed(2),
    targetNotional: targetNotional.toFixed(2),
    notional: notional.toFixed(2),
    capped,
    multiplier: D(adj.multiplier).toFixed(),
    adjustments: [...adj.adjustments],
    contracts: contracts.toFixed(),
    coin: contracts.isZero() ? '0' : contractsToCoin(contracts, inst, px).toFixed(),
    riskQuote: riskQuote.toFixed(2),
    minUnitRiskQuote: minUnitRisk.toFixed(2),
    note,
  };
}

// ---- full report ----

export interface InstrumentSignalReport {
  instId: string;
  /** The daily cut the bars of this report close at (UTC hour) */
  phase: SignalPhase;
  indicators: IndicatorSnapshot;
  regime: Regime;
  funding: FundingSummary | null;
  signals: TrendSignals;
  /** One plan per side, each with its own size multiplier; null when there is no equity to size from */
  sizing: { long: SizingPlan; short: SizingPlan } | null;
  /** Execution context (book depth/imbalance, open interest); filled in by the API, null when unavailable */
  structure: MarketStructure | null;
  /** When the candles and funding behind this report were fetched from the exchange; filled in by the API */
  dataFetchedAt: number | null;
  params: TrendParams;
}

export function buildSignalReport(
  instId: string,
  candles: readonly Candle[],
  funding: readonly FundingRecord[] | null,
  now: number,
  inst: Instrument | null,
  equity: DecimalInput | null,
  p: TrendParams = DEFAULT_TREND_PARAMS,
  s: SizingParams = DEFAULT_SIZING,
  /** Fractional 10-day change of the instrument's open interest (crowding rule), null when unknown */
  oiChange10d: DecimalInput | null = null,
  /** Open interest change per daily bar (crisis rule, see barOiChanges); null when unknown for every bar */
  oiChanges: readonly BarOiChange[] | null = null,
  /** The daily cut `candles` close at; the caller builds the bars of that cut (see dailyBarsFromHalfDays) */
  phase: SignalPhase = 0,
  /** Language of the texts in the report: signals.reasons, the sizing notes and adjustments */
  lang: Lang = 'en',
): InstrumentSignalReport {
  const confirmed = candles.filter((c) => c.confirm);
  const indicators = computeIndicators(confirmed, p, oiChanges);
  const regime = classifyRegime(indicators, p);
  const fundingSummary = funding ? summarizeFunding(funding, now, p.fundingWindowHours) : null;
  const signals = evaluateTrendSignals(indicators, regime, fundingSummary, p, lang);
  const adjLong = sizeAdjustment('long', regime, fundingSummary, oiChange10d, p, lang);
  const adjShort = sizeAdjustment('short', regime, fundingSummary, oiChange10d, p, lang);
  for (const a of adjLong.adjustments) signals.reasons.push(lang === 'zh' ? `做多仓位：${a}` : `long size: ${a}`);
  if (p.allowShort) for (const a of adjShort.adjustments) signals.reasons.push(lang === 'zh' ? `做空仓位：${a}` : `short size: ${a}`);
  const sizingParams = { ...s, atrStopMultiple: p.atrStopMultiple };
  const sizing =
    inst && equity !== null && D(equity).gt(0)
      ? { long: planSize(equity, indicators.close, indicators.atr, inst, sizingParams, adjLong, lang), short: planSize(equity, indicators.close, indicators.atr, inst, sizingParams, adjShort, lang) }
      : null;
  return { instId, phase, indicators, regime, funding: fundingSummary, signals, sizing, structure: null, dataFetchedAt: null, params: p };
}

// ---- second daily cut ----

/** UTC hours at which a signal day may close. */
export const SIGNAL_PHASE_HOURS = [0, 12] as const;
export type SignalPhase = 0 | 12;

const HOUR_MS = 3_600_000;
const HALF_DAY_MS = 12 * HOUR_MS;

/** Start of the phase-day containing `ts`: phase-days run from phase:00 UTC to phase:00 UTC the next day (phase 0 is the UTC day). */
export function phaseDayStart(ts: number, phase: SignalPhase): number {
  return utcDayStart(ts - phase * HOUR_MS) + phase * HOUR_MS;
}

/**
 * Daily candles that open at phase:00 UTC, each built from the two consecutive 12-hour UTC candles
 * that open at phase:00 and 12 hours later. A day is emitted only when both halves are present and
 * is confirmed only when both are. Oldest first.
 */
export function dailyBarsFromHalfDays(halfDayCandles: readonly Candle[], phase: SignalPhase): Candle[] {
  const byTs = new Map<number, Candle>();
  for (const c of halfDayCandles) byTs.set(c.ts, c);
  const out: Candle[] = [];
  for (const first of [...byTs.values()].sort((a, b) => a.ts - b.ts)) {
    if (phaseDayStart(first.ts, phase) !== first.ts) continue;
    const second = byTs.get(first.ts + HALF_DAY_MS);
    if (!second) continue;
    out.push({
      ts: first.ts,
      open: first.open,
      high: Decimal.max(first.high, second.high).toFixed(),
      low: Decimal.min(first.low, second.low).toFixed(),
      close: second.close,
      vol: D(first.vol).plus(second.vol).toFixed(),
      volCcy: D(first.volCcy).plus(second.volCcy).toFixed(),
      confirm: first.confirm && second.confirm,
    });
  }
  return out;
}

/**
 * Sizing of one phase's lot when the signal is computed at `phaseCount` daily cuts: the risk and the
 * notional cap of a unit are shared equally between the cuts, so the lots together stay within one unit.
 */
export function splitSizingAcrossPhases(s: SizingParams, phaseCount: number): SizingParams {
  if (!Number.isInteger(phaseCount) || phaseCount < 1) throw new SignalError('BAD_INPUT', 'phaseCount must be a positive integer');
  return { ...s, riskPct: D(s.riskPct).div(phaseCount).toFixed(), maxNotionalPct: D(s.maxNotionalPct).div(phaseCount).toFixed() };
}

/** A row of GET /api/signals that could not be computed. */
export interface SignalReportError {
  instId: string;
  /** The daily cut that could not be computed */
  phase: SignalPhase;
  error: { code: string; message: string };
}

export type SignalReportRow = InstrumentSignalReport | SignalReportError;

export function isSignalReportError(row: SignalReportRow): row is SignalReportError {
  return 'error' in row;
}

/** Response of GET /api/signals. */
export interface SignalsResponse {
  generatedAt: number;
  equity: string | null;
  /** The daily cuts the server computes, whether or not the request filtered the rows to one of them */
  phases: SignalPhase[];
  /** The sizing parameters of ONE cut's lot, as the plans were computed: the unit's values (request overrides applied) split across `phases` */
  sizingParams: SizingParams;
  reports: SignalReportRow[];
}

// ---- market structure (execution context, not direction) ----

export interface BookMetrics {
  /** (best ask − best bid) / mid */
  spreadPct: string;
  /** Quote notional resting on the bid side within the measured depth */
  bidNotional: string;
  askNotional: string;
  /** (bid − ask) / (bid + ask) over the measured depth: +1 all bids, −1 all asks */
  imbalance: string;
  /** Number of levels per side that were measured */
  levels: number;
  /** Book timestamp */
  ts: number;
}

/**
 * Depth and imbalance of the visible book. At a daily horizon this says
 * nothing about direction; it is for execution (how much can be filled
 * without walking the book) and for noticing abnormally thin markets.
 */
export function computeBookMetrics(
  book: { bids: ReadonlyArray<readonly [string, string]>; asks: ReadonlyArray<readonly [string, string]>; ts: number },
  inst: Instrument,
  levels = 20,
): BookMetrics | null {
  const bestBid = book.bids[0];
  const bestAsk = book.asks[0];
  if (!bestBid || !bestAsk) return null;
  const mid = D(bestBid[0]).plus(bestAsk[0]).div(2);
  if (mid.lte(0)) return null;
  const sumSide = (side: ReadonlyArray<readonly [string, string]>): Decimal => {
    let acc = ZERO;
    for (const lvl of side.slice(0, levels)) acc = acc.plus(notionalQuote(lvl[1], lvl[0], inst));
    return acc;
  };
  const bid = sumSide(book.bids);
  const ask = sumSide(book.asks);
  const total = bid.plus(ask);
  return {
    spreadPct: D(bestAsk[0]).minus(bestBid[0]).div(mid).toFixed(),
    bidNotional: bid.toFixed(2),
    askNotional: ask.toFixed(2),
    imbalance: total.isZero() ? '0' : bid.minus(ask).div(total).toFixed(4),
    levels: Math.min(levels, book.bids.length, book.asks.length),
    ts: book.ts,
  };
}

export interface OpenInterestPoint {
  ts: number;
  /** Open interest the changes are measured on: base coin for the instrument history (USD would move with price) */
  value: string;
  /** The same point in USD, shown as the level when present */
  usd?: string;
}

export interface OpenInterestMetrics {
  /** Latest open interest of the instrument, in `unit`: the forming day's value when the history has it */
  current: string;
  unit: 'usd' | 'contracts';
  /**
   * 'history': the instrument's daily history (UTC days); the changes are measured in base coin.
   * 'live': only the current level is known; the changes are unavailable ('').
   */
  source: 'history' | 'live';
  /** Fractional change of the last completed day vs. the day before it, '' when unavailable */
  change1d: string;
  /** Fractional change of the last completed day vs. 10 days before it, '' when unavailable */
  change10d: string;
  /** Percentile of the last completed day within the last 30 completed days (0..1), '' when < 10 points */
  percentile30d: string;
  /** Completed points the changes and the percentile are computed on */
  points: number;
}

/**
 * Open interest level and changes from a daily history (oldest first).
 * Rising OI with rising price = new positions (fuel and fragility);
 * falling OI on a sharp move = deleveraging (the move is being forced).
 *
 * A row holds the value at the END of its period, so the newest row of a live history is still
 * changing. With `formingFrom` (the start of the forming period, e.g. the UTC day start) rows at or
 * after it only supply the displayed level; the changes and the percentile compare completed periods.
 * Without it every row counts as completed.
 */
export function computeOpenInterestMetrics(
  history: readonly OpenInterestPoint[],
  unit: 'usd' | 'contracts' = 'usd',
  source: 'history' | 'live' = 'history',
  formingFrom?: number,
): OpenInterestMetrics | null {
  const all = [...history].filter((p) => p.value !== '' && D(p.value).gt(0)).sort((a, b) => a.ts - b.ts);
  const newest = all[all.length - 1];
  if (!newest) return null;
  const pts = formingFrom === undefined ? all : all.filter((p) => p.ts < formingFrom);
  const last = pts[pts.length - 1];
  const change = (back: number): string => {
    const ref = pts[pts.length - 1 - back];
    return last && ref ? D(last.value).div(ref.value).minus(1).toFixed(6) : '';
  };
  const window = pts.slice(-30);
  let percentile = '';
  if (last && window.length >= 10) {
    const below = window.filter((p) => D(p.value).lt(last.value)).length;
    percentile = D(below).div(window.length - 1).toFixed(3);
  }
  const level = newest.usd !== undefined && newest.usd !== '' ? newest.usd : newest.value;
  return { current: D(level).toFixed(), unit, source, change1d: change(1), change10d: change(10), percentile30d: percentile, points: pts.length };
}

export interface MarketStructure {
  book: BookMetrics | null;
  openInterest: OpenInterestMetrics | null;
}
