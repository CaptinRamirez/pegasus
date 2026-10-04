import { randomBytes } from 'node:crypto';
import { OkxApiError, OkxTransportError, OkxWsError, type OkxCancelOrderParams, type OkxOrder, type OkxOrderAck, type OkxPlaceOrderParams } from '@pegasus/okx';
import {
  contractsToCoin,
  D,
  Decimal,
  normalizePrice,
  notionalQuote,
  sizeToContracts,
  SizingError,
  type CancelOrderRequest,
  type ClosePositionRequest,
  type Instrument,
  type Order,
  type OrderPreview,
  type PlaceOrderRequest,
  type Position,
  type PosSide,
  type TdMode,
} from '@pegasus/shared';
import type { Store } from '../db/store.js';
import { AppError, ExchangeUnreachableError, RiskRejectedError } from '../errors.js';
import type { Logger } from '../logger.js';
import type { OkxClients } from '../okx/clients.js';
import { mapOrder } from '../okx/mappers.js';
import type { AccountService } from './account.js';
import type { MarketDataService } from './market-data.js';
import { isClosingOrder, type ExposureReservation, type RiskEngine } from './risk-engine.js';

const CL_ORD_PREFIX = 'pg';
/** Longest an accepted order is held against the limits while the account mirror has not shown its effect. */
const RESERVATION_TTL_MS = 10_000;
/** How many submitted client order ids are remembered for the retry lookup. */
const MAX_SENT_IDS = 200;

interface Reservation extends ExposureReservation {
  /** USD notional of the whole order; `notional` shrinks to the unfilled part once the positions show a partial fill. */
  full: string;
  /**
   * Local time after which it no longer counts, whatever happened: a reservation can never leak. Infinity while
   * the submit is in flight (the submit always settles); the clock starts when it does.
   */
  expiresAt: number;
  /** Exchange time of the order's terminal push; null while the order may still fill. */
  closedAt: number | null;
  /** Latest partial fill the positions have not shown yet: its exchange time and the notional still unfilled after it. */
  partial: { at: number; remainder: string } | null;
}

export function generateClOrdId(now = Date.now()): string {
  // 2 + 9 + 8 = 19 alphanumeric chars, well under OKX's 32 limit
  return `${CL_ORD_PREFIX}${now.toString(36)}${randomBytes(5).toString('hex').slice(0, 8)}`;
}

/** Translate OKX order errors into API errors with the exchange code attached. */
export function exchangeError(err: unknown): AppError {
  if (err instanceof OkxApiError) {
    return new AppError('EXCHANGE', err.okxMessage || err.message, err.isRateLimited ? 429 : 502, { okxCode: err.code, okxMsg: err.okxMessage });
  }
  if (err instanceof AppError) return err;
  if (err instanceof OkxTransportError) return new ExchangeUnreachableError(err);
  return new AppError('INTERNAL', (err as Error).message, 500);
}

/**
 * Turns user intents into exchange orders: sizing, price normalisation,
 * position-mode handling, risk checks and submission (WebSocket when the
 * private socket is ready, REST otherwise).
 */
export class OrderService {
  /**
   * Opening orders that passed the risk check, by clOrdId. The orders and positions pushes of a fill arrive
   * after the order is accepted, in either order; until the positions show it the next order is checked
   * against these as well as the mirror.
   */
  private readonly reservations = new Map<string, Reservation>();
  /**
   * Client order ids that went to the exchange and were not definitely refused, oldest first, with their
   * instrument. OKX frees a clOrdId once its order is filled or cancelled, so a retry under the same id is
   * refused as a duplicate only while the first order still rests; an id seen here is looked up before it is sent again.
   */
  private readonly sentIds = new Map<string, string>();

