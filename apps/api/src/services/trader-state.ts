import { copyFileSync, existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import type { TraderControlState, TraderLogRecord, TraderPosition, TraderPreviousDecision, TraderTradeResult, TraderWake } from '@pegasus/shared';

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
  /** Against the weekly trend: the position it fills into is closed at the market from this instant */
  closeAt?: number;
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
  /** Losses in a row within the UTC day, like the other counters */
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
  /** Its last decisions, newest first, shown to it at the next call */
  recentDecisions?: TraderPreviousDecision[];
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
    recentDecisions: [],
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

export type TraderStateLoad = { ok: true; state: TraderState; note?: string } | { ok: false; error: string };

/**
 * The state file: this version's, or none. A file of the lead-trader style (version 2, services/trader-leader.ts) that
 * holds no lot is moved to `<file>.leader-v2` and the record begins empty; one holding lots blocks the trader.
 */
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
    if (isObject(parsed) && parsed['version'] === 2 && parsed['style'] === 'leader') {
      const coins = Array.isArray(parsed['coins']) ? parsed['coins'] : [];
      const flat = coins.every((c: unknown) => isObject(c) && Array.isArray(c['lots']) && c['lots'].length === 0);
      if (!flat) return { ok: false, error: `${file} is the lead-trader style's and holds lots: sell them first (restart with TRADER_STYLE=leader), or move the file away` };
      const archived = `${file}.leader-v2`;
      try {
        renameSync(file, archived);
      } catch (err) {
        return { ok: false, error: `${file} is the lead-trader style's flat state and could not be moved to ${archived} (${(err as Error).message}); move it away by hand` };
      }
      return { ok: true, state: emptyTraderState(now), note: `the lead-trader style's flat state was moved to ${archived}` };
    }
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

export function saveTraderState(file: string, state: object): void {
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(`${file}.tmp`, JSON.stringify(state, null, 2));
  renameSync(`${file}.tmp`, file);
}

/** GET /api/trader/log: the newest `limit` records of a decision log, without their dossiers; a line cut by a crash is skipped. */
export function readTraderLog(file: string, limit: number): { records: TraderLogRecord[] } {
  if (!existsSync(file)) return { records: [] };
  const lines = readFileSync(file, 'utf8').split('\n').filter((l) => l.trim() !== '');
  const records: TraderLogRecord[] = [];
  for (const line of lines.slice(-limit).reverse()) {
    try {
      const { dossier: _dossier, ...rest } = JSON.parse(line) as TraderLogRecord;
      records.push(rest);
    } catch {
      // skipped
    }
  }
  return { records };
}

/** The counters of a new UTC day: everything of the day starts again; the position, the control and the recents stay. */
export function rolledToDay(state: TraderState, now: number, equity: string | null): TraderState {
  const date = utcDate(now);
  if (state.date === date) return state;
  return { ...state, date, equityAtStart: equity, tradesToday: 0, pnlToday: '0', consecutiveLosses: 0, usage: { date, calls: 0, inputTokens: 0, outputTokens: 0, cacheReadTokens: 0 } };
}
