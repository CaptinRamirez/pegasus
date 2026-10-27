import { EventEmitter } from 'node:events';
import { appendFileSync, existsSync, mkdirSync, readFileSync } from 'node:fs';
import { dirname } from 'node:path';
import {
  checkDecision,
  CL_ORD_PREFIXES,
  D,
  Decimal,
  estimateUsd,
  inTraderSession,
  traderSize,
  ZERO,
  type Candle,
  type PlaceOrderRequest,
  type Position,
  type PosSide,
  type TraderAccountInfo,
  type TraderDecision,
  type TraderDossier,
  type TraderLastDecision,
  type TraderLogRecord,
  type TraderMacro,
  type TraderPosition,
  recentTradesOf,
  type TraderStatus,
  type TraderStatusReason,
  type TraderTradeResult,
  type TraderUsage,
  type TraderVerdict,
  type TraderView,
  wakeOf,
} from '@pegasus/shared';
import type { TraderConfig } from '../config.js';
import type { Logger } from '../logger.js';
import type { OkxClients } from '../okx/clients.js';
import type { AccountService } from './account.js';
import type { MarketDataService } from './market-data.js';
import { generateClOrdId, type OrderService } from './order-service.js';
import type { RiskEngine } from './risk-engine.js';
import { buildTraderDossier, detectTriggers, exchangeDossierSources, FIFTEEN_MINUTES_MS, fifteenCloseAtOrBefore, type TraderDossierSources } from './trader-dossier.js';
import { FeedMacroSource, NO_MACRO, type TraderMacroSource } from './trader-macro.js';
import { ClaudeTraderModel, hasAnthropicCredentials, type TraderModel, type TraderModelAnswer } from './trader-model.js';
import { emptyTraderState, loadTraderState, RECENT_KEPT, rolledToDay, saveTraderState, utcDate, type PendingLimit, type TraderState } from './trader-state.js';

/**
 * The Claude auto trader (docs/proposals/claude-auto-trader.md): on its own paper stack (TRADER_ENABLED=1, paper only,
 * never with the campaign on the same account) it asks the model at 15-minute closes inside the US session and carries
 * out what passes the guardrails, on one instrument, through the order service like any order of the terminal (so the
 * risk engine, the journal and the exits of the terminal see it; client order ids start with `pt`).
 *
 * At every 15-minute close (the clock is looked at every checkEveryMs; a close missed while the API was down is not
 * made up): the position is reconciled with the exchange (a position gone is a result, measured from the equity), a
 * resting limit order of the close before is cancelled, the coin-flip control is settled on the bar, and, in the
 * session, the dossier is built with the economic calendar and the latest headlines (trader-macro.ts, TRADER_NEWS).
 * When the model is asked depends on TRADER_CADENCE. model (the default): the model names at every decision when it
 * wants to look again and the prices that wake it earlier (wakeOf); it is also asked at the first close of each session
 * day, when the position nears its stop or reaches its target, and at the first close after a high-impact US release
 * (and the close before one while a position is open) — wakeReasons; and between closes, at every tick, as soon as
 * the mark reaches a wake level (watch, at most once per WATCH_COOLDOWN_MS). Never at the stop or the target: both are
 * pre-commitments the exchange executes. hourly: at the hourly close and at a 15-minute
 * close that crossed a level of the day (detectTriggers). 15m: at every close. Its decision goes through checkDecision, then the
 * guardrails of the day (trade cap, daily loss, cooldown, kill switch, a resting limit), then the exchange: an isolated
 * order sized by traderSize with the stop attached (and the target as a take-profit), a close, or a tighter stop.
 * Outside the session an open position is left to its stop: no call is made (the board's choice).
 *
 * The control (TRADER_CONTROL=1): at every entry the trader makes, a second book takes the same contracts with the same
 * stop and target distances in a direction drawn by a seeded coin flip, filled at the mark with CONTROL_SLIPPAGE and
 * CONTROL_FEE, and settled on the following 15-minute bars (the stop wins when both are touched in one bar). It is the
 * baseline the pass line compares the model with; it never touches the exchange.
 *
 * Every decision is appended to TRADER_LOG_FILE with its whole dossier, so it can be re-asked later; the day's counters,
 * the position and the control live in TRADER_STATE_FILE. Without credentials for the model (ANTHROPIC_API_KEY in the
 * environment, which this service never reads) the trader is blocked and says so.
 */

export interface TraderServiceDeps {
  clients: OkxClients;
  market: MarketDataService;
  account: AccountService;
  risk: RiskEngine;
  orders: OrderService;
  log: Logger;
}

export interface TraderServiceOptions {
  now?: () => number;
  sleep?: (ms: number) => Promise<void>;
  /** The model; Claude through the SDK by default, when credentials are in the environment */
  model?: TraderModel;
  /** The exchange's by default */
  sources?: TraderDossierSources;
  /** The calendar and the news feeds over HTTP by default (none with TRADER_NEWS=0) */
  macro?: TraderMacroSource;
  /** How often the clock is looked at; 0: never by itself (tick() is called). Default 15 s */
  checkEveryMs?: number;
  /** Interval and count of the polls for the bar that just closed to be confirmed. Default 5 s, 12 polls */
  pollMs?: number;
  pollAttempts?: number;
}

const HOUR_MS = 3_600_000;
export const CONTROL_SLIPPAGE = '0.0005';
export const CONTROL_FEE = '0.0005';
/** Between two closes the mark is watched at every tick; a hit asks the model at most this often. */
export const WATCH_COOLDOWN_MS = 5 * 60_000;
const iso = (t: number): string => new Date(t).toISOString();
const money = (v: Decimal): string => v.toDecimalPlaces(8).toFixed();

