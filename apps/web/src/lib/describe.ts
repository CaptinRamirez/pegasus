import type { Instrument, JournalEvent, TakeProfitLeg, TradePlan, TrailingExit } from '@pegasus/shared';
import type { EventText, Messages, TpLegText } from '../i18n/en';
import { labelOf } from '../i18n';
import {
  checkExitForm,
  gainOf,
  legFigures,
  proposedRows,
  riskDistance,
  rMultipleOf,
  rowError,
  rowPrice,
  type ExitContext,
  type ExitForm,
  type ExitFormError,
  type TpRow,
} from './exits';
import { DASH, fmtContracts, fmtLocalTime, fmtNum, fmtPct, fmtPx, fmtSigned, fmtUtcMinute, safeDecimal } from './format';

/** The program's proposal for a take-profit row in words, "0.3437 (2R)"; '' when there is none. */
function proposalText(form: ExitForm, leg: number, ctx: ExitContext, t: Messages): string {
  const p = proposedRow(form, leg, ctx);
  const px = p === undefined ? null : rowPrice(p, ctx);
  if (p === undefined || px === null) return '';
  return t.exits.proposal(fmtPx(px, ctx.inst), p.basis === 'r' ? t.exits.asR(p.value) : `${p.value}%`);
}

/** The program's row for a leg of the form's mode (its level and share), given the context (a position's resting legs among it). */
function proposedRow(form: ExitForm, leg: number, ctx: ExitContext): TpRow | undefined {
  const rows = form.tpMode === 'single' ? [form.single] : form.ladder;
  const mode = form.tpMode === 'single' ? 'single' : 'ladder';
  return proposedRows(mode, rows.length, riskDistance(ctx) !== null, ctx.whole, ctx)[leg - 1];
}

/**
 * An error of the exit form in words. A row not filled in yet is not blamed: the text says what is missing and the
 * program's proposal for it (`missing`); so does a level that only lacks its entry price. A level on the wrong side
 * of the entry is named with the entry it must beat and the proposal. Anything else is the error's sentence.
 */
export function exitErrorText(e: ExitFormError, form: ExitForm, ctx: ExitContext, t: Messages): { text: string; missing: boolean } {
  const words: Record<ExitFormError['code'], (leg: number) => string> = t.exits.error;
  if (!('leg' in e)) return { text: words[e.code](0), missing: false };
  const rows = form.tpMode === 'single' ? [form.single] : form.ladder;
  const row = rows[e.leg - 1];
  if (row !== undefined) {
    if (e.code === 'TP_NEEDS_ENTRY') return { text: words[e.code](e.leg), missing: true };
    if ((e.code === 'TP_VALUE' || e.code === 'TP_R_NEEDS_STOP') && row.value.trim() === '') return { text: t.exits.needPrice(e.leg, proposalText(form, e.leg, ctx, t)), missing: true };
    if (e.code === 'TP_PCT' && row.pct.trim() === '') return { text: t.exits.needShare(e.leg, proposedRow(form, e.leg, ctx)?.pct ?? ''), missing: true };
    if (e.code === 'TP_LEG_TOO_SMALL') {
      const sz = legFigures(form, ctx)[e.leg - 1]?.sz ?? null;
      return { text: t.exits.legTooSmall(e.leg, fmtContracts(sz, ctx.inst), fmtContracts(ctx.inst?.minSz ?? null, ctx.inst)), missing: false };
    }
    if (e.code === 'TP_WRONG_SIDE') {
      const px = rowPrice(row, ctx);
      const entry = safeDecimal(ctx.entry);
      if (px !== null && entry !== null) return { text: t.exits.wrongSide(e.leg, fmtPx(px, ctx.inst), fmtPx(entry.toFixed(), ctx.inst), ctx.direction === 'short', proposalText(form, e.leg, ctx, t)), missing: false };
    }
  }
  return { text: words[e.code](e.leg), missing: false };
}

/** An error of one take-profit row (every code that names a leg). */
type LegError = Extract<ExitFormError, { leg: number }>;

/** What is missing or wrong with a take-profit row, for the summary's leg ("not filled in, suggested 0.3437 (2R)"). */
function legProblemText(e: LegError, form: ExitForm, ctx: ExitContext, t: Messages): string {
  const rows = form.tpMode === 'single' ? [form.single] : form.ladder;
  const row = rows[e.leg - 1];
  const empty = row !== undefined && row.value.trim() === '';
  if ((e.code === 'TP_VALUE' || e.code === 'TP_R_NEEDS_STOP') && empty) return t.exits.legProblem.missing(proposalText(form, e.leg, ctx, t));
  if (e.code === 'TP_PCT' && row !== undefined && row.pct.trim() === '') return t.exits.legProblem.missingShare(proposedRow(form, e.leg, ctx)?.pct ?? '');
  return t.exits.legProblem[e.code];
}

