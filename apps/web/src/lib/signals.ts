import {
  D,
  Decimal,
  ZERO,
  contractsToCoin,
  floorToStep,
  isolatedLongLiquidationPrice,
  notionalQuote,
  type CampaignFollowPlan,
  type CampaignHolding,
  type CampaignPlanWarning,
  type CampaignPlanWarningCode,
  type CampaignSignalReasonCode,
  type CampaignSignalRow,
  type CampaignSignalState,
  type DecimalInput,
  type Instrument,
  type Order,
  type Position,
  type SignalSnapshot,
} from '@pegasus/shared';
import { fmtContracts, fmtNum, fmtPct, fmtPx, fmtUtcMinute, safeDecimal } from './format';

/**
 * The campaign signals tab (GET /api/campaign/signals) as the page reads it: the order of the coin list, whether a
 * signal can be followed from here, the figures of the reason and warning codes formatted for the sentences of the
 * dictionaries, and the arithmetic of the confirmation sheet. Money through decimal.js only.
 */

export const DAY_MS = 86_400_000;
export const HALF_DAY_MS = 43_200_000;

/** The coin list's order: actionable first (entry, add, exit), then holding, near, none, unavailable. */
export const STATE_ORDER: readonly CampaignSignalState[] = ['entry', 'add', 'exit', 'holding', 'near', 'none', 'unavailable'];

/** States a follow plan exists for. */
export const FOLLOWABLE: readonly CampaignSignalState[] = ['entry', 'add'];

export const coinOf = (instId: string): string => instId.split('-')[0] ?? instId;

/**
 * The rows in the coin list's order (STATE_ORDER). Within near and none the coin closest to its entry level comes
 * first; otherwise the server's order (the configured list) is kept.
 */
export function sortRows(rows: readonly CampaignSignalRow[]): CampaignSignalRow[] {
  const rank = (s: CampaignSignalState): number => STATE_ORDER.indexOf(s);
  return rows
    .map((row, i) => ({ row, i }))
    .sort((a, b) => {
      const r = rank(a.row.state) - rank(b.row.state);
      if (r !== 0) return r;
      if (a.row.state === 'near' || a.row.state === 'none') {
        const da = safeDecimal(a.row.entryDistancePct);
        const db = safeDecimal(b.row.entryDistancePct);
        if (da !== null && db !== null && !da.eq(db)) return da.lt(db) ? -1 : 1;
        if (da === null && db !== null) return 1;
        if (da !== null && db === null) return -1;
      }
      return a.i - b.i;
    })
    .map((x) => x.row);
}

/**
 * Why a signal cannot be followed from this page, the first that applies:
 * - NOT_ACTIONABLE: only an entry or an add has a plan;
 * - CAMPAIGN_ACCOUNT: the campaign pot runs on this account and trades by itself;
 * - KILL_SWITCH: opening orders are refused;
 * - TRADING_BLOCKED: the account is not loaded, or the key is read-only;
 * - NOT_TRACKED: the server does not track the coin, an order on it is refused;
 * - NO_PLAN / NO_SIZE: the plan has no size (no equity, the price at or below the exit line, an inverse swap);
 * - EXITS_UNAVAILABLE: the plan's channel trailing exit is not offered here (live trading); EXITS_UNKNOWN: that
 *   could not be checked.
 */
export type FollowBlock = 'NOT_ACTIONABLE' | 'CAMPAIGN_ACCOUNT' | 'KILL_SWITCH' | 'TRADING_BLOCKED' | 'NOT_TRACKED' | 'NO_PLAN' | 'NO_SIZE' | 'EXITS_UNAVAILABLE' | 'EXITS_UNKNOWN';

export interface FollowContext {
  /** The campaign service runs on this account (CampaignSignalsResponse.campaign.ownAccount) */
  ownAccount: boolean;
  killSwitch: boolean;
  /** Whether exits are offered (GET /api/trailing); null while unknown */
  exits: boolean | null;
  /** The account is not loaded or the key cannot trade */
  tradingBlocked: boolean;
}

