import { fmt, type Dec } from '../num.js';
import type { OkxExecType, OkxFill, OkxOrderAck, OkxPosition, OkxResponse, OkxTrade } from '../wire.js';
import { isRejection, reject, type EngineContext, type Rejection } from './context.js';
import type { MarketSim } from './market.js';
import { orderToWire, type OrderRec } from './orders.js';
import { asRecord, str, validateAmend, validatePlace } from './validate.js';

/** OKX `cancelSource` codes. */
const CANCEL_USER = '1';
const CANCEL_IOC_FOK = '32';

export interface ClosePositionResult extends OkxResponse<{ instId: string; posSide: string; clOrdId: string; tag: string }> {}

/** Executes orders against the synthetic books and keeps account/order state in sync. */
export class Matcher {
  constructor(private readonly ctx: EngineContext) {}

  private ack(o: OrderRec, extra: Partial<OkxOrderAck> = {}): OkxOrderAck {
    return { ordId: o.ordId, clOrdId: o.clOrdId, tag: o.tag, sCode: '0', sMsg: '', ts: String(this.ctx.now()), ...extra };
  }

  private failAck(body: unknown, r: Rejection): OkxOrderAck {
    const raw = asRecord(body);
    return { ordId: '', clOrdId: raw ? (str(raw, 'clOrdId') ?? '') : '', tag: raw ? (str(raw, 'tag') ?? '') : '', sCode: r.sCode, sMsg: r.sMsg, ts: String(this.ctx.now()) };
  }

  place(body: unknown): OkxOrderAck {
    const v = validatePlace(body, this.ctx);
    if (isRejection(v)) return this.failAck(body, v);
    const order = v;
    const market = this.ctx.markets.get(order.instId);
    if (!market) return this.failAck(body, reject('51001', 'Instrument ID does not exist.'));
    if (order.ordType === 'post_only' && order.px && market.book.crosses(order.side, order.px)) {
      return this.failAck(body, reject('51117', 'Post-only order would cross the book and take liquidity.'));
    }
    this.ctx.orders.add(order);
    this.ctx.emit('order', orderToWire(order, false));
    if (order.ordType === 'fok' && order.px && market.book.available(order.side, order.px).lt(order.sz)) {
      this.cancel(order, CANCEL_IOC_FOK, 'FOK order could not be fully filled');
      return this.ack(order);
    }
    this.execute(order, market, 'T');
    return this.ack(order);
  }

  /** Walks the book for whatever is still open on the order and applies the fills. */
  private execute(order: OrderRec, market: MarketSim, execType: OkxExecType): void {
    const now = this.ctx.now();
    const fills = market.book.walk(order.side, order.sz.sub(order.accFillSz), order.px ?? undefined);
    const trades: OkxTrade[] = [];
    let affected: OkxPosition | null = null;
    const feeRate = execType === 'T' ? this.ctx.takerFee : this.ctx.makerFee;
    for (const f of fills) {
      const print = market.recordTrade(f.px, f.sz, order.side, now);
      const outcome = this.ctx.account.applyFill(order.instId, order.tdMode, order.side, order.posSide, f.px, f.sz, feeRate, market.markPx, print.trade.tradeId, now);
      const acc = order.accFillSz.add(f.sz);
      order.avgPx = order.accFillSz.mul(order.avgPx).add(f.sz.mul(f.px)).div(acc);
      order.accFillSz = acc;
      order.fee = order.fee.add(outcome.fee);
      order.pnl = order.pnl.add(outcome.pnl);
      order.uTime = now;
      order.state = acc.gte(order.sz) ? 'filled' : 'partially_filled';
      order.lastFill = { px: f.px, sz: f.sz, time: now, tradeId: print.trade.tradeId, execType, fee: outcome.fee, pnl: outcome.pnl };
      this.ctx.orders.addFill(this.fillWire(order, market.markPx, print.trade.tradeId));
      trades.push(print.trade);
      affected = outcome.position;
      this.ctx.emit('order', orderToWire(order, true));
    }
    if (fills.length > 0) {
      this.ctx.emit('trades', { instId: order.instId, trades });
      const push = market.book.delta(now);
      if (push) this.ctx.emit('books', { instId: order.instId, push });
      this.ctx.emit('candles', { instId: order.instId, candles: market.liveCandles() });
      this.pushPositions(order.instId, affected);
      this.pushAccount();
    }
    if (order.state === 'filled') {
      this.ctx.orders.finish(order);
      return;
    }
    if (order.ordType === 'market' || order.ordType === 'ioc' || order.ordType === 'fok') {
      this.cancel(order, CANCEL_IOC_FOK, order.ordType === 'market' ? 'Market order could not be fully filled' : 'IOC remainder canceled');
    }
  }

  private fillWire(o: OrderRec, markPx: Dec, tradeId: string): OkxFill {
    const f = o.lastFill;
    const ts = String(o.uTime);
    return {
      instType: 'SWAP',
      instId: o.instId,
      tradeId,
      ordId: o.ordId,
      clOrdId: o.clOrdId,
      billId: this.ctx.orders.newBillId(),
      tag: o.tag,
      fillPx: f ? fmt(f.px) : '',
      fillSz: f ? fmt(f.sz) : '0',
      fillIdxPx: fmt(markPx),
      fillPnl: f ? fmt(f.pnl) : '0',
      fillPxVol: '',
      fillPxUsd: '',
      fillMarkVol: '',
      fillFwdPx: '',
      fillMarkPx: fmt(markPx),
      side: o.side,
      posSide: o.posSide,
      execType: f ? f.execType : '',
      feeCcy: 'USDT',
      fee: f ? fmt(f.fee) : '0',
      ts,
      fillTime: ts,
    };
  }

