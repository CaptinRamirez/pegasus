import type { CampaignSignals, CampaignStructure } from './campaign.js';

/**
 * What the API's campaign service (apps/api/src/services/campaign.ts) keeps about the pot it runs on the paper
 * exchange, and how GET /api/campaign, GET /api/campaign/log and the `campaign` WebSocket message give it. The
 * records are the ledger's own (it is saved as they are); the view adds what the account shows now.
 *
 * Money is in USDT as decimal strings. Times are epoch ms: the closes are 00:00 and 12:00 UTC; the times of
 * orders and fills are the exchange's.
 */

/**
 * disabled: CAMPAIGN_ENABLED is not 1. blocked: the service does not trade, `reason` says why (the ledger cannot be
 * read, the account is not the pot's own, the account cannot be read yet). running: the pot is open. finished: the
 * pot has no campaign open and less free cash than the minimum stake; it stays finished.
 */
export type CampaignServiceStatus = 'disabled' | 'blocked' | 'running' | 'finished';

export interface CampaignStatusReason {
  /** CAMPAIGN_DISABLED, LEDGER_UNREADABLE, ACCOUNT_NOT_DEDICATED, ACCOUNT_UNAVAILABLE, POT_FINISHED */
  code: string;
  /** In English; a page explains it from the code */
  message: string;
}

/** An order of a campaign as the exchange reported it once it had ended. */
export interface CampaignFillRecord {
  /** When the order ended, exchange time */
  ts: number;
  ordId: string;
  clOrdId: string;
  /** Contracts filled */
  contracts: string;
  /** Base coin of those contracts */
  qty: string;
  avgPx: string;
  /** Fee paid, positive */
  fee: string;
}

export interface CampaignEntryRecord extends CampaignFillRecord {
  /** The 00:00 UTC close whose entry signal it executed */
  closeTs: number;
  /** Open of the 12-hour bar after that close: what the quantity was computed with, and the first add reference */
  price: string;
  /** What the open took from the free cash, measured: the available balance before less after (margin and fee) */
  stake: string;
  /** Margin of the isolated position once it was topped up */
  margin: string;
}

export interface CampaignAddRecord extends CampaignFillRecord {
  /** The 12-hour close that triggered it */
  closeTs: number;
  /** Open of the 12-hour bar after that close: what the quantity was computed with, and the new add reference */
  price: string;
  /** Margin of the position after the add: it paid the fee, nothing came from the balance */
  margin: string;
}

export interface CampaignSaleRecord extends CampaignFillRecord {
  /** The close of the harvest the sale belongs to */
  closeTs: number;
  /** Contracts held before the sale */
  held: string;
  /** Realised P&L as the exchange booked it */
  pnl: string;
  /** What came back to the available balance, measured: banked */
  proceeds: string;
}

/**
 * exit: closed on the exit signal. liquidated: closed by the exchange. harvest: a harvest sold all of it (less than
 * the minimum order would have been left). external: closed by an order that was not the campaign's (the terminal,
 * by hand). unknown: the position was gone and the exchange's order history did not say why (an execution error).
 */
export type CampaignEndKind = 'exit' | 'liquidated' | 'harvest' | 'external' | 'unknown';

export interface CampaignEndRecord {
  kind: CampaignEndKind;
  /** The exchange time of the closing order; when there is none, when the service found the position gone */
  ts: number;
  /**
   * What came back to the free cash, measured from the balance. '0' for a harvest, and for a liquidation unless part
   * of an exit had been sold before it; '' when it was not measured (external, unknown)
   */
  proceeds: string;
  /** The closing order when known, with its realised P&L */
  fill: (CampaignFillRecord & { pnl: string }) | null;
  /** exit: the daily close whose signal it executed */
  closeTs?: number;
  /** exit: how long after that close the position was closed, ms; long after a missed close */
  delayMs?: number;
}

