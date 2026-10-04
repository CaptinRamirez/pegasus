import { EventEmitter } from 'node:events';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { OkxInstrument, OkxWsArg, OkxWsData } from '@pegasus/okx';
import type { Logger } from '../src/logger.js';
import type { OkxClients } from '../src/okx/clients.js';
import { MarketDataService } from '../src/services/market-data.js';

const IDS = ['BTC', 'ETH', 'SOL', 'XRP', 'DOGE', 'LTC', 'LINK', 'ADA', 'SUI'].map((c) => `${c}-USDT-SWAP`);

function rawInst(instId: string): OkxInstrument {
  const uly = instId.replace('-SWAP', '');
  return {
    instType: 'SWAP', instId, uly, instFamily: uly, baseCcy: '', quoteCcy: '', settleCcy: 'USDT',
    ctVal: '0.01', ctMult: '1', ctValCcy: uly.split('-')[0] ?? '', ctType: 'linear', lotSz: '1', minSz: '1', tickSz: '0.1', maxLmtSz: '100000', maxMktSz: '12000',
    lever: '100', state: 'live', listTime: '0', expTime: '',
  };
}

/** Stands in for OkxWsClient: records subscribe / unsubscribe requests and lets the test push frames. */
class StubSocket extends EventEmitter {
  readonly requests: Array<{ op: 'subscribe' | 'unsubscribe'; args: OkxWsArg[] }> = [];
  /** Times (ms) of the watchdog-visible actions, for the hourly caps. */
  readonly subscribeTimes: number[] = [];
  readonly reconnectTimes: number[] = [];
  isReady = true;
  currentStatus = 'connected';
  connect(): void {}
  async close(): Promise<void> {}
  async subscribe(args: OkxWsArg[]): Promise<void> {
    this.requests.push({ op: 'subscribe', args });
    this.subscribeTimes.push(Date.now());
  }
  async unsubscribe(args: OkxWsArg[]): Promise<void> {
    this.requests.push({ op: 'unsubscribe', args });
  }
  /** The socket stays up: the worst case for the caps, the streams never recover. */
  reconnect(): void {
    this.reconnectTimes.push(Date.now());
  }
  drop(): void {
    this.isReady = false;
    this.currentStatus = 'disconnected';
    this.emit('status', 'disconnected');
  }
  restore(): void {
    this.isReady = true;
    this.currentStatus = 'connected';
    this.emit('status', 'connected');
    this.emit('ready');
  }
  /** subscribe + unsubscribe requests for `books`, optionally for one instrument */
  bookRequests(instId?: string): number {
    return this.requests.filter((r) => r.args.length === 1 && r.args[0]?.channel === 'books' && (instId === undefined || r.args[0].instId === instId)).length;
  }
}

function frame(instId: string, action: 'snapshot' | 'update', seqId: number, prevSeqId: number): OkxWsData {
  return { arg: { channel: 'books', instId }, action, data: [{ bids: [['100', '1', '0', '1']], asks: [['101', '1', '0', '1']], ts: '1700000000000', seqId, prevSeqId }] };
}

describe('MarketDataService instrument specs', () => {
  it('keeps the spec of every listed SWAP for valuing orders, while only the configured ones are tracked', async () => {
    const log = { debug() {}, info() {}, warn() {}, error() {} } as unknown as Logger;
    const listed = ['BTC-USDT-SWAP', 'PEPE-USDT-SWAP'];
    const clients = { rest: { getInstruments: async () => listed.map(rawInst) }, wsPublic: new StubSocket(), wsBusiness: new StubSocket(), wsPrivate: null, clock: { offsetMs: 0 }, demo: false } as unknown as OkxClients;
    const market = new MarketDataService(clients, log);
    await market.loadInstruments(['BTC-USDT-SWAP']);
    expect([...market.instruments.keys()]).toEqual(['BTC-USDT-SWAP']);
    expect(market.getInstrument('PEPE-USDT-SWAP')).toBeUndefined();
    expect(market.specOf('PEPE-USDT-SWAP')).toMatchObject({ instId: 'PEPE-USDT-SWAP', ctVal: '0.01', ctValCcy: 'PEPE' });
    expect(market.specOf('BTC-USDT-SWAP')).toBe(market.getInstrument('BTC-USDT-SWAP'));
    expect(market.specOf('NOPE-USDT-SWAP')).toBeUndefined();
  });
});

