import { afterEach, describe, expect, it, vi } from 'vitest';
import type { OkxCandleRow, OkxFundingRateHistory, OkxOpenInterest, OkxOpenInterestHistoryRow } from '@pegasus/okx';
import type { Instrument, InstrumentSignalReport, SignalsResponse } from '@pegasus/shared';
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

/** 300 daily rows, newest first like OKX: a steady rise, UTC-midnight opens, the newest bar still forming. */
function candleRows(now: number): OkxCandleRow[] {
  const rows: OkxCandleRow[] = [];
  const today = now - (now % DAY);
  let close = 50_000;
  for (let i = 299; i >= 0; i--) {
    const open = close;
    close = open * (i % 2 === 0 ? 1.005 : 1.001);
    rows.unshift([String(today - i * DAY), open.toFixed(1), (close * 1.0005).toFixed(1), (open * 0.996).toFixed(1), close.toFixed(1), '1', '1', '1', i === 0 ? '0' : '1']);
  }
  return rows;
}

function fundingRows(now: number, rate: string): OkxFundingRateHistory[] {
  const last = now - (now % (8 * HOUR));
  return Array.from({ length: 12 }, (_, i) => ({ instType: 'SWAP' as const, instId: 'X', fundingRate: rate, realizedRate: rate, fundingTime: String(last - i * 8 * HOUR) }));
}

/**
 * 30 daily points, newest first: [ts, contracts, coin, USD]. The newest is today's row, still forming (well below
 * yesterday, so a change measured from it would show); over the 10 completed days before it the coin column grows `growth10d`.
 */
