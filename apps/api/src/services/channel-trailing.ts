import {
  ceilToStep,
  channelStopLevel,
  D,
  dailyCloseAtOrBefore,
  Decimal,
  floorToStep,
  positionDirection,
  stopCoverage,
  stopsOfPosition,
  toPlainString,
  type Candle,
  type ChannelMove,
  type ChannelTrailingEntry,
  type Position,
  type PosSide,
  type TdMode,
  type TrailingView,
} from '@pegasus/shared';
import type { Store } from '../db/store.js';
import { AppError } from '../errors.js';
import type { Logger } from '../logger.js';
import type { OkxClients } from '../okx/clients.js';
import { mapCandle } from '../okx/mappers.js';
import type { AccountService } from './account.js';
import type { CampaignService } from './campaign.js';
import type { ExitStateFile } from './exit-state.js';
import type { MarketDataService } from './market-data.js';
import { ExitsUnavailableError, generateClOrdId, type OrderService } from './order-service.js';

/**
 * Channel trailing: Pegasus keeps the stop-loss of a flagged position at the channel of the last `bars` confirmed
 * daily bars (the lowest low for a long, the highest high for a short: channelStopLevel, the exit line of the campaign
 * rule with 10 bars) and moves it after each 00:00 UTC daily close, never against the position. The stop rests at the
 * exchange (an OKX `conditional` stop-loss, mark-triggered, executed at market); moving it needs this service running.
 *
 * - Which positions: the ones flagged with channel trailing, by an opening order's `trailing` once it has filled
 *   (exit-orders.ts) or through POST /api/positions/channel-trailing. The flags are kept in TRAILING_STATE_FILE
 *   (exit-state.ts) and survive a restart. A flag ends when its position is closed or turns to the other side, and
 *   through POST /api/positions/channel-trailing/clear (the stop then stays where it is).
 * - When: after each 00:00 UTC close, once the exchange's daily bar (OKX 1Dutc) that closed then is confirmed; the
 *   clock is looked at every minute. Closes missed while the API was not running are caught up with at the first look
 *   after the start: the level of every close missed is computed from the bars and the best of them is applied, which
 *   is where a service that had been running would have left the stop.
 * - How: every stop-loss of the position (stopsOfPosition) below the level (above it, for a short) is moved to it
 *   with POST /api/v5/trade/amend-algos (OrderService.amendStop: rounded to the tick towards the price, checked on the
 *   losing side of the live mark); a stop the exchange will not amend is replaced: cancelled, and placed again at the
 *   level for the same size. What the stops leave uncovered gets a stop at the level (OrderService.placeStop, client id
 *   `ch…`), so the whole position is protected at the level or better. A stop already beyond the level stays.
 * - A level the mark has already passed (it would fire at once) is not applied: the stop stays where it is and the
 *   entry says why; closing the position is the trader's decision.
 * - Every move is logged and recorded as a risk event (CHANNEL_STOP_MOVED); the view (GET /api/trailing) carries each
 *   managed position's level, its last move and the last error.
 * - The campaign's positions (orders with client ids starting `pc`) are never touched: they cannot be flagged, and a
 *   flagged one found to be the campaign's is left alone.
 * - Only where the exits of this stage are enabled (paper trading and the local mock).
 */

const DAY_MS = 86_400_000;
/** How often the clock is looked at */
const CHECK_EVERY_MS = 60_000;
/** Daily bars read for the channel: up to 100 bars of channel and the closes missed in between */
const CANDLE_LIMIT = 300;

export interface ChannelTrailingDeps {
  clients: OkxClients;
  account: AccountService;
  orders: OrderService;
  market: MarketDataService;
  store: Store;
  log: Logger;
}

export interface ChannelTrailingOptions {
  /** config.exits.enabled */
  enabled: boolean;
  state: ExitStateFile;
  now?: () => number;
  /** Daily UTC bars (OKX 1Dutc), oldest first; the forming one may be included. The exchange's by default */
  candles?: (instId: string) => Promise<Candle[]>;
  /** How often the clock is looked at; 0: never by itself (tick() is called). Default 60 s */
  checkEveryMs?: number;
  /** True for a position of the campaign service, which is never touched */
  isCampaignPosition?: (p: Position) => boolean;
}

export interface ChannelPositionRef {
  instId: string;
  mgnMode: TdMode;
  posSide?: PosSide | undefined;
}

