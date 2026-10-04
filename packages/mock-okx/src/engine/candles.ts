import { d, fmt, roundToStep, ZERO, type Dec } from '../num.js';
import type { Prng } from '../prng.js';
import type { OkxCandleRow } from '../wire.js';

// Like OKX: plain 6H, 12H, 1D and 1W open on UTC+8 boundaries, the "utc" variants on UTC ones.
export const BARS = ['1m', '3m', '5m', '15m', '30m', '1H', '2H', '4H', '6H', '12H', '1D', '1W', '6Hutc', '12Hutc', '1Dutc', '1Wutc'] as const;
export type Bar = (typeof BARS)[number];

const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;

export const BAR_MS: Readonly<Record<Bar, number>> = {
  '1m': MINUTE,
  '3m': 3 * MINUTE,
  '5m': 5 * MINUTE,
  '15m': 15 * MINUTE,
  '30m': 30 * MINUTE,
  '1H': HOUR,
  '2H': 2 * HOUR,
  '4H': 4 * HOUR,
  '6H': 6 * HOUR,
  '12H': 12 * HOUR,
  '1D': DAY,
  '1W': 7 * DAY,
  '6Hutc': 6 * HOUR,
  '12Hutc': 12 * HOUR,
  '1Dutc': DAY,
  '1Wutc': 7 * DAY,
};

const UTC8_BARS: ReadonlySet<Bar> = new Set<Bar>(['6H', '12H', '1D', '1W']);

export function isBar(s: string): s is Bar {
  return (BARS as readonly string[]).includes(s);
}

/**
 * Open time of the bar containing `ts`. Weeks start on Monday like OKX; 6H, 12H, 1D and 1W
 * follow the UTC+8 day (1D opens at 16:00 UTC), their utc variants the UTC day.
 */
export function barStart(bar: Bar, ts: number): number {
  const ms = BAR_MS[bar];
  // 1970-01-01 was a Thursday; shift so weeks begin on Monday
  let shift = bar === '1W' || bar === '1Wutc' ? 3 * DAY : 0;
  if (UTC8_BARS.has(bar)) shift += 8 * HOUR;
  return Math.floor((ts + shift) / ms) * ms - shift;
}

export interface Candle {
  ts: number;
  o: Dec;
  h: Dec;
  l: Dec;
  c: Dec;
  vol: Dec;
  volCcy: Dec;
  volCcyQuote: Dec;
}

export interface CandleQuery {
  limit: number;
  after?: number;
  before?: number;
  includeLive: boolean;
}

export function candleRow(c: Candle, confirm: boolean): OkxCandleRow {
  return [String(c.ts), fmt(c.o), fmt(c.h), fmt(c.l), fmt(c.c), fmt(c.vol), fmt(c.volCcy), fmt(c.volCcyQuote), confirm ? '1' : '0'];
}

/** One bar size of OHLCV history for one instrument, fed by trade prints. */
export class CandleSeries {
  private closed: Candle[] = [];
  private live: Candle | null = null;

  constructor(
    readonly bar: Bar,
    private readonly ctVal: Dec,
    private readonly tickSz: Dec,
    private readonly maxClosed = 1000,
  ) {}

  get current(): Candle | null {
    return this.live;
  }

