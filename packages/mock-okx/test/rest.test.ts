import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { MockOkxHandle, OkxBookData, OkxCandleRow, OkxInstrument, OkxTicker } from '../src/index.js';
import { rest, start } from './helpers.js';

let h: MockOkxHandle;

beforeAll(async () => {
  h = await start();
});
afterAll(async () => {
  await h.close();
});

describe('public REST', () => {
  it('returns server time', async () => {
    const r = await rest(h, 'GET', '/api/v5/public/time');
    expect(r.code).toBe('0');
    expect(Number(r.data[0]?.ts)).toBeGreaterThan(1_700_000_000_000);
  });

  it('lists SWAP instruments with OKX field conventions', async () => {
    const r = await rest<OkxInstrument>(h, 'GET', '/api/v5/public/instruments?instType=SWAP');
    expect(r.code).toBe('0');
    const btc = r.data.find((i) => i.instId === 'BTC-USDT-SWAP');
    expect(btc).toMatchObject({ instType: 'SWAP', ctVal: '0.01', ctValCcy: 'BTC', lotSz: '0.1', tickSz: '0.1', lever: '100', settleCcy: 'USDT', ctType: 'linear', uly: 'BTC-USDT', baseCcy: '', quoteCcy: '', state: 'live' });
    const one = await rest<OkxInstrument>(h, 'GET', '/api/v5/public/instruments?instType=SWAP&instId=ETH-USDT-SWAP');
    expect(one.data.map((i) => i.instId)).toEqual(['ETH-USDT-SWAP']);
    expect((await rest(h, 'GET', '/api/v5/public/instruments')).code).not.toBe('0');
  });

  it('serves ticker, tickers, books, mark price and funding rate', async () => {
    const t = await rest<OkxTicker>(h, 'GET', '/api/v5/market/ticker?instId=BTC-USDT-SWAP');
    expect(t.code).toBe('0');
    const ticker = t.data[0];
    expect(ticker).toBeDefined();
    expect(Number(ticker?.askPx)).toBeGreaterThan(Number(ticker?.bidPx));
    expect(ticker?.last).toMatch(/^\d+(\.\d)?$/);
    expect(Number(ticker?.high24h)).toBeGreaterThanOrEqual(Number(ticker?.low24h));
    const all = await rest<OkxTicker>(h, 'GET', '/api/v5/market/tickers?instType=SWAP');
    expect(all.data.map((x) => x.instId).sort()).toEqual(['BTC-USDT-SWAP', 'ETH-USDT-SWAP']);
    expect((await rest(h, 'GET', '/api/v5/market/ticker?instId=DOGE-USDT-SWAP')).code).toBe('51001');

    const b = await rest<OkxBookData>(h, 'GET', '/api/v5/market/books?instId=BTC-USDT-SWAP&sz=5');
    const book = b.data[0];
    expect(book?.asks).toHaveLength(5);
    expect(book?.bids).toHaveLength(5);
    expect(book?.asks[0]).toHaveLength(4);
    expect(Number(book?.asks[0]?.[0])).toBeLessThan(Number(book?.asks[1]?.[0]));
    expect(Number(book?.bids[0]?.[0])).toBeGreaterThan(Number(book?.bids[1]?.[0]));
    expect(Number(book?.asks[0]?.[0])).toBeGreaterThan(Number(book?.bids[0]?.[0]));

    const m = await rest(h, 'GET', '/api/v5/public/mark-price?instType=SWAP&instId=ETH-USDT-SWAP');
    expect(m.data[0]).toMatchObject({ instType: 'SWAP', instId: 'ETH-USDT-SWAP' });
    const f = await rest(h, 'GET', '/api/v5/public/funding-rate?instId=BTC-USDT-SWAP');
    expect(f.data[0]).toMatchObject({ instId: 'BTC-USDT-SWAP', fundingRate: '0.0001' });
    expect(Number(f.data[0]?.nextFundingTime)).toBeGreaterThan(Number(f.data[0]?.fundingTime));
  });

  it('serves candles newest first with 300 bars of history and a live bar', async () => {
    const r = await rest<OkxCandleRow>(h, 'GET', '/api/v5/market/candles?instId=BTC-USDT-SWAP&bar=1m&limit=300');
    expect(r.code).toBe('0');
    expect(r.data).toHaveLength(300);
    const first = r.data[0];
    expect(first).toHaveLength(9);
    expect(first?.[8]).toBe('0');
    expect(r.data[1]?.[8]).toBe('1');
    for (let i = 1; i < r.data.length; i++) {
      expect(Number(r.data[i]?.[0])).toBe(Number(r.data[i - 1]?.[0]) - 60_000);
      const row = r.data[i];
      if (!row) continue;
      expect(Number(row[2])).toBeGreaterThanOrEqual(Math.max(Number(row[1]), Number(row[4])));
      expect(Number(row[3])).toBeLessThanOrEqual(Math.min(Number(row[1]), Number(row[4])));
    }
    // history closes into the live open
    expect(r.data[1]?.[4]).toBe(first?.[1]);
    const hist = await rest<OkxCandleRow>(h, 'GET', `/api/v5/market/history-candles?instId=BTC-USDT-SWAP&bar=1H&limit=100&after=${first?.[0]}`);
    expect(hist.data).toHaveLength(100);
    expect(hist.data.every((row) => row[8] === '1')).toBe(true);
    for (const bar of ['5m', '15m', '4H', '1D']) {
      const c = await rest<OkxCandleRow>(h, 'GET', `/api/v5/market/candles?instId=ETH-USDT-SWAP&bar=${bar}&limit=5`);
      expect(c.data.length).toBe(5);
    }
    expect((await rest(h, 'GET', '/api/v5/market/candles?instId=BTC-USDT-SWAP&bar=7m')).code).toBe('51000');
  });

  it('advances the market on tick() and setPrice()', async () => {
    h.setPrice('ETH-USDT-SWAP', '3100');
    const t = await rest<OkxTicker>(h, 'GET', '/api/v5/market/ticker?instId=ETH-USDT-SWAP');
    expect(Number(t.data[0]?.bidPx)).toBeLessThanOrEqual(3100);
    expect(Number(t.data[0]?.askPx)).toBeGreaterThan(3100);
    const before = await rest<OkxCandleRow>(h, 'GET', '/api/v5/market/candles?instId=ETH-USDT-SWAP&bar=1m&limit=1');
    h.tick();
    const after = await rest<OkxCandleRow>(h, 'GET', '/api/v5/market/candles?instId=ETH-USDT-SWAP&bar=1m&limit=1');
    expect(Number(after.data[0]?.[5])).toBeGreaterThan(Number(before.data[0]?.[5]));
  });

  it('answers unknown routes with code 404', async () => {
    const r = await rest(h, 'GET', '/api/v5/nope');
    expect(r.status).toBe(404);
    expect(r.code).toBe('404');
  });
});
