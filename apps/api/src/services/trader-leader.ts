import { EventEmitter } from 'node:events';
import { appendFileSync, copyFileSync, mkdirSync, readFileSync, renameSync } from 'node:fs';
import { dirname } from 'node:path';
import {
  checkLeaderDecision,
  CL_ORD_PREFIXES,
  D,
  Decimal,
  estimateUsd,
  LEADER_INSTRUMENTS,
  LEADER_RULES,
  leaderLotSize,
  recentTradesOf,
  TRADER_TAKER_FEE,
  wakeOf,
  ZERO,
  type LeaderCoinView,
  type LeaderDecision,
  type LeaderDossier,
  type LeaderInfo,
  type LeaderLot,
  type LeaderRules,
  type LeaderVerdict,
  type PlaceOrderRequest,
  type Position,
  type TraderAccountInfo,
  type TraderDossier,
  type TraderLastDecision,
  type TraderLogRecord,
  type TraderMacro,
  type TraderPreviousDecision,
  type TraderStatus,
  type TraderStatusReason,
  type TraderTradeResult,
  type TraderUsage,
  type TraderView,
  type TraderWake,
} from '@pegasus/shared';
import type { TraderConfig } from '../config.js';
import type { Logger } from '../logger.js';
import { generateClOrdId } from './order-service.js';
import { buildTraderDossier, exchangeDossierSources, fifteenCloseAtOrBefore, type TraderDossierSources } from './trader-dossier.js';
import { FeedMacroSource, NO_MACRO, type TraderMacroSource } from './trader-macro.js';
import { ClaudeLeaderModel, hasAnthropicCredentials, type LeaderModel, type ModelAnswer } from './trader-model.js';
import { readTraderLog, RECENT_KEPT, saveTraderState, utcDate, type TraderUsageDay } from './trader-state.js';
import type { TraderServiceDeps } from './trader.js';

/**
 * The Claude auto trader in the lead-trader style (TRADER_STYLE=leader, the default since 2026-11-08; the owner:
 * 「我原来得设想是让opus交易员以这几位欧意交易员为榜样」, 「改吧」; the rules in packages/shared/src/trader.ts, LEADER_RULES
 * and checkLeaderDecision; docs/proposals/claude-auto-trader.md). On the trader's own paper stack it trades
 * LEADER_INSTRUMENTS long only, in lots, cross margin, no stop: at every daily close (00:00 UTC, every day), at the
 * recheck time the model named and as soon as the mark reaches a level it named, each coin's dossier (trader-dossier.ts,
 * with the `leader` block: the rules, every coin's ladder, this coin's, what a lot buys now and why a buy would be
 * refused) is put to the model, which answers buy, sell or hold for that coin. A buy that passes the rules is one lot at
 * the market; a sell closes the coin's position. The breaker: the equity at or under (1 - breakerPct) of the equity the
 * record began with sells everything and stops the trader for good (the state file is moved away to begin again).
 *
 * The clock is looked at every checkEveryMs; a 15-minute close that has not been processed reconciles every coin (a
 * position gone from the exchange is a result, measured from the lots and the mark; one the trader did not open blocks
 * that coin), runs the breaker, and asks what is due. Between closes the marks are held against the wake levels, at most
 * one call per coin per WATCH_COOLDOWN_MS. Every decision goes to TRADER_LOG_FILE with its dossier; the lots, the wakes
 * and the counters to TRADER_STATE_FILE (version 2; a flat file of the stops style is moved aside, one with a position
 * blocks the trader). The control of this style is the mechanical ladder book of the plain paper stack (the STRATEGIES
 * tab), not a coin flip: TRADER_CONTROL is ignored here.
 */

export interface LeaderServiceOptions {
  now?: () => number;
  sleep?: (ms: number) => Promise<void>;
  model?: LeaderModel;
  sources?: TraderDossierSources;
  macro?: TraderMacroSource;
  /** How often the clock is looked at; 0: never by itself (tick() is called). Default 15 s */
  checkEveryMs?: number;
  /** Interval and count of the polls for the daily bar that just closed to be confirmed. Default 5 s, 12 polls */
  pollMs?: number;
  pollAttempts?: number;
  rules?: LeaderRules;
}

export const LEADER_STATE_VERSION = 2;
const DAY_MS = 24 * 3_600_000;
const FIFTEEN_MS = 15 * 60_000;
export const LEADER_WATCH_COOLDOWN_MS = 5 * 60_000;
const money = (v: Decimal): string => v.toDecimalPlaces(8).toFixed();

