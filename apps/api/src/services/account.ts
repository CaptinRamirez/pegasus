import { EventEmitter } from 'node:events';
import { OkxApiError, OkxWsError, type OkxAccountConfig, type OkxAlgoOrder, type OkxBalance, type OkxLeverageInfo, type OkxOrder, type OkxPosition, type OkxSetLeverageParams, type OkxWsData } from '@pegasus/okx';
import { D, ZERO, type AccountConfig, type AccountError, type AccountStatus, type AlgoOrderList, type Balance, type ConnState, type Fill, type Order, type Position, type TdMode } from '@pegasus/shared';
import type { Store } from '../db/store.js';
import { NotConnectedError, ReadOnlyKeyError } from '../errors.js';
import type { Logger } from '../logger.js';
import type { OkxClients } from '../okx/clients.js';
import { failedAttachedStop, fillFromOrderPush, mapAlgoOrder, mapBalance, mapFill, mapOrder, mapPosition, positionKey } from '../okx/mappers.js';

export interface AccountEvents {
  order: [Order];
  fill: [Fill];
  positions: [Position[]];
  balance: [Balance];
  /** The stop-loss / take-profit algo orders were read from the exchange; emitted after every read, changed or not. */
  algoOrders: [AlgoOrderList];
  /** The account config was loaded for the first time or changed on the exchange. */
  config: [AccountConfig];
  /** The private socket state or the account status (state, error, read-only) changed. */
  status: [];
}

const OPEN_STATES = new Set<Order['state']>(['live', 'partially_filled']);
const RECONCILE_MS = 60_000;
/** Leverage can be changed outside this process (OKX app, other clients); cached values expire quickly. */
const LEVERAGE_TTL_MS = 30_000;
/** An order the exchange no longer knows (51603) is dropped at once when older than this; a younger one may just not be queryable yet. */
const VANISHED_ORDER_AGE_MS = 120_000;
/** The two TP/SL algo order types; OKX lists them together in one call. */
const ALGO_ORD_TYPES = 'conditional,oco';
const ALGO_PAGE_SIZE = 100;
const ALGO_MAX_PAGES = 5;
/**
 * A fill, a cancel or a position change may have created, consumed or orphaned a stop. Algo orders are not on
 * the private socket, so the list is read again this long after such an event, and once more for an exchange
 * that was slow to act on it.
 */
const ALGO_REFRESH_DELAYS_MS = [1_000, 5_000] as const;

function mapConfig(c: OkxAccountConfig): AccountConfig {
  const perms = (c.perm ?? '').split(',').map((p) => p.trim()).filter((p) => p !== '');
  // Without a perm list the key is assumed to be able to trade and the exchange decides.
  return { posMode: c.posMode === 'long_short_mode' ? 'long_short_mode' : 'net_mode', acctLv: c.acctLv, canTrade: perms.length === 0 || perms.includes('trade') };
}

/** The exchange's own code and text when it answered; the transport failure otherwise. */
function describeFailure(err: unknown, ts: number): AccountError {
  if (err instanceof OkxApiError) return { code: err.code, message: err.okxMessage, ts };
  if (err instanceof OkxWsError) return { code: err.code ?? '', message: err.message, ts };
  return { code: '', message: (err as Error).message, ts };
}

/**
 * Mirrors the exchange account: balance, positions and open orders, kept in
 * sync by the private WebSocket and periodically reconciled over REST.
 */
export class AccountService extends EventEmitter<AccountEvents> {
  /** null until the first successful load: the position mode is not guessed. */
  config: AccountConfig | null = null;
  balance: Balance | null = null;
  readonly positions = new Map<string, Position>();
  readonly openOrders = new Map<string, Order>();
  /** The stop-loss / take-profit algo orders as last read over REST; null until the first read succeeded. */
  algoOrders: AlgoOrderList | null = null;
  /** The algo order read in flight, if any. */
  private algoSyncing: Promise<AlgoOrderList> | null = null;
  /** Pending delayed reads of the algo orders, by their delay. */
  private readonly algoTimers = new Map<number, NodeJS.Timeout>();
  private readonly seenFills = new Set<string>();
  /** Orders already seen in a terminal state; guards against a late local insert after the fill push raced the order ack. */
  private readonly closedOrders = new Set<string>();
  /** How many REST snapshots in a row each open order has been missing from. */
  private readonly missedSnapshots = new Map<string, number>();
  /** Positions closed by a push, with the exchange time of the close; guards against a REST snapshot taken before it. */
  private readonly closedPositions = new Map<string, number>();
  private readonly leverageCache = new Map<string, { info: OkxLeverageInfo[]; fetchedAt: number }>();
  private reconcileTimer: NodeJS.Timeout | null = null;
  /** The REST reconcile in flight, if any. */
  private syncing: Promise<void> | null = null;
  private started = false;
  private stopped = false;
  private retryTimer: NodeJS.Timeout | null = null;
  /** Why the last REST bootstrap or reconcile failed; null once one succeeded. */
  private restError: AccountError | null = null;
  /** Why the private socket could not log in; null once it is ready. */
  private wsError: AccountError | null = null;
  private lastSyncAt: number | null = null;