/** Whether the campaign service runs a campaign on this position (an isolated one on an instrument with an open campaign). */
export function campaignOwns(campaign: CampaignService | undefined, p: Pick<Position, 'instId' | 'mgnMode'>): boolean {
  if (!campaign || p.mgnMode !== 'isolated') return false;
  return campaign.view().campaigns.some((c) => c.end === null && c.instId === p.instId);
}

const keyOf = (e: { instId: string; mgnMode: string; posSide: string }): string => `${e.instId}:${e.mgnMode}:${e.posSide}`;
const iso = (t: number): string => new Date(t).toISOString();

export class ChannelTrailingService {
  private timer: NodeJS.Timeout | null = null;
  /** Everything that reads or changes the entries runs one at a time */
  private chain: Promise<unknown> = Promise.resolve();
  private stopped = false;
  private readonly now: () => number;
  private readonly candles: (instId: string) => Promise<Candle[]>;
  private readonly log: Logger;

  constructor(
    private readonly deps: ChannelTrailingDeps,
    private readonly opts: ChannelTrailingOptions,
  ) {
    this.now = opts.now ?? Date.now;
    this.log = deps.log.child({ component: 'channel-trailing' });
    this.candles =
      opts.candles ??
      (async (instId) => (await deps.clients.rest.getCandles(instId, '1Dutc', { limit: CANDLE_LIMIT })).map(mapCandle).sort((a, b) => a.ts - b.ts));
  }

  get enabled(): boolean {
    return this.opts.enabled;
  }

  private get entries(): ChannelTrailingEntry[] {
    return this.opts.state.state.channel;
  }

  /** Looks at the clock every minute; the first look catches up with the closes missed while the API was not running. */
  start(): void {
    if (!this.opts.enabled) return;
    if (this.opts.state.error) {
      this.log.error({ err: this.opts.state.error }, 'trailing state unreadable: channel trailing does nothing; repair or move the file away (a copy is kept as .corrupt)');
      return;
    }
    if (this.entries.length > 0) this.log.info({ positions: this.entries.map((e) => `${keyOf(e)} ${e.bars} bars`) }, 'channel trailing: positions loaded');
    const every = this.opts.checkEveryMs ?? CHECK_EVERY_MS;
    if (every > 0) {
      this.timer = setInterval(() => void this.tick(), every);
      this.timer.unref();
    }
    void this.tick();
  }

  async stop(): Promise<void> {
    this.stopped = true;
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
    await this.chain.catch(() => undefined);
  }

  private exclusive<T>(fn: () => Promise<T>): Promise<T> {
    const run = this.chain.then(fn, fn);
    this.chain = run.catch(() => undefined);
    return run;
  }

  /** The account has been read: before that an empty mirror would end every flag. */
  private accountReady(): boolean {
    return this.deps.account.config !== null && this.deps.account.status().lastSyncAt !== null;
  }

  /** Applies every close that has come since each entry's last one, where its daily bar is confirmed. */
  tick(): Promise<void> {
    return this.exclusive(async () => {
      if (!this.opts.enabled || this.stopped || this.opts.state.error || !this.accountReady()) return;
      this.prune();
      const close = dailyCloseAtOrBefore(this.now());
      for (const entry of [...this.entries]) {
        if (entry.levelClose !== null && entry.levelClose >= close) continue;
        await this.process(entry, close).catch((err: unknown) => this.fail(entry, err));
      }
    });
  }

  /**
   * Flags a position (`source` order: the opening order's trailing, once it filled; route: by hand) and applies the
   * channel of the last close at once. Refused: outside paper trading and the local mock (EXITS_UNAVAILABLE), without
   * an open position (VALIDATION), on a position of the campaign (CAMPAIGN_POSITION), with the state file unreadable
   * (TRAILING_STATE_UNREADABLE). A level that cannot be applied now is reported in the entry's lastError.
   */
  enable(ref: ChannelPositionRef & { bars: number }, source: { kind: 'order' | 'route'; clOrdId?: string }): Promise<ChannelTrailingEntry> {
    return this.exclusive(async () => {
      if (!this.opts.enabled) throw new ExitsUnavailableError();
      if (this.opts.state.error) throw new AppError('TRAILING_STATE_UNREADABLE', this.opts.state.error, 503);
      const position = this.findPosition(ref);
      const direction = position ? positionDirection(position) : null;
      if (!position || direction === null) throw new AppError('VALIDATION', `no open ${ref.mgnMode} position in ${ref.instId}${ref.posSide && ref.posSide !== 'net' ? ` on the ${ref.posSide} side` : ''} to trail`);
      if (this.opts.isCampaignPosition?.(position)) throw new AppError('CAMPAIGN_POSITION', `the ${ref.instId} position is the campaign's: its exit is the rule's and is not set by hand`, 409);
      const existing = this.entries.find((e) => keyOf(e) === keyOf(position));
      const entry: ChannelTrailingEntry = existing ?? {
        instId: position.instId,
        mgnMode: position.mgnMode,
        posSide: position.posSide,
        direction,
        bars: ref.bars,
        source: source.kind,
        clOrdId: source.clOrdId ?? '',
        since: this.now(),
        level: null,
        levelClose: null,
        algoIds: [],
        lastMove: null,
        lastError: null,
      };
      if (existing) {
        // A new setting: the channel of the last close is applied again with its bars (still never against the position).
        existing.bars = ref.bars;
        existing.direction = direction;
        existing.levelClose = null;
      } else this.entries.push(entry);
      this.log.info({ position: keyOf(entry), bars: entry.bars, source: source.kind, clOrdId: source.clOrdId ?? '' }, 'channel trailing set');
      this.opts.state.save();
      await this.process(entry, dailyCloseAtOrBefore(this.now())).catch((err: unknown) => this.fail(entry, err));
      return structuredClone(entry);
    });
  }

