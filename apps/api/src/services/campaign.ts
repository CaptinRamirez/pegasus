import { EventEmitter } from 'node:events';
import type { PotReplayInput } from '@pegasus/backtest/campaign';
import { OkxApiError, OkxTransportError } from '@pegasus/okx';
import {
  contractsToCoin,
  D,
  Decimal,
  DEFAULT_CAMPAIGN_PARAMS,
  DEFAULT_POT_PARAMS,
  isLiquidationOrder,
  positionDirection,
  potFinished,
  potRungLevel,
  ZERO,
  type CampaignBankingRecord,
  type CampaignEndRecord,
  type CampaignErrorRecord,
  type CampaignFillRecord,
  type CampaignLogPage,
  type CampaignParams,
  type CampaignParamsView,
  type CampaignPositionView,
  type CampaignRecord,
  type CampaignRecordView,
  type CampaignReplayView,
  type CampaignServiceStatus,
  type CampaignStatusReason,
  type CampaignStepAction,
  type CampaignStepLog,
  type CampaignView,
  type Candle,
  type Instrument,
  type Order,
  type Position,
  type PosSide,
  type PotParams,
} from '@pegasus/shared';
import type { CampaignConfig } from '../config.js';
import { AppError, NotConnectedError } from '../errors.js';
import type { Logger } from '../logger.js';
import type { OkxClients } from '../okx/clients.js';
import { mapOrder, mapPosition } from '../okx/mappers.js';
import type { AccountService } from './account.js';
import { emptyLedger, loadLedger, saveLedger, type CampaignLedger } from './campaign-ledger.js';
import { CAMPAIGN_CL_ORD_PREFIX, type CampaignFill, type CampaignOrders } from './campaign-orders.js';
import { CampaignReplayService, type CampaignReplayOptions } from './campaign-replay.js';
import {
  afterSale,
  barsAt,
  closeAtOrBefore,
  closesAfter,
  DAY_MS,
  decideClose,
  HALF_DAY_MS,
  isDailyClose,
  positionEquity,
  resizeAddToSpare,
  sizeAdd,
  sizeEntry,
  walkMissedCloses,
  type CloseBars,
  type PlannedAction,
  type StepCampaign,
  type StepPosition,
} from './campaign-step.js';
import type { MarketDataService } from './market-data.js';
import type { RiskEngine } from './risk-engine.js';

/**
 * The campaign service: runs the campaign rule of packages/shared/src/campaign.ts on the paper exchange by itself, and
 * keeps the pot's ledger (campaign-ledger.ts). Started from index.ts only while CAMPAIGN_ENABLED=1, which the
 * configuration allows in paper trading only. The decisions are campaign-step.ts's, the orders campaign-orders.ts's.
 *
 * The live counterparts of the replay's timing rules (packages/backtest/src/campaign/engine.ts, C1-C13):
 *
 * C1.  Entry. Read at a 00:00 UTC close from the exchange's daily bar that closed then (OKX 1Dutc, confirmed) and the
 *      ones before it, and carried out right after the close by a market buy (openLong), not at the next bar's open.
 *      One campaign per instrument: an instrument whose campaign the exchange has liquidated before the step is free.
 * C2.  Size. campaignStake of the free cash left at that moment; the quantity at the open of the 12-hour bar running
 *      after the close, in whole lots; the margin is the notional at the book's estimated fill over the leverage
 *      (sizeEntry). A stake below the minimum stake or the minimum order is a skip. What the open took is measured
 *      from the available balance before and after it: that is the stake.
 * C3.  Inside a bar. The exchange liquidates by itself, on its mark price (a, e, g). The service carries out (b), (c),
 *      (d) after the close, in that order, then the entries.
 * C4.  Liquidation. The exchange's, on the mark price and its own maintenance tiers. It reaches the account service as
 *      an order of category full_liquidation, and the campaign is marked liquidated as soon as it does; at every step
 *      a campaign whose position is gone without a recorded close is classified from the exchange's order history:
 *      a liquidation, a close that was not the campaign's (its client order ids start with `pc`; the campaign ends
 *      `external`), or unknown (an execution error).
 * C5.  Exit. A daily close below the exit channel: closeLong right after the close. Retried with backoff while the
 *      failure is transient (the private stream down, the exchange unreachable), for up to 30 minutes; what the book
 *      did not fill is sold again, up to three orders at a step. One that is still not carried out is an execution
 *      error and is attempted again at every later step. What came back is measured from the balance.
 * C6.  Adds ('pyramid' only). A 12-hour close addStep above the reference: addLong (margin-neutral) right after the
 *      close. The quantity is the add unit cut by the campaign's cap and the exchange's (the instrument's maxLever)
 *      at the open of the running bar, as the replay does, and also by what the risk engine and the exchange accept
 *      at the live mark and book (sizeAdd); an add the exchange still refuses at its cap is sized once more from the
 *      margin it says the position can spare. The reference moves to the running bar's open at every close an add
 *      was due at: also when the caps left nothing, the kill switch held it, the close was missed or the add failed.
 * C7.  Funding. The exchange's real funding, charged by it to the isolated margin; it shows in the margin, the equity
 *      and the proceeds, and is not booked apart.
 * C8.  Holes. At each close the bars are polled until the one that closed is confirmed, a few seconds apart, for up to
 *      10 minutes; an instrument whose bar is still not confirmed then gives no signal at that close. A close the
 *      service could not process within those 10 minutes (it was not running, the account could not be read) is a
 *      missed close: see below.
 * C9.  The pot. At a close: the liquidations (reported, then reconciled), the ladder on the pot as marked at the
 *      exchange's mark, the harvest sales, the exits, the adds, then the entries in sameCloseOrder, each staking
 *      campaignStake of the free cash then measured. Free cash = the account's available USDT less the ledger's
 *      banked amount; pot value = free cash + the equity of the open campaigns at the mark. After every step, a pot
 *      that is potFinished is finished for good; nothing starts another one.
 * C10. The catalogue: the replay's only.
 * C11. Campaigns still open are shown at the mark, live.
 * C12. The pot's start: closes before it are not looked at.
 * C13. The ladder: planHarvest at every 12-hour close. What the free cash covers is banked at the close (a ledger
 *      entry: nothing is transferred on the paper exchange); the sales (reduceLong, harvestContracts of every open
 *      campaign) follow at once, and what each returns, measured from the balance, is banked. keptAfterHarvest then
 *      applies to the campaign's add unit and stake basis; its margin is the exchange's.
 *
 * Where live necessarily differs from the replay: the fills are market orders a few seconds after the close at the
 * book's prices, not the next bar's open with a modelled slippage; the exchange liquidates on its mark price with its
 * own tiers and fees, not on the 12-hour low; funding is the real one; an entry's margin is topped up after its buy
 * (campaign-orders.ts); a partial fill is what it is; and closes can be missed. Missed closes (walked at start and
 * at every step, from the ledger's last processed close): an exit signal at any of them is carried out now, late,
 * with the delay logged; adds and entries that were due are not carried out but logged as missed, and the add
 * reference moves as C6 says; the ladder is evaluated on the pot as it is now.
 *
 * The pot needs a paper account of its own: a new ledger starts the pot only on an account whose total equity is
 * within 1% of CAMPAIGN_POT_START and that has no position and no open order. Under the kill switch entries and adds
 * are skipped, exits and harvest sales go on. Execution errors are counted in the ledger exactly: an action the rule
 * decided that was not carried out as decided, or one that left a position in a state the rule does not have. Skips
 * the rule foresees and retries that succeeded are logged, not counted.
 *
 * Beside the pot the service keeps its replay (campaign-replay.ts): the backtest's replay of the pot from its start on
 * OKX's bars, with the other structure, the start value held in BTC and the ledger reconciled with it. It is computed
 * in the background after every step of a 00:00 UTC close, once at start when a pot exists and when the pot starts;
 * the view carries its summary (`replay`) and GET /api/campaign/replay the result.
 */

export interface CampaignCandleSource {
  /** 12-hour UTC bars (OKX 12Hutc), oldest first; the forming one may be included */
  halfDay(instId: string): Promise<Candle[]>;
  /** Daily UTC bars (OKX 1Dutc), oldest first; the forming one may be included */
  daily(instId: string): Promise<Candle[]>;
}

/** The exchange's bars through the market data service, which maps 12H and 1D to OKX's UTC-aligned ones. */
export function exchangeCandleSource(market: MarketDataService): CampaignCandleSource {
  return {
    halfDay: (instId) => market.fetchCandles(instId, '12H', 300),
    daily: (instId) => market.fetchCandles(instId, '1D', 300),
  };
}

export interface CampaignServiceDeps {
  clients: OkxClients;
  market: MarketDataService;
  account: AccountService;
  risk: RiskEngine;
  orders: CampaignOrders;
  log: Logger;
}

export interface CampaignServiceOptions {
  /** CAMPAIGN_STATE_FILE */
  ledgerFile: string;
  /** The rule; DEFAULT_CAMPAIGN_PARAMS with the settings' structure, leverage and fee rate when not given */
  params?: CampaignParams;
  /** The pot; DEFAULT_POT_PARAMS with the settings' start and minimum stake when not given */
  pot?: PotParams;
  /** The service's clock: the closes, the step times, the deadlines. Date.now by default */
  now?: () => number;
  sleep?: (ms: number) => Promise<void>;
  /** The exchange's bars by default */
  candles?: CampaignCandleSource;
  /** How often the clock is looked at for a close that is due; 0: never by itself (tick() is called). Default 15 s */
  checkEveryMs?: number;
  /** Interval of the bar polls while the bar that closed is not confirmed. Default 5 s */
  pollMs?: number;
  /** How long after a close its bars are waited for, and its adds and entries may still be carried out. Default 10 min */
  closeWindowMs?: number;
  /** How long exits and harvest sales are retried while their failure is transient. Default 30 min */
  exitRetryWindowMs?: number;
  /** Waits between the attempts of an action; the last one repeats. Default 2 s, 5 s, 10 s, 30 s, 60 s */
  retryDelaysMs?: readonly number[];
  /** The replay beside the pot (campaign-replay.ts): where its data comes from. Without it the replay is unavailable */
  replay?: CampaignReplayOptions;
}

