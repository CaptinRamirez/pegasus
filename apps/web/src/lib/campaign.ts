import type {
  CampaignEndKind,
  CampaignPotView,
  CampaignRecordView,
  CampaignReplayView,
  CampaignStepAction,
  CampaignStructure,
  CampaignView,
} from '@pegasus/shared';
import { DASH, fmtNum, fmtUtcMinute, safeDecimal } from './format';
import { isApiError } from './http';

/**
 * Pure helpers of the campaign page (the CAMPAIGN tab). Money stays in decimal strings: the only arithmetic here,
 * the pot's multiple, is decimal.js; numbers appear for counts and times only.
 */

/** Campaigns run to their end that stage G0 of the paper stage asks for (docs/strategy.md, section 4). */
export const ACCEPTANCE_TARGET = 20;

/** Ends the program carried out by itself; `external` (closed by hand) and `unknown` (an execution error) are not among them. */
export const RUN_TO_END_KINDS: readonly CampaignEndKind[] = ['exit', 'liquidated', 'harvest'];

export interface AcceptanceCounts {
  /** Ended on the exit signal, by liquidation, or sold whole by a harvest */
  ranToEnd: number;
  external: number;
  unknown: number;
  open: number;
}

export function acceptanceCounts(campaigns: ReadonlyArray<Pick<CampaignRecordView, 'end'>>): AcceptanceCounts {
  const counts: AcceptanceCounts = { ranToEnd: 0, external: 0, unknown: 0, open: 0 };
  for (const c of campaigns) {
    if (c.end === null) counts.open += 1;
    else if (RUN_TO_END_KINDS.includes(c.end.kind)) counts.ranToEnd += 1;
    else if (c.end.kind === 'external') counts.external += 1;
    else counts.unknown += 1;
  }
  return counts;
}

/** A campaign's state as the table shows it: open, or how it ended. */
export type CampaignState = 'open' | CampaignEndKind;

export const campaignState = (c: Pick<CampaignRecordView, 'end'>): CampaignState => (c.end === null ? 'open' : c.end.kind);

/**
 * (value + banked) / start value: what the pot is worth now together with what it has banked, per unit it started
 * with. The start value is the account's equity when the pot started (the configured start when that was not
 * recorded). null while the value is unknown.
 */
export function potMultiple(pot: Pick<CampaignPotView, 'value' | 'banked' | 'startValue' | 'start'>): string | null {
  const value = safeDecimal(pot.value);
  const banked = safeDecimal(pot.banked);
  const start = [pot.startValue, pot.start].map(safeDecimal).find((d) => d !== null && d.gt(0)) ?? null;
  if (value === null || banked === null || start === null) return null;
  return value.plus(banked).div(start).toFixed();
}

/** A multiple as "×1.23"; the dash when there is none ('' is a figure that was not measured). */
export function fmtMultiple(v: string | null | undefined, dp = 2): string {
  const d = safeDecimal(v);
  return d === null ? DASH : `×${fmtNum(d, dp)}`;
}

/** Money in USDT, two decimals with separators. */
export const fmtUsdt = (v: string | null | undefined): string => fmtNum(v, 2);

/** Whole hours, minutes and seconds of a duration (negative counts as zero), for the countdown. */
export function splitDuration(ms: number): { h: number; m: number; s: number } {
  const total = Math.max(0, Math.floor(ms / 1000));
  return { h: Math.floor(total / 3600), m: Math.floor((total % 3600) / 60), s: total % 60 };
}

/** Two digits: the minutes and seconds of the countdown. */
export const pad2 = (n: number): string => String(n).padStart(2, '0');

// ---- the chart ----

export type ChartLineId = 'value' | 'banked' | 'heldBtc' | 'replaySame' | 'replayOther';

export interface ChartPoint {
  /** A 12-hour close, epoch ms */
  ts: number;
  /** Decimal string, USDT */
  value: string;
}

export interface ChartLine {
  id: ChartLineId;
  points: ChartPoint[];
  /** The structure a replay line ran; null for the other lines */
  structure: CampaignStructure | null;
}

/**
 * The lines of the pot chart: its value and its banked total at every close processed, then, when the replay has a
 * result, the pot's start value held in BTC and the replay of each structure (the pot's own first).
 */
