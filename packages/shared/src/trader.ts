import { z } from 'zod';
import { D, Decimal, ZERO, floorToStep, type DecimalInput } from './decimal.js';
import { atr, SignalError } from './signals.js';
import { coinToContracts, notionalQuote } from './sizing.js';
import type { Candle, Instrument } from './types.js';

/**
 * The Claude auto trader (docs/proposals/claude-auto-trader.md): what the model is shown (the dossier), what it may
 * answer (the decision), the guardrails the code enforces whatever it answers, and the arithmetic around them. Pure
 * functions; the API's trader service does the I/O. Prices and indicator values travel as decimal strings.
 */

// ---- indicators ----

const toDecimals = (values: readonly DecimalInput[]): Decimal[] => values.map((v) => D(v));

/** Exponential moving average of `values`, seeded with the simple average of the first `n`; one value per input from the n-th on. */
export function emaSeries(values: readonly DecimalInput[], n: number): Decimal[] {
  if (!Number.isInteger(n) || n < 1) throw new SignalError('BAD_INPUT', 'the EMA period must be a positive whole number');
  const v = toDecimals(values);
  if (v.length < n) return [];
  const k = D(2).div(n + 1);
  let e = v.slice(0, n).reduce((s, x) => s.plus(x), ZERO).div(n);
  const out = [e];
  for (let i = n; i < v.length; i++) {
    e = (v[i] as Decimal).minus(e).mul(k).plus(e);
    out.push(e);
  }
  return out;
}

/** The last EMA value; null with fewer than `n` values. */
export function emaLast(values: readonly DecimalInput[], n: number): Decimal | null {
  const s = emaSeries(values, n);
  return s.length === 0 ? null : (s[s.length - 1] as Decimal);
}

export interface MacdValue {
  macd: Decimal;
  signal: Decimal;
  hist: Decimal;
  /** The histogram of the bar before: rising when hist > prevHist */
  prevHist: Decimal;
}

/** MACD(fast, slow, signal) at the last value; null while there are too few values for the signal line and the bar before. */
export function macd(values: readonly DecimalInput[], fast = 12, slow = 26, signal = 9): MacdValue | null {
  const fastS = emaSeries(values, fast);
  const slowS = emaSeries(values, slow);
  if (slowS.length === 0) return null;
  // Both series end at the last value; the MACD line exists from the slow EMA's first value on.
  const offset = fastS.length - slowS.length;
  const line = slowS.map((s, i) => (fastS[i + offset] as Decimal).minus(s));
  const sig = emaSeries(line, signal);
  if (sig.length < 2) return null;
  const last = line.length - 1;
  const hist = (line[last] as Decimal).minus(sig[sig.length - 1] as Decimal);
  const prevHist = (line[last - 1] as Decimal).minus(sig[sig.length - 2] as Decimal);
  return { macd: line[last] as Decimal, signal: sig[sig.length - 1] as Decimal, hist, prevHist };
}

/** Wilder's RSI over `n` changes; null with fewer than n + 1 values. 100 when there was no loss. */
export function rsi(values: readonly DecimalInput[], n = 14): Decimal | null {
  const v = toDecimals(values);
  if (v.length < n + 1) return null;
  let gain = ZERO;
  let loss = ZERO;
  for (let i = 1; i <= n; i++) {
    const d = (v[i] as Decimal).minus(v[i - 1] as Decimal);
    if (d.gt(0)) gain = gain.plus(d);
    else loss = loss.minus(d);
  }
  gain = gain.div(n);
  loss = loss.div(n);
  for (let i = n + 1; i < v.length; i++) {
    const d = (v[i] as Decimal).minus(v[i - 1] as Decimal);
    gain = gain.mul(n - 1).plus(d.gt(0) ? d : ZERO).div(n);
    loss = loss.mul(n - 1).plus(d.lt(0) ? d.neg() : ZERO).div(n);
  }
  if (loss.isZero()) return D(100);
  const rs = gain.div(loss);
  return D(100).minus(D(100).div(rs.plus(1)));
}

