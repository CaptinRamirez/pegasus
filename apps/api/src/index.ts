import { loadConfig } from './config.js';
import { PgStore } from './db/pg-store.js';
import { MemoryStore, type Store } from './db/store.js';
import type { Deps } from './deps.js';
import { createLogger } from './logger.js';
import { createOkxClients, OkxUnreachableAtStartError, reachOkxAtStart, scheduleClockSync, syncClock } from './okx/clients.js';
import { buildServer } from './server.js';
import { AccountService } from './services/account.js';
import { KillSwitchSweeper } from './services/kill-switch-sweeper.js';
import { MarketDataService } from './services/market-data.js';
import { OrderService } from './services/order-service.js';
import { RiskEngine } from './services/risk-engine.js';
import { SignalsService } from './services/signals.js';
import { Hub } from './ws/hub.js';

async function main(): Promise<void> {
  const config = loadConfig();
  const log = createLogger(config.server.logLevel, { logDir: config.logDir });
  // A stray rejection must never take the trading process (and its risk controls) down.
  process.on('unhandledRejection', (reason) => log.error({ err: reason }, 'unhandled promise rejection'));
  process.on('uncaughtException', (err) => {
    log.fatal({ err }, 'uncaught exception; exiting');
    process.exit(1);
  });
  log.info({ version: config.version, demo: config.okx.demo, paper: config.okx.paper, rest: config.okx.endpoints.rest, wsTrading: config.okx.wsTrading, logDir: config.logDir, instruments: config.instruments, host: config.server.host, port: config.server.port }, 'pegasus api starting');
  if (config.server.token === 'change-me') log.warn('API_TOKEN is the default value; set a real secret in .env before exposing this server');
  if (!config.okx.credentials) log.warn('no OKX credentials configured: running in market-data-only mode (no trading)');
  if (config.okx.paper) log.info({ paperExchange: config.okx.endpoints.restPrivate }, 'PAPER TRADING MODE: orders, positions and balance are simulated by the paper exchange; market data is OKX live data; nothing is sent to an OKX account');
  else if (!config.okx.demo && config.okx.credentials) log.warn('LIVE TRADING MODE: orders will use real funds');

  let store: Store;
  if (config.databaseUrl) {
    const pg = new PgStore(config.databaseUrl);
    await pg.migrate();
    store = pg;
    log.info('postgres store ready');
  } else {
    store = new MemoryStore(config.stateFile);
    log.warn({ stateFile: config.stateFile }, 'DATABASE_URL not set: the order journal is kept in memory only; the kill switch and the day baseline are saved to the state file');
  }

  const clients = createOkxClients(config, log);
  await syncClock(clients, log);
  scheduleClockSync(clients, log);

  const market = new MarketDataService(clients, log);
  try {
    await reachOkxAtStart('the instruments', () => market.loadInstruments(config.instruments), log);
  } catch (err) {
    if (err instanceof OkxUnreachableAtStartError) log.fatal({ rest: config.okx.endpoints.rest }, err.message);
    throw err;
  }
  log.info({ instruments: [...market.instruments.values()].map((i) => `${i.instId} ctVal=${i.ctVal}${i.ctValCcy} lot=${i.lotSz} tick=${i.tickSz}`) }, 'instruments loaded');

  const account = new AccountService(clients, store, log);
  const risk = new RiskEngine(config.risk, store, log);
  await risk.init();
  const orders = new OrderService(clients, market, account, risk, store, log, { defaultTdMode: config.defaultTdMode, wsTrading: config.okx.wsTrading });
  const signals = new SignalsService(clients, market, account, log, undefined, config.signalPhases);
  const hub = new Hub(config, market, account, risk, log);
  const deps: Deps = { config, log, clients, store, market, account, risk, orders, signals, hub };

  // Risk wiring: equity feeds the daily PnL / loss limit; exposure feeds the state shown in the UI.
  account.on('balance', (b) => risk.updateEquity(b.totalEq));
  const refreshExposure = () => risk.updateExposure(account.openOrders.size, account.totalPositionNotional(), account.positionList(), (id) => market.specOf(id));
  account.on('positions', refreshExposure);
  account.on('order', refreshExposure);
  // Kill switch: the open orders are cancelled when it goes on, and after a restart with the switch restored unless that sweep had already completed.
  new KillSwitchSweeper(risk, account, orders, log).start();

  hub.wire();
  const app = await buildServer(deps);
  await market.start();
  void account.startWithRetry();
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

main().catch((err: unknown) => {
  // Something the owner can act on is said in plain words; anything else keeps its stack for a developer.
  if (err instanceof OkxUnreachableAtStartError || (err instanceof Error && err.message.startsWith('invalid configuration'))) console.error(`\n${err.message}\n`);
  else console.error('fatal:', err);
  process.exit(1);
});
