import { normalizeOpenInterestHistory, type OkxOpenInterestHistoryRow } from '@pegasus/okx';
import type { Candle, FundingRecord, Instrument, SignalPhase } from '@pegasus/shared';
import type { InstrumentData, OiLevel } from '../types.js';
import type { CacheStore } from './cache.js';

/**
 * History for the engine, through a JSON cache. Completed bars and past settlements never change, so
 * a series is downloaded once and afterwards only what is newer than its newest cached row is fetched.
 * The exchange calls are injected (sources.ts has the real ones): the paging and merging here run
 * without a network in the tests.
 */

export type HistoryBar = '1Dutc' | '12Hutc';

const BAR_MS: Record<HistoryBar, number> = { '1Dutc': 86_400_000, '12Hutc': 43_200_000 };
/**
 * Where the first funding page starts. Perpetual swaps on the proxy venue began in September 2019; a
 * start time of 0 is not usable (Binance reads it as absent and answers with the newest rows).
 */
export const FUNDING_HISTORY_START = Date.UTC(2019, 0, 1);

/** One call each. Pages may come in any order. */
export interface Fetchers {
  instrument(instId: string): Promise<Instrument>;
  /** One page of candles that open before `after` (the newest page when undefined) */
  candles(instId: string, bar: HistoryBar, after: number | undefined): Promise<Candle[]>;
  /** One page of open interest rows up to `end` (the newest page when undefined) */
  openInterest(instId: string, period: HistoryBar, end: number | undefined): Promise<OkxOpenInterestHistoryRow[]>;
  /** One page of settlements from `startTime` on, oldest first; null when the proxy venue does not list the instrument */
  funding(instId: string, startTime: number): Promise<FundingRecord[] | null>;
  /** Rows of a full funding page: a shorter page is the last one */
  fundingPageSize: number;
}

export interface LoadOptions {
  instIds: readonly string[];
  phases: readonly SignalPhase[];
  /** Fetch the open interest history (off for --oi none) */
  openInterest: boolean;
  /** Fetch the funding history */
  funding: boolean;
  /** Current time: decides which open interest periods are complete */
  now: number;
  /** Ignore what is cached and download everything again */
  refresh: boolean;
  log?: (message: string) => void;
}

export interface LoadedData {
  data: InstrumentData[];
  /** What the run goes without, for the report */
  notes: string[];
}

/**
 * Page backwards from the newest row until a page reaches `stopAt` (a row at or before it), comes back
 * empty or brings nothing older. Rows keyed by time, oldest first.
 */
async function pageBackwards<T>(page: (cursor: number | undefined) => Promise<T[]>, timeOf: (row: T) => number, stopAt: number | null): Promise<T[]> {
  const rows = new Map<number, T>();
  let cursor: number | undefined;
  for (;;) {
    const batch = await page(cursor);
    if (batch.length === 0) break;
    let oldest = Number.POSITIVE_INFINITY;
    for (const row of batch) {
      const ts = timeOf(row);
      if (!rows.has(ts)) rows.set(ts, row);
      oldest = Math.min(oldest, ts);
    }
    if (stopAt !== null && oldest <= stopAt) break;
    if (cursor !== undefined && oldest >= cursor) break;
    cursor = oldest;
  }
  return [...rows.values()].sort((a, b) => timeOf(a) - timeOf(b));
}

/** Confirmed candles of one bar, oldest first: the cached ones plus the bars that closed since. */
export async function loadCandles(instId: string, bar: HistoryBar, fetchers: Fetchers, cache: CacheStore, refresh = false): Promise<Candle[]> {
  const key = `${instId}.candles-${bar}`;
  const cached = (refresh ? null : cache.read<Candle[]>(key)) ?? [];
  const newest = cached[cached.length - 1]?.ts ?? null;
  const fetched = await pageBackwards((after) => fetchers.candles(instId, bar, after), (c) => c.ts, newest);
  const added = fetched.filter((c) => c.confirm && (newest === null || c.ts > newest));
  if (added.length === 0 && cached.length > 0) return cached;
  const merged = [...cached, ...added];
  cache.write(key, merged);
  return merged;
}

/** Raw open interest rows of one period, oldest first. The two newest cached rows are fetched again: a row may have been cached while its period was forming. */
export async function loadOpenInterestRows(instId: string, period: HistoryBar, fetchers: Fetchers, cache: CacheStore, refresh = false): Promise<OkxOpenInterestHistoryRow[]> {
  const key = `${instId}.oi-${period}`;
  const cached = (refresh ? null : cache.read<OkxOpenInterestHistoryRow[]>(key)) ?? [];
  const newest = cached.length > 0 ? Number((cached[cached.length - 1] as OkxOpenInterestHistoryRow)[0]) : null;
  const timeOf = (row: OkxOpenInterestHistoryRow): number => Number(row[0]);
  const fetched = await pageBackwards((end) => fetchers.openInterest(instId, period, end), timeOf, newest === null ? null : newest - 2 * BAR_MS[period]);
  const byTs = new Map<number, OkxOpenInterestHistoryRow>();
  for (const row of cached) byTs.set(timeOf(row), row);
  for (const row of fetched) byTs.set(timeOf(row), row);
  const merged = [...byTs.values()].sort((a, b) => timeOf(a) - timeOf(b));
  cache.write(key, merged);
  return merged;
}