const warns = (plan: CampaignFollowPlan, code: CampaignPlanWarningCode): boolean => plan.warnings.some((w) => w.code === code);

export function followBlock(row: CampaignSignalRow, ctx: FollowContext): FollowBlock | null {
  if (!FOLLOWABLE.includes(row.state)) return 'NOT_ACTIONABLE';
  const plan = row.plan;
  if (ctx.ownAccount || (plan !== null && warns(plan, 'CAMPAIGN_ACCOUNT'))) return 'CAMPAIGN_ACCOUNT';
  if (ctx.killSwitch || (plan !== null && warns(plan, 'KILL_SWITCH'))) return 'KILL_SWITCH';
  if (ctx.tradingBlocked) return 'TRADING_BLOCKED';
  if (!row.tracked || (plan !== null && warns(plan, 'NOT_TRACKED'))) return 'NOT_TRACKED';
  if (plan === null || row.signal === null) return 'NO_PLAN';
  if (plan.contracts === null) return 'NO_SIZE';
  if (ctx.exits === false) return 'EXITS_UNAVAILABLE';
  if (ctx.exits === null) return 'EXITS_UNKNOWN';
  return null;
}

/** The figures of a reason or warning, formatted for a sentence; '' for one the code does not carry. */
export interface CodeText {
  close: string;
  level: string;
  markPx: string;
  distancePct: string;
  nearPct: string;
  contracts: string;
  trailingLine: string;
  addTrigger: string;
  trigger: string;
  addRef: string;
  /** The close of the bar named by barTs */
  barClose: string;
  avgPx: string;
  have: string;
  need: string;
  message: string;
  stopPx: string;
  entryPx: string;
  stopDistancePct: string;
  limit: string;
  sized: string;
  minSz: string;
  riskAmount: string;
  notional: string;
  projected: string;
  closedAt: string;
  /** ageMs as milliseconds; the dictionary words it */
  ageMs: string;
  risePct: string;
  leverage: string;
  maxLeverage: string;
  liqPx: string;
  /** The estimated liquidation at the leverage the rule would use (LEVERAGE_REDUCED) */
  liqPxAtMax: string;
  /** The line the liquidation must stay at or below: the stop less the buffer */
  limitPx: string;
  /** The contracts the risk alone sizes, before the limits (LIMITED_BY_*) */
  riskContracts: string;
  /** What each contract is counted at against the limit (LIMITED_BY_*): the mark plus `slippagePct` of slippage */
  perContract: string;
  slippagePct: string;
  /**
   * Where the liquidation at the rule's leverage stands against the stop (LEVERAGE_REDUCED, completeWarning): 'above'
   * at or above the stop, 'near' below it but above the line it must stay at or below, '' when not known
   */
  liqRelation: string;
}

type Kind = 'px' | 'pct' | 'ct' | 'usdt' | 'time' | 'halfDayClose' | 'dayClose' | 'raw';

const EMPTY_TEXT: CodeText = {
  close: '', level: '', markPx: '', distancePct: '', nearPct: '', contracts: '', trailingLine: '', addTrigger: '', trigger: '', addRef: '', barClose: '',
  avgPx: '', have: '', need: '', message: '', stopPx: '', entryPx: '', stopDistancePct: '', limit: '', sized: '', minSz: '', riskAmount: '', notional: '',
  projected: '', closedAt: '', ageMs: '', risePct: '', leverage: '', maxLeverage: '', liqPx: '', liqPxAtMax: '', limitPx: '', riskContracts: '', perContract: '', slippagePct: '',
  liqRelation: '',
};

