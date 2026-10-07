import {
  CALLBACK_RATIO_MAX,
  CALLBACK_RATIO_MIN,
  CHANNEL_BARS_MAX,
  CHANNEL_BARS_MIN,
  D,
  Decimal,
  ZERO,
  ceilToStep,
  contractsToCoin,
  floorToStep,
  sizeTakeProfitLegs,
  toPlainString,
  type AlgoOrder,
  type ChannelTrailingEntry,
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
 *
 * Every take-profit level is proposed by the program (proposeTakeProfits): with a stop, R multiples of the distance
 * from the entry to the stop (TP_PROPOSAL.r: 2R alone; 1.5R and 3R for a ladder, with the cost-price stop); without
 * one, percentages from the entry (TP_PROPOSAL.pct: 10%; 5% and 10%). A row the trader has not written in (empty, or
 * still holding a proposal) is proposed again when the stop appears or goes; a row they wrote stays theirs. The stop
 * of the context is the one the order will have: the stop attached to it or, with none attached, the one channel
 * trailing puts after the fill (ExitContext.stopAttached tells them apart: only an attached stop can move to the
 * entry after the first take-profit).
 */

export type TpMode = 'none' | 'single' | 'ladder';
/** A take-profit given as a price, as a multiple of the risk distance (entry to stop) beyond the entry, or as a percentage from the entry. */
export type TpBasis = 'price' | 'r' | 'pct';
export type TrailingMode = 'none' | 'channel' | 'callback';

export interface TpRow {
  basis: TpBasis;
  /** A price, an R multiple or a percentage */
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

/** The program's take-profit levels: R multiples with a stop, percentages from the entry without one; a ladder is spread evenly between its two ends. */
const TP_PROPOSAL = {
  single: { r: '2', pct: '10' },
  ladder: { r: ['1.5', '3'], pct: ['5', '10'] },
} as const;

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

/**
 * Why the exit part of a form does not make a request yet; `leg` is 1-based. TP_NEEDS_ENTRY: an R or % level without
 * an entry price to measure it from (a limit order without its price); TP_ORDER: a leg not beyond the leg before it.
 */
export type ExitFormError =
  | { code: 'TP_VALUE'; leg: number }
  | { code: 'TP_NEEDS_ENTRY'; leg: number }
  | { code: 'TP_R_NEEDS_STOP'; leg: number }
  | { code: 'TP_WRONG_SIDE'; leg: number }
  | { code: 'TP_ORDER'; leg: number }
  | { code: 'TP_PCT'; leg: number }
  | { code: 'TP_LEG_TOO_SMALL'; leg: number }
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
  /** The entry the R multiples and the percentages are measured from; null when unknown */
  entry: string | null;
  /** The stop the order will have: the one attached to it, or the one channel trailing puts after the fill; null without one */
  stop: string | null;
  /**
   * Whether `stop` is attached to the order (slTriggerPx), which the exchange can move to the entry after the first
   * take-profit; false for the stop channel trailing puts after the fill. true when not given.
   */
  stopAttached?: boolean;
  inst: Instrument | null;
  /**
   * true for an opening order: its legs cover the whole order, so the last leg takes what the others leave. false
   * for an open position: every leg closes its own share and together they may cover less than all of it.
   */
  whole: boolean;
  /** The contracts of the order (or of the position) the legs are shares of; null when unknown */
  contracts?: string | null;
  /**
   * For a position with take-profits resting: the farthest of them (the highest for a long, the lowest for a short),
   * which every level the program proposes is lifted beyond; null without one.
   */
  beyond?: string | null;
  /** For a position: the share of it no resting take-profit covers, a fraction ('0.5'); the whole position when not given */
  uncovered?: string | null;
}

/** What the program's proposal reads of the context: the entry and the stop its levels are measured from, and the resting legs to be beyond. */
export type ProposalContext = Pick<ExitContext, 'direction' | 'entry' | 'stop' | 'beyond' | 'uncovered'> & { inst?: Instrument | null };

const positive = (s: string): Decimal | null => {
  const t = s.trim();
  if (!isDecimalText(t)) return null;
  const d = D(t);
  return d.gt(0) ? d : null;
};

/** On the tick towards the entry: down for a long, up for a short, as the API rounds a trigger. */
function onTick(raw: Decimal, ctx: Pick<ExitContext, 'direction' | 'inst'>): string {
  if (ctx.inst === null) return raw.toFixed();
  const tick = ctx.inst.tickSz;
  return toPlainString(ctx.direction === 'long' ? floorToStep(raw, tick) : ceilToStep(raw, tick), tick);
}

/** The R distance: entry - stop for a long, stop - entry for a short; null when the stop is not on the losing side. */
export function riskDistance(ctx: Pick<ExitContext, 'direction' | 'entry' | 'stop'>): Decimal | null {
  const e = safeDecimal(ctx.entry);
  const s = safeDecimal(ctx.stop);
  if (e === null || s === null || !e.gt(0) || !s.gt(0)) return null;
  const distance = ctx.direction === 'long' ? e.minus(s) : s.minus(e);
  return distance.gt(0) ? distance : null;
}

/** Whether the order has a stop on the losing side attached to it: what the cost-price stop needs (the exchange moves an attached stop only). */
export const stopAttachedOf = (ctx: Pick<ExitContext, 'direction' | 'entry' | 'stop' | 'stopAttached'>): boolean => riskDistance(ctx) !== null && (ctx.stopAttached ?? true);

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
  return raw.gt(0) ? onTick(raw, ctx) : null;
}

