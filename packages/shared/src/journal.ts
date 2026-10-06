import type { OrderSource, SignalSnapshot, TakeProfitLeg, TrailingExit } from './schemas.js';
import type { OrdType, PosSide, Side, TdMode } from './types.js';

/**
 * The trade journal: what the API's journal service (apps/api/src/services/journal.ts) records about every trade of
 * the account, and how GET /api/journal, GET /api/journal/:id and the `journal` WebSocket message give it.
 *
 * A trade is one position's life on one instrument, margin mode and position leg (net in net mode, long or short in
 * long/short mode), from flat to flat: the opening fills, the adds and partial closes, and the final close or a
 * liquidation. Prices and money are decimal strings, in the instrument's settlement currency (USDT for the USDT
 * swaps); sizes are contracts unless the name says coin. Times are epoch ms: of fills and orders the exchange's, of
 * events the journal saw itself (an algo order read, a reconcile) the server's.
 */

/**
 * Who opened the trade, from the order of its first fill:
 * - campaign: the campaign service's orders (client order id starting with `pc`);
 * - signal / manual: an order Pegasus placed, as the request said (`source`, 'manual' when absent); after a restart,
 *   for an order whose request the journal had not seen, the client order id tells (`ps` signal, `pg` manual);
 * - external: an order not placed through Pegasus (OKX's app or website, another program), and a position the journal
 *   found open without having seen it open.
 */
export type TradeSource = OrderSource | 'campaign' | 'external';
export const TRADE_SOURCES: readonly TradeSource[] = ['manual', 'signal', 'campaign', 'external'] as const;

/** Client order id prefixes that tell where an order comes from (see sourceOfClOrdId). */
export const CL_ORD_PREFIXES = { campaign: 'pc', signal: 'ps', pegasus: 'pg' } as const;

/**
 * Where an order comes from by its client order id alone: `pc` the campaign, `ps` a signal followed from the terminal,
 * `pg` anything else Pegasus placed (the ticket, a close button); anything else is external. The request of an order
 * Pegasus placed says more (its `source`) and wins over the prefix, except for the campaign's.
 */
export function sourceOfClOrdId(clOrdId: string): TradeSource {
  if (clOrdId.startsWith(CL_ORD_PREFIXES.campaign)) return 'campaign';
  if (clOrdId.startsWith(CL_ORD_PREFIXES.signal)) return 'signal';
  if (clOrdId.startsWith(CL_ORD_PREFIXES.pegasus)) return 'manual';
  return 'external';
}

export type TradeStatus = 'open' | 'closed';

/**
 * Why contracts of a trade were closed:
 * - take_profit: a take-profit algo order triggered (`leg` says which, 1-based);
 * - stop: a stop-loss algo order triggered;
 * - trailing: a trailing exit triggered: the stop of a trade whose plan has a channel trailing exit once that stop was
 *   moved (or was placed after the opening), or, for a callback trailing exit, a close by the exchange that matched
 *   no stop or take-profit;
 * - manual: an order Pegasus placed (the ticket, a close button, a signal followed by hand);
 * - campaign: an order of the campaign service;
 * - liquidation: the exchange liquidated the position; adl: the exchange's auto-deleveraging;
 * - external: an order not placed through Pegasus that matched no algo order;
 * - unknown: the position was gone and the exchange's fills did not say how (they are kept for a limited time).
 */
export type TradeExitReason = 'take_profit' | 'stop' | 'trailing' | 'manual' | 'campaign' | 'liquidation' | 'adl' | 'external' | 'unknown';

/** open: the first order's fills; add: a later fill that grows the position; reduce: one that shrinks it; close: the one that takes it to flat. */
export type TradeFillRole = 'open' | 'add' | 'reduce' | 'close';

