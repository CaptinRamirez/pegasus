import { EventEmitter } from 'node:events';
import {
  LocalOrderBook,
  type OkxBookData,
  type OkxCandleRow,
  type OkxFundingRate,
  type OkxMarkPrice,
  type OkxTicker,
  type OkxTrade,
  type OkxWsArg,
  type OkxWsData,
} from '@pegasus/okx';
import { D, Decimal, ZERO, type Candle, type CandleBar, type ConnState, type FundingRate, type Instrument, type MarkPrice, type MarketStream, type OrderBook, type Side, type Ticker, type Trade } from '@pegasus/shared';
import { UnknownInstrumentError } from '../errors.js';
import type { Logger } from '../logger.js';
import type { OkxClients } from '../okx/clients.js';
import { fromOkxBar, mapCandle, mapFundingRate, mapInstrument, mapMarkPrice, mapTicker, mapTrade, toOkxBar } from '../okx/mappers.js';

export interface MarketEvents {
  ticker: [Ticker];
  book: [OrderBook];
  trades: [Trade[]];
  candle: [{ instId: string; bar: CandleBar; candle: Candle }];
  markPrice: [MarkPrice];
  fundingRate: [FundingRate];
  status: [];
}

interface InstrumentState {
  ticker: Ticker | null;
  book: LocalOrderBook;
  bookDirty: boolean;
  bookTimer: NodeJS.Timeout | null;
  /**
   * idle: the book follows the feed. waiting: a resync is scheduled (backoff). settling: unsubscribed,
   * about to subscribe again. subscribing: the fresh subscription was requested and its frames are applied.
   */
  resync: 'idle' | 'waiting' | 'settling' | 'subscribing';
  resyncTimer: NodeJS.Timeout | null;
  /** Consecutive resyncs without the book staying in sync for RESYNC_HEALTHY_MS in between. */
  resyncFailures: number;
  healthyTimer: NodeJS.Timeout | null;
  /** Runs from the resubscribe of a resync until the book has its snapshot. */
  snapshotTimer: NodeJS.Timeout | null;
  trades: Trade[];
  candles: Map<CandleBar, Map<number, Candle>>;
  markPrice: MarkPrice | null;
  fundingRate: FundingRate | null;
  /** Local receive time of the last frame per watched stream (not the exchange timestamp); 0 = nothing yet. */
  lastAt: Record<MarketStream, number>;
}

export interface MarketFillEstimate {
  /** Volume-weighted average fill price */
  avgPx: string;
  worstPx: string;
  filledContracts: string;
  /** Fraction between avg fill price and the best price on that side, e.g. "0.0012" */
  slippagePct: string;
  /** false when the visible book cannot absorb the whole order */
  complete: boolean;
}

const TRADES_KEEP = 100;
const CANDLES_KEEP = 600;
const PUBLIC_CHANNELS = ['tickers', 'books', 'trades', 'mark-price', 'funding-rate'] as const;
// Book resync backoff. OKX allows 480 subscribe/unsubscribe/login requests per hour per connection and
// each resync costs two, so a book that never syncs must not be re-requested in a tight loop.
const RESYNC_BASE_MS = 1_000;
const RESYNC_MAX_MS = 60_000;
const RESYNC_SETTLE_MS = 200;
const RESYNC_HEALTHY_MS = 30_000;
/** A resubscribed book that has no snapshot after this long counts as one more failed resync. */
const RESYNC_SNAPSHOT_MS = 10_000;
const RESYNC_ESCALATE_AFTER = 5;
/** Resyncs allowed per rolling hour across all instruments (200 of the 480 requests), leaving room for reconnects. */
const RESYNC_BUDGET_PER_HOUR = 100;
const HOUR_MS = 3_600_000;
// Stale-stream watchdog. A stream is stale when the public socket is ready and nothing arrived for this long.
// OKX pushes the mark price at least every 10 s even when unchanged and an empty `books` frame about every
// 60 s for a book that does not change; tickers have no keep-alive and a quiet market can go silent for a while.
const STREAMS: readonly MarketStream[] = ['ticker', 'book', 'mark'];
const STALE_AFTER_MS: Record<MarketStream, number> = { mark: 30_000, book: 90_000, ticker: 120_000 };
const STREAM_CHANNEL: Record<MarketStream, string> = { ticker: 'tickers', book: 'books', mark: 'mark-price' };
const WATCHDOG_MS = 5_000;
const RESUB_COOLDOWN_MS = 300_000;
/** A stream still silent this long after its re-subscribe means the connection itself is suspect. */
const RESUB_VERIFY_MS = 60_000;
const RESUB_BUDGET_PER_HOUR = 20;
const RECONNECT_STALE_STREAMS = 3;
const RECONNECT_MIN_GAP_MS = 600_000;
const RECONNECT_BUDGET_PER_HOUR = 6;

