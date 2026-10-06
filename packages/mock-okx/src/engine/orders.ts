import { d, fmt, ZERO, type Dec } from '../num.js';
import type { MockStop, OkxAlgoOrder, OkxAlgoOrdType, OkxAttachAlgoOrd, OkxExecType, OkxFill, OkxInstrument, OkxMgnMode, OkxOrdType, OkxOrder, OkxOrderState, OkxPosSide, OkxSide, OkxTriggerPxType } from '../wire.js';

export interface LastFill {
  px: Dec;
  sz: Dec;
  time: number;
  tradeId: string;
  execType: OkxExecType;
  fee: Dec;
  pnl: Dec;
}

/** The stop-loss an order carries in `attachAlgoOrds`; it becomes a StopRec when the order is completely filled. */
export interface AttachedSl {
  attachAlgoId: string;
  attachAlgoClOrdId: string;
  slTriggerPx: Dec;
  /** '-1' (market) or a limit price; the simulator always closes at market */
  slOrdPx: string;
  slTriggerPxType: OkxTriggerPxType;
  /**
   * The stop-loss of split take-profits with the cost-price stop enabled (amendPxOnTriggerType '1'): its trigger moves
   * to the order's average fill price when the first take-profit triggers. Absent in a file written before
   * take-profits were simulated.
   */
  amendPxOnTriggerType?: boolean;
}

/** A take-profit an order carries in `attachAlgoOrds`; it becomes a StopRec when the order is completely filled. */
export interface AttachedTp {
  attachAlgoId: string;
  attachAlgoClOrdId: string;
  tpTriggerPx: Dec;
  /** '-1' (market) or a limit price; the simulator always closes at market */
  tpOrdPx: string;
  tpTriggerPxType: OkxTriggerPxType;
  /** A leg of split take-profits: the contracts it closes. null in the one-object form, which covers the whole fill */
  sz: Dec | null;
}

/**
 * The algo order types: `conditional` (one leg, a stop-loss or a take-profit), `oco` (both legs; the first to
 * trigger ends the order) and `move_order_stop` (a trailing stop).
 */
export type AlgoOrdType = OkxAlgoOrdType;

/** Which part of an algo order triggered. */
export type AlgoLeg = 'sl' | 'tp' | 'trail';

/**
 * An active algo order: once the price its trigger type names reaches a leg's trigger, it closes `sz` of its position
 * with a market order (a reduce-only one, at most the position, unless it was placed without reduce-only in net mode).
 * A stop-loss leg triggers when the price falls to it (a stop that sells; rises to it, one that buys), a take-profit
 * leg when the price rises to it (falls to it), a trailing stop when the last price has come back `callbackRatio`
 * (or `callbackSpread`) from its extreme since it was activated.
 */
export interface StopRec {
  algoId: string;
  algoClOrdId: string;
  /** The order it was attached to; '' for one placed on its own */
  ordId: string;
  instId: string;
  tdMode: OkxMgnMode;
  posSide: OkxPosSide;
  /** Side of the closing order: sell protects a long, buy a short */
  side: OkxSide;
  sz: Dec;
  ordType: AlgoOrdType;
  /** null without a stop-loss leg */
  slTriggerPx: Dec | null;
  /** '-1' (market) or a limit price; the simulator always closes at market */
  slOrdPx: string;
  slTriggerPxType: OkxTriggerPxType;
  /** null without a take-profit leg */
  tpTriggerPx: Dec | null;
  tpOrdPx: string;
  tpTriggerPxType: OkxTriggerPxType;
  /** The order it sends when triggered can only reduce: always in long/short mode, in net mode when placed with reduceOnly */
  reduceOnly: boolean;
  /** Cancelled when its position is fully closed (cxlOnClosePos; assumed for the ones generated from attachAlgoOrds) */
  cxlOnClosePos: boolean;
  /** The cost-price stop of split take-profits, until it has moved: the first take-profit of `ordId` moves the stop-loss to costPx */
  amendPxOnTriggerType: boolean;
  /** The average fill price of the order it came from */
  costPx: Dec | null;
  /** Trailing stop: the share of the extreme it trails by, or the price distance */
  callbackRatio: Dec | null;
  callbackSpread: Dec | null;
  /** Trailing stop: it is activated once the last price reaches this (at once when null) */
  activePx: Dec | null;
  /** Trailing stop: the highest (one that sells) or lowest (one that buys) last price since it was activated; null before */
  extremePx: Dec | null;
  cTime: number;
  uTime: number;
}