/** How each figure of a code is written; barTs is written as the close of its bar, under `barClose`. */
const REASON_KINDS: Record<CampaignSignalReasonCode, Record<string, Kind>> = {
  CLOSE_ABOVE_ENTRY: { close: 'px', level: 'px' },
  NEAR_ENTRY: { markPx: 'px', level: 'px', distancePct: 'pct', nearPct: 'pct' },
  MARK_ABOVE_ENTRY: { markPx: 'px', level: 'px' },
  BELOW_ENTRY: { markPx: 'px', level: 'px', distancePct: 'pct' },
  HOLDING: { contracts: 'ct', trailingLine: 'px', addTrigger: 'px' },
  CLOSE_BELOW_EXIT: { close: 'px', level: 'px' },
  ADD_TRIGGER_REACHED: { close: 'px', trigger: 'px', addRef: 'px', barTs: 'halfDayClose' },
  ADDS_OFF: {},
  ADD_REF_FROM_POSITION: { avgPx: 'px' },
  SHORT_HELD: { contracts: 'ct' },
  NOT_ENOUGH_BARS: { have: 'raw', need: 'raw' },
  BARS_UNAVAILABLE: { message: 'raw' },
  NO_MARK_PRICE: {},
};

const WARNING_KINDS: Record<CampaignPlanWarningCode, Record<string, Kind>> = {
  STOP_NOT_BELOW_ENTRY: { stopPx: 'px', entryPx: 'px' },
  STOP_TOO_WIDE: { stopDistancePct: 'pct', limit: 'pct' },
  STOP_TOO_NARROW: { stopDistancePct: 'pct', limit: 'pct' },
  BELOW_MIN_ORDER: { sized: 'ct', minSz: 'ct', riskAmount: 'usdt' },
  OVER_ORDER_NOTIONAL: { notional: 'usdt', limit: 'usdt' },
  OVER_POSITION_NOTIONAL: { projected: 'usdt', limit: 'usdt' },
  OVER_TOTAL_NOTIONAL: { projected: 'usdt', limit: 'usdt' },
  LIMITED_BY_ORDER_NOTIONAL: { riskContracts: 'ct', contracts: 'ct', notional: 'usdt', limit: 'usdt', riskAmount: 'usdt', perContract: 'usdt', slippagePct: 'pct' },
  LIMITED_BY_POSITION_NOTIONAL: { riskContracts: 'ct', contracts: 'ct', notional: 'usdt', limit: 'usdt', riskAmount: 'usdt', perContract: 'usdt', slippagePct: 'pct' },
  LIMITED_BY_TOTAL_NOTIONAL: { riskContracts: 'ct', contracts: 'ct', notional: 'usdt', limit: 'usdt', riskAmount: 'usdt', perContract: 'usdt', slippagePct: 'pct' },
  SIGNAL_STALE: { barTs: 'dayClose', closedAt: 'time', ageMs: 'raw' },
  PRICE_FAR_ABOVE_SIGNAL: { markPx: 'px', close: 'px', risePct: 'pct', limit: 'pct' },
  EQUITY_UNKNOWN: {},
  LINEAR_ONLY: {},
  LEVERAGE_REDUCED: { leverage: 'raw', maxLeverage: 'raw', liqPx: 'px', liqPxAtMax: 'px', stopPx: 'px', limitPx: 'px', liqRelation: 'raw' },
  LIQUIDATION_NEAR_STOP: { liqPx: 'px', stopPx: 'px', limitPx: 'px', leverage: 'raw' },
  NOT_TRACKED: {},
  CAMPAIGN_ACCOUNT: {},
  KILL_SWITCH: {},
};

function formatValue(kind: Kind, v: string | number, inst: Instrument | undefined): string {
  switch (kind) {
    case 'px':
      return fmtPx(String(v), inst);
    case 'pct':
      return fmtPct(String(v), 2);
    case 'ct':
      return fmtContracts(String(v), inst);
    case 'usdt':
      return fmtNum(String(v), 2);
    case 'time':
      return typeof v === 'number' ? fmtUtcMinute(v) : String(v);
    case 'halfDayClose':
      return typeof v === 'number' ? fmtUtcMinute(v + HALF_DAY_MS) : String(v);
    case 'dayClose':
      return typeof v === 'number' ? fmtUtcMinute(v + DAY_MS) : String(v);
    case 'raw':
      return String(v);
  }
}