export function disabledTraderView(config: TraderConfig, now = Date.now()): TraderView {
  return {
    enabled: false,
    status: 'disabled',
    reason: { code: 'TRADER_DISABLED', message: 'the trader is not enabled (TRADER_ENABLED=1, paper trading only, on a stack of its own)' },
    instId: config.instId,
    cadence: config.cadence,
    wake: null,
    upcoming: [],
    session: { startHour: config.guardrails.sessionStartHour, endHour: config.guardrails.sessionEndHour, inSession: false },
    guardrails: config.guardrails,
    model: config.model,
    nextCallAt: null,
    last: null,
    position: null,
    today: { date: utcDate(now), trades: 0, pnl: '0', consecutiveLosses: 0, cooldownUntil: null, equityAtStart: null },
    usageToday: { calls: 0, inputTokens: 0, outputTokens: 0, estimatedUsd: '0' },
    control: null,
    recent: [],
    serverTime: now,
  };
}

export class TraderService extends EventEmitter<{ change: [TraderView] }> {
  private state: TraderState;
  private stateError: string | null = null;
  private timer: NodeJS.Timeout | null = null;
  private running = false;
  private stopped = false;
  private lastDossier: TraderDossier | null = null;
  private lastDecision: TraderLastDecision | null = null;
  /** The model asked for a close: the result of the position is dated by it */
  private closing = false;
  /** A position the trader did not open was logged already */
  private foreignWarned = false;
  /** When the mark last woke the model between two closes */
  private watchedAt: number | null = null;
  private readonly model: TraderModel | null;
  private readonly sources: TraderDossierSources;
  private readonly macroSource: TraderMacroSource;
  /** The last macro block read, for the view's upcoming releases */
  private lastMacro: TraderMacro | null = null;
  private readonly now: () => number;
  private readonly sleep: (ms: number) => Promise<void>;
  private readonly checkEveryMs: number;
  private readonly pollMs: number;
  private readonly pollAttempts: number;
  private readonly log: Logger;

  constructor(
    private readonly config: TraderConfig,
    private readonly deps: TraderServiceDeps,
    opts: TraderServiceOptions = {},
  ) {
    super();
    this.log = deps.log.child({ component: 'trader' });
    this.now = opts.now ?? Date.now;
    this.sleep = opts.sleep ?? ((ms) => new Promise((resolve) => setTimeout(resolve, ms).unref()));
    this.sources = opts.sources ?? exchangeDossierSources(deps.market, deps.clients);
    this.macroSource = opts.macro ?? (config.news ? new FeedMacroSource() : NO_MACRO);
    this.checkEveryMs = opts.checkEveryMs ?? 15_000;
    this.pollMs = opts.pollMs ?? 5_000;
    this.pollAttempts = opts.pollAttempts ?? 12;
    this.model = opts.model ?? (hasAnthropicCredentials() ? new ClaudeTraderModel({ model: config.model, effort: config.effort }) : null);
    this.state = emptyTraderState(this.now());
  }

  // ---- life cycle ----

  async start(): Promise<void> {
    const loaded = loadTraderState(this.config.stateFile, this.now());
    if (!loaded.ok) {
      this.stateError = loaded.error;
      this.log.error({ file: this.config.stateFile, err: loaded.error }, 'trader state unreadable: the trader does not trade; repair or move the file away');
      this.emitChange();
      return;
    }
    this.state = loaded.state;
    if (this.config.guardrails.maxConsecutiveLosses === 0 && this.state.cooldownUntil !== null) {
      // a pause set under an earlier rule: the rule now has none, and the last decision's next look was chosen around it
      this.log.info({ cooldownUntil: this.state.cooldownUntil }, 'pause after losses dropped: the guardrails have none; asked again at the next close');
      this.state.cooldownUntil = null;
      this.state.wake = null;
    }
    this.restoreLastDecision();
    this.log.info({ file: this.config.stateFile, instId: this.config.instId, model: this.model?.name ?? null, position: this.state.position?.side ?? null, tradesToday: this.state.tradesToday }, 'trader state loaded');
    if (this.model === null) this.log.error('the trader has no model credentials (ANTHROPIC_API_KEY): it is blocked until the API is restarted with them');
    if (this.checkEveryMs > 0) {
      this.timer = setInterval(() => void this.tick(), this.checkEveryMs);
      this.timer.unref();
    }
    await this.tick();
  }

  stop(): void {
    this.stopped = true;
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }

  /** One look at the clock: a 15-minute close that has not been processed is processed. Never two at once. */
  async tick(): Promise<void> {
    if (this.running || this.stopped || this.stateError !== null) return;
    this.running = true;
    try {
      await this.step();
    } catch (err) {
      this.log.error({ err: (err as Error).message }, 'trader step failed');
      this.record({ ts: this.now(), kind: 'error', instId: this.config.instId, error: (err as Error).message });
    } finally {
      this.running = false;
    }
  }

  // ---- the step ----