interface AccountSnapshot {
  available: Decimal;
  totalEq: Decimal;
  /** Every non-flat SWAP position */
  positions: Position[];
  openOrders: number;
  /** The campaign's leg: net in net mode, long in long/short mode */
  posSide: PosSide;
}

/** Why a campaign's position is gone, from the exchange's order history. own: a close of the campaign's whose answer was lost. */
interface GoneReason {
  kind: 'liquidated' | 'external' | 'own' | 'unknown';
  order: Order | null;
}

class ServiceStopped extends Error {
  constructor() {
    super('the campaign service was stopped');
  }
}

/** A closing operation found the position already gone: the end the order history explains. */
class PositionGone extends Error {
  constructor(readonly reason: GoneReason) {
    super(`the position is gone (${reason.kind})`);
  }
}

const DEFAULT_RETRY_DELAYS_MS: readonly number[] = [2_000, 5_000, 10_000, 30_000, 60_000];
/** Orders of the exchange are compared with the wall clock this much earlier: the paper exchange runs on this machine, OKX's clock is close to it. */
const CLOCK_SKEW_MS = 60_000;
/** How close to CAMPAIGN_POT_START the account's equity must be for a new pot to start on it */
const POT_START_TOLERANCE = '0.01';
/** Orders an exit sends at one step while the book fills only part of each */
const EXIT_ORDERS = 3;
/** Failures after which nothing was done: the same call may be made again. */
const RETRYABLE = new Set(['NOT_CONNECTED', 'NO_PRICE', 'NO_BOOK', 'CAMPAIGN_BUSY', 'LEVERAGE_UNAVAILABLE', 'CAMPAIGN_BALANCE_UNKNOWN']);
/** Failures whose outcome is not known: a closing operation is retried only after the position was read again. */
const UNKNOWN_OUTCOME = new Set(['ORDER_STATUS_UNKNOWN', 'CAMPAIGN_ORDER_UNKNOWN']);

const money = (v: Decimal): string => v.toFixed();
const ratio = (v: Decimal): string => v.toSignificantDigits(15).toFixed();
const iso = (t: number): string => new Date(t).toISOString();

function errorCode(err: unknown): string {
  if (err instanceof AppError) return err.code;
  if (err instanceof OkxApiError) return 'EXCHANGE';
  if (err instanceof OkxTransportError) return 'EXCHANGE_UNREACHABLE';
  return 'INTERNAL';
}

function errorDetails(err: unknown): Record<string, unknown> {
  if (err instanceof AppError) return err.details ?? {};
  if (err instanceof OkxApiError) return { okxCode: err.code, okxMsg: err.okxMessage };
  if (err instanceof OkxTransportError) return { timedOut: err.timedOut };
  return {};
}

/** A failure that leaves the operation free to be made again: nothing reached the exchange, or it refused for a passing reason. */
function isTransient(err: unknown): boolean {
  if (err instanceof AppError) {
    if (RETRYABLE.has(err.code)) return true;
    if (err.code === 'EXCHANGE_UNREACHABLE') return err.details?.['timedOut'] !== true;
    if (err.code === 'EXCHANGE') {
      const code = String(err.details?.['okxCode'] ?? '');
      return err.status === 429 || (/^500\d\d$/.test(code) && code !== '50004');
    }
    return false;
  }
  if (err instanceof OkxTransportError) return !err.timedOut;
  if (err instanceof OkxApiError) return err.isRateLimited || (/^500\d\d$/.test(err.code) && !err.isOutcomeUnknown);
  return false;
}

/** A failure after which the operation may or may not have been carried out. */
function isOutcomeUnknown(err: unknown): boolean {
  if (err instanceof AppError) return UNKNOWN_OUTCOME.has(err.code) || (err.code === 'EXCHANGE_UNREACHABLE' && err.details?.['timedOut'] === true) || (err.code === 'EXCHANGE' && ['50004', '51149'].includes(String(err.details?.['okxCode'] ?? '')));
  if (err instanceof OkxTransportError) return err.timedOut;
  return err instanceof OkxApiError && err.isOutcomeUnknown;
}

/** The risk engine refused because the kill switch is on: a skip the rule foresees, not an error. */
function isKillSwitchRefusal(err: unknown): boolean {
  return err instanceof AppError && err.code === 'RISK_REJECTED' && err.details?.['code'] === 'KILL_SWITCH';
}

/** Details as JSON holds them. */
function plainDetails(details: Record<string, unknown>): Record<string, unknown> {
  try {
    return JSON.parse(JSON.stringify(details)) as Record<string, unknown>;
  } catch {
    return {};
  }
}

/** The rule as the settings give it. */
function settingsParams(config: CampaignConfig): CampaignParams {
  return { ...DEFAULT_CAMPAIGN_PARAMS, structure: config.structure, leverage: config.leverage, feeRate: config.feeRate };
}

function settingsPot(config: CampaignConfig): PotParams {
  return { ...DEFAULT_POT_PARAMS, start: config.potStart, minStake: config.minStake };
}

function paramsView(instruments: string[], params: CampaignParams, pot: PotParams): CampaignParamsView {
  return {
    instruments,
    potStart: pot.start,
    minStake: pot.minStake,
    structure: params.structure,
    leverage: params.leverage,
    feeRate: params.feeRate,
    addStep: params.addStep,
    entryChannel: params.entryChannel,
    exitChannel: params.exitChannel,
    stakeFraction: pot.stakeFraction,
    rungFactor: pot.rungFactor,
    bankFraction: pot.bankFraction,
  };
}

/** GET /api/campaign while CAMPAIGN_ENABLED is not 1. */
export function disabledCampaignView(config: CampaignConfig, now = Date.now()): CampaignView {
  return {
    status: 'disabled',
    reason: { code: 'CAMPAIGN_DISABLED', message: 'the campaign is not enabled (CAMPAIGN_ENABLED=1, paper trading only)' },
    params: paramsView(config.instruments, settingsParams(config), settingsPot(config)),
    pot: null,
    campaigns: [],
    bankings: [],
    samples: [],
    errorCount: 0,
    errors: [],
    missedCloses: 0,
    foreign: [],
    lastStep: null,
    nextStep: null,
    replay: null,
    serverTime: now,
  };
}

export class CampaignService extends EventEmitter<{ change: [CampaignView] }> {
  private ledger: CampaignLedger = emptyLedger();
  /** Set when the ledger file cannot be trusted: nothing is traded or written */
  private ledgerError: string | null = null;
  /** Why the pot has not started */
  private blocked: CampaignStatusReason = { code: 'ACCOUNT_UNAVAILABLE', message: 'the paper account has not been read yet' };
  /** Why the account could not be read at the last attempt; null once it could */
  private unavailable: string | null = null;
  private running: Promise<void> | null = null;
  /** The step in progress */
  private current: CampaignStepLog | null = null;
  private stopped = false;
  private timer: NodeJS.Timeout | null = null;
  private readonly stopSignal: Promise<void>;
  private resolveStop: () => void = () => undefined;
  private readonly log: Logger;
  private readonly baseParams: CampaignParams;
  private readonly basePot: PotParams;
  private readonly now: () => number;
  private readonly sleep: (ms: number) => Promise<void>;
  private readonly candles: CampaignCandleSource;
  private readonly checkEveryMs: number;
  private readonly pollMs: number;
  private readonly closeWindowMs: number;
  private readonly exitRetryWindowMs: number;
  private readonly retryDelaysMs: readonly number[];
  /** The replay beside the pot, computed in the background */
  private readonly replay: CampaignReplayService;
  private readonly onOrder = (order: Order): void => this.noteLiquidation(order);

  constructor(
    private readonly config: CampaignConfig,
    private readonly deps: CampaignServiceDeps,
    private readonly opts: CampaignServiceOptions,
  ) {
    super();
    this.log = deps.log.child({ component: 'campaign' });
    this.baseParams = opts.params ?? settingsParams(config);
    this.basePot = opts.pot ?? settingsPot(config);
    this.now = opts.now ?? Date.now;
    this.sleep = opts.sleep ?? ((ms) => new Promise((resolve) => setTimeout(resolve, ms).unref()));
    this.candles = opts.candles ?? exchangeCandleSource(deps.market);
    this.checkEveryMs = opts.checkEveryMs ?? 15_000;
    this.pollMs = opts.pollMs ?? 5_000;
    this.closeWindowMs = opts.closeWindowMs ?? 10 * 60_000;
    this.exitRetryWindowMs = opts.exitRetryWindowMs ?? 30 * 60_000;
    this.retryDelaysMs = opts.retryDelaysMs ?? DEFAULT_RETRY_DELAYS_MS;
    this.stopSignal = new Promise((resolve) => {
      this.resolveStop = resolve;
    });
    this.replay = new CampaignReplayService({ unavailable: () => this.replayUnavailable(), input: () => this.replayInput() }, opts.replay ?? null, this.log, this.now);
    // Its summary is part of the view: a change of it reaches the terminals like a change of the ledger.
    this.replay.on('change', () => this.emitChange());
  }

  // ---- life cycle ----