export interface LeaderCoinState {
  instId: string;
  lots: LeaderLot[];
  wake: TraderWake | null;
  lastCallAt: number | null;
  /** Newest first, at most five: shown to the model at its next call on the coin */
  recentDecisions: TraderPreviousDecision[];
  /** The trader is closing the coin's position (the model's sale or the breaker) until the exchange reports it gone */
  closing: 'close' | 'breaker' | null;
}

export interface LeaderState {
  version: typeof LEADER_STATE_VERSION;
  style: 'leader';
  startedAt: number;
  /** The equity at the first look: the breaker measures from it */
  startEquity: string | null;
  /** Why the trader stopped; null while it trades */
  halted: string | null;
  /** Open time of the last 15-minute bar processed */
  lastBarTs: number | null;
  /** UTC day of the counters */
  date: string;
  lotsToday: number;
  pnlToday: string;
  coins: LeaderCoinState[];
  /** Newest first, at most RECENT_KEPT */
  recent: TraderTradeResult[];
  usage: TraderUsageDay;
}

const emptyCoin = (instId: string): LeaderCoinState => ({ instId, lots: [], wake: null, lastCallAt: null, recentDecisions: [], closing: null });

export function emptyLeaderState(now: number, instIds: readonly string[] = LEADER_INSTRUMENTS): LeaderState {
  const date = utcDate(now);
  return { version: LEADER_STATE_VERSION, style: 'leader', startedAt: now, startEquity: null, halted: null, lastBarTs: null, date, lotsToday: 0, pnlToday: '0', coins: instIds.map(emptyCoin), recent: [], usage: { date, calls: 0, inputTokens: 0, outputTokens: 0, cacheReadTokens: 0 } };
}

const isObject = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);

export type LeaderStateLoad = { ok: true; state: LeaderState; note?: string } | { ok: false; error: string };

/**
 * The state file: this version's, or none. A file of the stops style (version 1) that holds no position and no resting
 * order is moved to `<file>.stops-v1` and the record begins empty; one that holds a position blocks the trader, so that
 * nothing is left unattended on the exchange. Anything else is kept as `.corrupt` and blocks the trader.
 */
export function loadLeaderState(file: string, now: number, instIds: readonly string[] = LEADER_INSTRUMENTS): LeaderStateLoad {
  let text: string;
  try {
    text = readFileSync(file, 'utf8');
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return { ok: true, state: emptyLeaderState(now, instIds) };
    return { ok: false, error: `the trader state ${file} could not be read (${(err as Error).message})` };
  }
  let parsed: unknown = null;
  let problem: string | null = null;
  try {
    parsed = JSON.parse(text);
  } catch (err) {
    problem = (err as Error).message;
  }
  if (problem === null && isObject(parsed) && parsed['version'] === 1) {
    if (parsed['position'] !== null || parsed['pendingLimit'] !== null) return { ok: false, error: `${file} is the stops style's and holds a position or a resting order: close it first (restart with TRADER_STYLE=stops), or move the file away` };
    const archived = `${file}.stops-v1`;
    renameSync(file, archived);
    return { ok: true, state: emptyLeaderState(now, instIds), note: `the stops style's flat state was moved to ${archived}` };
  }
  if (problem === null && (!isObject(parsed) || parsed['version'] !== LEADER_STATE_VERSION || parsed['style'] !== 'leader' || !Array.isArray(parsed['coins']) || !Array.isArray(parsed['recent']) || !isObject(parsed['usage']))) {
    problem = `not a lead-trader state of version ${LEADER_STATE_VERSION}`;
  }
  if (problem !== null) {
    try {
      copyFileSync(file, `${file}.corrupt`);
    } catch {
      // the copy is a courtesy
    }
    return { ok: false, error: `the trader state ${file} is not one this version wrote (${problem}); a copy is kept as .corrupt` };
  }
  const state = parsed as LeaderState;
  for (const instId of instIds) if (!state.coins.some((c) => c.instId === instId)) state.coins.push(emptyCoin(instId));
  return { ok: true, state };
}

