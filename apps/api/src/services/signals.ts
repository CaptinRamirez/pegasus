import { normalizeOpenInterestHistory, OkxApiError } from '@pegasus/okx';
import {
  barOiChanges,
  buildSignalReport,
  computeBookMetrics,
  computeOpenInterestMetrics,
  dailyBarsFromHalfDays,
  DEFAULT_SIZING,
  DEFAULT_TREND_PARAMS,
  phaseDayStart,
  SIGNAL_PHASE_HOURS,
  splitSizingAcrossPhases,
  utcDayStart,
  type Candle,
  type FundingRecord,
  type Instrument,
  type OpenInterestMetrics,
  type OpenInterestPoint,
  type SignalPhase,
  type SignalReportRow,
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
  /** Risk of one unit; split equally between the daily cuts */
  riskPct?: string | undefined;
  /** Notional cap of one unit; split equally between the daily cuts */
  maxNotionalPct?: string | undefined;
  /** Report this cut only; the sizing stays split across all the cuts the service computes */
  phase?: SignalPhase | undefined;
}

/** Daily candles of one instrument at one cut, oldest first, the forming bar included. */
interface CandleCacheEntry {
  at: number;
  candles: Candle[];
}

interface FundingCacheEntry {
  at: number;
  /** null when the history was unavailable: the funding filter is skipped */
  funding: FundingRecord[] | null;
}

/** Open interest history of one instrument, normalised to levels at known instants. */
interface OiHistory {
  /** When the rows were fetched */
  at: number;
  /** Level at each instant (UTC midnights and noons), oldest first; `ts` is the instant, not a row label */
  snapshots: OpenInterestPoint[];
  /** The newest row as the exchange sent it: the forming period, which tracks the live level; null when there is none */
  forming: OpenInterestPoint | null;
}

interface OiCacheEntry {
  at: number;
  /** How long the entry is served: an hour, or OI_RETRY_MS when the levels of the last closed daily bar of some cut were missing */
  maxAgeMs: number;
  history: OiHistory;
}

const DAY_MS = 86_400_000;
const HALF_DAY_MS = DAY_MS / 2;
const CANDLE_CACHE_MS = 5 * 60_000;
const OI_CACHE_MS = 60 * 60_000;
// The trading-statistics endpoints allow 5 requests per 2 seconds per IP: the history calls go out one at a time, this far apart.
const OI_MIN_GAP_MS = 400;
/** Open interest is context: a report waits this long for the history and then goes out with the live level. */
const OI_WAIT_MS = 3_000;
/** After a failed or incomplete history call the instrument's history is not asked for again for this long. */
const OI_RETRY_MS = 60_000;

/** OKX returns at most this many candles per call. */
const CANDLE_PAGE = 300;

/**
 * A cache entry is good for `maxAgeMs` but never across a close of one of `phases` (00:00 UTC for
 * phase 0, 12:00 UTC for phase 12): a daily bar closes then, which is exactly when the framework says to look.
 */
function isFresh(at: number, now: number, maxAgeMs: number, phases: readonly SignalPhase[]): boolean {
  return now - at < maxAgeMs && phases.every((phase) => phaseDayStart(at, phase) === phaseDayStart(now, phase));
}

/** Whether two times fall into the same UTC half-day: a half-day row of the open interest history completes at 00:00 and at 12:00. */
function sameHalfDay(a: number, b: number): boolean {
  return Math.floor(a / HALF_DAY_MS) === Math.floor(b / HALF_DAY_MS);
}

/**
 * Daily points for computeOpenInterestMetrics: the level of completed UTC day D is the snapshot at D + 24h.
 * Only the unbroken run of days ending yesterday counts (the changes are measured by position); today's
 * forming row, when there is one, is appended as the displayed level.
 */
function dailyPoints(history: OiHistory, now: number): OpenInterestPoint[] {
  const today = utcDayStart(now);
  const byInstant = new Map(history.snapshots.map((s) => [s.ts, s]));
  const days: OpenInterestPoint[] = [];
  for (let end = today; ; end -= DAY_MS) {
    const level = byInstant.get(end);
    if (!level) break;
    days.unshift({ ...level, ts: end - DAY_MS });
  }
  if (days.length > 0 && history.forming && history.forming.ts >= today) days.push(history.forming);
  return days;
}

/**
 * Open interest change over the 10 days ending at the close of the bar that opens at `lastBarTs`
 * (the crowding input of that report), read from the levels at the two instants; null when either is missing.
 */