  /** Loads the ledger, starts the pot or catches up with the closes missed, then looks at the clock every checkEveryMs. */
  async start(): Promise<void> {
    const loaded = loadLedger(this.opts.ledgerFile);
    if (!loaded.ok) {
      this.ledgerError = loaded.error;
      this.log.error({ file: this.opts.ledgerFile, err: loaded.error }, 'campaign ledger unreadable: the campaign does not trade; repair or move the file away (a copy is kept as .corrupt)');
      this.emitChange();
      return;
    }
    this.ledger = loaded.ledger;
    const pot = this.ledger.pot;
    if (pot) {
      this.log.info({ file: this.opts.ledgerFile, startedAt: iso(pot.startedAt), open: this.openCampaigns().length, banked: pot.banked, rungs: pot.rungs, lastClose: this.ledger.lastClose === null ? null : iso(this.ledger.lastClose), errors: this.ledger.errorCount }, 'campaign ledger loaded');
      if (pot.structure !== this.baseParams.structure) this.log.warn({ pot: pot.structure, setting: this.baseParams.structure }, 'the pot runs the structure it was started with; CAMPAIGN_STRUCTURE applies to a new pot only');
    }
    for (const id of this.config.instruments) {
      const inst = this.deps.market.getInstrument(id);
      if (!inst) this.log.warn({ instId: id }, 'campaign instrument not tracked: left out');
      else if (D(inst.maxLever).lt(this.rule().leverage)) this.log.warn({ instId: id, maxLever: inst.maxLever }, `left out: the exchange offers ${inst.maxLever}x at most and the rule takes ${this.rule().leverage}x`);
    }
    for (const c of this.openCampaigns()) {
      if (!this.config.instruments.includes(c.instId)) this.log.warn({ instId: c.instId, campaign: c.id }, 'an open campaign is on an instrument CAMPAIGN_INSTRUMENTS no longer lists: it is not traded until it is listed again');
    }
    this.deps.account.on('order', this.onOrder);
    this.emitChange();
    const existed = this.ledger.pot !== null;
    await this.tick();
    // Once at start when a pot exists, after the closes missed meanwhile (a step of a daily close asks for it itself).
    if (existed) this.replay.refresh(false);
    if (this.checkEveryMs > 0 && !this.stopped && this.ledger.pot?.finishedAt == null) {
      this.timer = setInterval(() => void this.tick(), this.checkEveryMs);
      this.timer.unref();
    }
  }

  /** Stops looking at the clock; a step in progress ends at its next wait. */
  async stop(): Promise<void> {
    this.stopped = true;
    this.replay.stop();
    this.resolveStop();
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
    this.deps.account.off('order', this.onOrder);
    await this.running;
  }

  /** Processes what is due: starts the pot, catches up with missed closes, processes a close that has come. */
  async tick(): Promise<void> {
    if (this.running || this.stopped || this.ledgerError !== null) return;
    const run = this.advance()
      .catch((err: unknown) => this.log.error({ err }, 'campaign step failed unexpectedly'))
      .finally(() => {
        this.running = null;
      });
    this.running = run;
    await run;
  }

  /** A copy of the ledger as it is now. */
  ledgerCopy(): CampaignLedger {
    return JSON.parse(JSON.stringify(this.ledger)) as CampaignLedger;
  }

  private async advance(): Promise<void> {
    if (!this.ledger.pot) {
      await this.tryStart();
      if (!this.ledger.pot) return;
    }
    const pot = this.ledger.pot;
    if (pot.finishedAt !== null) return;
    const now = this.now();
    const due = closesAfter(this.ledger.lastClose ?? closeAtOrBefore(pot.startedAt), now);
    const last = due[due.length - 1];
    if (last === undefined) return;
    // A close is processed as it comes while its window is open; past it, it is a missed close.
    const live = now < last + this.closeWindowMs ? last : null;
    const missed = live === null ? due : due.slice(0, -1);
    if (missed.length > 0 && !(await this.catchUp(missed))) return;
    if (live !== null && !this.stopped) await this.processClose(live);
  }

  /** A new pot starts on a paper account of its own only (see the header). */
  private async tryStart(): Promise<void> {
    let snap: AccountSnapshot;
    try {
      snap = await this.readAccount(true);
    } catch (err) {
      this.setBlocked({ code: 'ACCOUNT_UNAVAILABLE', message: `the paper account could not be read: ${(err as Error).message}` });
      return;
    }
    const start = D(this.basePot.start);
    const problems: string[] = [];
    if (snap.totalEq.minus(start).abs().gt(start.mul(POT_START_TOLERANCE))) problems.push(`its total equity is ${snap.totalEq.toFixed()} USDT, the pot starts with ${start.toFixed()} (within 1%)`);
    if (snap.positions.length > 0) problems.push(`it holds ${snap.positions.length} position(s)`);
    if (snap.openOrders > 0) problems.push(`it has ${snap.openOrders} open order(s)`);
    if (problems.length > 0) {
      this.setBlocked({
        code: 'ACCOUNT_NOT_DEDICATED',
        message: `the pot needs a paper account of its own and this one is not: ${problems.join('; ')}. Run the campaign on its own paper account: start the paper exchange with a new PAPER_STATE_FILE and PAPER_BALANCE=${start.toFixed()} (and give the campaign its own CAMPAIGN_STATE_FILE)`,
      });
      return;
    }
    const now = this.now();
    this.ledger.pot = {
      startedAt: now,
      startValue: money(snap.totalEq),
      btcMarkAtStart: await this.btcMark(),
      structure: this.baseParams.structure,
      start: this.basePot.start,
      minStake: this.basePot.minStake,
      banked: '0',
      rungs: 0,
      peak: null,
      finishedAt: null,
    };
    this.ledger.lastClose = closeAtOrBefore(now);
    this.log.info({ value: this.ledger.pot.startValue, btcMark: this.ledger.pot.btcMarkAtStart, structure: this.ledger.pot.structure, instruments: this.tradedInstruments().map((i) => i.instId) }, 'campaign pot started');
    this.changed();
    this.replay.refresh();
  }

  private setBlocked(reason: CampaignStatusReason): void {
    const changed = reason.code !== this.blocked.code || reason.message !== this.blocked.message;
    this.blocked = reason;
    if (!changed) return;
    this.log.warn({ code: reason.code }, `campaign blocked: ${reason.message}`);
    this.emitChange();
  }

  private async btcMark(): Promise<string> {
    try {
      const [mark] = await this.deps.clients.rest.getMarkPrice('SWAP', 'BTC-USDT-SWAP');
      return mark?.markPx ?? '';
    } catch (err) {
      this.log.warn({ err: (err as Error).message }, 'the mark price of BTC-USDT-SWAP could not be read at the start of the pot');
      return '';
    }
  }

  // ---- steps ----

  /** The closes the service did not process in time (see the header). False when the account could not be read: tried again at the next tick. */
  private async catchUp(closes: number[]): Promise<boolean> {
    const snap = await this.tryReadAccount();
    if (!snap) return false;
    const first = closes[0] as number;
    const last = closes[closes.length - 1] as number;
    const step = this.beginStep('catch-up', closes);
    let freeCash: Decimal | null = null;
    try {
      step.notes.push(`${closes.length} close(s) from ${iso(first)} to ${iso(last)} were not processed in time: exits are carried out now, adds and entries are not`);
      this.log.warn({ closes: closes.length, from: iso(first), to: iso(last) }, 'campaign: closes missed; exits are carried out late, adds and entries are not');
      await this.reconcile(step, snap, last);
      const bars = await this.historyBars(step);
      const open = this.openCampaigns();
      const walk = walkMissedCloses(
        closes,
        open.map((c) => ({ id: c.id, instId: c.instId, addRef: c.addRef, exiting: c.pendingExit !== null })),
        bars,
        this.rule(),
      );
      step.inputs.push(...walk.inputs);
      for (const m of walk.missed) this.act(step, { kind: m.kind, closeTs: m.closeTs, instId: m.instId, campaignId: m.campaignId, plan: m.plan, outcome: 'missed', reason: 'missed-close' });
      for (const c of open) c.addRef = walk.addRefs.get(c.id) ?? c.addRef;
      for (const e of walk.exits) {
        const c = this.campaign(e.campaignId);
        if (c && c.end === null && c.pendingExit === null) c.pendingExit = { closeTs: e.closeTs, signalTs: e.signalTs };
      }
      this.ledger.missedCloses += closes.length;
      this.changed();
      // Without the bars of a close processed in time nothing new is decided: the ladder, the sales and the exits.
      await this.decideAndAct(step, last, snap, new Map(), last + this.closeWindowMs);
      freeCash = await this.sampleFreeCash(step, null);
      this.ledger.lastClose = last;
    } catch (err) {
      if (!(err instanceof ServiceStopped)) {
        this.recordError(step, null, null, 'step', err);
        this.ledger.lastClose = last;
      } else step.notes.push('stopped before the step was complete');
    } finally {
      if (freeCash !== null) this.checkFinished(freeCash);
      this.endStep(step);
    }
    return true;
  }

  /** A close processed as it comes (C9). */
  private async processClose(closeTs: number): Promise<void> {
    const deadline = closeTs + this.closeWindowMs;
    const bars = await this.awaitBars(closeTs, deadline);
    if (this.stopped) return;
    const snap = await this.tryReadAccount();
    // Tried again at the next tick; past its window the close is a missed one.
    if (!snap) return;
    const step = this.beginStep('close', [closeTs]);
    let freeCash: Decimal | null = null;
    try {
      step.inputs.push(...[...bars.values()].map((b) => b.input));
      const fresh = await this.reconcile(step, snap, closeTs);
      await this.decideAndAct(step, closeTs, fresh, bars, deadline);
      freeCash = await this.sampleFreeCash(step, closeTs);
      this.ledger.lastClose = closeTs;
    } catch (err) {
      if (!(err instanceof ServiceStopped)) {
        // Counted once; the close is not processed again.
        this.recordError(step, null, null, 'step', err);
        this.ledger.lastClose = closeTs;
      } else step.notes.push('stopped before the step was complete');
    } finally {
      if (freeCash !== null) this.checkFinished(freeCash);
      this.endStep(step);
    }
  }

