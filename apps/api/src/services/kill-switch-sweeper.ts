import { OkxApiError, OkxHttpError } from '@pegasus/okx';
import type { AccountConfig, CancelSweepState, RiskState } from '@pegasus/shared';
import { AppError, ReadOnlyKeyError } from '../errors.js';
import type { Logger } from '../logger.js';
import type { RiskEngine } from './risk-engine.js';

/** What the sweep needs from the account mirror (AccountService). */
export interface SweepAccount {
  readonly enabled: boolean;
  readonly config: AccountConfig | null;
  readonly openOrders: ReadonlyMap<string, unknown>;
  /** A completed REST reconcile; rejects when it failed. */
  refresh(): Promise<void>;
  on(event: 'config', listener: (config: AccountConfig) => void): unknown;
}

/** What the sweep needs from the OrderService. */
export interface SweepOrders {
  cancelAll(): Promise<number>;
}

/** Schedules `fn` after `ms` and returns the function that cancels it. */
export type SetTimer = (fn: () => void, ms: number) => () => void;

const RETRY_MIN_MS = 5_000;
const RETRY_MAX_MS = 60_000;

/**
 * OKX codes a retry cannot cure: API frozen, key of the other environment, wrong passphrase, IP not on the
 * allow-list, unknown key, bad signature or authorization, key without the permission for the endpoint.
 * A clock problem (50102, 50112) is not here: the clock is re-synced in the background.
 */
const PERMANENT_OKX_CODES = new Set(['50100', '50101', '50105', '50110', '50111', '50113', '50114', '50120']);

function isPermanent(err: unknown): boolean {
  if (err instanceof ReadOnlyKeyError) return true;
  if (err instanceof OkxApiError) return PERMANENT_OKX_CODES.has(err.code);
  if (err instanceof OkxHttpError) return err.status === 401 || err.status === 403;
  // OrderService reports an exchange error as AppError('EXCHANGE') with OKX's code in the details.
  if (err instanceof AppError) return typeof err.details?.['okxCode'] === 'string' && PERMANENT_OKX_CODES.has(err.details['okxCode']);
  return false;
}

function reasonOf(err: unknown): string {
  if (err instanceof OkxApiError) return `[${err.code}] ${err.okxMessage || err.message}`;
  if (err instanceof AppError && typeof err.details?.['okxCode'] === 'string') return `[${err.details['okxCode']}] ${err.message}`;
  return err instanceof Error ? err.message : String(err);
}

const defaultSetTimer: SetTimer = (fn, ms) => {
  const timer = setTimeout(fn, ms);
  timer.unref();
  return () => clearTimeout(timer);
};

/**
 * Cancels every open order of the account when the kill switch goes on.
 *
 * The sweep is armed on the off-to-on edge of the switch (and at start-up when the restored state is on and its
 * sweep had not completed before the restart) and
 * disarmed the moment the switch is off: nothing is cancelled for a switch that has been released, whatever was
 * pending. One sweep refreshes the open-order list over REST, cancels, refreshes again and is done only when no
 * open order is left; otherwise it is retried with a growing delay. It gives up on errors a retry cannot cure
 * and is not attempted at all with a key that cannot trade. Progress is reported in RiskState.cancelSweep.
 */
export class KillSwitchSweeper {
  private wasOn = false;
  private armed = false;
  private running = false;
  /** Bumped by every arm and disarm, so a sweep overtaken by a toggle notices after each await. */
  private epoch = 0;
  private retryMs = RETRY_MIN_MS;
  private cancelTimer: (() => void) | null = null;

  constructor(
    private readonly risk: RiskEngine,
    private readonly account: SweepAccount,
    private readonly orders: SweepOrders,
    private readonly log: Logger,
    private readonly setTimer: SetTimer = defaultSetTimer,
  ) {}

