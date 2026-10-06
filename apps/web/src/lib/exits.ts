import {
  CALLBACK_RATIO_MAX,
  CALLBACK_RATIO_MIN,
  CHANNEL_BARS_MAX,
  CHANNEL_BARS_MIN,
  D,
  ZERO,
  ceilToStep,
  floorToStep,
  toPlainString,
  type AlgoOrder,
  type ChannelTrailingEntry,
  type Decimal,
  type Instrument,
  type Position,
  type TakeProfitLeg,
  type TrailingExit,
  algoOrderClosesPosition,
} from '@pegasus/shared';
import { isDecimalText, safeDecimal } from './format';

/**
 * The exit plan as the forms hold it (the confirmation sheet, the order ticket, the exits of a position) and the
 * request fields it becomes: `takeProfits`, `breakevenAfterTp1` and `trailing` of PlaceOrderRequest, or the bodies of
 * the position routes. docs/api.md, "Exit orders".
 */

export type TpMode = 'none' | 'single' | 'ladder';
/** A take-profit given as a price, or as a multiple of the risk distance (entry to stop) beyond the entry. */
export type TpBasis = 'price' | 'r';
export type TrailingMode = 'none' | 'channel' | 'callback';

export interface TpRow {
  basis: TpBasis;
  /** A price, or an R multiple */
  value: string;
  /** Percent of the size; the last row of an opening order's ladder takes the rest and ignores it */
  pct: string;
}

export interface ExitForm {
  tpMode: TpMode;
  single: TpRow;
  ladder: TpRow[];
  /** The stop moves to the entry price once the first take-profit has filled (two legs or more, with a stop) */
  breakeven: boolean;
  trailing: TrailingMode;
  channelBars: string;
  /** Percent, '5' is 5% */
  callbackPct: string;
  activePx: string;
}

/** At most this many take-profit legs (the API's limit). */
export const MAX_TP_LEGS = 5;

export function defaultExitForm(trailing: TrailingMode = 'none', channelBars = 10): ExitForm {
  return {
    tpMode: 'none',
    single: { basis: 'price', value: '', pct: '100' },
    ladder: [
      { basis: 'price', value: '', pct: '50' },
      { basis: 'price', value: '', pct: '' },
    ],
    breakeven: false,
    trailing,
    channelBars: String(channelBars),
    callbackPct: '5',
    activePx: '',
  };
}

/** Why the exit part of a form does not make a request yet; `leg` is 1-based. */
export type ExitFormError =
  | { code: 'TP_VALUE'; leg: number }
  | { code: 'TP_R_NEEDS_STOP'; leg: number }
  | { code: 'TP_PCT'; leg: number }
  | { code: 'TP_REST' }
  | { code: 'TP_OVER_100' }
  | { code: 'BREAKEVEN' }
  | { code: 'CHANNEL_BARS' }
  | { code: 'CALLBACK_RATIO' }
  | { code: 'ACTIVE_PX' };

export interface ExitFields {
  takeProfits?: TakeProfitLeg[];
  breakevenAfterTp1?: true;
  trailing?: TrailingExit;
}

export interface ExitContext {
  /** long for an opening buy, short for an opening sell */
  direction: 'long' | 'short';
  /** The entry the R multiples are measured from; null when unknown */
  entry: string | null;
  /** The stop; null without one */
  stop: string | null;
  inst: Instrument | null;
  /**
   * true for an opening order: its legs cover the whole order, so the last leg takes what the others leave. false
   * for an open position: every leg closes its own share and together they may cover less than all of it.
   */
  whole: boolean;
}

const positive = (s: string): Decimal | null => {
  const t = s.trim();
  if (!isDecimalText(t)) return null;
  const d = D(t);
  return d.gt(0) ? d : null;
};

/** The R distance: entry - stop for a long, stop - entry for a short; null when the stop is not on the losing side. */
export function riskDistance(ctx: Pick<ExitContext, 'direction' | 'entry' | 'stop'>): Decimal | null {
  const e = safeDecimal(ctx.entry);
  const s = safeDecimal(ctx.stop);
  if (e === null || s === null || !e.gt(0) || !s.gt(0)) return null;
  const distance = ctx.direction === 'long' ? e.minus(s) : s.minus(e);
  return distance.gt(0) ? distance : null;
}

/**
 * The trigger of a take-profit `r` risk distances beyond the entry, on the tick towards the entry (down for a long, up
 * for a short, as the API rounds it); null without an entry and a stop on the losing side.
 */
export function priceAtR(r: string, ctx: Pick<ExitContext, 'direction' | 'entry' | 'stop' | 'inst'>): string | null {
  const multiple = positive(r);
  const distance = riskDistance(ctx);
  const e = safeDecimal(ctx.entry);
  if (multiple === null || distance === null || e === null) return null;
  const raw = ctx.direction === 'long' ? e.plus(distance.mul(multiple)) : e.minus(distance.mul(multiple));
  if (!raw.gt(0)) return null;
  if (ctx.inst === null) return raw.toFixed();
  const tick = ctx.inst.tickSz;
  return toPlainString(ctx.direction === 'long' ? floorToStep(raw, tick) : ceilToStep(raw, tick), tick);
}

/** The trigger price of a row; null when it is not a usable price (yet). */
export function rowPrice(row: TpRow, ctx: ExitContext): string | null {
  if (row.basis === 'r') return priceAtR(row.value, ctx);
  const p = positive(row.value);
  return p === null ? null : p.toFixed();
}

/** The R multiple a price stands for; null without an entry and a stop on the losing side. */
export function rMultipleOf(price: string, ctx: Pick<ExitContext, 'direction' | 'entry' | 'stop'>): Decimal | null {
  const p = safeDecimal(price);
  const e = safeDecimal(ctx.entry);
  const distance = riskDistance(ctx);
  if (p === null || e === null || distance === null) return null;
  return (ctx.direction === 'long' ? p.minus(e) : e.minus(p)).div(distance);
}

