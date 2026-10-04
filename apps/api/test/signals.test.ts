import { afterEach, describe, expect, it, vi } from 'vitest';
import type { OkxCandleRow, OkxFundingRateHistory, OkxOpenInterest, OkxOpenInterestHistoryRow } from '@pegasus/okx';
import type { Instrument, InstrumentSignalReport, SignalPhase, SignalsResponse } from '@pegasus/shared';
import type { Logger } from '../src/logger.js';
import type { OkxClients } from '../src/okx/clients.js';
import type { AccountService } from '../src/services/account.js';
import type { MarketDataService } from '../src/services/market-data.js';
import { SignalsService } from '../src/services/signals.js';

const HOUR = 3_600_000;
const DAY = 24 * HOUR;
/** 2026-10-03 12:00 UTC */
const NOON = Date.UTC(2026, 9, 3, 12);

function instrument(instId: string): Instrument {
  const base = instId.split('-')[0] ?? '';
  return {
    instId, instType: 'SWAP', uly: `${base}-USDT`, baseCcy: base, quoteCcy: 'USDT', settleCcy: 'USDT',
    ctVal: '0.01', ctValCcy: base, ctMult: '1', ctType: 'linear', lotSz: '0.1', minSz: '0.1', tickSz: '0.1',
    maxLmtSz: '100000', maxMktSz: '12000', maxLever: '100', state: 'live',
  };
}

/**
 * 300 daily rows, newest first like OKX: a steady rise, UTC-midnight opens, the newest bar still forming.
 * With `jump` the last closed bar (yesterday) rises by that fraction instead: a 3-sigma day on this quiet series.
 */
function candleRows(now: number, jump?: number): OkxCandleRow[] {
  const rows: OkxCandleRow[] = [];
  const today = now - (now % DAY);
  let close = 50_000;
  for (let i = 299; i >= 0; i--) {
    const open = close;
    close = open * (i === 1 && jump !== undefined ? 1 + jump : i % 2 === 0 ? 1.005 : 1.001);
    rows.unshift([String(today - i * DAY), open.toFixed(1), (close * 1.0005).toFixed(1), (open * 0.996).toFixed(1), close.toFixed(1), '1', '1', '1', i === 0 ? '0' : '1']);
  }
  return rows;
}

/**
 * 600 half-day rows, newest first: a steady rise, UTC midnight and noon opens, the newest bar still forming. The
 * noon-to-noon days alternate between a larger and a smaller gain, like the daily rows. Its own price level, so a
 * bar of the 12:00 cut cannot be mistaken for one of the 00:00 cut.
 */
function halfDayRows(now: number): OkxCandleRow[] {
  const rows: OkxCandleRow[] = [];
  const newest = now - (now % (DAY / 2));
  let close = 20_000;
  for (let i = 599; i >= 0; i--) {
    const open = close;
    const ts = newest - i * (DAY / 2);
    close = open * (Math.floor((ts - DAY / 2) / DAY) % 2 === 0 ? 1.0025 : 1.0005);
    rows.unshift([String(ts), open.toFixed(1), (close * 1.0005).toFixed(1), (open * 0.998).toFixed(1), close.toFixed(1), '1', '1', '1', i === 0 ? '0' : '1']);
  }
  return rows;
}

/** One page like OKX: at most `limit` rows, with `after` only those that opened before it. */
function page(rows: OkxCandleRow[], opts: { limit?: number; after?: number } = {}): OkxCandleRow[] {
  const after = opts.after;
  return rows.filter((row) => after === undefined || Number(row[0]) < after).slice(0, opts.limit ?? 100);
}

function fundingRows(now: number, rate: string): OkxFundingRateHistory[] {
  const last = now - (now % (8 * HOUR));
  return Array.from({ length: 12 }, (_, i) => ({ instType: 'SWAP' as const, instId: 'X', fundingRate: rate, realizedRate: rate, fundingTime: String(last - i * 8 * HOUR) }));
}

/**
 * Open interest history as OKX sends recent data, newest first: [ts, contracts, coin, USD], 30 daily or 60 half-day
 * rows, each holding the level at the END of its period. The newest row is still forming (well below yesterday, so
 * a change measured from it would show). Over the 10 completed days before today the coin column grows `growth10d`;
 * `change1d` moves yesterday's close by that fraction on top.
 */
function oiRows(now: number, growth10d: number, period: '1Dutc' | '12Hutc' = '1Dutc', change1d = 0): OkxOpenInterestHistoryRow[] {
  const today = now - (now % DAY);
  /** Level at the end of the day `i` days ago (1 = yesterday). */
  const dayEnd = (i: number): number => 10_000 * (1 + growth10d * Math.max(0, 1 - (i - 1) / 10)) * (i === 1 ? 1 + change1d : 1);
  const level = (instant: number): number => {
    const i = (today - (instant - (instant % DAY))) / DAY;
    if (instant % DAY === 0) return dayEnd(i + 1);
    return i === 0 ? 9_500 : (dayEnd(i + 1) + dayEnd(i)) / 2;
  };
  const row = (label: number, coin: number): OkxOpenInterestHistoryRow => [String(label), (coin * 100).toFixed(0), coin.toFixed(2), (coin * 60_000).toFixed(0)];
  const ms = period === '1Dutc' ? DAY : DAY / 2;
  const newest = now - (now % ms);
  return Array.from({ length: period === '1Dutc' ? 30 : 60 }, (_, i) => row(newest - i * ms, i === 0 ? 9_000 : level(newest - i * ms + ms)));
}