  private async step(): Promise<void> {
    const now = this.now();
    const equity = this.equity();
    const rolled = rolledToDay(this.state, now, equity);
    if (rolled !== this.state) {
      this.state = rolled;
      this.save();
    }
    if (this.state.equityAtStart === null && equity !== null) {
      this.state.equityAtStart = equity;
      this.save();
    }
    const bar = fifteenCloseAtOrBefore(now);
    if (!this.deps.account.ready || equity === null) return;
    if (this.state.lastBarTs !== null && bar <= this.state.lastBarTs) return this.watch(now, equity);
    const g = this.config.guardrails;
    const inSession = inTraderSession(bar, g);
    const fifteen = inSession || this.state.position !== null || this.state.control.position !== null ? await this.confirmedBars(bar) : [];
    await this.reconcilePosition(bar, now, equity, fifteen, null);
    await this.expirePendingLimit(bar);
    await this.guardStop(bar);
    this.settleControl(fifteen, bar);
    const done = (): void => {
      this.state.lastBarTs = bar;
      this.save();
      this.emitChange();
    };
    // Outside the session a position is left to its stop; nothing is asked.
    if (!inSession || this.model === null) return done();
    // A position the trader did not open: nothing is asked and nothing is opened until it is gone.
    const foreign = this.foreignPosition();
    if (foreign) {
      if (!this.foreignWarned) this.log.warn({ instId: this.config.instId, pos: foreign.pos, avgPx: foreign.avgPx }, 'the exchange holds a position the trader did not open: it asks nothing and opens nothing until that position is closed');
      this.foreignWarned = true;
      return done();
    }
    this.foreignWarned = false;
    const position = this.state.position;
    const macro = await this.readMacro(bar);
    const dossier = await buildTraderDossier({ instId: this.config.instId, now: bar, sources: this.sources, account: this.accountInfo(equity, position), guardrails: g, calendar: this.calendarFor(bar), triggers: [], macro, recentDecisions: this.state.recentDecisions ?? [], recentTrades: recentTradesOf(this.state.recent) });
    const triggers = detectTriggers(this.lastDossier, dossier);
    const hourly = bar % HOUR_MS === 0;
    this.lastDossier = dossier;
    const reasons =
      this.config.cadence === 'model'
        ? this.wakeReasons(bar, dossier, fifteen)
        : [...(hourly ? ['hourly close'] : []), ...(this.config.cadence === '15m' && !hourly ? ['15-minute close'] : []), ...triggers];
    if (reasons.length === 0) return done();
    dossier.triggers = reasons;
    await this.consult(dossier, bar, now, equity);
    done();
  }

  /** The 15-minute candles with the bar that closed at `bar` confirmed, polled a few times; what there is when it stays unconfirmed. */
  private async confirmedBars(bar: number): Promise<Candle[]> {
    let candles: Candle[] = [];
    for (let attempt = 0; attempt < this.pollAttempts; attempt++) {
      try {
        candles = await this.sources.candles(this.config.instId, '15m', 300);
      } catch (err) {
        this.log.warn({ err: (err as Error).message }, 'the 15-minute candles could not be read');
      }
      if (candles.some((c) => c.confirm && c.ts === bar - FIFTEEN_MINUTES_MS)) return candles;
      if (this.stopped) break;
      await this.sleep(this.pollMs);
    }
    return candles;
  }

  // ---- the model ----

  private async consult(dossier: TraderDossier, bar: number, now: number, equity: string): Promise<void> {
    const model = this.model as TraderModel;
    this.state.lastCallAt = bar;
    let answer: TraderModelAnswer;
    try {
      answer = await model.decide(dossier);
    } catch (err) {
      const error = `the model could not be asked: ${(err as Error).message}`;
      this.log.warn({ err: (err as Error).message }, 'trader model call failed');
      this.record({ ts: now, kind: 'error', instId: this.config.instId, triggers: dossier.triggers, dossier, error });
      this.lastDecision = { ts: bar, decision: null, verdict: error, executed: false, usage: null, triggers: dossier.triggers, error };
      // asked again in half an hour; the wake levels are dropped so that a failing model is not called at every close
      this.state.wake = { at: bar + 30 * 60_000, above: null, below: null, setAt: bar };
      return;
    }
    this.addUsage(answer.usage);
    const decision = answer.decision;
    this.state.wake = wakeOf(decision, bar);
    if (decision) this.state.recentDecisions = [{ ts: bar, triggers: dossier.triggers, action: decision.action, oneLiner: decision.oneLiner, invalidation: decision.invalidation, wakeAbove: this.state.wake.above, wakeBelow: this.state.wake.below }, ...(this.state.recentDecisions ?? [])].slice(0, 5);
    let verdictText = answer.problem ?? 'no decision';
    let executed = false;
    if (decision) {
      const verdict = checkDecision(decision, dossier.mark, this.config.guardrails, this.state.position);
      if (!verdict.ok) verdictText = `not carried out: ${verdict.reason}`;
      else {
        const blocked = verdict.action === 'long' || verdict.action === 'short' ? this.entryBlocked(bar, equity) : null;
        if (blocked !== null) verdictText = `not carried out: ${blocked}`;
        else {
          try {
            const outcome = await this.execute(verdict, dossier, equity, bar, now);
            executed = outcome.executed;
            verdictText = outcome.note;
          } catch (err) {
            verdictText = `execution failed: ${(err as Error).message}`;
            this.log.error({ err: (err as Error).message, action: verdict.action }, 'trader execution failed');
          }
        }
      }
    }
    this.record({ ts: now, kind: 'decision', instId: this.config.instId, triggers: dossier.triggers, dossier, decision, verdict: verdictText, usage: answer.usage });
    this.lastDecision = { ts: bar, decision, verdict: verdictText, executed, usage: answer.usage, triggers: dossier.triggers, error: answer.problem };
    this.log.info({ action: decision?.action ?? null, verdict: verdictText, executed, tokens: answer.usage.inputTokens + answer.usage.outputTokens, ms: answer.usage.ms }, 'trader decision');
  }

