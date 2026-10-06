import { OkxApiError } from '@pegasus/okx';
import { algoOrderClosesPosition, D, positionDirection, type AlgoOrderList, type Order, type PendingTrailingExit } from '@pegasus/shared';
import type { Store } from '../db/store.js';
import { AppError } from '../errors.js';
import type { Logger } from '../logger.js';
import type { OkxClients } from '../okx/clients.js';
import { mapOrder } from '../okx/mappers.js';
import type { AccountService } from './account.js';
import type { ChannelTrailingService } from './channel-trailing.js';
import type { ExitStateFile } from './exit-state.js';
import { isPegasusExitAlgo, trailingAlgoClOrdIdFor, type OrderPlacedEvent, type OrderService } from './order-service.js';

/**
 * The exits that follow an opening order, and the leftovers of closed positions.
 *
 * - An opening order with `trailing` (POST /api/orders) is remembered by its clOrdId, in TRAILING_STATE_FILE so that a
 *   restart does not lose it, until it has filled: completely, or partially and then cancelled. Then its trailing exit
 *   is placed for the position as it is then: `callback` becomes the exchange's trailing stop (OrderService.
 *   placeTrailingStop, client id `tr` + the tail of the order's clOrdId) for the whole position; `channel` flags the
 *   position for channel trailing (ChannelTrailingService.enable), which places or moves its stop-loss at once. An
 *   order cancelled before any fill drops it. The order's state comes from the account's order pushes, and, for one
 *   that may have filled before the order was acknowledged or while the API was not running, from a lookup by clOrdId.
 *   A placement that fails for a passing reason is tried again every 30 s, up to 10 times; one the risk engine or the
 *   exchange refuses is dropped and logged as an error.
 * - OKX keeps a trailing stop when its position is fully closed (it has no cxlOnClosePos), and with it would close the
 *   next position on that side; the same holds for the TP/SL orders placed without cxlOnClosePos (Pegasus sends it in
 *   net mode only). Every algo order list read is looked through for the algo orders Pegasus placed (client ids
 *   `sl…`, `ch…`, `tp1…` to `tp5…`, `tr…`) that are older than 30 s and close no open position: they are cancelled
 *   and logged. Orders Pegasus did not place are left alone; the campaign (client ids `pc…`) places none.
 * - Only where the exits of this stage are enabled (paper trading and the local mock).
 */

const RETRY_MS = 30_000;
const MAX_ATTEMPTS = 10;
/** An exit this young may belong to a position the mirror does not show yet */
const ORPHAN_AGE_MS = 30_000;

export interface ExitFollowUpDeps {
  clients: OkxClients;
  account: AccountService;
  orders: OrderService;
  channel: ChannelTrailingService;
  store: Store;
  log: Logger;
}

export interface ExitFollowUpOptions {
  enabled: boolean;
  state: ExitStateFile;
  now?: () => number;
  /** How often the pending exits are looked at again; 0: never by itself. Default 30 s */
  retryMs?: number;
  /** How old a take-profit or trailing stop of a closed position must be before it is cancelled. Default 30 s */
  orphanAgeMs?: number;
}

/** A failure after which trying again later may succeed: nothing reached the exchange, or it refused for a passing reason (busy, rate limit). */
function isPassing(err: unknown): boolean {
  if (err instanceof AppError) {
    if (err.code === 'EXCHANGE') return err.status === 429 || /^500\d\d$/.test(String(err.details?.['okxCode'] ?? ''));
    return ['NOT_CONNECTED', 'NO_PRICE', 'EXCHANGE_UNREACHABLE', 'LEVERAGE_UNAVAILABLE'].includes(err.code) || err.status === 503;
  }
  if (err instanceof OkxApiError) return err.isRateLimited || /^500\d\d$/.test(err.code);
  return true;
}

export class ExitFollowUp {
  private timer: NodeJS.Timeout | null = null;
  private readonly executing = new Set<string>();
  private cleaning = false;
  private readonly now: () => number;
  private readonly log: Logger;
  private started = false;