/**
 * Owns the public and business OKX sockets, keeps the latest market state per
 * tracked instrument and re-emits normalised updates for the hub.
 */
export class MarketDataService extends EventEmitter<MarketEvents> {
  readonly instruments = new Map<string, Instrument>();
  /** Specs of every SWAP the exchange lists: the account can hold orders in instruments this server does not track. */
  private readonly swapSpecs = new Map<string, Instrument>();
  private readonly state = new Map<string, InstrumentState>();
  private readonly candleRefs = new Map<string, number>();
  /** Start times of the book resyncs of the last hour, oldest first. */
  private readonly resyncLog: number[] = [];
  /** When the public socket last became ready; a stream gets its full threshold from then on. */
  private publicReadyAt = 0;
  private watchdogTimer: NodeJS.Timeout | null = null;
  /** The stale set as last announced through `status`. */
  private announcedStale = new Set<string>();
  /** Time of the watchdog's last re-subscribe per stream key. */
  private readonly resubAt = new Map<string, number>();
  /** Watchdog re-subscribes / forced reconnects of the last hour, oldest first. */
  private readonly resubLog: number[] = [];
  private readonly reconnectLog: number[] = [];
  private started = false;

  constructor(
    private readonly clients: OkxClients,
    private readonly log: Logger,
    private readonly opts: { bookDepth: number; bookThrottleMs: number } = { bookDepth: 50, bookThrottleMs: 100 },
  ) {
    super();
  }

  // ---- lifecycle ----

  async loadInstruments(instIds: string[]): Promise<void> {
    const all = await this.clients.rest.getInstruments('SWAP');
    const byId = new Map(all.map((i) => [i.instId, i]));
    for (const raw of all) this.swapSpecs.set(raw.instId, mapInstrument(raw));
    const missing: string[] = [];
    for (const id of instIds) {
      const raw = byId.get(id);
      if (!raw) {
        missing.push(id);
        continue;
      }
      const inst = mapInstrument(raw);
      this.instruments.set(id, inst);
      this.ensureState(id);
    }
    if (missing.length > 0) throw new Error(`unknown OKX SWAP instruments: ${missing.join(', ')}`);
  }

  async start(): Promise<void> {
    if (this.started) return;
    this.started = true;
    const pub = this.clients.wsPublic;
    const biz = this.clients.wsBusiness;
    pub.on('data', (msg) => this.onPublicData(msg));
    biz.on('data', (msg) => this.onBusinessData(msg));
    for (const ws of [pub, biz]) {
      ws.on('status', (status, detail) => {
        this.log.info({ ws: ws === pub ? 'public' : 'business', status, detail }, 'okx socket status');
        // Books are fed by the public socket only; a business (candles) reconnect must not wipe them.
        if (ws === pub && status !== 'connected') for (const s of this.state.values()) this.onPublicDown(s);
        this.refreshStale();
        this.emit('status');
      });
      ws.on('ready', () => {
        if (ws === pub) this.publicReadyAt = Date.now();
        this.refreshStale();
        this.emit('status');
      });
      ws.on('error', (err) => this.log.warn({ err: err.message }, 'okx socket error'));
    }
    const args: OkxWsArg[] = [];
    for (const instId of this.instruments.keys()) for (const channel of PUBLIC_CHANNELS) args.push({ channel, instId });
    await pub.subscribe(args);
    if (pub.isReady) this.publicReadyAt = Date.now();
    this.refreshStale();
    this.watchdogTimer = setInterval(() => this.watchdog(), WATCHDOG_MS);
    this.watchdogTimer.unref();
    pub.connect();
    biz.connect();
  }