function oiRows(now: number, growth10d: number): OkxOpenInterestHistoryRow[] {
  const today = now - (now % DAY);
  return Array.from({ length: 30 }, (_, i) => {
    const coin = i === 0 ? 9_000 : 10_000 * (1 + growth10d * Math.max(0, 1 - (i - 1) / 10));
    return [String(today - i * DAY), (coin * 100).toFixed(0), coin.toFixed(2), (coin * 60_000).toFixed(0)];
  });
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

function harness(opts: { fundingRate?: string; oiGrowth?: number } = {}): Harness {
  const getCandles = vi.fn(async () => candleRows(Date.now()));
  const getFundingRateHistory = vi.fn(async () => fundingRows(Date.now(), opts.fundingRate ?? '0.0001'));
  const getOpenInterestHistory = vi.fn(async (): Promise<OkxOpenInterestHistoryRow[]> => oiRows(Date.now(), opts.oiGrowth ?? 0.05));
  const getOpenInterest = vi.fn(async (_t: string, instId: string): Promise<OkxOpenInterest[]> => [{ instType: 'SWAP', instId, oi: '987654', oiCcy: '9876.54', oiUsd: '592592400', ts: String(Date.now()) }]);
  const warnings: string[] = [];
  const log = { debug() {}, info() {}, warn: (_meta: unknown, msg: string) => void warnings.push(msg), error() {} } as unknown as Logger;
  const clients = { rest: { getCandles, getFundingRateHistory, getOpenInterestHistory, getOpenInterest } } as unknown as OkxClients;
  const market = { requireInstrument: (instId: string) => instrument(instId), book: () => null } as unknown as MarketDataService;
  const account = { balance: null } as unknown as AccountService;
  return { service: new SignalsService(clients, market, account, log), getCandles, getFundingRateHistory, getOpenInterestHistory, getOpenInterest, warnings };
}

function reportOf(res: SignalsResponse, instId: string): InstrumentSignalReport {
  const r = res.reports.find((x) => x.instId === instId);
  if (!r || 'error' in r) throw new Error(`no report for ${instId}: ${JSON.stringify(r)}`);
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
    expect(h.getOpenInterestHistory).toHaveBeenCalledWith('BTC-USDT-SWAP', '1Dutc');
    const r = reportOf(res, 'BTC-USDT-SWAP');
    expect(r.indicators.asOf).toBe(NOON - 12 * HOUR - DAY);
    expect(r.dataFetchedAt).toBe(NOON);
    expect(res.sizingParams).toEqual({ riskPct: '0.005', maxNotionalPct: '0.10', atrStopMultiple: '2.5' });
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
    expect(h.getCandles).toHaveBeenCalledTimes(1);
    // three minutes after the first fetch, but a new daily bar has closed in between
    vi.setSystemTime(Date.UTC(2026, 9, 4, 0, 1));
    const res = await h.service.report(['BTC-USDT-SWAP']);
    expect(h.getCandles).toHaveBeenCalledTimes(2);
    expect(h.getOpenInterestHistory).toHaveBeenCalledTimes(2);
    expect(reportOf(res, 'BTC-USDT-SWAP').indicators.asOf).toBe(Date.UTC(2026, 9, 3));
    expect(reportOf(res, 'BTC-USDT-SWAP').dataFetchedAt).toBe(Date.UTC(2026, 9, 4, 0, 1));
  });

  it('fetches open interest history one instrument at a time and keeps it for an hour', async () => {
    vi.useFakeTimers({ now: NOON });
    const h = harness();
    let running = 0;
    let maxRunning = 0;
    const starts: number[] = [];
    h.getOpenInterestHistory.mockImplementation(async () => {
      starts.push(Date.now());
      maxRunning = Math.max(maxRunning, ++running);
      await new Promise((r) => setTimeout(r, 20));
      running--;
      return oiRows(Date.now(), 0.05);
    });
    const ids = ['BTC-USDT-SWAP', 'ETH-USDT-SWAP', 'SOL-USDT-SWAP'];
    const first = h.service.report(ids);
    await vi.advanceTimersByTimeAsync(2_000);
    for (const id of ids) expect(reportOf(await first, id).structure?.openInterest?.source).toBe('history');
    expect(h.getOpenInterestHistory).toHaveBeenCalledTimes(3);
    expect(maxRunning).toBe(1);
    // the statistics endpoint allows 5 requests per 2 seconds
    expect(starts.map((t) => t - NOON)).toEqual([0, 420, 840]);
    // ten minutes later the candles are refetched, the open interest history is not
    vi.setSystemTime(NOON + 10 * 60_000);
    await h.service.report(ids);
    expect(h.getCandles).toHaveBeenCalledTimes(6);
    expect(h.getOpenInterestHistory).toHaveBeenCalledTimes(3);
    vi.setSystemTime(NOON + 61 * 60_000);
    const later = h.service.report(['BTC-USDT-SWAP']);
    await vi.advanceTimersByTimeAsync(1_000);
    await later;
    expect(h.getOpenInterestHistory).toHaveBeenCalledTimes(4);
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
    expect(h.getOpenInterestHistory).toHaveBeenCalledTimes(2);
    expect(h.getCandles).toHaveBeenCalledTimes(1);
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
    expect(h.getOpenInterestHistory).toHaveBeenCalledTimes(2);
  });

  it('keeps the changes from the history fetched earlier the same UTC day when its hourly refresh fails', async () => {
    vi.useFakeTimers({ toFake: ['Date'], now: NOON });
    const h = harness();
    await h.service.report(['BTC-USDT-SWAP']);
    h.getOpenInterestHistory.mockRejectedValue(new Error('Too Many Requests'));
    vi.setSystemTime(NOON + 61 * 60_000);
    const stale = reportOf(await h.service.report(['BTC-USDT-SWAP']), 'BTC-USDT-SWAP');
    expect(h.getOpenInterestHistory).toHaveBeenCalledTimes(2);
    // completed days do not change during the day, so the earlier rows still give the right changes
    expect(stale.structure?.openInterest).toMatchObject({ source: 'history', points: 29 });
    // not across a UTC midnight: yesterday's rows would be one day behind
    vi.setSystemTime(NOON + 13 * HOUR);
    expect(reportOf(await h.service.report(['BTC-USDT-SWAP']), 'BTC-USDT-SWAP').structure?.openInterest?.source).toBe('live');
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
});
