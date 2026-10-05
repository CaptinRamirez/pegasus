import { OkxApiError } from '@pegasus/okx';
import {
  ceilToStep,
  D,
  Decimal,
  floorToStep,
  normalizeContracts,
  notionalQuote,
  positionDirection,
  SizingError,
  type Instrument,
  type Order,
  type PlaceOrderRequest,
  type PosSide,
  type Position,
  type RiskCheckResult,
} from '@pegasus/shared';
import type { Store } from '../db/store.js';
import { AppError, RiskRejectedError } from '../errors.js';
import type { Logger } from '../logger.js';
import type { OkxClients } from '../okx/clients.js';
import { mapOrder, mapPosition } from '../okx/mappers.js';
import type { AccountService } from './account.js';
import type { MarketDataService } from './market-data.js';
import { exchangeError, generateClOrdId, type OrderService } from './order-service.js';
import type { CampaignRiskContext, RiskEngine } from './risk-engine.js';

/**
 * The orders of a campaign (the rule of packages/shared/src/campaign.ts): one isolated long per instrument, opened at
 * the campaign's leverage on its equity and pyramided out of its own margin. These are the operations the campaign
 * loop calls. Each runs alone on its instrument (CAMPAIGN_BUSY otherwise) and only in paper trading
 * (CAMPAIGN_PAPER_ONLY; the configuration refuses to enable the campaign anywhere else as well). Every order goes
 * through OrderService.place and so through the risk engine: the opening ones with a CampaignRiskContext (the leverage
 * rule measures the notional over the equity the position will have, not the leverage set), the closing ones like any
 * exit (they pass under the kill switch). The position and the balance are read from the exchange over REST before
 * and after every step; the account mirror is only asked for the resting orders.
 *
 * Open (openLong): an isolated long whose margin ends at a given amount M (the stake less the entry fee), while the
 *   leverage set for it is the instrument's highest, so that a later add posts as little margin as possible.
 *   1. Refused before anything is sent: an isolated position on the instrument already; isolated orders resting on it
 *      (OKX does not change the leverage under them, 59101); the instrument's highest leverage below the campaign's;
 *      the risk check of the buy with margin M; an available balance that does not cover M and the fee.
 *   2. set-leverage: the instrument's highest, isolated (the long side in long/short mode).
 *   3. The market buy. It posts notional / highest leverage, a fraction of M: the position runs at that leverage
 *      until step 4. A buy whose outcome is not reported is looked for as a position (the instrument was flat): one
 *      that exists goes through step 4 all the same, and the open then fails with CAMPAIGN_OPEN_UNCONFIRMED, its
 *      details saying what the position holds.
 *   4. Back to back, margin-balance add: what the position lacks of M (of M x filled / ordered when the book filled
 *      only part of the buy). The position is read before every attempt and the amount is what that read leaves, so
 *      a call whose answer was lost is never added twice; retried retryDelaysMs.length times. If the margin is still
 *      short of M, the position is closed at market (the close retried the same way) and the operation fails with
 *      CAMPAIGN_MARGIN_FAILED, details.closed saying whether the close went through; when it did not, the position is
 *      left at the highest leverage and an error is logged. A position is never left under-margined without a word.
 *      A position that is gone before it was topped up (liquidated at the highest leverage) fails with
 *      CAMPAIGN_POSITION_GONE: it lost what the buy posted, the rest of M is still in the balance.
 *
 * Add (addLong), margin-neutral: n contracts more, paid out of the position's own margin, never with new money.
 *   1. Refused before anything is sent: no isolated long; an order that closes it resting (OKX moves no margin under
 *      it, 59302); the risk check of the buy with the margin the position keeps (its margin less the fee of the add);
 *      the exchange's cap: what the margin can spare (spareMargin) must cover the add's margin at the leverage set and
 *      its fee (CAMPAIGN_ADD_CAP; also when the exchange itself refuses step 2 with 59301).
 *   2. margin-balance reduce: the add's margin and fee at the estimated fill, with RISK_MAX_SLIPPAGE_PCT on top as far
 *      as the cap allows. The balance now holds what the buy will post and pay.
 *   3. The market buy, at the position's leverage: it posts its margin back into the position and pays its fee.
 *   4. The margin is brought to what it was before less the fee the exchange charged: an add of what step 2 took
 *      beyond that, or a reduce when the fill cost more than estimated. The position has paid the fee, the balance
 *      outside it is where it was. A buy that is refused or not filled gets the margin back where it was. When the
 *      margin cannot be brought there: an excess stays in the position (a warning); a shortfall fails with
 *      CAMPAIGN_MARGIN_UNRESTORED and the position is left open.
 *
 * Reduce (reduceLong) and close (closeLong): a market sell of n contracts, or of the whole position, that can only
 *   reduce: reduceOnly in net mode, posSide long in long/short mode (never both, see CLAUDE.md). The exchange gives
 *   back the same share of the margin with the realised P&L.
 *
 * Every operation returns the fill as the exchange reports the order, and the position as it reports it afterwards.
 * A liquidation is the exchange's: it reaches the account service as an order of category `full_liquidation`
 * (isLiquidationOrder), its fill and a positions push without the position; nothing here is involved.
 */

