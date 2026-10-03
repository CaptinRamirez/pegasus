import type { Dec } from '../num.js';
import type { OkxBalance, OkxInstrument, OkxOrder, OkxPosMode, OkxPosition, OkxTrade } from '../wire.js';
import type { Account } from './account.js';
import type { BooksPush } from './book.js';
import type { CandlePush, MarketSim } from './market.js';
import type { OrderStore } from './orders.js';

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
  readonly markets: Map<string, MarketSim>;
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
