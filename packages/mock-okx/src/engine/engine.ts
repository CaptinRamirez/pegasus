import { d, fmt, isDecimalString, ZERO, type Dec } from '../num.js';
import { Prng } from '../prng.js';
import type { MockState } from '../types.js';
import type { OkxAccountConfig, OkxAlgoOrder, OkxBalance, OkxBookData, OkxCandleRow, OkxFill, OkxFundingRate, OkxInstrument, OkxLeverageInfo, OkxMarginAdjustment, OkxMarkPrice, OkxMgnMode, OkxOrder, OkxPosMode, OkxPosSide, OkxPosition, OkxResponse, OkxTicker } from '../wire.js';
import { Account, type PositionRec } from './account.js';
import type { Bar, CandleQuery } from './candles.js';
import { reject, type EngineContext, type EngineEvents, type EventName, type Listener, type Market, type Rejection } from './context.js';
import { fallbackMmr } from './margin.js';
import { MarketSim, type TickResult } from './market.js';
import { Matcher } from './matching.js';
import { OrderStore, orderToWire, stopToAlgoWire, stopToWire } from './orders.js';
import { asRecord, str } from './validate.js';

export interface EngineConfig {
  posMode: OkxPosMode;
  perm: string;
  instruments: OkxInstrument[];
  initialPrices: Record<string, string>;
  seed: number;
  volatility: number;
  tickIntervalMs: number;
  initialBalanceUsdt: string;
  takerFeeRate: string;
  makerFeeRate: string;
  log: (msg: string) => void;
  /**
   * Markets supplied from outside (the paper exchange feeds them with the real exchange's quotes). The engine
   * then simulates no prices of its own: `tick`, `setPrice` and the public market-data queries have nothing to serve.
   */
  markets?: Map<string, Market>;
  /** Leverage of an instrument until it is set; 10 when absent. */
  defaultLever?: string;
  /**
   * Tier-1 maintenance margin rate by instrument: what its isolated positions are liquidated by. An instrument
   * without one gets half the initial margin rate of its highest leverage (fallbackMmr).
   */
  mmr?: Record<string, string>;
}

export const MOCK_UID = '1234567890';

/** The whole exchange simulation: markets, account, matching and an event bus. */
export class Engine implements EngineContext {
  readonly posMode: OkxPosMode;
  readonly perm: string;
  readonly instruments = new Map<string, OkxInstrument>();
  /** What the matching engine trades against: the simulated markets, or the ones supplied from outside. */
  readonly markets = new Map<string, Market>();
  /** The engine's own simulated markets (price process, book, candles); empty when the markets come from outside. */
  readonly sims = new Map<string, MarketSim>();
  /** Set while past events are replayed: the time they are stamped with instead of the wall clock. */
  clockOverride: number | null = null;
  /** When positions and balance of an instrument were last pushed because its market moved. */
  private readonly lastMovePush = new Map<string, number>();
  /** Tier-1 maintenance margin rate of every instrument. */
  readonly mmr = new Map<string, Dec>();
  readonly account: Account;
  readonly orders = new OrderStore();
  readonly takerFee: Dec;
  readonly makerFee: Dec;
  readonly matcher: Matcher;
  private readonly listeners = new Map<EventName, Set<(payload: unknown) => void>>();
  private readonly log: (msg: string) => void;
  private tickSeq = 0;

  constructor(cfg: EngineConfig) {
    this.posMode = cfg.posMode;
    this.perm = cfg.perm;
    this.log = cfg.log;
    this.takerFee = d(cfg.takerFeeRate);
    this.makerFee = d(cfg.makerFeeRate);
    const rng = new Prng(cfg.seed);
    const now = this.now();
    for (const inst of cfg.instruments) {
      this.instruments.set(inst.instId, inst);
      const rate = cfg.mmr?.[inst.instId];
      this.mmr.set(inst.instId, rate === undefined ? fallbackMmr(inst) : d(rate));
      const external = cfg.markets?.get(inst.instId);
      if (cfg.markets) {
        if (!external) throw new Error(`no market supplied for ${inst.instId}`);
        this.markets.set(inst.instId, external);
        continue;
      }
      const px = d(cfg.initialPrices[inst.instId] ?? '100');
      const sim = new MarketSim(inst, px, rng, { volatility: cfg.volatility, tickIntervalMs: cfg.tickIntervalMs }, now);
      this.sims.set(inst.instId, sim);
      this.markets.set(inst.instId, sim);
    }
    this.account = new Account(d(cfg.initialBalanceUsdt), cfg.posMode, this.instruments, cfg.defaultLever === undefined ? undefined : d(cfg.defaultLever), { mmr: this.mmr, feeRate: this.takerFee });
    this.matcher = new Matcher(this);
  }