/** The trigger of a take-profit `pct` percent beyond the entry (above for a long, below for a short), on the tick towards the entry; null without an entry. */
export function priceAtPct(pct: string, ctx: Pick<ExitContext, 'direction' | 'entry' | 'inst'>): string | null {
  const share = positive(pct);
  const e = safeDecimal(ctx.entry);
  if (share === null || e === null || !e.gt(0)) return null;
  const raw = ctx.direction === 'long' ? e.mul(D(1).plus(share.div(100))) : e.mul(D(1).minus(share.div(100)));
  return raw.gt(0) ? onTick(raw, ctx) : null;
}

/**
 * The trigger price of a row, on the tick towards the entry (a typed price off the tick is rounded as the API rounds
 * it: down for a long, up for a short); null when it is not a usable price (yet).
 */
export function rowPrice(row: TpRow, ctx: Pick<ExitContext, 'direction' | 'entry' | 'stop' | 'inst'>): string | null {
  if (row.basis === 'r') return priceAtR(row.value, ctx);
  if (row.basis === 'pct') return priceAtPct(row.value, ctx);
  const p = positive(row.value);
  if (p === null) return null;
  const px = onTick(p, ctx);
  return D(px).gt(0) ? px : null;
}

/** Whether a typed price is not on the tick: the row stands for another price than the one written (rowPrice). */
export function offTick(row: TpRow, ctx: Pick<ExitContext, 'direction' | 'inst'>): boolean {
  if (row.basis !== 'price' || ctx.inst === null) return false;
  const p = positive(row.value);
  return p !== null && !p.eq(onTick(p, ctx));
}

/** The R multiple a price stands for; null without an entry and a stop on the losing side. */
export function rMultipleOf(price: string, ctx: Pick<ExitContext, 'direction' | 'entry' | 'stop'>): Decimal | null {
  const p = safeDecimal(price);
  const e = safeDecimal(ctx.entry);
  const distance = riskDistance(ctx);
  if (p === null || e === null || distance === null) return null;
  return (ctx.direction === 'long' ? p.minus(e) : e.minus(p)).div(distance);
}

/** The gain a price stands for as a fraction of the entry (positive on the profit side); null without an entry. */
export function gainOf(price: string, ctx: Pick<ExitContext, 'direction' | 'entry'>): Decimal | null {
  const p = safeDecimal(price);
  const e = safeDecimal(ctx.entry);
  if (p === null || e === null || !e.gt(0)) return null;
  return (ctx.direction === 'long' ? p.minus(e) : e.minus(p)).div(e);
}

/** Whether `price` is on the profit side of the entry; true when the entry is unknown. */
function onProfitSide(price: string, ctx: Pick<ExitContext, 'direction' | 'entry'>): boolean {
  const g = gainOf(price, ctx);
  return g === null || g.gt(0);
}

// ---- the program's proposal ----

/** A decimal with at most `dp` decimals and no trailing zeros. */
const short = (d: Decimal, dp: number): string => d.toDecimalPlaces(dp).toFixed();