  constructor(
    private readonly deps: ExitFollowUpDeps,
    private readonly opts: ExitFollowUpOptions,
  ) {
    this.now = opts.now ?? Date.now;
    this.log = deps.log.child({ component: 'exit-orders' });
  }

  private get pending(): PendingTrailingExit[] {
    return this.opts.state.state.pending;
  }

  start(): void {
    if (!this.opts.enabled || this.started) return;
    this.started = true;
    // An unreadable file is never written over (ExitStateFile.save): what waits is then kept in memory only.
    if (this.opts.state.error) this.log.error({ err: this.opts.state.error }, 'trailing state unreadable: the trailing exits of new orders are kept in memory only until it is repaired');
    this.deps.orders.onPlaced((e) => this.onPlaced(e));
    this.deps.account.on('order', (o) => this.onOrder(o));
    this.deps.account.on('algoOrders', (list) => void this.cleanup(list));
    const every = this.opts.retryMs ?? RETRY_MS;
    if (every > 0) {
      this.timer = setInterval(() => void this.lookAgain(), every);
      this.timer.unref();
    }
    if (this.pending.length > 0) this.log.info({ pending: this.pending.map((p) => p.clOrdId) }, 'trailing exits waiting for their order to fill');
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }

  /** Every order place() put at the exchange: one with `trailing` is remembered until it has filled. */
  private onPlaced(e: OrderPlacedEvent): void {
    const trailing = e.request.trailing;
    if (!trailing || this.pending.some((p) => p.clOrdId === e.order.clOrdId)) return;
    const p: PendingTrailingExit = {
      clOrdId: e.order.clOrdId,
      ordId: e.order.ordId,
      instId: e.order.instId,
      tdMode: e.order.tdMode,
      posSide: e.order.posSide,
      side: e.order.side,
      trailing,
      createdAt: this.now(),
      attempts: 0,
      lastError: null,
    };
    this.pending.push(p);
    this.opts.state.save();
    this.log.info({ clOrdId: p.clOrdId, instId: p.instId, trailing }, 'trailing exit waits for its order to fill');
    // A market order may have filled before its acknowledgement reached this process.
    void this.lookUp(p);
  }

  private onOrder(o: Order): void {
    const p = this.pending.find((x) => x.clOrdId === o.clOrdId && x.instId === o.instId);
    if (p) this.settle(p, o);
  }

  /** What an order's state means for its pending exit. */
  private settle(p: PendingTrailingExit, o: Order): void {
    if (o.state === 'filled' || (o.state === 'canceled' && D(o.accFillSz || '0').gt(0))) void this.execute(p);
    else if (o.state === 'canceled') this.drop(p, 'the order was cancelled before any fill', 'info');
  }

  /** The order of a pending exit, looked up at the exchange by clOrdId. */
  private async lookUp(p: PendingTrailingExit): Promise<void> {
    try {
      this.settle(p, mapOrder(await this.deps.clients.rest.getOrder({ instId: p.instId, clOrdId: p.clOrdId })));
    } catch (err) {
      if (err instanceof OkxApiError && err.code === '51603' && this.now() - p.createdAt > 5 * 60_000) this.drop(p, 'the exchange does not know the order', 'warn');
    }
  }

  /** The timer: the pending exits without news are looked up again, a failed placement is tried again. */
  private async lookAgain(): Promise<void> {
    for (const p of [...this.pending]) {
      if (this.executing.has(p.clOrdId)) continue;
      if (p.lastError !== null) await this.execute(p);
      else await this.lookUp(p);
    }
  }

  private drop(p: PendingTrailingExit, why: string, level: 'info' | 'warn' | 'error'): void {
    const i = this.pending.indexOf(p);
    if (i < 0) return;
    this.pending.splice(i, 1);
    this.opts.state.save();
    this.log[level]({ clOrdId: p.clOrdId, instId: p.instId, trailing: p.trailing }, `trailing exit dropped: ${why}`);
  }