export class LeaderTraderService extends EventEmitter<{ change: [TraderView] }> {
  private state: LeaderState;
  private stateError: string | null = null;
  private timer: NodeJS.Timeout | null = null;
  private running = false;
  private stopped = false;
  private lastDecision: TraderLastDecision | null = null;
  private lastMacro: TraderMacro | null = null;
  private readonly foreignWarned = new Set<string>();
  private readonly mismatchWarned = new Map<string, string>();
  private readonly watchedAt = new Map<string, number>();
  /** The 1D ATR14 last seen per coin, for the ladders of the other coins in a dossier and on the screen */
  private readonly atrSeen = new Map<string, string>();
  private readonly model: LeaderModel | null;
  private readonly sources: TraderDossierSources;
  private readonly macroSource: TraderMacroSource;
  private readonly rules: LeaderRules;
  private readonly now: () => number;
  private readonly sleep: (ms: number) => Promise<void>;
  private readonly checkEveryMs: number;
  private readonly pollMs: number;
  private readonly pollAttempts: number;
  private readonly log: Logger;

  constructor(
    private readonly config: TraderConfig,
    private readonly deps: TraderServiceDeps,
    opts: LeaderServiceOptions = {},
  ) {
    super();
    this.log = deps.log.child({ component: 'trader' });
    this.now = opts.now ?? Date.now;
    this.sleep = opts.sleep ?? ((ms) => new Promise((resolve) => setTimeout(resolve, ms).unref()));
    this.sources = opts.sources ?? exchangeDossierSources(deps.market, deps.clients);
    this.macroSource = opts.macro ?? (config.news ? new FeedMacroSource() : NO_MACRO);
    this.rules = opts.rules ?? LEADER_RULES;
    this.checkEveryMs = opts.checkEveryMs ?? 15_000;
    this.pollMs = opts.pollMs ?? 5_000;
    this.pollAttempts = opts.pollAttempts ?? 12;
    this.model = opts.model ?? (hasAnthropicCredentials() ? new ClaudeLeaderModel({ model: config.model, effort: config.effort }) : null);
    this.state = emptyLeaderState(this.now());
  }

  // ---- life cycle ----