/** The share of the last leg of an opening order's ladder: 1 less the others'; null when a share before it is not a number. */
export function ladderRest(rows: readonly TpRow[]): Decimal | null {
  let used = ZERO;
  for (const row of rows.slice(0, -1)) {
    const p = positive(row.pct);
    if (p === null) return null;
    used = used.plus(p.div(100));
  }
  return D(1).minus(used);
}

function takeProfitLegs(form: ExitForm, ctx: ExitContext): { ok: true; legs: TakeProfitLeg[] } | { ok: false; error: ExitFormError } {
  const rows = form.tpMode === 'single' ? [form.single] : form.ladder;
  const legs: TakeProfitLeg[] = [];
  let used = ZERO;
  for (const [i, row] of rows.entries()) {
    const leg = i + 1;
    if (row.basis === 'r' && riskDistance(ctx) === null) return { ok: false, error: { code: 'TP_R_NEEDS_STOP', leg } };
    const px = rowPrice(row, ctx);
    if (px === null) return { ok: false, error: { code: 'TP_VALUE', leg } };
    let fraction: Decimal;
    if (form.tpMode === 'single') {
      fraction = ctx.whole ? D(1) : (positive(row.pct) ?? ZERO).div(100);
      if (!fraction.gt(0) || fraction.gt(1)) return { ok: false, error: { code: 'TP_PCT', leg } };
    } else if (ctx.whole && i === rows.length - 1) {
      fraction = D(1).minus(used);
      if (!fraction.gt(0)) return { ok: false, error: { code: 'TP_REST' } };
    } else {
      const pct = positive(row.pct);
      if (pct === null || pct.gt(100)) return { ok: false, error: { code: 'TP_PCT', leg } };
      fraction = pct.div(100);
    }
    used = used.plus(fraction);
    if (used.gt(1)) return { ok: false, error: { code: 'TP_OVER_100' } };
    legs.push({ triggerPx: px, fraction: fraction.toFixed() });
  }
  return { ok: true, legs };
}

function trailingExit(form: ExitForm): { ok: true; trailing: TrailingExit | null } | { ok: false; error: ExitFormError } {
  if (form.trailing === 'none') return { ok: true, trailing: null };
  if (form.trailing === 'channel') {
    const text = form.channelBars.trim();
    const bars = /^\d+$/.test(text) ? Number(text) : NaN;
    if (!Number.isInteger(bars) || bars < CHANNEL_BARS_MIN || bars > CHANNEL_BARS_MAX) return { ok: false, error: { code: 'CHANNEL_BARS' } };
    return { ok: true, trailing: { kind: 'channel', bars } };
  }
  const pct = positive(form.callbackPct);
  const ratio = pct === null ? null : pct.div(100);
  if (ratio === null || ratio.lt(CALLBACK_RATIO_MIN) || ratio.gt(CALLBACK_RATIO_MAX)) return { ok: false, error: { code: 'CALLBACK_RATIO' } };
  const active = form.activePx.trim();
  if (active === '') return { ok: true, trailing: { kind: 'callback', ratio: ratio.toFixed() } };
  const activePx = positive(active);
  if (activePx === null) return { ok: false, error: { code: 'ACTIVE_PX' } };
  return { ok: true, trailing: { kind: 'callback', ratio: ratio.toFixed(), activePx: activePx.toFixed() } };
}

/** Whether the cost-price stop can be asked for: a stop and two take-profit legs or more. */
export const breakevenAllowed = (form: Pick<ExitForm, 'tpMode' | 'ladder'>, hasStop: boolean): boolean => hasStop && form.tpMode === 'ladder' && form.ladder.length >= 2;

/** The request fields of the exit part of a form, or why there are none yet. */
export function buildExitFields(form: ExitForm, ctx: ExitContext): { ok: true; fields: ExitFields } | { ok: false; error: ExitFormError } {
  const fields: ExitFields = {};
  if (form.tpMode !== 'none') {
    const tp = takeProfitLegs(form, ctx);
    if (!tp.ok) return tp;
    fields.takeProfits = tp.legs;
    if (form.breakeven && form.tpMode === 'ladder') {
      if (!breakevenAllowed(form, ctx.stop !== null)) return { ok: false, error: { code: 'BREAKEVEN' } };
      fields.breakevenAfterTp1 = true;
    }
  }
  const trailing = trailingExit(form);
  if (!trailing.ok) return trailing;
  if (trailing.trailing !== null) fields.trailing = trailing.trailing;
  return { ok: true, fields };
}

// ---- the exits resting for a position ----

/** The take-profit orders of a position (an `oco` order is its stop as well). */
export const takeProfitsOf = (p: Position, orders: readonly AlgoOrder[]): AlgoOrder[] =>
  orders.filter((a) => a.tpTriggerPx !== '' && algoOrderClosesPosition(a, p)).sort((a, b) => (D(a.tpTriggerPx).lt(b.tpTriggerPx) ? -1 : 1));

/** The exchange's trailing stops (OKX move_order_stop) of a position. */
export const trailingStopsOf = (p: Position, orders: readonly AlgoOrder[]): AlgoOrder[] => orders.filter((a) => a.ordType === 'move_order_stop' && algoOrderClosesPosition(a, p));

/** The channel trailing kept for a position, if any. */
export const channelOf = (p: Position, entries: readonly ChannelTrailingEntry[] | undefined): ChannelTrailingEntry | null =>
  entries?.find((e) => e.instId === p.instId && e.mgnMode === p.mgnMode && e.posSide === p.posSide) ?? null;
