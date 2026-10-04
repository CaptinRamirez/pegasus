import { OkxApiError } from '@pegasus/okx';
import {
  buildSignalReport,
  computeBookMetrics,
  computeOpenInterestMetrics,
  DEFAULT_SIZING,
  DEFAULT_TREND_PARAMS,
  utcDayStart,
  type FundingRecord,
  type OpenInterestMetrics,
  type OpenInterestPoint,
  type SignalsResponse,
  type SizingParams,
  type TrendParams,
} from '@pegasus/shared';
import type { Logger } from '../logger.js';
import type { OkxClients } from '../okx/clients.js';
import { mapCandle, toOkxBar } from '../okx/mappers.js';
import type { AccountService } from './account.js';
import type { MarketDataService } from './market-data.js';

export interface SignalsOptions {
  /** Equity used for sizing; defaults to the account's total equity when available */
  equity?: string | undefined;
  riskPct?: string | undefined;
  maxNotionalPct?: string | undefined;
}

interface CacheEntry {
  at: number;
  candles: ReturnType<typeof mapCandle>[];
  funding: FundingRecord[] | null;
}

interface OiCacheEntry {
  at: number;
  /** Daily open interest history of the instrument (UTC days), oldest first */
  history: OpenInterestPoint[];
}

const CANDLE_CACHE_MS = 5 * 60_000;
const OI_CACHE_MS = 60 * 60_000;
// The trading-statistics endpoints allow 5 requests per 2 seconds per IP: the history calls go out one at a time, this far apart.
const OI_MIN_GAP_MS = 400;
/** Open interest is context: a report waits this long for the history and then goes out with the live level. */
const OI_WAIT_MS = 3_000;
/** After a failed history call the instrument's history is not asked for again for this long. */
const OI_RETRY_MS = 60_000;

/**
 * A cache entry is good for `maxAgeMs` but never across a UTC midnight: the daily bar closes
 * then, which is exactly when the framework says to look.
 */
function isFresh(at: number, now: number, maxAgeMs: number): boolean {
  return now - at < maxAgeMs && utcDayStart(at) === utcDayStart(now);
}

/**
 * Daily signal reports: confirmed UTC daily candles (forming bar excluded), the
 * recent funding history and the instrument's open interest history from the
 * exchange, run through the pure signal arithmetic in @pegasus/shared.
 */
export class SignalsService {
  private readonly cache = new Map<string, CacheEntry>();
  private readonly oiCache = new Map<string, OiCacheEntry>();
  private readonly oiPending = new Map<string, Promise<OpenInterestPoint[] | null>>();
  /** Per instrument: no report waits for its history before this time (Infinity while a call that was given up on is still running). */
  private readonly oiRetryAt = new Map<string, number>();
  /** Tail of the open interest history queue; resolves once the next call may start. */
  private oiQueue: Promise<void> = Promise.resolve();

  constructor(
    private readonly clients: OkxClients,
    private readonly market: MarketDataService,
    private readonly account: AccountService,
    private readonly log: Logger,
    private readonly params: TrendParams = DEFAULT_TREND_PARAMS,
  ) {}

  async report(instIds: string[], opts: SignalsOptions = {}): Promise<SignalsResponse> {
    const now = Date.now();
    const equity = opts.equity ?? this.account.balance?.totalEq ?? null;
    const sizing: SizingParams = {
      riskPct: opts.riskPct ?? DEFAULT_SIZING.riskPct,
      maxNotionalPct: opts.maxNotionalPct ?? DEFAULT_SIZING.maxNotionalPct,
      atrStopMultiple: this.params.atrStopMultiple,
    };
    const reports = await Promise.all(
      instIds.map(async (instId) => {
        try {
          const inst = this.market.requireInstrument(instId);
          const [data, openInterest] = await Promise.all([this.load(instId, now), this.openInterest(instId, now)]);
          const oiChange10d = openInterest !== null && openInterest.change10d !== '' ? openInterest.change10d : null;
          const report = buildSignalReport(instId, data.candles, data.funding, now, inst, equity, this.params, sizing, oiChange10d);
          const book = this.market.book(instId, 20);
          report.structure = { book: book ? computeBookMetrics(book, inst, 20) : null, openInterest };
          report.dataFetchedAt = data.at;
          return report;
        } catch (err) {
          const code = err instanceof OkxApiError ? 'EXCHANGE' : ((err as { code?: string }).code ?? 'INTERNAL');
          this.log.warn({ instId, err: (err as Error).message }, 'signal report failed');
          return { instId, error: { code, message: (err as Error).message } };
        }
      }),
    );
    return { generatedAt: now, equity, sizingParams: sizing, reports };
  }