  constructor(
    private readonly clients: OkxClients,
    private readonly market: MarketDataService,
    private readonly account: AccountService,
    private readonly risk: RiskEngine,
    private readonly store: Store,
    private readonly log: Logger,
    private readonly opts: { defaultTdMode: TdMode; wsTrading: boolean },
  ) {
    this.account.on('order', (order) => this.onOrderUpdate(order));
    this.account.on('positions', (positions) => this.onPositions(positions));
  }

  preview(req: PlaceOrderRequest): Promise<OrderPreview> {
    return this.evaluate(req);
  }

  /**
   * Size, price and risk-check an order. With `placeAs` (the clOrdId it is about to be submitted under) the
   * leverage is read fresh and an accepted opening order is reserved against the limits in the same
   * synchronous step as its check, so two concurrent orders can never both pass on the same snapshot.
   */
  private async evaluate(req: PlaceOrderRequest, placeAs?: string): Promise<OrderPreview> {
    const inst = this.market.requireInstrument(req.instId);
    const tdMode = req.tdMode ?? this.opts.defaultTdMode;
    // An unknown position mode is never assumed to be net mode: the order would be built for the wrong account.
    const longShort = this.account.requireConfig().posMode === 'long_short_mode';
    const posSide = this.resolvePosSide(req, longShort);
    // OKX only honours reduceOnly in net mode; in long/short mode the flag is not forwarded, so the
    // risk engine must not trust it either (closing orders are recognised there by side + posSide).
    const reduceOnly = !longShort && (req.reduceOnly ?? false);
    // Exits skip the leverage and slippage rules, so they must not wait for (or fail on) the inputs of those rules:
    // an exit matters most exactly when the leverage lookup fails or the book is resyncing.
    const closing = isClosingOrder({ posSide, side: req.side, reduceOnly });

    let px = '';
    let refPrice: string | undefined;
    if (req.ordType === 'market') {
      refPrice = this.market.bestPrice(req.instId, req.side) ?? this.market.refPrice(req.instId);
    } else {
      if (req.px === undefined) throw new AppError('VALIDATION', 'px is required for limit orders');
      px = normalizePrice(req.px, inst, req.side);
      refPrice = px;
    }
    if (refPrice === undefined) throw new AppError('NO_PRICE', `no market price available yet for ${req.instId}`, 503);

    let sized;
    try {
      sized = sizeToContracts(req.size, inst, req.ordType, refPrice);
    } catch (err) {
      if (err instanceof SizingError) throw new AppError('SIZING', err.message, 400, { code: err.code });
      throw err;
    }

    let estSlippagePct = '';
    if (req.ordType === 'market') {
      const est = this.market.estimateMarketFill(req.instId, req.side, sized.sz);
      // Fail closed: without a synced book the slippage rule cannot run, so an opening market order is refused.
      if (!est && !closing) throw new AppError('NO_BOOK', `order book for ${req.instId} is not synced yet; retry shortly`, 503);
      if (est) {
        estSlippagePct = est.slippagePct;
        refPrice = est.avgPx;
        if (!est.complete) estSlippagePct = D(estSlippagePct).plus(1).toFixed(); // force a rejection: book too thin
      }
    }
    const notional = notionalQuote(sized.sz, refPrice, inst).toFixed();
    let lever = '1';
    if (closing) {
      lever = '';
    } else if (this.account.enabled) {
      try {
        lever = await this.account.leverageFor(req.instId, tdMode, posSide, placeAs !== undefined);
      } catch (err) {
        // Fail closed: the leverage rule must not pass on an unknown value.
        throw new AppError('LEVERAGE_UNAVAILABLE', `could not read the leverage for ${req.instId}: ${(err as Error).message}`, 503);
      }
    }
    const markRef = this.market.refPrice(req.instId);
    if (markRef === undefined) throw new AppError('NO_PRICE', `no reference price available yet for ${req.instId}`, 503);
    const risk = this.risk.check({
      inst,
      side: req.side,
      posSide,
      ordType: req.ordType,
      contracts: sized.sz,
      notional,
      px,
      refPrice: markRef,
      lever,
      estSlippagePct,
      reduceOnly,
      positions: this.account.positionList(),
      openOrders: this.account.openOrderList(),
      // A retry under the same clOrdId is the same order, not a second one.
      reservations: this.liveReservations(placeAs ?? req.clOrdId),
      instrumentOf: (id) => this.market.specOf(id),
    });
    // No await between the check above and this line.
    if (placeAs !== undefined && risk.ok && !closing) {
      this.reservations.set(placeAs, { clOrdId: placeAs, instId: req.instId, side: req.side, posSide, notional, full: notional, expiresAt: Infinity, closedAt: null, partial: null });
    }
    return { instId: req.instId, side: req.side, ordType: req.ordType, tdMode, posSide, sz: sized.sz, coin: sized.coin.toFixed(), px, refPrice, notionalQuote: notional, estSlippagePct, lever, risk };
  }

