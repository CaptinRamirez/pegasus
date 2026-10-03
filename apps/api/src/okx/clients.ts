import { OkxRestClient, OkxWsClient } from '@pegasus/okx';
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
  const rest = new OkxRestClient({ baseUrl: cfg.okx.endpoints.rest, credentials: cfg.okx.credentials, demo: cfg.okx.demo, clockOffsetMs });
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