  /**
   * C9 from the ladder on, at `closeTs`, on the account as `snap` shows it after the reconcile: the ladder, the
   * sales, the exits (the ones decided earlier included) and, with the bars of a close processed in time, the adds
   * and the entries. Without bars (a catch-up) nothing new is decided but the ladder.
   */
  private async decideAndAct(step: CampaignStepLog, closeTs: number, snap: AccountSnapshot, bars: Map<string, CloseBars>, deadline: number): Promise<void> {
    const pot = this.requirePot();
    const open = this.openCampaigns();
    const campaigns: StepCampaign[] = [];
    const unresolved = new Set<string>();
    for (const c of open) {
      const p = this.positionOf(snap, c.instId);
      if (p) campaigns.push({ id: c.id, instId: c.instId, addRef: c.addRef, addUnit: c.addUnit, pendingExit: c.pendingExit !== null, position: this.stepPosition(p) });
      else unresolved.add(c.instId);
    }
    const instruments = this.instrumentsWith(open).map((inst) => ({ inst, bars: bars.get(inst.instId) ?? barsAt(inst.instId, [], [], closeTs, this.rule()) }));
    const foreign = new Set(this.foreignPositions(snap).map((p) => p.instId));
    // Less available than banked (a position the ledger does not know holds margin): the pot has no free cash.
    const freeCash = snap.available.minus(pot.banked);
    if (freeCash.lt(0)) step.notes.push(`the account's available ${money(snap.available)} USDT is less than the ${pot.banked} banked: the pot's free cash counts as 0`);
    const decision = decideClose({ closeTs, params: this.rule(), pot: this.potParams(), rungs: pot.rungs, freeCash: Decimal.max(ZERO, freeCash), campaigns, instruments, foreign, unresolved });
    step.before = { freeCash: money(decision.freeCash), openEquity: money(decision.openEquity), value: money(decision.value), banked: pot.banked, rungs: pot.rungs };
    // The highest value the pot was marked at, before the harvest of the close; each campaign's highest equity over its basis.
    if (pot.peak === null || decision.value.gt(pot.peak.value)) pot.peak = { ts: closeTs, value: money(decision.value) };
    for (const c of open) {
      const equity = decision.equity.get(c.id);
      if (equity && D(c.basis).gt(0) && equity.div(c.basis).gt(c.peak)) c.peak = ratio(equity.div(c.basis));
    }
    for (const s of decision.skips) this.act(step, { kind: s.kind, closeTs, instId: s.instId, campaignId: s.campaignId, plan: s.plan, outcome: 'skipped', reason: s.reason });
    // An exit is recorded before anything is sent: a restart in the middle carries it out.
    for (const a of decision.actions) {
      if (a.kind !== 'exit' || !a.signal) continue;
      const c = this.campaign(a.campaignId);
      if (c && c.pendingExit === null) c.pendingExit = { closeTs, signalTs: a.signalTs ?? closeTs - DAY_MS };
    }
    this.changed();

    let banking: CampaignBankingRecord | null = null;
    for (const a of decision.actions) {
      if (this.stopped) throw new ServiceStopped();
      if (a.kind === 'bank') banking = this.bank(step, closeTs, a);
      else if (a.kind === 'sell') await this.sell(step, closeTs, a, banking);
      else if (a.kind === 'exit') await this.exit(step, closeTs, a);
      else if (a.kind === 'add') await this.add(step, closeTs, a, deadline);
      else await this.enter(step, closeTs, a, deadline);
    }
  }

  // ---- actions ----

  /** C13: the part of the target the free cash covers leaves the pot at the close: a ledger entry. */
  private bank(step: CampaignStepLog, closeTs: number, a: Extract<PlannedAction, { kind: 'bank' }>): CampaignBankingRecord {
    const pot = this.requirePot();
    pot.banked = money(D(pot.banked).plus(a.fromCash));
    pot.rungs = a.rungs;
    const banking: CampaignBankingRecord = { closeTs, rungs: a.rungs, value: money(a.value), target: money(a.target), fromCash: money(a.fromCash), fraction: ratio(a.fraction), fromSales: '0', amount: money(a.fromCash) };
    this.ledger.bankings.push(banking);
    this.act(step, { kind: 'bank', closeTs, instId: null, campaignId: null, plan: { value: banking.value, target: banking.target, fromCash: banking.fromCash, fraction: banking.fraction, rungs: a.rungs }, outcome: 'done', result: { banked: pot.banked } });
    this.log.info({ value: banking.value, fromCash: banking.fromCash, fraction: banking.fraction, rungs: a.rungs }, 'campaign harvest: banked from the free cash');
    this.changed();
    return banking;
  }

  /** C13: a harvest sale, banked as measured; the campaign keeps the rest with its add unit and basis cut the same. */
  private async sell(step: CampaignStepLog, closeTs: number, a: Extract<PlannedAction, { kind: 'sell' }>, banking: CampaignBankingRecord | null): Promise<void> {
    const c = this.campaign(a.campaignId);
    if (!c || c.end !== null) return;
    const act = this.act(step, { kind: 'sell', closeTs, instId: c.instId, campaignId: c.id, plan: { held: money(a.held), contracts: money(a.contracts), fraction: ratio(a.fraction) }, outcome: 'done' });
    const inst = this.spec(c.instId);
    try {
      const done = await this.closing(act, c, a.held.minus(a.contracts), () => this.deps.orders.reduceLong({ instId: c.instId, contracts: money(a.contracts) }));
      const pot = this.requirePot();
      const proceeds = done.proceeds;
      const fill = done.fill;
      const sold = D(fill?.contracts ?? a.contracts);
      c.sales.push({ ...this.fillRecord(fill, inst, a.contracts), closeTs, held: money(a.held), pnl: fill?.pnl ?? '', proceeds: money(proceeds) });
      c.harvested = money(D(c.harvested).plus(proceeds));
      pot.banked = money(D(pot.banked).plus(proceeds));
      if (banking) {
        banking.fromSales = money(D(banking.fromSales).plus(proceeds));
        banking.amount = money(D(banking.fromCash).plus(banking.fromSales));
      }
      act.result = { contracts: money(sold), avgPx: fill?.avgPx ?? '', proceeds: money(proceeds), measured: done.measured, banked: pot.banked };
      if (done.closed || sold.gte(a.held)) {
        this.endCampaign(c, { kind: 'harvest', ts: fill?.ts ?? Date.now(), proceeds: '0', fill: null });
        act.result['closed'] = true;
      } else {
        const kept = afterSale(c.addUnit, c.basis, a.held, sold);
        c.addUnit = money(kept.addUnit);
        c.basis = money(kept.basis);
      }
      this.log.info({ campaign: c.id, contracts: money(sold), proceeds: money(proceeds), attempts: act.attempts }, 'campaign harvest sale');
      if (sold.lt(a.contracts) && !done.closed) this.partialFill(step, act, c, 'sell', a.contracts, sold);
    } catch (err) {
      if (err instanceof ServiceStopped) throw err;
      if (err instanceof PositionGone) this.endGone(step, act, c, err.reason);
      else this.recordError(step, act, c, 'sell', err);
    }
    this.changed();
  }

  /**
   * C5: the exit; the proceeds go to the free cash. When the book fills only part of the sale the rest is sold again,
   * up to EXIT_ORDERS orders; an exit that still leaves part of the position, or cannot be carried out, stays pending
   * with what it returned so far.
   */
  private async exit(step: CampaignStepLog, closeTs: number, a: Extract<PlannedAction, { kind: 'exit' }>): Promise<void> {
    const c = this.campaign(a.campaignId);
    if (!c || c.end !== null) return;
    const pending = c.pendingExit ?? { closeTs, signalTs: a.signalTs ?? closeTs - DAY_MS };
    c.pendingExit = pending;
    // Late: its close was missed, or the exit could not be carried out at the step of its close.
    const late = step.kind === 'catch-up' || pending.closeTs !== closeTs;
    const act = this.act(step, { kind: 'exit', closeTs: pending.closeTs, instId: c.instId, campaignId: c.id, plan: { signalTs: pending.signalTs, late }, outcome: 'done' });
    const inst = this.spec(c.instId);
    let proceeds = D(pending.proceeds ?? '0');
    try {
      let fill: CampaignFill | null = null;
      let measured = true;
      for (let order = 1; ; order++) {
        const done = await this.closing(act, c, ZERO, () => this.deps.orders.closeLong({ instId: c.instId }));
        proceeds = proceeds.plus(done.proceeds);
        measured &&= done.measured;
        fill = done.fill ?? fill;
        if (done.closed) break;
        if (order >= EXIT_ORDERS) {
          c.pendingExit = { ...pending, proceeds: money(proceeds) };
          act.result = { proceeds: money(proceeds), measured, orders: order };
          this.recordError(step, act, c, 'exit', new AppError('CAMPAIGN_EXIT_INCOMPLETE', `the book filled only part of the exit of ${c.id} after ${order} orders: the rest is sold at the next step`, 409, { orders: order, proceeds: money(proceeds) }));
          return;
        }
        this.log.warn({ campaign: c.id, filled: done.fill?.contracts ?? '', order }, 'the book filled only part of the exit: selling the rest');
        await this.pause(this.backoff(order));
        if (this.stopped) throw new ServiceStopped();
      }
      const delayMs = this.now() - pending.closeTs;
      this.endCampaign(c, {
        kind: 'exit',
        ts: fill?.ts ?? Date.now(),
        proceeds: money(proceeds),
        fill: fill ? { ...this.fillRecord(fill, inst, ZERO), pnl: fill.pnl } : null,
        closeTs: pending.closeTs,
        delayMs,
      });
      act.result = { contracts: fill?.contracts ?? '', avgPx: fill?.avgPx ?? '', proceeds: money(proceeds), measured, delayMs };
      const logged = { campaign: c.id, proceeds: money(proceeds), multiple: c.multiple, delayMs, attempts: act.attempts };
      if (late) this.log.warn(logged, 'campaign exit, late: its close was missed');
      else this.log.info(logged, 'campaign exit');
    } catch (err) {
      // What a part already sold returned stays with the exit that goes on at the next step.
      if (c.end === null && proceeds.gt(pending.proceeds ?? '0')) c.pendingExit = { ...pending, proceeds: money(proceeds) };
      if (err instanceof ServiceStopped) throw err;
      if (err instanceof PositionGone) this.endGone(step, act, c, err.reason);
      else this.recordError(step, act, c, 'exit', err);
    }
    this.changed();
  }

