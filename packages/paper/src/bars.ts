import { d, type Dec } from '@pegasus/mock-okx/engine';

export interface Bar {
  /** Open time, epoch ms */
  ts: number;
  open: Dec;
  high: Dec;
  low: Dec;
  close: Dec;
}

export type BarSize = '1m' | '5m' | '15m' | '1H';

export const BAR_MS: Record<BarSize, number> = { '1m': 60_000, '5m': 300_000, '15m': 900_000, '1H': 3_600_000 };

/** Where the history of a time span comes from; both return the bars that overlap [from, to], oldest first. */
export interface BarSource {
  /** Bars of traded prices. */
  tradeBars(instId: string, bar: BarSize, from: number, to: number): Promise<Bar[]>;
  /** Bars of the mark price. */
  markBars(instId: string, bar: BarSize, from: number, to: number): Promise<Bar[]>;
}

/** One page of candle rows, newest first: [ts, open, high, low, close, ...]. */
export type CandlePage = (opts: { after?: number; limit: number }) => Promise<readonly (readonly string[])[]>;

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

/**
 * Reads the bars that overlap [from, to] from OKX's two candle endpoints: the recent one (it carries the bar
 * still forming) and the history one, paged backwards with `after` until `from` is covered.
 */
export async function fetchBars(recent: CandlePage, history: CandlePage, barMs: number, from: number, to: number, opts: { recentLimit: number; historyLimit: number; pauseMs?: number; maxPages?: number }): Promise<Bar[]> {
  const first = Math.floor(from / barMs) * barMs;
  const bars = new Map<number, Bar>();
  const take = (rows: readonly (readonly string[])[]): number | null => {
    let oldest: number | null = null;
    for (const r of rows) {
      const ts = Number(r[0]);
      if (!Number.isFinite(ts)) continue;
      if (oldest === null || ts < oldest) oldest = ts;
      if (ts < first || ts > to) continue;
      bars.set(ts, { ts, open: d(r[1] ?? '0'), high: d(r[2] ?? '0'), low: d(r[3] ?? '0'), close: d(r[4] ?? '0') });
    }
    return oldest;
  };
  let cursor = take(await recent({ limit: opts.recentLimit })) ?? to + 1;
  const maxPages = opts.maxPages ?? 400;
  for (let page = 0; cursor > first; page++) {
    if (page >= maxPages) throw new Error(`the history between ${new Date(from).toISOString()} and ${new Date(to).toISOString()} needs more than ${maxPages} pages`);
    if (opts.pauseMs) await sleep(opts.pauseMs);
    const oldest = take(await history({ after: cursor, limit: opts.historyLimit }));
    // An empty page: the exchange has nothing older (the instrument was listed after `from`).
    if (oldest === null || oldest >= cursor) break;
    cursor = oldest;
  }
  return [...bars.values()].sort((a, b) => a.ts - b.ts);
}

export interface Segment {
  bar: BarSize;
  from: number;
  to: number;
}

/** Bars per segment that are still read at that size: 3,000 one-minute bars are 50 hours. */
const MAX_BARS = 3_000;

/**
 * The bar sizes a time span is replayed with. Up to 50 hours: one-minute bars throughout. Longer: one-minute
 * bars up to the next full hour (an order placed just before the stop must not be filled by a low made before it
 * existed), then the smallest size that covers the rest in 3,000 bars (hours when even that is not enough).
 */
export function planSegments(from: number, to: number): Segment[] {
  if (to <= from) return [];
  if ((to - from) / BAR_MS['1m'] <= MAX_BARS) return [{ bar: '1m', from, to }];
  const hour = Math.ceil(from / BAR_MS['1H']) * BAR_MS['1H'];
  const coarse = (['5m', '15m', '1H'] as const).find((b) => (to - hour) / BAR_MS[b] <= MAX_BARS) ?? '1H';
  const rest: Segment = { bar: coarse, from: hour, to };
  return hour > from ? [{ bar: '1m', from, to: hour - 1 }, rest] : [rest];
}