/** Client order ids of the campaign's orders start with this, so that its orders and fills can be told from the terminal's. */
export const CAMPAIGN_CL_ORD_PREFIX = 'pc';
/** Margin is moved in amounts of at most this many decimals. */
const MARGIN_STEP = '0.00000001';
const DEFAULT_RETRY_DELAYS_MS: readonly number[] = [500, 1_000, 2_000];

export interface CampaignOrdersOptions {
  /** The campaign's leverage (CampaignConfig.leverage) */
  leverage: string;
  /** Taker fee rate the margin moves leave room for (CampaignConfig.feeRate) */
  feeRate: string;
  /** True in paper trading only: every operation is refused otherwise */
  paper: boolean;
  /** Waits after a margin move or a close that failed; one retry per entry. Default 0.5 s, 1 s, 2 s */
  retryDelaysMs?: readonly number[];
  /** Interval of the reads that wait for an order to end and for the position to show it. Default 250 ms */
  pollMs?: number;
  /** How many of those reads before giving up. Default 20 */
  pollAttempts?: number;
}

export interface CampaignOpenRequest {
  instId: string;
  /** Contracts to buy (campaignContracts of the stake's quantity), a multiple of lotSz */
  contracts: string;
  /** Margin the position is to hold: the stake less the entry fee, its notional over the campaign's leverage */
  margin: string;
  clOrdId?: string;
}

export interface CampaignAddRequest {
  instId: string;
  /** Contracts to add (campaignContracts of campaignAddQuantity) */
  contracts: string;
  clOrdId?: string;
}

export interface CampaignReduceRequest {
  instId: string;
  /** Contracts to sell (harvestContracts); all of them closes the position */
  contracts: string;
  clOrdId?: string;
}

export interface CampaignCloseRequest {
  instId: string;
  clOrdId?: string;
}

/** An order of the campaign as the exchange reports it once it has ended. */
export interface CampaignFill {
  /** When the order was last updated (it ended), exchange time */
  ts: number;
  ordId: string;
  clOrdId: string;
  /** Contracts filled */
  contracts: string;
  avgPx: string;
  /** As the exchange books it: negative when paid */
  fee: string;
  /** Realised P&L of a sale; '0' for a buy */
  pnl: string;
}

export interface CampaignOpenResult {
  fill: CampaignFill;
  /** The isolated long, its margin topped up */
  position: Position;
}

export interface CampaignAddResult {
  fill: CampaignFill;
  /** The isolated long after the add: its margin is marginBefore plus fill.fee */
  position: Position;
  marginBefore: string;
}

export interface CampaignReduceResult {
  fill: CampaignFill;
  /** What is left of the position; null once it is closed */
  position: Position | null;
}

/**
 * What the exchange lets go of an isolated position's margin (margin-balance, reduce): what it holds beyond the
 * initial margin of its notional at the mark at the leverage set, an open loss held back, an open profit not counted.
 * OKX does not publish the formula; this is the reading the simulators apply (mock-okx Account.maxReducible), and the
 * exchange decides.
 */