/** An algo order record with the defaults of a one-way stop: what a caller does not set does not apply. */
export function algoRecord(base: Pick<StopRec, 'algoId' | 'algoClOrdId' | 'ordId' | 'instId' | 'tdMode' | 'posSide' | 'side' | 'sz' | 'cTime' | 'uTime'> & Partial<StopRec>): StopRec {
  return {
    ordType: 'conditional',
    slTriggerPx: null,
    slOrdPx: '',
    slTriggerPxType: 'last',
    tpTriggerPx: null,
    tpOrdPx: '',
    tpTriggerPxType: 'last',
    reduceOnly: true,
    cxlOnClosePos: false,
    amendPxOnTriggerType: false,
    costPx: null,
    callbackRatio: null,
    callbackSpread: null,
    activePx: null,
    extremePx: null,
    ...base,
  };
}

/** The price a trailing stop triggers at now: its extreme less (plus, for one that buys) the callback; null before it is active. */
export function trailingTrigger(s: StopRec): Dec | null {
  if (s.ordType !== 'move_order_stop' || s.extremePx === null) return null;
  const sells = s.side === 'sell';
  if (s.callbackSpread !== null) return sells ? s.extremePx.sub(s.callbackSpread) : s.extremePx.add(s.callbackSpread);
  const r = s.callbackRatio ?? ZERO;
  return sells ? s.extremePx.mul(d(1).sub(r)) : s.extremePx.mul(d(1).add(r));
}

export interface OrderRec {
  ordId: string;
  clOrdId: string;
  tag: string;
  instId: string;
  tdMode: OkxMgnMode;
  side: OkxSide;
  posSide: OkxPosSide;
  ordType: OkxOrdType;
  /** null for market orders */
  px: Dec | null;
  sz: Dec;
  accFillSz: Dec;
  avgPx: Dec;
  state: OkxOrderState;
  lever: Dec;
  reduceOnly: boolean;
  fee: Dec;
  pnl: Dec;
  cTime: number;
  uTime: number;
  cancelSource: string;
  cancelSourceReason: string;
  lastFill: LastFill | null;
  amendResult: string;
  reqId: string;
  attachSl: AttachedSl | null;
  /** The take-profits of `attachAlgoOrds`: one in the one-object form, one per leg for split take-profits */
  attachTps: AttachedTp[];
  /** OKX's order category: `normal` for an order of the user, `full_liquidation` for the one the exchange closes a liquidated position with */
  category: OrderCategory;
}

export type OrderCategory = 'normal' | 'full_liquidation';

/** Whether the order carries split take-profits (legs with a size of their own) rather than one attached object. */
export function hasSplitTps(o: Pick<OrderRec, 'attachTps'>): boolean {
  return o.attachTps.some((t) => t.sz !== null);
}

type Plain<T> = { [K in keyof T]: T[K] extends Dec ? string : T[K] extends Dec | null ? string | null : T[K] };

/** The fields every saved algo order has; the others came with take-profits and trailing stops and default when absent. */
type StopCore = 'algoId' | 'algoClOrdId' | 'ordId' | 'instId' | 'tdMode' | 'posSide' | 'side' | 'sz' | 'slTriggerPx' | 'slOrdPx' | 'slTriggerPxType' | 'cTime' | 'uTime';
export type StopJson = Pick<Plain<StopRec>, StopCore> & Partial<Omit<Plain<StopRec>, StopCore>>;

/** The order store as plain JSON: what the paper exchange keeps across restarts. Decimals are strings. */
export interface OrderStoreSnapshot {
  live: OrderJson[];
  history: OrderJson[];
  fills: OkxFill[];
  stops: StopJson[];
  ordSeq: number;
  billSeq: number;
  algoSeq: number;
}

export type OrderJson = Omit<Plain<OrderRec>, 'lastFill' | 'attachSl' | 'attachTps' | 'category'> & {
  lastFill: Plain<LastFill> | null;
  attachSl: Plain<AttachedSl> | null;
  /** Absent in a file written before take-profits were simulated */
  attachTps?: Array<Plain<AttachedTp>>;
  /** Absent in a file written before liquidations were simulated: every order in it is a normal one */
  category?: OrderCategory;
};