/** One campaign: an isolated long on one instrument from its entry to its end. */
export interface CampaignRecord {
  /** `<instId>@<close of the entry>` */
  id: string;
  instId: string;
  /** Open time of the daily bar whose close gave the entry signal */
  signalTs: number;
  entry: CampaignEntryRecord;
  adds: CampaignAddRecord[];
  sales: CampaignSaleRecord[];
  /** The price the next add is measured from: the open of the entry bar, then of every bar an add was due at (C6) */
  addRef: string;
  /** Base coin of one add: the entry quantity less the shares the harvests sold */
  addUnit: string;
  /** What it took from the pot: entry.stake */
  stake: string;
  /** The stake less the shares the harvests sold */
  basis: string;
  /** What its harvest sales banked */
  harvested: string;
  /** Highest equity at a close over the basis; '1' at first */
  peak: string;
  /**
   * An exit the rule decided that was not carried out yet: attempted again at every step. `proceeds`: what the part
   * already sold returned, when the book filled only part of it
   */
  pendingExit: { closeTs: number; signalTs: number; proceeds?: string } | null;
  end: CampaignEndRecord | null;
  /** (harvested + end.proceeds) / stake once ended; null while open */
  multiple: string | null;
}

/** A harvest: money leaving the pot for good at a rung of the ladder. */
export interface CampaignBankingRecord {
  /** The close at which the pot was at or above the rung */
  closeTs: number;
  /** Rungs passed after it */
  rungs: number;
  /** Pot value at that close, before the money left */
  value: string;
  /** What it aimed to bank */
  target: string;
  /** Banked from the free cash at the close */
  fromCash: string;
  /** Fraction of every open campaign sold; '0' when the free cash covered the target */
  fraction: string;
  /** What those sales returned, banked */
  fromSales: string;
  /** fromCash + fromSales */
  amount: string;
}

/** The pot after the step of one 12-hour close. */
export interface CampaignSampleRecord {
  /** The close */
  ts: number;
  /** The account's available USDT less the banked amount */
  freeCash: string;
  /** Equity of the open campaigns at the mark */
  openEquity: string;
  banked: string;
  /** freeCash + openEquity */
  value: string;
  /** Open campaigns */
  open: number;
}

/**
 * An execution error: an action the rule decided that was not carried out as decided, or one that left a position
 * in a state the rule does not have. Skips the rule foresees (minimum order, add cap, stake below the minimum, kill
 * switch) and retries that succeeded are not errors.
 */
export interface CampaignErrorRecord {
  /** Service time */
  ts: number;
  /** The close of the step it happened in; null outside a step */
  closeTs: number | null;
  campaignId: string | null;
  instId: string | null;
  /** enter, add, sell, exit, reconcile or step */
  action: string;
  code: string;
  message: string;
  details: Record<string, unknown>;
}

export interface CampaignPotRecord {
  /** Service time the pot was started */
  startedAt: number;
  /** The account's total equity then */
  startValue: string;
  /** Mark price of BTC-USDT-SWAP then, for a "held BTC instead" comparison; '' when it could not be read */
  btcMarkAtStart: string;
  /** The rule the pot runs, as it was started (a later change of the settings does not apply to it) */
  structure: CampaignStructure;
  /** CAMPAIGN_POT_START when it was started: the ladder's rungs are multiples of it */
  start: string;
  /** CAMPAIGN_MIN_STAKE when it was started */
  minStake: string;
  /** Taken out for good so far: a ledger entry; nothing is transferred on the paper exchange */
  banked: string;
  /** Rungs of the ladder passed */
  rungs: number;
  /** Highest value at a close, before that close's harvest */
  peak: { ts: number; value: string } | null;
  /** When it was found finished; null while it runs */
  finishedAt: number | null;
}

// ---- the decision log ----

/** What one instrument's bars said at a close. */
export interface CampaignStepInput {
  instId: string;
  closeTs: number;
  /** The 12-hour bar that closed then (its open time and prices); null when it was not confirmed in time */
  halfDay: { ts: number; open: string; high: string; low: string; close: string } | null;
  /** Open of the 12-hour bar after the close, the price of the quantities and of the add reference; the close when that bar is not known yet; null without bars */
  price: string | null;
  /** At a 00:00 UTC close: the daily close and the channel levels; null at 12:00, or when the daily bar was not confirmed in time */
  daily: CampaignSignals | null;
  /** Why something is missing */
  note?: string;
}

/** bank, sell, exit, add, enter: what the rule decides. liquidated, gone, foreign: what the service found on the exchange. */
export type CampaignStepActionKind = 'bank' | 'sell' | 'exit' | 'add' | 'enter' | 'liquidated' | 'gone' | 'foreign';

/**
 * done: carried out. skipped: the rule foresees not acting (reason: cash, min-size, add-cap, kill-switch,
 * foreign-position, position-gone; liquidated or external for a sale or an exit whose position the exchange had closed
 * already). missed: due at a close the service did not process in time. failed: not carried out, an execution error
 * (`error` true). noted: something found, not an action.
 */