  async stop(): Promise<void> {
    if (this.watchdogTimer) clearInterval(this.watchdogTimer);
    this.watchdogTimer = null;
    for (const s of this.state.values()) {
      if (s.bookTimer) clearTimeout(s.bookTimer);
      if (s.resyncTimer) clearTimeout(s.resyncTimer);
      if (s.healthyTimer) clearTimeout(s.healthyTimer);
      if (s.snapshotTimer) clearTimeout(s.snapshotTimer);
      s.bookTimer = null;
      s.resyncTimer = null;
      s.healthyTimer = null;
      s.snapshotTimer = null;
    }
    await Promise.all([this.clients.wsPublic.close(), this.clients.wsBusiness.close()]);
  }

  connection(): { public: ConnState; business: ConnState; dataAgeMs: number; staleStreams: string[] } {
    const now = Date.now();
    // Pongs and the other streams keep a socket "alive"; only the age of each stream's own data says whether it is.
    let oldest = Number.POSITIVE_INFINITY;
    for (const s of this.state.values()) for (const stream of STREAMS) if (s.lastAt[stream] > 0) oldest = Math.min(oldest, s.lastAt[stream]);
    return {
      public: this.clients.wsPublic.isReady ? 'connected' : this.clients.wsPublic.currentStatus,
      business: this.clients.wsBusiness.isReady ? 'connected' : this.clients.wsBusiness.currentStatus,
      dataAgeMs: Number.isFinite(oldest) ? now - oldest : -1,
      staleStreams: this.staleStreams(now),
    };
  }

  // ---- queries ----

  getInstrument(instId: string): Instrument | undefined {
    return this.instruments.get(instId);
  }

  /** Contract spec of any SWAP known at startup, tracked or not; for valuing orders, never for market data. */
  specOf(instId: string): Instrument | undefined {
    return this.instruments.get(instId) ?? this.swapSpecs.get(instId);
  }

  requireInstrument(instId: string): Instrument {
    const inst = this.instruments.get(instId);
    if (!inst) throw new UnknownInstrumentError(instId);
    return inst;
  }

  ticker(instId: string): Ticker | null {
    return this.state.get(instId)?.ticker ?? null;
  }

  book(instId: string, depth = this.opts.bookDepth): OrderBook | null {
    const s = this.state.get(instId);
    if (!s || !s.book.ready || !this.isLive(s, 'book')) return null;
    const snap = s.book.snapshot(depth);
    return { instId, bids: snap.bids, asks: snap.asks, ts: snap.ts, seqId: snap.seqId };
  }

  /** Consecutive failed order-book resyncs for the instrument; 0 while the book is healthy. */
  bookResyncFailures(instId: string): number {
    return this.state.get(instId)?.resyncFailures ?? 0;
  }

  trades(instId: string): Trade[] {
    return this.state.get(instId)?.trades ?? [];
  }

  markPrice(instId: string): MarkPrice | null {
    return this.state.get(instId)?.markPrice ?? null;
  }

  /** The mark price while its stream is live; unlike refPrice it never falls back to the last price or the book. */
  liveMarkPrice(instId: string): string | undefined {
    const s = this.state.get(instId);
    return s?.markPrice && this.isLive(s, 'mark') && D(s.markPrice.markPx).gt(0) ? s.markPrice.markPx : undefined;
  }

  fundingRate(instId: string): FundingRate | null {
    return this.state.get(instId)?.fundingRate ?? null;
  }

  /**
   * Reference price for sizing and risk: mark price, else last trade, else mid. Only live streams count;
   * with none left the caller gets undefined and refuses the order rather than check it against a frozen price.
   */
  refPrice(instId: string): string | undefined {
    const s = this.state.get(instId);
    if (!s) return undefined;
    if (s.markPrice && this.isLive(s, 'mark') && D(s.markPrice.markPx).gt(0)) return s.markPrice.markPx;
    if (s.ticker && this.isLive(s, 'ticker') && D(s.ticker.last).gt(0)) return s.ticker.last;
    if (!this.isLive(s, 'book')) return undefined;
    const bid = s.book.bestBid();
    const ask = s.book.bestAsk();
    if (bid && ask) return D(bid[0]).plus(ask[0]).div(2).toFixed();
    return undefined;
  }

  /** Price a market order would start filling at: best ask for buys, best bid for sells. Live streams only. */
  bestPrice(instId: string, side: Side): string | undefined {
    const s = this.state.get(instId);
    if (!s) return undefined;
    const lvl = !this.isLive(s, 'book') ? undefined : side === 'buy' ? s.book.bestAsk() : s.book.bestBid();
    if (lvl) return lvl[0];
    if (s.ticker && this.isLive(s, 'ticker')) return side === 'buy' ? s.ticker.askPx || undefined : s.ticker.bidPx || undefined;
    return undefined;
  }