  /**
   * Between two closes, at every tick: a position gone from the exchange is booked at once, and in the session the mark
   * is held against the wake levels; a hit asks the model now, not at the close, at most once per WATCH_COOLDOWN_MS
   * (TRADER_CADENCE=model).
   */
  private async watch(now: number, equity: string): Promise<void> {
    const mark = this.deps.market.liveMarkPrice(this.config.instId);
    if (mark === undefined) return;
    if (await this.reconcilePosition(now, now, equity, [], mark)) {
      this.save();
      this.emitChange();
    }
    if (this.config.cadence !== 'model' || this.model === null || !inTraderSession(now, this.config.guardrails) || this.foreignPosition()) return;
    if (this.watchedAt !== null && now - this.watchedAt < WATCH_COOLDOWN_MS) return;
    const reasons = this.priceReasons(mark);
    if (reasons.length === 0) return;
    this.watchedAt = now;
    const position = this.state.position;
    const macro = await this.readMacro(now);
    const dossier = await buildTraderDossier({ instId: this.config.instId, now, sources: this.sources, account: this.accountInfo(equity, position), guardrails: this.config.guardrails, calendar: this.calendarFor(now), triggers: reasons, macro, recentDecisions: this.state.recentDecisions ?? [], recentTrades: recentTradesOf(this.state.recent) });
    this.lastDossier = dossier;
    await this.consult(dossier, now, now, equity);
    this.save();
    this.emitChange();
  }

  /** The mark against the wake levels. */
  private priceReasons(mark: string): string[] {
    const out: string[] = [];
    const m = D(mark);
    const wake = this.state.wake ?? null;
    if (wake?.above != null && m.gte(wake.above)) out.push(`price reached ${wake.above}`);
    if (wake?.below != null && m.lte(wake.below)) out.push(`price reached ${wake.below}`);
    // Never at the stop or the target: both are the exchange's to execute; asking the model at the stop invites a panic close.
    return out;
  }

  /**
   * Why the model is asked at this close with TRADER_CADENCE=model; empty when it is not. The first close of the session
   * day; its own recheck time; a wake level reached by the bar that closed or by the mark; a high-impact US release that
   * came out in the bar that closed, or (with a position) one due before the next close.
   */
  private wakeReasons(bar: number, dossier: TraderDossier, fifteen: readonly Candle[]): string[] {
    const out: string[] = [];
    const wake = this.state.wake ?? null;
    const lastCall = this.state.lastCallAt;
    if (lastCall === null || utcDate(lastCall) !== utcDate(bar)) out.push('session open');
    else if (wake === null || bar >= wake.at) out.push('scheduled recheck');
    const last = fifteen.find((c) => c.confirm && c.ts === bar - FIFTEEN_MINUTES_MS);
    const mark = D(dossier.mark);
    if (wake?.above != null && (mark.gte(wake.above) || (last !== undefined && D(last.high).gte(wake.above)))) out.push(`price reached ${wake.above}`);
    if (wake?.below != null && (mark.lte(wake.below) || (last !== undefined && D(last.low).lte(wake.below)))) out.push(`price reached ${wake.below}`);
    for (const e of dossier.macro.calendar) {
      if (e.country !== 'USD' || e.impact !== 'High') continue;
      if (e.time > bar - FIFTEEN_MINUTES_MS && e.time <= bar) out.push(`high-impact release out: ${e.title}`);
      else if (this.state.position && e.time > bar && e.time <= bar + FIFTEEN_MINUTES_MS) out.push(`high-impact release in ${Math.round((e.time - bar) / 60_000)} min with a position open: ${e.title}`);
    }
    return out;
  }

  private async readMacro(bar: number): Promise<TraderMacro> {
    try {
      this.lastMacro = await this.macroSource.read(bar);
    } catch (err) {
      this.lastMacro = { calendar: [], headlines: [], notes: [`news not read (${(err as Error).message})`] };
    }
    return this.lastMacro;
  }

  /** The view's last decision after a restart: the newest decision of the log. */
  private restoreLastDecision(): void {
    const rec = this.logPage(50).records.find((r) => r.kind === 'decision');
    if (!rec) return;
    const verdict = rec.verdict ?? '';
    const executed = /^(long|short|limit|closed|stop tightened)/.test(verdict);
    this.lastDecision = { ts: rec.ts, decision: rec.decision ?? null, verdict, executed, usage: rec.usage ?? null, triggers: rec.triggers ?? [], error: null };
  }

  /** Why no position may be opened now; null when one may. */
  private entryBlocked(bar: number, equity: string): string | null {
    const g = this.config.guardrails;
    const s = this.state;
    if (!inTraderSession(bar, g)) return 'outside the session';
    if (s.position) return `a ${s.position.side} is held`;
    if (s.pendingLimit) return 'a limit order is resting';
    if (this.foreignPosition()) return 'the exchange holds a position the trader did not open';
    if (s.tradesToday >= g.maxTradesPerDay) return `the day's ${g.maxTradesPerDay} trades are done`;
    if (s.equityAtStart !== null && D(s.pnlToday).lte(D(s.equityAtStart).mul(g.dailyLossPct).neg())) return `the daily loss limit (${D(g.dailyLossPct).mul(100).toFixed()}% of ${s.equityAtStart}) is reached`;
    if (s.cooldownUntil !== null && s.cooldownUntil > bar) return `cooling down until ${iso(s.cooldownUntil)} after ${g.maxConsecutiveLosses} losses in a row`;
    if (this.deps.risk.state.killSwitch) return 'the kill switch is on';
    if (!D(equity).gt(0)) return 'the account has no equity';
    return null;
  }

