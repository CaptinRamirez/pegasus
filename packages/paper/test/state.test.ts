/** The account file: a save that fails for a moment is reported and the exchange goes on; one that keeps failing stops it. */
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { MIN, open, T0 } from './helpers.js';

/** A state file nothing can be written to: its folder is a regular file. */
function blockedFile(): string {
  const blocker = join(mkdtempSync(join(tmpdir(), 'pegasus-paper-')), 'blocker');
  writeFileSync(blocker, '');
  return join(blocker, 'paper-account.json');
}

describe('the account file', () => {
  it('a save that fails is reported and does not take the exchange down', () => {
    const { paper, logs } = open({ stateFile: blockedFile() });
    expect(() => paper.save()).not.toThrow();
    expect(logs.some((l) => l.startsWith('the account could not be saved to'))).toBe(true);
  });

  it('a save that keeps failing for five minutes stops the exchange, so that the launcher reports it; at shutdown the loss is said', () => {
    let now = T0;
    const { paper, logs } = open({ stateFile: blockedFile(), now: () => now });
    paper.save();
    now += 4 * MIN;
    expect(() => paper.save()).not.toThrow();
    now += MIN;
    expect(() => paper.save()).toThrow(/for 5 minutes/);
    expect(() => paper.close()).not.toThrow();
    expect(logs.at(-1)).toMatch(/at shutdown .*what changed since the last save is lost/);
  });
});