  start(): void {
    this.risk.on('state', (s) => this.onRiskState(s));
    // A key that gained the trade permission while the switch is on: the skipped sweep is due after all.
    this.account.on('config', (cfg) => {
      if (cfg.canTrade && this.risk.state.killSwitch && this.risk.state.cancelSweep.state === 'skipped') this.arm();
    });
    // A halt restored with its sweep already completed is not swept again: that would cancel the exits placed
    // since (closing orders are allowed under a halt). Any other restored halt gets its sweep now.
    if (this.risk.state.killSwitch && this.risk.state.cancelSweep.state === 'done') this.wasOn = true;
    else this.onRiskState(this.risk.state);
  }

  stop(): void {
    this.epoch++;
    this.armed = false;
    this.clearTimer();
  }

  private onRiskState(s: RiskState): void {
    if (s.killSwitch === this.wasOn) return;
    this.wasOn = s.killSwitch;
    if (s.killSwitch) this.arm();
    else this.disarm();
  }

  private arm(): void {
    this.epoch++;
    this.armed = true;
    this.retryMs = RETRY_MIN_MS;
    this.clearTimer();
    this.log.warn('kill switch engaged: cancelling all open orders');
    this.risk.setCancelSweep('pending', 'cancelling open orders');
    void this.run();
  }

  private disarm(): void {
    this.epoch++;
    this.armed = false;
    this.clearTimer();
    this.risk.setCancelSweep('idle', '');
  }

  private clearTimer(): void {
    this.cancelTimer?.();
    this.cancelTimer = null;
  }

  /** True while the sweep started under `epoch` is still wanted: same engagement, switch still on. */
  private live(epoch: number): boolean {
    return this.armed && this.epoch === epoch && this.risk.state.killSwitch;
  }

  /** Re-read on every call: the config can change during a refresh. */
  private readOnly(): boolean {
    return this.account.config?.canTrade === false;
  }

  private async run(): Promise<void> {
    if (this.running || !this.armed || !this.risk.state.killSwitch) return;
    const epoch = this.epoch;
    this.running = true;
    try {
      await this.sweep(epoch);
    } catch (err) {
      if (this.live(epoch)) this.onFailure(err);
    } finally {
      this.running = false;
    }
    // Released and engaged again while this sweep was in flight: the new engagement gets its own sweep.
    if (this.armed && this.epoch !== epoch) void this.run();
  }

  private async sweep(epoch: number): Promise<void> {
    if (!this.account.enabled) return this.finish('skipped', 'skipped: no API key configured');
    if (this.readOnly()) return this.finish('skipped', 'skipped: read-only key');
    // The mirror may be stale (private stream down, order placed on OKX during an outage): list the orders afresh.
    await this.account.refresh();
    if (!this.live(epoch)) return;
    if (this.readOnly()) return this.finish('skipped', 'skipped: read-only key');
    const found = this.account.openOrders.size;
    if (found === 0) return this.finish('done', 'no open orders to cancel');
    await this.orders.cancelAll();
    if (!this.live(epoch)) return;
    // An accepted cancel request is not a cancelled order: only an empty list ends the sweep.
    await this.account.refresh();
    if (!this.live(epoch)) return;
    const left = this.account.openOrders.size;
    if (left > 0) return this.retry(`${left} of ${found} orders still open`);
    this.finish('done', 'open orders cancelled');
  }

  private onFailure(err: unknown): void {
    const reason = reasonOf(err);
    if (isPermanent(err)) this.finish('failed', `cancel failed: ${reason}`);
    else this.retry(reason);
  }

  private finish(state: CancelSweepState, message: string): void {
    this.armed = false;
    if (state === 'failed') this.log.error({ message }, 'kill switch cancel sweep gave up; cancel the open orders on OKX');
    else this.log.warn({ state, message }, 'kill switch cancel sweep finished');
    this.risk.setCancelSweep(state, message);
  }

  private retry(reason: string): void {
    const delay = this.retryMs;
    this.retryMs = Math.min(RETRY_MAX_MS, delay * 2);
    this.log.error({ reason, retryInMs: delay }, 'kill switch cancel sweep failed; will retry');
    this.cancelTimer = this.setTimer(() => {
      this.cancelTimer = null;
      void this.run();
    }, delay);
    this.risk.setCancelSweep('pending', `cancel failed: ${reason}, retrying in ${delay / 1000} s`);
  }
}