  /** Places the trailing exit of an order that has filled, for its position as it is now. */
  private async execute(p: PendingTrailingExit): Promise<void> {
    if (this.executing.has(p.clOrdId) || !this.pending.includes(p)) return;
    this.executing.add(p.clOrdId);
    try {
      // The positions push of the fill may come after its order push: the account is read first.
      await this.deps.account.refresh();
      const direction = p.side === 'buy' ? 'long' : 'short';
      const position = this.deps.account.positionList().find((x) => x.instId === p.instId && x.mgnMode === p.tdMode && x.posSide === p.posSide && positionDirection(x) === direction);
      if (!position) {
        this.drop(p, `no open ${direction} position in ${p.instId} any more`, 'warn');
        return;
      }
      const ref = { instId: p.instId, mgnMode: p.tdMode, ...(p.posSide === 'net' ? {} : { posSide: p.posSide }) };
      if (p.trailing.kind === 'callback') {
        const placed = await this.deps.orders.placeTrailingStop({ ...ref, ratio: p.trailing.ratio, ...(p.trailing.activePx === undefined ? {} : { activePx: p.trailing.activePx }) }, { algoClOrdId: trailingAlgoClOrdIdFor(p.clOrdId) });
        this.log.info({ clOrdId: p.clOrdId, algoId: placed.algoId, sz: placed.sz, callbackRatio: placed.callbackRatio }, 'trailing stop of a filled order placed');
      } else {
        const entry = await this.deps.channel.enable({ ...ref, bars: p.trailing.bars }, { kind: 'order', clOrdId: p.clOrdId });
        this.log.info({ clOrdId: p.clOrdId, level: entry.level, lastError: entry.lastError?.message ?? null }, 'channel trailing of a filled order set');
      }
      this.drop(p, 'placed', 'info');
    } catch (err) {
      const message = err instanceof AppError ? `${err.code}: ${err.message}` : (err as Error).message;
      p.attempts += 1;
      p.lastError = message;
      this.opts.state.save();
      if (!isPassing(err)) this.drop(p, `refused (${message})`, 'error');
      else if (p.attempts >= MAX_ATTEMPTS) this.drop(p, `still failing after ${p.attempts} attempts (${message})`, 'error');
      else this.log.warn({ clOrdId: p.clOrdId, attempts: p.attempts, err: message }, 'trailing exit not placed yet; tried again shortly');
    } finally {
      this.executing.delete(p.clOrdId);
    }
  }

  /** Cancels the algo orders Pegasus placed that close no open position (see the header). */
  private async cleanup(list: AlgoOrderList): Promise<void> {
    if (this.cleaning || this.deps.account.config === null || this.deps.account.status().lastSyncAt === null) return;
    const positions = this.deps.account.positionList();
    const now = this.now();
    const minAge = this.opts.orphanAgeMs ?? ORPHAN_AGE_MS;
    const orphans = list.orders.filter((a) => isPegasusExitAlgo(a) && now - a.cTime >= minAge && !positions.some((p) => algoOrderClosesPosition(a, p)));
    if (orphans.length === 0) return;
    this.cleaning = true;
    try {
      for (let i = 0; i < orphans.length; i += 10) {
        const batch = orphans.slice(i, i + 10);
        const acks = await this.deps.clients.rest.cancelAlgoOrders(batch.map((a) => ({ instId: a.instId, algoId: a.algoId })));
        for (const [j, ack] of acks.entries()) {
          const a = batch[j];
          if (ack.sCode === '0') this.log.info({ algoId: a?.algoId, algoClOrdId: a?.algoClOrdId, instId: a?.instId, kind: a?.ordType ?? 'conditional' }, 'exit of a closed position cancelled');
          else this.log.warn({ algoId: a?.algoId, sCode: ack.sCode, sMsg: ack.sMsg }, 'exit of a closed position could not be cancelled');
        }
        void this.deps.store.addRiskEvent('EXITS_OF_CLOSED_POSITION_CANCELED', { algoIds: batch.map((a) => a.algoId) });
      }
      this.deps.account.expectAlgoChange();
    } catch (err) {
      this.log.warn({ err: (err as Error).message }, 'exits of closed positions could not be cancelled; tried again at the next read');
    } finally {
      this.cleaning = false;
    }
  }
}