  private async execute(verdict: TraderVerdict & { ok: true }, dossier: TraderDossier, equity: string, bar: number, now: number): Promise<{ executed: boolean; note: string }> {
    const { instId } = this.config;
    const posSideOf = (side: 'long' | 'short'): PosSide | undefined => (this.deps.account.config?.posMode === 'long_short_mode' ? side : undefined);
    if (verdict.action === 'flat') return { executed: false, note: 'flat' };
    const held = this.state.position;
    if ((verdict.action === 'close' || verdict.action === 'tighten_stop') && held && !this.livePosition()) return { executed: false, note: 'the position is already gone: the stop took it before the decision arrived' };
    if (verdict.action === 'close') {
      if (!held) return { executed: false, note: 'close without a position' };
      const posSide = posSideOf(held.side);
      await this.deps.orders.closePosition({ instId, mgnMode: 'isolated', ...(posSide ? { posSide } : {}) });
      this.closing = true;
      this.closeControlAtMark(dossier.mark, bar);
      return { executed: true, note: 'closed at the market' };
    }
    if (verdict.action === 'tighten_stop') {
      if (!held) return { executed: false, note: 'tighten_stop without a position' };
      const algo = this.deps.account.algoOrders?.orders.find((o) => o.instId === instId && o.slTriggerPx !== '');
      if (!algo) throw new Error('no stop order found on the exchange to tighten');
      await this.deps.orders.amendStop({ instId, algoId: algo.algoId, slTriggerPx: verdict.stopPx });
      held.stopPx = verdict.stopPx;
      if (this.state.control.position) this.state.control.position.stopPx = this.mirrorStop(verdict.stopPx, held, this.state.control.position);
      return { executed: true, note: `stop tightened to ${verdict.stopPx}` };
    }
    // long or short
    const inst = this.deps.market.requireInstrument(instId);
    const size = traderSize({ equity, entryPx: verdict.entryPx, stopPx: verdict.stopPx, inst, guardrails: this.config.guardrails });
    if (size === null) return { executed: false, note: `not carried out: ${D(equity).mul(this.config.guardrails.riskPct).toFixed(2)} of risk at that stop buys less than the minimum order` };
    const side = verdict.action;
    const posSide = posSideOf(side);
    await this.deps.orders.setIsolatedLeverage(instId, size.leverage, posSide ?? 'net');
    const clOrdId = generateClOrdId(now, CL_ORD_PREFIXES.trader);
    const req: PlaceOrderRequest = {
      instId,
      side: side === 'long' ? 'buy' : 'sell',
      ordType: verdict.entryType === 'market' ? 'market' : 'limit',
      ...(verdict.entryType === 'limit' ? { px: verdict.entryPx } : {}),
      tdMode: 'isolated',
      ...(posSide ? { posSide } : {}),
      size: { unit: 'contracts', value: size.contracts },
      slTriggerPx: verdict.stopPx,
      ...(verdict.targetPx !== null ? { takeProfits: [{ triggerPx: verdict.targetPx, fraction: '1' }] } : {}),
      clOrdId,
    };
    const { order } = await this.deps.orders.place(req);
    this.record({ ts: now, kind: 'execution', instId, order: { clOrdId, side: req.side, entryType: verdict.entryType, contracts: size.contracts, entryPx: verdict.entryPx, stopPx: verdict.stopPx, targetPx: verdict.targetPx, leverage: size.leverage } });
    if (verdict.entryType === 'limit') {
      this.state.pendingLimit = { clOrdId, side, contracts: size.contracts, px: verdict.entryPx, stopPx: verdict.stopPx, targetPx: verdict.targetPx, leverage: size.leverage, placedAt: now, barTs: bar, equityAtEntry: equity };
      return { executed: true, note: `limit ${side} resting at ${verdict.entryPx}, stop ${verdict.stopPx}` };
    }
    const entryPx = order.avgPx !== '' ? order.avgPx : verdict.entryPx;
    this.openPosition({ side, contracts: size.contracts, entryPx, stopPx: verdict.stopPx, targetPx: verdict.targetPx, openedAt: now, clOrdId, equityAtEntry: equity }, dossier.mark, bar);
    return { executed: true, note: `${side} ${size.contracts} contracts at ${entryPx}, stop ${verdict.stopPx}${verdict.targetPx ? `, target ${verdict.targetPx}` : ''}, ${size.leverage}x` };
  }

  private openPosition(position: TraderPosition, mark: string, bar: number): void {
    this.state.position = position;
    this.state.tradesToday += 1;
    this.closing = false;
    if (this.config.control) this.openControl(position, mark, bar);
  }

  // ---- the position on the exchange ----

  private livePosition(): Position | null {
    return this.deps.account.positionList().find((p) => p.instId === this.config.instId && !D(p.pos || '0').isZero()) ?? null;
  }

  /** A position on the instrument that the trader neither holds nor is waiting to fill: someone else's (a manual order, a lost answer). */
  private foreignPosition(): Position | null {
    if (this.state.position || this.state.pendingLimit) return null;
    return this.livePosition();
  }