  /** Walk the visible book to estimate the average fill price of a market order. */
  estimateMarketFill(instId: string, side: Side, contracts: string): MarketFillEstimate | null {
    const s = this.state.get(instId);
    if (!s || !s.book.ready || !this.isLive(s, 'book')) return null;
    const levels = side === 'buy' ? s.book.topAsks(400) : s.book.topBids(400);
    const best = levels[0];
    if (!best) return null;
    let remaining = D(contracts);
    let cost = ZERO;
    let filled = ZERO;
    let worst = D(best[0]);
    for (const [px, sz] of levels) {
      if (remaining.lte(0)) break;
      const take = Decimal.min(remaining, D(sz));
      cost = cost.plus(take.mul(px));
      filled = filled.plus(take);
      remaining = remaining.minus(take);
      worst = D(px);
    }
    if (filled.lte(0)) return null;
    const avg = cost.div(filled);
    const slippage = avg.minus(best[0]).abs().div(best[0]);
    return { avgPx: avg.toFixed(), worstPx: worst.toFixed(), filledContracts: filled.toFixed(), slippagePct: slippage.toFixed(), complete: remaining.lte(0) };
  }

  candles(instId: string, bar: CandleBar): Candle[] {
    const m = this.state.get(instId)?.candles.get(bar);
    if (!m) return [];
    return [...m.values()].sort((a, b) => a.ts - b.ts);
  }

  /** Fetch candles from REST, oldest first. `before` returns candles older than that timestamp. */
  async fetchCandles(instId: string, bar: CandleBar, limit = 300, before?: number): Promise<Candle[]> {
    this.requireInstrument(instId);
    let rows: OkxCandleRow[];
    if (before === undefined) {
      rows = await this.clients.rest.getCandles(instId, toOkxBar(bar), { limit: Math.min(limit, 300) });
    } else {
      // history-candles returns at most 100 per call; `after` = "older than" in OKX's pagination
      rows = await this.clients.rest.getHistoryCandles(instId, toOkxBar(bar), { after: before, limit: Math.min(limit, 100) });
    }
    const candles = rows.map(mapCandle).sort((a, b) => a.ts - b.ts);
    const s = this.ensureState(instId);
    const cache = this.candleCache(s, bar);
    for (const c of candles) if (!cache.has(c.ts) || !cache.get(c.ts)?.confirm) cache.set(c.ts, c);
    return candles;
  }

  // ---- candle subscriptions (reference counted by the hub) ----

  async subscribeCandles(instId: string, bar: CandleBar): Promise<void> {
    this.requireInstrument(instId);
    const key = `${instId}:${bar}`;
    const n = (this.candleRefs.get(key) ?? 0) + 1;
    this.candleRefs.set(key, n);
    if (n === 1) {
      try {
        await this.clients.wsBusiness.subscribe([{ channel: `candle${toOkxBar(bar)}`, instId }]);
      } catch (err) {
        this.log.warn({ err: (err as Error).message, instId, bar }, 'candle subscribe failed (will retry on reconnect)');
      }
    }
  }

  async unsubscribeCandles(instId: string, bar: CandleBar): Promise<void> {
    const key = `${instId}:${bar}`;
    const n = (this.candleRefs.get(key) ?? 0) - 1;
    if (n <= 0) {
      this.candleRefs.delete(key);
      await this.clients.wsBusiness.unsubscribe([{ channel: `candle${toOkxBar(bar)}`, instId }]).catch(() => undefined);
    } else {
      this.candleRefs.set(key, n);
    }
  }

  // ---- internals ----

  private ensureState(instId: string): InstrumentState {
    let s = this.state.get(instId);
    if (!s) {
      s = { ticker: null, book: new LocalOrderBook(instId), bookDirty: false, bookTimer: null, resync: 'idle', resyncTimer: null, resyncFailures: 0, healthyTimer: null, snapshotTimer: null, trades: [], candles: new Map(), markPrice: null, fundingRate: null, lastAt: { ticker: 0, book: 0, mark: 0 } };
      this.state.set(instId, s);
    }
    return s;
  }

  private candleCache(s: InstrumentState, bar: CandleBar): Map<number, Candle> {
    let m = s.candles.get(bar);
    if (!m) {
      m = new Map();
      s.candles.set(bar, m);
    }
    return m;
  }

