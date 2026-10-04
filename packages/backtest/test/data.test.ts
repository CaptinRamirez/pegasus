import type { OkxOpenInterestHistoryRow } from '@pegasus/okx';
import type { Candle, FundingRecord } from '@pegasus/shared';
import { describe, expect, it } from 'vitest';
import { MemoryCache } from '../src/data/cache.js';
import { FUNDING_HISTORY_START, loadCandles, loadData, loadFunding, loadOpenInterestRows, openInterestLevels, type Fetchers } from '../src/data/load.js';
import { binanceSymbol } from '../src/data/sources.js';
import { bar, DAY, HALF_DAY, HOUR, instrument, T0 } from './helpers.js';

const PAGE = 100;

/** An exchange with `days` daily bars (the newest still forming), their open interest rows and funding every 8 hours. */
class FakeExchange {
  days: number;
  calls = { candles: 0, openInterest: 0, funding: 0, instrument: 0 };
  /** null: the proxy venue does not list the instrument */
  hasFunding = true;
  fundingStarts: number[] = [];

  constructor(days: number) {
    this.days = days;
  }

  private candle(i: number, barMs: number): Candle {
    const forming = i === Math.floor((this.days * DAY) / barMs) - 1;
    return { ...bar(T0 + i * barMs, 100 + i, 101 + i, 99 + i, 100.5 + i), confirm: !forming };
  }

  /** Daily rows hold the level at their label, like the half-day row of the same instant (the START convention). */
  private oiRow(i: number, barMs: number): OkxOpenInterestHistoryRow {
    const instant = T0 + i * barMs;
    const level = 1000 + ((instant - T0) / HALF_DAY) * 7;
    return [String(instant), String(level * 100), String(level), String(level * 50_000)];
  }

  fetchers(): Fetchers {
    const page = <T>(count: number, make: (i: number) => T, tsOf: (row: T) => number, before: number | undefined): T[] => {
      const rows: T[] = [];
      for (let i = count - 1; i >= 0 && rows.length < PAGE; i--) {
        const row = make(i);
        if (before === undefined || tsOf(row) < before) rows.push(row);
      }
      return rows;
    };
    return {
      instrument: async (instId) => {
        this.calls.instrument++;
        return instrument(instId);
      },
      candles: async (_instId, barName, after) => {
        this.calls.candles++;
        const barMs = barName === '1Dutc' ? DAY : HALF_DAY;
        return page(Math.floor((this.days * DAY) / barMs), (i) => this.candle(i, barMs), (c) => c.ts, after);
      },
      openInterest: async (_instId, period, end) => {
        this.calls.openInterest++;
        const barMs = period === '1Dutc' ? DAY : HALF_DAY;
        // `end` is inclusive here: the pager must cope with either reading.
        return page(Math.floor((this.days * DAY) / barMs), (i) => this.oiRow(i, barMs), (r) => Number(r[0]), end === undefined ? undefined : end + 1);
      },
      fundingPageSize: PAGE,
      funding: async (_instId, startTime) => {
        this.calls.funding++;
        this.fundingStarts.push(startTime);
        if (!this.hasFunding) return null;
        const out: FundingRecord[] = [];
        for (let t = T0; t < T0 + this.days * DAY && out.length < PAGE; t += 8 * HOUR) if (t >= startTime) out.push({ fundingTime: t, fundingRate: '0.0001' });
        return out;
      },
    };
  }
}

describe('candle cache', () => {
  it('downloads the whole history once, confirmed bars only', async () => {
    const exchange = new FakeExchange(251);
    const cache = new MemoryCache();
    const bars = await loadCandles('AAA-USDT-SWAP', '1Dutc', exchange.fetchers(), cache);
    expect(bars).toHaveLength(250);
    expect(bars.every((c) => c.confirm)).toBe(true);
    expect(bars[0]?.ts).toBe(T0);
    expect(bars.every((c, i) => i === 0 || c.ts > (bars[i - 1] as Candle).ts)).toBe(true);
    // 100 + 100 + 51 rows, then the empty page that ends the history.
    expect(exchange.calls.candles).toBe(4);
  });

  it('afterwards fetches only the bars newer than the newest cached one', async () => {
    const exchange = new FakeExchange(251);
    const cache = new MemoryCache();
    const first = await loadCandles('AAA-USDT-SWAP', '1Dutc', exchange.fetchers(), cache);
    exchange.calls.candles = 0;
    // Nothing new: one call, the cache untouched.
    expect(await loadCandles('AAA-USDT-SWAP', '1Dutc', exchange.fetchers(), cache)).toEqual(first);
    expect(exchange.calls.candles).toBe(1);
    // Three days later: one call brings the three bars that closed since.
    exchange.days += 3;
    exchange.calls.candles = 0;
    const second = await loadCandles('AAA-USDT-SWAP', '1Dutc', exchange.fetchers(), cache);
    expect(exchange.calls.candles).toBe(1);
    expect(second).toHaveLength(253);
    expect(second.slice(0, 250)).toEqual(first);
    expect(cache.read<Candle[]>('AAA-USDT-SWAP.candles-1Dutc')).toHaveLength(253);
    // A long gap pages back until it meets the cache.
    exchange.days += 150;
    exchange.calls.candles = 0;
    expect(await loadCandles('AAA-USDT-SWAP', '1Dutc', exchange.fetchers(), cache)).toHaveLength(403);
    expect(exchange.calls.candles).toBe(2);
    // --refresh starts over.
    exchange.calls.candles = 0;
    expect(await loadCandles('AAA-USDT-SWAP', '1Dutc', exchange.fetchers(), cache, true)).toHaveLength(403);
    expect(exchange.calls.candles).toBe(6);
  });
});

