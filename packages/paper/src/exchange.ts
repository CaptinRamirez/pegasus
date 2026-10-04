import { Engine, type OkxInstrument, type OkxPosMode } from '@pegasus/mock-okx/engine';
import type { BarSource } from './bars.js';
import { FundingSettler, emptyFundingState, type FundingSource } from './funding.js';
import { LiveMarket } from './live-market.js';
import { replayInstrument } from './replay.js';
import { backupState, loadState, saveState, type PaperState } from './state.js';

export interface PaperConfig {
  /** Absolute path of the file the account is kept in. */
  stateFile: string;
  /** USDT a new account starts with; an existing account keeps its own balance. */
  initialBalance: string;
  posMode: OkxPosMode;
  takerFeeRate: string;
  makerFeeRate: string;
  /** Leverage of an instrument until it is set from the terminal. */
  defaultLever: string;
}

export interface PaperDeps {
  /** Contract specs of every instrument the account may trade or already holds, from the real exchange. */
  instruments: OkxInstrument[];
  bars: BarSource;
  funding: FundingSource;
  log: (msg: string) => void;
  now?: () => number;
}

/** A feed gap shorter than this is not replayed from candles: one-minute bars cannot resolve it. */
export const REPLAY_GAP_MS = 60_000;
/** After a failed replay the next attempt waits this long. */
const RESUME_RETRY_MS = 10_000;
const HOUR_MS = 3_600_000;

/** Instruments the saved account still has a position, an order or a stop in. */
export function instrumentsOf(state: PaperState | null): string[] {
  if (!state) return [];
  return [...new Set([...state.account.positions.map((p) => p.instId), ...state.orders.live.map((o) => o.instId), ...state.orders.stops.map((s) => s.instId)])];
}

/**
 * A paper account: the mock exchange's order, position and stop simulation, matched against the real
 * exchange's quotes, kept in a file, and brought up to date for the time it was not running.
 */
export class PaperExchange {
  readonly engine: Engine;
  readonly markets = new Map<string, LiveMarket>();
  readonly funding: FundingSettler;
  /** Whether the account was read from the file (false: created now). */
  readonly restored: boolean;
  private readonly createdAt: number;
  private readonly initialBalance: string;
  private readonly lastSeen: Record<string, number>;
  private readonly resuming = new Set<string>();
  private readonly retryAfter = new Map<string, number>();
  private readonly now: () => number;
  private fundingSlot = -1;
  private closed = false;

  constructor(
    private readonly config: PaperConfig,
    private readonly deps: PaperDeps,
  ) {
    this.now = deps.now ?? Date.now;
    const state = loadState(config.stateFile);
    if (state && state.posMode !== config.posMode) {
      throw new Error(`the paper account in ${config.stateFile} was created in ${state.posMode}; it cannot be opened in ${config.posMode}`);
    }
    backupState(config.stateFile);
    const missing = instrumentsOf(state).filter((id) => !deps.instruments.some((i) => i.instId === id));
    if (missing.length > 0) throw new Error(`the paper account holds ${missing.join(', ')}, which the exchange no longer lists`);
    for (const inst of deps.instruments) {
      if (inst.ctType !== 'linear' || inst.settleCcy !== 'USDT') throw new Error(`paper trading supports USDT-margined linear swaps only; ${inst.instId} is not one`);
      this.markets.set(inst.instId, new LiveMarket(inst));
    }
    this.engine = new Engine({
      posMode: config.posMode,
      perm: 'read_only,trade',
      instruments: deps.instruments,
      initialPrices: {},
      seed: 1,
      volatility: 0,
      tickIntervalMs: 0,
      initialBalanceUsdt: state?.initialBalance ?? config.initialBalance,
      takerFeeRate: config.takerFeeRate,
      makerFeeRate: config.makerFeeRate,
      log: deps.log,
      markets: this.markets,
      defaultLever: config.defaultLever,
    });
    this.engine.clockOverride = null;
    this.restored = state !== null;
    this.createdAt = state?.createdAt ?? this.now();
    this.initialBalance = state?.initialBalance ?? config.initialBalance;
    this.lastSeen = { ...(state?.lastSeen ?? {}) };
    if (state) {
      this.engine.account.restore(state.account);
      this.engine.orders.restore(state.orders);
    }
    this.funding = new FundingSettler(this.engine, state?.funding ?? emptyFundingState(), deps.funding, deps.log);
    this.engine.on('order', () => this.save());
    this.engine.on('positions', ({ positions }) => {
      const before = JSON.stringify(this.funding.state.sizeLog);
      this.funding.notePositions(positions);
      // A push that only moved the mark is not worth a write.
      if (JSON.stringify(this.funding.state.sizeLog) !== before) this.save();
    });
  }

