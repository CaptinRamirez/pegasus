import type { CampaignServiceStatus } from './campaign-api.js';
import type { CampaignStructure } from './campaign.js';
import type { SignalSnapshot, TakeProfitLeg, TrailingExit } from './schemas.js';
import type { Instrument, TdMode } from './types.js';

/**
 * GET /api/campaign/signals: the campaign rule (packages/shared/src/campaign.ts) read per coin for the terminal, each
 * signal with a plan to follow it by hand. The API's service is apps/api/src/services/campaign-signals.ts; its header
 * gives the rules of the states and of the plan. Texts are codes with their figures (`params`); the page translates
 * them. Prices and money are decimal strings in USDT; fractions are decimal strings (0.03 = 3%).
 */

/**
 * The state of one coin, by priority. While the account holds a long on it: exit (the last daily close was below the
 * exit level), then add (a 12-hour close since the last add reached the add trigger), then holding. Without one:
 * entry (the last daily close was above the entry level), then near (the mark is within `nearPct` of the level the
 * next daily close must beat, or above it), then none. unavailable: the bars could not be read or are too few.
 */
export type CampaignSignalState = 'entry' | 'near' | 'none' | 'holding' | 'add' | 'exit' | 'unavailable';

/**
 * Why a coin is in its state, as codes with figures:
 * - CLOSE_ABOVE_ENTRY { close, level }: the last daily close was above the entry level;
 * - NEAR_ENTRY { markPx, level, distancePct, nearPct }: the mark is within nearPct below the next entry level;
 * - MARK_ABOVE_ENTRY { markPx, level }: the mark is above the next entry level; an entry signal needs the daily close there;
 * - BELOW_ENTRY { markPx, level, distancePct }: none of the above;
 * - HOLDING { contracts, trailingLine, addTrigger }: a long is held (addTrigger null when adds are off);
 * - CLOSE_BELOW_EXIT { close, level }: the last daily close was below the exit level while a long is held;
 * - ADD_TRIGGER_REACHED { close, trigger, addRef, barTs }: a 12-hour close since the last add reached the add trigger;
 * - ADDS_OFF {}: the campaign's structure is noadd;
 * - ADD_REF_FROM_POSITION { avgPx }: the journal has no opening fill of the position: the add is measured from its average price;
 * - SHORT_HELD { contracts }: the account holds a short on the coin (the rule is long only; it is not counted as holding);
 * - NOT_ENOUGH_BARS { have, need }: too few confirmed daily bars for the channels;
 * - BARS_UNAVAILABLE { message }: the bars could not be read;
 * - NO_MARK_PRICE {}: no mark price: no distance and no plan.
 */
export type CampaignSignalReasonCode =
  | 'CLOSE_ABOVE_ENTRY'
  | 'NEAR_ENTRY'
  | 'MARK_ABOVE_ENTRY'
  | 'BELOW_ENTRY'
  | 'HOLDING'
  | 'CLOSE_BELOW_EXIT'
  | 'ADD_TRIGGER_REACHED'
  | 'ADDS_OFF'
  | 'ADD_REF_FROM_POSITION'
  | 'SHORT_HELD'
  | 'NOT_ENOUGH_BARS'
  | 'BARS_UNAVAILABLE'
  | 'NO_MARK_PRICE';