  /** C6: the add, sized now; the reference moves whatever comes of it. */
  private async add(step: CampaignStepLog, closeTs: number, a: Extract<PlannedAction, { kind: 'add' }>, deadline: number): Promise<void> {
    const c = this.campaign(a.campaignId);
    if (!c || c.end !== null || c.pendingExit !== null) return;
    const act = this.act(step, { kind: 'add', closeTs, instId: c.instId, campaignId: c.id, plan: { close: money(a.close), ref: money(a.ref), price: money(a.price) }, outcome: 'done' });
    c.addRef = money(a.price);
    this.changed();
    if (this.deps.risk.state.killSwitch) {
      this.skip(act, 'kill-switch', `kill switch on (${this.deps.risk.state.killSwitchReason}): no add`);
      return;
    }
    const inst = this.spec(c.instId);
    let cap: Decimal | null = null;
    for (let attempt = 1; ; attempt++) {
      act.attempts = attempt;
      let contracts = ZERO;
      let fillPx = money(a.price);
      let lever = inst.maxLever;
      try {
        const position = await this.positionNow(c);
        if (!position) {
          // The reconcile of the next step says why; a liquidation is not this add's failure.
          this.skip(act, 'position-gone', 'the position is gone: nothing to add to');
          return;
        }
        lever = position.lever || inst.maxLever;
        const unit = sizeAdd({ ...this.stepPosition(position), lever }, c.addUnit, a.price, null, inst, this.rule());
        const live = this.livePrices(c.instId, unit.contracts.gt(0) ? unit.contracts : D(inst.minSz));
        if (live) fillPx = live.fillPx;
        const sizing = sizeAdd({ ...this.stepPosition(position), lever }, c.addUnit, a.price, live, inst, this.rule());
        contracts = cap === null ? sizing.contracts : Decimal.min(sizing.contracts, cap);
        act.plan = { ...act.plan, unit: c.addUnit, atOpen: money(sizing.atOpen), live: sizing.live === null ? null : money(sizing.live), markPx: live?.markPx ?? null, fillPx: live?.fillPx ?? null, contracts: money(contracts) };
        if (contracts.isZero()) {
          this.skip(act, 'add-cap', 'the caps leave less than the minimum order');
          return;
        }
        const res = await this.deps.orders.addLong({ instId: c.instId, contracts: money(contracts) });
        c.adds.push({ ...this.fillRecord(res.fill, inst, contracts), closeTs, price: money(a.price), margin: res.position.margin });
        act.result = { contracts: res.fill.contracts, avgPx: res.fill.avgPx, fee: money(D(res.fill.fee || '0').neg()), margin: res.position.margin, marginBefore: res.marginBefore };
        this.log.info({ campaign: c.id, contracts: res.fill.contracts, avgPx: res.fill.avgPx, ref: c.addRef, attempts: attempt }, 'campaign add');
        if (D(res.fill.contracts).lt(contracts)) this.partialFill(step, act, c, 'add', contracts, D(res.fill.contracts));
        this.changed();
        return;
      } catch (err) {
        if (isKillSwitchRefusal(err)) return this.skip(act, 'kill-switch', 'the kill switch went on: no add');
        // Gone before the add began (nothing was moved): the reconcile of the next step says why.
        if (errorCode(err) === 'CAMPAIGN_NO_POSITION' || c.end !== null) return this.skip(act, 'position-gone', 'the position is gone: nothing to add to');
        if (errorCode(err) === 'CAMPAIGN_ADD_CAP' && cap === null && err instanceof AppError) {
          // The exchange's own reading of what the margin can spare.
          cap = resizeAddToSpare(contracts, String(err.details?.['spare'] ?? '0'), fillPx, lever, inst, this.rule());
          if (cap.isZero()) return this.skip(act, 'add-cap', 'the exchange caps the add below the minimum order');
          continue;
        }
        if (isTransient(err) && this.now() < deadline && !this.stopped) {
          await this.pause(this.backoff(attempt));
          continue;
        }
        if (this.stopped) throw new ServiceStopped();
        this.recordError(step, act, c, 'add', err);
        return;
      }
    }
  }

  /** C1, C2: the entry, staking campaignStake of the free cash left now. */
  private async enter(step: CampaignStepLog, closeTs: number, a: Extract<PlannedAction, { kind: 'enter' }>, deadline: number): Promise<void> {
    const act = this.act(step, { kind: 'enter', closeTs, instId: a.instId, campaignId: null, plan: { signalTs: a.signalTs, close: money(a.close), entryHigh: a.entryHigh, price: money(a.price) }, outcome: 'done' });
    if (this.deps.risk.state.killSwitch) {
      this.skip(act, 'kill-switch', `kill switch on (${this.deps.risk.state.killSwitchReason}): no entry`);
      return;
    }
    const inst = this.spec(a.instId);
    for (let attempt = 1; ; attempt++) {
      act.attempts = attempt;
      let before: Decimal | null = null;
      try {
        before = await this.readAvailable();
        const pot = this.requirePot();
        const freeCash = before.minus(pot.banked);
        const first = sizeEntry(freeCash, a.price, null, inst, this.rule(), this.potParams());
        if (!first.ok) return this.skip(act, first.reason, first.reason === 'cash' ? `free cash ${money(freeCash)} is below the minimum stake ${this.potParams().minStake}` : 'the stake does not buy the minimum order');
        const estimate = this.deps.market.estimateMarketFill(a.instId, 'buy', money(first.contracts));
        const s = sizeEntry(freeCash, a.price, estimate?.avgPx ?? null, inst, this.rule(), this.potParams());
        if (!s.ok) return this.skip(act, s.reason, 'the stake does not buy the minimum order at the fill');
        act.plan = { ...act.plan, freeCash: money(freeCash), stake: money(s.planned), contracts: money(s.contracts), margin: money(s.margin), fee: money(s.fee), fillPx: money(s.fillPx) };
        const res = await this.deps.orders.openLong({ instId: a.instId, contracts: money(s.contracts), margin: money(s.margin) });
        const after = await this.availableAfter();
        const stake = after === null ? D(res.position.margin || '0').minus(res.fill.fee || '0') : before.minus(after);
        const c = this.newCampaign(closeTs, a, inst, this.fillRecord(res.fill, inst, s.contracts), res.fill.contracts, stake, res.position.margin);
        act.campaignId = c.id;
        act.result = { contracts: res.fill.contracts, avgPx: res.fill.avgPx, stake: c.stake, margin: res.position.margin, measured: after !== null };
        this.log.info({ campaign: c.id, contracts: res.fill.contracts, avgPx: res.fill.avgPx, stake: c.stake, margin: res.position.margin, attempts: attempt }, 'campaign entry');
        // A partial fill: the margin was scaled to it (campaign-orders.ts), the campaign holds what was bought.
        if (D(res.fill.contracts).lt(s.contracts)) this.partialFill(step, act, c, 'enter', s.contracts, D(res.fill.contracts));
        this.changed();
        return;
      } catch (err) {
        if (isKillSwitchRefusal(err)) return this.skip(act, 'kill-switch', 'the kill switch went on: no entry');
        if (errorCode(err) === 'CAMPAIGN_OPEN_UNCONFIRMED' && err instanceof AppError) {
          // The position exists and holds its margin: it is the campaign's, and the unconfirmed buy is an error.
          const d = err.details ?? {};
          const after = await this.availableAfter();
          const pos = D(String(d['pos'] ?? '0')).abs();
          const margin = String(d['margin'] ?? '');
          const stake = before !== null && after !== null ? before.minus(after) : D(margin || '0');
          const fill: CampaignFillRecord = { ts: Date.now(), ordId: '', clOrdId: '', contracts: money(pos), qty: money(contractsToCoin(pos, inst)), avgPx: String(d['avgPx'] ?? ''), fee: money(Decimal.max(ZERO, stake.minus(margin || '0'))) };
          const c = this.newCampaign(closeTs, a, inst, fill, money(pos), stake, margin);
          act.campaignId = c.id;
          this.recordError(step, act, c, 'enter', err);
          return;
        }
        if (isTransient(err) && this.now() < deadline && !this.stopped) {
          await this.pause(this.backoff(attempt));
          continue;
        }
        if (this.stopped) throw new ServiceStopped();
        this.recordError(step, act, null, 'enter', err);
        return;
      }
    }
  }

  private newCampaign(closeTs: number, a: Extract<PlannedAction, { kind: 'enter' }>, inst: Instrument, fill: CampaignFillRecord, contracts: string, stake: Decimal, margin: string): CampaignRecord {
    const c: CampaignRecord = {
      id: `${a.instId}@${closeTs}`,
      instId: a.instId,
      signalTs: a.signalTs,
      entry: { ...fill, closeTs, price: money(a.price), stake: money(stake), margin },
      adds: [],
      sales: [],
      addRef: money(a.price),
      addUnit: money(contractsToCoin(contracts, inst)),
      stake: money(stake),
      basis: money(stake),
      harvested: '0',
      peak: '1',
      pendingExit: null,
      end: null,
      multiple: null,
    };
    this.ledger.campaigns.push(c);
    return c;
  }

  /**
   * A closing operation (a harvest sale, an exit), retried with backoff for up to exitRetryWindowMs while its
   * failure is transient or its outcome unknown. Before every retry the position is read: when it shows the operation
   * done (`left` contracts or fewer; gone for an exit) the operation went through and is not sent again. The
   * proceeds are the available balance after less before the first attempt. A position found gone otherwise throws
   * PositionGone with what the order history says.
   */
  private async closing(
    act: CampaignStepAction,
    c: CampaignRecord,
    left: Decimal,
    run: () => Promise<{ fill: CampaignFill; position: Position | null }>,
  ): Promise<{ fill: CampaignFill | null; proceeds: Decimal; measured: boolean; closed: boolean }> {
    const until = this.now() + this.exitRetryWindowMs;
    const since = Date.now() - CLOCK_SKEW_MS;
    let before: Decimal | null = null;
    let sent = false;
    for (let attempt = 1; ; attempt++) {
      act.attempts = attempt;
      try {
        before ??= await this.readAvailable();
        sent = true;
        const res = await run();
        const after = await this.availableAfter();
        return { fill: res.fill, proceeds: after === null ? this.estimateProceeds(c, res.fill) : after.minus(before), measured: after !== null, closed: res.position === null };
      } catch (err) {
        if (err instanceof ServiceStopped) throw err;
        // Liquidated while the operation was being tried (reported by the account service meanwhile).
        if (c.end !== null) throw new PositionGone({ kind: c.end.kind === 'liquidated' ? 'liquidated' : 'unknown', order: null });
        const code = errorCode(err);
        const unknown = isOutcomeUnknown(err);
        if (code === 'CAMPAIGN_NO_POSITION' || unknown || isTransient(err)) {
          // Did an attempt whose answer was lost go through, or is the position gone for another reason?
          let seen: Position | null | undefined;
          try {
            seen = await this.positionNow(c);
          } catch {
            seen = undefined;
          }
          if (seen === null) {
            const why = await this.whyGone(c, since).catch((): GoneReason => ({ kind: 'unknown', order: null }));
            if (why.kind === 'own' && sent && before !== null) return this.wentThrough(c, why.order, before, true);
            throw new PositionGone(why);
          }
          if (seen && sent && before !== null && left.gt(0) && D(seen.pos).abs().lte(left)) {
            const own = await this.whyGone(c, since).catch((): GoneReason => ({ kind: 'unknown', order: null }));
            return this.wentThrough(c, own.kind === 'own' ? own.order : null, before, false);
          }
        }
        if ((isTransient(err) || unknown) && this.now() < until && !this.stopped) {
          this.log.warn({ campaign: c.id, kind: act.kind, attempt, code, err: (err as Error).message }, 'campaign closing order failed; retrying');
          await this.pause(this.backoff(attempt));
          if (this.stopped) throw new ServiceStopped();
          continue;
        }
        if (this.stopped) throw new ServiceStopped();
        throw err;
      }
    }
  }

