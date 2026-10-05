/** The campaign's ledger file (services/campaign-ledger.ts): written whole through a temporary file, read back, never trusted when it is not one this version wrote. */
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import type { CampaignErrorRecord, CampaignStepLog } from '@pegasus/shared';
import { emptyLedger, LEDGER_VERSION, loadLedger, MAX_ERRORS, MAX_STEPS, saveLedger } from '../src/services/campaign-ledger.js';

const fileIn = (): string => join(mkdtempSync(join(tmpdir(), 'pegasus-ledger-')), 'nested', 'ledger.json');

const step = (seq: number): CampaignStepLog => ({ seq, kind: 'close', closeTs: seq, closes: [seq], startedAt: seq, endedAt: seq, before: null, inputs: [], actions: [], errors: 0, notes: [] });
const error = (n: number): CampaignErrorRecord => ({ ts: n, closeTs: null, campaignId: null, instId: null, action: 'enter', code: 'EXCHANGE', message: `#${n}`, details: {} });

describe('the campaign ledger file', () => {
  it('is new when it does not exist, and reads back what was written, its directory created', () => {
    const file = fileIn();
    expect(loadLedger(file)).toEqual({ ok: true, ledger: emptyLedger(), existed: false });
    const ledger = emptyLedger();
    ledger.pot = { startedAt: 1, startValue: '56', btcMarkAtStart: '60000', structure: 'pyramid', start: '56', minStake: '5.6', banked: '0', rungs: 0, peak: null, finishedAt: null };
    ledger.lastClose = 43_200_000;
    ledger.errorCount = 3;
    saveLedger(file, ledger);
    expect(loadLedger(file)).toEqual({ ok: true, ledger, existed: true });
    expect(existsSync(`${file}.tmp`)).toBe(false);
    expect((JSON.parse(readFileSync(file, 'utf8')) as { version: number }).version).toBe(LEDGER_VERSION);
  });

  it('keeps the last 1,000 steps and the details of the last 500 errors; the count stays whole', () => {
    const file = fileIn();
    const ledger = emptyLedger();
    ledger.steps = Array.from({ length: MAX_STEPS + 5 }, (_, i) => step(i + 1));
    ledger.errors = Array.from({ length: MAX_ERRORS + 2 }, (_, i) => error(i + 1));
    ledger.errorCount = MAX_ERRORS + 2;
    saveLedger(file, ledger);
    const read = loadLedger(file);
    if (!read.ok) throw new Error(read.error);
    expect(read.ledger.steps).toHaveLength(MAX_STEPS);
    expect(read.ledger.steps[0]?.seq).toBe(6);
    expect(read.ledger.errors).toHaveLength(MAX_ERRORS);
    expect(read.ledger.errors[0]?.message).toBe('#3');
    expect(read.ledger.errorCount).toBe(MAX_ERRORS + 2);
  });

  it('is not trusted when it is not one this version wrote: an error, and a copy kept aside', () => {
    const file = join(mkdtempSync(join(tmpdir(), 'pegasus-ledger-')), 'ledger.json');
    for (const [text, problem] of [
      ['{"version": 1, "pot"', /not valid/],
      [JSON.stringify({ ...emptyLedger(), version: 2 }), /schema version 2, this version reads 1/],
      [JSON.stringify({ ...emptyLedger(), campaigns: [{ id: 'x' }] }), /a campaign is not complete/],
      [JSON.stringify({ ...emptyLedger(), pot: { startedAt: 1 } }), /pot\.startValue is not a string/],
      [JSON.stringify({ ...emptyLedger(), errorCount: '3' }), /errorCount is not a number/],
    ] as const) {
      writeFileSync(file, text);
      const read = loadLedger(file);
      expect(read.ok).toBe(false);
      if (!read.ok) expect(read.error).toMatch(problem);
      expect(readFileSync(`${file}.corrupt`, 'utf8')).toBe(text);
      // the file itself is left as it was
      expect(readFileSync(file, 'utf8')).toBe(text);
    }
  });
});
