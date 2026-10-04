import { mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createLogger, dailyLogFile } from '../src/logger.js';

describe('log files', () => {
  let dir: string;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'pegasus-logs-'));
  });
  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  const lines = (name: string): Array<{ level: number; msg: string; n?: number }> =>
    readFileSync(join(dir, name), 'utf8').trim().split('\n').map((l) => JSON.parse(l) as { level: number; msg: string; n?: number });

  it('writes the JSON lines the console gets to logs/pegasus-YYYY-MM-DD.log as well', () => {
    const logDir = join(dir, 'logs'); // created on demand
    const consoleLines: string[] = [];
    const log = createLogger('info', { logDir, console: { write: (line: string) => consoleLines.push(line) }, now: () => new Date(2026, 9, 4, 23, 30).getTime() });
    log.debug('below the level');
    log.info({ n: 1 }, 'first');
    log.error('second');
    expect(readdirSync(logDir)).toEqual(['pegasus-2026-10-04.log']);
    const text = readFileSync(join(logDir, 'pegasus-2026-10-04.log'), 'utf8');
    expect(text).toBe(consoleLines.join(''));
    expect(text.trim().split('\n').map((l) => (JSON.parse(l) as { msg: string }).msg)).toEqual(['first', 'second']);
  });

  it('appends to the file of the day and starts a new file when the local date changes', () => {
    let now = new Date(2026, 9, 4, 23, 59, 59).getTime();
    const file = dailyLogFile(dir, () => now);
    file.write('{"level":30,"msg":"a"}\n');
    now += 2_000;
    file.write('{"level":30,"msg":"b"}\n');
    // a second process on the same day (a restart) adds to the same file
    dailyLogFile(dir, () => now).write('{"level":30,"msg":"c"}\n');
    expect(readdirSync(dir).sort()).toEqual(['pegasus-2026-10-04.log', 'pegasus-2026-10-05.log']);
    expect(lines('pegasus-2026-10-04.log').map((l) => l.msg)).toEqual(['a']);
    expect(lines('pegasus-2026-10-05.log').map((l) => l.msg)).toEqual(['b', 'c']);
  });

  it('keeps the newest 14 log files and leaves other files alone', () => {
    for (let day = 1; day <= 20; day++) writeFileSync(join(dir, `pegasus-2026-09-${String(day).padStart(2, '0')}.log`), 'old\n');
    writeFileSync(join(dir, 'notes.txt'), 'mine');
    writeFileSync(join(dir, 'pegasus-backup.log'), 'mine');
    dailyLogFile(dir, () => new Date(2026, 9, 4, 12).getTime()).write('{"level":30,"msg":"today"}\n');
    const kept = readdirSync(dir).filter((f) => /^pegasus-\d{4}-\d{2}-\d{2}\.log$/.test(f)).sort();
    expect(kept).toHaveLength(14);
    expect(kept[0]).toBe('pegasus-2026-09-08.log');
    expect(kept[13]).toBe('pegasus-2026-10-04.log');
    expect(readdirSync(dir)).toEqual(expect.arrayContaining(['notes.txt', 'pegasus-backup.log']));
  });

  it('a log directory that cannot be used does not stop the process: the console still gets every line', () => {
    const blocked = join(dir, 'blocked');
    writeFileSync(blocked, 'a file where the directory should be');
    const consoleLines: string[] = [];
    const stderr = vi.spyOn(process.stderr, 'write').mockReturnValue(true);
    try {
      const log = createLogger('info', { logDir: blocked, console: { write: (line: string) => consoleLines.push(line) } });
      log.info('still here');
      log.info('and here');
      expect(consoleLines.map((l) => (JSON.parse(l) as { msg: string }).msg)).toEqual(['still here', 'and here']);
      // said once, not with every line
      expect(stderr).toHaveBeenCalledTimes(1);
      expect(stderr.mock.calls[0]?.[0]).toContain('log file disabled');
    } finally {
      stderr.mockRestore();
    }
  });
});