/** The levels of `n` legs spread evenly from the first to the last of the two ends of TP_PROPOSAL.ladder. */
function spread(ends: readonly [string, string], n: number): string[] {
  if (n <= 1) return [ends[0]];
  const first = D(ends[0]);
  const step = D(ends[1]).minus(first).div(n - 1);
  return Array.from({ length: n }, (_, i) => short(first.plus(step.mul(i)), 2));
}

/**
 * The shares of `n` legs: the same share for each, rounded down to a whole percent; the last leg of an opening order
 * takes the rest (its share is ''), that of a position the remainder.
 */
export function proposedShares(n: number, whole: boolean): string[] {
  if (n <= 1) return ['100'];
  const each = Math.floor(100 / n);
  const rest = 100 - each * (n - 1);
  return Array.from({ length: n }, (_, i) => (i < n - 1 ? String(each) : whole ? '' : String(rest)));
}

/** Whether `px` is beyond `prev` on the profit side: higher for a long, lower for a short. */
const beyond = (px: string, prev: Decimal, direction: 'long' | 'short'): boolean => (direction === 'long' ? D(px).gt(prev) : D(px).lt(prev));

/** The whole step the program's levels are lifted by while they are not beyond the resting legs: 1R, or 5%. */
const LIFT_STEP = { r: '1', pct: '5' } as const;

/**
 * The proposed values lifted, all by the same number of whole steps (LIFT_STEP), until the first of them comes to a
 * price beyond `ctx.beyond` (the farthest take-profit resting for a position); as they are without one, or without
 * an entry (and a stop, for R) to measure them from.
 */
function liftBeyond(values: string[], basis: 'r' | 'pct', ctx: ProposalContext): string[] {
  const floor = safeDecimal(ctx.beyond ?? null);
  const first = values[0];
  if (floor === null || first === undefined) return values;
  const step = D(LIFT_STEP[basis]);
  const priced = { ...ctx, inst: ctx.inst ?? null };
  for (let k = 0; k < 100; k++) {
    const offset = step.mul(k);
    const px = rowPrice({ basis, value: D(first).plus(offset).toFixed(), pct: '' }, priced);
    if (px === null) return values;
    if (beyond(px, floor, ctx.direction)) return k === 0 ? values : values.map((v) => short(D(v).plus(offset), 2));
  }
  return values;
}

/**
 * proposedShares out of the share of a position no resting take-profit covers (`uncovered`, a fraction): that share
 * split evenly in whole percents, the last leg taking the remainder; '' for a leg that gets nothing (the resting legs
 * cover the position). The usual shares for an opening order, or when the whole position is free.
 */
function scaledShares(n: number, whole: boolean, uncovered: string | null | undefined): string[] {
  const u = safeDecimal(uncovered ?? null);
  if (whole || u === null || u.gte(1)) return proposedShares(n, whole);
  const total = Decimal.max(ZERO, u.mul(100).floor());
  const each = n <= 1 ? total : total.div(n).floor();
  const rest = total.minus(each.mul(n - 1));
  return Array.from({ length: n }, (_, i) => {
    const share = i < n - 1 ? each : rest;
    return share.gt(0) ? share.toFixed() : '';
  });
}

/**
 * The program's take-profit rows for a mode: `n` legs of a ladder (one for single), R multiples with a stop,
 * percentages without; given the context of a position, lifted beyond its resting take-profits (liftBeyond) and
 * sharing out what they leave of it (scaledShares).
 */
export function proposedRows(mode: 'single' | 'ladder', n: number, hasStop: boolean, whole = true, ctx?: ProposalContext): TpRow[] {
  const basis: TpBasis = hasStop ? 'r' : 'pct';
  const values = mode === 'single' ? [hasStop ? TP_PROPOSAL.single.r : TP_PROPOSAL.single.pct] : spread(hasStop ? TP_PROPOSAL.ladder.r : TP_PROPOSAL.ladder.pct, n);
  const lifted = ctx === undefined ? values : liftBeyond(values, basis, ctx);
  const shares = ctx === undefined ? proposedShares(n, whole) : scaledShares(n, whole, ctx.uncovered);
  return lifted.map((value, i) => ({ basis, value, pct: shares[i] ?? '' }));
}

/** Whether the row's level is the program's (empty, or a proposal for either stop state): the trader has not written one. */
function untouchedLevel(row: TpRow, i: number, mode: 'single' | 'ladder', n: number, ctx?: ProposalContext): boolean {
  if (row.value.trim() === '') return true;
  return [true, false].some((hasStop) => {
    const p = proposedRows(mode, n, hasStop, true, ctx)[i];
    return p !== undefined && p.basis === row.basis && p.value === row.value.trim();
  });
}

