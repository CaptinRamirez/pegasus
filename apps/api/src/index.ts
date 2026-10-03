import { loadConfig } from './config.js';
import { PgStore } from './db/pg-store.js';
import { MemoryStore, type Store } from './db/store.js';
import type { Deps } from './deps.js';
import { createLogger } from './logger.js';
import { createOkxClients, syncClock } from './okx/clients.js';
import { buildServer } from './server.js';
import { AccountService } from './services/account.js';
import { MarketDataService } from './services/market-data.js';
import { OrderService } from './services/order-service.js';
import { RiskEngine } from './services/risk-engine.js';
import { SignalsService } from './services/signals.js';
import { Hub } from './ws/hub.js';

async function main(): Promise<void> {
  const config = loadConfig();
  const log = createLogger(config.server.logLevel);
  // A stray rejection must never take the trading process (and its risk controls) down.
  process.on('unhandledRejection', (reason) => log.error({ err: reason }, 'unhandled promise rejection'));
  process.on('uncaughtException', (err) => {
    log.fatal({ err }, 'uncaught exception; exiting');
    process.exit(1);
  });
  log.info({ demo: config.okx.demo, rest: config.okx.endpoints.rest, wsTrading: config.okx.wsTrading, instruments: config.instruments, host: config.server.host, port: config.server.port }, 'pegasus api starting');
  if (config.server.token === 'change-me') log.warn('API_TOKEN is the default value; set a real secret in .env before exposing this server');
  if (!config.okx.credentials) log.warn('no OKX credentials configured: running in market-data-only mode (no trading)');
  if (!config.okx.demo && config.okx.credentials) log.warn('LIVE TRADING MODE: orders will use real funds');

  let store: Store;
  if (config.databaseUrl) {
    const pg = new PgStore(config.databaseUrl);
    await pg.migrate();
    store = pg;
    log.info('postgres store ready');
  } else {
    store = new MemoryStore();
    log.warn('DATABASE_URL not set: order journal and risk state are kept in memory only');
  }

  const clients = createOkxClients(config, log);
  await syncClock(clients, log);

  const market = new MarketDataService(clients, log);
  await market.loadInstruments(config.instruments);
  log.info({ instruments: [...market.instruments.values()].map((i) => `${i.instId} ctVal=${i.ctVal}${i.ctValCcy} lot=${i.lotSz} tick=${i.tickSz}`) }, 'instruments loaded');

  const account = new AccountService(clients, store, log);
  const risk = new RiskEngine(config.risk, store, log);
  await risk.init();
  const orders = new OrderService(clients, market, account, risk, store, log, { defaultTdMode: config.defaultTdMode, wsTrading: config.okx.wsTrading });
  const signals = new SignalsService(clients, market, account, log);
  const hub = new Hub(config, market, account, risk, log);
  const deps: Deps = { config, log, clients, store, market, account, risk, orders, signals, hub };

  // Risk wiring: equity feeds the daily PnL / loss limit; exposure feeds the state shown in the UI.
  account.on('balance', (b) => risk.updateEquity(b.totalEq));
  const refreshExposure = () => risk.updateExposure(account.openOrders.size, account.totalPositionNotional());
  account.on('positions', refreshExposure);
  account.on('order', refreshExposure);
  // Kill switch: cancelling the open orders is latched and retried until it succeeds, including after a restart.
  let killWasOn = risk.state.killSwitch;
  let cancelPending = risk.state.killSwitch;
  let cancelling = false;
  const tryCancelAll = () => {
    if (!cancelPending || cancelling || !account.ready) return;
    cancelling = true;
    orders
      .cancelAll()
      .then((n) => {
        cancelPending = false;
        log.warn({ canceled: n }, 'open orders cancelled by kill switch');
      })
      .catch((err: Error) => log.error({ err: err.message }, 'cancel-all after kill switch failed; will retry'))
      .finally(() => {
        cancelling = false;
      });
  };
  risk.on('state', (s) => {
    if (s.killSwitch && !killWasOn) {
      log.warn('kill switch engaged: cancelling all open orders');
      cancelPending = true;
    }
    killWasOn = s.killSwitch;
    tryCancelAll();
  });
  account.on('status', tryCancelAll);
  setInterval(tryCancelAll, 5_000).unref();

  hub.wire();
  const app = await buildServer(deps);
  await market.start();
  void startAccount(account, log);
  await app.listen({ host: config.server.host, port: config.server.port });
  log.info({ url: `http://${config.server.host}:${config.server.port}` }, 'pegasus api listening');

  const shutdown = async (signal: string) => {
    log.info({ signal }, 'shutting down');
    try {
      await hub.close();
      await app.close();
      await Promise.all([market.stop(), account.stop()]);
      await store.close();
    } catch (err) {
      log.error({ err }, 'error during shutdown');
    } finally {
      process.exit(0);
    }
  };
  process.once('SIGINT', () => void shutdown('SIGINT'));
  process.once('SIGTERM', () => void shutdown('SIGTERM'));
}

/** The private side needs REST calls that may fail transiently; keep retrying without blocking market data. */
async function startAccount(account: AccountService, log: ReturnType<typeof createLogger>): Promise<void> {
  if (!account.enabled) return;
  for (let attempt = 1; ; attempt++) {
    try {
      await account.start();
      return;
    } catch (err) {
      const delay = Math.min(60_000, 5_000 * attempt);
      log.error({ err: (err as Error).message, attempt, retryInMs: delay }, 'account service failed to start; retrying');
      await new Promise((r) => setTimeout(r, delay));
    }
  }
}

main().catch((err: unknown) => {
  console.error('fatal:', err);
  process.exit(1);
});