  private pushPositions(instId: string, affected: OkxPosition | null): void {
    const now = this.ctx.now();
    const current = this.ctx.account.positionsWire(instId, now);
    const positions = affected ? [...current.filter((p) => p.posId !== affected.posId), affected] : current;
    this.ctx.emit('positions', { instId, positions });
  }

  pushAccount(): void {
    this.ctx.emit('account', this.ctx.account.balance(this.ctx.orders.ordFrozen(this.ctx.instruments), this.ctx.now()));
  }

  private cancel(order: OrderRec, source: string, reason: string): void {
    order.state = 'canceled';
    order.cancelSource = source;
    order.cancelSourceReason = reason;
    order.uTime = this.ctx.now();
    this.ctx.orders.finish(order);
    this.ctx.emit('order', orderToWire(order, false));
    this.pushAccount();
  }

  cancelRequest(body: unknown): OkxOrderAck {
    const raw = asRecord(body);
    if (!raw) return this.failAck(body, reject('51000', 'Parameter error'));
    const instId = str(raw, 'instId') ?? '';
    if (!this.ctx.instruments.has(instId)) return this.failAck(body, reject('51001', 'Instrument ID does not exist.'));
    const ordId = str(raw, 'ordId');
    const clOrdId = str(raw, 'clOrdId');
    if (!ordId && !clOrdId) return this.failAck(body, reject('51000', 'Either ordId or clOrdId is required'));
    const order = this.ctx.orders.findLive(instId, ordId, clOrdId);
    if (!order) {
      const done = this.ctx.orders.findAny(instId, ordId, clOrdId);
      if (done?.state === 'filled') return this.failAck(body, reject('51402', 'Cancellation failed as the order is already completed.'));
      if (done?.state === 'canceled') return this.failAck(body, reject('51401', 'Cancellation failed as the order is already canceled.'));
      return this.failAck(body, reject('51400', 'Cancellation failed as the order does not exist.'));
    }
    this.cancel(order, CANCEL_USER, '');
    return this.ack(order);
  }

  amendRequest(body: unknown): OkxOrderAck {
    const v = validateAmend(body, this.ctx);
    if (isRejection(v)) return this.failAck(body, v);
    const { order, newSz, newPx, reqId } = v;
    const market = this.ctx.markets.get(order.instId);
    if (!market) return this.failAck(body, reject('51001', 'Instrument ID does not exist.'));
    const px = newPx ?? order.px;
    if (order.ordType === 'post_only' && px && market.book.crosses(order.side, px)) {
      return this.failAck(body, reject('51117', 'Post-only order would cross the book and take liquidity.'));
    }
    if (newSz) order.sz = newSz;
    if (newPx) order.px = newPx;
    order.uTime = this.ctx.now();
    order.amendResult = '0';
    order.reqId = reqId;
    this.ctx.emit('order', orderToWire(order, false));
    this.pushAccount();
    if (order.px && market.book.crosses(order.side, order.px)) this.execute(order, market, 'T');
    return this.ack(order, { reqId });
  }

  /** Re-checks resting limit orders against the (new) book; fills are maker fills. */
  matchResting(instId: string): void {
    const market = this.ctx.markets.get(instId);
    if (!market) return;
    for (const order of this.ctx.orders.liveOrders(instId)) {
      if (order.px && market.book.crosses(order.side, order.px)) this.execute(order, market, 'M');
    }
  }

  closePosition(body: unknown): ClosePositionResult {
    const raw = asRecord(body);
    if (!raw) return { code: '51000', msg: 'Parameter error', data: [] };
    const instId = str(raw, 'instId') ?? '';
    if (!this.ctx.instruments.has(instId)) return { code: '51001', msg: 'Instrument ID does not exist.', data: [] };
    const mgnMode = str(raw, 'mgnMode');
    if (mgnMode !== 'cross' && mgnMode !== 'isolated') return { code: '51000', msg: 'Parameter mgnMode error', data: [] };
    const posSideRaw = str(raw, 'posSide');
    let posSide: 'long' | 'short' | 'net';
    if (this.ctx.posMode === 'long_short_mode') {
      if (posSideRaw !== 'long' && posSideRaw !== 'short') return { code: '51000', msg: 'Parameter posSide error', data: [] };
      posSide = posSideRaw;
    } else {
      if (posSideRaw !== undefined && posSideRaw !== '' && posSideRaw !== 'net') return { code: '51000', msg: 'Parameter posSide error', data: [] };
      posSide = 'net';
    }
    const position = this.ctx.account.find(instId, mgnMode, posSide);
    if (!position || position.qty.isZero()) return { code: '51023', msg: 'Position does not exist.', data: [] };
    const clOrdId = str(raw, 'clOrdId') ?? '';
    const tag = str(raw, 'tag') ?? '';
    const params: Record<string, unknown> = {
      instId,
      tdMode: mgnMode,
      side: position.dir > 0 ? 'sell' : 'buy',
      ordType: 'market',
      sz: fmt(position.qty),
      reduceOnly: true,
      clOrdId,
      tag,
    };
    if (posSide !== 'net') params['posSide'] = posSide;
    const ack = this.place(params);
    if (ack.sCode !== '0') return { code: ack.sCode, msg: ack.sMsg, data: [] };
    return { code: '0', msg: '', data: [{ instId, posSide, clOrdId, tag }] };
  }
}