describe('funding cache', () => {
  it('pages forwards from the start, then from the newest cached settlement', async () => {
    const exchange = new FakeExchange(80);
    const cache = new MemoryCache();
    const first = await loadFunding('AAA-USDT-SWAP', exchange.fetchers(), cache);
    // 240 settlements in pages of 100.
    expect(first).toHaveLength(240);
    expect(exchange.fundingStarts).toEqual([FUNDING_HISTORY_START, T0 + 99 * 8 * HOUR + 1, T0 + 199 * 8 * HOUR + 1]);
    exchange.days += 1;
    exchange.fundingStarts = [];
    const second = await loadFunding('AAA-USDT-SWAP', exchange.fetchers(), cache);
    expect(second).toHaveLength(243);
    expect(exchange.fundingStarts).toEqual([T0 + 239 * 8 * HOUR + 1]);
  });

  it('is null for an instrument the proxy venue does not list', async () => {
    const exchange = new FakeExchange(80);
    exchange.hasFunding = false;
    expect(await loadFunding('AAA-USDT-SWAP', exchange.fetchers(), new MemoryCache())).toBeNull();
  });
});

describe('open interest cache', () => {
  it('fetches the two newest cached rows again and nothing older', async () => {
    const exchange = new FakeExchange(250);
    const cache = new MemoryCache();
    const first = await loadOpenInterestRows('AAA-USDT-SWAP', '1Dutc', exchange.fetchers(), cache);
    expect(first).toHaveLength(250);
    expect(exchange.calls.openInterest).toBe(4);
    // A row cached while its period was forming is replaced by the next fetch.
    const stale = first.map((r, i): OkxOpenInterestHistoryRow => (i === 249 ? [r[0], '1', '1', '1'] : r));
    cache.write('AAA-USDT-SWAP.oi-1Dutc', stale);
    exchange.days += 2;
    exchange.calls.openInterest = 0;
    const second = await loadOpenInterestRows('AAA-USDT-SWAP', '1Dutc', exchange.fetchers(), cache);
    expect(exchange.calls.openInterest).toBe(1);
    expect(second).toHaveLength(252);
    expect(second[249]).toEqual(first[249]);
  });
});

describe('loadData', () => {
  it('assembles candles, funding and open interest levels, and says what is missing', async () => {
    const exchange = new FakeExchange(60);
    const cache = new MemoryCache();
    const now = T0 + 60 * DAY - HOUR;
    const opts = { instIds: ['AAA-USDT-SWAP'], phases: [0, 12] as const, openInterest: true, funding: true, now, refresh: false };
    const { data, notes } = await loadData(opts, exchange.fetchers(), cache);
    const d = data[0];
    expect(notes).toEqual([]);
    expect(d?.daily).toHaveLength(59);
    expect(d?.halfDay).toHaveLength(119);
    expect(d?.funding).toHaveLength(180);
    // START-type rows: a level at every 00:00 and 12:00 up to the last completed half-day.
    const expected = openInterestLevels(cache.read('AAA-USDT-SWAP.oi-1Dutc') ?? [], cache.read('AAA-USDT-SWAP.oi-12Hutc') ?? [], now);
    expect(d?.oi).toEqual(expected);
    expect(d?.oi?.[0]).toEqual({ ts: T0, value: '1000' });
    expect(d?.oi?.every((l) => l.ts <= now)).toBe(true);
    // The instrument comes from the cache the second time.
    await loadData(opts, exchange.fetchers(), cache);
    expect(exchange.calls.instrument).toBe(1);

    exchange.hasFunding = false;
    const without = await loadData({ ...opts, instIds: ['BBB-USDT-SWAP'], phases: [0], openInterest: false }, exchange.fetchers(), new MemoryCache());
    expect(without.data[0]).toMatchObject({ funding: null, oi: null, halfDay: [] });
    expect(without.notes[0]).toContain('no funding history');
  });

  it('maps an OKX swap to the same pair on Binance', () => {
    expect(binanceSymbol('BTC-USDT-SWAP')).toBe('BTCUSDT');
    expect(binanceSymbol('ETH-USDT-SWAP')).toBe('ETHUSDT');
  });
});