function codeText(kinds: Record<string, Kind>, params: Record<string, string | number | null>, inst: Instrument | undefined): CodeText {
  const out: CodeText = { ...EMPTY_TEXT };
  const fields = out as unknown as Record<string, string>;
  for (const [key, value] of Object.entries(params)) {
    if (value === null) continue;
    const kind = kinds[key] ?? 'raw';
    fields[key === 'barTs' ? 'barClose' : key] = formatValue(kind, value, inst);
  }
  return out;
}

export const reasonText = (code: CampaignSignalReasonCode, params: Record<string, string | number | null>, inst: Instrument | undefined): CodeText =>
  codeText(REASON_KINDS[code], params, inst);

export const warningText = (code: CampaignPlanWarningCode, params: Record<string, string | number | null>, inst: Instrument | undefined): CodeText =>
  codeText(WARNING_KINDS[code], params, inst);

/**
 * A warning's figures with the prices a LEVERAGE_REDUCED or LIQUIDATION_NEAR_STOP sentence names, computed from the
 * plan when the API did not send them (an older API): the liquidation at the chosen leverage (the plan's), the one at
 * the rule's leverage (one unit at the entry, its margin entry / leverage, the plan's maintenance rate), the stop and
 * the line the liquidation must stay below (the stop less `liqBufferPct`); and, for LEVERAGE_REDUCED, where the
 * liquidation at the rule's leverage stands (`liqRelation`): at or above the stop, or below it but above the line.
 */
export function completeWarning(w: CampaignPlanWarning, plan: CampaignFollowPlan, inst: Instrument | undefined, liqBufferPct: string): Record<string, string | number | null> {
  if (w.code !== 'LEVERAGE_REDUCED' && w.code !== 'LIQUIDATION_NEAR_STOP') return w.params;
  const params = { ...w.params };
  const stop = safeDecimal(plan.stopPx);
  if (params['stopPx'] === undefined || params['stopPx'] === null) params['stopPx'] = plan.stopPx;
  if ((params['limitPx'] === undefined || params['limitPx'] === null) && stop !== null) params['limitPx'] = liquidationLimitOf(stop, liqBufferPct).toFixed();
  if (params['liqPx'] === undefined || params['liqPx'] === null) params['liqPx'] = plan.liqPx;
  if (w.code === 'LEVERAGE_REDUCED') {
    if ((params['liqPxAtMax'] === undefined || params['liqPxAtMax'] === null) && inst !== undefined) {
      const max = params['maxLeverage'];
      const liq = max === undefined || max === null ? null : estimateLiqPx('1', plan.entryPx, String(max), plan.maintenanceRate, inst);
      params['liqPxAtMax'] = liq === null ? null : liq.toFixed();
    }
    const atMax = safeDecimal(params['liqPxAtMax']);
    const stopPx = safeDecimal(params['stopPx']);
    const limitPx = safeDecimal(params['limitPx']);
    if (atMax !== null && stopPx !== null) params['liqRelation'] = liqRelationOf(atMax, stopPx, limitPx ?? stopPx) ?? '';
  }
  if (w.code === 'LIQUIDATION_NEAR_STOP' && (params['leverage'] === undefined || params['leverage'] === null)) params['leverage'] = plan.leverage;
  return params;
}

/** The line an estimated liquidation must stay at or below: the stop less `liqBufferPct` of it (the API's LIQ_BUFFER_PCT). */
export const liquidationLimitOf = (stop: Decimal, liqBufferPct: DecimalInput): Decimal => stop.mul(D(1).minus(liqBufferPct));

/**
 * The highest whole leverage, from `from` down to 1, at which the estimated isolated liquidation of a long at `entry`
 * stays at or below `limit` (liquidationLimitOf); the liquidation does not depend on the size. null when none does,
 * or when the figures are not numbers.
 */