  /** An attempt whose answer was lost went through: it is not sent again, and what it returned is measured all the same. */
  private async wentThrough(c: CampaignRecord, order: Order | null, before: Decimal, closed: boolean): Promise<{ fill: CampaignFill | null; proceeds: Decimal; measured: boolean; closed: boolean }> {
    const after = await this.availableAfter();
    const fill = order ? this.campaignFillOf(order) : null;
    this.log.warn({ campaign: c.id, ordId: order?.ordId ?? '' }, 'a closing order whose answer was lost went through: not sent again');
    return { fill, proceeds: after === null ? this.estimateProceeds(c, fill) : after.minus(before), measured: after !== null, closed };
  }

  /** What a close returned when the balance could not be read after it: the margin the position held, its share sold, plus the P&L less the fee. */
  private estimateProceeds(c: CampaignRecord, fill: CampaignFill | null): Decimal {
    if (!fill) return ZERO;
    const p = this.deps.account.positionList().find((x) => x.instId === c.instId && x.mgnMode === 'isolated');
    const margin = D(p?.margin || c.entry.margin || '0');
    const held = D(p?.pos || fill.contracts || '0').abs();
    const share = held.gt(0) ? Decimal.min(1, D(fill.contracts || '0').div(held)) : D(1);
    return Decimal.max(ZERO, margin.mul(share).plus(fill.pnl || '0').plus(fill.fee || '0'));
  }

  // ---- liquidations and positions that are gone ----

  /** C4: the exchange liquidated a campaign's position: it ends now, with nothing back. */
  private noteLiquidation(order: Order): void {
    if (!isLiquidationOrder(order) || order.state !== 'filled' || order.side !== 'sell') return;
    const c = this.openCampaigns().find((x) => x.instId === order.instId);
    if (!c || order.uTime < c.entry.ts) return;
    if (order.category !== 'full_liquidation') {
      this.log.warn({ campaign: c.id, ordId: order.ordId, contracts: order.accFillSz }, 'part of a campaign position was liquidated: the campaign goes on with the rest');
      return;
    }
    this.endCampaign(c, { kind: 'liquidated', ts: order.uTime || Date.now(), proceeds: c.pendingExit?.proceeds ?? '0', fill: this.orderRecord(order) });
    if (this.current) this.act(this.current, { kind: 'liquidated', closeTs: this.current.closeTs, instId: c.instId, campaignId: c.id, plan: {}, outcome: 'noted', result: { ordId: order.ordId, avgPx: order.avgPx, contracts: order.accFillSz } });
    this.log.warn({ campaign: c.id, ordId: order.ordId, avgPx: order.avgPx, stake: c.stake, multiple: c.multiple }, 'campaign liquidated by the exchange');
    this.changed();
  }

  /**
   * The liquidations of the close (C4, C9): every open campaign whose position the exchange no longer shows ends, as
   * the order history explains it; positions on the campaign's instruments the ledger does not know are reported.
   */
  private async reconcile(step: CampaignStepLog, snap: AccountSnapshot, closeTs: number): Promise<AccountSnapshot> {
    for (const c of this.openCampaigns()) {
      if (this.positionOf(snap, c.instId)) continue;
      let why: GoneReason;
      try {
        why = await this.whyGone(c, c.entry.ts);
      } catch (err) {
        step.notes.push(`${c.id}: the position is gone and the order history could not be read (${(err as Error).message}); looked at again at the next step`);
        continue;
      }
      const act = this.act(step, { kind: 'gone', closeTs, instId: c.instId, campaignId: c.id, plan: {}, outcome: 'noted' });
      this.endGone(step, act, c, why);
    }
    const foreign = this.foreignPositions(snap).map((p) => `${p.instId} ${p.mgnMode} ${p.posSide} ${p.pos}`);
    for (const f of foreign.filter((x) => !this.ledger.foreign.includes(x))) {
      this.act(step, { kind: 'foreign', closeTs, instId: f.split(' ')[0] ?? null, campaignId: null, plan: { position: f }, outcome: 'noted', reason: 'foreign-position' });
      this.log.warn({ position: f }, 'a position on a campaign instrument that the ledger does not know: reported, never touched (no entry on that instrument)');
    }
    this.ledger.foreign = foreign;
    this.changed();
    return snap;
  }

  /** Ends a campaign whose position is gone, as `why` says; an unexplained one is an execution error. */
  private endGone(step: CampaignStepLog, act: CampaignStepAction, c: CampaignRecord, why: GoneReason): void {
    const record = why.order ? this.orderRecord(why.order) : null;
    const ts = why.order?.uTime ?? Date.now();
    act.result = why.order ? { ordId: why.order.ordId, clOrdId: why.order.clOrdId, avgPx: why.order.avgPx, contracts: why.order.accFillSz } : null;
    if (why.kind === 'liquidated') {
      // A liquidation returns nothing; what part of an exit had returned before it stays the campaign's.
      if (c.end === null) this.endCampaign(c, { kind: 'liquidated', ts, proceeds: c.pendingExit?.proceeds ?? '0', fill: record });
      // Found by the reconcile, it is the liquidation itself; met by a sale or an exit, that action had nothing left to do.
      if (act.kind === 'gone') {
        act.kind = 'liquidated';
        act.outcome = 'noted';
      } else act.outcome = 'skipped';
      act.reason = 'liquidated';
      this.log.warn({ campaign: c.id }, 'campaign position liquidated');
    } else if (why.kind === 'external') {
      this.endCampaign(c, { kind: 'external', ts, proceeds: '', fill: record });
      act.outcome = act.kind === 'gone' ? 'noted' : 'skipped';
      act.reason = 'external';
      this.log.warn({ campaign: c.id, ordId: why.order?.ordId }, 'campaign position closed by an order that was not the campaign\'s');
    } else {
      this.endCampaign(c, { kind: 'unknown', ts, proceeds: '', fill: record });
      const code = why.kind === 'own' ? 'CAMPAIGN_CLOSE_UNRECORDED' : 'CAMPAIGN_POSITION_UNEXPLAINED';
      const message = why.kind === 'own' ? `the position of ${c.id} was closed by an order of the campaign the ledger did not record` : `the position of ${c.id} is gone and the exchange's order history does not say why`;
      this.recordError(step, act, c, act.kind === 'gone' ? 'reconcile' : act.kind, new AppError(code, message, 409, record ? { ordId: record.ordId } : {}));
    }
  }

  /** The exchange's order history of the instrument since `since` (exchange time): the sells the ledger does not know. */
  private async whyGone(c: CampaignRecord, since: number): Promise<GoneReason> {
    const known = new Set([c.entry.ordId, ...c.adds.map((x) => x.ordId), ...c.sales.map((x) => x.ordId)]);
    const rows = (await this.deps.clients.rest.getOrdersHistory({ instType: 'SWAP', instId: c.instId, limit: 100 })).map(mapOrder);
    const sells = rows.filter((o) => !known.has(o.ordId) && o.side === 'sell' && o.cTime >= since && D(o.accFillSz || '0').gt(0)).sort((x, y) => y.uTime - x.uTime);
    const liquidation = sells.find(isLiquidationOrder);
    if (liquidation) return { kind: 'liquidated', order: liquidation };
    const own = sells.find((o) => o.clOrdId.startsWith(CAMPAIGN_CL_ORD_PREFIX));
    if (own) return { kind: 'own', order: own };
    const external = sells[0];
    return external ? { kind: 'external', order: external } : { kind: 'unknown', order: null };
  }

  private endCampaign(c: CampaignRecord, end: CampaignEndRecord): void {
    c.end = end;
    c.pendingExit = null;
    const stake = D(c.stake || '0');
    c.multiple = end.proceeds === '' || !stake.gt(0) ? null : ratio(D(c.harvested).plus(end.proceeds).div(stake));
  }

  // ---- reading the exchange ----

  private async readAccount(withOrders: boolean): Promise<AccountSnapshot> {
    const config = this.deps.account.config;
    if (!config) throw new NotConnectedError('OKX account (position mode not loaded yet)');
    const rest = this.deps.clients.rest;
    const [balance, rows, pending] = await Promise.all([rest.getBalance('USDT'), rest.getPositions('SWAP'), withOrders ? rest.getOrdersPending({ instType: 'SWAP' }) : Promise.resolve([])]);
    const usdt = balance.details.find((d) => d.ccy === 'USDT');
    const available = usdt?.availEq || usdt?.availBal || '';
    if (available === '') throw new AppError('CAMPAIGN_BALANCE_UNKNOWN', 'the exchange reports no available USDT balance', 502);
    return {
      available: D(available),
      totalEq: D(balance.totalEq || usdt?.eq || '0'),
      positions: rows.map(mapPosition).filter((p) => !D(p.pos || '0').isZero()),
      openOrders: pending.length,
      posSide: config.posMode === 'long_short_mode' ? 'long' : 'net',
    };
  }

  /** The account, or null when it cannot be read now (logged once per reason). */
  private async tryReadAccount(): Promise<AccountSnapshot | null> {
    try {
      const snap = await this.readAccount(false);
      if (this.unavailable !== null) this.log.info('campaign: the paper account can be read again');
      this.unavailable = null;
      return snap;
    } catch (err) {
      const message = (err as Error).message;
      if (this.unavailable !== message) this.log.warn({ err: message }, 'campaign: the paper account cannot be read; the close waits (it is a missed close once its window has passed)');
      this.unavailable = message;
      return null;
    }
  }