function oiChange10d(history: OiHistory | null, lastBarTs: number | undefined): string | null {
  if (!history || lastBarTs === undefined) return null;
  const close = lastBarTs + DAY_MS;
  return barOiChanges(history.snapshots, [close - 10 * DAY_MS], 10 * DAY_MS)[0]?.change ?? null;
}

/** What the rows of one instrument share: everything but the candles of the cut. */
interface InstrumentInputs {
  inst: Instrument;
  funding: FundingCacheEntry;
  history: OiHistory | null;
  openInterest: OpenInterestMetrics | null;
}

/**
 * Daily signal reports, one per instrument and daily cut: confirmed daily candles that close at
 * that cut (forming bar excluded; 00:00 UTC from the exchange's UTC daily bars, 12:00 UTC built from
 * its 12-hour UTC bars), the recent funding history and the instrument's open interest history from
 * the exchange, run through the pure signal arithmetic in @pegasus/shared. Each cut is sized at its
 * share of a unit.
 */
export class SignalsService {
  /** Keyed by instrument and cut */
  private readonly candleCache = new Map<string, CandleCacheEntry>();
  private readonly fundingCache = new Map<string, FundingCacheEntry>();
  private readonly oiCache = new Map<string, OiCacheEntry>();
  private readonly oiPending = new Map<string, Promise<OiHistory | null>>();
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
    /** The daily cuts computed, in row order */
    private readonly phases: readonly SignalPhase[] = SIGNAL_PHASE_HOURS,
  ) {}

  async report(instIds: string[], opts: SignalsOptions = {}): Promise<SignalsResponse> {
    const now = Date.now();
    const equity = opts.equity ?? this.account.balance?.totalEq ?? null;
    // The request names the risk and the cap of one unit; every cut trades its share of it.
    const sizing: SizingParams = splitSizingAcrossPhases(
      {
        riskPct: opts.riskPct ?? DEFAULT_SIZING.riskPct,
        maxNotionalPct: opts.maxNotionalPct ?? DEFAULT_SIZING.maxNotionalPct,
        atrStopMultiple: this.params.atrStopMultiple,
      },
      this.phases.length,
    );
    const wanted = opts.phase === undefined ? this.phases : this.phases.filter((phase) => phase === opts.phase);
    const failed = (instId: string, phase: SignalPhase, err: unknown): SignalReportRow => {
      const code = err instanceof OkxApiError ? 'EXCHANGE' : ((err as { code?: string }).code ?? 'INTERNAL');
      this.log.warn({ instId, phase, err: (err as Error).message }, 'signal report failed');
      return { instId, phase, error: { code, message: (err as Error).message } };
    };
    const rows = await Promise.all(
      instIds.map(async (instId): Promise<SignalReportRow[]> => {
        let shared: InstrumentInputs;
        try {
          const inst = this.market.requireInstrument(instId);
          const [funding, history] = await Promise.all([this.loadFunding(instId, now), this.openInterestHistory(instId, now)]);
          shared = { inst, funding, history, openInterest: await this.openInterest(instId, history, now) };
        } catch (err) {
          return wanted.map((phase) => failed(instId, phase, err));
        }
        // Each cut is its own row: one failing (its candles unavailable, too few bars) leaves the other standing.
        return Promise.all(
          wanted.map(async (phase) => {
            try {
              const data = await this.loadCandles(instId, phase, now);
              const { inst, funding, history, openInterest } = shared;
              // Per daily bar of this cut for the crisis rule; a bar whose two levels are not both known stays unknown and counts as a crisis day there.
              const confirmed = data.candles.filter((c) => c.confirm).map((c) => c.ts);
              const oiChanges = history ? barOiChanges(history.snapshots, confirmed) : null;
              const crowding = oiChange10d(history, confirmed[confirmed.length - 1]);
              const report = buildSignalReport(instId, data.candles, funding.funding, now, inst, equity, this.params, sizing, crowding, oiChanges, phase);
              const book = this.market.book(instId, 20);
              report.structure = { book: book ? computeBookMetrics(book, inst, 20) : null, openInterest };
              report.dataFetchedAt = Math.min(data.at, funding.at);
              return report;
            } catch (err) {
              return failed(instId, phase, err);
            }
          }),
        );
      }),
    );
    return { generatedAt: now, equity, phases: [...this.phases], sizingParams: sizing, reports: rows.flat() };
  }

  /** Daily candles of one cut, cached for 5 minutes and never across that cut's own close. */
  private async loadCandles(instId: string, phase: SignalPhase, now: number): Promise<CandleCacheEntry> {
    const key = `${instId}:${phase}`;
    const cached = this.candleCache.get(key);
    if (cached && isFresh(cached.at, now, CANDLE_CACHE_MS, [phase])) return cached;
    const entry: CandleCacheEntry = { at: now, candles: phase === 0 ? await this.dailyCandles(instId) : dailyBarsFromHalfDays(await this.halfDayCandles(instId), phase) };
    this.candleCache.set(key, entry);
    return entry;
  }

  /** The exchange's own UTC daily bars. */
  private async dailyCandles(instId: string): Promise<Candle[]> {
    // 300 is the maximum per call; the newest row is the forming bar and is dropped downstream (confirm=false).
    const rows = await this.clients.rest.getCandles(instId, toOkxBar('1D'), { limit: CANDLE_PAGE });
    return rows.map(mapCandle).sort((a, b) => a.ts - b.ts);
  }

  /** 12-hour UTC bars, two pages: 600 of them make as many days as one page of daily bars. */
  private async halfDayCandles(instId: string): Promise<Candle[]> {
    const bar = toOkxBar('12H');
    const rows = await this.clients.rest.getCandles(instId, bar, { limit: CANDLE_PAGE });
    // `after` asks for the rows older than that open time. A short first page is the whole history.
    const oldest = rows.reduce((min, row) => Math.min(min, Number(row[0])), Number.POSITIVE_INFINITY);
    if (rows.length >= CANDLE_PAGE) rows.push(...(await this.clients.rest.getCandles(instId, bar, { limit: CANDLE_PAGE, after: oldest })));
    return rows.map(mapCandle).sort((a, b) => a.ts - b.ts);
  }

  /**
   * Funding settlements of the instrument, the same records for every cut (the window ends now, not at a close).
   * Cached like the candles, never across a close of any cut. Never fails the report.
   */
  private async loadFunding(instId: string, now: number): Promise<FundingCacheEntry> {
    const cached = this.fundingCache.get(instId);
    if (cached && isFresh(cached.at, now, CANDLE_CACHE_MS, this.phases)) return cached;
    let funding: FundingRecord[] | null = null;
    try {
      // 100 is the maximum per call and covers the 72-hour window even while settlement is hourly.
      const hist = await this.clients.rest.getFundingRateHistory(instId, { limit: 100 });
      funding = hist.map((h) => ({ fundingRate: h.fundingRate, fundingTime: Number(h.fundingTime) }));
    } catch (err) {
      this.log.warn({ instId, err: (err as Error).message }, 'funding history unavailable; signals computed without the funding filter');
    }
    const entry: FundingCacheEntry = { at: now, funding };
    this.fundingCache.set(instId, entry);
    return entry;
  }

  /**
   * Open interest of the instrument: level and changes from its history, or, when the history is
   * unavailable or does not reach yesterday, the live level alone (marked as such). Never fails the report.
   */
  private async openInterest(instId: string, history: OiHistory | null, now: number): Promise<OpenInterestMetrics | null> {
    // Today's row is still forming: it is the level shown, the changes compare completed UTC days.
    // Rows from an earlier half-day (a late or failed refresh) still give those changes; their forming row is old, so the live level is shown.
    const stale = history !== null && !sameHalfDay(history.at, now);
    const points = history ? dailyPoints(stale ? { ...history, forming: null } : history, now) : [];
    if (stale && points.length > 0) {
      const live = await this.liveLevel(instId);
      if (live && live.ts >= utcDayStart(now)) points.push(live);
    }
    const fromHistory = points.length > 0 ? computeOpenInterestMetrics(points, 'usd', 'history', utcDayStart(now)) : null;
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

  /** The live level as a point in coin and USD; null when the call fails or the exchange sends no USD value. */
  private async liveLevel(instId: string): Promise<OpenInterestPoint | null> {
    try {
      const [cur] = await this.clients.rest.getOpenInterest('SWAP', instId);
      if (!cur || !cur.oiUsd || cur.oiUsd === '') return null;
      return { ts: Number(cur.ts), value: cur.oiCcy || cur.oi, usd: cur.oiUsd };
    } catch {
      return null;
    }
  }

  /**
   * Cached for an hour per instrument, never across 00:00 or 12:00 UTC: a half-day row completes there. A report
   * never waits longer than OI_WAIT_MS for it: the calls are left to finish in their queue and fill the cache for
   * the next report, and until they have settled, or for OI_RETRY_MS after one failed, no report waits for that
   * instrument again. The level at a past instant never changes, so the rows fetched last, of whatever age,
   * stand in when a refresh is late or fails: only the bars that closed after them stay unknown.
   */
  private openInterestHistory(instId: string, now: number): Promise<OiHistory | null> {
    const cached = this.oiCache.get(instId);
    if (cached && sameHalfDay(cached.at, now) && now - cached.at < cached.maxAgeMs) return Promise.resolve(cached.history);
    const last = cached?.history ?? null;
    if (now < (this.oiRetryAt.get(instId) ?? 0)) return Promise.resolve(last);
    const run = this.oiPending.get(instId) ?? this.queueOpenInterestHistory(instId);
    return new Promise((resolve) => {
      const timer = setTimeout(() => {
        this.oiRetryAt.set(instId, Number.POSITIVE_INFINITY);
        resolve(last);
      }, OI_WAIT_MS);
      void run.then((history) => {
        clearTimeout(timer);
        resolve(history ?? last);
      });
    });
  }

  /**
   * Both the daily and the half-day history, one call after the other: only together do they say whether a
   * row holds the level at the start or at the end of its period (normalizeOpenInterestHistory).
   */
  private queueOpenInterestHistory(instId: string): Promise<OiHistory | null> {
    const run = this.oiQueue.then(async () => {
      try {
        // Rows are [ts, contracts, coin, USD]. The changes are measured on the coin column: USD moves with price.
        const daily = await this.clients.rest.getOpenInterestHistory(instId, toOkxBar('1D'));
        if (daily.length === 0) throw new Error('the exchange returned no rows');
        await new Promise<void>((resolve) => setTimeout(resolve, OI_MIN_GAP_MS));
        const halfDay = await this.clients.rest.getOpenInterestHistory(instId, toOkxBar('12H'));
        const at = Date.now();
        const today = utcDayStart(at);
        // Until the exchange has opened the row of the running period, its newest row is still the forming one,
        // whatever the clock says: the rows are read as of the last moment of that row's own period.
        const newestLabel = (rows: readonly (readonly string[])[]): number => rows.reduce((max, row) => Math.max(max, Number(row[0])), 0);
        const lagging = newestLabel(daily) < today || newestLabel(halfDay) < at - (at % HALF_DAY_MS);
        const asOf = lagging ? Math.min(at, newestLabel(daily) + DAY_MS - 1, newestLabel(halfDay) + HALF_DAY_MS - 1) : at;
        // Not extended past the half-day rows: the convention may change exactly where they end.
        const snapshots = normalizeOpenInterestHistory(daily, halfDay, { now: asOf }).map((s) => ({ ts: s.ts, value: s.oiCcy, usd: s.oiUsd }));
        const newest = [...daily, ...halfDay].reduce((a, b) => (Number(b[0]) > Number(a[0]) ? b : a));
        const forming = Number(newest[0]) >= today ? { ts: Number(newest[0]), value: newest[2], usd: newest[3] } : null;
        // The last closed daily bar of every cut needs the levels at its open and at its close: 00:00 to 00:00 UTC
        // for the displayed changes and the 00:00 cut, 12:00 to 12:00 for the 12:00 cut.
        const instants = new Set(snapshots.map((s) => s.ts));
        const complete = [...new Set<SignalPhase>([0, ...this.phases])].every((phase) => {
          const close = phaseDayStart(at, phase);
          return instants.has(close) && instants.has(close - DAY_MS);
        });
        if (!complete) {
          const what =
            snapshots.length === 0
              ? 'the daily and half-day rows do not fit together'
              : lagging
                ? 'the levels of the last closed daily bar are missing: the exchange has not opened the rows of the running period yet'
                : 'the levels of the last closed daily bar are missing';
          this.log.warn({ instId }, `open interest history incomplete (${what}); bars without both levels count as crisis days, asking again in a minute`);
        }
        // Rows that cannot be placed in time say nothing: the levels known from the last fetch are kept.
        const kept = snapshots.length === 0 ? this.oiCache.get(instId)?.history : undefined;
        const history: OiHistory = kept ?? { at, snapshots, forming };
        this.oiCache.set(instId, { at, maxAgeMs: complete ? OI_CACHE_MS : OI_RETRY_MS, history });
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