  /**
   * The held position still has its stop on the exchange: when none is found (a partial fill, a stop the exchange did
   * not create, one cancelled by hand) one is placed at the held stop price, and when the mark is already past it the
   * position is closed. Not for a position opened in this step: the exchange creates its stop as it fills.
   */
  private async guardStop(bar: number): Promise<void> {
    const held = this.state.position;
    if (!held || held.openedAt >= bar) return;
    const live = this.livePosition();
    if (!live) return;
    const { instId } = this.config;
    const closing = held.side === 'long' ? 'sell' : 'buy';
    let algos;
    try {
      algos = await this.deps.account.refreshAlgoOrders();
    } catch (err) {
      this.log.warn({ err: (err as Error).message }, 'the stops could not be read: the stop guard waits for the next close');
      return;
    }
    if (algos.orders.some((o) => o.instId === instId && o.side === closing && o.slTriggerPx !== '')) return;
    const posSide = this.deps.account.config?.posMode === 'long_short_mode' ? held.side : undefined;
    const mark = this.deps.market.liveMarkPrice(instId);
    const past = mark !== undefined && (held.side === 'long' ? D(mark).lte(held.stopPx) : D(mark).gte(held.stopPx));
    try {
      if (past) {
        await this.deps.orders.closePosition({ instId, mgnMode: 'isolated', ...(posSide ? { posSide } : {}) });
        this.log.error({ instId, stopPx: held.stopPx, mark }, 'the position had no stop and the mark is past it: closed at the market');
      } else {
        await this.deps.orders.placeStop({ instId, mgnMode: 'isolated', ...(posSide ? { posSide } : {}), slTriggerPx: held.stopPx });
        this.log.error({ instId, stopPx: held.stopPx }, 'the position had no stop on the exchange: one was placed at the held stop price');
      }
      this.record({ ts: this.now(), kind: 'error', instId, error: past ? `no stop on the exchange and the mark ${mark ?? ''} past ${held.stopPx}: closed at the market` : `no stop on the exchange: one placed at ${held.stopPx}` });
    } catch (err) {
      this.log.error({ instId, err: (err as Error).message }, 'the missing stop could not be restored');
      this.record({ ts: this.now(), kind: 'error', instId, error: `no stop on the exchange and it could not be restored: ${(err as Error).message}` });
    }
  }

  /**
   * A position gone from the exchange is a result; a limit order that filled is a position. At a close the bar that
   * closed says how the position ended; between closes the mark does. True when something changed.
   */
  private async reconcilePosition(bar: number, now: number, equity: string, fifteen: readonly Candle[], mark: string | null): Promise<boolean> {
    const live = this.livePosition();
    const held = this.state.position;
    if (held && !live) {
      const pnl = D(equity).minus(held.equityAtEntry);
      const last = fifteen.find((c) => c.ts === bar - FIFTEEN_MINUTES_MS) ?? null;
      const end = this.closing ? 'close' : this.endOf(held, last, mark);
      const result: TraderTradeResult = { side: held.side, openedAt: held.openedAt, closedAt: bar, entryPx: held.entryPx, exitPx: null, contracts: held.contracts, pnl: money(pnl), end, stopPx: held.stopPx, targetPx: held.targetPx };
      this.settleResult(result, now);
      this.state.position = null;
      this.closing = false;
      this.record({ ts: now, kind: 'result', instId: this.config.instId, result });
      this.log.info({ side: held.side, pnl: result.pnl, end }, 'trader position ended');
      return true;
    } else if (!held && live && this.state.pendingLimit) {
      const p = this.state.pendingLimit;
      this.state.pendingLimit = null;
      // A partial fill: the rest is cancelled, so that the exchange creates the stop for what filled (it waits for the order to end).
      if (this.deps.account.openOrderList().some((o) => o.clOrdId === p.clOrdId)) {
        try {
          await this.deps.orders.cancel({ instId: this.config.instId, clOrdId: p.clOrdId });
          this.log.info({ clOrdId: p.clOrdId, filled: live.pos }, 'trader limit order partly filled: the rest is cancelled');
        } catch (err) {
          this.log.warn({ clOrdId: p.clOrdId, err: (err as Error).message }, 'the rest of a partly filled limit order could not be cancelled');
        }
      }
      const entryPx = live.avgPx !== '' ? live.avgPx : p.px;
      this.openPosition({ side: p.side, contracts: D(live.pos).abs().toFixed(), entryPx, stopPx: p.stopPx, targetPx: p.targetPx, openedAt: now, clOrdId: p.clOrdId, equityAtEntry: p.equityAtEntry }, entryPx, bar);
      this.record({ ts: now, kind: 'execution', instId: this.config.instId, order: { clOrdId: p.clOrdId, side: p.side === 'long' ? 'buy' : 'sell', entryType: 'limit', contracts: p.contracts, entryPx, stopPx: p.stopPx, targetPx: p.targetPx, leverage: p.leverage } });
      return true;
    }
    return false;
  }

  private endOf(held: TraderPosition, bar: Candle | null, mark: string | null): TraderTradeResult['end'] {
    const long = held.side === 'long';
    const low = bar?.low ?? mark;
    const high = bar?.high ?? mark;
    if (low === null || high === null) return 'external';
    const stopHit = long ? D(low).lte(held.stopPx) : D(high).gte(held.stopPx);
    const targetHit = held.targetPx !== null && (long ? D(high).gte(held.targetPx) : D(low).lte(held.targetPx));
    return stopHit ? 'stop' : targetHit ? 'target' : 'external';
  }

  private settleResult(result: TraderTradeResult, now: number): void {
    const g = this.config.guardrails;
    const s = this.state;
    s.pnlToday = money(D(s.pnlToday).plus(result.pnl));
    if (D(result.pnl).lt(0)) {
      s.consecutiveLosses += 1;
      if (g.maxConsecutiveLosses > 0 && s.consecutiveLosses >= g.maxConsecutiveLosses) {
        s.cooldownUntil = now + g.cooldownMs;
        s.consecutiveLosses = 0;
      }
    } else s.consecutiveLosses = 0;
    s.recent = [result, ...s.recent].slice(0, RECENT_KEPT);
  }

