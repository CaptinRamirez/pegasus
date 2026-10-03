import { D, Decimal, ZERO, floorToStep, type DecimalInput } from './decimal.js';
import { contractsToCoin, notionalQuote } from './sizing.js';
import type { Candle, Instrument } from './types.js';

/**
 * Daily signal arithmetic for the low-frequency trend framework (docs/strategy.md).
 *
 * Everything here is a pure function of CONFIRMED daily candles sorted oldest
 * first. The forming bar must be excluded by the caller: every rule in the
 * framework is evaluated once, after the UTC close.
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
  /** |daily return| above this many daily sigmas is a crisis day */
  crisisReturnSigmas: string;
  /** Do not open longs when the 3-day 8h-normalised funding average is above this (fraction, e.g. 0.0005 = 0.05%) */
  maxFundingForLong: string;
  /** Do not open shorts when the 3-day 8h-normalised funding average is below this */
  minFundingForShort: string;
  /** Window for the funding average, hours */
  fundingWindowHours: number;
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
  maxFundingForLong: '0.0005',
  minFundingForShort: '-0.0003',
  fundingWindowHours: 72,
};

/** Minimum number of confirmed bars the indicators need. */
export function minBarsRequired(p: TrendParams = DEFAULT_TREND_PARAMS): number {
  return Math.max(p.trendMaPeriod, p.volLongPeriod + 1, p.entryChannel + 1, p.atrPeriod + 1, p.efficiencyPeriod + 1);
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

/**
 * Highest high and lowest low of the `n` bars BEFORE the last bar
 * (the Donchian channel today's close is compared against).
 */
export function previousChannel(candles: readonly Candle[], n: number): { high: Decimal; low: Decimal } {
  if (candles.length < n + 1) throw new SignalError('NOT_ENOUGH_DATA', `channel(${n}) needs ${n + 1} bars, got ${candles.length}`);
  let high: Decimal | null = null;
  let low: Decimal | null = null;
  for (let i = candles.length - 1 - n; i < candles.length - 1; i++) {
    const c = candles[i] as Candle;
    const h = D(c.high);
    const l = D(c.low);
    if (high === null || h.gt(high)) high = h;
    if (low === null || l.lt(low)) low = l;
  }
  return { high: high as Decimal, low: low as Decimal };
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
 * scaled by 8h / its own interval, inferred from the gap to the next record.
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
    let interval = next ? next.fundingTime - r.fundingTime : prev ? r.fundingTime - prev.fundingTime : EIGHT_HOURS;
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

// ---- regime and signals ----

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
  efficiencyRatio: string;
  volShort: string;
  volLong: string;
  volRatio: string;
  dailyReturn: string;
  dailySigma: string;
  /** Distance of close from the MA in ATRs, signed */
  maDistanceAtr: string;
}

export function computeIndicators(candles: readonly Candle[], p: TrendParams = DEFAULT_TREND_PARAMS): IndicatorSnapshot {
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
  const er = efficiencyRatio(closes, p.efficiencyPeriod);
  const volShort = realizedVol(closes, p.volShortPeriod);
  const volLong = realizedVol(closes, p.volLongPeriod);
  const sigma = dailyVol(closes, p.volShortPeriod);
  const dailyReturn = close.div(prev.close).ln();
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
    efficiencyRatio: er.toFixed(),
    volShort: volShort.toFixed(),
    volLong: volLong.toFixed(),
    volRatio: volLong.isZero() ? '0' : volShort.div(volLong).toFixed(),
    dailyReturn: dailyReturn.toFixed(),
    dailySigma: sigma.toFixed(),
    maDistanceAtr: a.isZero() ? '0' : close.minus(ma).div(a).toFixed(),
  };
}

export function classifyRegime(ind: IndicatorSnapshot, p: TrendParams = DEFAULT_TREND_PARAMS): Regime {
  const volRatio = D(ind.volRatio);
  const sigma = D(ind.dailySigma);
  if (volRatio.gt(p.crisisVolRatio) || (sigma.gt(0) && D(ind.dailyReturn).abs().gt(sigma.mul(p.crisisReturnSigmas)))) return 'crisis';
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
  /** Human-readable explanation of every condition, true or false */
  reasons: string[];
}