/** Volume-weighted average of the typical price over `candles`; null without volume. */
export function vwap(candles: readonly Candle[]): Decimal | null {
  let pv = ZERO;
  let vol = ZERO;
  for (const c of candles) {
    const typical = D(c.high).plus(c.low).plus(c.close).div(3);
    pv = pv.plus(typical.mul(c.vol));
    vol = vol.plus(c.vol);
  }
  return vol.gt(0) ? pv.div(vol) : null;
}

/** The last bar's volume over the average of the `n` bars before it; null with too few bars or no volume. */
export function volumeRatio(candles: readonly Candle[], n = 20): Decimal | null {
  if (candles.length < n + 1) return null;
  const last = candles[candles.length - 1] as Candle;
  const before = candles.slice(-(n + 1), -1);
  const avg = before.reduce((s, c) => s.plus(c.vol), ZERO).div(n);
  return avg.gt(0) ? D(last.vol).div(avg) : null;
}

/** bull: 5 above 10 above 21; bear: the reverse; mixed otherwise. */
export type EmaAlignment = 'bull' | 'bear' | 'mixed';

export function emaAlignment(e5: Decimal, e10: Decimal, e21: Decimal): EmaAlignment {
  if (e5.gt(e10) && e10.gt(e21)) return 'bull';
  if (e5.lt(e10) && e10.lt(e21)) return 'bear';
  return 'mixed';
}

// ---- the dossier ----

export type TraderBar = '15m' | '1H' | '4H' | '1D';

/** One time frame as the model sees it: the last confirmed bars and the indicators on them. */
export interface TraderFrame {
  bar: TraderBar;
  /** Open time of the last confirmed bar */
  asOf: number;
  close: string;
  ema5: string | null;
  ema10: string | null;
  ema21: string | null;
  ema50: string | null;
  ema200: string | null;
  alignment: EmaAlignment | null;
  macd: { macd: string; signal: string; hist: string; histRising: boolean } | null;
  rsi14: string | null;
  atr14: string | null;
  /** Last bar's volume over the 20 before it */
  volumeRatio: string | null;
  /** The last confirmed bars (up to 96), oldest first, each [open time, open, high, low, close, volume]: what a chart would show */
  bars: TraderBarRow[];
  /** The last swing highs and lows of those bars (a high above the 3 bars either side, a low below), oldest first */
  swings: TraderSwing[];
}

export type TraderBarRow = [ts: number, open: string, high: string, low: string, close: string, volume: string];

export interface TraderSwing {
  ts: number;
  kind: 'high' | 'low';
  px: string;
}

/**
 * The pivot points of a series: a bar whose high is above the highs of the `k` bars on each side is a swing high, one
 * whose low is below their lows a swing low. The last `n`, oldest first. The newest `k` bars cannot be pivots yet.
 */
export function swingPoints(candles: readonly Candle[], k = 3, n = 8): TraderSwing[] {
  const out: TraderSwing[] = [];
  for (let i = k; i < candles.length - k; i++) {
    const c = candles[i] as Candle;
    const around = [...candles.slice(i - k, i), ...candles.slice(i + 1, i + 1 + k)];
    if (around.every((o) => D(o.high).lt(c.high))) out.push({ ts: c.ts, kind: 'high', px: c.high });
    if (around.every((o) => D(o.low).gt(c.low))) out.push({ ts: c.ts, kind: 'low', px: c.low });
  }
  return out.slice(-n);
}

/** Price levels around the market, from the 15-minute bars and the daily ones. null when the bars do not reach. */
export interface TraderLevels {
  prevDayHigh: string | null;
  prevDayLow: string | null;
  prevDayClose: string | null;
  dayOpen: string | null;
  dayHigh: string | null;
  dayLow: string | null;
  /** 00:00 to 08:00 UTC of the current UTC day */
  asiaHigh: string | null;
  asiaLow: string | null;
  /** 08:00 to 13:00 UTC of the current UTC day */
  europeHigh: string | null;
  europeLow: string | null;
  /** VWAP of the current UTC day's 15-minute bars */
  vwap: string | null;
  roundBelow: string;
  roundAbove: string;
}