/** Whether the shares are the program's even split (or not filled in yet). */
function untouchedShares(rows: readonly TpRow[], whole: boolean): boolean {
  const even = proposedShares(rows.length, whole);
  return rows.every((row, i) => row.pct.trim() === '' || row.pct.trim() === even[i]);
}

/**
 * The form with the program's levels in every row of the chosen take-profit mode that the trader has not written
 * in, for the stop as it is now (R multiples with one, percentages without); a ladder left to the program also gets
 * its even shares and, with a stop attached to the order, the cost-price stop. `force` writes every row. The same
 * object comes back when nothing changes.
 */
export function proposeTakeProfits(form: ExitForm, ctx: ProposalContext & Pick<ExitContext, 'stopAttached' | 'whole'>, force = false): ExitForm {
  return proposeLevels(form, riskDistance(ctx) !== null, ctx.whole, force, stopAttachedOf(ctx), false, ctx);
}

/**
 * proposeTakeProfits from whether there is a stop on the losing side (`hasStop`) and whether it is attached to the
 * order (`breakevenOk`, the cost-price stop's condition; `hasStop` when not given): the levels are R multiples or
 * percentages, so nothing else of the context matters, and an effect can run on that alone (not on every tick of
 * the entry price). `stopAttachedNow`: a stop has just been attached (the channel's stood in for it before, so the
 * levels do not change), and a ladder left to the program takes the cost-price stop again. `ctx`, for a position:
 * the resting take-profits the levels are lifted beyond and share out what they leave.
 */
export function proposeLevels(form: ExitForm, hasStop: boolean, whole: boolean, force = false, breakevenOk = hasStop, stopAttachedNow = false, ctx?: ProposalContext): ExitForm {
  if (form.tpMode === 'single') {
    if (!force && !untouchedLevel(form.single, 0, 'single', 1, ctx)) return form;
    const p = proposedRows('single', 1, hasStop, whole, ctx)[0];
    if (p === undefined) return form;
    // the share: the program's (the whole position, or what the resting legs leave of it) where the row has none or the default
    const untouchedShare = form.single.pct.trim() === '' || form.single.pct.trim() === '100';
    const single: TpRow = { ...p, pct: untouchedShare ? p.pct : form.single.pct };
    return sameRow(single, form.single) ? form : { ...form, single };
  }
  if (form.tpMode === 'ladder') {
    const n = form.ladder.length;
    const proposal = proposedRows('ladder', n, hasStop, whole, ctx);
    const allLevels = force || form.ladder.every((row, i) => untouchedLevel(row, i, 'ladder', n, ctx));
    const shares = force || (allLevels && untouchedShares(form.ladder, whole));
    const ladder = form.ladder.map((row, i) => {
      const p = proposal[i];
      if (p === undefined || (!force && !untouchedLevel(row, i, 'ladder', n, ctx))) return row;
      return { basis: p.basis, value: p.value, pct: shares ? p.pct : row.pct };
    });
    const changed = !ladder.every((row, i) => sameRow(row, form.ladder[i]));
    // a ladder left to the program comes with the cost-price stop while a stop is attached; a choice made since stays,
    // except that without an attached stop the cost-price stop can never be asked for
    const breakeven = !breakevenOk ? false : allLevels && (changed || stopAttachedNow) ? whole && n >= 2 : form.breakeven;
    if (!changed && breakeven === form.breakeven) return form;
    return { ...form, ladder, breakeven };
  }
  return form;
}

/** The program's level written into one row of the chosen mode, whatever it held. */
export function proposeLeg(form: ExitForm, index: number, ctx: ProposalContext & Pick<ExitContext, 'whole'>): ExitForm {
  const hasStop = riskDistance(ctx) !== null;
  if (form.tpMode === 'single') {
    const p = proposedRows('single', 1, hasStop, ctx.whole, ctx)[0];
    return p === undefined ? form : { ...form, single: { ...form.single, basis: p.basis, value: p.value } };
  }
  if (form.tpMode !== 'ladder') return form;
  const p = proposedRows('ladder', form.ladder.length, hasStop, ctx.whole, ctx)[index];
  if (p === undefined) return form;
  return { ...form, ladder: form.ladder.map((row, i) => (i === index ? { ...row, basis: p.basis, value: p.value } : row)) };
}