const decOrNull = (s: string | null | undefined): Dec | null => (s === null || s === undefined || s === '' ? null : d(s));
const strOrNull = (v: Dec | null): string | null => (v === null ? null : v.toFixed());

function orderToJson(o: OrderRec): OrderJson {
  const f = o.lastFill;
  const sl = o.attachSl;
  return {
    ...o,
    px: o.px ? o.px.toFixed() : null,
    sz: o.sz.toFixed(),
    accFillSz: o.accFillSz.toFixed(),
    avgPx: o.avgPx.toFixed(),
    lever: o.lever.toFixed(),
    fee: o.fee.toFixed(),
    pnl: o.pnl.toFixed(),
    lastFill: f ? { ...f, px: f.px.toFixed(), sz: f.sz.toFixed(), fee: f.fee.toFixed(), pnl: f.pnl.toFixed() } : null,
    attachSl: sl ? { ...sl, slTriggerPx: sl.slTriggerPx.toFixed() } : null,
    attachTps: o.attachTps.map((t) => ({ ...t, tpTriggerPx: t.tpTriggerPx.toFixed(), sz: strOrNull(t.sz) })),
  };
}

function orderFromJson(o: OrderJson): OrderRec {
  const f = o.lastFill;
  const sl = o.attachSl;
  return {
    ...o,
    px: o.px === null ? null : d(o.px),
    sz: d(o.sz),
    accFillSz: d(o.accFillSz),
    avgPx: d(o.avgPx),
    lever: d(o.lever),
    fee: d(o.fee),
    pnl: d(o.pnl),
    lastFill: f ? { ...f, px: d(f.px), sz: d(f.sz), fee: d(f.fee), pnl: d(f.pnl) } : null,
    attachSl: sl ? { ...sl, slTriggerPx: d(sl.slTriggerPx) } : null,
    attachTps: (o.attachTps ?? []).map((t) => ({ ...t, tpTriggerPx: d(t.tpTriggerPx), sz: decOrNull(t.sz) })),
    category: o.category ?? 'normal',
  };
}

function stopToJson(s: StopRec): StopJson {
  return {
    ...s,
    sz: s.sz.toFixed(),
    slTriggerPx: strOrNull(s.slTriggerPx),
    tpTriggerPx: strOrNull(s.tpTriggerPx),
    costPx: strOrNull(s.costPx),
    callbackRatio: strOrNull(s.callbackRatio),
    callbackSpread: strOrNull(s.callbackSpread),
    activePx: strOrNull(s.activePx),
    extremePx: strOrNull(s.extremePx),
  };
}

/** A saved algo order; one written before take-profits and trailing stops were simulated is a stop-loss generated from attachAlgoOrds or placed with cxlOnClosePos, as the simulator kept them then. */
function stopFromJson(s: StopJson): StopRec {
  return algoRecord({
    algoId: s.algoId,
    algoClOrdId: s.algoClOrdId,
    ordId: s.ordId,
    instId: s.instId,
    tdMode: s.tdMode,
    posSide: s.posSide,
    side: s.side,
    sz: d(s.sz),
    slTriggerPx: decOrNull(s.slTriggerPx),
    slOrdPx: s.slOrdPx,
    slTriggerPxType: s.slTriggerPxType,
    cTime: s.cTime,
    uTime: s.uTime,
    ordType: s.ordType ?? 'conditional',
    tpTriggerPx: decOrNull(s.tpTriggerPx),
    tpOrdPx: s.tpOrdPx ?? '',
    tpTriggerPxType: s.tpTriggerPxType ?? 'last',
    reduceOnly: s.reduceOnly ?? true,
    cxlOnClosePos: s.cxlOnClosePos ?? true,
    amendPxOnTriggerType: s.amendPxOnTriggerType ?? false,
    costPx: decOrNull(s.costPx),
    callbackRatio: decOrNull(s.callbackRatio),
    callbackSpread: decOrNull(s.callbackSpread),
    activePx: decOrNull(s.activePx),
    extremePx: decOrNull(s.extremePx),
  });
}