  private async readAvailable(): Promise<Decimal> {
    const balance = await this.deps.clients.rest.getBalance('USDT');
    const usdt = balance.details.find((d) => d.ccy === 'USDT');
    const available = usdt?.availEq || usdt?.availBal || '';
    if (available === '') throw new AppError('CAMPAIGN_BALANCE_UNKNOWN', 'the exchange reports no available USDT balance', 502);
    return D(available);
  }

  /** The available balance right after an operation went through; null when it cannot be read (the amount is then estimated). */
  private async availableAfter(): Promise<Decimal | null> {
    for (let attempt = 1; attempt <= 3; attempt++) {
      try {
        return await this.readAvailable();
      } catch (err) {
        this.log.warn({ attempt, err: (err as Error).message }, 'campaign: the balance after an operation could not be read');
        if (attempt < 3) await this.pause(this.backoff(attempt));
      }
    }
    return null;
  }

  /** The campaign's isolated long as the exchange reports it now; null when it is gone. */
  private async positionNow(c: CampaignRecord): Promise<Position | null> {
    const posSide = this.deps.account.config?.posMode === 'long_short_mode' ? 'long' : 'net';
    const rows = await this.deps.clients.rest.getPositions('SWAP', c.instId);
    return rows.map(mapPosition).find((p) => p.instId === c.instId && p.mgnMode === 'isolated' && p.posSide === posSide && positionDirection(p) === 'long') ?? null;
  }

  private positionOf(snap: AccountSnapshot, instId: string): Position | undefined {
    return snap.positions.find((p) => p.instId === instId && p.mgnMode === 'isolated' && p.posSide === snap.posSide && positionDirection(p) === 'long');
  }

  /** Positions on the campaign's instruments that are not an open campaign's. */
  private foreignPositions(snap: AccountSnapshot): Position[] {
    const instruments = new Set([...this.config.instruments, ...this.openCampaigns().map((c) => c.instId)]);
    const own = new Set(this.openCampaigns().map((c) => c.instId));
    return snap.positions.filter((p) => instruments.has(p.instId) && !(own.has(p.instId) && p === this.positionOf(snap, p.instId)));
  }

  private stepPosition(p: Position): StepPosition {
    const markPx = D(p.markPx || '0').gt(0) ? p.markPx : (this.deps.market.refPrice(p.instId) ?? p.avgPx);
    return { contracts: D(p.pos).abs().toFixed(), avgPx: p.avgPx, margin: p.margin || '0', markPx };
  }

  /** The mark and the book's estimated fill of a buy of `contracts`, as the risk engine prices it; null while either is missing. */
  private livePrices(instId: string, contracts: Decimal): { markPx: string; fillPx: string } | null {
    const markPx = this.deps.market.refPrice(instId);
    const estimate = this.deps.market.estimateMarketFill(instId, 'buy', money(contracts));
    if (markPx === undefined || !estimate || !estimate.complete) return null;
    return { markPx, fillPx: estimate.avgPx };
  }

  /** C8: the bars of the close, polled until the one that closed is confirmed (and, at 00:00 UTC, the daily one), or the window is over. */
  private async awaitBars(closeTs: number, deadline: number): Promise<Map<string, CloseBars>> {
    const daily = isDailyClose(closeTs);
    const out = new Map<string, CloseBars>();
    await Promise.all(
      this.instrumentsWith(this.openCampaigns()).map(async (inst) => {
        for (;;) {
          let halfDay: Candle[] = [];
          let days: Candle[] = [];
          let failure = '';
          if (this.config.instruments.includes(inst.instId)) {
            try {
              halfDay = await this.candles.halfDay(inst.instId);
              if (daily) days = await this.candles.daily(inst.instId);
            } catch (err) {
              failure = (err as Error).message;
            }
          }
          const bars = barsAt(inst.instId, halfDay, days, closeTs, this.rule());
          const complete = bars.close !== null && (!daily || bars.daily !== null);
          if (complete || this.now() >= deadline || this.stopped || !this.config.instruments.includes(inst.instId)) {
            if (!complete) bars.input.note = `${bars.input.note ?? ''}${failure ? ` (${failure})` : ''}; not complete ${Math.round((this.now() - closeTs) / 1000)} s after the close: no signal`;
            out.set(inst.instId, bars);
            return;
          }
          await this.pause(this.pollMs);
        }
      }),
    );
    return out;
  }

  /** The bars of every instrument as they are now, for a catch-up; one that cannot be read gives no signal. */
  private async historyBars(step: CampaignStepLog): Promise<Array<{ instId: string; halfDay: Candle[]; daily: Candle[] }>> {
    return Promise.all(
      this.tradedInstruments().map(async (inst) => {
        try {
          const [halfDay, daily] = await Promise.all([this.candles.halfDay(inst.instId), this.candles.daily(inst.instId)]);
          return { instId: inst.instId, halfDay, daily };
        } catch (err) {
          step.notes.push(`${inst.instId}: the bars could not be read (${(err as Error).message}): no signal at the missed closes`);
          return { instId: inst.instId, halfDay: [], daily: [] };
        }
      }),
    );
  }

  // ---- after a step ----

  /** The sample of the close (null for a catch-up: no close was processed); returns the free cash for the finished check. */
  private async sampleFreeCash(step: CampaignStepLog, closeTs: number | null): Promise<Decimal | null> {
    const snap = await this.tryReadAccount();
    const pot = this.requirePot();
    if (!snap) {
      step.notes.push('the account could not be read after the step: no sample');
      return null;
    }
    const freeCash = snap.available.minus(pot.banked);
    if (closeTs === null) return freeCash;
    let openEquity = ZERO;
    let open = 0;
    for (const c of this.openCampaigns()) {
      const p = this.positionOf(snap, c.instId);
      if (!p) continue;
      openEquity = openEquity.plus(positionEquity(this.stepPosition(p), this.spec(c.instId)));
      open++;
    }
    this.ledger.samples.push({ ts: closeTs, freeCash: money(freeCash), openEquity: money(openEquity), banked: pot.banked, value: money(freeCash.plus(openEquity)), open });
    this.changed();
    return freeCash;
  }

  /** C9: no campaign open and less free cash than the minimum stake: finished for good. */
  private checkFinished(freeCash: Decimal): void {
    const pot = this.ledger.pot;
    if (!pot || pot.finishedAt !== null) return;
    if (!potFinished(freeCash, this.openCampaigns().length, this.potParams())) return;
    pot.finishedAt = this.now();
    this.log.warn({ freeCash: money(freeCash), banked: pot.banked, campaigns: this.ledger.campaigns.length }, 'campaign pot finished: no campaign open and less free cash than the minimum stake');
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
    this.changed();
  }

  // ---- the ledger ----

  private beginStep(kind: CampaignStepLog['kind'], closes: number[]): CampaignStepLog {
    const step: CampaignStepLog = { seq: ++this.ledger.stepSeq, kind, closeTs: closes[closes.length - 1] ?? 0, closes, startedAt: this.now(), endedAt: null, before: null, inputs: [], actions: [], errors: 0, notes: [] };
    this.ledger.steps.push(step);
    this.current = step;
    this.changed();
    return step;
  }

  private endStep(step: CampaignStepLog): void {
    step.endedAt = this.now();
    if (this.current === step) this.current = null;
    this.log.info({ seq: step.seq, kind: step.kind, close: iso(step.closeTs), actions: step.actions.length, errors: step.errors }, 'campaign step done');
    this.changed();
    // After the step of a 00:00 UTC close (entries and exits are decided there), in the background.
    if (step.closes.some(isDailyClose)) this.replay.refresh();
  }

  private act(step: CampaignStepLog, a: Pick<CampaignStepAction, 'kind' | 'closeTs' | 'instId' | 'campaignId' | 'plan'> & Partial<Pick<CampaignStepAction, 'outcome' | 'reason' | 'result'>>): CampaignStepAction {
    const action: CampaignStepAction = { kind: a.kind, closeTs: a.closeTs, instId: a.instId, campaignId: a.campaignId, plan: a.plan, outcome: a.outcome ?? 'noted', reason: a.reason ?? '', result: a.result ?? null, attempts: 0, error: false, ts: this.now() };
    step.actions.push(action);
    if (action.outcome === 'skipped' || action.outcome === 'missed') this.log.info({ kind: action.kind, instId: action.instId, campaign: action.campaignId, outcome: action.outcome, reason: action.reason }, 'campaign action not carried out');
    return action;
  }

  private skip(act: CampaignStepAction, reason: string, why: string): void {
    act.outcome = 'skipped';
    act.reason = reason;
    act.result = { why };
    const logged = { kind: act.kind, instId: act.instId, campaign: act.campaignId, reason };
    if (reason === 'kill-switch') this.log.warn(logged, `campaign ${act.kind} skipped: ${why}`);
    else this.log.info(logged, `campaign ${act.kind} skipped: ${why}`);
    this.changed();
  }

  /** The book filled only part of an order: the ledger holds what was done, and the deviation from the rule's quantity is an execution error. */
  private partialFill(step: CampaignStepLog, act: CampaignStepAction, c: CampaignRecord, action: string, ordered: Decimal, filled: Decimal): void {
    this.recordError(step, act, c, action, new AppError('CAMPAIGN_PARTIAL_FILL', `the book filled ${money(filled)} of the ${money(ordered)} contracts of the ${action} of ${c.id}`, 409, { ordered: money(ordered), filled: money(filled) }));
    // Done, in part: the ledger holds what was filled.
    act.outcome = 'done';
  }