describe('MarketDataService order book resync', () => {
  let pub: StubSocket;
  let market: MarketDataService;
  let errors: Array<{ meta: unknown; msg: unknown }>;

  async function boot(instIds: string[]): Promise<void> {
    pub = new StubSocket();
    errors = [];
    const log = { debug() {}, info() {}, warn() {}, error: (meta: unknown, msg: unknown) => void errors.push({ meta, msg }) } as unknown as Logger;
    const clients = { rest: { getInstruments: async () => instIds.map(rawInst) }, wsPublic: pub, wsBusiness: new StubSocket(), wsPrivate: null, clock: { offsetMs: 0 }, demo: false } as unknown as OkxClients;
    market = new MarketDataService(clients, log);
    await market.loadInstruments(instIds);
    await market.start();
    pub.requests.length = 0; // the initial subscription is not a resync
  }

  /** A feed that never syncs: an update without a snapshot every `stepMs` for each instrument. */
  async function feedBroken(instIds: string[], durationMs: number, stepMs: number): Promise<void> {
    for (let t = 0; t < durationMs; t += stepMs) {
      for (const id of instIds) pub.emit('data', frame(id, 'update', 2, 1));
      await vi.advanceTimersByTimeAsync(stepMs);
    }
  }

  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(async () => {
    await market.stop();
    vi.useRealTimers();
  });

  it('backs off: immediate, then 1 s, 2 s, 4 s, then only every 60 s with one error log', async () => {
    const id = 'BTC-USDT-SWAP';
    await boot([id]);
    await feedBroken([id], 60_000, 100);
    // resyncs at about 0 s, 1.3 s, 3.6 s and 7.9 s; the fifth waits the full minute
    expect(pub.bookRequests()).toBe(8);
    expect(market.bookResyncFailures(id)).toBe(5);
    expect(errors).toHaveLength(1);
    expect(String(errors[0]?.msg)).toMatch(/order book unavailable/);

    await feedBroken([id], 3_540_000, 500);
    // one hour in total: 4 quick attempts plus one per (60 s + settle) afterwards
    expect(pub.bookRequests()).toBeLessThanOrEqual(2 * (4 + 60));
    expect(pub.bookRequests()).toBeGreaterThanOrEqual(2 * 50);
    expect(errors).toHaveLength(1);
    expect(market.book(id)).toBeNull();
  });

  it('keeps nine broken books under the exchange limit of 480 subscription requests per hour', async () => {
    await boot(IDS);
    await feedBroken(IDS, 3_599_000, 500); // just short of the hour: the first resyncs leave the rolling window at 3 600 s
    expect(pub.bookRequests()).toBeLessThanOrEqual(200);
    // every instrument still gets its turn
    for (const id of IDS) expect(pub.bookRequests(id)).toBeGreaterThanOrEqual(8);
  });

  it('drops frames while a resync is pending and resets the streak after 30 s in sync', async () => {
    const id = 'BTC-USDT-SWAP';
    await boot([id]);
    expect(market.bookResyncFailures(id)).toBe(0);
    pub.emit('data', frame(id, 'update', 2, 1));
    await vi.advanceTimersByTimeAsync(300); // first resync is immediate
    expect(pub.requests.map((r) => r.op)).toEqual(['unsubscribe', 'subscribe']);
    pub.emit('data', frame(id, 'update', 2, 1));
    expect(market.bookResyncFailures(id)).toBe(2);
    // waiting out the 1 s backoff: more broken frames, even a snapshot, change nothing
    pub.emit('data', frame(id, 'update', 3, 2));
    pub.emit('data', frame(id, 'snapshot', 10, -1));
    await vi.advanceTimersByTimeAsync(500);
    expect(market.bookResyncFailures(id)).toBe(2);
    expect(pub.bookRequests()).toBe(2);
    expect(market.book(id)).toBeNull();
    await vi.advanceTimersByTimeAsync(1_000);
    expect(pub.bookRequests()).toBe(4);

    // the fresh subscription syncs
    pub.emit('data', frame(id, 'snapshot', 10, -1));
    pub.emit('data', frame(id, 'update', 11, 10));
    expect(market.book(id)?.seqId).toBe(11);
    await vi.advanceTimersByTimeAsync(29_000);
    expect(market.bookResyncFailures(id)).toBe(2);
    await vi.advanceTimersByTimeAsync(1_500);
    expect(market.bookResyncFailures(id)).toBe(0);

    // healthy again: the next gap is resynced at once
    pub.emit('data', frame(id, 'update', 20, 19));
    expect(market.bookResyncFailures(id)).toBe(1);
    await vi.advanceTimersByTimeAsync(300);
    expect(pub.bookRequests()).toBe(6);
  });

  it('stop() clears every pending timer', async () => {
    await boot(IDS);
    for (const id of IDS) pub.emit('data', frame(id, 'snapshot', 10, -1));
    await feedBroken(IDS, 2_000, 100);
    expect(vi.getTimerCount()).toBeGreaterThan(0);
    await market.stop();
    expect(vi.getTimerCount()).toBe(0);
  });
});

