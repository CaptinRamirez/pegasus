import { OkxRestClient, OkxTransportError, OkxWsClient } from '@pegasus/okx';
import type { AppConfig } from '../config.js';
import { okxLogger, type Logger } from '../logger.js';

export interface OkxClients {
  rest: OkxRestClient;
  wsPublic: OkxWsClient;
  wsBusiness: OkxWsClient;
  /** null when no credentials are configured (market-data only mode) */
  wsPrivate: OkxWsClient | null;
  clock: { offsetMs: number };
  demo: boolean;
}

export function createOkxClients(cfg: AppConfig, log: Logger): OkxClients {
  const clock = { offsetMs: 0 };
  const clockOffsetMs = () => clock.offsetMs;
  // In paper mode the signed requests go to the paper exchange (restPrivate); the market data stays on OKX.
  const rest = new OkxRestClient({ baseUrl: cfg.okx.endpoints.rest, privateBaseUrl: cfg.okx.endpoints.restPrivate, credentials: cfg.okx.credentials, demo: cfg.okx.demo, clockOffsetMs });
  const wsPublic = new OkxWsClient({ url: cfg.okx.endpoints.wsPublic, name: 'public', logger: okxLogger(log.child({ ws: 'public' })) });
  const wsBusiness = new OkxWsClient({ url: cfg.okx.endpoints.wsBusiness, name: 'business', logger: okxLogger(log.child({ ws: 'business' })) });
  const wsPrivate = cfg.okx.credentials
    ? new OkxWsClient({ url: cfg.okx.endpoints.wsPrivate, name: 'private', credentials: cfg.okx.credentials, logger: okxLogger(log.child({ ws: 'private' })), clockOffsetMs })
    : null;
  return { rest, wsPublic, wsBusiness, wsPrivate, clock, demo: cfg.okx.demo };
}

/** Measure the exchange clock offset so signatures stay within OKX's ±30 s window. */
export async function syncClock(clients: OkxClients, log: Logger): Promise<void> {
  try {
    const before = Date.now();
    const serverTs = await clients.rest.getTime();
    const after = Date.now();
    const rtt = after - before;
    clients.clock.offsetMs = serverTs - (before + rtt / 2);
    if (Math.abs(clients.clock.offsetMs) > 5_000) log.warn({ offsetMs: clients.clock.offsetMs }, 'large clock offset against OKX; signatures use the corrected time');
    else log.debug({ offsetMs: clients.clock.offsetMs, rtt }, 'clock synced with OKX');
  } catch (err) {
    log.warn({ err }, 'could not sync clock with OKX; using local time');
  }
}

/** OKX could not be reached while starting. The message is written for the owner, not for a developer. */
export class OkxUnreachableAtStartError extends Error {
  constructor(cause: OkxTransportError) {
    super(
      `Pegasus could not reach OKX (${cause.message}). Check the network connection or the proxy / VPN, then start it again.\n` +
        '无法连接 OKX，请检查网络或代理（VPN）后重新启动。',
    );
    this.name = 'OkxUnreachableAtStartError';
  }
}

/**
 * Runs a start-up call that needs OKX. Only a transport failure (no answer at all) is retried, after 2 s and
 * after 5 s; an answer from OKX, whatever it says, is final.
 */
export async function reachOkxAtStart<T>(what: string, fn: () => Promise<T>, log: Logger, backoffMs: readonly number[] = [2_000, 5_000]): Promise<T> {
  for (let attempt = 0; ; attempt++) {
    try {
      return await fn();
    } catch (err) {
      if (!(err instanceof OkxTransportError)) throw err;
      const delay = backoffMs[attempt];
      if (delay === undefined) throw new OkxUnreachableAtStartError(err);
      log.warn({ err: err.message, retryInMs: delay }, `could not load ${what} from OKX; retrying`);
      await new Promise((r) => setTimeout(r, delay));
    }
  }
}

/**
 * Re-measure the offset periodically: when the OS corrects a clock that was off at boot,
 * a stale offset would push signatures outside OKX's window until the next restart.
 */
export function scheduleClockSync(clients: OkxClients, log: Logger, intervalMs = 30 * 60_000): NodeJS.Timeout {
  const timer = setInterval(() => void syncClock(clients, log), intervalMs);
  timer.unref();
  return timer;
}