  private startReservationClock(clOrdId: string): void {
    const reservation = this.reservations.get(clOrdId);
    if (reservation) reservation.expiresAt = Date.now() + RESERVATION_TTL_MS;
  }

  /** Reservations still in force; expired ones are dropped here, so no timer or event is needed to bound them. */
  private liveReservations(except?: string): ExposureReservation[] {
    const now = Date.now();
    const live: ExposureReservation[] = [];
    for (const [clOrdId, r] of this.reservations) {
      if (r.expiresAt <= now) this.reservations.delete(clOrdId);
      else if (clOrdId !== except) live.push(r);
    }
    return live;
  }

  private onOrderUpdate(order: Order): void {
    const r = this.reservations.get(order.clOrdId);
    if (!r || order.state === 'live') return;
    const filled = D(order.accFillSz || '0');
    if (order.state === 'partially_filled') {
      const sz = D(order.sz);
      if (filled.isZero() || sz.lte(0)) return;
      r.partial = { at: order.uTime, remainder: Decimal.max(D(r.full).times(sz.minus(filled)).div(sz), 0).toFixed() };
    } else if (filled.isZero()) {
      // Cancelled without a fill: nothing will reach the positions.
      this.reservations.delete(order.clOrdId);
      return;
    } else {
      r.closedAt = order.uTime;
    }
    // The positions push of this fill may have arrived before the order push.
    this.releaseShown(order.clOrdId, r, this.account.positionList());
  }

  private onPositions(positions: Position[]): void {
    for (const [clOrdId, r] of this.reservations) this.releaseShown(clOrdId, r, positions);
  }

  /**
   * Stop counting what the positions already show: the whole reservation once its order is terminal, the filled
   * part of a partial fill. Only a position of the order's own leg, updated at or after that fill, proves it;
   * until one is seen the fill is in neither the mirror nor the resting order and must stay reserved.
   */
  private releaseShown(clOrdId: string, r: Reservation, positions: Position[]): void {
    const shownSince = (at: number): boolean => positions.some((p) => p.instId === r.instId && p.posSide === r.posSide && p.uTime >= at);
    if (r.closedAt !== null) {
      if (shownSince(r.closedAt)) this.reservations.delete(clOrdId);
    } else if (r.partial && shownSince(r.partial.at)) {
      r.notional = r.partial.remainder;
      r.partial = null;
    }
  }