export interface TraderSessionInfo {
  /** The trading window, UTC hours */
  startHour: number;
  endHour: number;
  inSession: boolean;
  /** Minutes since the US cash open (13:30 UTC); negative before it */
  minutesSinceUsOpen: number;
  /** Minutes until the session's end; negative after it */
  minutesToSessionEnd: number;
  /** Scheduled events of the day (CPI, FOMC...), from the settings */
  calendar: string[];
}

export interface TraderDerivatives {
  fundingRate: string | null;
  /** Mean of the last nine 8-hour settlements (three days) */
  fundingMean72h: string | null;
  openInterest: string | null;
  oiChange24hPct: string | null;
}

/** The position the trader holds, as it tracks it. */
export interface TraderPosition {
  side: 'long' | 'short';
  contracts: string;
  entryPx: string;
  stopPx: string;
  targetPx: string | null;
  openedAt: number;
  /** Client order id of the opening order */
  clOrdId: string;
  /** Total equity when the position was opened: the trade's result is measured from it */
  equityAtEntry: string;
}

export interface TraderAccountInfo {
  equity: string;
  position: (TraderPosition & { unrealizedPnl: string | null }) | null;
  tradesToday: number;
  pnlToday: string;
  consecutiveLosses: number;
  cooldownUntil: number | null;
  killSwitch: boolean;
}

/** Taker and maker fees of the paper exchange (OKX's regular tier on USDT swaps), fraction of the notional. */
export const TRADER_TAKER_FEE = '0.0005';
export const TRADER_MAKER_FEE = '0.0002';

/** What a round trip costs at the mark, so that the model weighs its stop and target against it. */
export interface TraderCosts {
  takerFeePct: string;
  makerFeePct: string;
  /** Entry and exit at the taker fee, in price points at the mark */
  roundTripPoints: string;
}

/** A finished trade as the model sees it among its recent ones. */
export interface TraderRecentTrade {
  side: 'long' | 'short';
  entryPx: string;
  stopPx: string | null;
  targetPx: string | null;
  /** Distance of the stop from the entry, percent of the entry */
  stopPct: string | null;
  minutesHeld: number;
  end: 'stop' | 'target' | 'close' | 'external';
  pnl: string;
  closedAt: number;
}

/** The guardrails the code enforces; the model is told them and cannot change them. */
export interface TraderGuardrails {
  /** Loss accepted per trade, fraction of the equity */
  riskPct: string;
  maxTradesPerDay: number;
  /** Loss of the day, fraction of the day's starting equity, at which the trader stops for the day */
  dailyLossPct: string;
  maxConsecutiveLosses: number;
  /** Pause after maxConsecutiveLosses */
  cooldownMs: number;
  /** UTC hours of the window in which positions are opened */
  sessionStartHour: number;
  sessionEndHour: number;
  maxLeverage: string;
  /** A limit entry may not be further than this from the mark */
  maxLimitDistancePct: string;
}

export const DEFAULT_TRADER_GUARDRAILS: TraderGuardrails = {
  riskPct: '0.02',
  maxTradesPerDay: 3,
  dailyLossPct: '0.06',
  maxConsecutiveLosses: 3,
  cooldownMs: 24 * 3_600_000,
  sessionStartHour: 13,
  sessionEndHour: 21,
  maxLeverage: '10',
  maxLimitDistancePct: '0.02',
};

/** A scheduled release of the economic calendar, as the model sees it (the calendar gives no actual figures). */
export interface TraderMacroEvent {
  time: number;
  title: string;
  /** USD, EUR, ... or All */
  country: string;
  /** High, Medium, Low, Holiday */
  impact: string;
  forecast: string;
  previous: string;
  /** Negative once it is out */
  minutesFromNow: number;
}

/** A headline from one of the news feeds: data for the model, never an instruction. */
export interface TraderHeadline {
  time: number;
  source: string;
  title: string;
  minutesAgo: number;
}

export interface TraderMacro {
  /** Releases from two hours ago to a day ahead: high impact anywhere, medium impact for the US */
  calendar: TraderMacroEvent[];
  /** The last hours of the feeds, newest first */
  headlines: TraderHeadline[];
  /** What could not be read */
  notes: string[];
}