  /** A limit order of an earlier close still resting is cancelled; one that is gone without a position was rejected or closed. */
  private async expirePendingLimit(bar: number): Promise<void> {
    const p = this.state.pendingLimit;
    if (!p || p.barTs >= bar || this.state.position) return;
    const resting = this.deps.account.openOrderList().some((o) => o.clOrdId === p.clOrdId);
    if (resting) {
      try {
        await this.deps.orders.cancel({ instId: this.config.instId, clOrdId: p.clOrdId });
        this.log.info({ clOrdId: p.clOrdId }, 'trader limit order cancelled: not filled by the next close');
      } catch (err) {
        this.log.warn({ clOrdId: p.clOrdId, err: (err as Error).message }, 'trader limit order could not be cancelled');
        return;
      }
    }
    this.state.pendingLimit = null;
  }

  // ---- the coin-flip control ----

  private flip(): 'long' | 'short' {
    const n = this.state.flips++;
    const x = Math.sin(n * 9301 + 49297) * 233280;
    return x - Math.floor(x) < 0.5 ? 'long' : 'short';
  }

  private openControl(position: TraderPosition, mark: string, bar: number): void {
    const inst = this.deps.market.requireInstrument(this.config.instId);
    // The control's last position is still open (it had no target, or the trader's ended first): it is closed at the mark and booked.
    const previous = this.state.control.position;
    if (previous) this.endControl(previous, mark, 'close', bar);
    const side = this.flip();
    const m = D(mark);
    const entry = side === 'long' ? m.mul(D(1).plus(CONTROL_SLIPPAGE)) : m.mul(D(1).minus(CONTROL_SLIPPAGE));
    const stopDist = D(position.entryPx).minus(position.stopPx).abs();
    const targetDist = position.targetPx === null ? null : D(position.targetPx).minus(position.entryPx).abs();
    const stopPx = side === 'long' ? entry.minus(stopDist) : entry.plus(stopDist);
    const targetPx = targetDist === null ? null : side === 'long' ? entry.plus(targetDist) : entry.minus(targetDist);
    const notional = D(position.contracts).mul(inst.ctVal).mul(entry);
    const fee = notional.mul(CONTROL_FEE).mul(2);
    this.state.control.position = { side, contracts: position.contracts, entryPx: money(entry), stopPx: money(stopPx), targetPx: targetPx === null ? null : money(targetPx), openedAt: bar, clOrdId: 'control', equityAtEntry: '0', fee: money(fee) };
    this.state.control.trades += 1;
    this.record({ ts: bar, kind: 'control', instId: this.config.instId, control: { direction: side, entryPx: money(entry), stopPx: money(stopPx), targetPx: targetPx === null ? null : money(targetPx) } });
  }

  private mirrorStop(newStop: string, held: TraderPosition, control: TraderPosition): string {
    // the same distance from the entry as the model's new stop
    const dist = D(held.entryPx).minus(newStop).abs();
    return money(control.side === 'long' ? D(control.entryPx).minus(dist) : D(control.entryPx).plus(dist));
  }

  private closeControlAtMark(mark: string, bar: number): void {
    const c = this.state.control.position;
    if (!c) return;
    this.endControl(c, mark, 'close', bar);
  }

  /** The control's position against the bar that just closed: the stop wins when both are touched. */
  private settleControl(fifteen: readonly Candle[], bar: number): void {
    const c = this.state.control.position;
    if (!c) return;
    const last = fifteen.find((x) => x.ts === bar - FIFTEEN_MINUTES_MS);
    if (!last || last.ts < c.openedAt) return;
    const long = c.side === 'long';
    if (long ? D(last.low).lte(c.stopPx) : D(last.high).gte(c.stopPx)) this.endControl(c, c.stopPx, 'stop', bar);
    else if (c.targetPx !== null && (long ? D(last.high).gte(c.targetPx) : D(last.low).lte(c.targetPx))) this.endControl(c, c.targetPx, 'target', bar);
  }

  private endControl(c: TraderPosition & { fee: string }, exitPx: string, end: TraderTradeResult['end'], bar: number): void {
    const inst = this.deps.market.requireInstrument(this.config.instId);
    const diff = D(exitPx).minus(c.entryPx).mul(c.side === 'long' ? 1 : -1);
    const pnl = D(c.contracts).mul(inst.ctVal).mul(diff).minus(c.fee);
    const result: TraderTradeResult = { side: c.side, openedAt: c.openedAt, closedAt: bar, entryPx: c.entryPx, exitPx, contracts: c.contracts, pnl: money(pnl), end };
    const control = this.state.control;
    control.position = null;
    control.pnlTotal = money(D(control.pnlTotal).plus(pnl));
    if (pnl.gte(0)) control.wins += 1;
    else control.losses += 1;
    this.record({ ts: bar, kind: 'control', instId: this.config.instId, control: result });
  }

  // ---- the account ----

  private equity(): string | null {
    const eq = this.deps.account.balance?.totalEq;
    return eq !== undefined && eq !== '' ? eq : null;
  }

  private accountInfo(equity: string, position: TraderPosition | null): TraderAccountInfo {
    const live = position ? this.livePosition() : null;
    return {
      equity,
      position: position ? { ...position, unrealizedPnl: live && live.upl !== '' ? live.upl : null } : null,
      tradesToday: this.state.tradesToday,
      pnlToday: this.state.pnlToday,
      consecutiveLosses: this.state.consecutiveLosses,
      cooldownUntil: this.state.cooldownUntil,
      killSwitch: this.deps.risk.state.killSwitch,
    };
  }

  private calendarFor(ts: number): string[] {
    const date = utcDate(ts);
    return this.config.calendar.filter((e) => e.date === date).map((e) => e.name);
  }

  private addUsage(u: TraderUsage): void {
    const day = this.state.usage;
    day.calls += 1;
    day.inputTokens += u.inputTokens;
    day.outputTokens += u.outputTokens;
    day.cacheReadTokens += u.cacheReadTokens;
  }

