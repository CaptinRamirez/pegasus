import { randomBytes } from 'node:crypto';
import { OkxApiError, OkxTransportError, OkxWsError, type OkxAttachAlgoOrd, type OkxCancelOrderParams, type OkxLeverageInfo, type OkxMarginBalance, type OkxOrder, type OkxOrderAck, type OkxPlaceAlgoParams, type OkxPlaceOrderParams, type OkxSetLeverageParams } from '@pegasus/okx';
import {
  algoOrderClosesPosition,
  ceilToStep,
  contractsToCoin,
  D,
  Decimal,
  floorToStep,
  isMultipleOf,
  normalizePrice,
  notionalQuote,
  positionDirection,
  SIGNAL_CL_ORD_PREFIX,
  sizeTakeProfitLegs,
  sizeToContracts,
  SizingError,
  stopCoverage,
  toPlainString,
  ZERO,
  type AlgoOrder,
  type AlgoOrderList,
  type AmendAlgoOrderRequest,
  type CancelAlgoOrderRequest,
  type CancelOrderRequest,
  type ClosePositionRequest,
  type Instrument,
  type Order,
  type OrderPreview,
  type PlaceOrderRequest,
  type PlaceStopRequest,
  type PlaceTakeProfitsRequest,
  type PlaceTakeProfitsResult,
  type PlaceTrailingStopRequest,
  type PlaceTrailingStopResult,
  type Position,
  type PosSide,
  type TakeProfitLegPreview,
  type TdMode,
} from '@pegasus/shared';
import type { Store } from '../db/store.js';
import { AppError, ExchangeUnreachableError, RiskRejectedError, UnknownInstrumentError } from '../errors.js';
import type { Logger } from '../logger.js';
import type { OkxClients } from '../okx/clients.js';
import { mapOrder } from '../okx/mappers.js';
import type { AccountService } from './account.js';
import type { MarketDataService } from './market-data.js';
import { isClosingOrder, type CampaignRiskContext, type ExitCheckInput, type ExposureReservation, type RiskCheckInput, type RiskEngine } from './risk-engine.js';

const CL_ORD_PREFIX = 'pg';
/** Longest an accepted order is held against the limits while the account mirror has not shown its effect. */
const RESERVATION_TTL_MS = 10_000;
/** Prefix of the client id of an attached stop-loss; the rest is the tail of the order's clOrdId. */
const ATTACH_SL_PREFIX = 'sl';
/** Prefix of the client id of a take-profit leg: `tp` + the leg's number (1 to 5) + the tail of an id. */
const TP_PREFIX = 'tp';
/** Prefix of the client id of a trailing stop (OKX move_order_stop) placed by Pegasus. */
const TRAIL_PREFIX = 'tr';
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

/** `prefix` tells who placed the order: `pg` the server, the campaign its own (CAMPAIGN_CL_ORD_PREFIX). */
export function generateClOrdId(now = Date.now(), prefix = CL_ORD_PREFIX): string {
  // 2 + 9 + 8 = 19 alphanumeric chars, well under OKX's 32 limit
  return `${prefix}${now.toString(36)}${randomBytes(5).toString('hex').slice(0, 8)}`;
}

/** Client id of the stop attached to an order, inside OKX's limit of 32 alphanumeric characters. */
export function attachAlgoClOrdIdFor(clOrdId: string): string {
  // The tail is kept: that is where a generated id carries its random part.
  return `${ATTACH_SL_PREFIX}${clOrdId.slice(-(32 - ATTACH_SL_PREFIX.length))}`;
}

/** Client id of take-profit leg `leg` (1-based) of an order or a request, inside OKX's limit of 32 alphanumeric characters. */
export function takeProfitAlgoClOrdIdFor(clOrdId: string, leg: number): string {
  const prefix = `${TP_PREFIX}${leg}`;
  return `${prefix}${clOrdId.slice(-(32 - prefix.length))}`;
}

/** Client id of a trailing stop placed by Pegasus. */
export function trailingAlgoClOrdIdFor(clOrdId: string): string {
  return `${TRAIL_PREFIX}${clOrdId.slice(-(32 - TRAIL_PREFIX.length))}`;
}

/**
 * Whether an algo order is one Pegasus placed, by its client id: a stop-loss (`sl`: attached to an entry or placed for
 * a position; `ch`: kept by channel trailing), a take-profit leg (`tp1`…`tp5`) or a trailing stop (`tr`).
 */
export function isPegasusExitAlgo(a: Pick<AlgoOrder, 'algoClOrdId'>): boolean {
  return /^(sl|ch|tr|tp[1-9])[A-Za-z0-9]/.test(a.algoClOrdId);
}

/** The take-profits, the cost-price stop and the trailing stops of this stage are refused outside paper trading and the local mock. */
export class ExitsUnavailableError extends AppError {
  constructor() {
    super('EXITS_UNAVAILABLE', 'take-profits, the cost-price stop and trailing stops are offered in paper trading and against the local mock only; nothing was sent', 403);
    this.name = 'ExitsUnavailableError';
  }
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
/** What place() reports once an order is at the exchange: sent now, or found there from an earlier attempt. */
export interface OrderPlacedEvent {
  request: PlaceOrderRequest;
  order: Order;
  /** True when a retry found the order an earlier attempt had left at the exchange; nothing was sent now */
  earlier: boolean;
}

export class OrderService {
  private readonly placedListeners: Array<(e: OrderPlacedEvent) => void> = [];
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
    /** `exits`: take-profits, the cost-price stop and trailing stops are offered (config.exits.enabled: paper trading and the local mock); refused with EXITS_UNAVAILABLE otherwise */
    private readonly opts: { defaultTdMode: TdMode; wsTrading: boolean; exits?: boolean },
  ) {
    this.account.on('order', (order) => this.onOrderUpdate(order));
    this.account.on('positions', (positions) => this.onPositions(positions));
  }