const MAX_HISTORY = 500;
const MAX_FILLS = 1000;
const ORD_ID_BASE = 1_700_000_000_000_000;
const BILL_ID_BASE = 1_800_000_000_000_000;
const ALGO_ID_BASE = 2_000_000_000_000_000;

/** Live orders (time priority), finished-order history and the fill ledger. */
export class OrderStore {
  private readonly live = new Map<string, OrderRec>();
  private readonly history: OrderRec[] = [];
  private readonly fills: OkxFill[] = [];
  /** Active stops by their algoId. They are algo orders: never part of the live orders. */
  private readonly stops = new Map<string, StopRec>();
  private ordSeq = 0;
  private billSeq = 0;
  private algoSeq = 0;

  snapshot(): OrderStoreSnapshot {
    return {
      live: [...this.live.values()].map(orderToJson),
      history: this.history.map(orderToJson),
      fills: [...this.fills],
      stops: [...this.stops.values()].map(stopToJson),
      ordSeq: this.ordSeq,
      billSeq: this.billSeq,
      algoSeq: this.algoSeq,
    };
  }

  /** Replaces the whole store with a snapshot taken earlier. */
  restore(s: OrderStoreSnapshot): void {
    this.live.clear();
    for (const o of s.live) this.live.set(o.ordId, orderFromJson(o));
    this.history.splice(0, this.history.length, ...s.history.map(orderFromJson));
    this.fills.splice(0, this.fills.length, ...s.fills);
    this.stops.clear();
    for (const stop of s.stops) this.stops.set(stop.algoId, stopFromJson(stop));
    this.ordSeq = s.ordSeq;
    this.billSeq = s.billSeq;
    this.algoSeq = s.algoSeq;
  }

  newAlgoId(): string {
    this.algoSeq += 1;
    return String(ALGO_ID_BASE + this.algoSeq);
  }

  /**
   * Generates the algo orders an order carried in `attachAlgoOrds`, for what it filled. `partial`: the order ended
   * cancelled after a partial fill. The one-object form becomes one algo order (`oco` with both legs, `conditional`
   * with one) for the filled size. Split take-profits become one `conditional` order per leg, sized as sent, and the
   * stop-loss one for the whole order; OKX places them "only after the main order is fully filled" (help center,
   * "Placing a stop order along with a normal order"), so a split order cancelled after a partial fill generates none.
   * Each is cancelled with its position (assumed: docs/okx-api-notes.md 12, item 31).
   */
  addAttached(parent: OrderRec, now: number, partial: boolean): void {
    const base = {
      ordId: parent.ordId,
      instId: parent.instId,
      tdMode: parent.tdMode,
      posSide: parent.posSide,
      side: (parent.side === 'buy' ? 'sell' : 'buy') as OkxSide,
      cxlOnClosePos: true,
      cTime: now,
      uTime: now,
    };
    const sl = parent.attachSl;
    if (hasSplitTps(parent)) {
      if (partial) return;
      for (const tp of parent.attachTps) {
        this.stops.set(tp.attachAlgoId, algoRecord({ ...base, algoId: tp.attachAlgoId, algoClOrdId: tp.attachAlgoClOrdId, sz: tp.sz ?? parent.accFillSz, tpTriggerPx: tp.tpTriggerPx, tpOrdPx: tp.tpOrdPx, tpTriggerPxType: tp.tpTriggerPxType }));
      }
      if (sl) {
        this.stops.set(sl.attachAlgoId, algoRecord({ ...base, algoId: sl.attachAlgoId, algoClOrdId: sl.attachAlgoClOrdId, sz: parent.accFillSz, slTriggerPx: sl.slTriggerPx, slOrdPx: sl.slOrdPx, slTriggerPxType: sl.slTriggerPxType, amendPxOnTriggerType: sl.amendPxOnTriggerType ?? false, costPx: parent.avgPx }));
      }
      return;
    }
    const tp = parent.attachTps[0];
    const first = sl ?? tp;
    if (!first) return;
    const legs: Partial<StopRec> = { ordType: sl && tp ? 'oco' : 'conditional' };
    if (sl) Object.assign(legs, { slTriggerPx: sl.slTriggerPx, slOrdPx: sl.slOrdPx, slTriggerPxType: sl.slTriggerPxType });
    if (tp) Object.assign(legs, { tpTriggerPx: tp.tpTriggerPx, tpOrdPx: tp.tpOrdPx, tpTriggerPxType: tp.tpTriggerPxType });
    this.stops.set(first.attachAlgoId, algoRecord({ ...base, ...legs, algoId: first.attachAlgoId, algoClOrdId: first.attachAlgoClOrdId, sz: parent.accFillSz }));
  }