  private snapshot(): PaperState {
    return {
      version: 1,
      createdAt: this.createdAt,
      initialBalance: this.initialBalance,
      posMode: this.config.posMode,
      lastSeen: this.lastSeen,
      account: this.engine.account.snapshot(),
      orders: this.engine.orders.snapshot(),
      funding: this.funding.state,
    };
  }

  save(): void {
    if (this.closed) return;
    saveState(this.config.stateFile, this.snapshot());
  }

  /**
   * Brings the account up to date for the time it was not running: replays every instrument from where it was
   * last watched, then settles the funding that fell due. Rejects when the history cannot be read; nothing is
   * half applied for the instrument that failed.
   */
  async catchUp(): Promise<void> {
    const now = this.now();
    for (const instId of this.markets.keys()) {
      const from = this.lastSeen[instId];
      if (from !== undefined) {
        const r = await replayInstrument(this.engine, this.deps.bars, instId, from, now);
        if (r.bars > 0) this.deps.log(`${instId}: replayed ${new Date(from).toISOString()} to ${new Date(now).toISOString()} (${r.bars} bars): ${r.filled} resting order(s) filled, ${r.stopped} stop(s) triggered`);
      }
      this.lastSeen[instId] = now;
    }
    await this.settleFunding(now);
    this.save();
  }

  private async settleFunding(now: number): Promise<void> {
    try {
      if ((await this.funding.settle(now)) > 0) this.save();
    } catch (err) {
      this.deps.log(`funding could not be settled now (${(err as Error).message}); it is tried again after the next full hour`);
    }
  }

  // ---- the feed ----

  /** A `books5` snapshot: both sides, best first. */
  onBook(instId: string, bids: readonly (readonly string[])[], asks: readonly (readonly string[])[]): void {
    this.markets.get(instId)?.book.set(bids, asks);
    this.touch(instId);
  }

  onMark(instId: string, markPx: string): void {
    this.markets.get(instId)?.setMark(markPx);
    this.touch(instId);
  }

  onLast(instId: string, last: string): void {
    this.markets.get(instId)?.setLast(last);
    this.touch(instId);
  }

  /** The feed lost its connection: no quote is current any more, so nothing fills and no stop triggers until it is back. */
  onFeedDown(): void {
    for (const market of this.markets.values()) market.goOffline();
  }

  private touch(instId: string): void {
    const market = this.markets.get(instId);
    if (!market || !market.quoted) return;
    if (!market.live) {
      void this.resume(instId, market);
      return;
    }
    this.lastSeen[instId] = this.now();
    this.engine.marketMoved(instId);
  }

  /** Quotes are back for an instrument: replay what was missed when that was more than a minute, then match live again. */
  private async resume(instId: string, market: LiveMarket): Promise<void> {
    if (this.resuming.has(instId) || this.now() < (this.retryAfter.get(instId) ?? 0)) return;
    this.resuming.add(instId);
    try {
      const from = this.lastSeen[instId];
      const now = this.now();
      if (from !== undefined && now - from > REPLAY_GAP_MS) {
        const r = await replayInstrument(this.engine, this.deps.bars, instId, from, now);
        this.deps.log(`${instId}: quotes were missing since ${new Date(from).toISOString()}; replayed ${r.bars} bars: ${r.filled} resting order(s) filled, ${r.stopped} stop(s) triggered`);
        await this.settleFunding(now);
      }
      if (this.closed || !market.quoted) return;
      this.lastSeen[instId] = this.now();
      market.live = true;
      this.engine.marketMoved(instId);
      this.save();
    } catch (err) {
      this.retryAfter.set(instId, this.now() + RESUME_RETRY_MS);
      this.deps.log(`${instId}: the time without quotes could not be replayed (${(err as Error).message}); orders of this instrument are not matched until it can`);
    } finally {
      this.resuming.delete(instId);
    }
  }

  /**
   * Housekeeping, called every few seconds: writes how far the prices were watched, and settles funding at
   * one and at six minutes past every hour (settlements are on the hour; the rate is published shortly after).
   */
  async tick(): Promise<void> {
    if (this.closed) return;
    this.save();
    const now = this.now();
    const minute = Math.floor((now % HOUR_MS) / 60_000);
    const slot = Math.floor(now / HOUR_MS) * 10 + (minute >= 6 ? 2 : minute >= 1 ? 1 : 0);
    if (slot === this.fundingSlot || slot % 10 === 0) return;
    this.fundingSlot = slot;
    await this.settleFunding(now);
  }

  close(): void {
    this.save();
    this.closed = true;
  }
}