  /** Whether the exits of this stage are offered here (paper trading, the local mock). */
  get exitsEnabled(): boolean {
    return this.opts.exits === true;
  }

  /** `campaign` is for the campaign's own orders (CampaignOrders); a request of the terminal never carries one. */
  async preview(req: PlaceOrderRequest, campaign?: CampaignRiskContext): Promise<OrderPreview> {
    this.checkSource(req);
    return this.evaluate(req, undefined, campaign);
  }

  /**
   * An order that follows a signal carries the client id prefix `ps` (SIGNAL_CL_ORD_PREFIX), and only such an order
   * does: the journal and the exchange's order history tell the two apart by it. A clOrdId of the request that does not
   * fit is refused rather than rewritten, since the page retries under its own id.
   */
  private checkSource(req: PlaceOrderRequest): void {
    if (req.clOrdId === undefined) return;
    const signal = req.source === 'signal';
    if (signal !== req.clOrdId.startsWith(SIGNAL_CL_ORD_PREFIX)) {
      throw new AppError('VALIDATION', signal ? `an order that follows a signal needs a clOrdId starting with '${SIGNAL_CL_ORD_PREFIX}' (or none: the server makes one)` : `the clOrdId prefix '${SIGNAL_CL_ORD_PREFIX}' is for orders that follow a signal (source 'signal')`, 400, { clOrdId: req.clOrdId });
    }
  }

  /**
   * Size, price and risk-check an order. With `placeAs` (the clOrdId it is about to be submitted under) the
   * leverage is read fresh and an accepted opening order is reserved against the limits in the same
   * synchronous step as its check, so two concurrent orders can never both pass on the same snapshot.
   * With `campaign` the order is an isolated one of a campaign, checked on the leverage its position runs at.
   */
  private async evaluate(req: PlaceOrderRequest, placeAs?: string, campaign?: CampaignRiskContext): Promise<OrderPreview> {
    const inst = this.market.requireInstrument(req.instId);
    const tdMode = req.tdMode ?? this.opts.defaultTdMode;
    if (campaign && tdMode !== 'isolated') throw new AppError('VALIDATION', 'an order of a campaign is an isolated one');
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
    const stop = req.slTriggerPx === undefined ? null : this.attachedStop(req.slTriggerPx, req, inst, posSide, closing, sized.sz, refPrice);
    const exits = this.exitPlan(req, inst, posSide, closing, sized.sz, refPrice);
    // The stop is not an input of the risk check: it never relaxes a limit.
    const input: RiskCheckInput = {
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
    };
    if (campaign) input.campaign = campaign;
    let risk = this.risk.check(input);
    // The exits are checked once the order itself passes: the first violated rule is reported.
    if (risk.ok && exits.check) risk = this.risk.checkExits(exits.check);
    // No await between the checks above and this line.
    if (placeAs !== undefined && risk.ok && !closing) {
      this.reservations.set(placeAs, { clOrdId: placeAs, instId: req.instId, side: req.side, posSide, notional, full: notional, expiresAt: Infinity, closedAt: null, partial: null });
    }
    const preview: OrderPreview = { instId: req.instId, side: req.side, ordType: req.ordType, tdMode, posSide, sz: sized.sz, coin: sized.coin.toFixed(), px, refPrice, notionalQuote: notional, estSlippagePct, lever, slTriggerPx: stop?.slTriggerPx ?? '', stopLossQuote: stop?.stopLossQuote ?? '', risk };
    if (exits.legs) preview.takeProfits = exits.legs;
    return preview;
  }