  /** Builds `count` closed bars ending at `endTs` (exclusive) whose last close equals `endPx`. */
  seedHistory(endTs: number, endPx: Dec, rng: Prng, volPerBar: number, count: number): void {
    const returns: number[] = [];
    let prod = 1;
    for (let i = 0; i < count; i++) {
      const r = rng.gaussian() * volPerBar;
      returns.push(r);
      prod *= 1 + r;
    }
    let px = endPx.div(d(prod));
    const firstTs = barStart(this.bar, endTs) - count * BAR_MS[this.bar];
    for (let i = 0; i < count; i++) {
      const ts = firstTs + i * BAR_MS[this.bar];
      const o = roundToStep(px, this.tickSz);
      const r = returns[i] ?? 0;
      px = i === count - 1 ? endPx : px.mul(d(1 + r));
      const c = roundToStep(px, this.tickSz);
      const wick = Math.abs(rng.gaussian()) * volPerBar * 0.5;
      const hi = o.gt(c) ? o : c;
      const lo = o.gt(c) ? c : o;
      const h = roundToStep(hi.mul(d(1 + wick)), this.tickSz);
      const l = roundToStep(lo.mul(d(1 - wick)), this.tickSz);
      const vol = roundToStep(d(rng.between(50, 5000) * Math.sqrt(BAR_MS[this.bar] / MINUTE)), d('0.1'));
      const volCcy = vol.mul(this.ctVal);
      this.closed.push({ ts, o, h, l, c, vol, volCcy, volCcyQuote: volCcy.mul(c) });
    }
    this.trim();
  }

  /** Applies a trade print; returns the candle that just closed, if the bar rolled. */
  update(ts: number, px: Dec, sz: Dec): Candle | null {
    const start = barStart(this.bar, ts);
    let rolled: Candle | null = null;
    if (!this.live || this.live.ts !== start) {
      if (this.live && this.live.ts < start) {
        rolled = this.live;
        this.closed.push(rolled);
        this.trim();
      }
      this.live = { ts: start, o: px, h: px, l: px, c: px, vol: ZERO, volCcy: ZERO, volCcyQuote: ZERO };
    }
    const c = this.live;
    if (px.gt(c.h)) c.h = px;
    if (px.lt(c.l)) c.l = px;
    c.c = px;
    if (sz.gt(0)) {
      const volCcy = sz.mul(this.ctVal);
      c.vol = c.vol.add(sz);
      c.volCcy = c.volCcy.add(volCcy);
      c.volCcyQuote = c.volCcyQuote.add(volCcy.mul(px));
    }
    return rolled;
  }

  private trim(): void {
    if (this.closed.length > this.maxClosed) this.closed.splice(0, this.closed.length - this.maxClosed);
  }

  liveRow(): OkxCandleRow | null {
    return this.live ? candleRow(this.live, false) : null;
  }

  /** Rows newest first, honouring OKX `after` (older than) / `before` (newer than) cursors. */
  rows(q: CandleQuery): OkxCandleRow[] {
    const all: Array<[Candle, boolean]> = this.closed.map((c) => [c, true]);
    if (q.includeLive && this.live) all.push([this.live, false]);
    const out: OkxCandleRow[] = [];
    for (let i = all.length - 1; i >= 0 && out.length < q.limit; i--) {
      const entry = all[i];
      if (!entry) continue;
      const [c, confirmed] = entry;
      if (q.after !== undefined && c.ts >= q.after) continue;
      if (q.before !== undefined && c.ts <= q.before) break;
      out.push(candleRow(c, confirmed));
    }
    return out;
  }

  /** Open/high/low/volume over the bars whose open time is >= `sinceTs`. */
  stats(sinceTs: number): { open: Dec; high: Dec; low: Dec; vol: Dec; volCcy: Dec } | null {
    const bars = this.closed.filter((c) => c.ts >= sinceTs);
    if (this.live) bars.push(this.live);
    const first = bars[0];
    if (!first) return null;
    let high = first.h;
    let low = first.l;
    let vol = ZERO;
    let volCcy = ZERO;
    for (const c of bars) {
      if (c.h.gt(high)) high = c.h;
      if (c.l.lt(low)) low = c.l;
      vol = vol.add(c.vol);
      volCcy = volCcy.add(c.volCcy);
    }
    return { open: first.o, high, low, vol, volCcy };
  }

  /** Open price of the bar that starts at `ts`, if known. */
  openAt(ts: number): Dec | null {
    if (this.live && this.live.ts === ts) return this.live.o;
    const c = this.closed.find((x) => x.ts === ts);
    return c ? c.o : null;
  }
}

