import { d, type Dec } from '../num.js';
import { Prng } from '../prng.js';
import type { MockState } from '../types.js';
import type { OkxAccountConfig, OkxBalance, OkxBookData, OkxCandleRow, OkxFill, OkxFundingRate, OkxInstrument, OkxLeverageInfo, OkxMarkPrice, OkxMgnMode, OkxOrder, OkxPosMode, OkxPosition, OkxTicker } from '../wire.js';
import { Account } from './account.js';
import type { Bar, CandleQuery } from './candles.js';
import type { EngineContext, EngineEvents, EventName, Listener } from './context.js';
import { MarketSim, type TickResult } from './market.js';
import { Matcher } from './matching.js';
import { OrderStore, orderToWire, stopToWire } from './orders.js';

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
}

export const MOCK_UID = '1234567890';

/** The whole exchange simulation: markets, account, matching and an event bus. */
export class Engine implements EngineContext {
  readonly posMode: OkxPosMode;
  readonly perm: string;
  readonly instruments = new Map<string, OkxInstrument>();
  readonly markets = new Map<string, MarketSim>();
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
      const px = d(cfg.initialPrices[inst.instId] ?? '100');
      this.markets.set(inst.instId, new MarketSim(inst, px, rng, { volatility: cfg.volatility, tickIntervalMs: cfg.tickIntervalMs }, now));
    }
    this.account = new Account(d(cfg.initialBalanceUsdt), cfg.posMode, this.instruments);
    this.matcher = new Matcher(this);
  }

  now(): number {
    return Date.now();
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
    for (const [instId, market] of this.markets) this.afterMove(instId, market, market.step(now), now);
  }

  setPrice(instId: string, px: string): void {
    const market = this.markets.get(instId);
    if (!market) throw new Error(`unknown instrument ${instId}`);
    const now = this.now();
    this.afterMove(instId, market, market.step(now, d(px)), now);
  }

  /** Pins the mark price apart from the mid (null: it follows the mid again) and checks the stops against it. */
  setMarkPrice(instId: string, px: string | null): void {
    const market = this.markets.get(instId);
    if (!market) throw new Error(`unknown instrument ${instId}`);
    market.pinMark(px === null ? null : d(px));
    this.account.markToMarket(instId, market.markPx);
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

  // ---- public market queries ----

  instrumentList(instId?: string): OkxInstrument[] {
    return [...this.instruments.values()].filter((i) => !instId || i.instId === instId);
  }

  ticker(instId: string): OkxTicker | undefined {
    return this.markets.get(instId)?.ticker(this.now());
  }

  tickers(): OkxTicker[] {
    const now = this.now();
    return [...this.markets.values()].map((m) => m.ticker(now));
  }

  books(instId: string, sz: number): OkxBookData | undefined {
    const market = this.markets.get(instId);
    if (!market) return undefined;
    const { asks, bids } = market.book.levels(sz);
    return { asks, bids, ts: String(this.now()) };
  }

  candles(instId: string, bar: Bar, q: CandleQuery): OkxCandleRow[] | undefined {
    return this.markets.get(instId)?.candles.get(bar)?.rows(q);
  }

  markPrices(instId?: string): OkxMarkPrice[] {
    const now = this.now();
    return [...this.markets.values()].filter((m) => !instId || m.inst.instId === instId).map((m) => m.markPrice(now));
  }

  fundingRate(instId: string): OkxFundingRate | undefined {
    return this.markets.get(instId)?.fundingRate(this.now());
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