  /**
   * The exits an opening order asks for: its take-profit legs, sized, and what the risk engine checks them with.
   * Refused outright (no risk verdict): outside paper trading and the local mock (EXITS_UNAVAILABLE); on an order that
   * closes, or in net mode reduces, a position (VALIDATION); the cost-price stop without a stop-loss and two legs
   * (BREAKEVEN_NEEDS_SPLIT_TP: OKX moves the stop-loss of split take-profits only, 51085); two legs with one trigger
   * (TP_TRIGGERS_NOT_DISTINCT: OKX 51081); a leg below the instrument's minimum size (TP_LEG_TOO_SMALL); no live mark
   * price (NO_PRICE). The legs are whole lots of the order's size and cover all of it: OKX refuses split take-profits
   * whose sizes do not add up to the order's (51083), so the last leg takes what the others leave.
   */
  private exitPlan(req: PlaceOrderRequest, inst: Instrument, posSide: PosSide, closing: boolean, sz: string, refPrice: string): { legs: TakeProfitLegPreview[] | null; check: ExitCheckInput | null } {
    if (req.takeProfits === undefined && req.breakevenAfterTp1 !== true && req.trailing === undefined) return { legs: null, check: null };
    if (!this.exitsEnabled) throw new ExitsUnavailableError();
    if (closing) throw new AppError('VALIDATION', 'take-profits and trailing exits can only accompany an order that opens a position');
    const buy = req.side === 'buy';
    const reduces = posSide === 'net' && this.account.positionList().some((p) => p.instId === req.instId && p.posSide === 'net' && (buy ? D(p.pos || '0').lt(0) : D(p.pos || '0').gt(0)));
    if (reduces) throw new AppError('VALIDATION', `take-profits and trailing exits can only accompany an order that opens a position: this ${req.side} order reduces the open net ${buy ? 'short' : 'long'} position of ${req.instId}`);
    const legsAsked = req.takeProfits ?? [];
    if (req.breakevenAfterTp1 === true && (req.slTriggerPx === undefined || legsAsked.length < 2)) {
      throw new AppError('BREAKEVEN_NEEDS_SPLIT_TP', 'the cost-price stop (breakevenAfterTp1) needs a stop-loss (slTriggerPx) and two take-profits or more: OKX moves the stop-loss of split take-profits only', 400, { takeProfits: legsAsked.length, slTriggerPx: req.slTriggerPx ?? '' });
    }
    const markPx = this.market.liveMarkPrice(req.instId);
    if (markPx === undefined) throw new AppError('NO_PRICE', `no live mark price for ${req.instId}: mark-triggered take-profits and trailing exits cannot be checked against it; retry shortly`, 503);
    const check: ExitCheckInput = { direction: buy ? 'long' : 'short', entryPx: refPrice, markPx };
    let legs: TakeProfitLegPreview[] | null = null;
    if (legsAsked.length > 0) {
      // Rounded to the tick towards the entry (down for a long, up for a short): the smaller profit.
      const triggers = legsAsked.map((leg) => (buy ? floorToStep(leg.triggerPx, inst.tickSz) : ceilToStep(leg.triggerPx, inst.tickSz)));
      if (triggers.some((t) => t.lte(0))) throw new AppError('VALIDATION', 'a take-profit trigger rounds to zero at this tick size');
      const distinct = new Set(triggers.map((t) => t.toFixed()));
      if (distinct.size < triggers.length) throw new AppError('TP_TRIGGERS_NOT_DISTINCT', 'two take-profit legs have the same trigger once rounded to the tick; OKX refuses that (51081)', 400, { triggers: triggers.map((t) => toPlainString(t, inst.tickSz)) });
      const sizes = sizeTakeProfitLegs(legsAsked.map((leg) => leg.fraction), sz, inst.lotSz, 'whole');
      sizes.forEach((legSz, i) => {
        if (legSz.lt(inst.minSz) || legSz.lte(0)) {
          throw new AppError('TP_LEG_TOO_SMALL', `take-profit ${i + 1} comes to ${legSz.toFixed()} of the order's ${sz} contracts, below the instrument's minimum of ${inst.minSz}: fewer legs, or a larger order`, 400, { leg: i + 1, sz: legSz.toFixed(), minSz: inst.minSz, orderSz: sz });
        }
      });
      legs = triggers.map((t, i) => {
        const legSz = sizes[i] ?? ZERO;
        return { triggerPx: toPlainString(t, inst.tickSz), fraction: legsAsked[i]?.fraction ?? '', sz: legSz.toFixed(), profitQuote: contractsToCoin(legSz, inst, refPrice).mul(t.minus(refPrice).abs()).toFixed() };
      });
      check.takeProfits = legs.map((l) => l.triggerPx);
    }
    if (req.trailing?.kind === 'callback') {
      check.callbackRatio = req.trailing.ratio;
      if (req.trailing.activePx !== undefined) check.activePx = req.trailing.activePx;
      const last = this.market.ticker(req.instId)?.last;
      if (last) check.lastPx = last;
    }
    return { legs, check };
  }

  /**
   * The `attachAlgoOrds` of an opening order. A stop-loss alone, or one take-profit (with the stop-loss when there is
   * one): one object for the whole fill, which OKX turns into one algo order (an oco order with both). Two take-profits
   * or more: split take-profits, one object per leg with its `sz`, and the stop-loss in an object of its own, with
   * `amendPxOnTriggerType: '1'` for the cost-price stop. Every leg is mark-triggered and executes at market.
   */
  private attachments(clOrdId: string, slTriggerPx: string, legs: TakeProfitLegPreview[] | undefined, breakeven: boolean): OkxAttachAlgoOrd[] {
    const sl: OkxAttachAlgoOrd | null = slTriggerPx === '' ? null : { slTriggerPx, slOrdPx: '-1', slTriggerPxType: 'mark' };
    const tp = (leg: TakeProfitLegPreview): OkxAttachAlgoOrd => ({ tpTriggerPx: leg.triggerPx, tpOrdPx: '-1', tpTriggerPxType: 'mark' });
    const [first] = legs ?? [];
    if (!first) return sl ? [{ attachAlgoClOrdId: attachAlgoClOrdIdFor(clOrdId), ...sl }] : [];
    if (legs?.length === 1) return [{ attachAlgoClOrdId: sl ? attachAlgoClOrdIdFor(clOrdId) : takeProfitAlgoClOrdIdFor(clOrdId, 1), ...tp(first), ...(sl ?? {}) }];
    const out: OkxAttachAlgoOrd[] = (legs ?? []).map((leg, i) => ({ attachAlgoClOrdId: takeProfitAlgoClOrdIdFor(clOrdId, i + 1), ...tp(leg), sz: leg.sz }));
    if (sl) out.push({ attachAlgoClOrdId: attachAlgoClOrdIdFor(clOrdId), ...sl, ...(breakeven ? { amendPxOnTriggerType: '1' as const } : {}) });
    return out;
  }