/** The decision before this one, so that the model stays consistent with itself. */
export interface TraderPreviousDecision {
  ts: number;
  action: TraderAction;
  oneLiner: string;
  invalidation: string;
  wakeAbove: string | null;
  wakeBelow: string | null;
}

/** When the model is asked next: at `at` (a 15-minute close), or earlier when the price reaches a level. */
export interface TraderWake {
  at: number;
  above: string | null;
  below: string | null;
  /** The close it was set at */
  setAt: number;
}

export interface TraderDossier {
  instId: string;
  /** The instant the dossier is built at: the close of the last 15-minute bar */
  asOf: number;
  asOfIso: string;
  mark: string;
  frames: TraderFrame[];
  levels: TraderLevels;
  session: TraderSessionInfo;
  derivatives: TraderDerivatives;
  account: TraderAccountInfo;
  guardrails: TraderGuardrails;
  /** Why the model is being asked now: the session's open, its own recheck time, a wake level, the position, a release */
  triggers: string[];
  /** The economic calendar and the headlines of the last hours */
  macro: TraderMacro;
  previous: TraderPreviousDecision | null;
  costs: TraderCosts;
  /** Its last finished trades, newest first: how wide the stop was, how long it held, how it ended */
  recentTrades: TraderRecentTrade[];
}

// ---- the decision ----

export const TRADER_ACTIONS = ['long', 'short', 'flat', 'close', 'tighten_stop'] as const;
export type TraderAction = (typeof TRADER_ACTIONS)[number];

/** The model's recheck time is kept within these minutes: 480 is the rest of a session. */
export const RECHECK_MIN_MINUTES = 15;
export const RECHECK_MAX_MINUTES = 480;
const FIFTEEN_MS = 15 * 60_000;

/** What the model answers. Kept to what structured outputs accept; the ranges are checked by checkDecision. */
export const traderDecisionSchema = z.object({
  action: z.enum(TRADER_ACTIONS),
  /** For long and short: a market order, or a limit order at `price` (a decimal string) */
  entryType: z.enum(['market', 'limit']),
  limitPrice: z.string().nullable(),
  /** For long, short and tighten_stop: the stop price, a decimal string */
  stopPx: z.string().nullable(),
  /** For long and short: the take-profit price, a decimal string, or null for none */
  targetPx: z.string().nullable(),
  /** 0 to 1 */
  confidence: z.number(),
  /** One to three reasons, each naming the dossier figures it rests on */
  reasons: z.array(z.string()),
  /** What would make the view wrong */
  invalidation: z.string(),
  /** One sentence for the screen */
  oneLiner: z.string(),
  /** When to be asked again, minutes from now: 15 to 480 (480: the rest of the session) */
  recheckMinutes: z.number(),
  /** Prices that wake the trader before then, decimal strings; null for none */
  wakeAbove: z.string().nullable(),
  wakeBelow: z.string().nullable(),
});
export type TraderDecision = z.infer<typeof traderDecisionSchema>;

const isDecimal = (s: string | null): s is string => s !== null && /^\d+(\.\d+)?$/.test(s) && D(s).gt(0);

export type TraderVerdict =
  | { ok: true; action: 'flat' }
  | { ok: true; action: 'close' }
  | { ok: true; action: 'tighten_stop'; stopPx: string }
  | { ok: true; action: 'long' | 'short'; entryType: 'market' | 'limit'; entryPx: string; stopPx: string; targetPx: string | null }
  | { ok: false; action: TraderAction; reason: string };

/**
 * Whether a decision may be carried out: the stop on the losing side of the entry (where is the model's call), the target beyond
 * the stop's distance, a limit price near the mark, a close or a tighter stop only with a position, an entry only
 * without one. A decision that fails is treated as `flat` and logged with the reason.
 */
