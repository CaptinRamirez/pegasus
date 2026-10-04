import type { Dec } from '../num.js';
import type { OkxBalance, OkxInstrument, OkxOrder, OkxPosMode, OkxPosition, OkxSide, OkxTrade } from '../wire.js';
import type { Account } from './account.js';
import type { BooksPush, WalkFill } from './book.js';
import type { CandlePush } from './market.js';
import type { OrderStore } from './orders.js';

/** The side of an order book the matching engine fills orders against. */
export interface MatchingBook {
  bestBid(): { px: Dec; sz: Dec } | undefined;
  bestAsk(): { px: Dec; sz: Dec } | undefined;
  /** Total size on the side an order of `side` takes from, within the limit price. */
  available(side: OkxSide, limitPx?: Dec): Dec;
  /** Whether an order of `side` at `limitPx` would trade against the best opposite quote. */
  crosses(side: OkxSide, limitPx: Dec): boolean;
  /** The fills an order of `side` for `sz` gets, never beyond `limitPx`. */
  walk(side: OkxSide, sz: Dec, limitPx?: Dec): WalkFill[];
  /** The public `books` update the fills caused, when the book publishes one. */
  delta(ts: number): BooksPush | null;
}

/**
 * What the matching engine needs from the market of one instrument. The simulator's own MarketSim is one;
 * the paper exchange supplies another that is fed with the real exchange's quotes.
 */
export interface Market {
  readonly inst: OkxInstrument;
  readonly book: MatchingBook;
  readonly markPx: Dec;
  /** Price of the latest print. */
  readonly lastPx: Dec;
  recordTrade(px: Dec, sz: Dec, side: OkxSide, now: number): { trade: OkxTrade };
  liveCandles(): CandlePush[];
  /**
   * How a resting order fills once the book has crossed its price. Absent: it walks the book like a taker
   * (the simulator); the paper exchange fills it at its own limit price.
   */
  restingFills?(side: OkxSide, sz: Dec, limitPx: Dec): WalkFill[];
}

export interface EngineEvents {
  /** Full OkxOrder on every state change (one per fill). */
  order: OkxOrder;
  /** Positions of the affected instrument after a change; a closed one appears once with pos '0'. */
  positions: { instId: string; positions: OkxPosition[] };
  account: OkxBalance;
  /** Incremental `books` update (from a tick or from liquidity consumed by an order). */
  books: { instId: string; push: BooksPush };
  trades: { instId: string; trades: OkxTrade[] };
  candles: { instId: string; candles: CandlePush[] };
  /** Emitted once per instrument per tick after the market moved. */
  tick: { instId: string; seq: number };
}

export type EventName = keyof EngineEvents;
export type Listener<K extends EventName> = (payload: EngineEvents[K]) => void;

/** Everything the matching engine needs from the rest of the simulator. */
export interface EngineContext {
  readonly posMode: OkxPosMode;
  readonly instruments: Map<string, OkxInstrument>;
  readonly markets: Map<string, Market>;
  readonly account: Account;
  readonly orders: OrderStore;
  readonly takerFee: Dec;
  readonly makerFee: Dec;
  now(): number;
  emit<K extends EventName>(event: K, payload: EngineEvents[K]): void;
}

export interface Rejection {
  sCode: string;
  sMsg: string;
}

export function reject(sCode: string, sMsg: string): Rejection {
  return { sCode, sMsg };
}

export function isRejection(x: unknown): x is Rejection {
  return typeof x === 'object' && x !== null && typeof (x as Rejection).sCode === 'string' && typeof (x as Rejection).sMsg === 'string';
}