export type CampaignStepOutcome = 'done' | 'skipped' | 'missed' | 'failed' | 'noted';

export interface CampaignStepAction {
  kind: CampaignStepActionKind;
  /** The close the decision belongs to (a missed one in a catch-up) */
  closeTs: number;
  instId: string | null;
  campaignId: string | null;
  /** The rule's figures: contracts, stake, price, fraction, … */
  plan: Record<string, string | number | boolean | null>;
  outcome: CampaignStepOutcome;
  /** A rule name or an error code; '' when done */
  reason: string;
  /** What the exchange did: fills, proceeds, measured amounts */
  result: Record<string, string | number | boolean | null> | null;
  /** Attempts made; more than 1 when a transient failure was retried */
  attempts: number;
  /** Counted as an execution error: a failed action, or a done one the book filled only in part (reason CAMPAIGN_PARTIAL_FILL) */
  error: boolean;
  /** Service time */
  ts: number;
}

export interface CampaignStepLog {
  seq: number;
  /** close: a close processed when it came; catch-up: closes the service did not process in time */
  kind: 'close' | 'catch-up';
  /** The close processed; for a catch-up the last of `closes` */
  closeTs: number;
  /** The closes looked at */
  closes: number[];
  startedAt: number;
  /** null while the step runs */
  endedAt: number | null;
  /** The pot as the step found it, after the liquidations; null when the account could not be read */
  before: { freeCash: string; openEquity: string; value: string; banked: string; rungs: number } | null;
  inputs: CampaignStepInput[];
  actions: CampaignStepAction[];
  /** Execution errors of this step */
  errors: number;
  notes: string[];
}

// ---- GET /api/campaign, the `campaign` message ----

/** A campaign's isolated position as the account shows it now. */
export interface CampaignPositionView {
  contracts: string;
  avgPx: string;
  markPx: string;
  margin: string;
  /** margin + open P&L at the mark */
  equity: string;
  liqPx: string;
}

export interface CampaignRecordView extends CampaignRecord {
  /** null once ended, and while the account does not show the position */
  position: CampaignPositionView | null;
  /** While open: (harvested + equity) / stake; once ended: multiple */
  valueMultiple: string | null;
}

export interface CampaignPotView extends CampaignPotRecord {
  /** The account's available USDT less the banked amount, as the account shows it now; null while unknown */
  freeCash: string | null;
  /** Equity of the open campaigns at the mark, now; null while unknown */
  openEquity: string | null;
  /** freeCash + openEquity; null while unknown */
  value: string | null;
  /** The pot value of the next rung */
  nextRung: string;
}

export interface CampaignParamsView {
  instruments: string[];
  potStart: string;
  minStake: string;
  structure: CampaignStructure;
  leverage: string;
  feeRate: string;
  addStep: string;
  entryChannel: number;
  exitChannel: number;
  stakeFraction: string;
  rungFactor: string;
  bankFraction: string;
}

/** GET /api/campaign and the `campaign` message. */
export interface CampaignView {
  status: CampaignServiceStatus;
  /** Why it is blocked, disabled or finished; null while it runs */
  reason: CampaignStatusReason | null;
  /** The rule: the pot's own once it has started, the settings before */
  params: CampaignParamsView;
  /** null until the pot has started */
  pot: CampaignPotView | null;
  /** Newest first */
  campaigns: CampaignRecordView[];
  /** Oldest first */
  bankings: CampaignBankingRecord[];
  /** One per 12-hour close processed, oldest first */
  samples: CampaignSampleRecord[];
  /** Execution errors since the pot started: the exact count */
  errorCount: number;
  /** The last 50 of them, newest first */
  errors: CampaignErrorRecord[];
  /** Closes the service did not process in time (it was not running) */
  missedCloses: number;
  /** Positions on the campaign's instruments the ledger does not know, as the last step found them: reported, never touched */
  foreign: string[];
  lastStep: { seq: number; kind: 'close' | 'catch-up'; closeTs: number; startedAt: number; endedAt: number | null; errors: number } | null;
  /** The close the next step is for; null when no step will come (disabled, finished, blocked) */
  nextStep: { closeTs: number; daily: boolean } | null;
  /** The replay beside the pot (GET /api/campaign/replay); null when the campaign is disabled */
  replay: CampaignReplaySummary | null;
  serverTime: number;
}

