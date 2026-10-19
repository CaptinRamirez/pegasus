import { copyFileSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import type { TraderControlState, TraderPosition, TraderPreviousDecision, TraderTradeResult, TraderWake } from '@pegasus/shared';

/**
 * What the Claude auto trader keeps across restarts (TRADER_STATE_FILE): the day's counters the guardrails read, the
 * position it holds and the limit order it is waiting on, the coin-flip control's book, the recent results and the
 * token usage. Written whole after every change through a temporary file and a rename; read once at start. A file
 * that is not one this version wrote is an error: the trader then does not trade (a copy is kept as `.corrupt`).
 */

export const TRADER_STATE_VERSION = 1;

export interface PendingLimit {
  clOrdId: string;
  side: 'long' | 'short';
  contracts: string;
  px: string;
  stopPx: string;
  targetPx: string | null;
  leverage: string;
  placedAt: number;
  /** The 15-minute bar the order was placed in; it is cancelled at the close of the next one if still unfilled */
  barTs: number;
  equityAtEntry: string;
}

export interface TraderUsageDay {
  date: string;
  calls: number;
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
}

export interface TraderState {
  version: typeof TRADER_STATE_VERSION;
  /** UTC day of the counters, YYYY-MM-DD */
  date: string;
  equityAtStart: string | null;
  tradesToday: number;
  pnlToday: string;
  consecutiveLosses: number;
  cooldownUntil: number | null;
  /** Open time of the last 15-minute bar the trader processed */
  lastBarTs: number | null;
  lastCallAt: number | null;
  position: TraderPosition | null;
  pendingLimit: PendingLimit | null;
  control: TraderControlState;
  /** Newest first, at most RECENT_KEPT */
  recent: TraderTradeResult[];
  usage: TraderUsageDay;
  /** Coin flips drawn so far: the seed of the next one */
  flips: number;
  /** The next look the model asked for (absent in files written before it decided its own cadence) */
  wake?: TraderWake | null;
  /** Its last decision, shown to it at the next call */
  previous?: TraderPreviousDecision | null;
}

export const RECENT_KEPT = 50;

export const utcDate = (ts: number): string => new Date(ts).toISOString().slice(0, 10);

export function emptyTraderState(now: number): TraderState {
  const date = utcDate(now);
  return {
    version: TRADER_STATE_VERSION,
    date,
    equityAtStart: null,
    tradesToday: 0,
    pnlToday: '0',
    consecutiveLosses: 0,
    cooldownUntil: null,
    lastBarTs: null,
    lastCallAt: null,
    position: null,
    pendingLimit: null,
    control: { position: null, trades: 0, pnlTotal: '0', wins: 0, losses: 0 },
    recent: [],
    usage: { date, calls: 0, inputTokens: 0, outputTokens: 0, cacheReadTokens: 0 },
    flips: 0,
    wake: null,
    previous: null,
  };
}

const isObject = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);
const isString = (v: unknown): v is string => typeof v === 'string';
const isNumber = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v);

function problemOf(v: unknown): string | null {
  if (!isObject(v)) return 'not a JSON object';
  if (v['version'] !== TRADER_STATE_VERSION) return `schema version ${JSON.stringify(v['version'])}, this version reads ${TRADER_STATE_VERSION}`;
  if (!isString(v['date']) || !isString(v['pnlToday'])) return 'date or pnlToday is not a string';
  for (const key of ['tradesToday', 'consecutiveLosses', 'flips']) if (!isNumber(v[key])) return `${key} is not a number`;
  if (v['position'] !== null && !isObject(v['position'])) return 'position is not an object';
  if (v['pendingLimit'] !== null && !isObject(v['pendingLimit'])) return 'pendingLimit is not an object';
  if (!isObject(v['control']) || !isObject(v['usage']) || !Array.isArray(v['recent'])) return 'control, usage or recent is missing';
  return null;
}

export type TraderStateLoad = { ok: true; state: TraderState } | { ok: false; error: string };

export function loadTraderState(file: string, now: number): TraderStateLoad {
  let text: string;
  try {
    text = readFileSync(file, 'utf8');
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return { ok: true, state: emptyTraderState(now) };
    return { ok: false, error: `the trader state ${file} could not be read (${(err as Error).message})` };
  }
  let parsed: unknown;
  let problem: string | null;
  try {
    parsed = JSON.parse(text);
    problem = problemOf(parsed);
  } catch (err) {
    problem = (err as Error).message;
  }
  if (problem !== null) {
    try {
      copyFileSync(file, `${file}.corrupt`);
    } catch {
      // the copy is a courtesy
    }
    return { ok: false, error: `the trader state ${file} is not one this version wrote (${problem}); a copy is kept as .corrupt` };
  }
  return { ok: true, state: parsed as TraderState };
}

export function saveTraderState(file: string, state: TraderState): void {
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(`${file}.tmp`, JSON.stringify(state, null, 2));
  renameSync(`${file}.tmp`, file);
}

/** The counters of a new UTC day: everything of the day starts again; the position, the control and the recents stay. */
export function rolledToDay(state: TraderState, now: number, equity: string | null): TraderState {
  const date = utcDate(now);
  if (state.date === date) return state;
  return { ...state, date, equityAtStart: equity, tradesToday: 0, pnlToday: '0', usage: { date, calls: 0, inputTokens: 0, outputTokens: 0, cacheReadTokens: 0 } };
}