  /** Ends channel trailing for a position; its stop stays where it is. Returns whether it was trailed. */
  disable(ref: ChannelPositionRef): Promise<boolean> {
    return this.exclusive(async () => {
      if (!this.opts.enabled) throw new ExitsUnavailableError();
      const posSide = ref.posSide ?? 'net';
      const i = this.entries.findIndex((e) => e.instId === ref.instId && e.mgnMode === ref.mgnMode && e.posSide === posSide);
      if (i < 0) return false;
      const [gone] = this.entries.splice(i, 1);
      this.opts.state.save();
      this.log.info({ position: gone ? keyOf(gone) : '' }, 'channel trailing cleared; the stop stays where it is');
      return true;
    });
  }

  view(): TrailingView {
    const now = this.now();
    return {
      enabled: this.opts.enabled,
      entries: structuredClone(this.entries),
      pending: structuredClone(this.opts.state.state.pending),
      nextCloseAt: dailyCloseAtOrBefore(now) + DAY_MS,
      ts: now,
    };
  }

  private findPosition(ref: ChannelPositionRef): Position | undefined {
    const posSide = ref.posSide ?? 'net';
    return this.deps.account.positionList().find((p) => p.instId === ref.instId && p.mgnMode === ref.mgnMode && p.posSide === posSide && !D(p.pos || '0').isZero());
  }

  /** Ends the entries whose position is closed or has turned to the other side. */
  private prune(): void {
    let changed = false;
    for (const entry of [...this.entries]) {
      const position = this.findPosition(entry);
      const direction = position ? positionDirection(position) : null;
      if (direction === entry.direction) continue;
      this.entries.splice(this.entries.indexOf(entry), 1);
      changed = true;
      this.log.info({ position: keyOf(entry), level: entry.level }, direction === null ? 'channel trailing ended: the position is closed' : 'channel trailing ended: the position turned to the other side');
    }
    if (changed) this.opts.state.save();
  }

  private fail(entry: ChannelTrailingEntry, err: unknown): void {
    const message = err instanceof AppError ? `${err.code}: ${err.message}` : (err as Error).message;
    entry.lastError = { at: this.now(), message };
    this.opts.state.save();
    this.log.warn({ position: keyOf(entry), err: message }, 'channel trailing could not move the stop; it is tried again at the next look');
  }

