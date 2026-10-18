import {
  D,
  Decimal,
  emaAlignment,
  emaLast,
  frameAtr,
  inTraderSession,
  macd,
  minutesTo,
  roundLevels,
  rsi,
  utcDayStart,
  volumeRatio,
  vwap,
  type Candle,
  type TraderAccountInfo,
  type TraderBar,
  type TraderDerivatives,
  type TraderDossier,
  type TraderFrame,
  type TraderGuardrails,
  type TraderLevels,
  type TraderPosition,
} from '@pegasus/shared';
import type { OkxClients } from '../okx/clients.js';
import type { MarketDataService } from './market-data.js';

/**
 * The dossier the Claude auto trader reads at a 15-minute close (docs/proposals/claude-auto-trader.md, section 2):
 * the 15-minute, 1-hour and 4-hour frames with their indicators, the price levels of the day and the day before,
 * where the clock stands in the US session, the daily derivatives figures, and the account's discipline counters.
 * Everything the model sees is a number computed here; it is never shown a chart or a headline.
 */

const HOUR_MS = 3_600_000;
const FIFTEEN_MS = 15 * 60_000;
/** Confirmed bars kept per frame: enough for the EMA 200 on the 4-hour frame */
const FRAME_BARS = 260;
const SHOWN_BARS = 12;
const US_OPEN = { hour: 13, minute: 30 };

export interface TraderDossierSources {
  /** Candles oldest first, the forming one included or not */
  candles(instId: string, bar: TraderBar | '1D', limit: number): Promise<Candle[]>;
  mark(instId: string): string | null;
  funding(instId: string): Promise<{ rate: string | null; mean72h: string | null }>;
  openInterest(instId: string): Promise<{ oi: string | null; change24hPct: string | null }>;
}

const fix = (v: Decimal | null, dp = 8): string | null => (v === null ? null : v.toDecimalPlaces(dp).toFixed());

/** One frame from its candles: only confirmed bars count. */
export function frameOf(bar: TraderBar, candles: readonly Candle[]): TraderFrame | null {
  const closed = candles.filter((c) => c.confirm).slice(-FRAME_BARS);
  const last = closed[closed.length - 1];
  if (!last) return null;
  const closes = closed.map((c) => c.close);
  const e5 = emaLast(closes, 5);
  const e10 = emaLast(closes, 10);
  const e21 = emaLast(closes, 21);
  const m = macd(closes);
  return {
    bar,
    asOf: last.ts,
    close: last.close,
    ema5: fix(e5, 2),
    ema10: fix(e10, 2),
    ema21: fix(e21, 2),
    ema50: fix(emaLast(closes, 50), 2),
    ema200: fix(emaLast(closes, 200), 2),
    alignment: e5 && e10 && e21 ? emaAlignment(e5, e10, e21) : null,
    macd: m ? { macd: m.macd.toDecimalPlaces(2).toFixed(), signal: m.signal.toDecimalPlaces(2).toFixed(), hist: m.hist.toDecimalPlaces(2).toFixed(), histRising: m.hist.gt(m.prevHist) } : null,
    rsi14: fix(rsi(closes, 14), 1),
    atr14: fix(frameAtr(closed, 14), 2),
    volumeRatio: fix(volumeRatio(closed, 20), 2),
    bars: closed.slice(-SHOWN_BARS).map((c) => ({ ts: c.ts, open: c.open, high: c.high, low: c.low, close: c.close })),
  };
}

const rangeOf = (bars: readonly Candle[]): { high: string | null; low: string | null } => {
  if (bars.length === 0) return { high: null, low: null };
  return { high: Decimal.max(...bars.map((c) => c.high)).toFixed(), low: Decimal.min(...bars.map((c) => c.low)).toFixed() };
};

/** The levels from the 15-minute bars of the current UTC day and the daily bars (the forming one is today's). */
export function levelsOf(fifteen: readonly Candle[], daily: readonly Candle[], now: number, mark: string): TraderLevels {
  const dayStart = utcDayStart(now);
  const today = fifteen.filter((c) => c.ts >= dayStart && c.ts < now);
  const inHours = (from: number, to: number): Candle[] => today.filter((c) => c.ts >= dayStart + from * HOUR_MS && c.ts < dayStart + to * HOUR_MS);
  const prev = daily.filter((c) => c.confirm && c.ts < dayStart).at(-1) ?? null;
  const todayBar = daily.find((c) => c.ts === dayStart) ?? null;
  const dayRange = rangeOf(today);
  const asia = rangeOf(inHours(0, 8));
  const europe = rangeOf(inHours(8, 13));
  const round = roundLevels(mark);
  return {
    prevDayHigh: prev?.high ?? null,
    prevDayLow: prev?.low ?? null,
    prevDayClose: prev?.close ?? null,
    dayOpen: todayBar?.open ?? today[0]?.open ?? null,
    dayHigh: todayBar?.high ?? dayRange.high,
    dayLow: todayBar?.low ?? dayRange.low,
    asiaHigh: asia.high,
    asiaLow: asia.low,
    europeHigh: europe.high,
    europeLow: europe.low,
    vwap: fix(vwap(today), 2),
    roundBelow: round.below,
    roundAbove: round.above,
  };
}

/**
 * What the last 15-minute bar changed, for the event-triggered calls: a close through a level of the day, a flip of
 * the 15-minute EMA alignment, and, with a position, the price within a third of the stop's distance of the stop or
 * past the target. Empty when nothing happened.
 */