  async place(req: PlaceOrderRequest): Promise<{ order: Order; preview: OrderPreview }> {
    const config = this.account.requireTrading();
    const clOrdId = req.clOrdId ?? generateClOrdId();
    // The page marks its retries as well: this memory does not survive a restart, and a restart in mid-request
    // is exactly how a reply gets lost.
    if (this.sentIds.get(clOrdId) === req.instId || (req.retry === true && req.clOrdId !== undefined)) {
      const inst = this.market.requireInstrument(req.instId);
      const earlier = await this.findEarlierAttempt(req.instId, clOrdId);
      if (earlier) {
        this.log.warn({ ordId: earlier.ordId, clOrdId, state: earlier.state }, 'retry of an order that already reached the exchange; nothing sent');
        return { order: earlier, preview: this.previewOfExisting(earlier, inst) };
      }
    }
    const preview = await this.evaluate(req, clOrdId);
    if (!preview.risk.ok) {
      this.log.warn({ req, risk: preview.risk }, 'order rejected by risk engine');
      void this.store.addRiskEvent('ORDER_REJECTED', { req, risk: preview.risk });
      throw new RiskRejectedError(preview.risk);
    }
    const params: OkxPlaceOrderParams = {
      instId: preview.instId,
      tdMode: preview.tdMode,
      side: preview.side,
      ordType: preview.ordType,
      sz: preview.sz,
      clOrdId,
      tag: 'pegasus',
    };
    if (preview.ordType !== 'market') params.px = preview.px;
    if (config.posMode === 'long_short_mode') params.posSide = preview.posSide;
    else if (req.reduceOnly) params.reduceOnly = true;

    const t0 = Date.now();
    this.rememberSent(clOrdId, req.instId);
    let ack: OkxOrderAck;
    try {
      ack = await this.submit(params);
    } catch (err) {
      this.log.warn({ params, err: (err as Error).message }, 'order submit failed');
      // A definite refusal frees the reservation. An unknown outcome keeps it for the full time from now (the
      // submit and the lookup may have taken longer than that), and so does a duplicate clOrdId (51016): that
      // is the answer to a retry whose first attempt did arrive and still rests.
      if (err instanceof OkxApiError && err.code !== '51016') {
        this.reservations.delete(clOrdId);
        this.sentIds.delete(clOrdId);
      } else this.startReservationClock(clOrdId);
      throw exchangeError(err);
    }
    // The clock of the reservation starts at the acknowledgement, not at the submit.
    this.startReservationClock(clOrdId);
    this.log.info({ ordId: ack.ordId, clOrdId, instId: params.instId, side: params.side, ordType: params.ordType, sz: params.sz, px: params.px, latencyMs: Date.now() - t0 }, 'order accepted');
    const order: Order = {
      ordId: ack.ordId,
      clOrdId,
      instId: preview.instId,
      side: preview.side,
      posSide: preview.posSide,
      tdMode: preview.tdMode,
      ordType: preview.ordType,
      px: preview.px,
      sz: preview.sz,
      accFillSz: '0',
      avgPx: '',
      state: 'live',
      reduceOnly: params.reduceOnly ?? false,
      lever: preview.lever,
      fee: '0',
      feeCcy: '',
      pnl: '0',
      cTime: t0,
      uTime: t0,
    };
    // Journal the synthetic 'live' row only when the fill push has not already recorded a newer state.
    if (this.account.noteLocalOrder(order)) void this.store.upsertOrder(order).catch(() => undefined);
    return { order, preview };
  }

  private rememberSent(clOrdId: string, instId: string): void {
    this.sentIds.delete(clOrdId);
    this.sentIds.set(clOrdId, instId);
    if (this.sentIds.size > MAX_SENT_IDS) {
      const oldest = this.sentIds.keys().next();
      if (!oldest.done) this.sentIds.delete(oldest.value);
    }
  }

  /**
   * The order an earlier submit under this clOrdId left at the exchange, in whatever state it is now; null only
   * when OKX says it does not exist (51603). Any other answer leaves the outcome unknown, and nothing may be sent.
   */
  private async findEarlierAttempt(instId: string, clOrdId: string): Promise<Order | null> {
    try {
      return mapOrder(await this.clients.rest.getOrder({ instId, clOrdId }));
    } catch (err) {
      if (err instanceof OkxApiError && err.code === '51603') return null;
      this.log.warn({ err: (err as Error).message, clOrdId }, 'lookup of the earlier attempt failed; the retry is not sent');
      throw new AppError('ORDER_STATUS_UNKNOWN', 'the earlier attempt could not be looked up, so this retry was not sent; it may have filled or still be live. Check positions, fills and open orders before retrying', 504, { clOrdId });
    }
  }