/**
 * Open interest levels at known instants from the daily and half-day rows. As in the live service, rows
 * whose newest period the exchange has not opened yet are read as of the last moment of that period.
 */
export function openInterestLevels(daily: readonly OkxOpenInterestHistoryRow[], halfDay: readonly OkxOpenInterestHistoryRow[], now: number): OiLevel[] {
  const newestLabel = (rows: readonly OkxOpenInterestHistoryRow[]): number => rows.reduce((max, row) => Math.max(max, Number(row[0])), 0);
  const asOf = Math.min(now, newestLabel(daily) + BAR_MS['1Dutc'] - 1, newestLabel(halfDay) + BAR_MS['12Hutc'] - 1);
  // The backtest reaches back before the half-day rows begin, so the daily rows of those days are used too.
  return normalizeOpenInterestHistory(daily, halfDay, { now: asOf, extendBeforeHalfDayCoverage: true }).map((s) => ({ ts: s.ts, value: s.oiCcy }));
}

/** Funding settlements, oldest first, paged forwards from the newest cached one; null when the proxy venue has no history for the instrument. */
export async function loadFunding(instId: string, fetchers: Fetchers, cache: CacheStore, refresh = false): Promise<FundingRecord[] | null> {
  const key = `${instId}.funding`;
  const cached = (refresh ? null : cache.read<FundingRecord[]>(key)) ?? [];
  const merged = [...cached];
  for (;;) {
    const last = merged[merged.length - 1];
    const page = await fetchers.funding(instId, last ? last.fundingTime + 1 : FUNDING_HISTORY_START);
    if (page === null) return merged.length > 0 ? merged : null;
    const fresh = page.filter((r) => !last || r.fundingTime > last.fundingTime).sort((a, b) => a.fundingTime - b.fundingTime);
    merged.push(...fresh);
    if (page.length < fetchers.fundingPageSize || fresh.length === 0) break;
  }
  if (merged.length > cached.length) cache.write(key, merged);
  return merged.length > 0 ? merged : null;
}

async function loadInstrument(instId: string, fetchers: Fetchers, cache: CacheStore, refresh: boolean): Promise<Instrument> {
  const key = `${instId}.instrument`;
  const cached = refresh ? null : cache.read<Instrument>(key);
  if (cached) return cached;
  const inst = await fetchers.instrument(instId);
  cache.write(key, inst);
  return inst;
}

/**
 * Everything the engine needs for `instIds`. Candles and the instrument are required; funding and open
 * interest are not: an instrument without them runs without, and a note says so.
 */
export async function loadData(opts: LoadOptions, fetchers: Fetchers, cache: CacheStore): Promise<LoadedData> {
  const log = opts.log ?? (() => undefined);
  const notes: string[] = [];
  const data: InstrumentData[] = [];
  const needHalfDays = opts.phases.some((phase) => phase !== 0);
  for (const instId of opts.instIds) {
    const inst = await loadInstrument(instId, fetchers, cache, opts.refresh);
    const daily = await loadCandles(instId, '1Dutc', fetchers, cache, opts.refresh);
    const halfDay = needHalfDays ? await loadCandles(instId, '12Hutc', fetchers, cache, opts.refresh) : [];
    log(`${instId}: ${daily.length} daily bars${needHalfDays ? `, ${halfDay.length} half-day bars` : ''}`);

    let funding: FundingRecord[] | null = null;
    if (opts.funding) {
      try {
        funding = await loadFunding(instId, fetchers, cache, opts.refresh);
        if (funding === null) notes.push(`${instId}: no funding history on the proxy venue; run without the funding filter and without funding charges`);
      } catch (err) {
        // A failed refresh still has what was downloaded before.
        funding = cache.read<FundingRecord[]>(`${instId}.funding`);
        notes.push(`${instId}: funding history not updated (${(err as Error).message}); ${funding ? 'using the cached records' : 'run without the funding filter and without funding charges'}`);
      }
      if (funding) log(`${instId}: ${funding.length} funding settlements`);
    }

    let oi: OiLevel[] | null = null;
    if (opts.openInterest) {
      try {
        const dailyRows = await loadOpenInterestRows(instId, '1Dutc', fetchers, cache, opts.refresh);
        const halfDayRows = await loadOpenInterestRows(instId, '12Hutc', fetchers, cache, opts.refresh);
        const levels = openInterestLevels(dailyRows, halfDayRows, opts.now);
        if (levels.length > 0) oi = levels;
        else notes.push(`${instId}: the open interest rows do not fit together; every OI change is unknown`);
      } catch (err) {
        // The level at a past instant never changes: the rows of an earlier run still stand.
        const levels = openInterestLevels(cache.read(`${instId}.oi-1Dutc`) ?? [], cache.read(`${instId}.oi-12Hutc`) ?? [], opts.now);
        if (levels.length > 0) oi = levels;
        notes.push(`${instId}: open interest history not updated (${(err as Error).message}); ${oi ? 'using the cached rows' : 'every OI change is unknown'}`);
      }
      if (oi) log(`${instId}: ${oi.length} open interest levels from ${new Date((oi[0] as OiLevel).ts).toISOString().slice(0, 10)}`);
    }
    data.push({ inst, daily, halfDay, funding, oi });
  }
  return { data, notes };
}