export function spareMargin(p: Pick<Position, 'margin' | 'upl' | 'notionalUsd' | 'lever'>): Decimal {
  const lever = D(p.lever || '0');
  if (!lever.gt(0)) return D(0);
  const spare = D(p.margin || '0').plus(Decimal.min(D(p.upl || '0'), 0)).minus(D(p.notionalUsd || '0').abs().div(lever));
  return Decimal.max(spare, 0);
}

const fillOf = (o: Order): CampaignFill => ({ ts: o.uTime, ordId: o.ordId, clOrdId: o.clOrdId, contracts: o.accFillSz || '0', avgPx: o.avgPx, fee: o.fee || '0', pnl: o.pnl || '0' });

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

export class CampaignOrders {
  /** Instruments an operation is running on. */
  private readonly busy = new Set<string>();
  private readonly retryDelaysMs: readonly number[];
  private readonly pollMs: number;
  private readonly pollAttempts: number;

  constructor(
    private readonly clients: OkxClients,
    private readonly market: MarketDataService,
    private readonly account: AccountService,
    private readonly orders: OrderService,
    private readonly risk: RiskEngine,
    private readonly store: Store,
    private readonly log: Logger,
    private readonly opts: CampaignOrdersOptions,
  ) {
    this.retryDelaysMs = opts.retryDelaysMs ?? DEFAULT_RETRY_DELAYS_MS;
    this.pollMs = opts.pollMs ?? 250;
    this.pollAttempts = opts.pollAttempts ?? 20;
  }

  /** Opens a campaign: an isolated long of `contracts` whose margin ends at `margin` (see the header, Open). */
  async openLong(req: CampaignOpenRequest): Promise<CampaignOpenResult> {
    return this.exclusive(req.instId, async () => {
      const { inst, posSide } = this.prepare(req.instId);
      const sz = this.contractsOf(req.contracts, inst);
      if (!D(req.margin).gt(0)) throw new AppError('VALIDATION', 'the margin of a campaign must be positive', 400, { margin: req.margin });
      const margin = ceilToStep(req.margin, MARGIN_STEP);
      if (D(inst.maxLever).lt(this.opts.leverage)) {
        throw new AppError('CAMPAIGN_LEVERAGE', `the highest leverage of ${inst.instId} is ${inst.maxLever}x, below the campaign's ${this.opts.leverage}x`, 409, { maxLever: inst.maxLever });
      }
      const held = await this.readPosition(inst, posSide);
      if (held) throw new AppError('CAMPAIGN_POSITION_EXISTS', `${inst.instId} already has an isolated position of ${held.pos} contracts: a campaign opens on a flat instrument only`, 409, { pos: held.pos, margin: held.margin });
      if (this.account.openOrderList().some((o) => o.instId === inst.instId && o.tdMode === 'isolated' && o.posSide === posSide)) {
        throw new AppError('CAMPAIGN_RESTING_ORDERS', `isolated orders of ${inst.instId} are resting: the exchange does not change the leverage under them; cancel them first`, 409);
      }
      const order = this.buy(inst, posSide, sz, req.clOrdId);
      const ctx: CampaignRiskContext = { leverage: this.opts.leverage, margin: margin.toFixed() };
      // Everything that can refuse is asked before the leverage is changed and the buy is sent.
      const preview = await this.orders.preview(order, ctx);
      if (!preview.risk.ok) this.reject(order, preview.risk);
      const needed = margin.plus(D(preview.notionalQuote).mul(this.opts.feeRate));
      const available = await this.available(inst);
      if (available.lt(needed)) {
        throw new AppError('CAMPAIGN_INSUFFICIENT_BALANCE', `${available.toFixed()} ${inst.settleCcy} is available, the campaign needs ${needed.toFixed()} (the margin and the fee)`, 409, { available: available.toFixed(), needed: needed.toFixed() });
      }

      await this.orders.setIsolatedLeverage(inst.instId, inst.maxLever, posSide);
      let bought: Order;
      try {
        const placed = await this.orders.place(order, ctx);
        bought = await this.awaitOrder(inst.instId, placed.order.ordId);
      } catch (err) {
        throw await this.unconfirmedBuy(inst, posSide, margin, sz, err);
      }
      const filled = D(bought.accFillSz || '0');
      if (filled.isZero()) throw new AppError('CAMPAIGN_NOT_FILLED', `the buy of ${inst.instId} did not fill: nothing was bought`, 409, { ordId: bought.ordId });
      const position = await this.topUp(inst, posSide, this.marginFor(margin, filled, sz), filled, bought.ordId);
      this.log.info({ instId: inst.instId, ordId: bought.ordId, contracts: bought.accFillSz, avgPx: bought.avgPx, margin: position.margin, lever: position.lever, liqPx: position.liqPx }, 'campaign opened');
      return { fill: fillOf(bought), position };
    });
  }