export function checkDecision(d: TraderDecision, mark: string, g: TraderGuardrails, held: TraderPosition | null): TraderVerdict {
  const m = D(mark);
  const pct = (a: DecimalInput, b: DecimalInput): Decimal => D(a).minus(b).abs().div(b);
  if (d.action === 'flat') return { ok: true, action: 'flat' };
  if (d.action === 'close') return held ? { ok: true, action: 'close' } : { ok: false, action: d.action, reason: 'close without a position' };
  if (d.action === 'tighten_stop') {
    if (!held) return { ok: false, action: d.action, reason: 'tighten_stop without a position' };
    if (!isDecimal(d.stopPx)) return { ok: false, action: d.action, reason: 'tighten_stop without a stop price' };
    const stop = D(d.stopPx);
    const tighter = held.side === 'long' ? stop.gt(held.stopPx) && stop.lt(m) : stop.lt(held.stopPx) && stop.gt(m);
    return tighter ? { ok: true, action: 'tighten_stop', stopPx: stop.toFixed() } : { ok: false, action: d.action, reason: `the stop ${d.stopPx} is not tighter than ${held.stopPx} on the right side of the mark ${mark}` };
  }
  // long or short
  if (held) return { ok: false, action: d.action, reason: `${d.action} while a ${held.side} is held` };
  let entry = m;
  if (d.entryType === 'limit') {
    if (!isDecimal(d.limitPrice)) return { ok: false, action: d.action, reason: 'limit entry without a price' };
    entry = D(d.limitPrice);
    if (pct(entry, m).gt(g.maxLimitDistancePct)) return { ok: false, action: d.action, reason: `the limit price ${d.limitPrice} is more than ${D(g.maxLimitDistancePct).mul(100).toFixed()}% from the mark ${mark}` };
  }
  if (!isDecimal(d.stopPx)) return { ok: false, action: d.action, reason: 'an entry without a stop price' };
  const stop = D(d.stopPx);
  const long = d.action === 'long';
  if (long ? !stop.lt(entry) : !stop.gt(entry)) return { ok: false, action: d.action, reason: `the stop ${d.stopPx} is on the wrong side of the entry ${entry.toFixed()}` };
  let target: string | null = null;
  if (d.targetPx !== null) {
    if (!isDecimal(d.targetPx)) return { ok: false, action: d.action, reason: 'the target is not a price' };
    const t = D(d.targetPx);
    if (long ? !t.gt(entry) : !t.lt(entry)) return { ok: false, action: d.action, reason: `the target ${d.targetPx} is on the wrong side of the entry` };
    if (t.minus(entry).abs().lt(stop.minus(entry).abs())) return { ok: false, action: d.action, reason: 'the target is closer than the stop: less than one to one' };
    target = t.toFixed();
  }
  return { ok: true, action: d.action, entryType: d.entryType, entryPx: entry.toFixed(), stopPx: stop.toFixed(), targetPx: target };
}

/**
 * The next look the model asked for: its recheck time kept within 15 to 480 minutes (60 when there is no decision or
 * no usable number) and moved to the next 15-minute close, and its wake levels when they are prices.
 */
export function wakeOf(d: Pick<TraderDecision, 'recheckMinutes' | 'wakeAbove' | 'wakeBelow'> | null, bar: number): TraderWake {
  const raw = d !== null && Number.isFinite(d.recheckMinutes) ? d.recheckMinutes : 60;
  const minutes = Math.min(RECHECK_MAX_MINUTES, Math.max(RECHECK_MIN_MINUTES, Math.round(raw)));
  const at = Math.ceil((bar + minutes * 60_000) / FIFTEEN_MS) * FIFTEEN_MS;
  const level = (s: string | null | undefined): string | null => (s !== null && s !== undefined && isDecimal(s) ? D(s).toFixed() : null);
  return { at, above: level(d?.wakeAbove), below: level(d?.wakeBelow), setAt: bar };
}

// ---- sizing ----

export interface TraderSize {
  contracts: string;
  notional: string;
  /** Whole-number isolated leverage the margin is posted at */
  leverage: string;
  /** What the stop loses, at the fill: contracts x the stop distance */
  riskQuote: string;
}

/**
 * The position of an entry: the contracts whose loss at the stop is riskPct of the equity, in whole lots, cut to what
 * maxLeverage of the equity buys (with 5% left for fees); the leverage is the smallest whole number that posts the
 * notional within the equity, maxLeverage at most. null when less than the minimum order comes out. Linear contracts.
 */
