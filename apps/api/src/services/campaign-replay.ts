import { EventEmitter } from 'node:events';
import { reconcileMismatches, replayPot, type PotReplay, type PotReplayInput, type PotReplaySources } from '@pegasus/backtest/campaign';
import type { CampaignReplayStatus, CampaignReplaySummary, CampaignReplayView, CampaignStatusReason } from '@pegasus/shared';
import type { Logger } from '../logger.js';

/**
 * The replay beside the pot (GET /api/campaign/replay): the campaign replay of packages/backtest (src/campaign/pot.ts)
 * run on OKX's bars from the pot's start with the pot's own rule, the other structure beside it, the pot's start
 * value held in BTC, and the ledger reconciled with the replay campaign by campaign.
 *
 * Computed in the background, never in a step's way: the campaign service asks for it after every step that
 * processed a 00:00 UTC close, once at start when a pot exists, and when the pot starts; POST /api/campaign/replay
 * asks for it too. One computation at a time (one asked for while another runs follows it, once), each given up
 * after timeoutMs; a computation given up on is waited for before the next one starts. A failure is reported with
 * its reason and the last result is kept. The data is read from OKX's public endpoints and kept in the cache
 * (data/campaign-replay under the repository root), so after the first computation only the newest bars are read.
 */

export interface CampaignReplayOptions {
  /** Where the bars and the funding come from and where they are kept */
  sources: PotReplaySources;
  /** How long one computation may take before it is given up as failed. Default 5 minutes */
  timeoutMs?: number;
}

/** What the campaign service gives the replay. */
export interface CampaignReplaySource {
  /** Why there is nothing to replay now (no pot, the ledger cannot be read); null while there is a pot */
  unavailable(): CampaignStatusReason | null;
  /** The pot, its campaigns and its rule as they are now; a copy */
  input(): PotReplayInput;
}

const DEFAULT_TIMEOUT_MS = 5 * 60_000;

/** GET /api/campaign/replay when there is nothing to show. */
export function unavailableReplayView(reason: CampaignStatusReason): CampaignReplayView {
  return { status: 'unavailable', reason, computedAt: null, through: null, same: null, other: null, heldBtc: [], reconciliation: null };
}

export const CAMPAIGN_DISABLED_REPLAY: CampaignStatusReason = { code: 'CAMPAIGN_DISABLED', message: 'the campaign is not enabled (CAMPAIGN_ENABLED=1, paper trading only): there is no pot to replay' };

export class CampaignReplayService extends EventEmitter<{ change: [CampaignReplaySummary] }> {
  private last: { computedAt: number; replay: PotReplay } | null = null;
  /** Why the last computation failed; null when it did not */
  private failure: CampaignStatusReason | null = null;
  /** The computations asked for, run one after the other */
  private running: Promise<void> | null = null;
  /** A computation was asked for while one ran: one more follows it */
  private again = false;
  /** The work of a computation that was given up on and has not ended yet */
  private work: Promise<void> | null = null;
  private stopped = false;
  private shown = '';
  private readonly timeoutMs: number;

  constructor(
    private readonly source: CampaignReplaySource,
    private readonly opts: CampaignReplayOptions | null,
    private readonly log: Logger,
    private readonly now: () => number = Date.now,
  ) {
    super();
    this.timeoutMs = opts?.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  }

  /** What the `campaign` view says about it. */
  summary(): CampaignReplaySummary {
    const { status } = this.state();
    return { status, computedAt: this.last?.computedAt ?? null, mismatches: this.last ? reconcileMismatches(this.last.replay.reconciliation) : null };
  }

  /** GET /api/campaign/replay */
  view(): CampaignReplayView {
    const { status, reason } = this.state();
    const last = this.last;
    if (!last) return { status, reason, computedAt: null, through: null, same: null, other: null, heldBtc: [], reconciliation: null };
    const r = last.replay;
    return { status, reason, computedAt: last.computedAt, through: r.through, same: r.same, other: r.other, heldBtc: r.heldBtc, reconciliation: r.reconciliation };
  }

  /**
   * Asks for a computation. While one runs, `again` asks for one more after it (the data or the ledger has changed
   * since it began); otherwise the one that runs answers. False when nothing can be computed (no pot, no source).
   */
  refresh(again = true): boolean {
    if (this.stopped || this.unavailable() !== null) return false;
    if (this.running) {
      if (again) this.again = true;
      return true;
    }
    this.running = this.loop().finally(() => {
      this.running = null;
    });
    this.changed();
    return true;
  }

  /** Resolves once no computation runs or is waiting. */
  async idle(): Promise<void> {
    while (this.running) await this.running;
  }

  /** No computation is started any more; the one running ends in the background and changes nothing. */
  stop(): void {
    this.stopped = true;
  }

  private unavailable(): CampaignStatusReason | null {
    if (this.opts === null) return { code: 'REPLAY_NOT_CONFIGURED', message: 'the replay has no data source' };
    return this.source.unavailable();
  }

  private state(): { status: CampaignReplayStatus; reason: CampaignStatusReason | null } {
    if (this.failure) return { status: 'failed', reason: this.failure };
    if (this.last) return { status: 'ready', reason: null };
    const unavailable = this.unavailable();
    // With a pot the first computation is asked for as soon as there is one.
    return unavailable ? { status: 'unavailable', reason: unavailable } : { status: 'running', reason: null };
  }

  private async loop(): Promise<void> {
    do {
      this.again = false;
      await this.computeOnce();
    } while (this.again && !this.stopped);
  }

  private async computeOnce(): Promise<void> {
    // Never two at once: a computation that was given up on still holds the data sources.
    if (this.work) await this.work;
    if (this.stopped || this.unavailable() !== null || this.opts === null) return;
    const started = this.now();
    let timer: NodeJS.Timeout | undefined;
    const timeout = new Promise<'timeout'>((resolve) => {
      timer = setTimeout(() => resolve('timeout'), this.timeoutMs);
      timer.unref();
    });
    try {
      const work = replayPot(this.source.input(), this.opts.sources);
      const tracked: Promise<void> = work.then(
        () => undefined,
        () => undefined,
      );
      const outcome = await Promise.race([work, timeout]);
      if (this.stopped) return;
      if (outcome === 'timeout') {
        const settled: Promise<void> = tracked.finally(() => {
          if (this.work === settled) this.work = null;
        });
        this.work = settled;
        this.fail('REPLAY_TIMEOUT', `the replay took longer than ${Math.round(this.timeoutMs / 1000)} s and was given up; the next one waits for it to end`);
        return;
      }
      this.last = { computedAt: this.now(), replay: outcome };
      this.failure = null;
      const r = outcome.reconciliation;
      this.log.info({ through: new Date(outcome.through).toISOString(), value: outcome.same.value, other: outcome.other.value, matched: r.matched, differing: r.differing, liveOnly: r.liveOnly, replayOnly: r.replayOnly, notes: outcome.notes, ms: this.now() - started }, 'campaign replay computed');
    } catch (err) {
      if (!this.stopped) this.fail('REPLAY_FAILED', (err as Error).message);
    } finally {
      clearTimeout(timer);
      this.changed();
    }
  }

  private fail(code: string, message: string): void {
    this.failure = { code, message };
    this.log.warn({ code, err: message, kept: this.last ? new Date(this.last.computedAt).toISOString() : null }, `campaign replay failed: ${message}`);
  }

  /** The summary is pushed with the campaign's view when it changes. */
  private changed(): void {
    if (this.stopped) return;
    const summary = this.summary();
    const text = JSON.stringify(summary);
    if (text === this.shown) return;
    this.shown = text;
    this.emit('change', summary);
  }
}