  /** Adds `contracts` to a campaign out of its own margin (see the header, Add). */
  async addLong(req: CampaignAddRequest): Promise<CampaignAddResult> {
    return this.exclusive(req.instId, async () => {
      const { inst, posSide } = this.prepare(req.instId);
      const sz = this.contractsOf(req.contracts, inst);
      const before = await this.heldLong(inst, posSide);
      if (this.account.openOrderList().some((o) => o.instId === inst.instId && o.tdMode === 'isolated' && o.posSide === posSide && o.side === 'sell')) {
        throw new AppError('CAMPAIGN_RESTING_ORDERS', `an order that closes the isolated position of ${inst.instId} is resting: the exchange moves no margin under it; cancel it first`, 409);
      }
      const lever = D(before.lever || '0');
      // What the add posts its margin at: the position's own leverage, not one assumed.
      if (!lever.gt(0)) throw new AppError('LEVERAGE_UNAVAILABLE', `the exchange reports no leverage for the isolated position of ${inst.instId}`, 503);
      const estimate = this.market.estimateMarketFill(inst.instId, 'buy', sz);
      if (!estimate || !estimate.complete) throw new AppError('NO_BOOK', `the order book of ${inst.instId} is not synced or too thin to price the add; retry shortly`, 503);
      const notional = notionalQuote(sz, estimate.avgPx, inst);
      const fee = notional.mul(this.opts.feeRate);
      // What the buy posts at the position's leverage, and pays.
      const required = notional.div(lever).plus(fee);
      const marginBefore = D(before.margin);
      const order = this.buy(inst, posSide, sz, req.clOrdId);
      const ctx: CampaignRiskContext = { leverage: this.opts.leverage, margin: marginBefore.minus(fee).toFixed() };
      const preview = await this.orders.preview(order, ctx);
      if (!preview.risk.ok) this.reject(order, preview.risk);
      const spare = spareMargin(before);
      if (spare.lt(required)) throw this.addCap(inst.instId, spare, required);
      const release = Decimal.min(floorToStep(spare, MARGIN_STEP), ceilToStep(required.mul(D(1).plus(this.risk.config.maxSlippagePct)), MARGIN_STEP));

      try {
        await this.orders.adjustIsolatedMargin({ instId: inst.instId, posSide, type: 'reduce', amt: release.toFixed() });
      } catch (err) {
        // Nothing moved, unless the answer was lost: the margin is set back from what the exchange reports.
        await this.restore(inst, posSide, marginBefore, err);
        if (err instanceof AppError && err.details?.['okxCode'] === '59301') throw this.addCap(inst.instId, spare, required);
        throw err;
      }
      let bought: Order;
      try {
        const placed = await this.orders.place(order, ctx);
        bought = await this.awaitOrder(inst.instId, placed.order.ordId);
      } catch (err) {
        // Refused, or its outcome unknown: the margin goes back to where it was. An add that did go through leaves
        // the position its fee richer than it should be, never poorer.
        await this.restore(inst, posSide, marginBefore, err);
        throw err;
      }
      const filled = D(bought.accFillSz || '0');
      const target = marginBefore.plus(bought.fee || '0');
      const shows = (p: Position): boolean => D(p.pos).abs().gte(D(before.pos).abs().plus(filled));
      let position: Position;
      try {
        position = await this.settleMargin(inst, posSide, target, shows);
      } catch (err) {
        throw this.unrestored(inst.instId, target, err);
      }
      if (filled.isZero()) throw new AppError('CAMPAIGN_NOT_FILLED', `the add to ${inst.instId} did not fill: the margin is back where it was`, 409, { ordId: bought.ordId });
      this.log.info({ instId: inst.instId, ordId: bought.ordId, contracts: bought.accFillSz, avgPx: bought.avgPx, fee: bought.fee, marginBefore: marginBefore.toFixed(), margin: position.margin, liqPx: position.liqPx }, 'campaign added to');
      return { fill: fillOf(bought), position, marginBefore: marginBefore.toFixed() };
    });
  }