  private async load(instId: string, now: number): Promise<CacheEntry> {
    const cached = this.cache.get(instId);
    if (cached && isFresh(cached.at, now, CANDLE_CACHE_MS)) return cached;
    // 300 is the maximum per call; the newest row is the forming bar and is dropped downstream (confirm=false).
    const rows = await this.clients.rest.getCandles(instId, toOkxBar('1D'), { limit: 300 });
    const candles = rows.map(mapCandle).sort((a, b) => a.ts - b.ts);
    let funding: FundingRecord[] | null = null;
    try {
      // 100 is the maximum per call and covers the 72-hour window even while settlement is hourly.
      const hist = await this.clients.rest.getFundingRateHistory(instId, { limit: 100 });
      funding = hist.map((h) => ({ fundingRate: h.fundingRate, fundingTime: Number(h.fundingTime) }));
    } catch (err) {
      this.log.warn({ instId, err: (err as Error).message }, 'funding history unavailable; signals computed without the funding filter');
    }
    const entry: CacheEntry = { at: now, candles, funding };
    this.cache.set(instId, entry);
    return entry;
  }

  /**
   * Open interest of the instrument: level and changes from its daily history, or, when the
   * history cannot be fetched, the live level alone (marked as such). Never fails the report.
   */
  private async openInterest(instId: string, now: number): Promise<OpenInterestMetrics | null> {
    const history = await this.openInterestHistory(instId, now);
    // Today's row is still forming: it is the level shown, the changes compare completed UTC days.
    const fromHistory = history ? computeOpenInterestMetrics(history, 'usd', 'history', utcDayStart(now)) : null;
    if (fromHistory) return fromHistory;
    try {
      const [cur] = await this.clients.rest.getOpenInterest('SWAP', instId);
      if (!cur) return null;
      const ts = Number(cur.ts);
      if (cur.oiUsd && cur.oiUsd !== '') return computeOpenInterestMetrics([{ ts, value: cur.oiCcy || cur.oi, usd: cur.oiUsd }], 'usd', 'live');
      return computeOpenInterestMetrics([{ ts, value: cur.oi }], 'contracts', 'live');
    } catch (err) {
      this.log.warn({ instId, err: (err as Error).message }, 'open interest unavailable');
      return null;
    }
  }

  /**
   * Cached for an hour per instrument. A report never waits longer than OI_WAIT_MS for it: the call is left to
   * finish in its queue and fills the cache for the next report, and until it has settled, or for OI_RETRY_MS
   * after it failed, no report waits for that instrument again. Completed days do not change during a UTC day,
   * so rows fetched earlier the same day stand in when a refresh is late or fails.
   */
  private openInterestHistory(instId: string, now: number): Promise<OpenInterestPoint[] | null> {
    const cached = this.oiCache.get(instId);
    if (cached && isFresh(cached.at, now, OI_CACHE_MS)) return Promise.resolve(cached.history);
    const sameDay = cached && utcDayStart(cached.at) === utcDayStart(now) ? cached.history : null;
    if (now < (this.oiRetryAt.get(instId) ?? 0)) return Promise.resolve(sameDay);
    const run = this.oiPending.get(instId) ?? this.queueOpenInterestHistory(instId);
    return new Promise((resolve) => {
      const timer = setTimeout(() => {
        this.oiRetryAt.set(instId, Number.POSITIVE_INFINITY);
        resolve(sameDay);
      }, OI_WAIT_MS);
      void run.then((history) => {
        clearTimeout(timer);
        resolve(history ?? sameDay);
      });
    });
  }

  private queueOpenInterestHistory(instId: string): Promise<OpenInterestPoint[] | null> {
    const run = this.oiQueue.then(async () => {
      try {
        // Rows are [ts, contracts, coin, USD]. The changes are measured on the coin column: USD moves with price.
        const rows = await this.clients.rest.getOpenInterestHistory(instId, toOkxBar('1D'));
        const history = rows.map((r) => ({ ts: Number(r[0]), value: r[2], usd: r[3] })).sort((a, b) => a.ts - b.ts);
        if (history.length === 0) throw new Error('the exchange returned no rows');
        this.oiCache.set(instId, { at: Date.now(), history });
        this.oiRetryAt.delete(instId);
        return history;
      } catch (err) {
        this.log.warn({ instId, err: (err as Error).message }, 'open interest history unavailable; reporting the live level without changes');
        this.oiRetryAt.set(instId, Date.now() + OI_RETRY_MS);
        return null;
      } finally {
        this.oiPending.delete(instId);
      }
    });
    this.oiPending.set(instId, run);
    this.oiQueue = run.then(() => new Promise<void>((resolve) => setTimeout(resolve, OI_MIN_GAP_MS)));
    return run;
  }
}
