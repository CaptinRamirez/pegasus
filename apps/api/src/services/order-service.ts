import { randomBytes } from 'node:crypto';
import { OkxApiError, OkxWsError, type OkxCancelOrderParams, type OkxOrder, type OkxOrderAck, type OkxPlaceOrderParams } from '@pegasus/okx';
import {
  D,
  normalizePrice,
  notionalQuote,
  sizeToContracts,
  SizingError,
  type CancelOrderRequest,
  type ClosePositionRequest,
  type Order,
  type OrderPreview,
  type PlaceOrderRequest,
  type PosSide,
  type TdMode,
} from '@pegasus/shared';
import type { Store } from '../db/store.js';
import { AppError, RiskRejectedError } from '../errors.js';
import type { Logger } from '../logger.js';
import type { OkxClients } from '../okx/clients.js';
import type { AccountService } from './account.js';
import type { MarketDataService } from './market-data.js';
import type { RiskEngine } from './risk-engine.js';

const CL_ORD_PREFIX = 'pg';

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
  return new AppError('INTERNAL', (err as Error).message, 500);
}

/**
 * Turns user intents into exchange orders: sizing, price normalisation,
 * position-mode handling, risk checks and submission (WebSocket when the
 * private socket is ready, REST otherwise).
 */
export class OrderService {
  constructor(
    private readonly clients: OkxClients,
    private readonly market: MarketDataService,
    private readonly account: AccountService,
    private readonly risk: RiskEngine,
    private readonly store: Store,
    private readonly log: Logger,
    private readonly opts: { defaultTdMode: TdMode; wsTrading: boolean },
  ) {}

  async preview(req: PlaceOrderRequest): Promise<OrderPreview> {
    const inst = this.market.requireInstrument(req.instId);
    const tdMode = req.tdMode ?? this.opts.defaultTdMode;
    const posSide = this.resolvePosSide(req);
    // OKX only honours reduceOnly in net mode; in long/short mode the flag is not forwarded, so the
    // risk engine must not trust it either (closing orders are recognised there by side + posSide).
    const longShort = this.account.config.posMode === 'long_short_mode';
    const reduceOnly = !longShort && (req.reduceOnly ?? false);

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
      // Fail closed: without a synced book the slippage rule cannot run, so a market order is refused.
      if (!est) throw new AppError('NO_BOOK', `order book for ${req.instId} is not synced yet; retry shortly`, 503);
      estSlippagePct = est.slippagePct;
      refPrice = est.avgPx;
      if (!est.complete) estSlippagePct = D(estSlippagePct).plus(1).toFixed(); // force a rejection: book too thin
    }
    const notional = notionalQuote(sized.sz, refPrice, inst).toFixed();
    let lever = '1';
    if (this.account.enabled) {
      try {
        lever = await this.account.leverageFor(req.instId, tdMode, posSide);
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
      instrumentOf: (id) => this.market.getInstrument(id),
    });
    return { instId: req.instId, side: req.side, ordType: req.ordType, tdMode, posSide, sz: sized.sz, coin: sized.coin.toFixed(), px, refPrice, notionalQuote: notional, estSlippagePct, lever, risk };
  }

  async place(req: PlaceOrderRequest): Promise<{ order: Order; preview: OrderPreview }> {
    this.account.requireReady();
    const preview = await this.preview(req);
    if (!preview.risk.ok) {
      this.log.warn({ req, risk: preview.risk }, 'order rejected by risk engine');
      void this.store.addRiskEvent('ORDER_REJECTED', { req, risk: preview.risk });
      throw new RiskRejectedError(preview.risk);
    }
    const clOrdId = req.clOrdId ?? generateClOrdId();
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
    if (this.account.config.posMode === 'long_short_mode') params.posSide = preview.posSide;
    else if (req.reduceOnly) params.reduceOnly = true;

    const t0 = Date.now();
    let ack: OkxOrderAck;
    try {
      ack = await this.submit(params);
    } catch (err) {
      this.log.warn({ params, err: (err as Error).message }, 'order submit failed');
      throw exchangeError(err);
    }
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
        if (err instanceof OkxApiError) throw err;
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
      if (err instanceof OkxApiError) throw err;
      // transport failure (timeout, reset): the exchange may or may not have the order
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
    throw new AppError('ORDER_STATUS_UNKNOWN', 'the exchange did not acknowledge the order; it may still be live. Check open orders before retrying', 504, { clOrdId: clOrdId ?? '' });
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
    this.account.requireReady();
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

  async cancelAll(instId?: string): Promise<number> {
    this.account.requireReady();
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
    this.account.requireReady();
    this.market.requireInstrument(req.instId);
    const posSide = this.account.config.posMode === 'long_short_mode' ? req.posSide : undefined;
    if (this.account.config.posMode === 'long_short_mode' && (posSide === undefined || posSide === 'net')) {
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

  private resolvePosSide(req: PlaceOrderRequest): PosSide {
    if (this.account.config.posMode !== 'long_short_mode') return 'net';
    if (req.posSide === 'long' || req.posSide === 'short') return req.posSide;
    throw new AppError('VALIDATION', 'posSide (long|short) is required because the account is in long/short position mode');
  }
}