  now(): number {
    return this.clockOverride ?? Date.now();
  }

  on<K extends EventName>(event: K, fn: Listener<K>): () => void {
    let set = this.listeners.get(event);
    if (!set) {
      set = new Set();
      this.listeners.set(event, set);
    }
    const wrapped = fn as (payload: unknown) => void;
    set.add(wrapped);
    return () => {
      set.delete(wrapped);
    };
  }

  emit<K extends EventName>(event: K, payload: EngineEvents[K]): void {
    const set = this.listeners.get(event);
    if (!set) return;
    for (const fn of set) {
      try {
        fn(payload);
      } catch (err) {
        this.log(`listener for ${event} failed: ${(err as Error).message}`);
      }
    }
  }

  // ---- simulation ----

  tick(): void {
    const now = this.now();
    for (const [instId, market] of this.sims) this.afterMove(instId, market, market.step(now), now);
  }

  setPrice(instId: string, px: string): void {
    const market = this.sims.get(instId);
    if (!market) throw new Error(`unknown instrument ${instId}`);
    const now = this.now();
    this.afterMove(instId, market, market.step(now, d(px)), now);
  }

  /** Pins the mark price apart from the mid (null: it follows the mid again) and checks liquidations and the stops against it. */
  setMarkPrice(instId: string, px: string | null): void {
    const market = this.sims.get(instId);
    if (!market) throw new Error(`unknown instrument ${instId}`);
    market.pinMark(px === null ? null : d(px));
    this.account.markToMarket(instId, market.markPx);
    this.matcher.checkLiquidations(instId);
    this.matcher.checkStops(instId);
    this.tickSeq += 1;
    // Publishes the new mark on the mark-price channel.
    this.emit('tick', { instId, seq: this.tickSeq });
    const positions = this.account.positionsWire(instId, this.now());
    if (positions.length > 0) {
      this.emit('positions', { instId, positions });
      this.matcher.pushAccount();
    }
  }

  private afterMove(instId: string, market: MarketSim, result: TickResult, now: number): void {
    this.account.markToMarket(instId, market.markPx);
    // Before anything fills or stops: a mark that reached both a stop and the liquidation price liquidates.
    this.matcher.checkLiquidations(instId);
    if (result.books) this.emit('books', { instId, push: result.books });
    this.emit('trades', { instId, trades: result.trades });
    this.emit('candles', { instId, candles: result.candles });
    this.matcher.matchResting(instId);
    this.matcher.checkStops(instId);
    this.tickSeq += 1;
    this.emit('tick', { instId, seq: this.tickSeq });
    const positions = this.account.positionsWire(instId, now);
    if (positions.length > 0) {
      this.emit('positions', { instId, positions });
      this.matcher.pushAccount();
    }
  }

  /**
   * A market supplied from outside has new quotes: mark the positions, liquidate the isolated ones the mark has
   * reached, fill what the quotes now reach and trigger the stops. Positions and balance are pushed at most once
   * per `pushEveryMs` for the mark alone; a fill, a triggered stop or a liquidation pushes them itself.
   */
  marketMoved(instId: string, pushEveryMs = 1_000): void {
    const market = this.markets.get(instId);
    if (!market) return;
    this.account.markToMarket(instId, market.markPx);
    this.matcher.checkLiquidations(instId);
    this.matcher.matchResting(instId);
    this.matcher.checkStops(instId);
    const now = this.now();
    if (now - (this.lastMovePush.get(instId) ?? 0) < pushEveryMs) return;
    const positions = this.account.positionsWire(instId, now);
    if (positions.length === 0) return;
    this.lastMovePush.set(instId, now);
    this.emit('positions', { instId, positions });
    this.matcher.pushAccount();
  }

  // ---- public market queries ----

  instrumentList(instId?: string): OkxInstrument[] {
    return [...this.instruments.values()].filter((i) => !instId || i.instId === instId);
  }

  ticker(instId: string): OkxTicker | undefined {
    return this.sims.get(instId)?.ticker(this.now());
  }

  tickers(): OkxTicker[] {
    const now = this.now();
    return [...this.sims.values()].map((m) => m.ticker(now));
  }

  books(instId: string, sz: number): OkxBookData | undefined {
    const market = this.sims.get(instId);
    if (!market) return undefined;
    const { asks, bids } = market.book.levels(sz);
    return { asks, bids, ts: String(this.now()) };
  }

