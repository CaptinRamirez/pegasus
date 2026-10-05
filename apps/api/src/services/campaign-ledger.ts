import { copyFileSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import type { CampaignBankingRecord, CampaignErrorRecord, CampaignPotRecord, CampaignRecord, CampaignSampleRecord, CampaignStepLog } from '@pegasus/shared';

/**
 * The campaign's ledger, kept in its own JSON file (CAMPAIGN_STATE_FILE) whichever store the API uses: the pot, every
 * campaign, the bankings, a sample per close, the decision log of the last steps, the execution errors and the last
 * close processed. Written whole after every change, through a temporary file and a rename, so that a crash never
 * leaves half a file; read once at start.
 */

export const LEDGER_VERSION = 1;
/** Steps of the decision log kept */
export const MAX_STEPS = 1_000;
/** Execution errors kept with their details; errorCount counts them all */
export const MAX_ERRORS = 500;

export interface CampaignLedger {
  version: typeof LEDGER_VERSION;
  /** null until the pot has started */
  pot: CampaignPotRecord | null;
  /** Oldest first */
  campaigns: CampaignRecord[];
  bankings: CampaignBankingRecord[];
  samples: CampaignSampleRecord[];
  /** The last MAX_STEPS steps, oldest first */
  steps: CampaignStepLog[];
  /** Number of the last step */
  stepSeq: number;
  /** The last MAX_ERRORS execution errors, oldest first */
  errors: CampaignErrorRecord[];
  /** Every execution error since the pot started */
  errorCount: number;
  /** Closes that were not processed in time */
  missedCloses: number;
  /** The last close processed; null before the pot started */
  lastClose: number | null;
  /** Positions on the campaign's instruments the ledger does not know, as the last step found them */
  foreign: string[];
}

export function emptyLedger(): CampaignLedger {
  return { version: LEDGER_VERSION, pot: null, campaigns: [], bankings: [], samples: [], steps: [], stepSeq: 0, errors: [], errorCount: 0, missedCloses: 0, lastClose: null, foreign: [] };
}

export type LedgerLoad = { ok: true; ledger: CampaignLedger; existed: boolean } | { ok: false; error: string };

const isObject = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);
const isString = (v: unknown): v is string => typeof v === 'string';
const isNumber = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v);

/** What makes the file one this version wrote; anything else is not trusted (the file can be edited by hand). */
function problemOf(v: unknown): string | null {
  if (!isObject(v)) return 'not a JSON object';
  if (v['version'] !== LEDGER_VERSION) return `schema version ${JSON.stringify(v['version'])}, this version reads ${LEDGER_VERSION}`;
  for (const key of ['campaigns', 'bankings', 'samples', 'steps', 'errors', 'foreign']) if (!Array.isArray(v[key])) return `${key} is not a list`;
  for (const key of ['stepSeq', 'errorCount', 'missedCloses']) if (!isNumber(v[key])) return `${key} is not a number`;
  if (v['lastClose'] !== null && !isNumber(v['lastClose'])) return 'lastClose is not a number';
  const pot = v['pot'];
  if (pot !== null) {
    if (!isObject(pot)) return 'pot is not an object';
    for (const key of ['startValue', 'btcMarkAtStart', 'structure', 'start', 'minStake', 'banked']) if (!isString(pot[key])) return `pot.${key} is not a string`;
    if (!isNumber(pot['startedAt']) || !isNumber(pot['rungs'])) return 'pot.startedAt or pot.rungs is not a number';
  }
  for (const c of v['campaigns'] as unknown[]) {
    if (!isObject(c) || !isString(c['id']) || !isString(c['instId']) || !isObject(c['entry']) || !Array.isArray(c['adds']) || !Array.isArray(c['sales'])) return 'a campaign is not complete';
    for (const key of ['addRef', 'addUnit', 'stake', 'basis', 'harvested', 'peak']) if (!isString(c[key])) return `campaign ${String(c['id'])}: ${key} is not a string`;
  }
  return null;
}

/**
 * Reads the ledger. A missing file is a new ledger. A file that cannot be read or is not one this version wrote is
 * an error: the service then does not trade and does not write (a copy is kept as `<file>.corrupt`), so that what
 * the file held is never overwritten by a fresh pot.
 */
export function loadLedger(file: string): LedgerLoad {
  let text: string;
  try {
    text = readFileSync(file, 'utf8');
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return { ok: true, ledger: emptyLedger(), existed: false };
    return { ok: false, error: `the campaign ledger ${file} could not be read (${(err as Error).message})` };
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
    return { ok: false, error: `the campaign ledger ${file} is not valid (${problem})` };
  }
  return { ok: true, ledger: parsed as CampaignLedger, existed: true };
}

/** Writes the ledger whole, through a temporary file; the decision log and the error details are trimmed first. */
export function saveLedger(file: string, ledger: CampaignLedger): void {
  if (ledger.steps.length > MAX_STEPS) ledger.steps.splice(0, ledger.steps.length - MAX_STEPS);
  if (ledger.errors.length > MAX_ERRORS) ledger.errors.splice(0, ledger.errors.length - MAX_ERRORS);
  const tmp = `${file}.tmp`;
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(tmp, `${JSON.stringify(ledger)}\n`);
  renameSync(tmp, file);
}