  async start(): Promise<void> {
    const loaded = loadLeaderState(this.config.stateFile, this.now());
    if (!loaded.ok) {
      this.stateError = loaded.error;
      this.log.error({ file: this.config.stateFile, err: loaded.error }, 'trader state unreadable: the trader does not trade; repair or move the file away');
      this.emitChange();
      return;
    }
    this.state = loaded.state;
    if (loaded.note !== undefined) this.log.info({ file: this.config.stateFile }, loaded.note);
    this.restoreLastDecision();
    this.log.info({ file: this.config.stateFile, instruments: LEADER_INSTRUMENTS, model: this.model?.name ?? null, lots: this.state.coins.map((c) => `${c.instId} ${c.lots.length}`), halted: this.state.halted }, 'trader state loaded (lead-trader style)');
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
      this.record({ ts: this.now(), kind: 'error', instId: LEADER_INSTRUMENTS.join(','), error: (err as Error).message });
    } finally {
      this.running = false;
    }
  }

  // ---- the step ----

  private async step(): Promise<void> {
    const now = this.now();
    const equity = this.equity();
    if (!this.deps.account.ready || equity === null) return;
    this.rollDay(now);
    if (this.state.startEquity === null) {
      this.state.startEquity = equity;
      this.save();
    }
    const bar = fifteenCloseAtOrBefore(now);
    if (this.state.lastBarTs !== null && bar <= this.state.lastBarTs) return this.watch(now, equity);
    for (const coin of this.state.coins) await this.reconcile(coin, bar, now);
    await this.breaker(now, equity);
    const done = (): void => {
      this.state.lastBarTs = bar;
      this.save();
      this.emitChange();
    };
    if (this.model === null || this.state.halted !== null) return done();
    const daily = bar % DAY_MS === 0;
    for (const coin of this.state.coins) {
      const mark = this.mark(coin.instId);
      const due = daily ? ['daily close'] : coin.wake !== null && bar >= coin.wake.at ? ['scheduled recheck'] : [];
      const reasons = [...due, ...(mark === null ? [] : this.priceReasons(coin, mark))];
      if (reasons.length === 0) continue;
      if (this.foreignPosition(coin)) {
        if (!this.foreignWarned.has(coin.instId)) this.log.warn({ instId: coin.instId }, 'the exchange holds a position the trader did not open: the coin is not asked about and nothing is bought until that position is closed');
        this.foreignWarned.add(coin.instId);
        continue;
      }
      this.foreignWarned.delete(coin.instId);
      if (daily) await this.confirmedDaily(coin.instId, bar);
      await this.consult(coin, reasons, bar, now, this.equity() ?? equity);
    }
    done();
  }

  /** Waits for the daily bar that closed at `bar` to be confirmed, a few polls; goes on with what there is when it stays unconfirmed. */
  private async confirmedDaily(instId: string, bar: number): Promise<void> {
    for (let attempt = 0; attempt < this.pollAttempts; attempt++) {
      try {
        const daily = await this.sources.candles(instId, '1D', 5);
        if (daily.some((c) => c.confirm && c.ts === bar - DAY_MS)) return;
      } catch (err) {
        this.log.warn({ instId, err: (err as Error).message }, 'the daily candles could not be read');
      }
      if (this.stopped) return;
      await this.sleep(this.pollMs);
    }
    this.log.warn({ instId, bar }, 'the daily bar was not confirmed in time: the dossier stands on the bars confirmed so far');
  }

  /** Between two closes, at every tick: a position gone is booked at once, and each mark is held against its wake levels. */
  private async watch(now: number, equity: string): Promise<void> {
    let changed = false;
    for (const coin of this.state.coins) if (await this.reconcile(coin, now, now)) changed = true;
    if (changed) {
      this.save();
      this.emitChange();
    }
    if (this.model === null || this.state.halted !== null) return;
    for (const coin of this.state.coins) {
      const mark = this.mark(coin.instId);
      if (mark === null) continue;
      const last = this.watchedAt.get(coin.instId);
      if (last !== undefined && now - last < LEADER_WATCH_COOLDOWN_MS) continue;
      const reasons = this.priceReasons(coin, mark);
      if (reasons.length === 0 || this.foreignPosition(coin)) continue;
      this.watchedAt.set(coin.instId, now);
      await this.consult(coin, reasons, now, now, this.equity() ?? equity);
      this.save();
      this.emitChange();
    }
  }

  /** The mark against the coin's wake levels. */
  private priceReasons(coin: LeaderCoinState, mark: string): string[] {
    const out: string[] = [];
    const m = D(mark);
    if (coin.wake?.above != null && m.gte(coin.wake.above)) out.push(`price reached ${coin.wake.above}`);
    if (coin.wake?.below != null && m.lte(coin.wake.below)) out.push(`price reached ${coin.wake.below}`);
    return out;
  }

  // ---- the model ----

  private async consult(coin: LeaderCoinState, triggers: string[], bar: number, now: number, equity: string): Promise<void> {
    const model = this.model as LeaderModel;
    const { instId } = coin;
    coin.lastCallAt = bar;
    let dossier: TraderDossier;
    try {
      const macro = await this.readMacro(bar);
      dossier = await buildTraderDossier({ instId, now: bar, sources: this.sources, account: this.accountInfo(equity), guardrails: this.config.guardrails, calendar: this.calendarFor(bar), triggers, macro, recentDecisions: coin.recentDecisions, recentTrades: recentTradesOf(this.state.recent.filter((r) => r.instId === instId)) });
    } catch (err) {
      this.log.warn({ instId, err: (err as Error).message }, 'the dossier could not be built: asked again at the next close');
      this.record({ ts: now, kind: 'error', instId, triggers, error: `the dossier could not be built: ${(err as Error).message}` });
      return;
    }
    const atr = dossier.frames.find((f) => f.bar === '1D')?.atr14 ?? null;
    if (atr !== null) this.atrSeen.set(instId, atr);
    dossier.leader = this.leaderDossier(coin, equity, dossier.mark);
    let answer: ModelAnswer<LeaderDecision>;
    try {
      answer = await model.decide(dossier);
    } catch (err) {
      const error = `the model could not be asked: ${(err as Error).message}`;
      this.log.warn({ instId, err: (err as Error).message }, 'trader model call failed');
      this.record({ ts: now, kind: 'error', instId, triggers, dossier, error });
      this.lastDecision = { ts: bar, decision: null, verdict: error, executed: false, usage: null, triggers, error };
      // asked again in half an hour; the wake levels are dropped so that a failing model is not called at every tick
      coin.wake = { at: bar + 30 * 60_000, above: null, below: null, setAt: bar };
      return;
    }
    this.addUsage(answer.usage);
    const decision = answer.decision;
    coin.wake = wakeOf(decision, bar, { min: this.rules.recheckMinMinutes, max: this.rules.recheckMaxMinutes });
    let verdictText = answer.problem ?? 'no decision';
    let executed = false;
    if (decision) {
      // judged on the mark of this moment: the dossier's is as old as the model's thinking
      const mark = this.mark(instId) ?? dossier.mark;
      const verdict = checkLeaderDecision(decision, { mark, equity, coin: this.coinView(coin, mark), exposure: this.exposure(), atr, inst: this.deps.market.requireInstrument(instId), rules: this.rules, blocked: this.buyBlocked(coin) });
      if (!verdict.ok) verdictText = `not carried out: ${verdict.reason}`;
      else {
        try {
          const outcome = await this.execute(coin, verdict, mark, now);
          executed = outcome.executed;
          verdictText = outcome.note;
        } catch (err) {
          verdictText = `execution failed: ${(err as Error).message}`;
          this.log.error({ instId, err: (err as Error).message, action: verdict.action }, 'trader execution failed');
        }
      }
    }
    if (decision) coin.recentDecisions = [{ ts: bar, triggers, action: decision.action, oneLiner: decision.oneLiner, invalidation: decision.invalidation, wakeAbove: coin.wake.above, wakeBelow: coin.wake.below, verdict: verdictText }, ...coin.recentDecisions].slice(0, 5);
    this.record({ ts: now, kind: 'decision', instId, triggers, dossier, decision, verdict: verdictText, usage: answer.usage });
    this.lastDecision = { ts: bar, decision, verdict: verdictText, executed, usage: answer.usage, triggers, error: answer.problem };
    this.log.info({ instId, action: decision?.action ?? null, verdict: verdictText, executed, tokens: answer.usage.inputTokens + answer.usage.outputTokens, ms: answer.usage.ms }, 'trader decision (lead-trader style)');
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
    const rec = readTraderLog(this.config.logFile, 50).records.find((r) => r.kind === 'decision');
    if (!rec) return;
    const verdict = rec.verdict ?? '';
    this.lastDecision = { ts: rec.ts, decision: rec.decision ?? null, verdict, executed: /^(lot \d+:|\d+ lots?,)/.test(verdict), usage: rec.usage ?? null, triggers: rec.triggers ?? [], error: null };
  }

  /** Why nothing may be bought on the coin now; null when a lot may. */
  private buyBlocked(coin: LeaderCoinState): string | null {
    if (this.state.halted !== null) return `the trader has stopped: ${this.state.halted}`;
    if (this.deps.risk.state.killSwitch) return 'the kill switch is on';
    if (this.foreignPosition(coin)) return 'the exchange holds a position of the coin the trader did not open';
    if (coin.closing !== null) return 'the coin is being sold';
    return null;
  }

  private async execute(coin: LeaderCoinState, verdict: LeaderVerdict & { ok: true }, mark: string, now: number): Promise<{ executed: boolean; note: string }> {
    const { instId } = coin;
    if (verdict.action === 'hold') return { executed: false, note: 'hold' };
    const inst = this.deps.market.requireInstrument(instId);
    const notionalOf = (contracts: string, px: string): string => D(contracts).mul(inst.ctVal).mul(px).toDecimalPlaces(2).toFixed();
    if (verdict.action === 'sell') {
      const live = this.livePosition(instId);
      if (!live) return { executed: false, note: 'the position is already gone' };
      await this.deps.orders.closePosition({ instId, mgnMode: 'cross' });
      coin.closing = 'close';
      const contracts = D(live.pos).abs().toFixed();
      this.record({ ts: now, kind: 'execution', instId, lot: { clOrdId: '', side: 'sell', contracts, px: mark, lots: coin.lots.length, notional: notionalOf(contracts, mark) } });
      return { executed: true, note: `${coin.lots.length} lots, ${contracts} contracts, sold at the market (mark ${mark})` };
    }
    // buy: one lot at the market, cross margin, no stop
    const before = this.livePosition(instId);
    const clOrdId = generateClOrdId(now, CL_ORD_PREFIXES.trader);
    const req: PlaceOrderRequest = { instId, side: 'buy', ordType: 'market', tdMode: 'cross', size: { unit: 'contracts', value: verdict.contracts }, clOrdId };
    const { order } = await this.deps.orders.place(req);
    // Booked at the fill: the order's average, or the lot's share of the position's average once the exchange reports
    // the larger position; the mark stands in when neither has come within two seconds.
    let px = order.avgPx;
    for (let i = 0; px === '' && i < 20; i++) {
      await this.sleep(100);
      const live = this.livePosition(instId);
      if (!live || live.avgPx === '') continue;
      const prevQty = before ? D(before.pos).abs() : ZERO;
      const prevAvg = before && before.avgPx !== '' ? D(before.avgPx) : ZERO;
      const qty = D(live.pos).abs();
      if (qty.gt(prevQty)) px = D(live.avgPx).mul(qty).minus(prevAvg.mul(prevQty)).div(qty.minus(prevQty)).toDecimalPlaces(8).toFixed();
    }
    const filled = px !== '';
    if (!filled) {
      px = mark;
      this.log.warn({ instId, clOrdId, contracts: verdict.contracts, mark }, 'no fill reported within two seconds of the market order: the lot is booked at the mark');
    }
    coin.lots.push({ contracts: verdict.contracts, entryPx: px, openedAt: now, clOrdId });
    this.state.lotsToday += 1;
    this.record({ ts: now, kind: 'execution', instId, lot: { clOrdId, side: 'buy', contracts: verdict.contracts, px, lots: coin.lots.length, notional: notionalOf(verdict.contracts, px) } });
    return { executed: true, note: `lot ${coin.lots.length}: ${verdict.contracts} contracts bought at ${px}${filled ? '' : ' (the mark: no fill reported within 2 s)'}, ${notionalOf(verdict.contracts, px)} USDT` };
  }

  // ---- the positions on the exchange ----

  /**
   * A coin whose lots are gone from the exchange is a result: the lots against the mark, less the taker fee on both
   * legs, ended by the model's sale, the breaker, or an outside event (a close by hand). True when something changed.
   */
  private async reconcile(coin: LeaderCoinState, bar: number, now: number): Promise<boolean> {
    const { instId } = coin;
    const live = this.livePosition(instId);
    const first = coin.lots[0];
    if (first !== undefined && !live) {
      const inst = this.deps.market.requireInstrument(instId);
      const contracts = coin.lots.reduce((s, l) => s.plus(l.contracts), ZERO);
      const cost = coin.lots.reduce((s, l) => s.plus(D(l.contracts).mul(l.entryPx)), ZERO);
      const avg = cost.div(contracts);
      const mark = this.mark(instId) ?? avg.toFixed();
      // shortcut: the funding paid or received on the lots is not in the result (the journal has the exact trade), upgrade when the record is compared with the journal
      const gross = D(mark).minus(avg).mul(contracts).mul(inst.ctVal);
      const fees = cost.plus(D(mark).mul(contracts)).mul(inst.ctVal).mul(TRADER_TAKER_FEE);
      const pnl = gross.minus(fees);
      const result: TraderTradeResult = { side: 'long', openedAt: first.openedAt, closedAt: bar, entryPx: avg.toDecimalPlaces(2).toFixed(), exitPx: mark, contracts: contracts.toFixed(), pnl: money(pnl), end: coin.closing ?? 'external', instId };
      this.state.recent = [result, ...this.state.recent].slice(0, RECENT_KEPT);
      this.state.pnlToday = money(D(this.state.pnlToday).plus(pnl));
      this.log.info({ instId, lots: coin.lots.length, pnl: result.pnl, end: result.end }, 'trader ladder ended');
      coin.lots = [];
      coin.closing = null;
      this.record({ ts: now, kind: 'result', instId, result });
      return true;
    }
    if (first !== undefined && live) {
      const sum = coin.lots.reduce((s, l) => s.plus(l.contracts), ZERO);
      const held = D(live.pos).abs();
      const key = `${held.toFixed()}/${sum.toFixed()}`;
      if (!held.eq(sum) && this.mismatchWarned.get(instId) !== key) {
        this.mismatchWarned.set(instId, key);
        this.log.warn({ instId, exchange: held.toFixed(), lots: sum.toFixed() }, 'the exchange holds a different size than the lots say: the exchange counts for the exposure, the lots for the spacing');
      }
    }
    return false;
  }

  /**
   * The breaker (the owner, 2026-11-08): the equity at or under (1 - breakerPct) of the start sells every position and
   * stops the trader for good. A close that failed is tried again at every look while the trader is halted.
   */
  private async breaker(now: number, equity: string): Promise<void> {
    const start = this.state.startEquity;
    if (start === null) return;
    const floor = D(start).mul(D(1).minus(this.rules.breakerPct));
    if (this.state.halted === null) {
      if (D(equity).gt(floor)) return;
      this.state.halted = `the equity ${equity} fell to ${floor.toFixed(2)} or under, ${D(1).minus(this.rules.breakerPct).mul(100).toFixed()}% of the start ${start}: every position is sold and the trader has stopped (the owner, 2026-11-08). Move the state file away to begin a new record`;
      this.record({ ts: now, kind: 'error', instId: LEADER_INSTRUMENTS.join(','), error: this.state.halted });
      this.log.error({ equity, floor: floor.toFixed(2), start }, 'trader breaker: everything is sold, the trader has stopped');
    }
    for (const coin of this.state.coins) {
      if (!this.livePosition(coin.instId) || coin.closing === 'breaker') continue;
      try {
        await this.deps.orders.closePosition({ instId: coin.instId, mgnMode: 'cross' });
        coin.closing = 'breaker';
      } catch (err) {
        this.log.error({ instId: coin.instId, err: (err as Error).message }, 'the breaker could not close the position; tried again at the next look');
      }
    }
  }

  private livePosition(instId: string): Position | null {
    return this.deps.account.positionList().find((p) => p.instId === instId && !D(p.pos || '0').isZero()) ?? null;
  }

  /** A position on the coin that the trader holds no lot of: someone else's. */
  private foreignPosition(coin: LeaderCoinState): boolean {
    return coin.lots.length === 0 && this.livePosition(coin.instId) !== null;
  }

  private mark(instId: string): string | null {
    return this.deps.market.liveMarkPrice(instId) ?? this.deps.market.refPrice(instId) ?? null;
  }

  /** Every position of the traded coins at the marks, in USDT. */
  private exposure(): string {
    let total = ZERO;
    for (const coin of this.state.coins) {
      const live = this.livePosition(coin.instId);
      const mark = this.mark(coin.instId) ?? live?.markPx ?? null;
      if (!live || mark === null || mark === '') continue;
      total = total.plus(D(live.pos).abs().mul(this.deps.market.requireInstrument(coin.instId).ctVal).mul(mark));
    }
    return total.toDecimalPlaces(2).toFixed();
  }

  private coinView(coin: LeaderCoinState, mark: string | null): LeaderCoinView {
    const live = this.livePosition(coin.instId);
    const sum = coin.lots.reduce((s, l) => s.plus(l.contracts), ZERO);
    const contracts = live ? D(live.pos).abs() : sum;
    const cost = coin.lots.reduce((s, l) => s.plus(D(l.contracts).mul(l.entryPx)), ZERO);
    const last = coin.lots[coin.lots.length - 1];
    const px = mark ?? (live && live.markPx !== '' ? live.markPx : null);
    const atr = this.atrSeen.get(coin.instId) ?? null;
    const ctVal = this.deps.market.requireInstrument(coin.instId).ctVal;
    return {
      instId: coin.instId,
      // a copy: the dossier is logged after the execution, and must show the lots the model saw
      lots: coin.lots.map((l) => ({ ...l })),
      contracts: contracts.toFixed(),
      avgPx: live && live.avgPx !== '' ? live.avgPx : sum.gt(0) ? cost.div(sum).toDecimalPlaces(2).toFixed() : null,
      lastLotPx: last?.entryPx ?? null,
      notional: px === null ? '0' : contracts.mul(ctVal).mul(px).toDecimalPlaces(2).toFixed(),
      unrealizedPnl: live && live.upl !== '' ? live.upl : null,
      atr,
      nextAddBelow: last !== undefined && atr !== null ? D(last.entryPx).minus(D(atr).mul(this.rules.addAtr)).toFixed() : null,
      wake: coin.wake,
    };
  }

  private leaderInfo(equity: string): LeaderInfo {
    const start = this.state.startEquity ?? equity;
    const exposure = this.exposure();
    return {
      rules: this.rules,
      startEquity: start,
      breakerEquity: D(start).mul(D(1).minus(this.rules.breakerPct)).toDecimalPlaces(2).toFixed(),
      exposure,
      exposurePct: D(equity).gt(0) ? D(exposure).div(equity).toDecimalPlaces(4).toFixed() : '0',
      halted: this.state.halted,
      coins: this.state.coins.map((c) => this.coinView(c, this.mark(c.instId))),
    };
  }

  private leaderDossier(coin: LeaderCoinState, equity: string, mark: string): LeaderDossier {
    const info = this.leaderInfo(equity);
    const view = this.coinView(coin, mark);
    const inst = this.deps.market.requireInstrument(coin.instId);
    const probe: LeaderDecision = { action: 'buy', confidence: 0, reasons: [], invalidation: '', oneLiner: '', recheckMinutes: 0, wakeAbove: null, wakeBelow: null };
    const verdict = checkLeaderDecision(probe, { mark, equity, coin: view, exposure: info.exposure, atr: view.atr, inst, rules: this.rules, blocked: this.buyBlocked(coin) });
    return { ...info, coin: view, lotNow: leaderLotSize(equity, mark, inst, this.rules), buyRefused: verdict.ok ? null : verdict.reason };
  }

  // ---- the account ----

  private equity(): string | null {
    const eq = this.deps.account.balance?.totalEq;
    return eq !== undefined && eq !== '' ? eq : null;
  }

  private accountInfo(equity: string): TraderAccountInfo {
    return { equity, position: null, tradesToday: this.state.lotsToday, pnlToday: this.state.pnlToday, consecutiveLosses: 0, cooldownUntil: null, killSwitch: this.deps.risk.state.killSwitch };
  }

  private calendarFor(ts: number): string[] {
    const date = utcDate(ts);
    return this.config.calendar.filter((e) => e.date === date).map((e) => e.name);
  }

  private rollDay(now: number): void {
    const date = utcDate(now);
    if (this.state.date === date) return;
    this.state = { ...this.state, date, lotsToday: 0, pnlToday: '0', usage: { date, calls: 0, inputTokens: 0, outputTokens: 0, cacheReadTokens: 0 } };
    this.save();
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
    return readTraderLog(this.config.logFile, limit);
  }

  /** For tests */
  stateCopy(): LeaderState {
    return structuredClone(this.state);
  }

  // ---- what the service shows ----

  private status(): { status: TraderStatus; reason: TraderStatusReason | null } {
    if (this.stateError !== null) return { status: 'blocked', reason: { code: 'STATE_UNREADABLE', message: `${this.stateError}: the trader does not trade until the file is repaired or moved away` } };
    if (this.model === null) return { status: 'blocked', reason: { code: 'NO_MODEL_CREDENTIALS', message: 'no ANTHROPIC_API_KEY in the environment: put one in .env and restart the stack' } };
    if (!this.deps.account.ready || this.equity() === null) return { status: 'blocked', reason: { code: 'ACCOUNT_UNAVAILABLE', message: 'the paper account has not been read yet' } };
    if (this.state.halted !== null) return { status: 'blocked', reason: { code: 'BREAKER', message: this.state.halted } };
    const foreign = this.state.coins.filter((c) => this.foreignPosition(c)).map((c) => c.instId);
    if (foreign.length > 0) return { status: 'blocked', reason: { code: 'FOREIGN_POSITION', message: `the paper account holds a position of ${foreign.join(', ')} that the trader did not open: it asks nothing about that coin and buys nothing until that position is closed` } };
    if (this.state.coins.some((c) => c.lots.length > 0)) return { status: 'holding', reason: null };
    return { status: 'in-session', reason: null };
  }

  /** The next instant the model is called at the latest: the next daily close, or a coin's recheck time if earlier. */
  nextCallAt(now: number): number {
    const nextFifteen = Math.floor(now / FIFTEEN_MS) * FIFTEEN_MS + FIFTEEN_MS;
    const nextDaily = Math.floor(now / DAY_MS) * DAY_MS + DAY_MS;
    const wakes = this.state.coins.map((c) => c.wake?.at ?? null).filter((t): t is number => t !== null).map((t) => Math.max(t, nextFifteen));
    return Math.min(nextDaily, ...wakes);
  }

  view(): TraderView {
    const now = this.now();
    const { status, reason } = this.status();
    const equity = this.equity();
    const usage = this.state.usage;
    const upcoming = (this.lastMacro?.calendar ?? []).filter((e) => e.time >= now).slice(0, 6);
    const wakes = this.state.coins.map((c) => c.wake).filter((w): w is TraderWake => w !== null).sort((a, b) => a.at - b.at);
    return {
      enabled: true,
      style: 'leader',
      ...(equity === null ? {} : { leader: this.leaderInfo(equity) }),
      cadence: 'model',
      wake: wakes[0] ?? null,
      upcoming,
      status,
      reason,
      instId: LEADER_INSTRUMENTS.join(', '),
      session: { startHour: 0, endHour: 24, inSession: true },
      guardrails: this.config.guardrails,
      model: this.model?.name ?? this.config.model,
      nextCallAt: status === 'blocked' ? null : this.nextCallAt(now),
      last: this.lastDecision,
      position: null,
      today: { date: this.state.date, trades: this.state.lotsToday, pnl: this.state.pnlToday, consecutiveLosses: 0, cooldownUntil: null, equityAtStart: this.state.startEquity },
      usageToday: { calls: usage.calls, inputTokens: usage.inputTokens, outputTokens: usage.outputTokens, estimatedUsd: estimateUsd(this.config.model, usage).toDecimalPlaces(4).toFixed() },
      control: null,
      recent: this.state.recent,
      serverTime: now,
    };
  }
}