  /** The preview of an order that is already at the exchange, from its own values: no rule is checked again. */
  private previewOfExisting(order: Order, inst: Instrument): OrderPreview {
    const refPrice = [order.avgPx, order.px, this.market.refPrice(order.instId) ?? ''].find((p) => p !== '') ?? '';
    return {
      instId: order.instId,
      side: order.side,
      ordType: order.ordType,
      tdMode: order.tdMode,
      posSide: order.posSide,
      sz: order.sz,
      coin: refPrice === '' ? '' : contractsToCoin(order.sz, inst, refPrice).toFixed(),
      px: order.px,
      refPrice,
      notionalQuote: refPrice === '' ? '' : notionalQuote(order.sz, refPrice, inst).toFixed(),
      estSlippagePct: '',
      lever: order.lever,
      risk: { ok: true, code: 'OK', message: 'already at the exchange; nothing was sent' },
    };
  }

  /**
   * Submit the order. A request that provably never left this process is retried on
   * the other transport; one whose outcome is unknown (timeout, socket lost after the
   * frame was sent) is NEVER resent: the order is looked up by clOrdId instead, so a
   * single click can never turn into two executions.
   */
  private async submit(params: OkxPlaceOrderParams): Promise<OkxOrderAck> {
    const ws = this.clients.wsPrivate;
    if (this.opts.wsTrading && ws?.isReady) {
      try {
        const res = await ws.request<OkxOrderAck>('order', [params], { timeoutMs: 5_000 });
        const ack = res.data[0];
        if (!ack) throw new OkxApiError(res.code, res.msg || 'empty order response', 'ws:order');
        if (ack.sCode !== '0') throw new OkxApiError(ack.sCode, ack.sMsg, 'ws:order', ack);
        return ack;
      } catch (err) {
        if (err instanceof OkxApiError && !err.isOutcomeUnknown) throw err;
        if (err instanceof OkxWsError && !err.sent) {
          this.log.warn({ err: err.message }, 'ws order op not sent; falling back to REST');
          return this.submitRest(params);
        }
        this.log.warn({ err: (err as Error).message, clOrdId: params.clOrdId }, 'ws order op outcome unknown; looking the order up');
        return this.resolveUnknownOutcome(params);
      }
    }
    return this.submitRest(params);
  }

  private async submitRest(params: OkxPlaceOrderParams): Promise<OkxOrderAck> {
    try {
      return await this.clients.rest.placeOrder(params);
    } catch (err) {
      if (err instanceof OkxApiError && !err.isOutcomeUnknown) throw err;
      // transport failure (timeout, reset) or a timeout inside OKX (50004, 51149): the exchange may or may not have the order
      this.log.warn({ err: (err as Error).message, clOrdId: params.clOrdId }, 'REST order outcome unknown; looking the order up');
      return this.resolveUnknownOutcome(params);
    }
  }

  private async resolveUnknownOutcome(params: OkxPlaceOrderParams): Promise<OkxOrderAck> {
    const clOrdId = params.clOrdId;
    if (clOrdId) {
      const found = await this.lookupByClOrdId(params.instId, clOrdId);
      if (found) return { ordId: found.ordId, clOrdId: found.clOrdId, tag: found.tag ?? '', sCode: '0', sMsg: '' };
    }
    throw new AppError('ORDER_STATUS_UNKNOWN', 'the exchange did not acknowledge the order; it may have filled or still be live. Check positions, fills and open orders before retrying', 504, { clOrdId: clOrdId ?? '' });
  }

