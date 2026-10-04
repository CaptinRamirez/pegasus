import { ZERO, d, type CandlePush, type Dec, type Market, type MatchingBook, type OkxInstrument, type OkxSide, type OkxTrade, type WalkFill } from '@pegasus/mock-okx/engine';

interface Level {
  px: Dec;
  sz: Dec;
}

/**
 * The top of the real exchange's order book, as the last `books5` snapshot gave it. Orders are filled against
 * it without consuming it: a paper order takes no real liquidity, and the next snapshot replaces the levels anyway.
 */
export class LiveBook implements MatchingBook {
  /** Best first */
  private bids: Level[] = [];
  private asks: Level[] = [];

  /** Replaces both sides; levels are [price, size, ...] rows, best first, as OKX pushes them. */
  set(bids: readonly (readonly string[])[], asks: readonly (readonly string[])[]): void {
    const side = (rows: readonly (readonly string[])[]): Level[] => rows.map((r) => ({ px: d(r[0] ?? '0'), sz: d(r[1] ?? '0') })).filter((l) => l.px.gt(0) && l.sz.gt(0));
    this.bids = side(bids);
    this.asks = side(asks);
  }

  clear(): void {
    this.bids = [];
    this.asks = [];
  }

  get empty(): boolean {
    return this.bids.length === 0 || this.asks.length === 0;
  }

  bestBid(): Level | undefined {
    return this.bids[0];
  }

  bestAsk(): Level | undefined {
    return this.asks[0];
  }

  private withinLimit(side: OkxSide, px: Dec, limitPx: Dec): boolean {
    return side === 'buy' ? px.lte(limitPx) : px.gte(limitPx);
  }

  available(side: OkxSide, limitPx?: Dec): Dec {
    let total = ZERO;
    for (const l of side === 'buy' ? this.asks : this.bids) {
      if (limitPx && !this.withinLimit(side, l.px, limitPx)) break;
      total = total.add(l.sz);
    }
    return total;
  }

  crosses(side: OkxSide, limitPx: Dec): boolean {
    const top = side === 'buy' ? this.bestAsk() : this.bestBid();
    return top !== undefined && this.withinLimit(side, top.px, limitPx);
  }

  /**
   * A buy takes the asks, a sell the bids, level by level and never beyond `limitPx`. Only five levels are known:
   * what a market order (no limit) needs beyond them is filled at the price of the last one.
   */
  walk(side: OkxSide, sz: Dec, limitPx?: Dec): WalkFill[] {
    const fills: WalkFill[] = [];
    let remaining = sz;
    let lastPx: Dec | undefined;
    for (const l of side === 'buy' ? this.asks : this.bids) {
      if (remaining.lte(0)) break;
      if (limitPx && !this.withinLimit(side, l.px, limitPx)) break;
      const take = remaining.lt(l.sz) ? remaining : l.sz;
      fills.push({ px: l.px, sz: take });
      remaining = remaining.sub(take);
      lastPx = l.px;
    }
    if (remaining.gt(0) && !limitPx && lastPx) fills.push({ px: lastPx, sz: remaining });
    return fills;
  }

  /** Nothing is published: the public book is the real exchange's. */
  delta(): null {
    return null;
  }
}

/**
 * The market of one instrument as the real exchange quotes it: top of book, mark price and last price, set by
 * the feed. While it is not `live` (no quotes yet, or the feed is down) the book is empty, so nothing fills and
 * no stop triggers on a price that is no longer current.
 */
export class LiveMarket implements Market {
  readonly book = new LiveBook();
  private mark: Dec = ZERO;
  private last: Dec = ZERO;
  private seq = 0;
  /** Whether quotes are current: orders are matched and stops checked only then. */
  live = false;

  constructor(readonly inst: OkxInstrument) {}

  get markPx(): Dec {
    return this.mark;
  }

  /** The last traded price; the mark price until the first one arrives. */
  get lastPx(): Dec {
    return this.last.gt(0) ? this.last : this.mark;
  }

  setMark(px: string): void {
    const v = d(px);
    if (v.gt(0)) this.mark = v;
  }

  setLast(px: string): void {
    const v = d(px);
    if (v.gt(0)) this.last = v;
  }

  /** Whether the feed has delivered both a book and a mark price since it (re)connected. */
  get quoted(): boolean {
    return !this.book.empty && this.mark.gt(0);
  }

  /** The feed is down: quotes are no longer current. The mark stays as the last known value for the position display. */
  goOffline(): void {
    this.live = false;
    this.book.clear();
  }

  /** A paper fill is not a print of the real market: it only gets an id, unique across restarts. */
  recordTrade(px: Dec, sz: Dec, side: OkxSide, now: number): { trade: OkxTrade } {
    this.seq = (this.seq + 1) % 1000;
    return { trade: { instId: this.inst.instId, tradeId: `${now}${String(this.seq).padStart(3, '0')}`, px: px.toFixed(), sz: sz.toFixed(), side, count: '1', ts: String(now) } };
  }

  liveCandles(): CandlePush[] {
    return [];
  }

  /**
   * A resting limit order fills in full at its own price once the opposite best quote has reached it. The queue
   * is not modelled: on the real exchange part of it could have stayed unfilled.
   */
  restingFills(_side: OkxSide, sz: Dec, limitPx: Dec): WalkFill[] {
    return [{ px: limitPx, sz }];
  }
}