const IDS = ['BTC', 'ETH', 'SOL', 'XRP', 'DOGE', 'LTC', 'LINK', 'ADA', 'SUI'].map((c) => `${c}-USDT-SWAP`);

interface Harness {
  service: SignalsService;
  getCandles: ReturnType<typeof vi.fn>;
  getFundingRateHistory: ReturnType<typeof vi.fn>;
  getOpenInterestHistory: ReturnType<typeof vi.fn>;
  getOpenInterest: ReturnType<typeof vi.fn>;
  warnings: string[];
}

function harness(opts: { fundingRate?: string; oiGrowth?: number; oiChange1d?: number; jump?: number } = {}): Harness {
  const getCandles = vi.fn(async (_instId: string, bar: string, q: { limit?: number; after?: number } = {}): Promise<OkxCandleRow[]> =>
    page(bar === '12Hutc' ? halfDayRows(Date.now()) : candleRows(Date.now(), opts.jump), q),
  );
  const getFundingRateHistory = vi.fn(async () => fundingRows(Date.now(), opts.fundingRate ?? '0.0001'));
  const getOpenInterestHistory = vi.fn(async (_instId: string, period: '1Dutc' | '12Hutc'): Promise<OkxOpenInterestHistoryRow[]> => oiRows(Date.now(), opts.oiGrowth ?? 0.05, period, opts.oiChange1d));
  const getOpenInterest = vi.fn(async (_t: string, instId: string): Promise<OkxOpenInterest[]> => [{ instType: 'SWAP', instId, oi: '987654', oiCcy: '9876.54', oiUsd: '592592400', ts: String(Date.now()) }]);
  const warnings: string[] = [];
  const log = { debug() {}, info() {}, warn: (_meta: unknown, msg: string) => void warnings.push(msg), error() {} } as unknown as Logger;
  const clients = { rest: { getCandles, getFundingRateHistory, getOpenInterestHistory, getOpenInterest } } as unknown as OkxClients;
  const market = { requireInstrument: (instId: string) => instrument(instId), book: () => null } as unknown as MarketDataService;
  const account = { balance: null } as unknown as AccountService;
  return { service: new SignalsService(clients, market, account, log), getCandles, getFundingRateHistory, getOpenInterestHistory, getOpenInterest, warnings };
}

/** The row of one cut; the 00:00 UTC cut unless told otherwise. */
function reportOf(res: SignalsResponse, instId: string, phase: SignalPhase = 0): InstrumentSignalReport {
  const r = res.reports.find((x) => x.instId === instId && x.phase === phase);
  if (!r || 'error' in r) throw new Error(`no report for ${instId} at phase ${phase}: ${JSON.stringify(r)}`);
  return r;
}