  hasStop(algoId: string): boolean {
    return this.stops.has(algoId);
  }

  /** A stop placed on its own (POST /api/v5/trade/order-algo), not generated from an order: its `ordId` is empty. */
  addStandaloneStop(stop: StopRec): void {
    this.stops.set(stop.algoId, stop);
  }

  algoClOrdIdInUse(algoClOrdId: string): boolean {
    for (const s of this.stops.values()) if (s.algoClOrdId === algoClOrdId) return true;
    return false;
  }

  /** An active stop by its algoId, or by its client id when no algoId is given (OKX: algoId wins when both are passed). */
  findStop(instId: string, algoId: string | undefined, algoClOrdId: string | undefined): StopRec | undefined {
    for (const s of this.stops.values()) {
      if (s.instId !== instId) continue;
      if (algoId ? s.algoId === algoId : algoClOrdId !== undefined && algoClOrdId !== '' && s.algoClOrdId === algoClOrdId) return s;
    }
    return undefined;
  }

  removeStop(stop: StopRec): void {
    this.stops.delete(stop.algoId);
  }

  activeStops(instId?: string): StopRec[] {
    const out: StopRec[] = [];
    for (const s of this.stops.values()) if (!instId || s.instId === instId) out.push(s);
    return out;
  }

  newOrdId(): string {
    this.ordSeq += 1;
    return String(ORD_ID_BASE + this.ordSeq);
  }

  newBillId(): string {
    this.billSeq += 1;
    return String(BILL_ID_BASE + this.billSeq);
  }

  add(o: OrderRec): void {
    this.live.set(o.ordId, o);
  }

  /** Moves a filled/canceled order out of the live set, keeping the last 500. */
  finish(o: OrderRec): void {
    this.live.delete(o.ordId);
    this.history.push(o);
    if (this.history.length > MAX_HISTORY) this.history.splice(0, this.history.length - MAX_HISTORY);
  }

  isLive(ordId: string): boolean {
    return this.live.has(ordId);
  }

  clOrdIdInUse(clOrdId: string): boolean {
    for (const o of this.live.values()) if (o.clOrdId === clOrdId) return true;
    return false;
  }

  findLive(instId: string, ordId: string | undefined, clOrdId: string | undefined): OrderRec | undefined {
    if (ordId) {
      const o = this.live.get(ordId);
      return o && o.instId === instId ? o : undefined;
    }
    if (clOrdId) {
      for (const o of this.live.values()) if (o.instId === instId && o.clOrdId === clOrdId) return o;
    }
    return undefined;
  }

  findAny(instId: string, ordId: string | undefined, clOrdId: string | undefined): OrderRec | undefined {
    const live = this.findLive(instId, ordId, clOrdId);
    if (live) return live;
    for (let i = this.history.length - 1; i >= 0; i--) {
      const o = this.history[i];
      if (!o || o.instId !== instId) continue;
      if ((ordId && o.ordId === ordId) || (!ordId && clOrdId && o.clOrdId === clOrdId)) return o;
    }
    return undefined;
  }

  /** Live orders in time priority, optionally filtered by instrument. */
  liveOrders(instId?: string): OrderRec[] {
    const out: OrderRec[] = [];
    for (const o of this.live.values()) if (!instId || o.instId === instId) out.push(o);
    return out;
  }

  /** Finished orders, newest first. */
  historyOrders(instId: string | undefined, limit: number): OrderRec[] {
    const out: OrderRec[] = [];
    for (let i = this.history.length - 1; i >= 0 && out.length < limit; i--) {
      const o = this.history[i];
      if (o && (!instId || o.instId === instId)) out.push(o);
    }
    return out;
  }

  addFill(f: OkxFill): void {
    this.fills.push(f);
    if (this.fills.length > MAX_FILLS) this.fills.splice(0, this.fills.length - MAX_FILLS);
  }