describe('MarketDataService stale market data', () => {
  const id = 'BTC-USDT-SWAP';
  let pub: StubSocket;
  let market: MarketDataService;
  let warnings: Array<{ meta: unknown; msg: unknown }>;

  async function boot(instIds: string[]): Promise<void> {
    pub = new StubSocket();
    warnings = [];
    const log = { debug() {}, info() {}, warn: (meta: unknown, msg: unknown) => void warnings.push({ meta, msg }), error() {} } as unknown as Logger;
    const clients = { rest: { getInstruments: async () => instIds.map(rawInst) }, wsPublic: pub, wsBusiness: new StubSocket(), wsPrivate: null, clock: { offsetMs: 0 }, demo: false } as unknown as OkxClients;
    market = new MarketDataService(clients, log);
    await market.loadInstruments(instIds);
    await market.start();
    pub.requests.length = 0;
    pub.subscribeTimes.length = 0;
  }

  const pushTicker = (instId: string, last = '100.5'): void => {
    pub.emit('data', { arg: { channel: 'tickers', instId }, data: [{ instType: 'SWAP', instId, last, lastSz: '1', askPx: '101', askSz: '1', bidPx: '100', bidSz: '1', open24h: '99', high24h: '102', low24h: '98', volCcy24h: '1', vol24h: '1', ts: '1700000000000' }] } satisfies OkxWsData);
  };
  const pushMark = (instId: string, markPx = '100.4'): void => {
    pub.emit('data', { arg: { channel: 'mark-price', instId }, data: [{ instType: 'SWAP', instId, markPx, ts: '1700000000000' }] } satisfies OkxWsData);
  };
  /** What OKX sends about every 60 s for a book that did not change. */
  const pushBookKeepAlive = (instId: string, seqId: number): void => {
    pub.emit('data', { arg: { channel: 'books', instId }, action: 'update', data: [{ bids: [], asks: [], ts: '1700000000000', seqId, prevSeqId: seqId }] } satisfies OkxWsData);
  };
  /** Requests for one channel of one instrument, in order. */
  const ops = (channel: string, instId: string): string[] =>
    pub.requests.filter((r) => r.args.length === 1 && r.args[0]?.channel === channel && r.args[0].instId === instId).map((r) => r.op);
  const maxPerHour = (times: number[]): number => Math.max(0, ...times.map((t) => times.filter((u) => u >= t && u < t + 3_600_000).length));

  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(async () => {
    await market.stop();
    vi.useRealTimers();
  });

  it('flags each stream after its own threshold and stops pricing from it', async () => {
    await boot([id]);
    expect(market.connection()).toMatchObject({ dataAgeMs: -1, staleStreams: [] });
    pushTicker(id);
    pushMark(id);
    pub.emit('data', frame(id, 'snapshot', 10, -1));
    expect(market.refPrice(id)).toBe('100.4');
    expect(market.bestPrice(id, 'buy')).toBe('101');
    expect(market.estimateMarketFill(id, 'buy', '1')?.avgPx).toBe('101');

    await vi.advanceTimersByTimeAsync(29_000);
    expect(market.connection().staleStreams).toEqual([]);
    expect(market.refPrice(id)).toBe('100.4');
    expect(market.liveMarkPrice(id)).toBe('100.4');

    // 31 s without a mark price: the frozen mark is no longer the reference, the last trade is
    await vi.advanceTimersByTimeAsync(2_000);
    expect(market.connection()).toMatchObject({ public: 'connected', staleStreams: [`${id}:mark`], dataAgeMs: 31_000 });
    expect(market.refPrice(id)).toBe('100.5');
    expect(market.markPrice(id)?.markPx).toBe('100.4'); // kept for display
    expect(market.liveMarkPrice(id)).toBeUndefined(); // and never replaced by the last price

    // 91 s without a book frame
    await vi.advanceTimersByTimeAsync(60_000);
    expect(market.connection().staleStreams).toEqual([`${id}:book`, `${id}:mark`]);
    expect(market.book(id)).toBeNull();
    expect(market.estimateMarketFill(id, 'buy', '1')).toBeNull();
    expect(market.bestPrice(id, 'buy')).toBe('101'); // from the ticker, still fresh
    expect(market.bestPrice(id, 'sell')).toBe('100');

    // 121 s without a ticker: nothing fresh is left
    await vi.advanceTimersByTimeAsync(30_000);
    expect(market.connection().staleStreams).toEqual([`${id}:ticker`, `${id}:book`, `${id}:mark`]);
    expect(market.refPrice(id)).toBeUndefined();
    expect(market.bestPrice(id, 'buy')).toBeUndefined();
    expect(market.ticker(id)?.last).toBe('100.5'); // kept for display

    // the streams come back
    pushMark(id, '100.6');
    expect(market.refPrice(id)).toBe('100.6');
    expect(market.connection().staleStreams).toEqual([`${id}:ticker`, `${id}:book`]);
  });

  it('counts the empty keep-alive book frame, but not other streams, as book activity', async () => {
    await boot([id]);
    pub.emit('data', frame(id, 'snapshot', 10, -1));
    for (let t = 0; t < 180_000; t += 10_000) {
      if (t % 60_000 === 0) pushBookKeepAlive(id, 10);
      pushTicker(id);
      pushMark(id);
      await vi.advanceTimersByTimeAsync(10_000);
    }
    expect(market.connection().staleStreams).toEqual([]);
    expect(market.book(id)?.seqId).toBe(10);

    // the book stream stops while ticker and mark price keep flowing on the same socket
    for (let t = 0; t < 100_000; t += 10_000) {
      pushTicker(id);
      pushMark(id);
      await vi.advanceTimersByTimeAsync(10_000);
    }
    expect(market.connection().staleStreams).toEqual([`${id}:book`]);
    expect(market.book(id)).toBeNull();
    expect(market.refPrice(id)).toBe('100.4');
  });

  it('treats every stream as stale while the public socket is down and after it until fresh frames arrive', async () => {
    await boot([id]);
    const statuses: string[][] = [];
    market.on('status', () => statuses.push(market.connection().staleStreams));
    pushTicker(id);
    pushMark(id);
    pub.emit('data', frame(id, 'snapshot', 10, -1));
    await vi.advanceTimersByTimeAsync(1_000);

    pub.drop();
    expect(market.connection().staleStreams).toHaveLength(3);
    expect(statuses[statuses.length - 1]).toHaveLength(3);
    expect(market.refPrice(id)).toBeUndefined();
    expect(market.bestPrice(id, 'sell')).toBeUndefined();
    expect(market.ticker(id)?.last).toBe('100.5');
    expect(market.markPrice(id)?.markPx).toBe('100.4');

    await vi.advanceTimersByTimeAsync(20_000);
    pub.restore();
    // connected again, but the values on hand are from before the outage
    expect(market.connection().staleStreams).toEqual([]);
    expect(market.refPrice(id)).toBeUndefined();
    pushMark(id, '101.1');
    expect(market.refPrice(id)).toBe('101.1');
  });

  it('re-subscribes a stale stream once, then reconnects when that did not help, each with its cooldown', async () => {
    await boot([id]);
    const statuses: string[][] = [];
    market.on('status', () => statuses.push(market.connection().staleStreams));
    pub.emit('data', frame(id, 'snapshot', 10, -1));
    const feed = async (ms: number, mark: boolean): Promise<void> => {
      for (let t = 0; t < ms; t += 5_000) {
        pushTicker(id);
        pushBookKeepAlive(id, 10);
        if (mark) pushMark(id);
        await vi.advanceTimersByTimeAsync(5_000);
      }
    };
    await feed(20_000, true);
    expect(pub.requests).toEqual([]);

    // the mark price stops: stale 30 s later, noticed by the next 5 s check
    await feed(40_000, false);
    expect(ops('mark-price', id)).toEqual(['unsubscribe', 'subscribe']);
    expect(statuses).toEqual([[`${id}:mark`]]);
    expect(pub.reconnectTimes).toHaveLength(0);

    // still silent 60 s after the re-subscribe: one forced reconnect
    await feed(65_000, false);
    expect(pub.reconnectTimes).toHaveLength(1);
    expect(ops('mark-price', id)).toHaveLength(2);

    // 5 minutes after the first re-subscribe the stream is asked for again; no second reconnect inside 10 minutes
    await feed(240_000, false);
    expect(ops('mark-price', id)).toEqual(['unsubscribe', 'subscribe', 'unsubscribe', 'subscribe']);
    await feed(200_000, false);
    expect(pub.reconnectTimes).toHaveLength(1);
    await feed(160_000, false);
    expect(pub.reconnectTimes).toHaveLength(2);
    expect(warnings.length).toBeGreaterThanOrEqual(4);
    expect(pub.requests.every((r) => r.args[0]?.channel === 'mark-price')).toBe(true);

    // it recovers: the flag clears with the first frame
    pushMark(id);
    expect(statuses[statuses.length - 1]).toEqual([]);
  });

  it('reconnects straight away when three or more streams are stale at once', async () => {
    await boot(IDS);
    await vi.advanceTimersByTimeAsync(36_000); // nine mark prices never arrived
    expect(pub.reconnectTimes).toHaveLength(1);
    expect(pub.requests).toEqual([]);
  });

  it('never exceeds 20 re-subscribes and 6 forced reconnects per hour, however much is stale', async () => {
    await boot(IDS);
    await vi.advanceTimersByTimeAsync(3 * 3_600_000);
    expect(market.connection().staleStreams).toHaveLength(27);
    expect(pub.subscribeTimes.length).toBeGreaterThan(20);
    expect(maxPerHour(pub.subscribeTimes)).toBeLessThanOrEqual(20);
    expect(pub.reconnectTimes.length).toBeGreaterThan(6);
    expect(maxPerHour(pub.reconnectTimes)).toBeLessThanOrEqual(6);
    for (let i = 1; i < pub.reconnectTimes.length; i++) {
      expect((pub.reconnectTimes[i] ?? 0) - (pub.reconnectTimes[i - 1] ?? 0)).toBeGreaterThanOrEqual(600_000);
    }
  });

  /** Ticker and mark price keep flowing for `ms`; the book gets nothing. */
  const feedPrices = async (ms: number): Promise<void> => {
    for (let t = 0; t < ms; t += 5_000) {
      pushTicker(id);
      pushMark(id);
      await vi.advanceTimersByTimeAsync(5_000);
    }
  };

  it('counts a resubscribe that brings no snapshot within 10 s as a failed resync and retries under the backoff', async () => {
    await boot([id]);
    pub.emit('data', frame(id, 'snapshot', 10, -1));
    pub.emit('data', frame(id, 'update', 20, 19)); // a gap: resynced at once
    await vi.advanceTimersByTimeAsync(300);
    expect(ops('books', id)).toEqual(['unsubscribe', 'subscribe']);
    expect(market.bookResyncFailures(id)).toBe(1);

    // nothing at all arrives on the fresh subscription: 10 s later that is one more failure, then 1 s, 2 s, 4 s apart
    await feedPrices(10_000);
    expect(market.bookResyncFailures(id)).toBe(2);
    await feedPrices(50_000);
    expect(ops('books', id)).toHaveLength(8);
    expect(market.bookResyncFailures(id)).toBe(5);
    expect(market.connection().staleStreams).toEqual([`${id}:book`]);

    // from the fifth on once a minute; this one gets its snapshot and the book is back
    await feedPrices(50_000);
    expect(ops('books', id)).toHaveLength(10);
    pub.emit('data', frame(id, 'snapshot', 30, -1));
    expect(market.book(id)?.seqId).toBe(30);
    for (let t = 0; t < 35_000; t += 5_000) {
      pushBookKeepAlive(id, 30);
      await feedPrices(5_000);
    }
    expect(market.bookResyncFailures(id)).toBe(0);
    expect(ops('books', id)).toHaveLength(10);
    expect(market.connection().staleStreams).toEqual([]);
    expect(pub.reconnectTimes).toHaveLength(0);
  });

  it('hands a silent book to the watchdog once no resync is scheduled or in flight', async () => {
    await boot([id]);
    pub.emit('data', frame(id, 'snapshot', 10, -1));
    pub.emit('data', frame(id, 'update', 20, 19));
    await vi.advanceTimersByTimeAsync(300);
    expect(market.bookResyncFailures(id)).toBe(1);
    // the socket drops before the snapshot arrives; the reconnect resubscribes the book, which stays silent
    pub.drop();
    pub.restore();
    pub.requests.length = 0;
    await feedPrices(85_000);
    expect(ops('books', id)).toEqual([]);
    await feedPrices(15_000);
    expect(market.connection().staleStreams).toEqual([`${id}:book`]);
    expect(ops('books', id)).toEqual(['unsubscribe', 'subscribe']);
  });

  it('reports a book in resync backoff as stale but leaves it to the resync', async () => {
    await boot([id]);
    for (let t = 0; t < 150_000; t += 500) {
      pushTicker(id);
      pushMark(id);
      pub.emit('data', frame(id, 'update', 2, 1));
      await vi.advanceTimersByTimeAsync(500);
    }
    expect(market.connection().staleStreams).toEqual([`${id}:book`]);
    expect(pub.reconnectTimes).toHaveLength(0);
    // only the resync cadence: 4 quick attempts, then one per minute
    expect(pub.bookRequests()).toBeLessThanOrEqual(2 * 7);
    expect(pub.requests.every((r) => r.args[0]?.channel === 'books')).toBe(true);
  });
});