  private onPublicData(msg: OkxWsData): void {
    const instId = msg.arg.instId;
    if (!instId) return;
    const s = this.state.get(instId);
    if (!s) return;
    switch (msg.arg.channel) {
      case 'tickers': {
        const last = msg.data[msg.data.length - 1] as OkxTicker | undefined;
        if (!last) return;
        s.ticker = mapTicker(last);
        this.touch(instId, s, 'ticker');
        this.emit('ticker', s.ticker);
        return;
      }
      case 'books': {
        // Frames of the subscription being torn down are dropped; the fresh one starts with its own snapshot.
        if (s.resync === 'waiting' || s.resync === 'settling') return;
        for (const d of msg.data as OkxBookData[]) {
          const err = s.book.apply(msg.action, d);
          if (err) {
            this.bookOutOfSync(instId, s, err);
            return;
          }
        }
        this.touch(instId, s, 'book');
        if (s.snapshotTimer && s.book.ready) this.clearSnapshotTimer(s);
        if (s.resyncFailures > 0 && !s.healthyTimer) {
          s.healthyTimer = setTimeout(() => {
            s.healthyTimer = null;
            s.resyncFailures = 0;
          }, RESYNC_HEALTHY_MS);
        }
        this.scheduleBookEmit(instId, s);
        return;
      }
      case 'trades': {
        const trades = (msg.data as OkxTrade[]).map(mapTrade);
        s.trades.push(...trades);
        if (s.trades.length > TRADES_KEEP) s.trades.splice(0, s.trades.length - TRADES_KEEP);
        this.emit('trades', trades);
        return;
      }
      case 'mark-price': {
        const last = msg.data[msg.data.length - 1] as OkxMarkPrice | undefined;
        if (!last) return;
        s.markPrice = mapMarkPrice(last);
        this.touch(instId, s, 'mark');
        this.emit('markPrice', s.markPrice);
        return;
      }
      case 'funding-rate': {
        const last = msg.data[msg.data.length - 1] as OkxFundingRate | undefined;
        if (!last) return;
        s.fundingRate = mapFundingRate(last);
        this.emit('fundingRate', s.fundingRate);
        return;
      }
      default:
        return;
    }
  }

  private onBusinessData(msg: OkxWsData): void {
    const instId = msg.arg.instId;
    const channel = msg.arg.channel;
    if (!instId || !channel.startsWith('candle')) return;
    const bar = fromOkxBar(channel.slice('candle'.length));
    const s = this.state.get(instId);
    if (!s || bar === null) return;
    const cache = this.candleCache(s, bar);
    for (const row of msg.data as OkxCandleRow[]) {
      const candle = mapCandle(row);
      cache.set(candle.ts, candle);
      this.emit('candle', { instId, bar, candle });
    }
    if (cache.size > CANDLES_KEEP) {
      const keys = [...cache.keys()].sort((a, b) => a - b).slice(0, cache.size - CANDLES_KEEP);
      for (const k of keys) cache.delete(k);
    }
  }

  private scheduleBookEmit(instId: string, s: InstrumentState): void {
    s.bookDirty = true;
    if (s.bookTimer) return;
    s.bookTimer = setTimeout(() => {
      s.bookTimer = null;
      if (!s.bookDirty) return;
      s.bookDirty = false;
      const book = this.book(instId);
      if (book) this.emit('book', book);
    }, this.opts.bookThrottleMs);
  }

  /**
   * The book can no longer be trusted: drop it and schedule a resync. The first one after a healthy
   * period is immediate, further consecutive ones wait 1 s, 2 s, 4 s; from the fifth on the book is
   * reported unavailable and retried once a minute.
   */
  private bookOutOfSync(instId: string, s: InstrumentState, err: string): void {
    s.book.reset();
    if (s.healthyTimer) clearTimeout(s.healthyTimer);
    s.healthyTimer = null;
    this.clearSnapshotTimer(s);
    // A resync already under way picks this up: once it finishes, the next bad frame schedules another.
    if (s.resync !== 'idle') return;
    const failures = ++s.resyncFailures;
    let delay = failures === 1 ? 0 : Math.min(RESYNC_MAX_MS, RESYNC_BASE_MS * 2 ** (failures - 2));
    if (failures >= RESYNC_ESCALATE_AFTER) delay = RESYNC_MAX_MS;
    if (failures === RESYNC_ESCALATE_AFTER) {
      this.log.error({ instId, err, failures }, `order book unavailable: it fell out of sync ${failures} times in a row; retrying every ${RESYNC_MAX_MS / 1000} s`);
    } else {
      this.log.warn({ instId, err, failures, retryInMs: delay }, 'order book out of sync; resubscribing');
    }
    this.scheduleResync(instId, s, delay);
  }