export function evaluateTrendSignals(ind: IndicatorSnapshot, regime: Regime, funding: FundingSummary | null, p: TrendParams = DEFAULT_TREND_PARAMS): TrendSignals {
  const close = D(ind.close);
  const reasons: string[] = [];
  const aboveMa = close.gt(ind.ma);
  const belowMa = close.lt(ind.ma);
  const breakUp = close.gt(ind.entryHigh);
  const breakDown = close.lt(ind.entryLow);
  const fundingOkLong = funding === null || D(funding.avg8h).lte(p.maxFundingForLong);
  const fundingOkShort = funding === null || D(funding.avg8h).gte(p.minFundingForShort);
  const regimeOk = regime !== 'range';
  reasons.push(`close ${ind.close} vs ${p.entryChannel}d high ${ind.entryHigh}: ${breakUp ? 'breakout up' : 'no'}`);
  reasons.push(`close vs ${p.entryChannel}d low ${ind.entryLow}: ${breakDown ? 'breakout down' : 'no'}`);
  reasons.push(`close vs MA${p.trendMaPeriod} ${ind.ma}: ${aboveMa ? 'above' : belowMa ? 'below' : 'equal'}`);
  reasons.push(`regime ${regime}: ${regimeOk ? 'new entries allowed' : 'no new entries'}`);
  reasons.push(funding === null ? 'funding: no data (filter skipped)' : `funding 3d avg ${D(funding.avg8h).mul(100).toFixed(4)}%/8h: long ${fundingOkLong ? 'ok' : 'blocked'}, short ${fundingOkShort ? 'ok' : 'blocked'}`);
  const longExit = close.lt(ind.exitLow);
  const shortExit = close.gt(ind.exitHigh);
  reasons.push(`exit: close vs ${p.exitChannel}d low ${ind.exitLow} → long exit ${longExit ? 'YES' : 'no'}; vs ${p.exitChannel}d high ${ind.exitHigh} → short exit ${shortExit ? 'YES' : 'no'}`);
  return {
    longEntry: breakUp && aboveMa && regimeOk && fundingOkLong,
    shortEntry: breakDown && belowMa && regimeOk && fundingOkShort,
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

export interface SizingPlan {
  entryPx: string;
  stopLong: string;
  stopShort: string;
  /** Stop distance as a fraction of the entry price */
  stopDistancePct: string;
  /** Notional before the cap */
  rawNotional: string;
  /** Notional actually used (after the cap) */
  notional: string;
  capped: boolean;
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
 * capped at maxNotionalPct of equity, converted to contracts and rounded down.
 */
export function planSize(equity: DecimalInput, entryPx: DecimalInput, atrValue: DecimalInput, inst: Instrument, s: SizingParams = DEFAULT_SIZING): SizingPlan {
  const eq = D(equity);
  const px = D(entryPx);
  const stopDist = D(atrValue).mul(s.atrStopMultiple);
  if (px.lte(0) || stopDist.lte(0)) throw new SignalError('BAD_INPUT', 'price and ATR must be positive');
  const distPct = stopDist.div(px);
  const rawNotional = eq.mul(s.riskPct).div(distPct);
  const cap = eq.mul(s.maxNotionalPct);
  const capped = rawNotional.gt(cap);
  const notional = capped ? cap : rawNotional;
  const unit = D(inst.ctVal).mul(inst.ctMult || '1');
  const perContractNotional = inst.ctType === 'linear' ? unit.mul(px) : unit;
  const minUnitRisk = perContractNotional.mul(inst.minSz).mul(distPct);
  let contracts = floorToStep(notional.div(perContractNotional), inst.lotSz);
  let note = capped ? `notional capped at ${D(s.maxNotionalPct).mul(100).toFixed(0)}% of equity; actual risk below ${D(s.riskPct).mul(100).toFixed(2)}%` : 'sized from the stop distance';
  if (contracts.lt(inst.minSz)) {
    contracts = ZERO;
    note = `the minimum order size (${inst.minSz} contracts) would risk ${minUnitRisk.toFixed(2)} which exceeds the budget ${eq.mul(s.riskPct).toFixed(2)}; do not trade this instrument at this equity`;
  }
  const riskQuote = contracts.isZero() ? ZERO : notionalQuote(contracts, px, inst).mul(distPct);
  return {
    entryPx: px.toFixed(),
    stopLong: px.minus(stopDist).toFixed(),
    stopShort: px.plus(stopDist).toFixed(),
    stopDistancePct: distPct.toFixed(),
    rawNotional: rawNotional.toFixed(2),
    notional: notional.toFixed(2),
    capped,
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
  indicators: IndicatorSnapshot;
  regime: Regime;
  funding: FundingSummary | null;
  signals: TrendSignals;
  sizing: SizingPlan | null;
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
): InstrumentSignalReport {
  const confirmed = candles.filter((c) => c.confirm);
  const indicators = computeIndicators(confirmed, p);
  const regime = classifyRegime(indicators, p);
  const fundingSummary = funding ? summarizeFunding(funding, now, p.fundingWindowHours) : null;
  const signals = evaluateTrendSignals(indicators, regime, fundingSummary, p);
  const sizing = inst && equity !== null && D(equity).gt(0) ? planSize(equity, indicators.close, indicators.atr, inst, { ...s, atrStopMultiple: p.atrStopMultiple }) : null;
  return { instId, indicators, regime, funding: fundingSummary, signals, sizing, params: p };
}