  /** An execution error: counted, with its time, campaign, code and details. */
  private recordError(step: CampaignStepLog | null, act: CampaignStepAction | null, c: CampaignRecord | null, action: string, err: unknown): void {
    const code = errorCode(err);
    const message = err instanceof Error ? err.message : String(err);
    const record: CampaignErrorRecord = { ts: this.now(), closeTs: step?.closeTs ?? null, campaignId: c?.id ?? act?.campaignId ?? null, instId: c?.instId ?? act?.instId ?? null, action, code, message, details: plainDetails(errorDetails(err)) };
    this.ledger.errors.push(record);
    this.ledger.errorCount++;
    if (step) step.errors++;
    if (act) {
      act.outcome = 'failed';
      act.reason = code;
      act.error = true;
      act.result = { ...(act.result ?? {}), message };
    }
    this.log.error({ action, campaign: record.campaignId, instId: record.instId, code, details: record.details, errors: this.ledger.errorCount }, `campaign execution error: ${message}`);
    this.changed();
  }

  private changed(): void {
    if (this.ledgerError === null) {
      try {
        saveLedger(this.opts.ledgerFile, this.ledger);
      } catch (err) {
        this.log.error({ file: this.opts.ledgerFile, err: (err as Error).message }, 'the campaign ledger could not be written');
      }
    }
    this.emitChange();
  }

  private emitChange(): void {
    if (this.listenerCount('change') > 0) this.emit('change', this.view());
  }

  // ---- what the service shows ----

  view(): CampaignView {
    const pot = this.ledger.pot;
    const status = this.status();
    const live = this.liveFigures();
    const lastStep = this.ledger.steps[this.ledger.steps.length - 1];
    const next = status.status === 'running' && pot ? (this.ledger.lastClose ?? closeAtOrBefore(pot.startedAt)) + HALF_DAY_MS : null;
    return {
      status: status.status,
      reason: status.reason,
      params: paramsView(this.config.instruments, this.rule(), this.potParams()),
      pot: pot
        ? {
            ...pot,
            freeCash: live.freeCash === null ? null : money(live.freeCash),
            openEquity: live.openEquity === null ? null : money(live.openEquity),
            value: live.freeCash === null || live.openEquity === null ? null : money(live.freeCash.plus(live.openEquity)),
            nextRung: money(potRungLevel(pot.rungs, this.potParams())),
          }
        : null,
      campaigns: [...this.ledger.campaigns].reverse().map((c) => this.recordView(c, live.positions)),
      bankings: [...this.ledger.bankings],
      samples: [...this.ledger.samples],
      errorCount: this.ledger.errorCount,
      errors: this.ledger.errors.slice(-50).reverse(),
      missedCloses: this.ledger.missedCloses,
      foreign: [...this.ledger.foreign],
      lastStep: lastStep ? { seq: lastStep.seq, kind: lastStep.kind, closeTs: lastStep.closeTs, startedAt: lastStep.startedAt, endedAt: lastStep.endedAt, errors: lastStep.errors } : null,
      nextStep: next === null ? null : { closeTs: next, daily: isDailyClose(next) },
      replay: this.replay.summary(),
      serverTime: this.now(),
    };
  }

  /** GET /api/campaign/replay: the last result of the replay beside the pot. */
  replayView(): CampaignReplayView {
    return this.replay.view();
  }

  /** POST /api/campaign/replay: a computation in the background; false when there is nothing to replay. */
  refreshReplay(): boolean {
    return this.replay.refresh();
  }

  /** Resolves once the replay has no computation running or waiting. */
  replayIdle(): Promise<void> {
    return this.replay.idle();
  }

  private replayUnavailable(): CampaignStatusReason | null {
    if (this.ledgerError !== null) return { code: 'LEDGER_UNREADABLE', message: `${this.ledgerError}: there is no pot to replay` };
    if (!this.ledger.pot) return { code: 'POT_NOT_STARTED', message: 'the pot has not started: there is nothing to replay yet' };
    return null;
  }

  /** The pot, its campaigns and its rule now, copied: a step goes on while the replay runs. */
  private replayInput(): PotReplayInput {
    const pot = this.requirePot();
    return { pot: structuredClone(pot), campaigns: structuredClone(this.ledger.campaigns), instruments: [...this.config.instruments], params: this.rule(), potParams: this.potParams(), now: this.now() };
  }

  /** GET /api/campaign/log: the steps before `before` (a seq), newest first. */
  logPage(before: number | undefined, limit: number): CampaignLogPage {
    const older = this.ledger.steps.filter((s) => before === undefined || s.seq < before);
    const steps = older.slice(-limit).reverse();
    const oldest = steps[steps.length - 1];
    return { steps, total: this.ledger.steps.length, next: oldest !== undefined && older.length > steps.length ? oldest.seq : null };
  }

  private status(): { status: CampaignServiceStatus; reason: CampaignStatusReason | null } {
    if (this.ledgerError !== null) return { status: 'blocked', reason: { code: 'LEDGER_UNREADABLE', message: `${this.ledgerError}: the campaign does not trade until the file is repaired or moved away` } };
    const pot = this.ledger.pot;
    if (!pot) return { status: 'blocked', reason: this.blocked };
    if (pot.finishedAt !== null) return { status: 'finished', reason: { code: 'POT_FINISHED', message: 'no campaign is open and the free cash is below the minimum stake: the pot is finished and no other one is started' } };
    return { status: 'running', reason: null };
  }

  /** The pot as the account mirror shows it now. */
  private liveFigures(): { freeCash: Decimal | null; openEquity: Decimal | null; positions: Map<string, CampaignPositionView> } {
    const positions = new Map<string, CampaignPositionView>();
    const pot = this.ledger.pot;
    const usdt = this.deps.account.balance?.details.find((d) => d.ccy === 'USDT');
    const freeCash = pot && usdt && usdt.availEq !== '' ? D(usdt.availEq).minus(pot.banked) : null;
    const posSide = this.deps.account.config?.posMode === 'long_short_mode' ? 'long' : 'net';
    let openEquity: Decimal | null = ZERO;
    for (const c of this.openCampaigns()) {
      const p = this.deps.account.positionList().find((x) => x.instId === c.instId && x.mgnMode === 'isolated' && x.posSide === posSide && positionDirection(x) === 'long');
      const inst = this.deps.market.specOf(c.instId);
      if (!p || !inst) {
        openEquity = null;
        continue;
      }
      const sp = this.stepPosition(p);
      const equity = positionEquity(sp, inst);
      positions.set(c.id, { contracts: sp.contracts, avgPx: sp.avgPx, markPx: sp.markPx, margin: sp.margin, equity: money(equity), liqPx: p.liqPx });
      if (openEquity !== null) openEquity = openEquity.plus(equity);
    }
    return { freeCash, openEquity, positions };
  }

  private recordView(c: CampaignRecord, positions: Map<string, CampaignPositionView>): CampaignRecordView {
    const position = c.end === null ? (positions.get(c.id) ?? null) : null;
    const stake = D(c.stake || '0');
    const valueMultiple = c.end !== null ? c.multiple : position && stake.gt(0) ? ratio(D(c.harvested).plus(position.equity).div(stake)) : null;
    return { ...c, position, valueMultiple };
  }

  // ---- helpers ----

  private rule(): CampaignParams {
    const pot = this.ledger.pot;
    return pot ? { ...this.baseParams, structure: pot.structure } : this.baseParams;
  }

  private potParams(): PotParams {
    const pot = this.ledger.pot;
    return pot ? { ...this.basePot, start: pot.start, minStake: pot.minStake } : this.basePot;
  }

  private requirePot(): NonNullable<CampaignLedger['pot']> {
    const pot = this.ledger.pot;
    if (!pot) throw new Error('the pot has not started');
    return pot;
  }

  private openCampaigns(): CampaignRecord[] {
    return this.ledger.campaigns.filter((c) => c.end === null);
  }

  private campaign(id: string): CampaignRecord | undefined {
    return this.ledger.campaigns.find((c) => c.id === id);
  }

  /** The campaign's instruments the rule trades: tracked, and offering the rule's leverage. */
  private tradedInstruments(): Instrument[] {
    const out: Instrument[] = [];
    for (const id of this.config.instruments) {
      const inst = this.deps.market.getInstrument(id);
      if (inst && !D(inst.maxLever).lt(this.rule().leverage)) out.push(inst);
    }
    return out;
  }

  /** The traded instruments and those of the open campaigns. */
  private instrumentsWith(open: readonly CampaignRecord[]): Instrument[] {
    const out = new Map(this.tradedInstruments().map((i) => [i.instId, i]));
    for (const c of open) {
      if (out.has(c.instId)) continue;
      const inst = this.deps.market.specOf(c.instId);
      if (inst) out.set(c.instId, inst);
    }
    return [...out.values()];
  }

  private spec(instId: string): Instrument {
    const inst = this.deps.market.specOf(instId);
    if (!inst) throw new AppError('UNKNOWN_INSTRUMENT', `no specification of ${instId}`, 404);
    return inst;
  }

  private fillRecord(fill: CampaignFill | null, inst: Instrument, contracts: Decimal): CampaignFillRecord {
    const filled = fill?.contracts ?? money(contracts);
    return { ts: fill?.ts || Date.now(), ordId: fill?.ordId ?? '', clOrdId: fill?.clOrdId ?? '', contracts: filled, qty: money(contractsToCoin(filled, inst)), avgPx: fill?.avgPx ?? '', fee: money(D(fill?.fee || '0').neg()) };
  }

  private orderRecord(o: Order): CampaignFillRecord & { pnl: string } {
    const inst = this.deps.market.specOf(o.instId);
    return { ts: o.uTime, ordId: o.ordId, clOrdId: o.clOrdId, contracts: o.accFillSz, qty: inst ? money(contractsToCoin(o.accFillSz || '0', inst)) : '', avgPx: o.avgPx, fee: money(D(o.fee || '0').neg()), pnl: o.pnl };
  }

  private campaignFillOf(o: Order): CampaignFill {
    return { ts: o.uTime, ordId: o.ordId, clOrdId: o.clOrdId, contracts: o.accFillSz || '0', avgPx: o.avgPx, fee: o.fee || '0', pnl: o.pnl || '0' };
  }

  private backoff(attempt: number): number {
    return this.retryDelaysMs[Math.min(attempt - 1, this.retryDelaysMs.length - 1)] ?? 1_000;
  }

  /** A wait that a stop cuts short. */
  private async pause(ms: number): Promise<void> {
    await Promise.race([this.sleep(ms), this.stopSignal]);
  }
}
