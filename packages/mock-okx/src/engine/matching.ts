import { fmt, type Dec } from '../num.js';
import type { OkxAlgoAck, OkxExecType, OkxFill, OkxOrderAck, OkxPosition, OkxResponse, OkxTrade } from '../wire.js';
import type { WalkFill } from './book.js';
import { isRejection, reject, type EngineContext, type Market, type Rejection } from './context.js';
import type { PositionRec } from './account.js';
import { orderToWire, trailingTrigger, type AlgoLeg, type OrderRec, type StopRec } from './orders.js';
import { asRecord, str, validateAmend, validateAmendAlgo, validatePlace, validatePlaceAlgo } from './validate.js';

/** Whether the order carries anything in attachAlgoOrds. */
const hasAttached = (o: OrderRec): boolean => o.attachSl !== null || o.attachTps.length > 0;

/** OKX `cancelSource` codes. */
const CANCEL_USER = '1';
const CANCEL_IOC_FOK = '32';
/** "Risk cancellation was triggered. Pending order was canceled due to insufficient maintenance margin ratio and forced-liquidation risk." */
const CANCEL_LIQUIDATION = '3';

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

  /**
   * `fillPx` is for the replay of a time the exchange did not see: the order is filled in full at that price
   * instead of against the book (which holds the quotes of now, not of then).
   */
  place(body: unknown, fillPx?: Dec): OkxOrderAck {
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
    this.execute(order, market, 'T', fillPx ? [{ px: fillPx, sz: order.sz }] : undefined);
    return this.ack(order);
  }

  /** Fills a resting order in full at `px` (the replay of a time the exchange did not see); false when it is no longer live. */
  fillRestingAt(ordId: string, instId: string, px: Dec): boolean {
    const order = this.ctx.orders.findLive(instId, ordId, undefined);
    const market = this.ctx.markets.get(instId);
    if (!order || !market) return false;
    this.execute(order, market, 'M', [{ px, sz: order.sz.sub(order.accFillSz) }]);
    return true;
  }

  /**
   * Applies fills to whatever is still open on the order: the given ones, else what a resting order gets once
   * the book crossed it (a market that says so), else what walking the book yields.
   */
  private execute(order: OrderRec, market: Market, execType: OkxExecType, forced?: WalkFill[]): void {
    const now = this.ctx.now();
    const open = order.sz.sub(order.accFillSz);
    const fills = forced ?? (execType === 'M' && order.px && market.restingFills ? market.restingFills(order.side, open, order.px) : market.book.walk(order.side, open, order.px ?? undefined));
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
    // OKX generates the attached orders only once the parent order is completely filled, for the whole order: a
    // partially filled order that is still resting has no stop and no take-profit.
    if (order.state === 'filled' && hasAttached(order)) this.ctx.orders.addAttached(order, now, false);
    if (fills.length > 0) {
      this.ctx.emit('trades', { instId: order.instId, trades });
      const push = market.book.delta(now);
      if (push) this.ctx.emit('books', { instId: order.instId, push });
      this.ctx.emit('candles', { instId: order.instId, candles: market.liveCandles() });
      this.pushPositions(order.instId, affected);
      this.pushAccount();
      this.dropOrphanStops(order.instId);
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
      subType: this.subType(o),
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

  /**
   * OKX's transaction type of a fill: 1 buy and 2 sell in net mode; 3 open long, 4 open short, 5 close long and
   * 6 close short in long/short mode. A liquidation is 106 (buy) or 107 (sell) in net mode, 104 (of a long) or
   * 105 (of a short) in long/short mode.
   */
  private subType(o: OrderRec): string {
    const liquidation = o.category === 'full_liquidation';
    if (o.posSide === 'net') return liquidation ? (o.side === 'buy' ? '106' : '107') : o.side === 'buy' ? '1' : '2';
    if (liquidation) return o.posSide === 'long' ? '104' : '105';
    const opening = (o.side === 'buy') === (o.posSide === 'long');
    return o.posSide === 'long' ? (opening ? '3' : '5') : opening ? '4' : '6';
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
    // Unverified: OKX documents only that a parent cancelled before any fill generates no stop. The simulator reads
    // that as "a parent cancelled after a partial fill generates the stop for what has filled"; whether the exchange
    // does so is to be confirmed on demo trading. Split take-profits generate nothing then (OrderStore.addAttached).
    if (hasAttached(order) && order.accFillSz.gt(0)) {
      this.ctx.orders.addAttached(order, order.uTime, true);
      this.dropOrphanStops(order.instId);
    }
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

  /** Places an algo order on its own for an open position (POST /api/v5/trade/order-algo): a TP/SL or a trailing stop. */
  placeAlgoRequest(body: unknown): OkxAlgoAck {
    const v = validatePlaceAlgo(body, this.ctx);
    if (isRejection(v)) {
      const raw = asRecord(body);
      return { algoId: '', algoClOrdId: raw ? (str(raw, 'algoClOrdId') ?? '') : '', sCode: v.sCode, sMsg: v.sMsg };
    }
    this.ctx.orders.addStandaloneStop(v);
    return { algoId: v.algoId, algoClOrdId: v.algoClOrdId, sCode: '0', sMsg: '' };
  }

  /**
   * Cancels one active stop (an item of POST /api/v5/trade/cancel-algos). OKX documents no code for an algo order
   * that does not exist; the simulator answers with the one of an ordinary order (51400).
   */
  cancelAlgoRequest(body: unknown): OkxAlgoAck {
    const raw = asRecord(body);
    const algoId = raw ? (str(raw, 'algoId') ?? '') : '';
    const algoClOrdId = raw ? (str(raw, 'algoClOrdId') ?? '') : '';
    const fail = (sCode: string, sMsg: string): OkxAlgoAck => ({ algoId, algoClOrdId, sCode, sMsg });
    if (!raw) return fail('51000', 'Parameter error');
    const instId = str(raw, 'instId') ?? '';
    if (!this.ctx.instruments.has(instId)) return fail('51001', 'Instrument ID does not exist.');
    if (algoId === '' && algoClOrdId === '') return fail('51000', 'Either algoId or algoClOrdId is required');
    const stop = this.ctx.orders.findStop(instId, algoId, algoClOrdId);
    if (!stop) return fail('51400', 'Cancellation failed as the order does not exist.');
    this.ctx.orders.removeStop(stop);
    return { algoId: stop.algoId, algoClOrdId: stop.algoClOrdId, sCode: '0', sMsg: '' };
  }

  /** Amends one active TP/SL order (POST /api/v5/trade/amend-algos); the new triggers are checked against the price at once. */
  amendAlgoRequest(body: unknown): OkxAlgoAck {
    const v = validateAmendAlgo(body, this.ctx);
    if (isRejection(v)) {
      const raw = asRecord(body);
      return { algoId: raw ? (str(raw, 'algoId') ?? '') : '', algoClOrdId: raw ? (str(raw, 'algoClOrdId') ?? '') : '', reqId: raw ? (str(raw, 'reqId') ?? '') : '', sCode: v.sCode, sMsg: v.sMsg };
    }
    const { stop } = v;
    if (v.newSlTriggerPx) stop.slTriggerPx = v.newSlTriggerPx;
    if (v.newSlOrdPx) stop.slOrdPx = v.newSlOrdPx;
    if (v.newSlTriggerPxType) stop.slTriggerPxType = v.newSlTriggerPxType;
    if (v.newTpTriggerPx) stop.tpTriggerPx = v.newTpTriggerPx;
    if (v.newTpOrdPx) stop.tpOrdPx = v.newTpOrdPx;
    if (v.newSz) stop.sz = v.newSz;
    stop.uTime = this.ctx.now();
    return { algoId: stop.algoId, algoClOrdId: stop.algoClOrdId, reqId: v.reqId, sCode: '0', sMsg: '' };
  }

  /** Re-checks resting limit orders against the (new) book; fills are maker fills. */
  matchResting(instId: string): void {
    const market = this.ctx.markets.get(instId);
    if (!market) return;
    for (const order of this.ctx.orders.liveOrders(instId)) {
      if (order.px && market.book.crosses(order.side, order.px)) this.execute(order, market, 'M');
    }
  }

  /**
   * Liquidates the isolated positions of an instrument whose liquidation price the mark price has reached (a long
   * at or below it, a short at or above it: OKX liquidates at a margin level of 100% or less). `range` is for the
   * replay of a time the exchange did not see: the lowest and the highest mark of a bar instead of the mark of
   * now. Returns how many positions were liquidated.
   */
  checkLiquidations(instId: string, range?: { low: Dec; high: Dec }): number {
    const market = this.ctx.markets.get(instId);
    if (!market) return 0;
    const low = range?.low ?? market.markPx;
    const high = range?.high ?? market.markPx;
    // A market that has no price yet (zero) liquidates nothing.
    if (low.lte(0)) return 0;
    let liquidated = 0;
    for (const p of this.ctx.account.all()) {
      if (p.instId !== instId) continue;
      const liqPx = this.ctx.account.liquidationPx(p);
      if (liqPx === null || (p.dir > 0 ? low.gt(liqPx) : high.lt(liqPx))) continue;
      // Of a replayed bar only the range is known: the mark that triggered it is taken to be the liquidation price.
      this.liquidate(p, range ? liqPx : market.markPx);
      liquidated++;
    }
    return liquidated;
  }

  /**
   * The exchange closes an isolated position, in OKX's order: the resting orders of the position are cancelled
   * (cancelSource 3), then all of it is taken over (see Account.liquidate), and its stops go with it. The account
   * sees what a real one would: the cancelled orders, a filled order of category `full_liquidation`, the position
   * at zero and the balance without the margin. The takeover is not a trade of the market: nothing is printed, the
   * order carries trade id 0 and its fill a negative one, and neither is a taker or a maker fill.
   *
   * Unverified: the order type and the reduce-only flag OKX gives its liquidation order; a reduce-only market
   * order is shown, like the closing order of a stop.
   */
  private liquidate(p: PositionRec, markPx: Dec): void {
    const now = this.ctx.now();
    for (const o of this.ctx.orders.liveOrders(p.instId)) {
      if (o.tdMode === p.mgnMode && o.posSide === p.posSide) this.cancel(o, CANCEL_LIQUIDATION, 'Risk cancellation was triggered. Pending order was canceled due to insufficient maintenance margin ratio and forced-liquidation risk.');
    }
    const sz = p.qty;
    const out = this.ctx.account.liquidate(p, markPx, now);
    const order: OrderRec = {
      ordId: this.ctx.orders.newOrdId(),
      clOrdId: '',
      tag: '',
      instId: p.instId,
      tdMode: p.mgnMode,
      side: p.dir > 0 ? 'sell' : 'buy',
      posSide: p.posSide,
      ordType: 'market',
      px: null,
      sz,
      accFillSz: sz,
      avgPx: out.px,
      state: 'filled',
      lever: p.lever,
      reduceOnly: true,
      fee: out.fee,
      pnl: out.pnl,
      cTime: now,
      uTime: now,
      cancelSource: '',
      cancelSourceReason: '',
      lastFill: { px: out.px, sz, time: now, tradeId: '0', execType: '', fee: out.fee, pnl: out.pnl },
      amendResult: '',
      reqId: '',
      attachSl: null,
      attachTps: [],
      category: 'full_liquidation',
    };
    const fill = this.fillWire(order, markPx, '');
    fill.tradeId = `-${fill.billId}`;
    this.ctx.orders.addFill(fill);
    this.ctx.orders.finish(order);
    this.ctx.emit('order', orderToWire(order, true));
    this.pushPositions(p.instId, out.position);
    this.pushAccount();
    this.dropOrphanStops(p.instId);
  }

  /** The position a stop protects, while it is still open in the stop's direction. */
  private stopPosition(stop: StopRec): PositionRec | undefined {
    const p = this.ctx.account.find(stop.instId, stop.tdMode, stop.posSide);
    return p && !p.qty.isZero() && p.dir === (stop.side === 'sell' ? 1 : -1) ? p : undefined;
  }

  /**
   * An algo order with cxlOnClosePos is dropped when its position is gone (OKX: "the TP/SL order will be canceled
   * when the position is fully closed"); one without stays (OKX: "will not be affected"), and so does a trailing
   * stop, which has no such flag. Unverified: OKX does not document what becomes of the orders generated from
   * attachAlgoOrds once the position is closed (docs/okx-api-notes.md 12, item 31); the simulator drops them.
   */
  private dropOrphanStops(instId: string): void {
    for (const stop of this.ctx.orders.activeStops(instId)) if (stop.cxlOnClosePos && !this.stopPosition(stop)) this.ctx.orders.removeStop(stop);
  }

  /**
   * Triggers the active algo orders the market has reached: a stop-loss or take-profit leg on the price its trigger
   * type names (the mark price for 'mark' and 'index', which the simulator does not model apart; the latest print for
   * 'last'), a trailing stop on the latest print. A triggered order closes its size, at most the position, with a
   * reduce-only market order, and is removed once that order is accepted. Of an oco order the stop-loss is looked at
   * first. An order that has not triggered and whose position is gone is dropped when it has cxlOnClosePos.
   */
  checkStops(instId: string): void {
    const market = this.ctx.markets.get(instId);
    if (!market) return;
    for (const stop of this.ctx.orders.activeStops(instId)) {
      // A close earlier in this loop may have ended it (its position, or the oco order it belonged to).
      if (!this.ctx.orders.hasStop(stop.algoId)) continue;
      const leg = this.triggeredLeg(stop, market);
      if (leg === null) {
        if (stop.cxlOnClosePos && !this.stopPosition(stop)) this.ctx.orders.removeStop(stop);
        continue;
      }
      this.fireStop(stop, undefined, leg);
    }
  }

  /** The leg of an algo order the market has reached now, if any. A trailing stop is moved along (and activated) first. */
  private triggeredLeg(stop: StopRec, market: Market): AlgoLeg | null {
    if (stop.ordType === 'move_order_stop') return this.trail(stop, market.lastPx) ? 'trail' : null;
    const sells = stop.side === 'sell';
    const priceOf = (type: StopRec['slTriggerPxType']): Dec => (type === 'last' ? market.lastPx : market.markPx);
    // A market that has no price yet (zero) triggers nothing.
    if (stop.slTriggerPx) {
      const px = priceOf(stop.slTriggerPxType);
      if (px.gt(0) && (sells ? px.lte(stop.slTriggerPx) : px.gte(stop.slTriggerPx))) return 'sl';
    }
    if (stop.tpTriggerPx) {
      const px = priceOf(stop.tpTriggerPxType);
      if (px.gt(0) && (sells ? px.gte(stop.tpTriggerPx) : px.lte(stop.tpTriggerPx))) return 'tp';
    }
    return null;
  }

  /**
   * Moves a trailing stop along with the latest print and says whether that print has reached its trigger. The help
   * center's rules: it is activated once the latest price reaches the activation price (at once without one); from
   * then on it keeps the highest price (a stop that sells; the lowest, one that buys) and triggers when the latest
   * price is at or below highest x (1 - callbackRatio) (at or above lowest x (1 + callbackRatio); or the extreme less
   * or plus callbackSpread).
   */
  trail(stop: StopRec, px: Dec): boolean {
    if (px.lte(0)) return false;
    const sells = stop.side === 'sell';
    if (stop.extremePx === null) {
      if (stop.activePx !== null && (sells ? px.lt(stop.activePx) : px.gt(stop.activePx))) return false;
      stop.extremePx = px;
      stop.uTime = this.ctx.now();
      return false;
    }
    if (sells ? px.gt(stop.extremePx) : px.lt(stop.extremePx)) {
      stop.extremePx = px;
      stop.uTime = this.ctx.now();
    }
    const trigger = trailingTrigger(stop);
    return trigger !== null && (sells ? px.lte(trigger) : px.gte(trigger));
  }

  /**
   * Sends the closing order of a triggered algo order: its size, at most the position, as a reduce-only market order
   * (filled at `fillPx` when given, see place). The order is removed once that order is accepted; when its position
   * is gone the trigger fails (OKX: order_failed) and the order ends without closing anything. Returns whether it
   * closed anything. The first take-profit leg of split take-profits that closes moves the cost-price stop of the
   * same order to the order's average fill price.
   */
  fireStop(stop: StopRec, fillPx?: Dec, leg: AlgoLeg = 'sl'): boolean {
    const position = this.stopPosition(stop);
    if (!position) {
      this.ctx.orders.removeStop(stop);
      return false;
    }
    const params: Record<string, unknown> = {
      instId: stop.instId,
      tdMode: stop.tdMode,
      side: stop.side,
      ordType: 'market',
      sz: fmt(stop.sz.lt(position.qty) ? stop.sz : position.qty),
      reduceOnly: true,
    };
    if (stop.posSide !== 'net') params['posSide'] = stop.posSide;
    // Removed before the close is sent, so that the close cannot find it again (an oco order ends with either leg);
    // put back when the close is refused: the position must not be left unprotected, and it is tried again on the
    // next price instead of vanishing as if it had fired.
    this.ctx.orders.removeStop(stop);
    if (this.place(params, fillPx).sCode !== '0') {
      if (this.stopPosition(stop)) this.ctx.orders.addStandaloneStop(stop);
      return false;
    }
    if (leg === 'tp') this.afterTakeProfit(stop);
    return true;
  }

  /**
   * The cost-price stop (amendPxOnTriggerType '1' on the stop-loss of split take-profits): "Whether slTriggerPx will
   * move to avgPx when the first TP order is triggered". The stop-loss of the take-profit's order moves to that
   * order's average fill price, once, wherever it was.
   */
  private afterTakeProfit(tp: StopRec): void {
    if (tp.ordId === '') return;
    const now = this.ctx.now();
    for (const s of this.ctx.orders.activeStops(tp.instId)) {
      if (s.ordId !== tp.ordId || !s.amendPxOnTriggerType || s.slTriggerPx === null || s.costPx === null) continue;
      s.slTriggerPx = s.costPx;
      s.amendPxOnTriggerType = false;
      s.uTime = now;
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