  constructor(
    private readonly clients: OkxClients,
    private readonly store: Store,
    private readonly log: Logger,
  ) {
    super();
  }

  get enabled(): boolean {
    return this.clients.wsPrivate !== null;
  }

  get ready(): boolean {
    return this.clients.wsPrivate?.isReady ?? false;
  }

  connection(): ConnState {
    const ws = this.clients.wsPrivate;
    if (!ws) return 'disconnected';
    if (ws.isReady) return 'connected';
    // An open socket that has not logged in yet delivers nothing: it is still connecting.
    return ws.currentStatus === 'disconnected' ? 'disconnected' : 'connecting';
  }

  status(): AccountStatus {
    const error = this.restError ?? this.wsError;
    const state = !this.enabled ? 'disabled' : error ? 'error' : this.started ? 'ok' : 'starting';
    return { state, error, lastSyncAt: this.lastSyncAt, readOnly: this.config !== null && !this.config.canTrade };
  }

  /** One start attempt; a failure is recorded in the status and rethrown. */
  async start(): Promise<void> {
    if (this.started || !this.enabled) return;
    const ws = this.clients.wsPrivate;
    if (!ws) return;
    // Nothing is marked started until the REST bootstrap succeeded, so a transient failure can be retried.
    await this.refresh();
    this.started = true;
    this.emit('status');
    ws.on('data', (msg) => this.onPrivateData(msg));
    ws.on('status', (status, detail) => {
      this.log.info({ ws: 'private', status, detail }, 'okx socket status');
      this.emit('status');
    });
    ws.on('ready', () => {
      this.wsError = null;
      this.emit('status');
      void this.reconcile();
    });
    ws.on('error', (err) => {
      this.log.warn({ err: err.message }, 'okx private socket error');
      // The client raises OkxWsError only when the login after a connect failed; plain socket errors show as a disconnected stream.
      if (err instanceof OkxWsError) {
        this.wsError = describeFailure(err, Date.now());
        this.emit('status');
      }
    });
    await ws.subscribe([
      { channel: 'orders', instType: 'SWAP' },
      { channel: 'positions', instType: 'SWAP' },
      { channel: 'account' },
    ]);
    ws.connect();
    this.reconcileTimer = setInterval(() => void this.reconcile(), RECONCILE_MS);
    this.reconcileTimer.unref();
  }

  /** The private side needs REST calls that may fail (bad key, clock, network); keep retrying without blocking market data. */
  async startWithRetry(): Promise<void> {
    if (!this.enabled) return;
    for (let attempt = 1; !this.stopped; attempt++) {
      try {
        await this.start();
        return;
      } catch (err) {
        const delay = Math.min(60_000, 5_000 * attempt);
        this.log.error({ err: (err as Error).message, attempt, retryInMs: delay }, 'account service failed to start; retrying');
        await new Promise<void>((resolve) => {
          this.retryTimer = setTimeout(resolve, delay);
          this.retryTimer.unref();
        });
      }
    }
  }

  async stop(): Promise<void> {
    this.stopped = true;
    if (this.retryTimer) clearTimeout(this.retryTimer);
    this.retryTimer = null;
    if (this.reconcileTimer) clearInterval(this.reconcileTimer);
    this.reconcileTimer = null;
    for (const timer of this.algoTimers.values()) clearTimeout(timer);
    this.algoTimers.clear();
    await this.clients.wsPrivate?.close();
  }

  requireReady(): void {
    if (!this.enabled) throw new NotConnectedError('OKX private API (no credentials configured)');
    if (!this.ready) throw new NotConnectedError('OKX private stream');
  }