/**
 * The exit plan as a form holds it, in one phrase: every take-profit row, a complete one with its price, R, gain and
 * share, an incomplete one with what is missing or wrong (the program's proposal for an empty level); the cost-price
 * stop; the trailing stop with its level now, or what is wrong with it. The summary of an order never says "no
 * take-profit" while take-profits are chosen.
 */
export function exitFormText(form: ExitForm, ctx: ExitContext, inst: Instrument | null | undefined, t: Messages, now: Omit<ExitPlanNow, 'ctx'> = {}): string {
  const check = checkExitForm(form, ctx);
  const parts: string[] = [];
  if (form.tpMode === 'none') parts.push(t.exits.tpNone);
  else {
    const rows = form.tpMode === 'single' ? [form.single] : form.ladder;
    const figures = legFigures(form, ctx);
    const legs: TpLegText[] = rows.map((_row, i) => {
      const error = rowError(check.errors, i + 1);
      if (error !== null && 'leg' in error) return { px: '', pct: '', r: '', gain: '', problem: legProblemText(error, form, ctx, t) };
      const fig = figures[i];
      const px = fig?.px ?? null;
      const r = fig?.r ?? null;
      const gain = fig?.gain ?? null;
      return {
        px: px === null ? DASH : fmtPx(px, inst),
        pct: ctx.whole && rows.length > 1 && i === rows.length - 1 ? t.exits.rest : fmtPct(fig?.fraction ?? null, 0),
        r: r === null ? '' : t.exits.asR(fmtNum(r, 2)),
        gain: gain === null || !gain.gt(0) ? '' : t.exits.gain(fmtPct(gain, 2)),
        problem: '',
      };
    });
    parts.push(t.exits.tpList(legs));
    if (check.errors.some((e) => e.code === 'TP_REST' || e.code === 'TP_OVER_100')) parts.push(t.exits.tpSharesProblem);
    if (check.fields.breakevenAfterTp1 === true) parts.push(t.exits.breakevenOn);
  }
  if (form.trailing === 'none') parts.push(t.exits.trailingNone);
  else if (check.fields.trailing !== undefined) parts.push(trailingText(check.fields.trailing, inst, t, now));
  else parts.push(form.trailing === 'channel' ? t.exits.channelProblem : t.exits.callbackProblem);
  return t.exits.joinParts(parts);
}

/** The exits of an order, of a plan or of a journal trade in words, in the page's language. */

/** A time in UTC with the browser's local time beside it (its date only when it is another day there). */
export const utcLocal = (ts: number, t: Messages): string => t.common.utcLocal(fmtUtcMinute(ts), fmtLocalTime(ts));

/** What the words of an exit plan can say besides the plan: where the levels stand now. */
export interface ExitPlanNow {
  /** The entry and the stop the take-profits are measured from, for their R and gain */
  ctx?: Pick<ExitContext, 'direction' | 'entry' | 'stop'> | undefined;
  /** Where channel trailing keeps the stop now; null when not known */
  channelLevel?: string | null | undefined;
  /** Where a callback trailing stop would trigger: at the current price, or at the earliest once it activates (callbackTriggerNow); null when not known */
  callbackTrigger?: string | null | undefined;
  /** The callback trigger is the earliest one: the price has not reached the activation price yet (activationPending); false when not given */
  callbackPending?: boolean | undefined;
}

export function trailingText(trailing: TrailingExit | null | undefined, inst: Instrument | null | undefined, t: Messages, now: Omit<ExitPlanNow, 'ctx'> = {}): string {
  if (trailing === null || trailing === undefined) return t.exits.trailingNone;
  const channelLevel = now.channelLevel ?? null;
  if (trailing.kind === 'channel') return t.exits.trailingChannelText(trailing.bars, channelLevel === null ? null : fmtPx(channelLevel, inst));
  const trigger = now.callbackTrigger ?? null;
  return t.exits.trailingCallbackText(fmtPct(trailing.ratio, 2), trailing.activePx === undefined ? null : fmtPx(trailing.activePx, inst), trigger === null ? null : fmtPx(trigger, inst), now.callbackPending === true);
}

