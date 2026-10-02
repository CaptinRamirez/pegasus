import { pino, type Logger } from 'pino';
import type { OkxWsLogger } from '@pegasus/okx';

export type { Logger };

export function createLogger(level: string, pretty: boolean = process.stdout.isTTY === true): Logger {
  if (pretty) {
    return pino({ level, transport: { target: 'pino-pretty', options: { colorize: true, translateTime: 'SYS:HH:MM:ss.l', ignore: 'pid,hostname' } } });
  }
  return pino({ level });
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