export function traderSize(input: { equity: DecimalInput; entryPx: DecimalInput; stopPx: DecimalInput; inst: Instrument; guardrails: Pick<TraderGuardrails, 'riskPct' | 'maxLeverage'> }): TraderSize | null {
  const { inst, guardrails: g } = input;
  if (inst.ctType !== 'linear') throw new SignalError('BAD_INPUT', 'the trader sizes linear contracts only');
  const equity = D(input.equity);
  const entry = D(input.entryPx);
  const dist = entry.minus(input.stopPx).abs();
  if (!equity.gt(0) || !entry.gt(0) || !dist.gt(0)) return null;
  const coin = equity.mul(g.riskPct).div(dist);
  let contracts = floorToStep(coinToContracts(coin, inst), inst.lotSz);
  const cap = floorToStep(coinToContracts(equity.mul(g.maxLeverage).mul('0.95').div(entry), inst), inst.lotSz);
  if (contracts.gt(cap)) contracts = cap;
  if (contracts.lt(inst.minSz) || !contracts.gt(0)) return null;
  const notional = notionalQuote(contracts, entry, inst);
  const leverage = Decimal.min(D(g.maxLeverage), Decimal.max(1, notional.div(equity).mul('1.1').ceil()));
  const riskQuote = notional.div(entry).mul(dist);
  return { contracts: contracts.toFixed(), notional: notional.toFixed(), leverage: leverage.toFixed(0), riskQuote: riskQuote.toFixed() };
}

// ---- time ----

const HOUR_MS = 3_600_000;

/** Whether `ts` falls in the trading window: [startHour, endHour) UTC. */
export function inTraderSession(ts: number, g: Pick<TraderGuardrails, 'sessionStartHour' | 'sessionEndHour'>): boolean {
  const hour = new Date(ts).getUTCHours() + new Date(ts).getUTCMinutes() / 60;
  return hour >= g.sessionStartHour && hour < g.sessionEndHour;
}

/** Minutes from `ts` to the UTC hour:minute of the same UTC day (negative when past). */
export function minutesTo(ts: number, hour: number, minute = 0): number {
  const day = ts - (ts % (24 * HOUR_MS));
  return Math.round((day + hour * HOUR_MS + minute * 60_000 - ts) / 60_000);
}

/** The ATR of a frame's bars as the dossier shows it; null with too few bars. */
export function frameAtr(candles: readonly Candle[], n = 14): Decimal | null {
  try {
    return atr(candles, n);
  } catch {
    return null;
  }
}

/** Round numbers around a price: the step is a tenth of the price's order of magnitude (82,345 -> 1,000; 3,456 -> 100). */
export function roundLevels(price: DecimalInput): { below: string; above: string } {
  const p = D(price);
  const magnitude = Math.floor(Math.log10(p.toNumber()));
  const step = D(10).pow(Math.max(0, magnitude - 1));
  const below = floorToStep(p, step);
  return { below: below.toFixed(), above: below.plus(step).toFixed() };
}

// ---- what the API shows and keeps ----

export type TraderStatus = 'disabled' | 'blocked' | 'idle' | 'in-session' | 'holding';

export interface TraderStatusReason {
  code: string;
  message: string;
}

export interface TraderUsage {
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  ms: number;
  model: string;
}

/** The outcome of a trade of the trader or of the control, measured from the equity. */
export interface TraderTradeResult {
  side: 'long' | 'short';
  openedAt: number;
  closedAt: number;
  entryPx: string;
  exitPx: string | null;
  contracts: string;
  pnl: string;
  /** How it ended: the stop, the target, the model's close, the session's end, or an outside event */
  end: 'stop' | 'target' | 'close' | 'external';
  /** The stop and the target it held when it ended (absent in results booked before they were kept) */
  stopPx?: string;
  targetPx?: string | null;
}

/** The trades the model is shown, newest first, at most `n`. */
export function recentTradesOf(results: readonly TraderTradeResult[], n = 5): TraderRecentTrade[] {
  return results.slice(0, n).map((r) => ({
    side: r.side,
    entryPx: r.entryPx,
    stopPx: r.stopPx ?? null,
    targetPx: r.targetPx ?? null,
    stopPct: r.stopPx === undefined ? null : D(r.entryPx).minus(r.stopPx).abs().div(r.entryPx).mul(100).toDecimalPlaces(3).toFixed(),
    minutesHeld: Math.round((r.closedAt - r.openedAt) / 60_000),
    end: r.end,
    pnl: r.pnl,
    closedAt: r.closedAt,
  }));
}

