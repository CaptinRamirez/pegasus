import { D, type Instrument, type JournalEvent, type TakeProfitLeg, type TradePlan, type TrailingExit } from '@pegasus/shared';
import type { EventText, Messages } from '../i18n/en';
import { labelOf } from '../i18n';
import { fmtContracts, fmtLocalTime, fmtNum, fmtPct, fmtPx, fmtSigned, fmtUtcMinute, safeDecimal } from './format';

/** The exits of an order, of a plan or of a journal trade in words, in the page's language. */

/** A time in UTC with the browser's local time beside it (its date only when it is another day there). */
export const utcLocal = (ts: number, t: Messages): string => t.common.utcLocal(fmtUtcMinute(ts), fmtLocalTime(ts));

export function trailingText(trailing: TrailingExit | null | undefined, inst: Instrument | null | undefined, t: Messages): string {
  if (trailing === null || trailing === undefined) return t.exits.trailingNone;
  if (trailing.kind === 'channel') return t.exits.trailingChannelText(trailing.bars);
  return t.exits.trailingCallbackText(fmtPct(trailing.ratio, 2), trailing.activePx === undefined ? null : fmtPx(trailing.activePx, inst));
}

/**
 * Take-profit legs in words. `whole`: the legs of an opening order, whose last one takes what the others leave (its
 * share is "rest" when there are several).
 */
export function takeProfitText(legs: readonly TakeProfitLeg[] | undefined, inst: Instrument | null | undefined, t: Messages, whole: boolean, bare = false): string {
  if (legs === undefined || legs.length === 0) return t.exits.tpNone;
  const words = legs.map((l, i) => ({ px: fmtPx(l.triggerPx, inst), pct: whole && legs.length > 1 && i === legs.length - 1 ? t.exits.rest : fmtPct(l.fraction, 0) }));
  return bare ? t.exits.tpLegs(words) : t.exits.tpList(words);
}

export interface ExitPlanParts {
  takeProfits?: readonly TakeProfitLeg[] | undefined;
  breakevenAfterTp1?: boolean | undefined;
  trailing?: TrailingExit | null | undefined;
}

/** The whole exit plan in one phrase: the take-profits, the cost-price stop, the trailing stop. */
export function exitPlanText(plan: ExitPlanParts, inst: Instrument | null | undefined, t: Messages, whole = true): string {
  const parts = [takeProfitText(plan.takeProfits as TakeProfitLeg[] | undefined, inst, t, whole)];
  if (plan.breakevenAfterTp1 === true) parts.push(t.exits.breakevenOn);
  parts.push(trailingText(plan.trailing, inst, t));
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

/** The base coin of contracts as the journal recorded it ("0.03 BTC"). */
export const coinWithUnit = (coin: string, base: string): string => `${groupCoin(coin)} ${base}`;

const groupCoin = (coin: string): string => {
  const d = safeDecimal(coin);
  return d === null ? coin : D(d).toFixed();
};