  /** Fills, newest first. */
  fillsList(instId: string | undefined, limit: number): OkxFill[] {
    const out: OkxFill[] = [];
    for (let i = this.fills.length - 1; i >= 0 && out.length < limit; i--) {
      const f = this.fills[i];
      if (f && (!instId || f.instId === instId)) out.push(f);
    }
    return out;
  }

  /** Margin reserved by resting orders that would open exposure. */
  ordFrozen(instruments: Map<string, OkxInstrument>): Dec {
    let total = ZERO;
    for (const o of this.live.values()) {
      if (o.reduceOnly || !o.px) continue;
      const inst = instruments.get(o.instId);
      if (!inst) continue;
      total = total.add(o.sz.sub(o.accFillSz).mul(d(inst.ctVal)).mul(o.px).div(o.lever));
    }
    return total;
  }
}

export function stopToWire(s: StopRec): MockStop {
  const out: MockStop = {
    algoId: s.algoId,
    algoClOrdId: s.algoClOrdId,
    ordId: s.ordId,
    instId: s.instId,
    tdMode: s.tdMode,
    posSide: s.posSide,
    side: s.side,
    sz: fmt(s.sz),
    slTriggerPx: s.slTriggerPx ? fmt(s.slTriggerPx) : '',
    slTriggerPxType: s.slTriggerPx ? s.slTriggerPxType : '',
  };
  if (s.ordType !== 'conditional') out.ordType = s.ordType;
  if (s.tpTriggerPx) {
    out.tpTriggerPx = fmt(s.tpTriggerPx);
    out.tpTriggerPxType = s.tpTriggerPxType;
  }
  if (s.amendPxOnTriggerType) out.amendPxOnTriggerType = true;
  if (s.callbackRatio) out.callbackRatio = fmt(s.callbackRatio);
  if (s.callbackSpread) out.callbackSpread = fmt(s.callbackSpread);
  if (s.activePx) out.activePx = fmt(s.activePx);
  if (s.ordType === 'move_order_stop') {
    const trigger = trailingTrigger(s);
    out.moveTriggerPx = trigger ? fmt(trigger) : '';
  }
  if (!s.reduceOnly) out.reduceOnly = false;
  if (!s.cxlOnClosePos) out.cxlOnClosePos = false;
  return out;
}

/** An algo order as the algo order list shows it: for a fixed number of contracts, with the fields of its type. */
export function stopToAlgoWire(s: StopRec): OkxAlgoOrder {
  const trigger = trailingTrigger(s);
  return {
    instType: 'SWAP',
    instId: s.instId,
    algoId: s.algoId,
    algoClOrdId: s.algoClOrdId,
    ordType: s.ordType,
    side: s.side,
    posSide: s.posSide,
    tdMode: s.tdMode,
    sz: fmt(s.sz),
    closeFraction: '',
    state: 'live',
    reduceOnly: s.reduceOnly ? 'true' : 'false',
    tpTriggerPx: s.tpTriggerPx ? fmt(s.tpTriggerPx) : '',
    tpTriggerPxType: s.tpTriggerPx ? s.tpTriggerPxType : '',
    tpOrdPx: s.tpTriggerPx ? s.tpOrdPx : '',
    slTriggerPx: s.slTriggerPx ? fmt(s.slTriggerPx) : '',
    slTriggerPxType: s.slTriggerPx ? s.slTriggerPxType : '',
    slOrdPx: s.slTriggerPx ? s.slOrdPx : '',
    callbackRatio: s.callbackRatio ? fmt(s.callbackRatio) : '',
    callbackSpread: s.callbackSpread ? fmt(s.callbackSpread) : '',
    activePx: s.activePx ? fmt(s.activePx) : '',
    moveTriggerPx: trigger ? fmt(trigger) : '',
    amendPxOnTriggerType: s.amendPxOnTriggerType ? '1' : '0',
    ordIdList: [],
    actualSz: '0',
    actualPx: '',
    actualSide: '',
    triggerTime: '',
    failCode: '',
    tag: '',
    cTime: String(s.cTime),
    uTime: String(s.uTime),
  };
}