const sameRow = (a: TpRow, b: TpRow | undefined): boolean => b !== undefined && a.basis === b.basis && a.value === b.value && a.pct === b.pct;

/**
 * `exact` (an R multiple or a percentage) written with the fewest decimals, from 2 to 8, at which it stands for the
 * price `px` again (rounded half up first, then up, since the price it gives is rounded to the tick towards the
 * entry): a conversion never moves the level by a tick. With 8 decimals otherwise.
 */
function exactValue(exact: Decimal, basis: 'r' | 'pct', px: string, ctx: Pick<ExitContext, 'direction' | 'entry' | 'stop' | 'inst'>): string {
  const target = ctx.inst === null ? px : onTick(D(px), ctx);
  for (const rounding of [Decimal.ROUND_HALF_UP, Decimal.ROUND_UP]) {
    for (let dp = 2; dp <= 8; dp++) {
      const value = exact.toDecimalPlaces(dp, rounding).toFixed();
      if (rowPrice({ basis, value, pct: '' }, ctx) === target) return value;
    }
  }
  return exact.toDecimalPlaces(8).toFixed();
}

/**
 * The row's value expressed in another basis, from the price it stands for now, with as many decimals as keep that
 * price (exactValue: 2R stays 0.3437 through 26.2211%); the value is kept when it cannot be converted.
 */
export function convertRow(row: TpRow, basis: TpBasis, ctx: Pick<ExitContext, 'direction' | 'entry' | 'stop' | 'inst'>): TpRow {
  if (basis === row.basis) return row;
  const px = rowPrice(row, ctx);
  // A row whose price cannot be computed (an R row without a stop, a % row without an entry) has no value in the new
  // basis: the number is cleared rather than carried over, where '2' R would read as a price of 2.
  if (px === null) return { ...row, basis, value: '' };
  if (basis === 'price') return { ...row, basis, value: ctx.inst === null ? px : toPlainString(px, ctx.inst.tickSz) };
  if (basis === 'r') {
    const r = rMultipleOf(px, ctx);
    return { ...row, basis, value: r === null ? '' : exactValue(r, 'r', px, ctx) };
  }
  const g = gainOf(px, ctx);
  return { ...row, basis, value: g === null ? '' : exactValue(g.mul(100), 'pct', px, ctx) };
}

/**
 * A ladder one leg longer: the new leg goes before the last. A ladder the trader has left to the program is proposed
 * again for its new length; otherwise the new leg takes the level halfway between its neighbours, in the basis of the
 * leg before it, and the shares are split evenly again only when they were the program's.
 */