  /** Gate for placing orders; returns the config so callers never act on an unknown position mode. */
  requireTrading(): AccountConfig {
    if (!this.enabled) throw new NotConnectedError('OKX private API (no credentials configured)');
    if (this.config !== null && !this.config.canTrade) throw new ReadOnlyKeyError();
    this.requireReady();
    return this.requireConfig();
  }

  /**
   * Gate for the writes that are plain REST calls and take no risk decision from the mirror (cancel, close, set leverage):
   * credentials and the trade permission, not the private stream. Exits must work while the stream is down.
   */
  requireRestTrading(): AccountConfig {
    const config = this.requireConfig();
    if (!config.canTrade) throw new ReadOnlyKeyError();
    return config;
  }

  requireConfig(): AccountConfig {
    if (!this.enabled) throw new NotConnectedError('OKX private API (no credentials configured)');
    if (this.config === null) throw new NotConnectedError('OKX account (position mode not loaded yet)');
    return this.config;
  }

  // ---- queries ----

  positionList(): Position[] {
    return [...this.positions.values()];
  }

  openOrderList(): Order[] {
    return [...this.openOrders.values()].sort((a, b) => b.cTime - a.cTime);
  }

  /** Sum of absolute USD notional across all positions. */
  totalPositionNotional(): string {
    let acc = ZERO;
    for (const p of this.positions.values()) acc = acc.plus(D(p.notionalUsd || '0').abs());
    return acc.toFixed();
  }

  /** `fresh` skips the cache: an order must be checked against the leverage OKX has now, not the one of 30 s ago. */
  async getLeverage(instId: string, mgnMode: TdMode, fresh = false): Promise<OkxLeverageInfo[]> {
    const key = `${instId}:${mgnMode}`;
    const cached = this.leverageCache.get(key);
    if (!fresh && cached && Date.now() - cached.fetchedAt < LEVERAGE_TTL_MS) return cached.info;
    const info = await this.clients.rest.getLeverageInfo(instId, mgnMode);
    if (info.length > 0) this.leverageCache.set(key, { info, fetchedAt: Date.now() });
    else this.leverageCache.delete(key);
    return info;
  }

  async setLeverage(params: OkxSetLeverageParams): Promise<OkxLeverageInfo[]> {
    const info = await this.clients.rest.setLeverage(params);
    if (params.instId) this.leverageCache.delete(`${params.instId}:${params.mgnMode}`);
    return info;
  }

  /** Leverage currently set for an instrument/margin mode (and side in long/short mode); throws when OKX reports none. */
  async leverageFor(instId: string, mgnMode: TdMode, posSide: 'long' | 'short' | 'net', fresh = false): Promise<string> {
    const info = await this.getLeverage(instId, mgnMode, fresh);
    const match = info.find((i) => i.posSide === posSide) ?? info.find((i) => i.posSide === 'net') ?? info[0];
    // No row is "unknown", not 1x: the caller's leverage rule must fail closed.
    if (!match || !match.lever) throw new Error(`OKX returned no leverage for ${instId} ${mgnMode}`);
    return match.lever;
  }

  /** The exchange's clock: uTime / cTime of orders and positions are compared against this, never the local clock. */
  private exchangeNow(): number {
    return Date.now() + this.clients.clock.offsetMs;
  }

  // ---- sync ----

  /** Position mode and key permissions can be changed on OKX at any time, so they are re-read with every reconcile. */
  private async loadConfig(): Promise<void> {
    const cfg = mapConfig(await this.clients.rest.getAccountConfig());
    const prev = this.config;
    if (prev && prev.posMode === cfg.posMode && prev.acctLv === cfg.acctLv && prev.canTrade === cfg.canTrade) return;
    this.config = cfg;
    this.log.info({ posMode: cfg.posMode, acctLv: cfg.acctLv, canTrade: cfg.canTrade, demo: this.clients.demo }, prev ? 'okx account config changed' : 'okx account config loaded');
    if (!cfg.canTrade) this.log.warn('the API key has no trade permission: orders, cancels, closes and leverage changes are refused');
    this.emit('config', cfg);
    this.emit('status');
  }

  private noteFailure(err: unknown): void {
    const prev = this.restError;
    this.restError = describeFailure(err, Date.now());
    if (!prev || prev.code !== this.restError.code || prev.message !== this.restError.message) this.emit('status');
  }

  async reconcile(force = false): Promise<void> {
    if (this.syncing || !this.enabled) return;
    if (!force && !this.started) return;
    // The failure is logged and recorded in the status by sync(); the next timer tick tries again.
    await this.sync().catch(() => undefined);
  }