export function safeLeverageFor(entry: DecimalInput | null, limit: Decimal | null, from: DecimalInput | null, maintenanceRate: DecimalInput, inst: Instrument): number | null {
  const top = safeDecimal(from);
  if (limit === null || top === null || !top.gte(1)) return null;
  for (let lever = Math.floor(top.toNumber()); lever >= 1; lever--) {
    const liq = estimateLiqPx('1', entry, lever, maintenanceRate, inst);
    if (liq === null) return null;
    if (liq.lte(limit)) return lever;
  }
  return null;
}

/** When the bar of the signal closed: a daily bar for an entry, a 12-hour bar for an add. */
export const signalCloseTs = (signal: Pick<SignalSnapshot, 'kind' | 'barTs'>): number => signal.barTs + (signal.kind === 'entry' ? DAY_MS : HALF_DAY_MS);

/** The next 00:00 UTC close after `now`. */
export const nextDailyClose = (now: number): number => Math.floor(now / DAY_MS) * DAY_MS + DAY_MS;

/** price / ref - 1; null when either is missing or ref is not positive. */
export function changeFrom(price: DecimalInput | null | undefined, ref: DecimalInput | null | undefined): Decimal | null {
  const p = safeDecimal(price);
  const r = safeDecimal(ref);
  if (p === null || r === null || !r.gt(0)) return null;
  return p.div(r).minus(1);
}

/** The add trigger after an entry filled at `entryPx`: entryPx x (1 + addStep). */
export function addTriggerAfter(entryPx: DecimalInput | null | undefined, addStep: DecimalInput): Decimal | null {
  const e = safeDecimal(entryPx);
  return e === null ? null : e.mul(D(1).plus(addStep));
}

// ---- the confirmation sheet's arithmetic (linear contracts, a long) ----

/** What one contract loses from `entry` to `stop`; null when the stop is not below the entry. */
function riskPerContract(entry: Decimal, stop: Decimal, inst: Instrument): Decimal | null {
  const distance = entry.minus(stop);
  if (!distance.gt(0)) return null;
  return distance.mul(contractsToCoin(1, inst));
}

/**
 * Contracts of a long that lose `riskPct` of `equity` from `entry` to `stop`: whole lots rounded down, at least
 * the minimum order (`belowMin` then says so), as the API sizes a plan. null when it cannot be computed.
 */
export function contractsForRisk(
  equity: DecimalInput | null,
  riskPct: DecimalInput | null,
  entry: DecimalInput | null,
  stop: DecimalInput | null,
  inst: Instrument,
): { contracts: string; belowMin: boolean } | null {
  const eq = safeDecimal(equity);
  const r = safeDecimal(riskPct);
  const e = safeDecimal(entry);
  const s = safeDecimal(stop);
  if (eq === null || r === null || e === null || s === null || !eq.gt(0) || !r.gt(0) || !s.gt(0)) return null;
  const per = riskPerContract(e, s, inst);
  if (per === null) return null;
  const sized = floorToStep(eq.mul(r).div(per), inst.lotSz);
  const belowMin = sized.lt(inst.minSz);
  return { contracts: (belowMin ? D(inst.minSz) : sized).toFixed(), belowMin };
}

/** What `contracts` of a long lose from `entry` to `stop`, in the quote currency; null when it cannot be computed. */
export function riskOf(contracts: DecimalInput | null, entry: DecimalInput | null, stop: DecimalInput | null, inst: Instrument): Decimal | null {
  const c = safeDecimal(contracts);
  const e = safeDecimal(entry);
  const s = safeDecimal(stop);
  if (c === null || e === null || s === null || !c.gt(0)) return null;
  const per = riskPerContract(e, s, inst);
  return per === null ? null : per.mul(c);
}

/** part / whole; null when whole is not positive. */
export function shareOf(part: DecimalInput | null, whole: DecimalInput | null): Decimal | null {
  const p = safeDecimal(part);
  const w = safeDecimal(whole);
  if (p === null || w === null || !w.gt(0)) return null;
  return p.div(w);
}