describe('SignalsService', () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it('computes on the UTC daily bar and reports when the data was fetched and the sizing used', async () => {
    vi.useFakeTimers({ toFake: ['Date'], now: NOON });
    const h = harness();
    const res = await h.service.report(['BTC-USDT-SWAP'], { equity: '100000', riskPct: '0.005' });
    // OKX's plain 1D is the UTC+8 day; the framework decides on the UTC close
    expect(h.getCandles).toHaveBeenCalledWith('BTC-USDT-SWAP', '1Dutc', { limit: 300 });
    expect(h.getFundingRateHistory).toHaveBeenCalledWith('BTC-USDT-SWAP', { limit: 100 });
    // both periods: only together do they say which instant a row refers to
    expect(h.getOpenInterestHistory.mock.calls).toEqual([['BTC-USDT-SWAP', '1Dutc'], ['BTC-USDT-SWAP', '12Hutc']]);
    const r = reportOf(res, 'BTC-USDT-SWAP');
    expect(r.indicators.asOf).toBe(NOON - 12 * HOUR - DAY);
    expect(r.dataFetchedAt).toBe(NOON);
    // the request names one unit; each of the two cuts is sized at half of it
    expect(res.phases).toEqual([0, 12]);
    expect(res.sizingParams).toEqual({ riskPct: '0.0025', maxNotionalPct: '0.05', atrStopMultiple: '2.5' });
    // the level is today's forming row; the changes compare completed UTC days (yesterday with the days before it)
    expect(r.structure?.openInterest).toMatchObject({ source: 'history', unit: 'usd', current: '540000000', points: 29 });
    expect(Number(r.structure?.openInterest?.change10d)).toBeCloseTo(0.05, 6);
    expect(Number(r.structure?.openInterest?.change1d)).toBeCloseTo(1.05 / 1.045 - 1, 6);
  });

  it('never serves the previous day from the cache once a UTC midnight has passed', async () => {
    vi.useFakeTimers({ toFake: ['Date'], now: Date.UTC(2026, 9, 3, 23, 58) });
    const h = harness();
    await h.service.report(['BTC-USDT-SWAP']);
    vi.setSystemTime(Date.UTC(2026, 9, 3, 23, 59, 30));
    await h.service.report(['BTC-USDT-SWAP']);
    // one page of daily bars and two of half-day bars
    expect(h.getCandles).toHaveBeenCalledTimes(3);
    // three minutes after the first fetch, but a new daily bar has closed in between: at the 00:00 cut only
    vi.setSystemTime(Date.UTC(2026, 9, 4, 0, 1));
    const res = await h.service.report(['BTC-USDT-SWAP']);
    expect(h.getCandles).toHaveBeenCalledTimes(4);
    expect(h.getCandles.mock.calls[3]).toEqual(['BTC-USDT-SWAP', '1Dutc', { limit: 300 }]);
    expect(h.getOpenInterestHistory).toHaveBeenCalledTimes(4);
    expect(reportOf(res, 'BTC-USDT-SWAP').indicators.asOf).toBe(Date.UTC(2026, 9, 3));
    expect(reportOf(res, 'BTC-USDT-SWAP').dataFetchedAt).toBe(Date.UTC(2026, 9, 4, 0, 1));
  });

  it('fetches open interest history one instrument at a time and keeps it for an hour', async () => {
    vi.useFakeTimers({ now: NOON });
    const h = harness();
    let running = 0;
    let maxRunning = 0;
    const starts: number[] = [];
    h.getOpenInterestHistory.mockImplementation(async (_instId: string, period: '1Dutc' | '12Hutc') => {
      starts.push(Date.now());
      maxRunning = Math.max(maxRunning, ++running);
      await new Promise((r) => setTimeout(r, 20));
      running--;
      return oiRows(Date.now(), 0.05, period);
    });
    const ids = ['BTC-USDT-SWAP', 'ETH-USDT-SWAP', 'SOL-USDT-SWAP'];
    const first = h.service.report(ids);
    await vi.advanceTimersByTimeAsync(2_500);
    for (const id of ids) expect(reportOf(await first, id).structure?.openInterest?.source).toBe('history');
    // two calls per instrument: the daily and the half-day history
    expect(h.getOpenInterestHistory).toHaveBeenCalledTimes(6);
    expect(maxRunning).toBe(1);
    // the statistics endpoint allows 5 requests per 2 seconds
    expect(starts.map((t) => t - NOON)).toEqual([0, 420, 840, 1260, 1680, 2100]);
    // ten minutes later the candles are refetched, the open interest history is not
    vi.setSystemTime(NOON + 10 * 60_000);
    await h.service.report(ids);
    // three calls per instrument and fetch: the daily page and the two half-day pages
    expect(h.getCandles).toHaveBeenCalledTimes(18);
    expect(h.getOpenInterestHistory).toHaveBeenCalledTimes(6);
    vi.setSystemTime(NOON + 61 * 60_000);
    const later = h.service.report(['BTC-USDT-SWAP']);
    await vi.advanceTimersByTimeAsync(1_000);
    await later;
    expect(h.getOpenInterestHistory).toHaveBeenCalledTimes(8);
  });

  it('never serves open interest history from the cache across 00:00 or 12:00 UTC', async () => {
    vi.useFakeTimers({ toFake: ['Date'], now: NOON - 10 * 60_000 });
    const h = harness();
    await h.service.report(['BTC-USDT-SWAP']);
    vi.setSystemTime(NOON - 60_000);
    await h.service.report(['BTC-USDT-SWAP']);
    expect(h.getOpenInterestHistory).toHaveBeenCalledTimes(2);
    // eleven minutes after the fetch, but a half-day row has completed in between
    vi.setSystemTime(NOON + 60_000);
    const r = reportOf(await h.service.report(['BTC-USDT-SWAP']), 'BTC-USDT-SWAP');
    expect(h.getOpenInterestHistory).toHaveBeenCalledTimes(4);
    expect(r.structure?.openInterest).toMatchObject({ source: 'history', points: 29 });
  });

  it('marks the live fallback as such and does not ask for a failed history again for a minute', async () => {
    vi.useFakeTimers({ toFake: ['Date'], now: NOON });
    const h = harness();
    h.getOpenInterestHistory.mockRejectedValueOnce(new Error('Too Many Requests'));
    const first = reportOf(await h.service.report(['BTC-USDT-SWAP']), 'BTC-USDT-SWAP');
    expect(h.warnings.some((w) => w.includes('open interest history unavailable'))).toBe(true);
    // the live level of the same instrument, with the changes marked unavailable, not another measure
    expect(first.structure?.openInterest).toMatchObject({ source: 'live', unit: 'usd', current: '592592400', change1d: '', change10d: '', points: 1 });
    vi.setSystemTime(NOON + 30_000);
    const second = reportOf(await h.service.report(['BTC-USDT-SWAP']), 'BTC-USDT-SWAP');
    expect(h.getOpenInterestHistory).toHaveBeenCalledTimes(1);
    expect(second.structure?.openInterest?.source).toBe('live');
    vi.setSystemTime(NOON + 61_000);
    const third = reportOf(await h.service.report(['BTC-USDT-SWAP']), 'BTC-USDT-SWAP');
    expect(h.getOpenInterestHistory).toHaveBeenCalledTimes(3);
    expect(h.getCandles).toHaveBeenCalledTimes(3);
    expect(third.structure?.openInterest?.source).toBe('history');
  });

  it('does not let a stalled open interest endpoint hold the reports back', async () => {
    vi.useFakeTimers({ now: NOON });
    const h = harness();
    // every history call hangs until the 10 s REST timeout
    h.getOpenInterestHistory.mockImplementation(() => new Promise((_, reject) => setTimeout(() => reject(new Error('The operation was aborted due to timeout')), 10_000)));
    let answered = false;
    const first = h.service.report(IDS).then((res) => {
      answered = true;
      return res;
    });
    await vi.advanceTimersByTimeAsync(2_900);
    expect(answered).toBe(false);
    await vi.advanceTimersByTimeAsync(200);
    expect(answered).toBe(true);
    for (const id of IDS) expect(reportOf(await first, id).structure?.openInterest).toMatchObject({ source: 'live', change10d: '' });
    expect(h.getOpenInterestHistory).toHaveBeenCalledTimes(1);

    // a refresh while the queue still works through the stalled calls is answered without waiting again
    await vi.advanceTimersByTimeAsync(20_000);
    const second = await h.service.report(IDS);
    for (const id of IDS) expect(reportOf(second, id).structure?.openInterest?.source).toBe('live');
    expect(h.getOpenInterestHistory).toHaveBeenCalledTimes(3);
  });

  it('lets a slow history call finish in the background and serves it to the next report', async () => {
    vi.useFakeTimers({ now: NOON });
    const h = harness();
    h.getOpenInterestHistory.mockImplementationOnce(() => new Promise((_, reject) => setTimeout(() => reject(new Error('The operation was aborted due to timeout')), 10_000)));
    const first = h.service.report(['BTC-USDT-SWAP']);
    await vi.advanceTimersByTimeAsync(3_000);
    expect(reportOf(await first, 'BTC-USDT-SWAP').structure?.openInterest?.source).toBe('live');
    // it failed at 10 s: nothing is asked again for a minute, then the next report triggers a new call
    await vi.advanceTimersByTimeAsync(37_000);
    expect(reportOf(await h.service.report(['BTC-USDT-SWAP']), 'BTC-USDT-SWAP').structure?.openInterest?.source).toBe('live');
    expect(h.getOpenInterestHistory).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(31_000);
    // this one takes 5 s: the report does not wait for it, the one after gets it from the cache
    h.getOpenInterestHistory.mockImplementationOnce(() => new Promise((resolve) => setTimeout(() => resolve(oiRows(Date.now(), 0.05)), 5_000)));
    const third = h.service.report(['BTC-USDT-SWAP']);
    await vi.advanceTimersByTimeAsync(3_000);
    expect(reportOf(await third, 'BTC-USDT-SWAP').structure?.openInterest?.source).toBe('live');
    expect(h.getOpenInterestHistory).toHaveBeenCalledTimes(2);
    await vi.advanceTimersByTimeAsync(3_000);
    expect(reportOf(await h.service.report(['BTC-USDT-SWAP']), 'BTC-USDT-SWAP').structure?.openInterest?.source).toBe('history');
    expect(h.getOpenInterestHistory).toHaveBeenCalledTimes(3);
  });

  it('keeps the changes from the history fetched earlier the same UTC day when its hourly refresh fails', async () => {
    vi.useFakeTimers({ toFake: ['Date'], now: NOON });
    const h = harness();
    await h.service.report(['BTC-USDT-SWAP']);
    h.getOpenInterestHistory.mockRejectedValue(new Error('Too Many Requests'));
    vi.setSystemTime(NOON + 61 * 60_000);
    const stale = reportOf(await h.service.report(['BTC-USDT-SWAP']), 'BTC-USDT-SWAP');
    expect(h.getOpenInterestHistory).toHaveBeenCalledTimes(3);
    // completed rows do not change during a half-day, so the earlier rows still give the right changes
    expect(stale.structure?.openInterest).toMatchObject({ source: 'history', points: 29 });
    // not across a UTC midnight: yesterday's rows would be one day behind
    vi.setSystemTime(NOON + 13 * HOUR);
    expect(reportOf(await h.service.report(['BTC-USDT-SWAP']), 'BTC-USDT-SWAP').structure?.openInterest?.source).toBe('live');
  });

  it('keeps the crisis verdict of closed bars from the last history when the refresh after a half-day boundary fails', async () => {
    vi.useFakeTimers({ toFake: ['Date'], now: NOON - 10 * 60_000 });
    // yesterday's bar is a 3-sigma breakout with open interest up: not a crisis
    const h = harness({ jump: 0.012 });
    const before = reportOf(await h.service.report(['BTC-USDT-SWAP'], { equity: '100000' }), 'BTC-USDT-SWAP');
    expect(before.indicators.shockBars[0]).toMatchObject({ daysAgo: 0, crisis: false });
    h.getOpenInterestHistory.mockRejectedValue(new Error('Too Many Requests'));
    // past 12:00 the cache is no longer fresh, but the levels of every closed daily bar are the same as before
    vi.setSystemTime(NOON + 60_000);
    const after = reportOf(await h.service.report(['BTC-USDT-SWAP'], { equity: '100000' }), 'BTC-USDT-SWAP');
    expect(h.getOpenInterestHistory).toHaveBeenCalledTimes(3);
    expect(after.indicators.shockBars).toEqual(before.indicators.shockBars);
    expect(after.regime).not.toBe('crisis');
    expect(after.sizing?.long.multiplier).toBe('1');
    // the changes still compare completed days; the level shown is the live one, not the morning's forming row
    expect(after.structure?.openInterest).toMatchObject({ source: 'history', points: 29, current: '592592400', change10d: before.structure?.openInterest?.change10d });
    // past midnight a new bar has closed: only that one is unknown, the display falls back to the live level
    vi.setSystemTime(NOON + 13 * HOUR);
    const next = reportOf(await h.service.report(['BTC-USDT-SWAP'], { equity: '100000' }), 'BTC-USDT-SWAP');
    expect(next.indicators.shockBars[0]).toMatchObject({ daysAgo: 0, oiChange: '', crisis: true });
    expect(next.structure?.openInterest?.source).toBe('live');
  });

  it('does not take the newest row for a closed period while the exchange has not opened the next one', async () => {
    const midnight = NOON + 12 * HOUR;
    vi.useFakeTimers({ toFake: ['Date'], now: midnight + 40_000 });
    const h = harness({ jump: 0.012 });
    // 40 s after 00:00 UTC the rows are still those of 23:59: the newest ones, labelled yesterday, hold a level from before the close
    h.getOpenInterestHistory.mockImplementation(async (_instId: string, period: '1Dutc' | '12Hutc') => oiRows(midnight - 60_000, 0.05, period));
    const early = reportOf(await h.service.report(['BTC-USDT-SWAP'], { equity: '100000' }), 'BTC-USDT-SWAP');
    expect(h.warnings.some((w) => w.includes('open interest history incomplete') && w.includes('has not opened the rows'))).toBe(true);
    // yesterday's close is not known yet: unknown, not a change measured to the unfinished row
    expect(early.indicators.shockBars[0]).toMatchObject({ daysAgo: 0, oiChange: '', crisis: true });
    expect(early.structure?.openInterest?.source).toBe('live');
    expect(h.getOpenInterestHistory).toHaveBeenCalledTimes(2);
    // asked again after a minute instead of being kept for the cache hour
    h.getOpenInterestHistory.mockImplementation(async (_instId: string, period: '1Dutc' | '12Hutc') => oiRows(Date.now(), 0.05, period));
    vi.setSystemTime(midnight + 101_000);
    const healed = reportOf(await h.service.report(['BTC-USDT-SWAP'], { equity: '100000' }), 'BTC-USDT-SWAP');
    expect(h.getOpenInterestHistory).toHaveBeenCalledTimes(4);
    expect(healed.indicators.shockBars[0]).toMatchObject({ daysAgo: 0, crisis: false });
    expect(healed.structure?.openInterest?.source).toBe('history');
  });

  it('asks again a minute later when the level at the 12:00 close is missing, although both midnight levels are there', async () => {
    vi.useFakeTimers({ toFake: ['Date'], now: NOON + 40_000 });
    const h = harness({ fundingRate: '0.0009', oiGrowth: 0.24 });
    // 40 s after 12:00 UTC the exchange has not opened the 12:00 half-day row: the level at noon is not known yet
    h.getOpenInterestHistory.mockImplementation(async (_instId: string, period: '1Dutc' | '12Hutc') => oiRows(NOON - 60_000, 0.24, period));
    const early = await h.service.report(['BTC-USDT-SWAP'], { equity: '100000' });
    expect(h.warnings.some((w) => w.includes('open interest history incomplete') && w.includes('has not opened the rows'))).toBe(true);
    expect(reportOf(early, 'BTC-USDT-SWAP', 12).indicators.asOf).toBe(NOON - DAY);
    expect(reportOf(early, 'BTC-USDT-SWAP', 12).sizing?.long.adjustments).toEqual(['crowded x0.75 (funding 0.09%/8h, 10d OI change unavailable)']);
    // the 00:00 cut has both its levels
    expect(reportOf(early, 'BTC-USDT-SWAP', 0).sizing?.long.adjustments).toEqual(['crowded x0.75 (funding 0.09%/8h, OI +24% in 10d)']);
    expect(h.getOpenInterestHistory).toHaveBeenCalledTimes(2);
    // not kept for the cache hour: the 12:00 row heals once the exchange has the level
    h.getOpenInterestHistory.mockImplementation(async (_instId: string, period: '1Dutc' | '12Hutc') => oiRows(Date.now(), 0.24, period));
    vi.setSystemTime(NOON + 101_000);
    const healed = await h.service.report(['BTC-USDT-SWAP'], { equity: '100000' });
    expect(h.getOpenInterestHistory).toHaveBeenCalledTimes(4);
    expect(reportOf(healed, 'BTC-USDT-SWAP', 12).sizing?.long).toMatchObject({ multiplier: '1', adjustments: [] });
  });

  it('feeds the 10-day open interest change into the crowding cut', async () => {
    vi.useFakeTimers({ toFake: ['Date'], now: NOON });
    const crowded = harness({ fundingRate: '0.0009', oiGrowth: 0.24 });
    const r = reportOf(await crowded.service.report(['BTC-USDT-SWAP'], { equity: '100000' }), 'BTC-USDT-SWAP');
    expect(r.signals.longEntry).toBe(true);
    expect(r.sizing?.long.multiplier).toBe('0.75');
    expect(r.sizing?.long.adjustments).toEqual(['crowded x0.75 (funding 0.09%/8h, OI +24% in 10d)']);
    const calm = harness({ fundingRate: '0.0009', oiGrowth: 0.05 });
    expect(reportOf(await calm.service.report(['BTC-USDT-SWAP'], { equity: '100000' }), 'BTC-USDT-SWAP').sizing?.long.multiplier).toBe('1');
  });

  it('feeds the open interest change of each daily bar into the crisis rule', async () => {
    vi.useFakeTimers({ toFake: ['Date'], now: NOON });
    // yesterday's bar jumped 1.2% (a 3-sigma day) to a 55-day high while open interest rose: not a crisis
    const up = harness({ jump: 0.012 });
    const breakout = reportOf(await up.service.report(['BTC-USDT-SWAP'], { equity: '100000' }), 'BTC-USDT-SWAP');
    expect(breakout.indicators.shockBars).toHaveLength(1);
    expect(breakout.indicators.shockBars[0]).toMatchObject({ daysAgo: 0, crisis: false });
    expect(Number(breakout.indicators.shockBars[0]?.oiChange)).toBeCloseTo(1.05 / 1.045 - 1, 5);
    expect(breakout.indicators.crisisDaysAgo).toBeNull();
    expect(breakout.regime).not.toBe('crisis');
    expect(breakout.signals.longEntry).toBe(true);
    expect(breakout.sizing?.long.multiplier).toBe('1');
    expect(breakout.signals.reasons.some((r) => r.includes('not a deleveraging day'))).toBe(true);
    // the same bar with open interest down 12% over the UTC day is one
    const forced = harness({ jump: 0.012, oiChange1d: -0.12 });
    const crisis = reportOf(await forced.service.report(['BTC-USDT-SWAP'], { equity: '100000' }), 'BTC-USDT-SWAP');
    expect(crisis.indicators.shockBars[0]).toMatchObject({ daysAgo: 0, crisis: true });
    expect(Number(crisis.indicators.shockBars[0]?.oiChange)).toBeCloseTo((1.05 * 0.88) / 1.045 - 1, 5);
    expect(crisis.regime).toBe('crisis');
    expect(crisis.sizing?.long.multiplier).toBe('0.5');
    expect(crisis.structure?.openInterest?.change1d).toBe(crisis.indicators.shockBars[0]?.oiChange);
  });

  it('counts the shock as a crisis when the two histories do not fit together, and asks again a minute later', async () => {
    vi.useFakeTimers({ toFake: ['Date'], now: NOON });
    const h = harness({ jump: 0.012 });
    // daily rows that match neither half of their day: no row can be placed in time
    h.getOpenInterestHistory.mockImplementation(async (_instId: string, period: '1Dutc' | '12Hutc') => oiRows(Date.now(), period === '1Dutc' ? 0.5 : 0.05, period, period === '1Dutc' ? 0.3 : 0));
    const first = reportOf(await h.service.report(['BTC-USDT-SWAP'], { equity: '100000' }), 'BTC-USDT-SWAP');
    expect(h.warnings.some((w) => w.includes('open interest history incomplete') && w.includes('do not fit together'))).toBe(true);
    expect(first.indicators.shockBars).toEqual([{ daysAgo: 0, return: first.indicators.dailyReturn, oiChange: '', crisis: true }]);
    expect(first.regime).toBe('crisis');
    expect(first.sizing?.long.multiplier).toBe('0.5');
    expect(first.signals.reasons.some((r) => r.includes('OI change unavailable, counted as crisis'))).toBe(true);
    expect(first.structure?.openInterest).toMatchObject({ source: 'live', change10d: '' });
    expect(h.getOpenInterestHistory).toHaveBeenCalledTimes(2);
    // not kept for the cache hour
    vi.setSystemTime(NOON + 30_000);
    await h.service.report(['BTC-USDT-SWAP']);
    expect(h.getOpenInterestHistory).toHaveBeenCalledTimes(2);
    h.getOpenInterestHistory.mockImplementation(async (_instId: string, period: '1Dutc' | '12Hutc') => oiRows(Date.now(), 0.05, period));
    vi.setSystemTime(NOON + 61_000);
    const healed = reportOf(await h.service.report(['BTC-USDT-SWAP'], { equity: '100000' }), 'BTC-USDT-SWAP');
    expect(h.getOpenInterestHistory).toHaveBeenCalledTimes(4);
    expect(healed.indicators.shockBars[0]).toMatchObject({ crisis: false });
    expect(healed.structure?.openInterest?.source).toBe('history');
  });

  it('passes on what is known when the level at the last close is missing, and asks again a minute later', async () => {
    vi.useFakeTimers({ toFake: ['Date'], now: NOON });
    const h = harness({ jump: 0.012 });
    const today = NOON - 12 * HOUR;
    // the exchange is a day behind: nothing labelled yesterday or later
    h.getOpenInterestHistory.mockImplementation(async (_instId: string, period: '1Dutc' | '12Hutc') => oiRows(Date.now(), 0.05, period).filter((row) => Number(row[0]) < today - DAY));
    const r = reportOf(await h.service.report(['BTC-USDT-SWAP'], { equity: '100000' }), 'BTC-USDT-SWAP');
    expect(h.warnings.some((w) => w.includes('open interest history incomplete') && w.includes('last closed daily bar'))).toBe(true);
    expect(r.indicators.shockBars[0]).toMatchObject({ daysAgo: 0, oiChange: '', crisis: true });
    // the changes would describe an older day: the live level is shown instead
    expect(r.structure?.openInterest?.source).toBe('live');
    vi.setSystemTime(NOON + 61_000);
    await h.service.report(['BTC-USDT-SWAP']);
    expect(h.getOpenInterestHistory).toHaveBeenCalledTimes(4);
  });

  it('reports every instrument at both daily cuts, the 12:00 one on bars built from half-days', async () => {
    vi.useFakeTimers({ toFake: ['Date'], now: NOON + HOUR });
    const h = harness();
    const res = await h.service.report(['BTC-USDT-SWAP', 'ETH-USDT-SWAP'], { equity: '100000' });
    // ordered by instrument, then cut
    expect(res.reports.map((r) => [r.instId, r.phase])).toEqual([['BTC-USDT-SWAP', 0], ['BTC-USDT-SWAP', 12], ['ETH-USDT-SWAP', 0], ['ETH-USDT-SWAP', 12]]);
    // the second page asks for the rows before the oldest one of the first
    const halfDay = h.getCandles.mock.calls.filter((c) => c[0] === 'BTC-USDT-SWAP' && c[1] === '12Hutc');
    expect(halfDay).toEqual([['BTC-USDT-SWAP', '12Hutc', { limit: 300 }], ['BTC-USDT-SWAP', '12Hutc', { limit: 300, after: NOON - 299 * 12 * HOUR }]]);
    expect(h.getFundingRateHistory).toHaveBeenCalledTimes(2);
    const midnight = reportOf(res, 'BTC-USDT-SWAP', 0);
    const noon = reportOf(res, 'BTC-USDT-SWAP', 12);
    expect(midnight.indicators.asOf).toBe(NOON - 12 * HOUR - DAY);
    // the last day of the 12:00 cut ran from yesterday noon to today noon; the one open now is not counted
    expect(noon.indicators.asOf).toBe(NOON - DAY);
    expect(noon.indicators.bars).toBe(299);
    // the day's close is the close of its second half-day (the row that opened at 00:00 today), its range spans both
    const rows = halfDayRows(NOON + HOUR);
    const second = rows.find((r) => Number(r[0]) === NOON - 12 * HOUR);
    const first = rows.find((r) => Number(r[0]) === NOON - DAY);
    expect(noon.indicators.close).toBe(second?.[4]);
    expect(noon.indicators.close).not.toBe(midnight.indicators.close);
    expect(noon.indicators.nextExitHigh).toBe(second?.[2]);
    expect(Number(noon.indicators.dailyReturn)).toBeCloseTo(Math.log(Number(second?.[4]) / Number(first?.[1])), 6);
    // the same funding and the same displayed open interest block on both rows
    expect(noon.funding).toEqual(midnight.funding);
    expect(noon.structure?.openInterest).toEqual(midnight.structure?.openInterest);
    expect(noon.dataFetchedAt).toBe(NOON + HOUR);
  });

  it('sizes each cut at half a unit', async () => {
    vi.useFakeTimers({ toFake: ['Date'], now: NOON + HOUR });
    const two = harness();
    const res = await two.service.report(['BTC-USDT-SWAP'], { equity: '100000' });
    expect(res.sizingParams).toEqual({ riskPct: '0.00375', maxNotionalPct: '0.05', atrStopMultiple: '2.5' });
    // the same service with the 00:00 cut alone trades the whole unit there
    const getCandles = vi.fn(async (_instId: string, _bar: string, q: { limit?: number } = {}) => page(candleRows(Date.now()), q));
    const clients = { rest: { getCandles, getFundingRateHistory: two.getFundingRateHistory, getOpenInterestHistory: two.getOpenInterestHistory, getOpenInterest: two.getOpenInterest } } as unknown as OkxClients;
    const market = { requireInstrument: (instId: string) => instrument(instId), book: () => null } as unknown as MarketDataService;
    const log = { debug() {}, info() {}, warn() {}, error() {} } as unknown as Logger;
    const one = await new SignalsService(clients, market, { balance: null } as unknown as AccountService, log, undefined, [0]).report(['BTC-USDT-SWAP'], { equity: '100000' });
    expect(one.phases).toEqual([0]);
    expect(one.sizingParams).toEqual({ riskPct: '0.0075', maxNotionalPct: '0.1', atrStopMultiple: '2.5' });
    expect(one.reports.map((r) => r.phase)).toEqual([0]);
    expect(getCandles).toHaveBeenCalledTimes(1);
    const unit = reportOf(one, 'BTC-USDT-SWAP').sizing?.long;
    const lot = reportOf(res, 'BTC-USDT-SWAP').sizing?.long;
    // the stop is tighter than 7.5%, so both are capped: 10% of equity for the unit, 5% for one cut's lot
    expect(unit).toMatchObject({ capped: true, targetNotional: '10000.00' });
    expect(lot).toMatchObject({ capped: true, targetNotional: '5000.00', stopLong: unit?.stopLong });
    expect(Number(lot?.rawNotional)).toBeCloseTo(Number(unit?.rawNotional) / 2, 1);
    expect(reportOf(res, 'BTC-USDT-SWAP', 12).sizing?.long).toMatchObject({ capped: true, targetNotional: '5000.00' });
  });

  it('never serves a cut from the cache across its own close, and leaves the other cut cached', async () => {
    vi.useFakeTimers({ toFake: ['Date'], now: NOON - 2 * 60_000 });
    const h = harness();
    const before = await h.service.report(['BTC-USDT-SWAP']);
    expect(h.getCandles).toHaveBeenCalledTimes(3);
    expect(reportOf(before, 'BTC-USDT-SWAP', 12).indicators.asOf).toBe(NOON - 2 * DAY);
    // three minutes after the fetch, but the bar of the 12:00 cut has closed in between
    vi.setSystemTime(NOON + 60_000);
    const after = await h.service.report(['BTC-USDT-SWAP']);
    expect(h.getCandles).toHaveBeenCalledTimes(5);
    expect(h.getCandles.mock.calls.slice(3).map((c) => c[1])).toEqual(['12Hutc', '12Hutc']);
    expect(reportOf(after, 'BTC-USDT-SWAP', 12).indicators.asOf).toBe(NOON - DAY);
    expect(reportOf(after, 'BTC-USDT-SWAP', 0).indicators.asOf).toBe(NOON - 12 * HOUR - DAY);
    // the funding window ends now: refetched with whichever cut closed
    expect(h.getFundingRateHistory).toHaveBeenCalledTimes(2);
  });

  it('reports one cut when the other fails, and can be asked for one cut only', async () => {
    vi.useFakeTimers({ toFake: ['Date'], now: NOON + HOUR });
    const h = harness();
    h.getCandles.mockImplementation(async (_instId: string, bar: string, q: { limit?: number; after?: number } = {}) => {
      if (bar === '12Hutc') throw new Error('half-day candles unavailable');
      return page(candleRows(Date.now()), q);
    });
    const res = await h.service.report(['BTC-USDT-SWAP'], { equity: '100000' });
    expect(res.reports).toHaveLength(2);
    expect(reportOf(res, 'BTC-USDT-SWAP', 0).signals.longEntry).toBe(true);
    expect(res.reports[1]).toEqual({ instId: 'BTC-USDT-SWAP', phase: 12, error: { code: 'INTERNAL', message: 'half-day candles unavailable' } });
    // too short a history at one cut is that cut's error alone
    h.getCandles.mockImplementation(async (_instId: string, bar: string, q: { limit?: number; after?: number } = {}) => page(bar === '12Hutc' ? halfDayRows(Date.now()).slice(0, 100) : candleRows(Date.now()), q));
    vi.setSystemTime(NOON + HOUR + 6 * 60_000);
    const short = await h.service.report(['BTC-USDT-SWAP']);
    expect(short.reports[1]).toMatchObject({ phase: 12, error: { code: 'NOT_ENOUGH_DATA' } });
    expect('error' in (short.reports[0] ?? {})).toBe(false);
    // filtered to one cut: only that row, the sizing still split across both
    const only = await h.service.report(['BTC-USDT-SWAP'], { phase: 0 });
    expect(only.reports.map((r) => r.phase)).toEqual([0]);
    expect(only.phases).toEqual([0, 12]);
    expect(only.sizingParams.riskPct).toBe('0.00375');
  });

  it('measures the 10-day open interest change of the crowding cut up to each cut\'s own last close', async () => {
    vi.useFakeTimers({ toFake: ['Date'], now: NOON + HOUR });
    // up 24% over the 10 UTC days to today 00:00, but down again by 12:00: the 10 days to noon are -6%
    const h = harness({ fundingRate: '0.0009', oiGrowth: 0.24 });
    const res = await h.service.report(['BTC-USDT-SWAP'], { equity: '100000' });
    expect(reportOf(res, 'BTC-USDT-SWAP', 0).sizing?.long.adjustments).toEqual(['crowded x0.75 (funding 0.09%/8h, OI +24% in 10d)']);
    expect(reportOf(res, 'BTC-USDT-SWAP', 12).sizing?.long).toMatchObject({ multiplier: '1', adjustments: [] });
    // a level missing at either end: unknown, and with extreme funding the smaller size wins
    const gap = harness({ fundingRate: '0.0009', oiGrowth: 0.24 });
    const tenDaysBeforeNoon = NOON - 10 * DAY;
    gap.getOpenInterestHistory.mockImplementation(async (_instId: string, period: '1Dutc' | '12Hutc') =>
      oiRows(Date.now(), 0.24, period).filter((row) => period === '1Dutc' || Number(row[0]) !== tenDaysBeforeNoon - 12 * HOUR),
    );
    const holed = await gap.service.report(['BTC-USDT-SWAP'], { equity: '100000' });
    expect(reportOf(holed, 'BTC-USDT-SWAP', 0).sizing?.long.adjustments).toEqual(['crowded x0.75 (funding 0.09%/8h, OI +24% in 10d)']);
    expect(reportOf(holed, 'BTC-USDT-SWAP', 12).sizing?.long.adjustments).toEqual(['crowded x0.75 (funding 0.09%/8h, 10d OI change unavailable)']);
  });
});