  /**
   * A full REST reconcile that has completed when this resolves; rejects with the reason when it failed.
   * Does not need the private stream.
   */
  async refresh(): Promise<void> {
    if (!this.enabled) throw new NotConnectedError('OKX private API (no credentials configured)');
    // A reconcile already in flight may have read the exchange before the caller's last write: wait, then pull again.
    while (this.syncing) await this.syncing.catch(() => undefined);
    await this.sync();
  }

  private sync(): Promise<void> {
    const run = this.pull().finally(() => {
      if (this.syncing === run) this.syncing = null;
    });
    this.syncing = run;
    return run;
  }

  /**
   * Pull the account config, balance, positions and open orders over REST and
   * merge them into the local state without reverting anything a WebSocket push
   * updated in the meantime: entries are only replaced by newer data (uTime) and
   * only orders known before the call went out can be evicted.
   */
  private async pull(): Promise<void> {
    const t0 = this.exchangeNow();
    const knownBefore = [...this.openOrders.keys()];
    try {
      // On its own first: a rejected key then costs one request per attempt instead of four.
      await this.loadConfig();
      const [balance, positions, pending] = await Promise.all([
        this.clients.rest.getBalance(),
        this.clients.rest.getPositions('SWAP'),
        this.clients.rest.getOrdersPending({ instType: 'SWAP' }),
      ]);
      this.leverageCache.clear();
      if (!this.balance || this.balance.ts <= Number(balance.uTime || '0')) this.applyBalance(balance);

      const restKeys = new Set<string>();
      for (const raw of positions) {
        const pos = mapPosition(raw);
        const key = positionKey(pos);
        restKeys.add(key);
        const local = this.positions.get(key);
        if (local && local.uTime > pos.uTime) continue; // a push during the round trip is newer
        const closedAt = this.closedPositions.get(key);
        if (closedAt !== undefined) {
          if (pos.uTime <= closedAt) continue; // closed by a push while the snapshot was in flight
          this.closedPositions.delete(key);
        }
        if (D(pos.pos).isZero()) this.positions.delete(key);
        else this.positions.set(key, pos);
      }
      for (const [key, local] of this.positions) {
        if (!restKeys.has(key) && local.uTime < t0) this.positions.delete(key);
      }
      this.emit('positions', this.positionList());

      const seen = new Set<string>();
      for (const o of pending) {
        const order = mapOrder(o);
        seen.add(order.ordId);
        this.missedSnapshots.delete(order.ordId);
        if (this.closedOrders.has(order.ordId)) continue; // closed by a push while the snapshot was in flight
        const prev = this.openOrders.get(order.ordId);
        if (prev && prev.uTime > order.uTime) continue;
        this.openOrders.set(order.ordId, order);
        if (!prev || prev.state !== order.state || prev.accFillSz !== order.accFillSz) this.emit('order', order);
        void this.store.upsertOrder(order).catch((err: Error) => this.log.warn({ err: err.message }, 'store.upsertOrder failed'));
      }
      for (const ordId of knownBefore) {
        if (seen.has(ordId)) continue;
        const order = this.openOrders.get(ordId);
        if (!order) {
          this.missedSnapshots.delete(ordId);
          continue;
        }
        const missed = (this.missedSnapshots.get(ordId) ?? 0) + 1;
        this.missedSnapshots.set(ordId, missed);
        // The exchange no longer lists it as open; confirm its final state before dropping it.
        try {
          const final = mapOrder(await this.clients.rest.getOrder({ instId: order.instId, ordId }));
          if (OPEN_STATES.has(final.state)) {
            if (order.uTime <= final.uTime) this.openOrders.set(ordId, final);
            continue;
          }
          this.dropOrder(ordId);
          this.emit('order', final);
          void this.store.upsertOrder(final).catch(() => undefined);
        } catch (err) {
          // 51603 (order does not exist): OKX has purged it, so its final state will never be confirmed. Kept for
          // ever it would count in exposure and the open-order limit; a just-placed order is protected by its age.
          if (err instanceof OkxApiError && err.code === '51603' && (missed >= 2 || t0 - order.cTime > VANISHED_ORDER_AGE_MS)) {
            const gone: Order = { ...order, state: 'canceled', uTime: this.exchangeNow() };
            this.dropOrder(ordId);
            this.log.warn({ ordId, instId: order.instId, missed }, 'open order no longer exists on the exchange; dropped as canceled');
            this.emit('order', gone);
            void this.store.upsertOrder(gone).catch(() => undefined);
            continue;
          }
          this.log.warn({ ordId, err: (err as Error).message }, 'could not confirm state of vanished order; keeping it until the next reconcile');
        }
      }
      this.lastSyncAt = Date.now();
      if (this.restError) {
        this.restError = null;
        this.emit('status');
      }
    } catch (err) {
      this.log.warn({ err: (err as Error).message }, 'account reconcile failed');
      this.noteFailure(err);
      throw err;
    }
    // Apart from the account itself: a failed read of the stops must not fail the reconcile of balance, positions and orders.
    await this.readAlgoOrdersQuietly();
  }