/** The exit plan of the order that opened the trade, as Pegasus placed it (PlaceOrderRequest). */
export interface TradePlan {
  /** The stop-loss attached to the opening order; null without one */
  slTriggerPx: string | null;
  /** The take-profit legs, in the order the request gave them (leg 1 first); empty without take-profits */
  takeProfits: TakeProfitLeg[];
  breakevenAfterTp1: boolean;
  trailing: TrailingExit | null;
  /** The signal the order followed; null for a manual order */
  signal: SignalSnapshot | null;
}

export interface TradeEntry {
  /** Average price of all the opening fills (the first order and the adds) */
  avgPx: string;
  /** Contracts opened in total (the first order and the adds) */
  contracts: string;
  /** Base coin of those contracts */
  coin: string;
  /** Notional of the opening fills at their prices */
  notional: string;
  /** The largest the position was, contracts */
  maxContracts: string;
  /**
   * The leverage the position ran at after its opening order: that order's notional over `margin` once the exchange
   * reported a margin, else the leverage set for the position (for an isolated position the setting only says what an
   * add posts); null when neither is known
   */
  leverage: string | null;
  mgnMode: TdMode;
  /** Margin of the position as the exchange reported it while it held only its opening order (isolated: posted; cross: the initial requirement); null until reported */
  margin: string | null;
}

/** One order that closed contracts of the trade. */
export interface TradeExit {
  /** Time of its first fill */
  ts: number;
  reason: TradeExitReason;
  /** take_profit: the leg, 1-based; null otherwise */
  leg: number | null;
  ordId: string;
  clOrdId: string;
  /** The algo order that triggered it, when one did and is known */
  algoId: string | null;
  /** Average price of its fills */
  px: string;
  contracts: string;
  coin: string;
  /** Realised P&L of these contracts against the trade's average entry price */
  pnl: string;
  /** Fees paid on its fills, positive */
  fee: string;
}

export interface TradeFill {
  ts: number;
  ordId: string;
  clOrdId: string;
  /** The exchange's trade id: '0' or negative for a close made by the exchange itself (a liquidation) */
  tradeId: string;
  side: Side;
  role: TradeFillRole;
  px: string;
  contracts: string;
  coin: string;
  /** Fee as the exchange reports it: negative when paid, positive for a rebate */
  fee: string;
  /** Realised P&L of a reduce or close fill; '0' for an opening one */
  pnl: string;
  /** Contracts held after it */
  posAfter: string;
}

/** A trade as GET /api/journal lists it. */
export interface JournalTradeSummary {
  /** `<seq>-<instId>`, e.g. "12-BTC-USDT-SWAP" */
  id: string;
  /** The journal's own count, increasing in the order the trades were opened (recorded) */
  seq: number;
  instId: string;
  mgnMode: TdMode;
  /** The position leg: net in net mode, long or short in long/short mode */
  posSide: PosSide;
  direction: 'long' | 'short';
  source: TradeSource;
  status: TradeStatus;
  /** Time of the first fill (for an adopted trade, the position's creation time) */
  openedAt: number;
  closedAt: number | null;
  /** closedAt - openedAt; null while open */
  durationMs: number | null;
  /** Server time of the last change of the record */
  updatedAt: number;
  /** Settlement currency: what prices, P&L and fees are in */
  ccy: string;
  entry: TradeEntry;
  /** Contracts held now; '0' once closed */
  size: string;
  /** Average price of the exits so far; null before the first */
  exitPx: string | null;
  /** The exit plan of the opening order; null when Pegasus did not place it (campaign, external) or the journal did not see its request */
  plan: TradePlan | null;
  /** The plan's stop, else the trigger of the first stop-loss the exchange showed on the position before any of it was closed; null without */
  initialStop: string | null;
  /** |average price of the opening order - initialStop| x its base coin: what 1 R is; null without an initial stop or when it is not a loss */
  initialRisk: string | null;
  /** Fees paid on all fills, positive (a rebate makes it smaller) */
  fees: string;
  /** Funding received (positive) or paid (negative) over the position's life, as the exchange last reported it on the open position (its fundingFee); null when it reports none */
  funding: string | null;
  /** Sum of the exits' P&L */
  realisedPnl: string;
  /** realisedPnl - fees + funding */
  netPnl: string;
  /** netPnl / initialRisk once closed; null while open or without an initial risk */
  rMultiple: string | null;
  /** Oldest first */
  exits: TradeExit[];
  /** The reason of the exit that took the position to flat; null while open */
  closeReason: TradeExitReason | null;
  /** The journal found the position open without having seen it open (it started then, or its fills were no longer available): the entry is the position's as the exchange reported it */
  adopted: boolean;
}