  candles(instId: string, bar: Bar, q: CandleQuery): OkxCandleRow[] | undefined {
    return this.sims.get(instId)?.candles.get(bar)?.rows(q);
  }

  markPrices(instId?: string): OkxMarkPrice[] {
    const now = this.now();
    return [...this.sims.values()].filter((m) => !instId || m.inst.instId === instId).map((m) => m.markPrice(now));
  }

  fundingRate(instId: string): OkxFundingRate | undefined {
    return this.sims.get(instId)?.fundingRate(this.now());
  }

  /** Whether the API key may place, amend or cancel orders, close positions and set leverage. */
  get canTrade(): boolean {
    return this.perm.split(',').includes('trade');
  }

  // ---- account queries ----

  config(): OkxAccountConfig {
    return {
      uid: MOCK_UID,
      mainUid: MOCK_UID,
      acctLv: '2',
      posMode: this.posMode,
      autoLoan: false,
      greeksType: 'PA',
      level: 'Lv1',
      levelTmp: '',
      ctIsoMode: 'automatic',
      mgnIsoMode: 'automatic',
      spotOffsetType: '',
      roleType: '0',
      traderInsts: [],
      spotRoleType: '0',
      spotTraderInsts: [],
      opAuth: '0',
      kycLv: '2',
      label: 'mock-okx',
      ip: '',
      perm: this.perm,
      liquidationGear: '-1',
      enableSpotBorrow: false,
      spotBorrowAutoRepay: false,
    };
  }

  balance(): OkxBalance {
    return this.account.balance(this.orders.ordFrozen(this.instruments), this.now());
  }

  positions(instId?: string): OkxPosition[] {
    return this.account.positionsWire(instId, this.now());
  }

  leverageInfo(instId: string, mgnMode: OkxMgnMode): OkxLeverageInfo[] {
    return this.account.leverageInfo(instId, mgnMode);
  }

  setLeverage(instId: string, mgnMode: OkxMgnMode, lever: Dec, posSide: 'long' | 'short' | undefined): OkxLeverageInfo[] {
    return this.account.setLeverage(instId, mgnMode, lever, posSide);
  }

  /**
   * What a new isolated leverage of an instrument does before it is set: null when it can be set, the refusal
   * otherwise (setting the leverage it already has is always possible, and changes nothing).
   *
   * - OKX refuses a change while isolated orders of the instrument rest (59101).
   * - An open isolated position takes the new leverage with the margin it moves (Account.leverageMarginChange):
   *   lowered, the difference comes from the available balance, and the change is refused when that is not there
   *   (59108); raised, the difference goes back to the balance, and the change is refused when the position
   *   would be left at or below its liquidation threshold (59102). OKX documents these two codes for a leverage
   *   that is too low for the margin there is and one that is too high; that they are the ones it answers with
   *   in exactly these two cases is an assumption.
   */
  changeIsolatedLeverage(instId: string, lever: Dec, posSide: 'long' | 'short' | undefined): Rejection | null {
    const sides: OkxPosSide[] = this.posMode === 'long_short_mode' ? (posSide ? [posSide] : ['long', 'short']) : ['net'];
    const moved: PositionRec[] = [];
    let needed = ZERO;
    for (const side of sides) {
      const held = this.account.find(instId, 'isolated', side);
      const position = held && !held.qty.isZero() ? held : undefined;
      if ((position?.lever ?? this.account.leverFor(instId, 'isolated', side)).eq(lever)) continue;
      if (this.orders.liveOrders(instId).some((o) => o.tdMode === 'isolated' && o.posSide === side)) {
        return reject('59101', "Leverage can't be modified. Please cancel all pending isolated margin orders before adjusting the leverage.");
      }
      if (!position) continue;
      const change = this.account.leverageMarginChange(position, lever);
      if (change.lt(0) && !this.account.survivesWith(position, position.margin.add(change))) return reject('59102', 'Leverage exceeds the maximum limit. Please lower the leverage.');
      if (change.gt(0)) needed = needed.add(change);
      moved.push(position);
    }
    if (needed.gt(this.account.availEq(this.orders.ordFrozen(this.instruments)))) {
      return reject('59108', 'Your account leverage is too low and has insufficient margins. Please increase the leverage.');
    }
    if (moved.length === 0) return null;
    const now = this.now();
    for (const position of moved) this.account.relever(position, lever, now);
    this.emit('positions', { instId, positions: this.account.positionsWire(instId, now) });
    this.matcher.pushAccount();
    return null;
  }