/** GET /api/campaign/log: the decision log, newest first. */
export interface CampaignLogPage {
  steps: CampaignStepLog[];
  /** Steps kept (the last 1,000) */
  total: number;
  /** `before` for the next (older) page; null when there is none */
  next: number | null;
}

// ---- the replay beside the pot (GET /api/campaign/replay) ----

/**
 * unavailable: nothing to replay yet (the campaign is disabled, or the pot has not started). running: the first
 * result is being computed. ready: the last result is given (also while a newer one is computed). failed: the last
 * attempt failed and `reason` says why; an earlier result, if there is one, is still given.
 */
export type CampaignReplayStatus = 'unavailable' | 'running' | 'ready' | 'failed';

/** What the `campaign` view says about the replay, so that a page knows when to fetch GET /api/campaign/replay again. */
export interface CampaignReplaySummary {
  status: CampaignReplayStatus;
  /** When the result GET /api/campaign/replay gives was computed; null before the first */
  computedAt: number | null;
  /** Rows of the reconciliation that are not a match (differs, live-only, replay-only); null before the first result */
  mismatches: number | null;
}

/**
 * GET /api/campaign/replay: the campaign replay of packages/backtest (src/campaign) run on the same bars from the
 * pot's start with the pot's own parameters; the other structure beside it; the pot's start value held in BTC; and
 * the reconciliation of the ledger against the replay, campaign by campaign.
 */
export interface CampaignReplayView {
  status: CampaignReplayStatus;
  /** Why it is unavailable or failed; null otherwise */
  reason: CampaignStatusReason | null;
  computedAt: number | null;
  /** The last 12-hour close the result covers */
  through: number | null;
  /** The pot's own structure */
  same: CampaignReplayRun | null;
  /** The other structure ('noadd' beside 'pyramid', and the reverse), same start and same pot */
  other: CampaignReplayRun | null;
  /** The pot's start value held in BTC (BTC-USDT-SWAP) from the start: one sample per 12-hour close */
  heldBtc: CampaignValueSample[];
  /** The ledger against `same` */
  reconciliation: CampaignReconciliation | null;
}

export interface CampaignValueSample {
  /** A 12-hour close */
  ts: number;
  value: string;
}

/** One structure replayed from the pot's start. */
export interface CampaignReplayRun {
  structure: CampaignStructure;
  /** One per 12-hour close: the pot's value (free cash and open equity) and what it has banked so far */
  samples: Array<CampaignValueSample & { banked: string }>;
  /** Oldest first */
  campaigns: CampaignReplayCampaign[];
  /** Oldest first */
  bankings: Array<{ closeTs: number; amount: string }>;
  /** At `through` */
  value: string;
  banked: string;
  finished: boolean;
}

export interface CampaignReplayCampaign {
  instId: string;
  /** Open time of the daily bar whose close gave the entry signal, as CampaignRecord.signalTs: the signal close is signalTs + 1 day */
  signalTs: number;
  /** When the replay filled the entry (the open after the signal) */
  entryTs: number;
  entryPx: string;
  stake: string;
  adds: number;
  /** 'open' while the campaign is still open at `through`; a campaign the sale of a harvest closed is 'exit' (its multiple holds what the harvests banked) */
  end: 'exit' | 'liquidated' | 'open';
  /** Open time of the 12-hour bar it ended in (an exit: the open it was filled at); null while open */
  endTs: number | null;
  /** All it returned over its stake; null while open */
  multiple: string | null;
}

/**
 * match: the same campaign within the tolerances. differs: the same signal, something else differs. live-only /
 * replay-only: one side has no campaign for that signal.
 */
export type CampaignReconcileVerdict = 'match' | 'differs' | 'live-only' | 'replay-only';

export interface CampaignReconcileRow {
  instId: string;
  /** Open time of the daily bar whose close gave the entry signal, as CampaignRecord.signalTs; with instId the key of the row */
  signalTs: number;
  /** CampaignRecord.id of the ledger's campaign; null for replay-only */
  campaignId: string | null;
  verdict: CampaignReconcileVerdict;
  /** What differs; empty for a match, and for live-only and replay-only */
  differences: Array<{ field: string; live: string | null; replay: string | null }>;
}

export interface CampaignReconciliation {
  /** The tolerances the comparison applied, by field, as fractions (e.g. { entryPx: '0.005' }) */
  tolerances: Record<string, string>;
  matched: number;
  differing: number;
  liveOnly: number;
  replayOnly: number;
  /** Oldest signal first */
  rows: CampaignReconcileRow[];
}