  // ---- algo orders (stops) ----

  /**
   * Reads the TP/SL algo orders from the exchange now and resolves with the list read; rejects with the reason
   * when the read failed. Does not need the private stream.
   */
  async refreshAlgoOrders(): Promise<AlgoOrderList> {
    if (!this.enabled) throw new NotConnectedError('OKX private API (no credentials configured)');
    // A read already in flight may have started before the caller's last write: wait, then read again.
    while (this.algoSyncing) await this.algoSyncing.catch(() => undefined);
    const run = this.pullAlgoOrders().finally(() => {
      if (this.algoSyncing === run) this.algoSyncing = null;
    });
    this.algoSyncing = run;
    return run;
  }

  /** A read whose failure is only logged: the list keeps the time of the last successful read, which the terminal shows. */
  private async readAlgoOrdersQuietly(): Promise<void> {
    if (!this.enabled || this.stopped) return;
    try {
      await this.refreshAlgoOrders();
    } catch (err) {
      this.log.warn({ err: (err as Error).message, lastReadAt: this.algoOrders?.ts ?? null }, 'algo order read failed; the stops shown are the ones of the last successful read');
    }
  }

  /** Something happened that may have created, consumed or orphaned a stop: read the list again shortly. */
  expectAlgoChange(): void {
    if (!this.enabled || this.stopped) return;
    for (const delay of ALGO_REFRESH_DELAYS_MS) {
      if (this.algoTimers.has(delay)) continue;
      const timer = setTimeout(() => {
        this.algoTimers.delete(delay);
        void this.readAlgoOrdersQuietly();
      }, delay);
      timer.unref();
      this.algoTimers.set(delay, timer);
    }
  }

  private async pullAlgoOrders(): Promise<AlgoOrderList> {
    const rows: OkxAlgoOrder[] = [];
    let after: string | undefined;
    for (let page = 1; ; page++) {
      const params: { ordType: string; instType: 'SWAP'; limit: number; after?: string } = { ordType: ALGO_ORD_TYPES, instType: 'SWAP', limit: ALGO_PAGE_SIZE };
      if (after !== undefined) params.after = after;
      const batch = await this.clients.rest.getAlgoOrdersPending(params);
      rows.push(...batch);
      const last = batch[batch.length - 1];
      if (batch.length < ALGO_PAGE_SIZE || !last) break;
      if (page === ALGO_MAX_PAGES) {
        this.log.warn({ read: rows.length }, 'more algo orders than are read; the stops shown are incomplete');
        break;
      }
      after = last.algoId;
    }
    const list: AlgoOrderList = { orders: rows.map(mapAlgoOrder).sort((a, b) => b.cTime - a.cTime), ts: Date.now() };
    this.algoOrders = list;
    this.emit('algoOrders', list);
    return list;
  }

  private applyBalance(b: OkxBalance): void {
    const next = mapBalance(b);
    // OKX can push an account update without a total equity. That is "not reported", not zero: the last value
    // is kept, so the risk engine never sees a total loss (or takes a zero baseline) that did not happen.
    if (!b.totalEq) {
      if (!this.balance) return;
      next.totalEq = this.balance.totalEq;
    }
    this.balance = next;
    this.emit('balance', this.balance);
  }

  /** Applies a position push; true when it changed the size of the position (opened, grew, shrank or closed). */
  private applyPosition(p: OkxPosition): boolean {
    const pos = mapPosition(p);
    const key = positionKey(pos);
    const before = this.positions.get(key)?.pos;
    if (D(pos.pos).isZero()) {
      this.closedPositions.set(key, pos.uTime || this.exchangeNow());
      if (this.closedPositions.size > 1_000) this.closedPositions.delete(this.closedPositions.keys().next().value as string);
      return this.positions.delete(key);
    }
    this.closedPositions.delete(key);
    this.positions.set(key, pos);
    return before === undefined || !D(before).eq(pos.pos);
  }