export function detectTriggers(prev: Pick<TraderDossier, 'frames' | 'levels'> | null, next: Pick<TraderDossier, 'frames' | 'levels' | 'mark'>, position: TraderPosition | null): string[] {
  const out: string[] = [];
  const frame = next.frames.find((f) => f.bar === '15m');
  const before = prev?.frames.find((f) => f.bar === '15m');
  if (!frame) return out;
  const close = D(frame.close);
  const lastClose = before ? D(before.close) : null;
  if (lastClose) {
    const crossed = (name: string, level: string | null): void => {
      if (level === null) return;
      const l = D(level);
      if (lastClose.lte(l) && close.gt(l)) out.push(`closed above ${name} ${level}`);
      else if (lastClose.gte(l) && close.lt(l)) out.push(`closed below ${name} ${level}`);
    };
    crossed('prevDayHigh', next.levels.prevDayHigh);
    crossed('prevDayLow', next.levels.prevDayLow);
    crossed('dayHigh', prev?.levels.dayHigh ?? null);
    crossed('dayLow', prev?.levels.dayLow ?? null);
    crossed('vwap', next.levels.vwap);
    crossed('round', next.levels.roundBelow);
    crossed('round', next.levels.roundAbove);
    if (before && before.alignment !== null && frame.alignment !== null && before.alignment !== frame.alignment) out.push(`15m EMA alignment ${before.alignment} -> ${frame.alignment}`);
  }
  if (position) {
    const mark = D(next.mark);
    const dist = D(position.entryPx).minus(position.stopPx).abs();
    if (mark.minus(position.stopPx).abs().lte(dist.div(3))) out.push('mark near the stop');
    if (position.targetPx !== null && (position.side === 'long' ? mark.gte(position.targetPx) : mark.lte(position.targetPx))) out.push('mark at the target');
  }
  return out;
}

export interface BuildDossierInput {
  instId: string;
  /** The close the dossier stands at */
  now: number;
  sources: TraderDossierSources;
  account: TraderAccountInfo;
  guardrails: TraderGuardrails;
  /** Today's scheduled events from the settings */
  calendar: string[];
  triggers: string[];
}

export async function buildTraderDossier(input: BuildDossierInput): Promise<TraderDossier> {
  const { instId, now, sources } = input;
  const [fifteen, hourly, fourHour, daily] = await Promise.all([sources.candles(instId, '15m', 300), sources.candles(instId, '1H', 300), sources.candles(instId, '4H', 300), sources.candles(instId, '1D', 5)]);
  const mark = sources.mark(instId) ?? fifteen.filter((c) => c.confirm).at(-1)?.close ?? null;
  if (mark === null) throw new Error(`${instId}: no mark price and no candles`);
  const frames = [frameOf('15m', fifteen), frameOf('1H', hourly), frameOf('4H', fourHour)].filter((f): f is TraderFrame => f !== null);
  const [funding, oi] = await Promise.all([sources.funding(instId).catch(() => ({ rate: null, mean72h: null })), sources.openInterest(instId).catch(() => ({ oi: null, change24hPct: null }))]);
  const derivatives: TraderDerivatives = { fundingRate: funding.rate, fundingMean72h: funding.mean72h, openInterest: oi.oi, oiChange24hPct: oi.change24hPct };
  const g = input.guardrails;
  return {
    instId,
    asOf: now,
    asOfIso: new Date(now).toISOString(),
    mark,
    frames,
    levels: levelsOf(fifteen, daily, now, mark),
    session: {
      startHour: g.sessionStartHour,
      endHour: g.sessionEndHour,
      inSession: inTraderSession(now, g),
      minutesSinceUsOpen: -minutesTo(now, US_OPEN.hour, US_OPEN.minute),
      minutesToSessionEnd: minutesTo(now, g.sessionEndHour),
      calendar: input.calendar,
    },
    derivatives,
    account: input.account,
    guardrails: g,
    triggers: input.triggers,
  };
}

/** The sources on the exchange: candles and the mark through the market data service, funding and open interest over REST. */
export function exchangeDossierSources(market: MarketDataService, clients: OkxClients): TraderDossierSources {
  return {
    candles: (instId, bar, limit) => market.fetchCandles(instId, bar, limit),
    mark: (instId) => market.liveMarkPrice(instId) ?? market.refPrice(instId) ?? null,
    async funding(instId) {
      const [current, history] = await Promise.all([clients.rest.getFundingRate(instId), clients.rest.getFundingRateHistory(instId, { limit: 9 })]);
      const rates = history.map((r) => D(r.realizedRate || r.fundingRate)).filter((r) => r.isFinite());
      const mean = rates.length > 0 ? rates.reduce((s, r) => s.plus(r), D(0)).div(rates.length) : null;
      return { rate: current.fundingRate || null, mean72h: fix(mean, 8) };
    },
    async openInterest(instId) {
      const [now, history] = await Promise.all([clients.rest.getOpenInterest('SWAP', instId), clients.rest.getOpenInterestHistory(instId, '1H', { limit: 25 })]);
      const oi = now[0]?.oiCcy ?? null;
      const rows = [...history].sort((a, b) => Number(a[0]) - Number(b[0]));
      const first = rows[0];
      const last = rows[rows.length - 1];
      const change = first && last && rows.length >= 24 && D(first[2]).gt(0) ? D(last[2]).div(first[2]).minus(1).mul(100) : null;
      return { oi, change24hPct: fix(change, 2) };
    },
  };
}

/** The open time of the 15-minute bar that closed at or before `now`. */
export const fifteenCloseAtOrBefore = (now: number): number => Math.floor(now / FIFTEEN_MS) * FIFTEEN_MS;
export const FIFTEEN_MINUTES_MS = FIFTEEN_MS;