  /** Sells `contracts` of a campaign; all of them close it (see the header, Reduce). */
  async reduceLong(req: CampaignReduceRequest): Promise<CampaignReduceResult> {
    return this.exclusive(req.instId, async () => {
      const { inst, posSide } = this.prepare(req.instId);
      const sz = this.contractsOf(req.contracts, inst);
      const held = await this.heldLong(inst, posSide);
      if (D(sz).gt(D(held.pos).abs())) throw new AppError('VALIDATION', `${sz} contracts is more than the ${D(held.pos).abs().toFixed()} the isolated position of ${inst.instId} holds`, 400, { contracts: sz, pos: held.pos });
      return this.sellOff(inst, posSide, held, sz, req.clOrdId);
    });
  }

  /** Closes a campaign: a market sell of the whole position (see the header, Reduce). */
  async closeLong(req: CampaignCloseRequest): Promise<CampaignReduceResult> {
    return this.exclusive(req.instId, async () => {
      const { inst, posSide } = this.prepare(req.instId);
      const held = await this.heldLong(inst, posSide);
      return this.sellOff(inst, posSide, held, D(held.pos).abs().toFixed(), req.clOrdId);
    });
  }

  // ---- steps ----

  /** The instrument and the leg of its campaign; refused outside paper trading. */
  private prepare(instId: string): { inst: Instrument; posSide: PosSide } {
    if (!this.opts.paper) throw new AppError('CAMPAIGN_PAPER_ONLY', 'campaign orders are sent to the paper exchange only in this stage', 403);
    const inst = this.market.requireInstrument(instId);
    if (inst.ctType !== 'linear') throw new AppError('VALIDATION', `${instId} is not a linear swap: the campaign trades linear contracts only`);
    return { inst, posSide: this.account.requireConfig().posMode === 'long_short_mode' ? 'long' : 'net' };
  }

  private async exclusive<T>(instId: string, run: () => Promise<T>): Promise<T> {
    if (this.busy.has(instId)) throw new AppError('CAMPAIGN_BUSY', `another campaign operation on ${instId} is still running`, 409);
    this.busy.add(instId);
    try {
      return await run();
    } finally {
      this.busy.delete(instId);
    }
  }

  /** Exchange contracts of a request: whole lots, at least the minimum order. */
  private contractsOf(contracts: string, inst: Instrument): string {
    try {
      return normalizeContracts(contracts, inst, 'market').sz;
    } catch (err) {
      if (err instanceof SizingError) throw new AppError('SIZING', err.message, 400, { code: err.code });
      throw err;
    }
  }

  private buy(inst: Instrument, posSide: PosSide, sz: string, clOrdId: string | undefined): PlaceOrderRequest {
    const req: PlaceOrderRequest = { instId: inst.instId, side: 'buy', ordType: 'market', tdMode: 'isolated', size: { unit: 'contracts', value: sz }, clOrdId: clOrdId ?? generateClOrdId(Date.now(), CAMPAIGN_CL_ORD_PREFIX) };
    if (posSide !== 'net') req.posSide = posSide;
    return req;
  }

  private sell(inst: Instrument, posSide: PosSide, sz: string, clOrdId: string | undefined): PlaceOrderRequest {
    const req: PlaceOrderRequest = { instId: inst.instId, side: 'sell', ordType: 'market', tdMode: 'isolated', size: { unit: 'contracts', value: sz }, clOrdId: clOrdId ?? generateClOrdId(Date.now(), CAMPAIGN_CL_ORD_PREFIX) };
    // It may only reduce: OKX honours reduceOnly in net mode only; in long/short mode a sell on the long side closes.
    if (posSide === 'net') req.reduceOnly = true;
    else req.posSide = posSide;
    return req;
  }

