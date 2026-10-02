import { EventEmitter } from 'node:events';
import type { OkxBalance, OkxLeverageInfo, OkxOrder, OkxPosition, OkxSetLeverageParams, OkxWsData } from '@pegasus/okx';
import { D, ZERO, type AccountConfig, type Balance, type ConnState, type Fill, type Order, type Position, type TdMode } from '@pegasus/shared';
import type { Store } from '../db/store.js';
import { NotConnectedError } from '../errors.js';
import type { Logger } from '../logger.js';
import type { OkxClients } from '../okx/clients.js';
import { fillFromOrderPush, mapBalance, mapFill, mapOrder, mapPosition, positionKey } from '../okx/mappers.js';

export interface AccountEvents {
  order: [Order];
  fill: [Fill];
  positions: [Position[]];
  balance: [Balance];
  status: [];
}

const OPEN_STATES = new Set<Order['state']>(['live', 'partially_filled']);
const RECONCILE_MS = 60_000;

/**
 * Mirrors the exchange account: balance, positions and open orders, kept in
 * sync by the private WebSocket and periodically reconciled over REST.
 */
export class AccountService extends EventEmitter<AccountEvents> {
  config: AccountConfig = { posMode: 'net_mode', acctLv: '' };
  balance: Balance | null = null;
  readonly positions = new Map<string, Position>();
  readonly openOrders = new Map<string, Order>();
  private readonly seenFills = new Set<string>();
  /** Orders already seen in a terminal state; guards against a late local insert after the fill push raced the order ack. */
  private readonly closedOrders = new Set<string>();
  private readonly leverageCache = new Map<string, OkxLeverageInfo[]>();
  private reconcileTimer: NodeJS.Timeout | null = null;
  private reconciling = false;
  private started = false;

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
    return ws.isReady ? 'connected' : ws.currentStatus;
  }

  async start(): Promise<void> {
    if (this.started || !this.enabled) return;
    this.started = true;
    const ws = this.clients.wsPrivate;
    if (!ws) return;
    this.config = await this.loadConfig();
    await this.reconcile();
    ws.on('data', (msg) => this.onPrivateData(msg));
    ws.on('status', (status, detail) => {
      this.log.info({ ws: 'private', status, detail }, 'okx socket status');
      this.emit('status');
    });
    ws.on('ready', () => {
      this.emit('status');
      void this.reconcile();
    });
    ws.on('error', (err) => this.log.warn({ err: err.message }, 'okx private socket error'));
    await ws.subscribe([
      { channel: 'orders', instType: 'SWAP' },
      { channel: 'positions', instType: 'SWAP' },
      { channel: 'account' },
    ]);
    ws.connect();
    this.reconcileTimer = setInterval(() => void this.reconcile(), RECONCILE_MS);
    this.reconcileTimer.unref();
  }

  async stop(): Promise<void> {
    if (this.reconcileTimer) clearInterval(this.reconcileTimer);
    this.reconcileTimer = null;
    await this.clients.wsPrivate?.close();
  }

  requireReady(): void {
    if (!this.enabled) throw new NotConnectedError('OKX private API (no credentials configured)');
    if (!this.ready) throw new NotConnectedError('OKX private stream');
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

  async getLeverage(instId: string, mgnMode: TdMode): Promise<OkxLeverageInfo[]> {
    const key = `${instId}:${mgnMode}`;
    const cached = this.leverageCache.get(key);
    if (cached) return cached;
    const info = await this.clients.rest.getLeverageInfo(instId, mgnMode);
    this.leverageCache.set(key, info);
    return info;
  }

  async setLeverage(params: OkxSetLeverageParams): Promise<OkxLeverageInfo[]> {
    const info = await this.clients.rest.setLeverage(params);
    if (params.instId) this.leverageCache.delete(`${params.instId}:${params.mgnMode}`);
    return info;
  }

  /** Leverage currently set for an instrument/margin mode (and side in long/short mode). */
  async leverageFor(instId: string, mgnMode: TdMode, posSide: 'long' | 'short' | 'net'): Promise<string> {
    const info = await this.getLeverage(instId, mgnMode);
    const match = info.find((i) => i.posSide === posSide) ?? info.find((i) => i.posSide === 'net') ?? info[0];
    return match?.lever ?? '1';
  }

  // ---- sync ----

  private async loadConfig(): Promise<AccountConfig> {
    const c = await this.clients.rest.getAccountConfig();
    const cfg: AccountConfig = { posMode: c.posMode === 'long_short_mode' ? 'long_short_mode' : 'net_mode', acctLv: c.acctLv };
    this.log.info({ posMode: cfg.posMode, acctLv: cfg.acctLv, demo: this.clients.demo }, 'okx account config loaded');
    return cfg;
  }

  async reconcile(): Promise<void> {
    if (this.reconciling || !this.enabled) return;
    this.reconciling = true;
    try {
      const [balance, positions, pending] = await Promise.all([
        this.clients.rest.getBalance(),
        this.clients.rest.getPositions('SWAP'),
        this.clients.rest.getOrdersPending({ instType: 'SWAP' }),
      ]);
      this.applyBalance(balance);
      this.positions.clear();
      for (const p of positions) this.applyPosition(p);
      this.emit('positions', this.positionList());
      const seen = new Set<string>();
      for (const o of pending) {
        const order = mapOrder(o);
        seen.add(order.ordId);
        const prev = this.openOrders.get(order.ordId);
        if (!prev || prev.uTime <= order.uTime) {
          this.openOrders.set(order.ordId, order);
          if (!prev || prev.state !== order.state || prev.accFillSz !== order.accFillSz) this.emit('order', order);
          void this.store.upsertOrder(order).catch((err: Error) => this.log.warn({ err: err.message }, 'store.upsertOrder failed'));
        }
      }
      for (const [ordId, order] of this.openOrders) {
        if (seen.has(ordId)) continue;
        // The exchange no longer lists it as open; fetch the final state so the UI and journal agree.
        this.openOrders.delete(ordId);
        this.rememberClosed(ordId);
        try {
          const final = mapOrder(await this.clients.rest.getOrder({ instId: order.instId, ordId }));
          this.emit('order', final);
          void this.store.upsertOrder(final).catch(() => undefined);
        } catch (err) {
          this.log.warn({ ordId, err: (err as Error).message }, 'could not fetch final state of vanished order');
          this.emit('order', { ...order, state: 'canceled', uTime: Date.now() });
        }
      }
    } catch (err) {
      this.log.warn({ err: (err as Error).message }, 'account reconcile failed');
    } finally {
      this.reconciling = false;
    }
  }

  private applyBalance(b: OkxBalance): void {
    this.balance = mapBalance(b);
    this.emit('balance', this.balance);
  }

  private applyPosition(p: OkxPosition): boolean {
    const pos = mapPosition(p);
    const key = positionKey(pos);
    if (D(pos.pos).isZero()) {
      return this.positions.delete(key);
    }
    this.positions.set(key, pos);
    return true;
  }

  private onPrivateData(msg: OkxWsData): void {
    switch (msg.arg.channel) {
      case 'orders':
        for (const raw of msg.data as OkxOrder[]) this.applyOrderPush(raw);
        return;
      case 'positions': {
        for (const raw of msg.data as OkxPosition[]) this.applyPosition(raw);
        this.emit('positions', this.positionList());
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
  noteLocalOrder(order: Order): void {
    if (this.closedOrders.has(order.ordId) || this.openOrders.has(order.ordId)) return;
    this.openOrders.set(order.ordId, order);
    this.emit('order', order);
  }

  private rememberClosed(ordId: string): void {
    this.closedOrders.add(ordId);
    if (this.closedOrders.size > 10_000) this.closedOrders.delete(this.closedOrders.values().next().value as string);
  }

  private applyOrderPush(raw: OkxOrder): void {
    const order = mapOrder(raw);
    if (OPEN_STATES.has(order.state)) {
      this.openOrders.set(order.ordId, order);
    } else {
      this.openOrders.delete(order.ordId);
      this.rememberClosed(order.ordId);
    }
    this.emit('order', order);
    void this.store.upsertOrder(order).catch((err: Error) => this.log.warn({ err: err.message }, 'store.upsertOrder failed'));
    const fill = fillFromOrderPush(raw);
    if (fill && !this.seenFills.has(fill.tradeId)) {
      this.seenFills.add(fill.tradeId);
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