/** The cost of a round trip at the mark. */
export function traderCosts(mark: DecimalInput): TraderCosts {
  return {
    takerFeePct: D(TRADER_TAKER_FEE).mul(100).toFixed(),
    makerFeePct: D(TRADER_MAKER_FEE).mul(100).toFixed(),
    roundTripPoints: D(mark).mul(TRADER_TAKER_FEE).mul(2).toDecimalPlaces(1).toFixed(),
  };
}

/** The coin-flip control: the same opportunities with a random direction, filled at the mark and settled on the bars. */
export interface TraderControlState {
  position: (TraderPosition & { fee: string }) | null;
  trades: number;
  pnlTotal: string;
  wins: number;
  losses: number;
}

export interface TraderLastDecision {
  ts: number;
  decision: TraderDecision | null;
  verdict: string;
  executed: boolean;
  usage: TraderUsage | null;
  triggers: string[];
  error: string | null;
}

export interface TraderView {
  enabled: boolean;
  /** model: the model sets its next look; hourly: hourly closes and level events; 15m: every 15-minute close */
  cadence: 'model' | 'hourly' | '15m';
  /** The next look the model asked for; null before its first decision */
  wake: TraderWake | null;
  /** Releases still to come in the next day, from the last calendar read */
  upcoming: TraderMacroEvent[];
  status: TraderStatus;
  reason: TraderStatusReason | null;
  instId: string;
  session: { startHour: number; endHour: number; inSession: boolean };
  guardrails: TraderGuardrails;
  model: string;
  /** Next instant the model is called at the latest (the next hourly close in session), null when disabled or blocked */
  nextCallAt: number | null;
  last: TraderLastDecision | null;
  position: TraderAccountInfo['position'];
  today: { date: string; trades: number; pnl: string; consecutiveLosses: number; cooldownUntil: number | null; equityAtStart: string | null };
  /** Calls and estimated cost since the state began the day */
  usageToday: { calls: number; inputTokens: number; outputTokens: number; estimatedUsd: string };
  control: TraderControlState | null;
  recent: TraderTradeResult[];
  serverTime: number;
}

/** One line of data/trader-log.jsonl. The dossier is kept on decisions, so a decision can be re-asked later. */
export interface TraderLogRecord {
  ts: number;
  kind: 'decision' | 'execution' | 'result' | 'control' | 'error';
  instId: string;
  triggers?: string[];
  dossier?: TraderDossier;
  decision?: TraderDecision | null;
  verdict?: string;
  usage?: TraderUsage;
  order?: { clOrdId: string; side: 'buy' | 'sell'; entryType: 'market' | 'limit'; contracts: string; entryPx: string; stopPx: string; targetPx: string | null; leverage: string };
  result?: TraderTradeResult;
  control?: { direction: 'long' | 'short'; entryPx: string; stopPx: string; targetPx: string | null } | TraderTradeResult;
  error?: string;
}

/** Pricing of the models the trader may run, USD per million tokens (input, output, cache read), for the estimate on the screen. */
export const TRADER_MODEL_PRICES: Readonly<Record<string, { input: number; output: number; cacheRead: number }>> = {
  'claude-opus-5-5': { input: 4, output: 20, cacheRead: 0.2 },
  'claude-sonnet-5-5': { input: 2, output: 10, cacheRead: 0.2 },
  'claude-haiku-5-5': { input: 0.1, output: 0.5, cacheRead: 0.01 },
};

export function estimateUsd(model: string, usage: Pick<TraderUsage, 'inputTokens' | 'outputTokens' | 'cacheReadTokens'>): Decimal {
  const p = TRADER_MODEL_PRICES[model] ?? { input: 4, output: 20, cacheRead: 0.2 };
  return D(usage.inputTokens).mul(p.input).plus(D(usage.outputTokens).mul(p.output)).plus(D(usage.cacheReadTokens).mul(p.cacheRead)).div(1_000_000);
}