/**
 * Estimated liquidation price of a new isolated long of `contracts` at `entry` with `leverage` (margin = notional /
 * leverage), with the maintenance rate the plan used. null when it cannot be estimated.
 */
export function estimateLiqPx(contracts: DecimalInput | null, entry: DecimalInput | null, leverage: DecimalInput | null, maintenanceRate: DecimalInput, inst: Instrument): Decimal | null {
  const c = safeDecimal(contracts);
  const e = safeDecimal(entry);
  const l = safeDecimal(leverage);
  if (c === null || e === null || l === null || !c.gt(0) || !e.gt(0) || !l.gt(0)) return null;
  const qty = contractsToCoin(c, inst);
  const margin = notionalQuote(c, e, inst).div(l);
  const liq = isolatedLongLiquidationPrice({ qty, avgPx: e, margin }, maintenanceRate);
  return liq.gt(0) ? liq : ZERO;
}

/** What the sheet needs of the long held on the coin to estimate the position after an add (CampaignHolding). */
export type AddHolding = Pick<CampaignHolding, 'contracts' | 'avgPx' | 'mgnMode' | 'lever' | 'margin'>;

/**
 * Estimated liquidation price of the isolated position after `contracts` are added to `holding` at `entry`, as the
 * API estimates a plan's `after`: the held coin and the added coin at their average price, the held margin plus the
 * add's (notional / leverage). At another leverage than the position's the held margin is taken as its notional at
 * the average price over that leverage (what setting the leverage makes of it). null for a cross position, or when
 * it cannot be estimated.
 */
export function liqAfterAdd(holding: AddHolding, contracts: DecimalInput | null, entry: DecimalInput | null, leverage: DecimalInput | null, maintenanceRate: DecimalInput, inst: Instrument): Decimal | null {
  const c = safeDecimal(contracts);
  const e = safeDecimal(entry);
  const l = safeDecimal(leverage);
  const heldContracts = safeDecimal(holding.contracts);
  const avgHeld = safeDecimal(holding.avgPx);
  if (holding.mgnMode !== 'isolated' || c === null || e === null || l === null || heldContracts === null || avgHeld === null) return null;
  if (!c.gt(0) || !e.gt(0) || !l.gt(0) || !heldContracts.gt(0) || !avgHeld.gt(0)) return null;
  const heldCoin = contractsToCoin(heldContracts, inst);
  const coin = contractsToCoin(c, inst);
  const qty = heldCoin.plus(coin);
  const avgPx = heldCoin.mul(avgHeld).plus(coin.mul(e)).div(qty);
  const heldMargin = safeDecimal(holding.margin);
  const sameLeverage = heldMargin !== null && heldMargin.gt(0) && (safeDecimal(holding.lever)?.eq(l) ?? false);
  const margin = (sameLeverage ? heldMargin : notionalQuote(heldContracts, avgHeld, inst).div(l)).plus(notionalQuote(c, e, inst).div(l));
  const liq = isolatedLongLiquidationPrice({ qty, avgPx, margin }, maintenanceRate);
  return liq.gt(0) ? liq : ZERO;
}

/** safeLeverageFor for an add: the highest whole leverage, from `from` down to 1, at which the position after it (liqAfterAdd) stays at or below `limit`. */
export function safeLeverageAfterAdd(holding: AddHolding, contracts: DecimalInput | null, entry: DecimalInput | null, limit: Decimal | null, from: DecimalInput | null, maintenanceRate: DecimalInput, inst: Instrument): number | null {
  const top = safeDecimal(from);
  if (limit === null || top === null || !top.gte(1)) return null;
  for (let lever = Math.floor(top.toNumber()); lever >= 1; lever--) {
    const liq = liqAfterAdd(holding, contracts, entry, lever, maintenanceRate, inst);
    if (liq === null) return null;
    if (liq.lte(limit)) return lever;
  }
  return null;
}

