import {
  D,
  ZERO,
  contractsToCoin,
  floorToStep,
  isolatedLongLiquidationPrice,
  notionalQuote,
  type CampaignFollowPlan,
  type CampaignPlanWarningCode,
  type CampaignSignalReasonCode,
  type CampaignSignalRow,
  type CampaignSignalState,
  type Decimal,
  type DecimalInput,
  type Instrument,
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
}

type Kind = 'px' | 'pct' | 'ct' | 'usdt' | 'time' | 'halfDayClose' | 'dayClose' | 'raw';

const EMPTY_TEXT: CodeText = {
  close: '', level: '', markPx: '', distancePct: '', nearPct: '', contracts: '', trailingLine: '', addTrigger: '', trigger: '', addRef: '', barClose: '',
  avgPx: '', have: '', need: '', message: '', stopPx: '', entryPx: '', stopDistancePct: '', limit: '', sized: '', minSz: '', riskAmount: '', notional: '',
  projected: '', closedAt: '', ageMs: '', risePct: '', leverage: '', maxLeverage: '', liqPx: '',
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
  SIGNAL_STALE: { barTs: 'dayClose', closedAt: 'time', ageMs: 'raw' },
  PRICE_FAR_ABOVE_SIGNAL: { markPx: 'px', close: 'px', risePct: 'pct', limit: 'pct' },
  EQUITY_UNKNOWN: {},
  LINEAR_ONLY: {},
  LEVERAGE_REDUCED: { leverage: 'raw', maxLeverage: 'raw' },
  LIQUIDATION_NEAR_STOP: { liqPx: 'px', stopPx: 'px' },
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

/** notional / leverage; null when it cannot be computed. */
export function marginAt(notional: DecimalInput | null, leverage: DecimalInput | null): Decimal | null {
  const n = safeDecimal(notional);
  const l = safeDecimal(leverage);
  if (n === null || l === null || !l.gt(0)) return null;
  return n.div(l);
}