export function addLadderLeg(form: ExitForm, ctx: ProposalContext & Pick<ExitContext, 'inst' | 'whole'>): ExitForm {
  const n = form.ladder.length;
  if (n >= MAX_TP_LEGS) return form;
  const hasStop = riskDistance(ctx) !== null;
  const allLevels = form.ladder.every((row, i) => untouchedLevel(row, i, 'ladder', n, ctx));
  const evenShares = untouchedShares(form.ladder, ctx.whole);
  let ladder: TpRow[];
  if (allLevels) {
    // the program's ladder, one leg longer: its levels spread again, and its shares when they were the program's
    const rows = proposedRows('ladder', n + 1, hasStop, ctx.whole, ctx);
    const shares = evenShares ? rows.map((r) => r.pct) : [...form.ladder.slice(0, -1).map((r) => r.pct), '', form.ladder[n - 1]?.pct ?? ''];
    ladder = rows.map((row, i) => ({ ...row, pct: shares[i] ?? '' }));
  } else {
    // the trader's ladder: the new leg halfway between its neighbours, in the basis of the leg before it
    const before = form.ladder[n - 2];
    const last = form.ladder[n - 1];
    const p1 = before === undefined ? null : rowPrice(before, ctx);
    const p2 = last === undefined ? null : rowPrice(last, ctx);
    let leg: TpRow = { basis: before?.basis ?? 'price', value: '', pct: '' };
    if (p1 !== null && p2 !== null && before !== undefined) leg = convertRow({ basis: 'price', value: onTick(D(p1).plus(p2).div(2), ctx), pct: '' }, before.basis, ctx);
    ladder = [...form.ladder.slice(0, -1), leg, ...form.ladder.slice(-1)];
    if (evenShares) {
      const even = proposedShares(n + 1, ctx.whole);
      ladder = ladder.map((row, i) => ({ ...row, pct: even[i] ?? '' }));
    }
  }
  return { ...form, ladder };
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

// ---- the request fields and the errors ----

interface TakeProfitCheck {
  legs: TakeProfitLeg[];
  errors: ExitFormError[];
}

/**
 * Every leg of the take-profit rows, and every error among them (one per row at most, then the shares together). A
 * row's level must be a number, measured from an entry when it is an R multiple or a percentage (and from a stop on
 * the losing side when an R multiple), on the profit side of the entry and beyond the leg before it; a leg sized
 * from the contracts (legSizes) must come to the minimum order at least, as the server sizes it.
 */
function takeProfitLegs(form: ExitForm, ctx: ExitContext): TakeProfitCheck {
  const rows = form.tpMode === 'single' ? [form.single] : form.ladder;
  const legs: TakeProfitLeg[] = [];
  const errors: ExitFormError[] = [];
  const entry = safeDecimal(ctx.entry);
  let used = ZERO;
  let sharesOk = true;
  let prev: Decimal | null = null;
  for (const [i, row] of rows.entries()) {
    const leg = i + 1;
    let px: string | null = null;
    if (row.basis !== 'price' && (entry === null || !entry.gt(0))) errors.push({ code: 'TP_NEEDS_ENTRY', leg });
    else if (row.basis === 'r' && riskDistance(ctx) === null) errors.push({ code: 'TP_R_NEEDS_STOP', leg });
    else {
      px = rowPrice(row, ctx);
      if (px === null) errors.push({ code: 'TP_VALUE', leg });
      else if (!onProfitSide(px, ctx)) {
        errors.push({ code: 'TP_WRONG_SIDE', leg });
        px = null;
      } else if (prev !== null && !beyond(px, prev, ctx.direction)) {
        errors.push({ code: 'TP_ORDER', leg });
        px = null;
      }
    }
    if (px !== null) prev = D(px);
    let fraction: Decimal | null = null;
    if (form.tpMode === 'single') {
      const f = ctx.whole ? D(1) : (positive(row.pct) ?? ZERO).div(100);
      if (!f.gt(0) || f.gt(1)) errors.push({ code: 'TP_PCT', leg });
      else fraction = f;
    } else if (ctx.whole && i === rows.length - 1) {
      const rest = D(1).minus(used);
      if (sharesOk && !rest.gt(0)) {
        errors.push({ code: 'TP_REST' });
        sharesOk = false;
      } else if (sharesOk) fraction = rest;
    } else {
      const pct = positive(row.pct);
      if (pct === null || pct.gt(100)) errors.push({ code: 'TP_PCT', leg });
      else fraction = pct.div(100);
    }
    if (fraction !== null) {
      used = used.plus(fraction);
      if (used.gt(1) && sharesOk) {
        errors.push({ code: 'TP_OVER_100' });
        sharesOk = false;
      }
    }
    if (px !== null && fraction !== null) legs.push({ triggerPx: px, fraction: fraction.toFixed() });
  }
  // every row fine: a leg the contracts size below the minimum order is refused by the server (TP_LEG_TOO_SMALL)
  if (errors.length === 0 && ctx.inst !== null) {
    const sizes = legSizes(
      legs.map((l) => D(l.fraction)),
      ctx,
    );
    sizes.forEach((sz, i) => {
      if (sz !== null && sz.lt(ctx.inst?.minSz ?? '0')) errors.push({ code: 'TP_LEG_TOO_SMALL', leg: i + 1 });
    });
  }
  return { legs, errors };
}

/**
 * The contracts of each leg out of `ctx.contracts` for the legs' fractions, as the API sizes them (sizeTakeProfitLegs:
 * whole lots rounded down; the last leg of an opening order takes what the others leave, that of a position what the
 * legs cover together leaves); null for each without the contracts or the instrument.
 */
function legSizes(fractions: readonly Decimal[], ctx: ExitContext): Array<Decimal | null> {
  const total = safeDecimal(ctx.contracts ?? null);
  if (total === null || !total.gt(0) || ctx.inst === null || fractions.length === 0) return fractions.map(() => null);
  return sizeTakeProfitLegs(fractions, total, ctx.inst.lotSz, ctx.whole ? 'whole' : 'share');
}

function trailingExit(form: ExitForm): { trailing: TrailingExit | null; error: ExitFormError | null } {
  if (form.trailing === 'none') return { trailing: null, error: null };
  if (form.trailing === 'channel') {
    const text = form.channelBars.trim();
    const bars = /^\d+$/.test(text) ? Number(text) : NaN;
    if (!Number.isInteger(bars) || bars < CHANNEL_BARS_MIN || bars > CHANNEL_BARS_MAX) return { trailing: null, error: { code: 'CHANNEL_BARS' } };
    return { trailing: { kind: 'channel', bars }, error: null };
  }
  const pct = positive(form.callbackPct);
  const ratio = pct === null ? null : pct.div(100);
  if (ratio === null || ratio.lt(CALLBACK_RATIO_MIN) || ratio.gt(CALLBACK_RATIO_MAX)) return { trailing: null, error: { code: 'CALLBACK_RATIO' } };
  const active = form.activePx.trim();
  if (active === '') return { trailing: { kind: 'callback', ratio: ratio.toFixed() }, error: null };
  const activePx = positive(active);
  if (activePx === null) return { trailing: null, error: { code: 'ACTIVE_PX' } };
  return { trailing: { kind: 'callback', ratio: ratio.toFixed(), activePx: activePx.toFixed() }, error: null };
}

/** Whether the cost-price stop can be asked for: a stop on the losing side attached to the order (`stopAttached`, stopAttachedOf) and two take-profit legs or more. */
export const breakevenAllowed = (form: Pick<ExitForm, 'tpMode' | 'ladder'>, stopAttached: boolean): boolean => stopAttached && form.tpMode === 'ladder' && form.ladder.length >= 2;

export interface ExitFormCheck {
  /** The request fields of the parts of the form that are complete: the take-profits only when every leg is, the trailing stop on its own */
  fields: ExitFields;
  /** Everything wrong or missing, the take-profit rows first (one error per row at most), then the trailing stop */
  errors: ExitFormError[];
}

/**
 * The exit part of a form checked: the fields of what is complete, so the rest of an order can be previewed while a
 * leg is still being written, and every error, so each row can say its own.
 */
export function checkExitForm(form: ExitForm, ctx: ExitContext): ExitFormCheck {
  const fields: ExitFields = {};
  const errors: ExitFormError[] = [];
  if (form.tpMode !== 'none') {
    const tp = takeProfitLegs(form, ctx);
    errors.push(...tp.errors);
    if (tp.errors.length === 0) {
      fields.takeProfits = tp.legs;
      if (form.breakeven && form.tpMode === 'ladder') {
        if (!breakevenAllowed(form, stopAttachedOf(ctx))) errors.push({ code: 'BREAKEVEN' });
        else fields.breakevenAfterTp1 = true;
      }
    }
  }
  const trailing = trailingExit(form);
  if (trailing.error !== null) errors.push(trailing.error);
  else if (trailing.trailing !== null) fields.trailing = trailing.trailing;
  return { fields, errors };
}

/** The request fields of the exit part of a form, or why there are none yet (the first error). */
export function buildExitFields(form: ExitForm, ctx: ExitContext): { ok: true; fields: ExitFields } | { ok: false; error: ExitFormError } {
  const { fields, errors } = checkExitForm(form, ctx);
  const [error] = errors;
  return error === undefined ? { ok: true, fields } : { ok: false, error };
}

/** The error of a take-profit row among `errors`; null when the row is fine. */
export const rowError = (errors: readonly ExitFormError[], leg: number): ExitFormError | null => errors.find((e) => 'leg' in e && e.leg === leg) ?? null;

// ---- what a leg comes to ----

export interface LegFigures {
  /** The trigger price; null while the row has none */
  px: string | null;
  /** The R multiple the price stands for; null without a stop */
  r: Decimal | null;
  /** The gain from the entry, a fraction; null without an entry */
  gain: Decimal | null;
  /** The share of the size the leg closes; null while it is not known */
  fraction: Decimal | null;
  /** Contracts of the leg in whole lots (the last leg of an opening order takes the rest); null without the size */
  sz: Decimal | null;
  /** Profit in the quote currency if the leg fills at its price, from the entry; null without the size or the price */
  profit: Decimal | null;
}

/**
 * Each take-profit row of the form in figures: its price, R and gain, and the contracts and profit of its leg out of
 * `ctx.contracts`, sized as the API sizes the legs (sizeTakeProfitLegs: whole lots rounded down; the last leg of an
 * opening order takes what the others leave, that of a position what the legs cover together leaves). The last leg
 * has no contracts while another leg has no share yet.
 */
export function legFigures(form: ExitForm, ctx: ExitContext): LegFigures[] {
  const rows = form.tpMode === 'single' ? [form.single] : form.tpMode === 'ladder' ? form.ladder : [];
  const total = safeDecimal(ctx.contracts ?? null);
  const inst = ctx.inst;
  const e = safeDecimal(ctx.entry);
  const fractions = rows.map((row, i): Decimal | null => {
    let fraction: Decimal | null;
    if (form.tpMode === 'single') fraction = ctx.whole ? D(1) : (positive(row.pct)?.div(100) ?? null);
    else if (ctx.whole && i === rows.length - 1) fraction = ladderRest(rows);
    else fraction = positive(row.pct)?.div(100) ?? null;
    return fraction !== null && fraction.gt(0) && fraction.lte(1) ? fraction : null;
  });
  const known = fractions.flatMap((f) => (f === null ? [] : [f]));
  const sizes: Array<Decimal | null> =
    total === null || !total.gt(0) || inst === null
      ? rows.map(() => null)
      : known.length === rows.length
        ? legSizes(known, ctx)
        : fractions.map((f, i) => (f === null || i === rows.length - 1 ? null : floorToStep(total.mul(f), inst.lotSz)));
  return rows.map((row, i) => {
    const px = (row.basis !== 'price' && e === null) || (row.basis === 'r' && riskDistance(ctx) === null) ? null : rowPrice(row, ctx);
    const r = px === null ? null : rMultipleOf(px, ctx);
    const gain = px === null ? null : gainOf(px, ctx);
    const fraction = fractions[i] ?? null;
    const sz = sizes[i] ?? null;
    const profit = sz === null || px === null || e === null || inst === null || inst.ctType !== 'linear' ? null : (ctx.direction === 'long' ? D(px).minus(e) : e.minus(px)).mul(contractsToCoin(sz, inst));
    return { px, r, gain, fraction, sz, profit };
  });
}

/** Whether a callback trailing stop with `activePx` would not be armed at `price` yet: the price has not reached the activation (above it for a long, below it for a short). */
export function activationPending(price: string | null, activePx: string | null, direction: 'long' | 'short'): boolean {
  const p = safeDecimal(price);
  const a = positive(activePx ?? '');
  if (p === null || a === null) return false;
  return direction === 'long' ? p.lt(a) : p.gt(a);
}

/**
 * Where a callback trailing stop would trigger if it were armed now: `pct` percent back from `price`, or, while the
 * price has not reached `activePx` (activationPending), the earliest trigger once it does, `pct` percent back from the
 * activation price. null without a price.
 */
export function callbackTriggerNow(pct: string, price: string | null, ctx: Pick<ExitContext, 'direction' | 'inst'>, activePx: string | null = null): string | null {
  const share = positive(pct);
  const p = activationPending(price, activePx, ctx.direction) ? positive(activePx ?? '') : safeDecimal(price);
  if (share === null || p === null || !p.gt(0)) return null;
  const raw = ctx.direction === 'long' ? p.mul(D(1).minus(share.div(100))) : p.mul(D(1).plus(share.div(100)));
  if (!raw.gt(0)) return null;
  if (ctx.inst === null) return raw.toFixed();
  const tick = ctx.inst.tickSz;
  return toPlainString(ctx.direction === 'long' ? floorToStep(raw, tick) : ceilToStep(raw, tick), tick);
}

/** The lowest low (for a long; the highest high for a short) of the last `bars` confirmed daily bars: where channel trailing keeps the stop now. null with too few bars. */
export function channelLevelOf(candles: ReadonlyArray<{ ts: number; low: string; high: string; confirm: boolean }> | undefined, bars: number, direction: 'long' | 'short'): string | null {
  if (candles === undefined || !Number.isInteger(bars) || bars < 1) return null;
  const confirmed = candles.filter((c) => c.confirm).sort((a, b) => a.ts - b.ts).slice(-bars);
  if (confirmed.length < bars) return null;
  let level: Decimal | null = null;
  for (const c of confirmed) {
    const v = D(direction === 'long' ? c.low : c.high);
    if (level === null || (direction === 'long' ? v.lt(level) : v.gt(level))) level = v;
  }
  return level === null ? null : level.toFixed();
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