/** Where an estimated liquidation stands against the stop: 'above' at or above it, 'near' below it but above `limit` (liquidationLimitOf), null when safely below. */
export function liqRelationOf(liq: Decimal, stop: Decimal, limit: Decimal): 'above' | 'near' | null {
  if (liq.gte(stop)) return 'above';
  return liq.gt(limit) ? 'near' : null;
}

/** notional / leverage; null when it cannot be computed. */
export function marginAt(notional: DecimalInput | null, leverage: DecimalInput | null): Decimal | null {
  const n = safeDecimal(notional);
  const l = safeDecimal(leverage);
  if (n === null || l === null || !l.gt(0)) return null;
  return n.div(l);
}

/** The notional of `contracts` at `price` in the quote currency; null when either is missing or not positive. */
export function notionalOf(contracts: DecimalInput | null, price: DecimalInput | null, inst: Instrument): Decimal | null {
  const c = safeDecimal(contracts);
  const p = safeDecimal(price);
  if (c === null || p === null || !c.gt(0) || !p.gt(0)) return null;
  return notionalQuote(c, p, inst);
}

// ---- the size the risk limits allow ----

/** Which limit cut a size: the per-order notional, the coin's position notional, the total position notional, the available balance. */
export type CapBound = 'order' | 'instrument' | 'total' | 'balance';

export interface SizeLimits {
  /** The risk limits (RiskConfig); null while unknown */
  maxOrderNotional: string | null;
  maxPositionNotionalPerInstrument: string | null;
  maxTotalPositionNotional: string | null;
  /**
   * How much worse than the reference price the risk engine may value a market fill (RiskConfig.maxSlippagePct: a
   * fill that slips more is refused anyway); null for a limit order, valued at its price
   */
  slippagePct: string | null;
  /** What is held on the coin and in total now, as the engine projects it: positions and resting opening orders (exposureNow) */
  instrumentNotional: string;
  totalNotional: string;
  /** Quote currency available for the margin and the fee; null when unknown */
  availEq: string | null;
  leverage: string | null;
  feeRate: string;
}

export interface CappedSize {
  contracts: string;
  /** What each contract is counted at against the limits, in the quote currency: the entry, a market fill `slippagePct` worse */
  perContract: string;
  /** The limit that cut the size; null when none did */
  bound: CapBound | null;
  /** The figure of that limit, in the quote currency ('' without one) */
  limit: string;
  /** The most contracts the tightest limit allows, in whole lots */
  max: string;
  /** The tightest limit allows less than the minimum order: `contracts` is the minimum, which the engine will refuse */
  belowMin: boolean;
}

/**
 * `contracts` cut to what the risk limits allow at `entry`: the per-order notional, the coin's position limit less what
 * is held on it, the total limit less what is held, and the available balance for the margin (notional / leverage)
 * plus the taker fee; each contract valued at the entry, a market fill `slippagePct` worse. Whole lots rounded down,
 * never below the minimum order (then `belowMin`). null when the size or the entry is not a number.
 */