/**
 * Take-profit legs in words: each with its price, its share and, given the entry and the stop (`ctx`), the R multiple
 * and the gain it stands for. `whole`: the legs of an opening order, whose last one takes what the others leave (its
 * share is "rest" when there are several).
 */
export function takeProfitText(
  legs: readonly TakeProfitLeg[] | undefined,
  inst: Instrument | null | undefined,
  t: Messages,
  whole: boolean,
  bare = false,
  ctx?: Pick<ExitContext, 'direction' | 'entry' | 'stop'>,
): string {
  if (legs === undefined || legs.length === 0) return t.exits.tpNone;
  const words: TpLegText[] = legs.map((l, i) => {
    const r = ctx === undefined ? null : rMultipleOf(l.triggerPx, ctx);
    const gain = ctx === undefined ? null : gainOf(l.triggerPx, ctx);
    return {
      px: fmtPx(l.triggerPx, inst),
      pct: whole && legs.length > 1 && i === legs.length - 1 ? t.exits.rest : fmtPct(l.fraction, 0),
      r: r === null ? '' : t.exits.asR(fmtNum(r, 2)),
      gain: gain === null || !gain.gt(0) ? '' : t.exits.gain(fmtPct(gain, 2)),
      problem: '',
    };
  });
  return bare ? t.exits.tpLegs(words) : t.exits.tpList(words);
}

export interface ExitPlanParts {
  takeProfits?: readonly TakeProfitLeg[] | undefined;
  breakevenAfterTp1?: boolean | undefined;
  trailing?: TrailingExit | null | undefined;
}

/** The whole exit plan in one phrase: the take-profits (with their R and gain when `now.ctx` is given), the cost-price stop, the trailing stop (with its level now when known). */
export function exitPlanText(plan: ExitPlanParts, inst: Instrument | null | undefined, t: Messages, whole = true, now: ExitPlanNow = {}): string {
  const parts = [takeProfitText(plan.takeProfits as TakeProfitLeg[] | undefined, inst, t, whole, false, now.ctx)];
  if (plan.breakevenAfterTp1 === true) parts.push(t.exits.breakevenOn);
  parts.push(trailingText(plan.trailing, inst, t, now));
  return t.exits.joinParts(parts);
}

/** A journal plan in one phrase, with its stop. */
export function tradePlanText(plan: TradePlan, inst: Instrument | null | undefined, t: Messages): string {
  const exits = exitPlanText(plan, inst, t);
  return plan.slTriggerPx === null ? exits : t.exits.joinParts([t.exits.stopText(fmtPx(plan.slTriggerPx, inst)), exits]);
}

/** A fee as the exchange reports it (negative when paid) shown as the amount paid. */
export const feePaid = (fee: string | undefined): string => {
  const d = safeDecimal(fee);
  return d === null ? '' : fmtNum(d.neg(), 4);
};

/** One event of a trade's timeline as a sentence. */
export function eventSentence(e: JournalEvent, inst: Instrument | null | undefined, ccy: string, t: Messages): string {
  const reason =
    e.reason === undefined ? '' : e.reason === 'take_profit' && e.leg !== undefined ? t.journal.exitReasonLeg(e.leg) : labelOf(t.journal.exitReason, e.reason);
  const text: EventText = {
    side: e.side === undefined ? '' : t.enums.side[e.side],
    contracts: e.contracts === undefined ? '' : fmtContracts(e.contracts, inst),
    px: e.px === undefined || e.px === '' ? '' : fmtPx(e.px, inst),
    fromPx: e.fromPx === undefined ? '' : fmtPx(e.fromPx, inst),
    fee: e.fee === undefined ? '' : `${feePaid(e.fee)} ${ccy}`,
    pnl: e.pnl === undefined || (e.role !== undefined && (e.role === 'open' || e.role === 'add')) ? '' : `${fmtSigned(e.pnl, 2)} ${ccy}`,
    role: e.role === undefined ? '' : t.journal.role[e.role],
    reason,
    leg: e.leg === undefined ? '' : String(e.leg),
    source: e.source === undefined ? '' : t.journal.source[e.source],
    code: e.code === undefined ? '' : labelOf(t.journal.eventCode, e.code),
    plan: e.plan === undefined ? '' : tradePlanText(e.plan, inst, t),
  };
  return t.journal.event[e.kind](text);
}

/** "+1.25R" from a decimal string; '' without one. */
export function fmtR(r: string | null): string {
  const d = safeDecimal(r);
  return d === null ? '' : `${d.gt(0) ? '+' : ''}${d.toFixed(2)}R`;
}