  /**
   * Validate the stop-loss an opening order asks for and work out what it loses. The trigger is rounded to the
   * tick towards the entry (the smaller loss) and must lie on the losing side of both the order's reference
   * price and the mark: the stop is triggered by the mark price, so one on the wrong side of it fires at once.
   * Only the live mark will do for that; the last price or the book mid the other rules fall back on is not it.
   */
  private attachedStop(raw: string, req: PlaceOrderRequest, inst: Instrument, posSide: PosSide, closing: boolean, sz: string, refPrice: string): { slTriggerPx: string; stopLossQuote: string } {
    if (closing) throw new AppError('VALIDATION', 'a stop-loss can only be attached to an order that opens a position');
    const buy = req.side === 'buy';
    // Net mode: without reduce-only an order against the open position reduces or flips it; its stop would protect nothing.
    const reduces = posSide === 'net' && this.account.positionList().some((p) => p.instId === req.instId && p.posSide === 'net' && (buy ? D(p.pos || '0').lt(0) : D(p.pos || '0').gt(0)));
    if (reduces) throw new AppError('VALIDATION', `a stop-loss can only be attached to an order that opens a position: this ${req.side} order reduces the open net ${buy ? 'short' : 'long'} position of ${req.instId}`);
    const markPx = this.market.liveMarkPrice(req.instId);
    if (markPx === undefined) throw new AppError('NO_PRICE', `no live mark price for ${req.instId}: a mark-triggered stop-loss cannot be checked against it; retry shortly or place the order without the stop`, 503);
    const trigger = buy ? ceilToStep(raw, inst.tickSz) : floorToStep(raw, inst.tickSz);
    const slTriggerPx = toPlainString(trigger, inst.tickSz);
    const details = { slTriggerPx, refPrice, markPx };
    if (trigger.lte(0)) throw new AppError('VALIDATION', 'the stop-loss trigger rounds to zero at this tick size', 400, details);
    const losing = (px: string): boolean => (buy ? trigger.lt(px) : trigger.gt(px));
    if (!losing(refPrice) || !losing(markPx)) {
      throw new AppError('VALIDATION', `the stop-loss trigger ${slTriggerPx} must be ${buy ? 'below' : 'above'} both the order price ${refPrice} and the mark price ${markPx} for a ${req.side} order`, 400, details);
    }
    // Coin held at the entry times the price distance: also right for inverse contracts, whose coin amount depends on the entry.
    const stopLossQuote = contractsToCoin(sz, inst, refPrice).mul(D(refPrice).minus(trigger).abs()).toFixed();
    return { slTriggerPx, stopLossQuote };
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

  /** `campaign` is for the campaign's own orders (CampaignOrders); a request of the terminal never carries one. */
  async place(req: PlaceOrderRequest, campaign?: CampaignRiskContext): Promise<{ order: Order; preview: OrderPreview }> {
    const config = this.account.requireTrading();
    this.checkSource(req);
    // `source` and `signal` are for the trade journal (onPlaced): they never go to the exchange; a signal order is told apart by its prefix.
    const clOrdId = req.clOrdId ?? generateClOrdId(Date.now(), req.source === 'signal' ? SIGNAL_CL_ORD_PREFIX : CL_ORD_PREFIX);
    // The page marks its retries as well: this memory does not survive a restart, and a restart in mid-request
    // is exactly how a reply gets lost.
    if (this.sentIds.get(clOrdId) === req.instId || (req.retry === true && req.clOrdId !== undefined)) {
      const inst = this.market.requireInstrument(req.instId);
      const earlier = await this.findEarlierAttempt(req.instId, clOrdId);
      if (earlier) {
        this.log.warn({ ordId: earlier.ordId, clOrdId, state: earlier.state }, 'retry of an order that already reached the exchange; nothing sent');
        this.notifyPlaced({ request: req, order: earlier, earlier: true });
        return { order: earlier, preview: this.previewOfExisting(earlier, inst) };
      }
    }
    const preview = await this.evaluate(req, clOrdId, campaign);
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
    // The exchange creates the stop and the take-profits when the order has filled. OKX triggers on the last price unless told otherwise.
    const attached = this.attachments(clOrdId, preview.slTriggerPx, preview.takeProfits, req.breakevenAfterTp1 === true);
    if (attached.length > 0) params.attachAlgoOrds = attached;

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
    this.log.info({ ordId: ack.ordId, clOrdId, instId: params.instId, side: params.side, ordType: params.ordType, sz: params.sz, px: params.px, slTriggerPx: preview.slTriggerPx, takeProfits: preview.takeProfits?.map((l) => `${l.sz}@${l.triggerPx}`), breakevenAfterTp1: req.breakevenAfterTp1 === true, trailing: req.trailing, source: req.source ?? 'manual', latencyMs: Date.now() - t0 }, 'order accepted');
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
    if (preview.slTriggerPx !== '') order.slTriggerPx = preview.slTriggerPx;
    // Journal the synthetic 'live' row only when the fill push has not already recorded a newer state.
    if (this.account.noteLocalOrder(order)) void this.store.upsertOrder(order).catch(() => undefined);
    this.notifyPlaced({ request: req, order, earlier: false });
    return { order, preview };
  }

  /** Called for every order place() has put at the exchange (or found there from an earlier attempt): the trade journal records the plan it carries. */
  onPlaced(listener: (e: OrderPlacedEvent) => void): void {
    this.placedListeners.push(listener);
  }

  private notifyPlaced(e: OrderPlacedEvent): void {
    for (const listener of this.placedListeners) {
      try {
        listener(e);
      } catch (err) {
        this.log.warn({ clOrdId: e.order.clOrdId, err: (err as Error).message }, 'order placed listener failed');
      }
    }
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
      slTriggerPx: order.slTriggerPx ?? '',
      stopLossQuote: '',
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

  // ---- stops (algo orders) ----

  /**
   * Place a stop-loss for an open position that has none, or not for all of it: mark-triggered, executed at
   * market, for the contracts its stops do not cover yet (or fewer, when `sz` says so). The position comes from
   * the mirror, the stops from a fresh read of the exchange; the trigger is rounded to the tick towards the price
   * and must lie on the losing side of the live mark. A stop can only take risk away, so the kill switch does not
   * refuse it.
   */
  async placeStop(req: PlaceStopRequest, opts: { algoClOrdId?: string } = {}): Promise<{ algoId: string; instId: string; slTriggerPx: string; sz: string }> {
    const longShort = this.account.requireRestTrading().posMode === 'long_short_mode';
    if (longShort && req.posSide !== 'long' && req.posSide !== 'short') throw new AppError('VALIDATION', 'posSide (long|short) is required to place a stop in long/short mode');
    const posSide: PosSide = longShort ? (req.posSide ?? 'net') : 'net';
    const position = this.account.positionList().find((p) => p.instId === req.instId && p.mgnMode === req.mgnMode && p.posSide === posSide);
    const direction = position ? positionDirection(position) : null;
    if (!position || direction === null) throw new AppError('VALIDATION', `no open ${req.mgnMode} position in ${req.instId}${longShort ? ` on the ${posSide} side` : ''} to place a stop for`);
    const coverage = stopCoverage(position, (await this.account.refreshAlgoOrders()).orders);
    const uncovered = D(coverage.size).minus(coverage.covered);
    if (uncovered.lte(0)) throw new AppError('VALIDATION', `the position is already covered by its stops (${coverage.covered} of ${coverage.size} contracts): move or cancel one in the Stops tab`, 400, { covered: coverage.covered, size: coverage.size });
    const sz = req.sz === undefined ? uncovered : D(req.sz);
    if (sz.gt(uncovered)) throw new AppError('VALIDATION', `a stop for ${sz.toFixed()} contracts is more than the ${uncovered.toFixed()} the position's stops leave uncovered`, 400, { covered: coverage.covered, size: coverage.size });

    const closesLong = direction === 'long';
    const inst = this.market.specOf(req.instId);
    const trigger = inst ? (closesLong ? ceilToStep(req.slTriggerPx, inst.tickSz) : floorToStep(req.slTriggerPx, inst.tickSz)) : D(req.slTriggerPx);
    const slTriggerPx = inst ? toPlainString(trigger, inst.tickSz) : trigger.toFixed();
    if (trigger.lte(0)) throw new AppError('VALIDATION', 'the stop-loss trigger rounds to zero at this tick size', 400, { slTriggerPx });
    const markPx = this.market.liveMarkPrice(req.instId);
    if (markPx === undefined) throw new AppError('NO_PRICE', `no live mark price for ${req.instId}: a mark-triggered stop-loss cannot be checked against it; retry shortly`, 503);
    if (closesLong ? !trigger.lt(markPx) : !trigger.gt(markPx)) {
      throw new AppError('VALIDATION', `the stop-loss trigger ${slTriggerPx} must be ${closesLong ? 'below' : 'above'} the mark price ${markPx} for a ${direction} position: it would fire at once`, 400, { slTriggerPx, markPx });
    }

    const params: OkxPlaceAlgoParams = {
      instId: req.instId,
      tdMode: req.mgnMode,
      side: closesLong ? 'sell' : 'buy',
      ordType: 'conditional',
      sz: sz.toFixed(),
      slTriggerPx,
      slOrdPx: '-1',
      slTriggerPxType: 'mark',
      algoClOrdId: opts.algoClOrdId ?? attachAlgoClOrdIdFor(generateClOrdId()),
    };
    if (longShort) params.posSide = posSide;
    else {
      // The stop may only reduce, and goes with its position when that is fully closed.
      params.reduceOnly = true;
      params.cxlOnClosePos = true;
    }
    let algoId: string;
    try {
      algoId = (await this.clients.rest.placeAlgoOrder(params)).algoId;
    } catch (err) {
      this.log.warn({ params, err: (err as Error).message }, 'stop placement failed');
      throw exchangeError(err);
    }
    this.log.info({ algoId, instId: req.instId, side: params.side, sz: params.sz, slTriggerPx }, 'stop placed');
    void this.store.addRiskEvent('STOP_PLACED', { algoId, instId: req.instId, sz: params.sz, slTriggerPx });
    await this.showAlgoChange();
    return { algoId, instId: req.instId, slTriggerPx, sz: sz.toFixed() };
  }

  /**
   * Move the stop-loss of an algo order to a new trigger price. The order is looked up in a fresh read of the
   * exchange, the trigger is rounded to the tick towards the price (the smaller loss) and, for a mark-triggered
   * stop, must lie on the losing side of the live mark: one on the wrong side of it would fire at once. Only the
   * trigger price is sent; size, trigger price type and execution stay as they are.
   */
  async amendStop(req: AmendAlgoOrderRequest): Promise<{ algoId: string; instId: string; slTriggerPx: string; previous: string }> {
    this.account.requireRestTrading();
    const stop = (await this.account.refreshAlgoOrders()).orders.find((a) => a.algoId === req.algoId && a.instId === req.instId);
    if (!stop) throw new AppError('ALGO_NOT_FOUND', `no resting algo order ${req.algoId} for ${req.instId}: it may have triggered or been cancelled`, 404, { algoId: req.algoId });
    if (stop.slTriggerPx === '') throw new AppError('VALIDATION', `algo order ${req.algoId} has no stop-loss to move`);
    // The contract spec of any SWAP will do for the tick; without one the price goes out as given and the exchange decides.
    const inst = this.market.specOf(req.instId);
    const closesLong = stop.side === 'sell';
    const trigger = inst ? (closesLong ? ceilToStep(req.slTriggerPx, inst.tickSz) : floorToStep(req.slTriggerPx, inst.tickSz)) : D(req.slTriggerPx);
    const slTriggerPx = inst ? toPlainString(trigger, inst.tickSz) : trigger.toFixed();
    if (trigger.lte(0)) throw new AppError('VALIDATION', 'the stop-loss trigger rounds to zero at this tick size', 400, { slTriggerPx });
    if (trigger.eq(stop.slTriggerPx)) throw new AppError('VALIDATION', `the stop is already at ${slTriggerPx}`, 400, { slTriggerPx });
    this.checkStopSide(stop, trigger, slTriggerPx);
    try {
      await this.clients.rest.amendAlgoOrder({ instId: req.instId, algoId: req.algoId, newSlTriggerPx: slTriggerPx });
    } catch (err) {
      this.log.warn({ algoId: req.algoId, instId: req.instId, slTriggerPx, err: (err as Error).message }, 'stop amend failed');
      throw exchangeError(err);
    }
    this.log.info({ algoId: req.algoId, instId: req.instId, from: stop.slTriggerPx, to: slTriggerPx }, 'stop moved');
    void this.store.addRiskEvent('STOP_AMENDED', { algoId: req.algoId, instId: req.instId, from: stop.slTriggerPx, to: slTriggerPx });
    await this.showAlgoChange();
    return { algoId: req.algoId, instId: req.instId, slTriggerPx, previous: stop.slTriggerPx };
  }

  /** A mark-triggered stop must stay on the losing side of the live mark; for the other trigger price types the exchange decides. */
  private checkStopSide(stop: AlgoOrder, trigger: Decimal, slTriggerPx: string): void {
    if (stop.slTriggerPxType !== 'mark') return;
    const markPx = this.market.liveMarkPrice(stop.instId);
    if (markPx === undefined) {
      throw new AppError('NO_PRICE', `no live mark price for ${stop.instId}: a mark-triggered stop-loss cannot be checked against it; retry shortly or move the stop on OKX`, 503);
    }
    const closesLong = stop.side === 'sell';
    if (closesLong ? !trigger.lt(markPx) : !trigger.gt(markPx)) {
      throw new AppError('VALIDATION', `the stop-loss trigger ${slTriggerPx} must be ${closesLong ? 'below' : 'above'} the mark price ${markPx} for a stop that closes a ${closesLong ? 'long' : 'short'}: it would fire at once`, 400, { slTriggerPx, markPx });
    }
  }

  /**
   * Cancel an algo order. Like the cancel of an order it needs neither the instrument to be tracked nor the
   * order to be in the mirror: whatever rests at the exchange under that id is cancelled.
   */
  async cancelStop(req: CancelAlgoOrderRequest): Promise<{ algoId: string; instId: string }> {
    this.account.requireRestTrading();
    try {
      await this.clients.rest.cancelAlgoOrder({ instId: req.instId, algoId: req.algoId });
    } catch (err) {
      this.log.warn({ algoId: req.algoId, instId: req.instId, err: (err as Error).message }, 'stop cancel failed');
      throw exchangeError(err);
    }
    this.log.info({ algoId: req.algoId, instId: req.instId }, 'stop cancelled');
    void this.store.addRiskEvent('STOP_CANCELED', { algoId: req.algoId, instId: req.instId });
    await this.showAlgoChange();
    return { algoId: req.algoId, instId: req.instId };
  }

  /** The exchange accepted a change of an algo order: read the list now for the terminals, and again shortly in case it was not applied yet. */
  private async showAlgoChange(): Promise<AlgoOrderList | null> {
    this.account.expectAlgoChange();
    try {
      return await this.account.refreshAlgoOrders();
    } catch (err) {
      this.log.warn({ err: (err as Error).message }, 'algo order read after a change failed');
      return null;
    }
  }

  // ---- exits for an open position (paper trading and the local mock) ----

  /**
   * The open position a request names: its instrument, margin mode and, in long/short mode, side (required there), as
   * the mirror has it. VALIDATION when there is none.
   */
  private requirePosition(req: { instId: string; mgnMode: TdMode; posSide?: PosSide | undefined }, longShort: boolean, what: string): { position: Position; posSide: PosSide; direction: 'long' | 'short' } {
    if (longShort && req.posSide !== 'long' && req.posSide !== 'short') throw new AppError('VALIDATION', `posSide (long|short) is required to place ${what} in long/short mode`);
    const posSide: PosSide = longShort ? (req.posSide ?? 'net') : 'net';
    const position = this.account.positionList().find((p) => p.instId === req.instId && p.mgnMode === req.mgnMode && p.posSide === posSide);
    const direction = position ? positionDirection(position) : null;
    if (!position || direction === null) throw new AppError('VALIDATION', `no open ${req.mgnMode} position in ${req.instId}${longShort ? ` on the ${posSide} side` : ''} to place ${what} for`);
    return { position, posSide, direction };
  }

  /** What an algo order placed for an open position adds: the closing side, and reduce-only in net mode (posSide in long/short mode). */
  private closingParams(req: { instId: string; mgnMode: TdMode }, posSide: PosSide, direction: 'long' | 'short'): Pick<OkxPlaceAlgoParams, 'instId' | 'tdMode' | 'side' | 'posSide' | 'reduceOnly'> {
    const base: Pick<OkxPlaceAlgoParams, 'instId' | 'tdMode' | 'side' | 'posSide' | 'reduceOnly'> = { instId: req.instId, tdMode: req.mgnMode, side: direction === 'long' ? 'sell' : 'buy' };
    if (posSide === 'net') base.reduceOnly = true;
    else base.posSide = posSide;
    return base;
  }

  /**
   * Take-profit legs for an open position: one OKX `conditional` order per leg, mark-triggered, executed at market, on
   * the closing side, reduce-only (in net mode with `cxlOnClosePos`, so that OKX cancels it with the position; in
   * long/short mode with the position's `posSide`). Each leg closes its fraction of the position in whole lots, the
   * last one what the others leave of the fractions' sum; together with the take-profits already resting for the
   * position they may not close more than it holds (TP_EXCEEDS_POSITION). The triggers are rounded to the tick towards
   * the entry and checked by the risk engine (TP_WRONG_SIDE). A leg only reduces: the kill switch does not refuse it.
   * The legs are placed one after the other; when one is refused the ones placed before it are cancelled.
   */
  async placeTakeProfits(req: PlaceTakeProfitsRequest): Promise<PlaceTakeProfitsResult> {
    if (!this.exitsEnabled) throw new ExitsUnavailableError();
    const longShort = this.account.requireRestTrading().posMode === 'long_short_mode';
    const { position, posSide, direction } = this.requirePosition(req, longShort, 'take-profits');
    const inst = this.market.specOf(req.instId);
    if (!inst) throw new UnknownInstrumentError(req.instId);
    const long = direction === 'long';
    const triggers = req.takeProfits.map((leg) => (long ? floorToStep(leg.triggerPx, inst.tickSz) : ceilToStep(leg.triggerPx, inst.tickSz)));
    if (triggers.some((t) => t.lte(0))) throw new AppError('VALIDATION', 'a take-profit trigger rounds to zero at this tick size');
    if (new Set(triggers.map((t) => t.toFixed())).size < triggers.length) throw new AppError('TP_TRIGGERS_NOT_DISTINCT', 'two take-profit legs have the same trigger once rounded to the tick', 400, { triggers: triggers.map((t) => toPlainString(t, inst.tickSz)) });
    const size = D(position.pos).abs();
    const sizes = sizeTakeProfitLegs(req.takeProfits.map((leg) => leg.fraction), size, inst.lotSz, 'share');
    sizes.forEach((sz, i) => {
      if (sz.lt(inst.minSz) || sz.lte(0)) throw new AppError('TP_LEG_TOO_SMALL', `take-profit ${i + 1} comes to ${sz.toFixed()} of the position's ${size.toFixed()} contracts, below the instrument's minimum of ${inst.minSz}`, 400, { leg: i + 1, sz: sz.toFixed(), minSz: inst.minSz, size: size.toFixed() });
    });
    const resting = (await this.account.refreshAlgoOrders()).orders.filter((a) => a.tpTriggerPx !== '' && algoOrderClosesPosition(a, position));
    const existing = resting.reduce((sum, a) => sum.plus(a.closeFraction !== '' ? size.times(a.closeFraction) : D(a.sz || '0')), ZERO);
    const requested = sizes.reduce((sum, sz) => sum.plus(sz), ZERO);
    if (existing.plus(requested).gt(size)) {
      throw new AppError('TP_EXCEEDS_POSITION', `the take-profits would close ${existing.plus(requested).toFixed()} contracts of a position of ${size.toFixed()} (${existing.toFixed()} already rest): cancel one or ask for less`, 400, { existing: existing.toFixed(), requested: requested.toFixed(), size: size.toFixed() });
    }
    const markPx = this.market.liveMarkPrice(req.instId);
    if (markPx === undefined) throw new AppError('NO_PRICE', `no live mark price for ${req.instId}: a mark-triggered take-profit cannot be checked against it; retry shortly`, 503);
    const prices = triggers.map((t) => toPlainString(t, inst.tickSz));
    const risk = this.risk.checkExits({ direction, entryPx: position.avgPx || markPx, markPx, takeProfits: prices });
    if (!risk.ok) {
      this.log.warn({ req, risk }, 'take-profits rejected by risk engine');
      throw new RiskRejectedError(risk);
    }
    const base = { ...this.closingParams(req, posSide, direction), ...(posSide === 'net' ? { cxlOnClosePos: true } : {}) };
    const id = generateClOrdId();
    const legs: PlaceTakeProfitsResult['legs'] = [];
    for (const [i, triggerPx] of prices.entries()) {
      const sz = (sizes[i] ?? ZERO).toFixed();
      const params: OkxPlaceAlgoParams = { ...base, ordType: 'conditional', sz, tpTriggerPx: triggerPx, tpOrdPx: '-1', tpTriggerPxType: 'mark', algoClOrdId: takeProfitAlgoClOrdIdFor(id, i + 1) };
      try {
        legs.push({ algoId: (await this.clients.rest.placeAlgoOrder(params)).algoId, triggerPx, sz });
      } catch (err) {
        this.log.warn({ params, err: (err as Error).message, placed: legs.map((l) => l.algoId) }, 'take-profit placement failed; cancelling the legs placed before it');
        for (const leg of legs) await this.clients.rest.cancelAlgoOrder({ instId: req.instId, algoId: leg.algoId }).catch(() => undefined);
        await this.showAlgoChange();
        throw exchangeError(err);
      }
    }
    this.log.info({ instId: req.instId, posSide, legs }, 'take-profits placed');
    void this.store.addRiskEvent('TAKE_PROFITS_PLACED', { instId: req.instId, posSide, legs });
    await this.showAlgoChange();
    return { instId: req.instId, posSide, legs };
  }

  /**
   * The exchange's trailing stop (OKX `move_order_stop`) for an open position: on the closing side, reduce-only in net
   * mode (posSide in long/short mode), for `sz` contracts or the whole position. It closes once the last price has come
   * back `ratio` from its extreme since activation (`activePx`, rounded to the tick towards the price; at once
   * without). The risk engine checks the ratio (CALLBACK_RATIO) and the activation price (ACTIVE_PX_WRONG_SIDE); with
   * the trailing stops already resting for the position it may not close more than the position holds
   * (TRAILING_EXCEEDS_POSITION). It only reduces: the kill switch does not refuse it. OKX does not amend a trailing
   * stop; it is cancelled through POST /api/algo-orders/cancel and placed again.
   */
  async placeTrailingStop(req: PlaceTrailingStopRequest, opts: { algoClOrdId?: string } = {}): Promise<PlaceTrailingStopResult> {
    if (!this.exitsEnabled) throw new ExitsUnavailableError();
    const longShort = this.account.requireRestTrading().posMode === 'long_short_mode';
    const { position, posSide, direction } = this.requirePosition(req, longShort, 'a trailing stop');
    const inst = this.market.specOf(req.instId);
    if (!inst) throw new UnknownInstrumentError(req.instId);
    const size = D(position.pos).abs();
    const sz = req.sz === undefined ? size : D(req.sz);
    if (!isMultipleOf(sz, inst.lotSz) || sz.lt(inst.minSz)) throw new AppError('VALIDATION', `a trailing stop for ${sz.toFixed()} contracts is not a whole number of lots of ${inst.lotSz} at least ${inst.minSz}`, 400, { sz: sz.toFixed() });
    const resting = (await this.account.refreshAlgoOrders()).orders.filter((a) => a.ordType === 'move_order_stop' && algoOrderClosesPosition(a, position));
    const existing = resting.reduce((sum, a) => sum.plus(a.sz || '0'), ZERO);
    if (existing.plus(sz).gt(size)) {
      throw new AppError('TRAILING_EXCEEDS_POSITION', `the trailing stops would close ${existing.plus(sz).toFixed()} contracts of a position of ${size.toFixed()} (${existing.toFixed()} already rest)`, 400, { existing: existing.toFixed(), requested: sz.toFixed(), size: size.toFixed() });
    }
    const markPx = this.market.liveMarkPrice(req.instId);
    if (markPx === undefined) throw new AppError('NO_PRICE', `no live mark price for ${req.instId}: the trailing stop cannot be checked against it; retry shortly`, 503);
    const long = direction === 'long';
    const activePx = req.activePx === undefined ? undefined : toPlainString(long ? floorToStep(req.activePx, inst.tickSz) : ceilToStep(req.activePx, inst.tickSz), inst.tickSz);
    const check: ExitCheckInput = { direction, entryPx: position.avgPx || markPx, markPx, callbackRatio: req.ratio };
    const last = this.market.ticker(req.instId)?.last;
    if (last) check.lastPx = last;
    if (activePx !== undefined) check.activePx = activePx;
    const risk = this.risk.checkExits(check);
    if (!risk.ok) {
      this.log.warn({ req, risk }, 'trailing stop rejected by risk engine');
      throw new RiskRejectedError(risk);
    }
    const params: OkxPlaceAlgoParams = { ...this.closingParams(req, posSide, direction), ordType: 'move_order_stop', sz: sz.toFixed(), callbackRatio: req.ratio, algoClOrdId: opts.algoClOrdId ?? trailingAlgoClOrdIdFor(generateClOrdId()) };
    if (activePx !== undefined) params.activePx = activePx;
    let algoId: string;
    try {
      algoId = (await this.clients.rest.placeAlgoOrder(params)).algoId;
    } catch (err) {
      this.log.warn({ params, err: (err as Error).message }, 'trailing stop placement failed');
      throw exchangeError(err);
    }
    this.log.info({ algoId, instId: req.instId, posSide, sz: params.sz, callbackRatio: req.ratio, activePx: activePx ?? '' }, 'trailing stop placed');
    void this.store.addRiskEvent('TRAILING_STOP_PLACED', { algoId, instId: req.instId, posSide, sz: params.sz, callbackRatio: req.ratio, activePx: activePx ?? '' });
    await this.showAlgoChange();
    return { algoId, instId: req.instId, posSide, sz: sz.toFixed(), callbackRatio: req.ratio, activePx: activePx ?? '' };
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

  // ---- isolated margin (the campaign's) ----

  /**
   * Sets the leverage of an instrument's isolated positions; in long/short mode that of one side, `posSide`, which OKX
   * requires there. Not limited by RISK_MAX_LEVERAGE: that is the limit of the leverage the terminal sets (POST
   * /api/account/leverage), and the caller is the campaign, whose orders are checked on the leverage their position
   * runs at (CampaignRiskContext). On an open isolated position the exchange moves the difference of its initial margin
   * between the position and the balance; while isolated orders of the instrument rest it refuses (59101).
   */
  async setIsolatedLeverage(instId: string, lever: string, posSide: PosSide): Promise<OkxLeverageInfo[]> {
    const longShort = this.account.requireRestTrading().posMode === 'long_short_mode';
    const params: OkxSetLeverageParams = { instId, lever, mgnMode: 'isolated' };
    if (longShort) {
      if (posSide === 'net') throw new AppError('VALIDATION', 'posSide (long|short) is required to set the isolated leverage in long/short mode');
      params.posSide = posSide;
    }
    try {
      const info = await this.account.setLeverage(params);
      this.log.info({ ...params }, 'isolated leverage set');
      return info;
    } catch (err) {
      this.log.warn({ ...params, err: (err as Error).message }, 'isolated leverage change failed');
      throw exchangeError(err);
    }
  }

  /**
   * Adds margin to an isolated position, or takes margin out of it (POST /api/v5/account/position/margin-balance).
   * `posSide` is `net` in net mode and the position's side in long/short mode; OKX takes it in both. Adding only
   * takes risk away and is allowed at any time; taking out raises the leverage the position runs at and is refused
   * while the kill switch is on (RiskEngine.checkMarginTransfer). The exchange's refusals come back as EXCHANGE with
   * `details.okxCode`: 59300 no such position, 59301 more than it can spare (or than the balance has), 59302 an
   * order that closes the position rests.
   */
  async adjustIsolatedMargin(req: { instId: string; posSide: PosSide; type: 'add' | 'reduce'; amt: string }): Promise<OkxMarginBalance> {
    const longShort = this.account.requireRestTrading().posMode === 'long_short_mode';
    if (longShort === (req.posSide === 'net')) throw new AppError('VALIDATION', `posSide ${req.posSide} does not name an isolated position in ${longShort ? 'long/short' : 'net'} mode`);
    if (!D(req.amt).gt(0)) throw new AppError('VALIDATION', 'the amount of margin to move must be positive', 400, { amt: req.amt });
    const risk = this.risk.checkMarginTransfer(req.type);
    if (!risk.ok) {
      this.log.warn({ req, risk }, 'margin transfer rejected by risk engine');
      void this.store.addRiskEvent('MARGIN_REJECTED', { req, risk });
      throw new RiskRejectedError(risk);
    }
    let result: OkxMarginBalance;
    try {
      result = await this.clients.rest.adjustMargin({ instId: req.instId, posSide: req.posSide, type: req.type, amt: req.amt });
    } catch (err) {
      this.log.warn({ req, err: (err as Error).message }, 'margin transfer failed');
      throw exchangeError(err);
    }
    this.log.info({ ...req, leverage: result.leverage }, 'isolated margin moved');
    void this.store.addRiskEvent('MARGIN_MOVED', { ...req, leverage: result.leverage });
    return result;
  }

  private resolvePosSide(req: PlaceOrderRequest, longShort: boolean): PosSide {
    if (!longShort) return 'net';
    if (req.posSide === 'long' || req.posSide === 'short') return req.posSide;
    throw new AppError('VALIDATION', 'posSide (long|short) is required because the account is in long/short position mode');
  }
}