  /** A refusal of the risk engine before anything was sent: journaled like the ones of OrderService.place. */
  private reject(req: PlaceOrderRequest, risk: RiskCheckResult): never {
    this.log.warn({ req, risk }, 'campaign order rejected by risk engine');
    void this.store.addRiskEvent('ORDER_REJECTED', { req, risk, campaign: true });
    throw new RiskRejectedError(risk);
  }

  private addCap(instId: string, spare: Decimal, required: Decimal): AppError {
    return new AppError('CAMPAIGN_ADD_CAP', `the isolated position of ${instId} can spare ${spare.toFixed(8)} of its margin, the add needs ${required.toFixed(8)} (its margin at the leverage set and its fee): the exchange would refuse it`, 409, { spare: spare.toFixed(), required: required.toFixed() });
  }

  /** The instrument's isolated position on the campaign's leg, read from the exchange; null when there is none. */
  private async readPosition(inst: Instrument, posSide: PosSide): Promise<Position | null> {
    let rows;
    try {
      rows = await this.clients.rest.getPositions('SWAP', inst.instId);
    } catch (err) {
      throw exchangeError(err);
    }
    for (const raw of rows) {
      const p = mapPosition(raw);
      if (p.instId === inst.instId && p.mgnMode === 'isolated' && p.posSide === posSide && !D(p.pos).isZero()) return p;
    }
    return null;
  }

  /** The campaign's isolated long; refused when there is none, or when the isolated position is a short. */
  private async heldLong(inst: Instrument, posSide: PosSide): Promise<Position> {
    const held = await this.readPosition(inst, posSide);
    if (!held) throw new AppError('CAMPAIGN_NO_POSITION', `${inst.instId} has no isolated position`, 409);
    if (positionDirection(held) !== 'long') throw new AppError('CAMPAIGN_POSITION_CONFLICT', `the isolated position of ${inst.instId} is a short: a campaign is a long`, 409, { pos: held.pos });
    return held;
  }

  /** Reads the position until `done` says it shows what was traded, or the reads run out: the last read either way. */
  private async awaitPosition(inst: Instrument, posSide: PosSide, done: (p: Position | null) => boolean): Promise<Position | null> {
    let p = await this.readPosition(inst, posSide);
    for (let i = 1; i < this.pollAttempts && !done(p); i++) {
      await sleep(this.pollMs);
      p = await this.readPosition(inst, posSide);
    }
    return p;
  }

  /** Reads the order until it has ended (filled, or cancelled with what it filled); a market order ends at once. */
  private async awaitOrder(instId: string, ordId: string): Promise<Order> {
    let last: Order | null = null;
    for (let i = 0; i < this.pollAttempts; i++) {
      if (i > 0) await sleep(this.pollMs);
      try {
        last = mapOrder(await this.clients.rest.getOrder({ instId, ordId }));
        if (last.state === 'filled' || last.state === 'canceled') return last;
      } catch (err) {
        // 51603: not queryable yet right after its acknowledgement
        if (!(err instanceof OkxApiError && err.code === '51603')) this.log.warn({ instId, ordId, err: (err as Error).message }, 'campaign order read failed');
      }
    }
    throw new AppError('CAMPAIGN_ORDER_UNKNOWN', `whether order ${ordId} of ${instId} has filled could not be read`, 504, { ordId, state: last?.state ?? '' });
  }

  /** The available balance of the instrument's settlement currency, read from the exchange. */
  private async available(inst: Instrument): Promise<Decimal> {
    let detail;
    try {
      detail = (await this.clients.rest.getBalance(inst.settleCcy)).details.find((d) => d.ccy === inst.settleCcy);
    } catch (err) {
      throw exchangeError(err);
    }
    const available = detail?.availEq || detail?.availBal || '';
    if (available === '') throw new AppError('CAMPAIGN_BALANCE_UNKNOWN', `the exchange reports no available ${inst.settleCcy} balance`, 502);
    return D(available);
  }

