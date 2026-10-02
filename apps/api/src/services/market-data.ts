import { EventEmitter } from 'node:events';
import {
  LocalOrderBook,
  OkxApiError,
  type OkxBookData,
  type OkxCandleRow,
  type OkxFundingRate,
  type OkxMarkPrice,
  type OkxTicker,
  type OkxTrade,
  type OkxWsArg,
  type OkxWsData,
} from '@pegasus/okx';
import { D, Decimal, ZERO, type Candle, type CandleBar, type ConnState, type FundingRate, type Instrument, type MarkPrice, type OrderBook, type Side, type Ticker, type Trade } from '@pegasus/shared';
import { UnknownInstrumentError } from '../errors.js';
import type { Logger } from '../logger.js';
import type { OkxClients } from '../okx/clients.js';
import { mapCandle, mapFundingRate, mapInstrument, mapMarkPrice, mapTicker, mapTrade } from '../okx/mappers.js';

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
  resyncing: boolean;
  trades: Trade[];
  candles: Map<CandleBar, Map<number, Candle>>;
  markPrice: MarkPrice | null;
  fundingRate: FundingRate | null;
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

/**
 * Owns the public and business OKX sockets, keeps the latest market state per
 * tracked instrument and re-emits normalised updates for the hub.
 */
export class MarketDataService extends EventEmitter<MarketEvents> {
  readonly instruments = new Map<string, Instrument>();
  private readonly state = new Map<string, InstrumentState>();
  private readonly candleRefs = new Map<string, number>();
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
        if (status !== 'connected') for (const s of this.state.values()) s.book.reset();
        this.emit('status');
      });
      ws.on('ready', () => this.emit('status'));
      ws.on('error', (err) => this.log.warn({ err: err.message }, 'okx socket error'));
    }
    const args: OkxWsArg[] = [];
    for (const instId of this.instruments.keys()) for (const channel of PUBLIC_CHANNELS) args.push({ channel, instId });
    await pub.subscribe(args);
    pub.connect();
    biz.connect();
  }

  async stop(): Promise<void> {
    for (const s of this.state.values()) if (s.bookTimer) clearTimeout(s.bookTimer);
    await Promise.all([this.clients.wsPublic.close(), this.clients.wsBusiness.close()]);
  }

  connection(): { public: ConnState; business: ConnState; lastMessageAgeMs: number } {
    const ageMs = Math.min(this.clients.wsPublic.lastMessageAgeMs, this.clients.wsBusiness.lastMessageAgeMs);
    return {
      public: this.clients.wsPublic.isReady ? 'connected' : this.clients.wsPublic.currentStatus,
      business: this.clients.wsBusiness.isReady ? 'connected' : this.clients.wsBusiness.currentStatus,
      lastMessageAgeMs: Number.isFinite(ageMs) ? Math.round(ageMs) : -1,
    };
  }

  // ---- queries ----

  getInstrument(instId: string): Instrument | undefined {
    return this.instruments.get(instId);
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
    if (!s || !s.book.ready) return null;
    const snap = s.book.snapshot(depth);
    return { instId, bids: snap.bids, asks: snap.asks, ts: snap.ts, seqId: snap.seqId };
  }

  trades(instId: string): Trade[] {
    return this.state.get(instId)?.trades ?? [];
  }

  markPrice(instId: string): MarkPrice | null {
    return this.state.get(instId)?.markPrice ?? null;
  }

  fundingRate(instId: string): FundingRate | null {
    return this.state.get(instId)?.fundingRate ?? null;
  }

  /** Reference price for sizing and risk: mark price, else last trade, else mid. */
  refPrice(instId: string): string | undefined {
    const s = this.state.get(instId);
    if (!s) return undefined;
    if (s.markPrice && D(s.markPrice.markPx).gt(0)) return s.markPrice.markPx;
    if (s.ticker && D(s.ticker.last).gt(0)) return s.ticker.last;
    const bid = s.book.bestBid();
    const ask = s.book.bestAsk();
    if (bid && ask) return D(bid[0]).plus(ask[0]).div(2).toFixed();
    return undefined;
  }

  /** Price a market order would start filling at: best ask for buys, best bid for sells. */
  bestPrice(instId: string, side: Side): string | undefined {
    const s = this.state.get(instId);
    if (!s) return undefined;
    const lvl = side === 'buy' ? s.book.bestAsk() : s.book.bestBid();
    if (lvl) return lvl[0];
    if (s.ticker) return side === 'buy' ? s.ticker.askPx || undefined : s.ticker.bidPx || undefined;
    return undefined;
  }

  /** Walk the visible book to estimate the average fill price of a market order. */
  estimateMarketFill(instId: string, side: Side, contracts: string): MarketFillEstimate | null {
    const s = this.state.get(instId);
    if (!s || !s.book.ready) return null;
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
      rows = await this.clients.rest.getCandles(instId, bar, { limit: Math.min(limit, 300) });
    } else {
      // history-candles returns at most 100 per call; `after` = "older than" in OKX's pagination
      rows = await this.clients.rest.getHistoryCandles(instId, bar, { after: before, limit: Math.min(limit, 100) });
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
        await this.clients.wsBusiness.subscribe([{ channel: `candle${bar}`, instId }]);
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
      await this.clients.wsBusiness.unsubscribe([{ channel: `candle${bar}`, instId }]).catch(() => undefined);
    } else {
      this.candleRefs.set(key, n);
    }
  }

  // ---- internals ----

  private ensureState(instId: string): InstrumentState {
    let s = this.state.get(instId);
    if (!s) {
      s = { ticker: null, book: new LocalOrderBook(instId), bookDirty: false, bookTimer: null, resyncing: false, trades: [], candles: new Map(), markPrice: null, fundingRate: null };
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
        this.emit('ticker', s.ticker);
        return;
      }
      case 'books': {
        for (const d of msg.data as OkxBookData[]) {
          const err = s.book.apply(msg.action, d);
          if (err) {
            this.log.warn({ instId, err }, 'order book out of sync; resubscribing');
            void this.resyncBook(instId, s);
            return;
          }
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
    const bar = channel.slice('candle'.length) as CandleBar;
    const s = this.state.get(instId);
    if (!s) return;
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

  private async resyncBook(instId: string, s: InstrumentState): Promise<void> {
    if (s.resyncing) return;
    s.resyncing = true;
    s.book.reset();
    const arg: OkxWsArg = { channel: 'books', instId };
    try {
      await this.clients.wsPublic.unsubscribe([arg]);
      await new Promise((r) => setTimeout(r, 200));
      await this.clients.wsPublic.subscribe([arg]);
    } catch (err) {
      const message = err instanceof OkxApiError ? err.message : (err as Error).message;
      this.log.warn({ instId, err: message }, 'book resubscribe failed; it will be retried on the next reconnect');
    } finally {
      s.resyncing = false;
    }
  }
}
