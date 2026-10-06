import { copyFileSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import type { ChannelTrailingEntry, PendingTrailingExit } from '@pegasus/shared';

/**
 * What the exit services keep across restarts, in their own JSON file (TRAILING_STATE_FILE, next to STATE_FILE by
 * default) whichever store the API uses: the positions channel trailing manages (channel-trailing.ts) and the opening
 * orders whose trailing exit is placed once they have filled (exit-orders.ts). Written whole after every change,
 * through a temporary file and a rename, so that a crash never leaves half a file; read once at start.
 */

export const EXIT_STATE_VERSION = 1;

export interface ExitState {
  version: typeof EXIT_STATE_VERSION;
  channel: ChannelTrailingEntry[];
  pending: PendingTrailingExit[];
}

export function emptyExitState(): ExitState {
  return { version: EXIT_STATE_VERSION, channel: [], pending: [] };
}

const isObject = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);
const isString = (v: unknown): v is string => typeof v === 'string';
const isNumber = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v);

/** What makes the file one this version wrote; anything else is not trusted (the file can be edited by hand). */
function problemOf(v: unknown): string | null {
  if (!isObject(v)) return 'not a JSON object';
  if (v['version'] !== EXIT_STATE_VERSION) return `schema version ${JSON.stringify(v['version'])}, this version reads ${EXIT_STATE_VERSION}`;
  if (!Array.isArray(v['channel']) || !Array.isArray(v['pending'])) return 'channel or pending is not a list';
  for (const e of v['channel'] as unknown[]) {
    if (!isObject(e)) return 'a channel entry is not an object';
    for (const key of ['instId', 'mgnMode', 'posSide', 'direction', 'source', 'clOrdId']) if (!isString(e[key])) return `a channel entry's ${key} is not a string`;
    if (!isNumber(e['bars']) || !isNumber(e['since'])) return 'a channel entry has no bars or since';
    if (e['level'] !== null && !isString(e['level'])) return 'a channel entry has a level that is not a string';
    if (e['levelClose'] !== null && !isNumber(e['levelClose'])) return 'a channel entry has a levelClose that is not a number';
    if (!Array.isArray(e['algoIds'])) return 'a channel entry has no algoIds';
  }
  for (const p of v['pending'] as unknown[]) {
    if (!isObject(p)) return 'a pending exit is not an object';
    for (const key of ['clOrdId', 'ordId', 'instId', 'tdMode', 'posSide', 'side']) if (!isString(p[key])) return `a pending exit's ${key} is not a string`;
    if (!isObject(p['trailing']) || !isNumber(p['createdAt']) || !isNumber(p['attempts'])) return 'a pending exit is not complete';
  }
  return null;
}

export type ExitStateLoad = { ok: true; state: ExitState } | { ok: false; error: string };

/**
 * Reads the state. A missing file is an empty state. A file that cannot be read or is not one this version wrote is an
 * error: the services then neither act on it nor write it (a copy is kept as `<file>.corrupt`), so that what it held
 * is never overwritten.
 */
export function loadExitState(file: string): ExitStateLoad {
  let text: string;
  try {
    text = readFileSync(file, 'utf8');
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return { ok: true, state: emptyExitState() };
    return { ok: false, error: `the trailing state ${file} could not be read (${(err as Error).message})` };
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
      // best effort
    }
    return { ok: false, error: `the trailing state ${file} is not valid (${problem})` };
  }
  return { ok: true, state: parsed as ExitState };
}

export function saveExitState(file: string, state: ExitState): void {
  const tmp = `${file}.tmp`;
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(tmp, `${JSON.stringify(state)}\n`);
  renameSync(tmp, file);
}

/** The state of one file, shared by the channel trailing and the exit follow-up services of one API process. */
export class ExitStateFile {
  readonly state: ExitState;
  /** Set when the file could not be trusted: nothing is acted on or written */
  readonly error: string | null;

  constructor(readonly file: string) {
    const loaded = loadExitState(file);
    this.state = loaded.ok ? loaded.state : emptyExitState();
    this.error = loaded.ok ? null : loaded.error;
  }

  save(): void {
    if (this.error !== null) return;
    saveExitState(this.file, this.state);
  }
}