  // ---- the log and the state ----

  private record(rec: TraderLogRecord): void {
    try {
      mkdirSync(dirname(this.config.logFile), { recursive: true });
      appendFileSync(this.config.logFile, `${JSON.stringify(rec)}\n`);
    } catch (err) {
      this.log.error({ err: (err as Error).message, file: this.config.logFile }, 'trader log could not be written');
    }
  }

  private save(): void {
    try {
      saveTraderState(this.config.stateFile, this.state);
    } catch (err) {
      this.log.error({ err: (err as Error).message, file: this.config.stateFile }, 'trader state could not be written');
    }
  }

  private emitChange(): void {
    this.emit('change', this.view());
  }

  /** GET /api/trader/log: the newest `limit` records, without their dossiers. */
  logPage(limit: number): { records: TraderLogRecord[] } {
    if (!existsSync(this.config.logFile)) return { records: [] };
    const lines = readFileSync(this.config.logFile, 'utf8').split('\n').filter((l) => l.trim() !== '');
    const records: TraderLogRecord[] = [];
    for (const line of lines.slice(-limit).reverse()) {
      try {
        const { dossier: _dossier, ...rest } = JSON.parse(line) as TraderLogRecord;
        records.push(rest);
      } catch {
        // a line cut by a crash is skipped
      }
    }
    return { records };
  }

  /** For tests */
  stateCopy(): TraderState {
    return structuredClone(this.state);
  }

  // ---- what the service shows ----

  private status(now: number): { status: TraderStatus; reason: TraderStatusReason | null } {
    if (this.stateError !== null) return { status: 'blocked', reason: { code: 'STATE_UNREADABLE', message: `${this.stateError}: the trader does not trade until the file is repaired or moved away` } };
    if (this.model === null) return { status: 'blocked', reason: { code: 'NO_MODEL_CREDENTIALS', message: 'no ANTHROPIC_API_KEY in the environment: put one in .env and restart the stack' } };
    if (!this.deps.account.ready || this.equity() === null) return { status: 'blocked', reason: { code: 'ACCOUNT_UNAVAILABLE', message: 'the paper account has not been read yet' } };
    const foreign = this.foreignPosition();
    if (foreign) return { status: 'blocked', reason: { code: 'FOREIGN_POSITION', message: `the paper account holds a ${this.config.instId} position of ${foreign.pos} contracts that the trader did not open: it asks nothing and opens nothing until that position is closed` } };
    if (this.state.position) return { status: 'holding', reason: null };
    return { status: inTraderSession(now, this.config.guardrails) ? 'in-session' : 'idle', reason: null };
  }

  /** The next instant the model is called at the latest: the next hourly close (every 15 minutes with TRADER_CADENCE=15m) inside the session, Monday's open after Friday's close. */
  nextCallAt(now: number): number {
    const g = this.config.guardrails;
    if (this.config.cadence === 'model') {
      // the first close in session that opens a new day or reaches the wake time; a wake level may come earlier
      const wakeAt = this.state.wake?.at ?? null;
      const lastCall = this.state.lastCallAt;
      let t = Math.floor(now / FIFTEEN_MINUTES_MS) * FIFTEEN_MINUTES_MS + FIFTEEN_MINUTES_MS;
      for (let i = 0; i < 800; i++, t += FIFTEEN_MINUTES_MS) {
        if (!inTraderSession(t, g)) continue;
        if (lastCall === null || utcDate(lastCall) !== utcDate(t) || wakeAt === null || t >= wakeAt) return t;
      }
      return t;
    }
    const step = this.config.cadence === '15m' ? FIFTEEN_MINUTES_MS : HOUR_MS;
    let t = Math.floor(now / step) * step + step;
    for (let i = 0; i < 800; i++, t += step) if (inTraderSession(t, g)) return t;
    return t;
  }

  view(): TraderView {
    const now = this.now();
    const { status, reason } = this.status(now);
    const live = this.state.position ? this.livePosition() : null;
    const usage = this.state.usage;
    const upcoming = (this.lastMacro?.calendar ?? []).filter((e) => e.time >= now).slice(0, 6);
    return {
      enabled: true,
      cadence: this.config.cadence,
      wake: this.config.cadence === 'model' ? (this.state.wake ?? null) : null,
      upcoming,
      status,
      reason,
      instId: this.config.instId,
      session: { startHour: this.config.guardrails.sessionStartHour, endHour: this.config.guardrails.sessionEndHour, inSession: inTraderSession(now, this.config.guardrails) },
      guardrails: this.config.guardrails,
      model: this.model?.name ?? this.config.model,
      nextCallAt: status === 'blocked' ? null : this.nextCallAt(now),
      last: this.lastDecision,
      position: this.state.position ? { ...this.state.position, unrealizedPnl: live && live.upl !== '' ? live.upl : null } : null,
      today: { date: this.state.date, trades: this.state.tradesToday, pnl: this.state.pnlToday, consecutiveLosses: this.state.consecutiveLosses, cooldownUntil: this.state.cooldownUntil, equityAtStart: this.state.equityAtStart },
      usageToday: { calls: usage.calls, inputTokens: usage.inputTokens, outputTokens: usage.outputTokens, estimatedUsd: estimateUsd(this.config.model, usage).toDecimalPlaces(4).toFixed() },
      control: this.config.control ? this.state.control : null,
      recent: this.state.recent,
      serverTime: now,
    };
  }
}

/** For the tests: a decision that passes checkDecision at a given mark. */
export type { TraderDecision };
export { ZERO };
