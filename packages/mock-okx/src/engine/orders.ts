import { d, fmt, ZERO, type Dec } from '../num.js';
import type { MockStop, OkxAlgoOrder, OkxExecType, OkxFill, OkxInstrument, OkxMgnMode, OkxOrdType, OkxOrder, OkxOrderState, OkxPosSide, OkxSide, OkxTriggerPxType } from '../wire.js';

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
}

/** An active stop-loss: closes `sz` of its position with a market order once its trigger price type reaches the trigger. */
export interface StopRec {
  algoId: string;
  algoClOrdId: string;
  /** The order it was attached to; '' for a stop placed on its own */
  ordId: string;
  instId: string;
  tdMode: OkxMgnMode;
  posSide: OkxPosSide;
  /** Side of the closing order: sell protects a long, buy a short */
  side: OkxSide;
  sz: Dec;
  slTriggerPx: Dec;
  /** '-1' (market) or a limit price; the simulator always closes at market */
  slOrdPx: string;
  slTriggerPxType: OkxTriggerPxType;
  cTime: number;
  uTime: number;
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
}

type Plain<T> = { [K in keyof T]: T[K] extends Dec ? string : T[K] extends Dec | null ? string | null : T[K] };

/** The order store as plain JSON: what the paper exchange keeps across restarts. Decimals are strings. */
export interface OrderStoreSnapshot {
  live: OrderJson[];
  history: OrderJson[];
  fills: OkxFill[];
  stops: Array<Plain<StopRec>>;
  ordSeq: number;
  billSeq: number;
  algoSeq: number;
}

export type OrderJson = Omit<Plain<OrderRec>, 'lastFill' | 'attachSl'> & { lastFill: Plain<LastFill> | null; attachSl: Plain<AttachedSl> | null };

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
  };
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
      stops: [...this.stops.values()].map((s) => ({ ...s, sz: s.sz.toFixed(), slTriggerPx: s.slTriggerPx.toFixed() })),
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
    for (const stop of s.stops) this.stops.set(stop.algoId, { ...stop, sz: d(stop.sz), slTriggerPx: d(stop.slTriggerPx) });
    this.ordSeq = s.ordSeq;
    this.billSeq = s.billSeq;
    this.algoSeq = s.algoSeq;
  }

  newAlgoId(): string {
    this.algoSeq += 1;
    return String(ALGO_ID_BASE + this.algoSeq);
  }

  /** Generates the stop of a parent order that has ended, for everything the order filled. */
  addStop(parent: OrderRec, sl: AttachedSl, now: number): void {
    this.stops.set(sl.attachAlgoId, {
      algoId: sl.attachAlgoId,
      algoClOrdId: sl.attachAlgoClOrdId,
      ordId: parent.ordId,
      instId: parent.instId,
      tdMode: parent.tdMode,
      posSide: parent.posSide,
      side: parent.side === 'buy' ? 'sell' : 'buy',
      sz: parent.accFillSz,
      slTriggerPx: sl.slTriggerPx,
      slOrdPx: sl.slOrdPx,
      slTriggerPxType: sl.slTriggerPxType,
      cTime: now,
      uTime: now,
    });
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
  return { algoId: s.algoId, algoClOrdId: s.algoClOrdId, ordId: s.ordId, instId: s.instId, tdMode: s.tdMode, posSide: s.posSide, side: s.side, sz: fmt(s.sz), slTriggerPx: fmt(s.slTriggerPx), slTriggerPxType: s.slTriggerPxType };
}

/** A stop as the algo order list shows it: a one-way (`conditional`) stop for a fixed number of contracts. */
export function stopToAlgoWire(s: StopRec): OkxAlgoOrder {
  return {
    instType: 'SWAP',
    instId: s.instId,
    algoId: s.algoId,
    algoClOrdId: s.algoClOrdId,
    ordType: 'conditional',
    side: s.side,
    posSide: s.posSide,
    tdMode: s.tdMode,
    sz: fmt(s.sz),
    closeFraction: '',
    state: 'live',
    reduceOnly: 'true',
    tpTriggerPx: '',
    tpTriggerPxType: '',
    tpOrdPx: '',
    slTriggerPx: fmt(s.slTriggerPx),
    slTriggerPxType: s.slTriggerPxType,
    slOrdPx: s.slOrdPx,
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
    category: 'normal',
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
    attachAlgoOrds: o.attachSl
      ? [
          {
            attachAlgoId: o.attachSl.attachAlgoId,
            attachAlgoClOrdId: o.attachSl.attachAlgoClOrdId,
            tpTriggerPx: '',
            tpOrdPx: '',
            tpTriggerPxType: '',
            slTriggerPx: fmt(o.attachSl.slTriggerPx),
            slOrdPx: o.attachSl.slOrdPx,
            slTriggerPxType: o.attachSl.slTriggerPxType,
            sz: '',
            amendPxOnTriggerType: '0',
            failCode: '',
            failReason: '',
          },
        ]
      : [],
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
