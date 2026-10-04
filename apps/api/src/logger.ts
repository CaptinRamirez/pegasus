import { readdirSync, unlinkSync } from 'node:fs';
import { join } from 'node:path';
import { pino, type DestinationStream, type Level, type Logger } from 'pino';
import type { OkxWsLogger } from '@pegasus/okx';

export type { Logger };

const LOG_FILE_RE = /^pegasus-\d{4}-\d{2}-\d{2}\.log$/;
const KEEP_LOG_FILES = 14;

export interface LoggerOptions {
  /** Directory of the dated log files; without it only the console is written. */
  logDir?: string;
  /** Where the console output goes; by default stdout, pretty-printed on a terminal. */
  console?: DestinationStream;
  now?: () => number;
}

/**
 * The console window is closed to stop the system, so the same JSON lines also go to a file per local day
 * that can be read afterwards.
 */
export function createLogger(level: Level, opts: LoggerOptions = {}): Logger {
  const out =
    opts.console ??
    (process.stdout.isTTY === true
      ? (pino.transport({ target: 'pino-pretty', options: { colorize: true, translateTime: 'SYS:HH:MM:ss.l', ignore: 'pid,hostname' } }) as DestinationStream)
      : pino.destination(1));
  if (opts.logDir === undefined) return pino({ level }, out);
  return pino({ level }, pino.multistream([{ level, stream: out }, { level, stream: dailyLogFile(opts.logDir, opts.now) }]));
}

const pad2 = (n: number): string => String(n).padStart(2, '0');

/**
 * Appends to `<dir>/pegasus-YYYY-MM-DD.log` (local date), moves on to a new file when the date changes and keeps
 * the newest 14. Written synchronously so the last lines before a crash are in the file. A directory that cannot
 * be written is reported once on stderr and never stops the process.
 */
export function dailyLogFile(dir: string, now: () => number = Date.now): DestinationStream {
  let day = '';
  let file: ReturnType<typeof pino.destination> | null = null;
  let disabled = false;
  const giveUp = (err: unknown): void => {
    if (disabled) return;
    disabled = true;
    process.stderr.write(`[pegasus] log file disabled: ${(err as Error).message}\n`);
  };
  const open = (today: string): void => {
    file?.end();
    day = today;
    file = pino.destination({ dest: join(dir, `pegasus-${today}.log`), sync: true, append: true, mkdir: true });
    file.on('error', giveUp);
    try {
      const old = readdirSync(dir).filter((name) => LOG_FILE_RE.test(name)).sort().slice(0, -KEEP_LOG_FILES);
      for (const name of old) unlinkSync(join(dir, name));
    } catch {
      // best effort: an old file that cannot be removed is no reason to stop logging
    }
  };
  return {
    write(line: string): void {
      if (disabled) return;
      const d = new Date(now());
      const today = `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())}`;
      try {
        if (today !== day) open(today);
        file?.write(line);
      } catch (err) {
        giveUp(err);
      }
    },
  };
}

/** Adapts a pino logger to the minimal logger interface used by @pegasus/okx. */
export function okxLogger(log: Logger): OkxWsLogger {
  return {
    debug: (msg, meta) => log.debug(meta ?? {}, msg),
    info: (msg, meta) => log.info(meta ?? {}, msg),
    warn: (msg, meta) => log.warn(meta ?? {}, msg),
    error: (msg, meta) => log.error(meta ?? {}, msg),
  };
}