  private scheduleResync(instId: string, s: InstrumentState, delayMs: number): void {
    s.resync = 'waiting';
    s.resyncTimer = setTimeout(() => {
      s.resyncTimer = null;
      void this.resyncBook(instId, s);
    }, delayMs);
  }

  private async resyncBook(instId: string, s: InstrumentState): Promise<void> {
    const now = Date.now();
    while (this.resyncLog[0] !== undefined && now - this.resyncLog[0] >= HOUR_MS) this.resyncLog.shift();
    const oldest = this.resyncLog[0];
    if (oldest !== undefined && this.resyncLog.length >= RESYNC_BUDGET_PER_HOUR) {
      // Many books failing at once: wait for the hourly request budget rather than hit the exchange limit.
      this.scheduleResync(instId, s, oldest + HOUR_MS - now);
      return;
    }
    this.resyncLog.push(now);
    const arg: OkxWsArg = { channel: 'books', instId };
    try {
      s.resync = 'settling';
      await this.clients.wsPublic.unsubscribe([arg]);
      await new Promise<void>((resolve) => {
        s.resyncTimer = setTimeout(resolve, RESYNC_SETTLE_MS);
      });
      s.resyncTimer = null;
      s.resync = 'subscribing';
      await this.clients.wsPublic.subscribe([arg]);
      s.resync = 'idle';
      // A subscription that delivers nothing sends no bad frame either: without this the book would be given up on.
      if (!s.book.ready) {
        s.snapshotTimer = setTimeout(() => {
          s.snapshotTimer = null;
          if (!s.book.ready) this.bookOutOfSync(instId, s, `no snapshot within ${RESYNC_SNAPSHOT_MS / 1000} s of the resubscribe`);
        }, RESYNC_SNAPSHOT_MS);
      }
    } catch (err) {
      s.resync = 'idle';
      // Counts as one more failed attempt, so the retry runs under the same backoff. A book that
      // synced anyway (only the acknowledgement went missing) is left alone.
      if (!s.book.ready) this.bookOutOfSync(instId, s, `resubscribe failed: ${(err as Error).message}`);
    }
  }

  private clearSnapshotTimer(s: InstrumentState): void {
    if (s.snapshotTimer) clearTimeout(s.snapshotTimer);
    s.snapshotTimer = null;
  }

  /** The public socket dropped: its reconnect resubscribes every book, so a resync that has not started yet is moot. */
  private onPublicDown(s: InstrumentState): void {
    s.book.reset();
    if (s.healthyTimer) clearTimeout(s.healthyTimer);
    s.healthyTimer = null;
    this.clearSnapshotTimer(s);
    if (s.resync === 'waiting') {
      if (s.resyncTimer) clearTimeout(s.resyncTimer);
      s.resyncTimer = null;
      s.resync = 'idle';
    }
  }

  // ---- stale streams ----

  /** A book whose resync is backing off after repeated failures. */
  private bookInBackoff(s: InstrumentState): boolean {
    return s.resync !== 'idle' && s.resyncFailures > 1;
  }

  private isStale(s: InstrumentState, stream: MarketStream, now = Date.now()): boolean {
    if (!this.clients.wsPublic.isReady) return true;
    if (stream === 'book' && this.bookInBackoff(s)) return true;
    return now - Math.max(s.lastAt[stream], this.publicReadyAt) > STALE_AFTER_MS[stream];
  }

  /**
   * Whether the stream's last value may be used as a current price: it arrived on the present connection
   * and the stream is not stale. Values from before a reconnect are display-only until a fresh frame replaces them.
   */
  private isLive(s: InstrumentState, stream: MarketStream): boolean {
    const at = s.lastAt[stream];
    return at > 0 && at >= this.publicReadyAt && !this.isStale(s, stream);
  }

  private staleStreams(now: number): string[] {
    const out: string[] = [];
    for (const [instId, s] of this.state) for (const stream of STREAMS) if (this.isStale(s, stream, now)) out.push(`${instId}:${stream}`);
    return out;
  }