  /**
   * POST /api/v5/account/position/margin-balance: adds margin to an isolated position from the available balance,
   * or takes out of it what it holds beyond its requirement (Account.maxReducible). OKX's refusals: 59300 when
   * there is no such position, 59302 while an order that closes it rests, 59301 for an amount beyond the limit.
   * Unverified: that 59301 is also the answer to an add beyond the available balance, and that 59302 holds for an
   * add as it does for a reduction (its text names the adjustment, not its direction).
   */
  adjustMargin(body: unknown): OkxResponse<OkxMarginAdjustment> {
    const refuse = (code: string, msg: string): OkxResponse<OkxMarginAdjustment> => ({ code, msg, data: [] });
    const raw = asRecord(body);
    if (!raw) return refuse('51000', 'Parameter error');
    const instId = str(raw, 'instId') ?? '';
    if (!this.instruments.has(instId)) return refuse('51001', 'Instrument ID does not exist.');
    const type = raw['type'];
    if (type !== 'add' && type !== 'reduce') return refuse('51000', 'Parameter type error');
    const amtStr = str(raw, 'amt');
    if (!amtStr || !isDecimalString(amtStr) || d(amtStr).lte(0)) return refuse('51000', 'Parameter amt error');
    const posSideRaw = raw['posSide'];
    let posSide: OkxPosSide;
    if (this.posMode === 'long_short_mode') {
      if (posSideRaw !== 'long' && posSideRaw !== 'short') return refuse('51000', 'Parameter posSide error');
      posSide = posSideRaw;
    } else {
      if (posSideRaw !== undefined && posSideRaw !== '' && posSideRaw !== 'net') return refuse('51000', 'Parameter posSide error');
      posSide = 'net';
    }
    const position = this.account.find(instId, 'isolated', posSide);
    if (!position || position.qty.isZero()) return refuse('59300', 'Margin call failed. Position does not exist.');
    const closing = position.dir > 0 ? 'sell' : 'buy';
    if (this.orders.liveOrders(instId).some((o) => o.tdMode === 'isolated' && o.posSide === posSide && o.side === closing)) {
      return refuse('59302', 'Margin adjustment failed due to pending close order. Please cancel any pending close orders.');
    }
    const amt = d(amtStr);
    const limit = type === 'add' ? this.account.availEq(this.orders.ordFrozen(this.instruments)) : this.account.maxReducible(position);
    if (amt.gt(limit)) return refuse('59301', 'Margin adjustment failed for exceeding the max limit.');
    const now = this.now();
    this.account.moveMargin(position, type === 'add' ? amt : amt.neg(), now);
    const wire = this.account.positionWire(position, now);
    this.emit('positions', { instId, positions: this.account.positionsWire(instId, now) });
    this.matcher.pushAccount();
    // "Real leverage after the margin adjustment": the position's value at the mark over the margin it now holds.
    return { code: '0', msg: '', data: [{ instId, posSide, amt: amtStr, type, leverage: d(wire.margin).gt(0) ? fmt(d(wire.notionalUsd).div(wire.margin)) : '', ccy: 'USDT' }] };
  }

  // ---- order queries ----

  orderDetail(instId: string, ordId: string | undefined, clOrdId: string | undefined): OkxOrder | undefined {
    const o = this.orders.findAny(instId, ordId, clOrdId);
    return o ? orderToWire(o, true) : undefined;
  }

  ordersPending(instId?: string): OkxOrder[] {
    return this.orders
      .liveOrders(instId)
      .reverse()
      .map((o) => orderToWire(o, true));
  }

  ordersHistory(instId: string | undefined, limit: number): OkxOrder[] {
    return this.orders.historyOrders(instId, limit).map((o) => orderToWire(o, true));
  }

  /** Active stops as algo orders, newest first. */
  algoOrdersPending(instId?: string): OkxAlgoOrder[] {
    return this.orders
      .activeStops(instId)
      .sort((a, b) => (a.algoId < b.algoId ? 1 : -1))
      .map(stopToAlgoWire);
  }

  fills(instId: string | undefined, limit: number): OkxFill[] {
    return this.orders.fillsList(instId, limit);
  }

  state(): MockState {
    return {
      orders: [...this.ordersPending(), ...this.ordersHistory(undefined, 500)],
      positions: this.positions(),
      balance: this.balance(),
      fills: this.fills(undefined, 1000),
      stops: this.orders.activeStops().map(stopToWire),
    };
  }
}