  /**
   * Brings the margin of the isolated position to `target` (within MARGIN_STEP): an add when it holds less, a reduce
   * when it holds more. The position is read from the exchange before every attempt and the amount is what that read
   * leaves to move, so an attempt whose answer was lost is never moved twice. `shows` says when a read shows the trade
   * just made (the exchange may apply a fill a moment after acknowledging it). A margin still short of the target after
   * the retries fails with CAMPAIGN_MARGIN_SHORT; one that stays above it (the exchange keeps the excess) is accepted
   * with a warning. CAMPAIGN_POSITION_GONE when the position is gone.
   */
  private async settleMargin(inst: Instrument, posSide: PosSide, target: Decimal, shows: (p: Position) => boolean = () => true): Promise<Position> {
    let failure: unknown = null;
    for (let attempt = 0; ; attempt++) {
      const position = await this.awaitPosition(inst, posSide, (p) => p !== null && shows(p));
      if (!position) throw new AppError('CAMPAIGN_POSITION_GONE', `the isolated position of ${inst.instId} is gone (liquidated or closed) before its margin was settled`, 409, { target: target.toFixed() });
      const missing = target.minus(position.margin || '0');
      if (missing.abs().lte(MARGIN_STEP)) return position;
      if (attempt > this.retryDelaysMs.length) {
        if (missing.lt(0)) {
          this.log.warn({ instId: inst.instId, target: target.toFixed(), margin: position.margin, err: (failure as Error | null)?.message }, 'the isolated margin stays above its target: the exchange did not let the excess go');
          return position;
        }
        throw new AppError('CAMPAIGN_MARGIN_SHORT', `the isolated position of ${inst.instId} holds ${position.margin} of margin, short of ${target.toFixed()}: ${(failure as Error | null)?.message ?? 'not moved'}`, 502, { target: target.toFixed(), margin: position.margin });
      }
      try {
        await this.orders.adjustIsolatedMargin({ instId: inst.instId, posSide, type: missing.gt(0) ? 'add' : 'reduce', amt: missing.abs().toFixed() });
      } catch (err) {
        failure = err;
        this.log.warn({ instId: inst.instId, target: target.toFixed(), margin: position.margin, attempt, err: (err as Error).message }, 'isolated margin move failed');
        const delay = this.retryDelaysMs[attempt];
        if (delay !== undefined) await sleep(delay);
      }
    }
  }

  /** The margin of an open: M for the contracts ordered, the same share of it when the book filled only part of them. */
  private marginFor(margin: Decimal, filled: Decimal, ordered: string): Decimal {
    return filled.gte(ordered) ? margin : ceilToStep(margin.mul(filled).div(ordered), MARGIN_STEP);
  }

  /**
   * The buy of an open failed, or its outcome was not reported. The instrument was flat, so a position on it now is
   * this buy's, whether its answer arrived or not: it is topped up like any other (or closed when that fails) and the
   * open fails with CAMPAIGN_OPEN_UNCONFIRMED, its details saying what the position holds. Without a position the
   * original failure stands. Returns the error to throw.
   */
  private async unconfirmedBuy(inst: Instrument, posSide: PosSide, margin: Decimal, ordered: string, cause: unknown): Promise<unknown> {
    let held: Position | null;
    try {
      held = await this.readPosition(inst, posSide);
    } catch (err) {
      this.log.error({ instId: inst.instId, err: (cause as Error).message, read: (err as Error).message }, 'the campaign buy failed and the position could not be read: it may be open at the highest leverage, check it');
      return cause;
    }
    if (!held) return cause;
    const filled = D(held.pos).abs();
    this.log.error({ instId: inst.instId, err: (cause as Error).message, pos: held.pos }, 'the outcome of the campaign buy was not reported, but its position exists: topping it up');
    const position = await this.topUp(inst, posSide, this.marginFor(margin, filled, ordered), filled, '');
    return new AppError('CAMPAIGN_OPEN_UNCONFIRMED', `the buy of ${inst.instId} was not confirmed (${(cause as Error).message}), but its position exists and now holds its margin`, 504, { pos: position.pos, avgPx: position.avgPx, margin: position.margin, reason: (cause as Error).message });
  }