/**
 * What a plan warns about:
 * - STOP_TOO_WIDE / STOP_TOO_NARROW { stopDistancePct, limit }: the stop is unusually far from / close to the entry;
 * - STOP_NOT_BELOW_ENTRY { stopPx, entryPx }: the mark is at or below the exit line: there is no stop to size with, the plan has no size;
 * - BELOW_MIN_ORDER { sized, minSz, riskAmount }: the risk buys less than the minimum order; the plan holds the minimum, which risks riskAmount
 *   (not raised with an OVER_* warning, which leaves the plan without a size);
 * - LIMITED_BY_ORDER_NOTIONAL, LIMITED_BY_POSITION_NOTIONAL, LIMITED_BY_TOTAL_NOTIONAL { riskContracts, contracts, notional, limit, riskAmount, perContract, slippagePct }:
 *   the risk sizes riskContracts, but a risk limit (RISK_MAX_ORDER_NOTIONAL, RISK_MAX_POSITION_NOTIONAL_PER_INSTRUMENT,
 *   RISK_MAX_TOTAL_POSITION_NOTIONAL, counted on the positions held now, each contract valued at `perContract` = the mark plus
 *   `slippagePct` = RISK_MAX_SLIPPAGE_PCT) allows only `contracts` (`notional` at the mark, risking riskAmount): the plan holds that size;
 * - OVER_ORDER_NOTIONAL { notional, limit }, OVER_POSITION_NOTIONAL { projected, limit }, OVER_TOTAL_NOTIONAL { projected, limit }:
 *   even the minimum order would break that risk limit (`notional` / `projected` with the minimum order, counted at the mark plus
 *   RISK_MAX_SLIPPAGE_PCT as the room was): the plan has no size;
 * - SIGNAL_STALE { barTs, closedAt, ageMs }: the bar of the signal closed more than one bar ago (a newer bar is not confirmed);
 * - PRICE_FAR_ABOVE_SIGNAL { markPx, close, risePct, limit }: the mark is already far above the signal's close;
 * - EQUITY_UNKNOWN {}: no equity to size with: the plan has no size;
 * - LINEAR_ONLY {}: the plan arithmetic is for linear (USDT) contracts: an inverse swap has no size;
 * - LEVERAGE_REDUCED { leverage, maxLeverage, liqPx, liqPxAtMax, stopPx, limitPx }: below the campaign's leverage (maxLeverage), so that the
 *   estimated liquidation (liqPx at `leverage`; liqPxAtMax at maxLeverage) stays at or below limitPx = stopPx x (1 - liqBufferPct);
 * - LIQUIDATION_NEAR_STOP { liqPx, stopPx, limitPx, leverage }: an add: the position's estimated liquidation would not stay at or below limitPx;
 * - NOT_TRACKED {}: this server does not track the coin, so an order on it is refused (UNKNOWN_INSTRUMENT); add it to INSTRUMENTS;
 * - CAMPAIGN_ACCOUNT {}: the campaign service runs on this account: its positions are the pot's, and an order here disturbs it;
 * - KILL_SWITCH {}: trading is halted.
 */
export type CampaignPlanWarningCode =
  | 'STOP_NOT_BELOW_ENTRY'
  | 'STOP_TOO_WIDE'
  | 'STOP_TOO_NARROW'
  | 'BELOW_MIN_ORDER'
  | 'LIMITED_BY_ORDER_NOTIONAL'
  | 'LIMITED_BY_POSITION_NOTIONAL'
  | 'LIMITED_BY_TOTAL_NOTIONAL'
  | 'OVER_ORDER_NOTIONAL'
  | 'OVER_POSITION_NOTIONAL'
  | 'OVER_TOTAL_NOTIONAL'
  | 'SIGNAL_STALE'
  | 'PRICE_FAR_ABOVE_SIGNAL'
  | 'EQUITY_UNKNOWN'
  | 'LINEAR_ONLY'
  | 'LEVERAGE_REDUCED'
  | 'LIQUIDATION_NEAR_STOP'
  | 'NOT_TRACKED'
  | 'CAMPAIGN_ACCOUNT'
  | 'KILL_SWITCH';

export interface CampaignSignalReason {
  code: CampaignSignalReasonCode;
  params: Record<string, string | number | null>;
}

export interface CampaignPlanWarning {
  code: CampaignPlanWarningCode;
  params: Record<string, string | number | null>;
}

/** A confirmed bar as the signals read it. */
export interface CampaignSignalBar {
  /** Open time: for the daily bar the campaign's signalTs */
  barTs: number;
  /** When it closed: barTs + its length */
  closeTs: number;
  close: string;
}

/**
 * How to follow an entry or an add by hand: an isolated market buy now, with its stop at the exit line, the channel
 * trailing exit and no take-profit (the rule exits on the channel only). Sized so that a fill at `entryPx` stopped at
 * `stopPx` loses `riskTarget`, in whole lots, and no more than the risk limits allow.
 */
