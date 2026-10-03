import { d, fmt, ZERO, type Dec } from '../num.js';
import type { OkxExecType, OkxFill, OkxInstrument, OkxMgnMode, OkxOrdType, OkxOrder, OkxOrderState, OkxPosSide, OkxSide } from '../wire.js';

export interface LastFill {
  px: Dec;
  sz: Dec;
  time: number;
  tradeId: string;
  execType: OkxExecType;
  fee: Dec;
  pnl: Dec;
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
}

const MAX_HISTORY = 500;
const MAX_FILLS = 1000;
const ORD_ID_BASE = 1_700_000_000_000_000;
const BILL_ID_BASE = 1_800_000_000_000_000;

/** Live orders (time priority), finished-order history and the fill ledger. */
export class OrderStore {
  private readonly live = new Map<string, OrderRec>();
  private readonly history: OrderRec[] = [];
  private readonly fills: OkxFill[] = [];
  private ordSeq = 0;
  private billSeq = 0;

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
    attachAlgoOrds: [],
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