  /**
   * Applies the channel of `close` (and of every close missed since the entry's last one) to the position's stops.
   * Returns without recording the close when its daily bar is not confirmed yet: the next look tries again.
   */
  private async process(entry: ChannelTrailingEntry, close: number): Promise<void> {
    const position = this.findPosition(entry);
    const direction = position ? positionDirection(position) : null;
    if (!position || direction !== entry.direction) {
      this.prune();
      return;
    }
    if (this.opts.isCampaignPosition?.(position)) {
      entry.lastError = { at: this.now(), message: "the position is the campaign's: channel trailing does not touch it" };
      entry.levelClose = close;
      this.opts.state.save();
      this.log.warn({ position: keyOf(entry) }, "a flagged position is the campaign's: left alone");
      return;
    }
    const candles = await this.candles(entry.instId);
    const closing = candles.find((c) => c.ts === close - DAY_MS);
    if (!closing?.confirm) {
      entry.lastError = { at: this.now(), message: `the daily bar that closed at ${iso(close)} is not confirmed yet` };
      return;
    }
    const long = direction === 'long';
    const better = (a: Decimal, b: Decimal): boolean => (long ? a.gt(b) : a.lt(b));
    // The closes this run accounts for: the last one, and every one missed since the entry's last (never against the position).
    const from = entry.levelClose === null ? close : entry.levelClose + DAY_MS;
    let target: Decimal | null = null;
    for (let c = from; c <= close; c += DAY_MS) {
      const level = channelStopLevel(candles, entry.bars, direction, c);
      if (level && (target === null || better(level, target))) target = level;
    }
    if (target === null) {
      entry.levelClose = close;
      entry.lastError = { at: this.now(), message: `fewer than ${entry.bars} confirmed daily bars before ${iso(close)}: no channel yet` };
      this.opts.state.save();
      return;
    }
    if (entry.level !== null && better(D(entry.level), target)) target = D(entry.level);
    const inst = this.deps.market.specOf(entry.instId);
    // Rounded to the tick towards the price, as OrderService rounds a stop.
    const level = inst ? toPlainString(long ? ceilToStep(target, inst.tickSz) : floorToStep(target, inst.tickSz), inst.tickSz) : target.toFixed();
    const markPx = this.deps.market.liveMarkPrice(entry.instId);
    if (markPx === undefined) throw new AppError('NO_PRICE', `no live mark price for ${entry.instId}: the channel stop cannot be checked against it`, 503);
    if (long ? !D(level).lt(markPx) : !D(level).gt(markPx)) {
      entry.level = level;
      entry.levelClose = close;
      entry.lastError = { at: this.now(), message: `the channel level ${level} is at or beyond the mark price ${markPx}: a stop there would fire at once, so the stop stays where it is` };
      this.opts.state.save();
      this.log.warn({ position: keyOf(entry), level, markPx }, 'channel level already passed by the mark: the stop is not moved');
      return;
    }

    const moves: ChannelMove[] = [];
    const record = (move: Omit<ChannelMove, 'at' | 'close'>): void => {
      const full: ChannelMove = { ...move, at: this.now(), close };
      moves.push(full);
      this.log.info({ position: keyOf(entry), ...full, close: iso(close) }, 'channel stop moved');
      void this.deps.store.addRiskEvent('CHANNEL_STOP_MOVED', { position: keyOf(entry), ...full });
    };
    const list = await this.deps.account.refreshAlgoOrders();
    for (const stop of stopsOfPosition(position, list.orders)) {
      const from = stop.slTriggerPx;
      if (!better(D(level), D(from))) continue;
      try {
        await this.deps.orders.amendStop({ instId: entry.instId, algoId: stop.algoId, slTriggerPx: level });
        record({ algoId: stop.algoId, action: 'amended', from, to: level });
      } catch (err) {
        if (err instanceof AppError && err.code === 'ALGO_NOT_FOUND') continue;
        if (!(err instanceof AppError && err.code === 'EXCHANGE')) throw err;
        // The exchange will not amend it: replaced, for the same size, at the level.
        await this.deps.orders.cancelStop({ instId: entry.instId, algoId: stop.algoId });
        const placed = await this.deps.orders.placeStop({ instId: entry.instId, mgnMode: entry.mgnMode, posSide: entry.posSide, slTriggerPx: level, sz: stop.sz || D(position.pos).abs().toFixed() }, { algoClOrdId: `ch${generateClOrdId()}` });
        record({ algoId: placed.algoId, action: 'replaced', from, to: placed.slTriggerPx });
      }
    }
    // What the stops leave uncovered gets a stop at the level.
    const after = await this.deps.account.refreshAlgoOrders();
    const coverage = stopCoverage(position, after.orders);
    const uncovered = D(coverage.size).minus(coverage.covered);
    if (uncovered.gt(0)) {
      const placed = await this.deps.orders.placeStop({ instId: entry.instId, mgnMode: entry.mgnMode, posSide: entry.posSide, slTriggerPx: level, sz: uncovered.toFixed() }, { algoClOrdId: `ch${generateClOrdId()}` });
      record({ algoId: placed.algoId, action: 'placed', from: null, to: placed.slTriggerPx });
    }
    const final = await this.deps.account.refreshAlgoOrders();
    entry.algoIds = stopsOfPosition(position, final.orders).map((s) => s.algoId);
    entry.level = level;
    entry.levelClose = close;
    entry.lastError = null;
    const last = moves[moves.length - 1];
    if (last) entry.lastMove = last;
    this.opts.state.save();
  }
}