export interface CampaignFollowPlan {
  kind: 'entry' | 'add';
  instId: string;
  side: 'buy';
  tdMode: Extract<TdMode, 'isolated'>;
  /** The contract: its size, lot, minimum order, tick and maximum leverage, for a coin the terminal does not track */
  spec: Instrument;
  /** The mark price now: what a market buy is expected to fill near */
  entryPx: string;
  /** The stop: the exit line, the lowest low of the last exitChannel confirmed daily bars (what the next daily close is measured against, and where the channel trailing exit keeps the stop) */
  stopPx: string;
  /** entryPx - stopPx */
  stopDistance: string;
  /** stopDistance / entryPx */
  stopDistancePct: string;
  /** equity x riskPct; null without equity */
  riskTarget: string | null;
  /** What `contracts` lose from entryPx to stopPx; null without equity */
  riskAmount: string | null;
  /** The contracts the risk alone sizes (whole lots, at least the minimum order), before the risk limits; null without equity */
  riskContracts: string | null;
  /** riskContracts, or less when a risk limit allows less (LIMITED_BY_*); null without equity or when even the minimum order breaks a limit (OVER_*) */
  contracts: string | null;
  coin: string | null;
  notional: string | null;
  /** The highest whole leverage up to the campaign's (and RISK_MAX_LEVERAGE, and the instrument's maximum) that keeps the liquidation below the stop by liqBufferPct; for an add the position's own setting */
  leverage: string;
  /** notional / leverage: the isolated margin the buy posts; null without equity */
  margin: string | null;
  /** Estimated liquidation price of the isolated position (for an add, of the position after it); null when it cannot be estimated (an add to a cross position) */
  liqPx: string | null;
  /** The maintenance rate the estimate used: the instrument's first tier plus the taker fee (campaignMaintenanceRate) */
  maintenanceRate: string;
  trailing: TrailingExit;
  takeProfits: TakeProfitLeg[];
  /** An add: the position after it, at entryPx */
  after: { contracts: string; avgPx: string; margin: string | null; liqPx: string | null } | null;
  /** What to send as PlaceOrderRequest.signal (with source 'signal') */
  signal: SignalSnapshot;
  warnings: CampaignPlanWarning[];
}

/** The long the account holds on the coin, with what the rule needs to follow it. */
export interface CampaignHolding {
  /** Contracts of the long (all margin modes together) */
  contracts: string;
  avgPx: string;
  mgnMode: TdMode;
  lever: string;
  margin: string;
  liqPx: string;
  /** The exit line: the lowest low of the last exitChannel confirmed daily bars; a daily close below it ends the campaign */
  trailingLine: string | null;
  /** The price the next add is measured from: the average price of the last opening order (the entry or the last add) in the journal, else the position's average price */
  addRef: string;
  /** When that order filled (its first fill); null when it comes from the position */
  addRefTs: number | null;
  addRefSource: 'journal' | 'position';
  /** addRef x (1 + addStep): the 12-hour close an add needs; null when adds are off */
  addTrigger: string | null;
  /** The journal's open trade of the long; null when the journal has none */
  tradeId: string | null;
}

export interface CampaignSignalRow {
  instId: string;
  state: CampaignSignalState;
  reasons: CampaignSignalReason[];
  /** Whether this server tracks the coin (its market data, and orders on it) */
  tracked: boolean;
  /** The last confirmed daily bar (OKX 1Dutc); null when unavailable */
  daily: CampaignSignalBar | null;
  /** The last confirmed 12-hour bar (OKX 12Hutc); null when unavailable */
  halfDay: CampaignSignalBar | null;
  /**
   * entry / exit: the highest high of the entryChannel and the lowest low of the exitChannel daily bars before the last
   * one (what the last close was measured against); nextEntry / nextExit: the same channels ending with the last bar
   * (what the next daily close is measured against). null with too few bars.
   */
  levels: { entry: string | null; exit: string | null; nextEntry: string | null; nextExit: string | null };
  markPx: string | null;
  /** nextEntry / markPx - 1: the rise from the mark to the level the next daily close must close above; negative when the mark is above it */
  entryDistancePct: string | null;
  holding: CampaignHolding | null;
  /** For 'entry' and 'add': the signal as PlaceOrderRequest.signal carries it */
  signal: SignalSnapshot | null;
  /** For 'entry' and 'add': how to follow it */
  plan: CampaignFollowPlan | null;
}

export interface CampaignSignalsResponse {
  generatedAt: number;
  /** The rule the signals are read with: the campaign's (the pot's own while one runs) */
  params: { entryChannel: number; exitChannel: number; addStep: string; structure: CampaignStructure; leverage: string; feeRate: string };
  /** The fixed thresholds of the states and the warnings */
  thresholds: { nearPct: string; stopWidePct: string; stopNarrowPct: string; farAbovePct: string; liqBufferPct: string };
  /** Risk of one plan, fraction of the equity */
  riskPct: string;
  /** The equity the plans are sized with; null when unknown */
  equity: string | null;
  equitySource: 'request' | 'account' | null;
  /**
   * The campaign service on this API. ownAccount: it runs on this account (CAMPAIGN_ENABLED=1): the positions on its
   * coins are the pot's, and following a signal here would disturb it (every plan then warns CAMPAIGN_ACCOUNT).
   */
  campaign: { enabled: boolean; status: CampaignServiceStatus; ownAccount: boolean };
  /** One per campaign coin, in the order of the configured list */
  rows: CampaignSignalRow[];
}