export type JournalEventKind =
  | 'order_placed'
  | 'order_cancelled'
  | 'fill'
  | 'stop_placed'
  | 'stop_moved'
  | 'stop_triggered'
  | 'stop_cancelled'
  | 'tp_placed'
  | 'tp_moved'
  | 'tp_triggered'
  | 'tp_cancelled'
  | 'trailing_placed'
  | 'trailing_moved'
  | 'trailing_triggered'
  | 'trailing_cancelled'
  | 'liquidation'
  | 'adopted'
  | 'reconciled';

/**
 * One line of a trade's timeline. Which fields are set depends on the kind:
 * - order_placed: ordId, clOrdId, side, ordType, contracts, px (limit; absent at market), source, plan (when Pegasus placed it);
 * - order_cancelled: ordId, clOrdId, contracts (what was left unfilled);
 * - fill: ordId, clOrdId, side, role, px, contracts, fee, pnl (reduce and close), reason (reduce and close);
 * - stop_* / tp_* / trailing_*: algoId, px (the trigger; the new one of a move), fromPx (moved: the trigger before), leg (tp), contracts (the size it closes, when known), code (cancelled: POSITION_CLOSED when the position was closed by then);
 * - liquidation: ordId, px, contracts, pnl;
 * - adopted: px (the position's average price), contracts, code POSITION_ADOPTED;
 * - reconciled: code POSITION_GONE (closed without fills to say how) or SIZE_CORRECTED (contracts: the size the exchange shows), px.
 */
export interface JournalEvent {
  ts: number;
  kind: JournalEventKind;
  ordId?: string;
  clOrdId?: string;
  algoId?: string;
  side?: Side;
  ordType?: OrdType;
  role?: TradeFillRole;
  px?: string;
  fromPx?: string;
  contracts?: string;
  fee?: string;
  pnl?: string;
  reason?: TradeExitReason;
  leg?: number;
  source?: TradeSource;
  plan?: TradePlan;
  code?: string;
}

/** GET /api/journal/:id: the trade with its fills and its timeline. */
export interface JournalTrade extends JournalTradeSummary {
  /** Oldest first */
  fills: TradeFill[];
  /** Oldest first */
  timeline: JournalEvent[];
}

/**
 * disabled: no account to record (no API key); starting: reading what happened while the API was not running;
 * ready: recording; blocked: the journal file cannot be read or is not one this version wrote, nothing is recorded
 * and the file is not written over (`reason` says which file).
 */
export type JournalStatus = 'disabled' | 'starting' | 'ready' | 'blocked';

export interface JournalStatusReason {
  /** JOURNAL_DISABLED, JOURNAL_STARTING, JOURNAL_UNREADABLE */
  code: string;
  /** In English; a page explains it from the code */
  message: string;
}

/** GET /api/journal. */
export interface JournalPage {
  status: JournalStatus;
  reason: JournalStatusReason | null;
  /** Newest first (highest seq first) */
  trades: JournalTradeSummary[];
  /** Trades that match the filter */
  total: number;
  /** `before` for the next (older) page; null when there is none */
  next: number | null;
  serverTime: number;
}

/** The `journal` WebSocket message: sent after every change of the journal, with the trades that changed. */
export interface JournalUpdate {
  status: JournalStatus;
  reason: JournalStatusReason | null;
  /** The trades that changed, newest first; empty when only the status changed */
  trades: JournalTradeSummary[];
  serverTime: number;
}