export function capContracts(contracts: DecimalInput | null, entry: DecimalInput | null, inst: Instrument, limits: SizeLimits): CappedSize | null {
  const c = safeDecimal(contracts);
  const e = safeDecimal(entry);
  if (c === null || e === null || !c.gt(0) || !e.gt(0) || inst.ctType !== 'linear') return null;
  const slip = safeDecimal(limits.slippagePct) ?? ZERO;
  const valued = notionalQuote(1, e, inst).mul(D(1).plus(slip));
  const rooms: Array<{ bound: CapBound; limit: string; room: Decimal }> = [];
  const push = (bound: CapBound, limit: string | null, roomQuote: Decimal | null) => {
    if (limit === null || roomQuote === null) return;
    rooms.push({ bound, limit, room: roomQuote.div(valued) });
  };
  push('order', limits.maxOrderNotional, safeDecimal(limits.maxOrderNotional));
  const perCoin = safeDecimal(limits.maxPositionNotionalPerInstrument);
  push('instrument', limits.maxPositionNotionalPerInstrument, perCoin === null ? null : perCoin.minus(safeDecimal(limits.instrumentNotional) ?? ZERO));
  const total = safeDecimal(limits.maxTotalPositionNotional);
  push('total', limits.maxTotalPositionNotional, total === null ? null : total.minus(safeDecimal(limits.totalNotional) ?? ZERO));
  const avail = safeDecimal(limits.availEq);
  const lev = safeDecimal(limits.leverage);
  const fee = safeDecimal(limits.feeRate) ?? ZERO;
  if (avail !== null && lev !== null && lev.gt(0)) {
    // margin + fee a contract costs: valued x (1 / leverage + feeRate)
    const cost = valued.mul(D(1).div(lev).plus(fee));
    rooms.push({ bound: 'balance', limit: avail.toFixed(), room: avail.div(cost) });
  }
  let tightest: { bound: CapBound; limit: string; room: Decimal } | null = null;
  for (const r of rooms) if (tightest === null || r.room.lt(tightest.room)) tightest = r;
  const max = tightest === null ? null : Decimal.max(floorToStep(tightest.room, inst.lotSz), ZERO);
  const perContract = valued.toFixed();
  if (tightest === null || max === null || max.gte(c)) {
    return { contracts: c.toFixed(), perContract, bound: null, limit: tightest?.limit ?? '', max: max === null ? c.toFixed() : max.toFixed(), belowMin: false };
  }
  const belowMin = max.lt(inst.minSz);
  return { contracts: (belowMin ? D(inst.minSz) : max).toFixed(), perContract, bound: tightest.bound, limit: tightest.limit, max: max.toFixed(), belowMin };
}

/** True when the order can only reduce exposure: the closing direction of a leg, or reduce-only in net mode (as the risk engine counts). */
const closingOrder = (o: Pick<Order, 'side' | 'posSide' | 'reduceOnly'>): boolean => (o.posSide === 'long' ? o.side === 'sell' : o.posSide === 'short' ? o.side === 'buy' : o.reduceOnly);

/**
 * What is held now, as the risk engine projects an opening order: the notional of every position (gross of both legs)
 * and the unfilled notional of every resting opening order with a price, on `instId` and in total. An order whose
 * instrument is not among `instruments` cannot be valued and is left out (the engine refuses then: EXPOSURE_UNKNOWN).
 */
export function exposureNow(instId: string, positions: readonly Position[], orders: readonly Order[], instruments: readonly Instrument[]): { instrument: Decimal; total: Decimal } {
  const instOf = (id: string): Instrument | undefined => instruments.find((i) => i.instId === id);
  let instrument = ZERO;
  let total = ZERO;
  const add = (id: string, n: Decimal) => {
    total = total.plus(n);
    if (id === instId) instrument = instrument.plus(n);
  };
  for (const p of positions) {
    const pos = safeDecimal(p.pos) ?? ZERO;
    if (pos.isZero()) continue;
    let n = (safeDecimal(p.notionalUsd) ?? ZERO).abs();
    const inst = instOf(p.instId);
    const mark = safeDecimal(p.markPx);
    if (n.isZero() && inst !== undefined && mark !== null && mark.gt(0)) n = notionalQuote(pos.abs(), mark, inst);
    add(p.instId, n);
  }
  for (const o of orders) {
    if (closingOrder(o) || o.px === '' || o.ordType === 'market') continue;
    const inst = instOf(o.instId);
    const remaining = (safeDecimal(o.sz) ?? ZERO).minus(safeDecimal(o.accFillSz) ?? ZERO);
    const px = safeDecimal(o.px);
    if (inst === undefined || px === null || !remaining.gt(0)) continue;
    add(o.instId, notionalQuote(remaining, px, inst));
  }
  return { instrument, total };
}