/**
 * The `attachAlgoOrds` an order echoes: one entry per object it was sent with. The one-object form is one entry with
 * its take-profit and its stop-loss; split take-profits are one entry per leg (with its `sz`) and one for the stop-loss
 * (with `amendPxOnTriggerType`).
 */
function attachedToWire(o: OrderRec): OkxAttachAlgoOrd[] {
  const blank = { tpTriggerPx: '', tpOrdPx: '', tpTriggerPxType: '', slTriggerPx: '', slOrdPx: '', slTriggerPxType: '' as const, sz: '', amendPxOnTriggerType: '0', failCode: '', failReason: '' };
  const sl = o.attachSl;
  const slFields = sl ? { slTriggerPx: fmt(sl.slTriggerPx), slOrdPx: sl.slOrdPx, slTriggerPxType: sl.slTriggerPxType } : {};
  const tpFields = (tp: AttachedTp) => ({ tpTriggerPx: fmt(tp.tpTriggerPx), tpOrdPx: tp.tpOrdPx, tpTriggerPxType: tp.tpTriggerPxType });
  if (hasSplitTps(o)) {
    const out: OkxAttachAlgoOrd[] = o.attachTps.map((tp) => ({ ...blank, attachAlgoId: tp.attachAlgoId, attachAlgoClOrdId: tp.attachAlgoClOrdId, ...tpFields(tp), sz: tp.sz ? fmt(tp.sz) : '' }));
    if (sl) out.push({ ...blank, attachAlgoId: sl.attachAlgoId, attachAlgoClOrdId: sl.attachAlgoClOrdId, ...slFields, amendPxOnTriggerType: sl.amendPxOnTriggerType ? '1' : '0' });
    return out;
  }
  const tp = o.attachTps[0];
  const first = sl ?? tp;
  if (!first) return [];
  return [{ ...blank, attachAlgoId: first.attachAlgoId, attachAlgoClOrdId: first.attachAlgoClOrdId, ...(tp ? tpFields(tp) : {}), ...slFields }];
}

/** Converts an order to the OKX wire shape. `fillEvent` controls the per-fill fields. */
export function orderToWire(o: OrderRec, fillEvent: boolean): OkxOrder {
  const f = fillEvent ? o.lastFill : null;
  const notional = o.px ? o.sz.mul(o.px) : o.accFillSz.mul(o.avgPx);
  return {
    instType: 'SWAP',
    instId: o.instId,
    ordId: o.ordId,
    clOrdId: o.clOrdId,
    tag: o.tag,
    tdMode: o.tdMode,
    ccy: '',
    side: o.side,
    posSide: o.posSide,
    ordType: o.ordType,
    px: o.px ? fmt(o.px) : '',
    sz: fmt(o.sz),
    accFillSz: fmt(o.accFillSz),
    fillPx: f ? fmt(f.px) : '',
    fillSz: f ? fmt(f.sz) : '0',
    fillTime: f ? String(f.time) : '',
    tradeId: f ? f.tradeId : '',
    avgPx: o.accFillSz.gt(0) ? fmt(o.avgPx) : '',
    state: o.state,
    lever: fmt(o.lever),
    reduceOnly: o.reduceOnly ? 'true' : 'false',
    fee: fmt(o.fee),
    feeCcy: 'USDT',
    rebate: '0',
    rebateCcy: 'USDT',
    pnl: fmt(o.pnl),
    category: o.category,
    source: '',
    cancelSource: o.cancelSource,
    cancelSourceReason: o.cancelSourceReason,
    tgtCcy: '',
    tpTriggerPx: '',
    tpOrdPx: '',
    slTriggerPx: '',
    slOrdPx: '',
    stpMode: 'cancel_maker',
    algoClOrdId: '',
    algoId: '',
    attachAlgoOrds: attachedToWire(o),
    cTime: String(o.cTime),
    uTime: String(o.uTime),
    execType: f ? f.execType : '',
    fillFee: f ? fmt(f.fee) : '0',
    fillFeeCcy: f ? 'USDT' : '',
    fillPnl: f ? fmt(f.pnl) : '0',
    fillNotionalUsd: f ? fmt(f.px.mul(f.sz)) : '',
    notionalUsd: fmt(notional),
    amendResult: o.amendResult,
    reqId: o.reqId,
    code: '0',
    msg: '',
  };
}