  private onPrivateData(msg: OkxWsData): void {
    this.lastSyncAt = Date.now();
    switch (msg.arg.channel) {
      case 'orders':
        for (const raw of msg.data as OkxOrder[]) this.applyOrderPush(raw);
        return;
      case 'positions': {
        let resized = false;
        for (const raw of msg.data as OkxPosition[]) resized = this.applyPosition(raw) || resized;
        this.emit('positions', this.positionList());
        // A position that changed size may have gained a stop (its entry filled) or lost one (it was closed).
        if (resized) this.expectAlgoChange();
        return;
      }
      case 'account': {
        const last = msg.data[msg.data.length - 1] as OkxBalance | undefined;
        if (last) this.applyBalance(last);
        return;
      }
      default:
        return;
    }
  }

  /**
   * Record an order this process just submitted. The exchange may have pushed
   * its fill before the placement ack arrived, in which case it is already
   * closed and must not be re-inserted as open.
   */
  noteLocalOrder(order: Order): boolean {
    if (this.closedOrders.has(order.ordId) || this.openOrders.has(order.ordId)) return false;
    this.openOrders.set(order.ordId, order);
    this.emit('order', order);
    return true;
  }

  private dropOrder(ordId: string): void {
    this.openOrders.delete(ordId);
    this.missedSnapshots.delete(ordId);
    this.rememberClosed(ordId);
  }

  private rememberClosed(ordId: string): void {
    this.closedOrders.add(ordId);
    if (this.closedOrders.size > 10_000) this.closedOrders.delete(this.closedOrders.values().next().value as string);
  }

  private applyOrderPush(raw: OkxOrder): void {
    const order = mapOrder(raw);
    const lostStop = failedAttachedStop(raw);
    if (lostStop) {
      this.log.error({ ordId: order.ordId, clOrdId: order.clOrdId, instId: order.instId, slTriggerPx: lostStop.slTriggerPx, failCode: lostStop.failCode, failReason: lostStop.failReason }, 'the exchange did not create the stop-loss attached to this order; its position has no stop, place one on OKX');
    }
    if (OPEN_STATES.has(order.state)) {
      this.openOrders.set(order.ordId, order);
    } else {
      this.dropOrder(order.ordId);
      // An order that ended may have generated its attached stop, or be the closing order of a stop that fired.
      this.expectAlgoChange();
    }
    this.emit('order', order);
    void this.store.upsertOrder(order).catch((err: Error) => this.log.warn({ err: err.message }, 'store.upsertOrder failed'));
    const fill = fillFromOrderPush(raw);
    const fillKey = fill ? `${fill.instId}:${fill.tradeId}` : '';
    if (fill && !this.seenFills.has(fillKey)) {
      this.seenFills.add(fillKey);
      if (this.seenFills.size > 10_000) this.seenFills.delete(this.seenFills.values().next().value as string);
      this.emit('fill', fill);
      void this.store.upsertFill(fill).catch((err: Error) => this.log.warn({ err: err.message }, 'store.upsertFill failed'));
    }
  }

  /** Recent fills from the exchange (REST), newest first; falls back to the journal when the private API is unavailable. */
  async recentFills(instId: string | undefined, limit: number): Promise<Fill[]> {
    if (this.enabled) {
      try {
        const params: { instType: 'SWAP'; instId?: string; limit: number } = { instType: 'SWAP', limit };
        if (instId !== undefined) params.instId = instId;
        return (await this.clients.rest.getFills(params)).map(mapFill);
      } catch (err) {
        this.log.warn({ err: (err as Error).message }, 'fills fetch failed; serving journal');
      }
    }
    const opts: { instId?: string; limit: number } = { limit };
    if (instId !== undefined) opts.instId = instId;
    return this.store.listFills(opts);
  }

  async orderHistory(instId: string | undefined, limit: number): Promise<Order[]> {
    if (this.enabled) {
      try {
        const params: { instType: 'SWAP'; instId?: string; limit: number } = { instType: 'SWAP', limit };
        if (instId !== undefined) params.instId = instId;
        return (await this.clients.rest.getOrdersHistory(params)).map(mapOrder);
      } catch (err) {
        this.log.warn({ err: (err as Error).message }, 'order history fetch failed; serving journal');
      }
    }
    const opts: { instId?: string; limit: number } = { limit };
    if (instId !== undefined) opts.instId = instId;
    return this.store.listOrders(opts);
  }
}