export function campaignChartLines(view: Pick<CampaignView, 'samples'>, replay: CampaignReplayView | null): ChartLine[] {
  const lines: ChartLine[] = [
    { id: 'value', structure: null, points: view.samples.map((s) => ({ ts: s.ts, value: s.value })) },
    { id: 'banked', structure: null, points: view.samples.map((s) => ({ ts: s.ts, value: s.banked })) },
  ];
  if (replay === null) return lines;
  if (replay.heldBtc.length > 0) lines.push({ id: 'heldBtc', structure: null, points: replay.heldBtc.map((s) => ({ ts: s.ts, value: s.value })) });
  if (replay.same !== null) lines.push({ id: 'replaySame', structure: replay.same.structure, points: replay.same.samples.map((s) => ({ ts: s.ts, value: s.value })) });
  if (replay.other !== null) lines.push({ id: 'replayOther', structure: replay.other.structure, points: replay.other.samples.map((s) => ({ ts: s.ts, value: s.value })) });
  return lines;
}

/** The value a line had at `ts` (the last point at or before it), or its last value when `ts` is null; null without one. */
export function valueAt(points: readonly ChartPoint[], ts: number | null): string | null {
  let found: ChartPoint | null = null;
  for (const p of points) {
    if (ts !== null && p.ts > ts) continue;
    if (found === null || p.ts >= found.ts) found = p;
  }
  return found?.value ?? null;
}

// ---- the replay ----

/** GET /api/campaign/replay answered 404: the API has no such route (an older server). */
export function isNotFound(e: unknown): boolean {
  return isApiError(e) && (e.status === 404 || e.code === 'NOT_FOUND');
}

/**
 * What the page knows of the replay. off: nothing to replay (the view is not loaded, the campaign is disabled or its
 * pot has not started). missing: the API does not offer it (404). error: it could not be loaded. loaded: the API's
 * answer, whose own status says whether it holds a result.
 */
export type ReplayState =
  | { kind: 'off' }
  | { kind: 'loading' }
  | { kind: 'missing' }
  | { kind: 'error'; error: unknown }
  | { kind: 'loaded'; replay: CampaignReplayView };

export function replayState(wanted: boolean, data: CampaignReplayView | undefined, error: unknown): ReplayState {
  if (!wanted) return { kind: 'off' };
  if (error !== null && error !== undefined && isNotFound(error)) return { kind: 'missing' };
  if (data !== undefined) return { kind: 'loaded', replay: data };
  if (error !== null && error !== undefined) return { kind: 'error', error };
  return { kind: 'loading' };
}

/** The replay to draw and reconcile with: the result of a loaded answer, also the earlier one a failed attempt keeps. */
export const replayResult = (state: ReplayState): CampaignReplayView | null => (state.kind === 'loaded' ? state.replay : null);

// ---- the decision log ----

/** A value of an action's plan or result as the log shows it: times (keys ending in Ts) in UTC, the rest as the API wrote it. */
export function fmtLogValue(key: string, v: string | number | boolean | null): string {
  if (v === null) return DASH;
  if (typeof v === 'number' && key.endsWith('Ts') && v > 1e11) return fmtUtcMinute(v);
  return String(v);
}

/** An action's plan or result in one line: "contracts=3, stake=28". */
export function fmtLogRecord(rec: Record<string, string | number | boolean | null> | null): string {
  if (rec === null) return DASH;
  const parts = Object.entries(rec).map(([k, v]) => `${k}=${fmtLogValue(k, v)}`);
  return parts.length === 0 ? DASH : parts.join(', ');
}

/** The actions of a step grouped by kind and outcome, in the order they first appear: "enter ×1", "add skipped ×2". */
export function groupActions(actions: readonly CampaignStepAction[]): Array<{ kind: CampaignStepAction['kind']; outcome: CampaignStepAction['outcome']; count: number; error: boolean }> {
  const groups: Array<{ kind: CampaignStepAction['kind']; outcome: CampaignStepAction['outcome']; count: number; error: boolean }> = [];
  for (const a of actions) {
    const g = groups.find((x) => x.kind === a.kind && x.outcome === a.outcome);
    if (g === undefined) groups.push({ kind: a.kind, outcome: a.outcome, count: 1, error: a.error });
    else {
      g.count += 1;
      g.error = g.error || a.error;
    }
  }
  return groups;
}