  /** Step 4 of the open: the margin brought to `due`; when it cannot be, the position is closed and the open fails. */
  private async topUp(inst: Instrument, posSide: PosSide, due: Decimal, filled: Decimal, ordId: string): Promise<Position> {
    try {
      return await this.settleMargin(inst, posSide, due, (p) => D(p.pos).abs().gte(filled));
    } catch (err) {
      if (err instanceof AppError && err.code === 'CAMPAIGN_POSITION_GONE') {
        this.log.error({ instId: inst.instId, ordId, margin: due.toFixed() }, 'the campaign position is gone before its margin was topped up');
        void this.store.addRiskEvent('CAMPAIGN_POSITION_GONE', { instId: inst.instId, ordId, margin: due.toFixed() });
        throw err;
      }
      const closed = await this.closeAfterFailure(inst, posSide);
      const details = { instId: inst.instId, ordId, margin: due.toFixed(), closed, reason: (err as Error).message };
      this.log.error(details, closed ? 'the campaign position could not be given its margin and was closed' : 'the campaign position could not be given its margin NOR be closed: it is open at the highest leverage, close it by hand');
      void this.store.addRiskEvent('CAMPAIGN_MARGIN_FAILED', details);
      throw new AppError(
        'CAMPAIGN_MARGIN_FAILED',
        closed
          ? `the margin of the new campaign on ${inst.instId} could not be brought to ${due.toFixed()} (${details.reason}); the position was closed`
          : `the margin of the new campaign on ${inst.instId} could not be brought to ${due.toFixed()} (${details.reason}) and the position could not be closed: it is open at the highest leverage, close it by hand`,
        502,
        details,
      );
    }
  }

  /** The open could not give its position the margin it needs: closed at market, retried; true once it is flat. */
  private async closeAfterFailure(inst: Instrument, posSide: PosSide): Promise<boolean> {
    for (let attempt = 0; ; attempt++) {
      try {
        const held = await this.readPosition(inst, posSide);
        if (!held) return true;
        await this.sellOff(inst, posSide, held, D(held.pos).abs().toFixed(), undefined);
        if (!(await this.readPosition(inst, posSide))) return true;
      } catch (err) {
        this.log.warn({ instId: inst.instId, attempt, err: (err as Error).message }, 'closing the campaign position failed');
      }
      const delay = this.retryDelaysMs[attempt];
      if (delay === undefined) return false;
      await sleep(delay);
    }
  }

  /**
   * After a step of the add went wrong: the margin set back to `target`. The original failure is for the caller to
   * throw; one that cannot be set back fails with CAMPAIGN_MARGIN_UNRESTORED instead.
   */
  private async restore(inst: Instrument, posSide: PosSide, target: Decimal, cause: unknown): Promise<void> {
    try {
      await this.settleMargin(inst, posSide, target);
    } catch (err) {
      throw this.unrestored(inst.instId, target, err, cause);
    }
  }

  private unrestored(instId: string, target: Decimal, err: unknown, cause?: unknown): AppError {
    const details: Record<string, unknown> = { instId, target: target.toFixed(), reason: (err as Error).message };
    if (cause !== undefined) details['cause'] = (cause as Error).message;
    this.log.error(details, 'the margin of the campaign position could not be set back; it is left open with less margin than planned');
    void this.store.addRiskEvent('CAMPAIGN_MARGIN_UNRESTORED', details);
    return new AppError('CAMPAIGN_MARGIN_UNRESTORED', `the margin of the isolated position of ${instId} could not be brought back to ${target.toFixed()}: ${(err as Error).message}`, 502, details);
  }

  /** A market sell of `sz` contracts that can only reduce, waited for until it has ended and the position shows it. */
  private async sellOff(inst: Instrument, posSide: PosSide, held: Position, sz: string, clOrdId: string | undefined): Promise<CampaignReduceResult> {
    const placed = await this.orders.place(this.sell(inst, posSide, sz, clOrdId));
    const sold = await this.awaitOrder(inst.instId, placed.order.ordId);
    const left = D(held.pos).abs().minus(sold.accFillSz || '0');
    const position = await this.awaitPosition(inst, posSide, (p) => (p === null ? left.lte(0) : D(p.pos).abs().lte(left)));
    this.log.info({ instId: inst.instId, ordId: sold.ordId, contracts: sold.accFillSz, avgPx: sold.avgPx, pnl: sold.pnl, left: position?.pos ?? '0' }, 'campaign sold');
    return { fill: fillOf(sold), position };
  }
}