  /** Recompute the stale set; true when it differs from the one last announced. */
  private refreshStale(): boolean {
    const next = new Set(this.staleStreams(Date.now()));
    const changed = next.size !== this.announcedStale.size || [...next].some((k) => !this.announcedStale.has(k));
    this.announcedStale = next;
    return changed;
  }

  /** A frame of the stream arrived; a stream announced as stale is reported as recovered at once. */
  private touch(instId: string, s: InstrumentState, stream: MarketStream): void {
    s.lastAt[stream] = Date.now();
    if (this.announcedStale.has(`${instId}:${stream}`) && this.refreshStale()) this.emit('status');
  }

  /**
   * Every WATCHDOG_MS: announce changes of the stale set and try to revive stale streams, first by
   * re-subscribing the one channel, then by reconnecting the public socket. Both are capped per hour
   * (subscription requests are rate limited by the exchange); past the caps streams are only flagged.
   */
  private watchdog(): void {
    const now = Date.now();
    if (this.clients.wsPublic.isReady) {
      const stale: Array<{ instId: string; stream: MarketStream; key: string; resubAt: number | undefined; unanswered: boolean }> = [];
      for (const [instId, s] of this.state) {
        for (const stream of STREAMS) {
          if (!this.isStale(s, stream, now)) continue;
          // A book whose resync is scheduled, in flight or waiting for its snapshot belongs to the resync above;
          // re-subscribing it here would bypass its backoff. Any other silent book is this watchdog's to revive.
          if (stream === 'book' && (s.resync !== 'idle' || s.snapshotTimer !== null)) continue;
          const key = `${instId}:${stream}`;
          const resubAt = this.resubAt.get(key);
          stale.push({ instId, stream, key, resubAt, unanswered: resubAt !== undefined && now - resubAt >= RESUB_VERIFY_MS && s.lastAt[stream] < resubAt });
        }
      }
      const unanswered = stale.find((x) => x.unanswered);
      let reconnected = false;
      if (stale.length >= RECONNECT_STALE_STREAMS) reconnected = this.forceReconnect(now, `${stale.length} streams stale`);
      else if (unanswered) reconnected = this.forceReconnect(now, `${unanswered.key} still stale after its re-subscribe`);
      if (!reconnected) {
        for (const x of stale) {
          if (x.resubAt !== undefined && now - x.resubAt < RESUB_COOLDOWN_MS) continue;
          while (this.resubLog[0] !== undefined && now - this.resubLog[0] >= HOUR_MS) this.resubLog.shift();
          if (this.resubLog.length >= RESUB_BUDGET_PER_HOUR) break;
          this.resubLog.push(now);
          this.resubAt.set(x.key, now);
          this.resubscribeStream(x.instId, x.stream);
        }
      }
    }
    if (this.refreshStale()) this.emit('status');
  }

  private resubscribeStream(instId: string, stream: MarketStream): void {
    this.log.warn({ instId, stream, resubscribesLastHour: this.resubLog.length, limit: RESUB_BUDGET_PER_HOUR }, 'market data stream stale; resubscribing it');
    const arg: OkxWsArg = { channel: STREAM_CHANNEL[stream], instId };
    const pub = this.clients.wsPublic;
    pub
      .unsubscribe([arg])
      .then(() => pub.subscribe([arg]))
      .catch((err: unknown) => this.log.warn({ err: (err as Error).message, instId, stream }, 'stale stream resubscribe failed'));
  }

  /** Reconnect the public socket unless one was forced in the last RECONNECT_MIN_GAP_MS or the hourly cap is used up. */
  private forceReconnect(now: number, reason: string): boolean {
    while (this.reconnectLog[0] !== undefined && now - this.reconnectLog[0] >= HOUR_MS) this.reconnectLog.shift();
    const last = this.reconnectLog[this.reconnectLog.length - 1];
    if (last !== undefined && now - last < RECONNECT_MIN_GAP_MS) return false;
    if (this.reconnectLog.length >= RECONNECT_BUDGET_PER_HOUR) return false;
    this.reconnectLog.push(now);
    this.log.warn({ reason, reconnectsLastHour: this.reconnectLog.length, limit: RECONNECT_BUDGET_PER_HOUR }, 'market data stale; reconnecting the public socket');
    this.clients.wsPublic.reconnect(reason);
    return true;
  }
}