  /** Poll GET /trade/order by clOrdId for a few seconds; null when OKX reports it does not exist. */
  private async lookupByClOrdId(instId: string, clOrdId: string): Promise<OkxOrder | null> {
    for (let attempt = 0; attempt < 6; attempt++) {
      try {
        return await this.clients.rest.getOrder({ instId, clOrdId });
      } catch (err) {
        if (err instanceof OkxApiError && (err.code === '51603' || err.code === '51000')) {
          await new Promise((r) => setTimeout(r, 500));
          continue;
        }
        this.log.warn({ err: (err as Error).message }, 'order lookup failed');
        await new Promise((r) => setTimeout(r, 500));
      }
    }
    return null;
  }

  async cancel(req: CancelOrderRequest): Promise<OkxOrderAck> {
    this.account.requireRestTrading();
    const params: OkxCancelOrderParams = { instId: req.instId };
    if (req.ordId !== undefined) params.ordId = req.ordId;
    else if (req.clOrdId !== undefined) params.clOrdId = req.clOrdId;
    try {
      const ws = this.clients.wsPrivate;
      if (this.opts.wsTrading && ws?.isReady) {
        const res = await ws.request<OkxOrderAck>('cancel-order', [params], { timeoutMs: 5_000 });
        const ack = res.data[0];
        if (ack && ack.sCode === '0') return ack;
        if (ack) throw new OkxApiError(ack.sCode, ack.sMsg, 'ws:cancel-order', ack);
      }
      return await this.clients.rest.cancelOrder(params);
    } catch (err) {
      throw exchangeError(err);
    }
  }

  /** Cancels the open orders the account mirror knows; returns how many cancel requests the exchange accepted. */
  async cancelAll(instId?: string): Promise<number> {
    this.account.requireRestTrading();
    const targets = this.account.openOrderList().filter((o) => instId === undefined || o.instId === instId);
    let canceled = 0;
    for (let i = 0; i < targets.length; i += 20) {
      const batch = targets.slice(i, i + 20).map((o) => ({ instId: o.instId, ordId: o.ordId }));
      try {
        const acks = await this.clients.rest.cancelBatchOrders(batch);
        canceled += acks.filter((a) => a.sCode === '0').length;
        // An order that is no longer live (filled or already cancelled) is reported per item; that is not a failure of the sweep.
        for (const a of acks) if (a.sCode !== '0') this.log.info({ ordId: a.ordId, sCode: a.sCode, sMsg: a.sMsg }, 'cancel skipped');
      } catch (err) {
        throw exchangeError(err);
      }
    }
    return canceled;
  }

  async closePosition(req: ClosePositionRequest): Promise<{ instId: string; posSide: PosSide }> {
    // No instrument lookup: a position opened on OKX in an instrument this server does not track must be closable too.
    const longShort = this.account.requireRestTrading().posMode === 'long_short_mode';
    const posSide = longShort ? req.posSide : undefined;
    if (longShort && (posSide === undefined || posSide === 'net')) {
      throw new AppError('VALIDATION', 'posSide (long|short) is required to close a position in long/short mode');
    }
    const params: { instId: string; mgnMode: TdMode; posSide?: 'long' | 'short'; autoCxl: boolean; clOrdId: string } = { instId: req.instId, mgnMode: req.mgnMode, autoCxl: true, clOrdId: generateClOrdId() };
    if (posSide === 'long' || posSide === 'short') params.posSide = posSide;
    try {
      await this.clients.rest.closePosition(params);
    } catch (err) {
      throw exchangeError(err);
    }
    void this.store.addRiskEvent('CLOSE_POSITION', { instId: req.instId, posSide: posSide ?? 'net' });
    this.log.info({ instId: req.instId, posSide }, 'close-position submitted');
    return { instId: req.instId, posSide: posSide ?? 'net' };
  }

  private resolvePosSide(req: PlaceOrderRequest, longShort: boolean): PosSide {
    if (!longShort) return 'net';
    if (req.posSide === 'long' || req.posSide === 'short') return req.posSide;
    throw new AppError('VALIDATION', 'posSide (long|short) is required because the account is in long/short position mode');
  }
}