describe('MarketDataService candle bars', () => {
  it('requests and subscribes the UTC-aligned daily bar and emits it as 1D', async () => {
    const biz = new StubSocket();
    const row = ['1790985600000', '1', '2', '0.5', '1.5', '10', '10', '10', '0'];
    const getCandles = vi.fn(async () => [row]);
    const getHistoryCandles = vi.fn(async () => [row]);
    const log = { debug() {}, info() {}, warn() {}, error() {} } as unknown as Logger;
    const id = 'BTC-USDT-SWAP';
    const clients = { rest: { getInstruments: async () => [rawInst(id)], getCandles, getHistoryCandles }, wsPublic: new StubSocket(), wsBusiness: biz, wsPrivate: null, clock: { offsetMs: 0 }, demo: false } as unknown as OkxClients;
    const market = new MarketDataService(clients, log);
    await market.loadInstruments([id]);
    await market.start();

    await market.fetchCandles(id, '1D', 300);
    expect(getCandles).toHaveBeenCalledWith(id, '1Dutc', { limit: 300 });
    await market.fetchCandles(id, '1W', 100, 1_800_000_000_000);
    expect(getHistoryCandles).toHaveBeenCalledWith(id, '1Wutc', { after: 1_800_000_000_000, limit: 100 });
    await market.fetchCandles(id, '4H', 50);
    expect(getCandles).toHaveBeenLastCalledWith(id, '4H', { limit: 50 });

    await market.subscribeCandles(id, '1D');
    expect(biz.requests).toEqual([{ op: 'subscribe', args: [{ channel: 'candle1Dutc', instId: id }] }]);
    const seen: Array<{ bar: string; ts: number }> = [];
    market.on('candle', (e) => seen.push({ bar: e.bar, ts: e.candle.ts }));
    biz.emit('data', { arg: { channel: 'candle1Dutc', instId: id }, data: [row] } satisfies OkxWsData);
    expect(seen).toEqual([{ bar: '1D', ts: 1790985600000 }]);
    expect(market.candles(id, '1D')).toHaveLength(1);
    // a frame of the UTC+8 day is not the terminal's daily bar
    biz.emit('data', { arg: { channel: 'candle1D', instId: id }, data: [['1790956800000', '1', '2', '0.5', '1.5', '10', '10', '10', '0']] } satisfies OkxWsData);
    expect(seen).toHaveLength(1);
    await market.unsubscribeCandles(id, '1D');
    expect(biz.requests[1]).toEqual({ op: 'unsubscribe', args: [{ channel: 'candle1Dutc', instId: id }] });
    await market.stop();
  });
});
