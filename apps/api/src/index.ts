import { createFetchers, FileCache } from '@pegasus/backtest/campaign';
import { loadConfig } from './config.js';
import { PgStore } from './db/pg-store.js';
import { MemoryStore, type Store } from './db/store.js';
import type { Deps } from './deps.js';
import { createLogger } from './logger.js';
import { createOkxClients, OkxUnreachableAtStartError, reachOkxAtStart, scheduleClockSync, syncClock } from './okx/clients.js';
import { buildServer } from './server.js';
import { AccountService } from './services/account.js';
import { CampaignService, disabledCampaignView } from './services/campaign.js';
import { CampaignOrders } from './services/campaign-orders.js';
import { CampaignSignalsService } from './services/campaign-signals.js';
import { campaignOwns, ChannelTrailingService } from './services/channel-trailing.js';
import { ExitFollowUp } from './services/exit-orders.js';
import { ExitStateFile } from './services/exit-state.js';
import { JournalService } from './services/journal.js';
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
  log.info({ version: config.version, demo: config.okx.demo, paper: config.okx.paper, rest: config.okx.endpoints.rest, wsTrading: config.okx.wsTrading, logDir: config.logDir, instruments: config.instruments, campaign: config.campaign.enabled, host: config.server.host, port: config.server.port }, 'pegasus api starting');
  if (config.server.token === 'change-me') log.warn('API_TOKEN is the default value (allowed only with no OKX account behind the API and loopback binding); set a random secret in .env before connecting an OKX key or exposing this server');
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

  // The trailing stops are read only where the exits of this stage are offered (paper trading, the local mock).
  const account = new AccountService(clients, store, log, { readTrailingStops: config.exits.enabled });
  const risk = new RiskEngine(config.risk, store, log);
  await risk.init();
  const orders = new OrderService(clients, market, account, risk, store, log, { defaultTdMode: config.defaultTdMode, wsTrading: config.okx.wsTrading, exits: config.exits.enabled });
  const signals = new SignalsService(clients, market, account, log, undefined, config.signalPhases);
  const hub = new Hub(config, market, account, risk, log);
  // The trade journal: every trade of the account, in its own file (JOURNAL_FILE); each change reaches the terminals.
  const journal = new JournalService({ clients, market, account, onPlaced: (listener) => orders.onPlaced(listener), log: log.child({ component: 'journal' }) }, { file: config.journalFile });
  journal.on('change', (update) => hub.broadcast({ type: 'journal', data: update }));
  const deps: Deps = { config, log, clients, store, market, account, risk, orders, signals, hub, journal };
  // Paper only: loadConfig refuses CAMPAIGN_ENABLED=1 without the paper exchange.
  let campaign: CampaignService | null = null;
  if (config.campaign.enabled) {
    const campaignOrders = new CampaignOrders(clients, market, account, orders, risk, store, log, { leverage: config.campaign.leverage, feeRate: config.campaign.feeRate, paper: config.okx.paper });
    deps.campaignOrders = campaignOrders;
    // The replay beside the pot reads OKX's public history (the market data hosts) and its funding, what the paper exchange charged.
    const replay = { fetchers: createFetchers({ okxBaseUrl: config.okx.endpoints.rest, funding: 'okx' }), cache: new FileCache(config.campaign.replayCacheDir), log: (message: string) => log.debug({ component: 'campaign-replay' }, message) };
    const service = new CampaignService(config.campaign, { clients, market, account, risk, orders: campaignOrders, log }, { ledgerFile: config.campaign.stateFile, replay: { sources: replay } });
    // Every change of the ledger reaches the terminals; a terminal that connects gets the state after hello.
    service.on('change', (view) => hub.broadcast({ type: 'campaign', data: view }));
    hub.setCampaignView(() => service.view());
    deps.campaign = service;
    campaign = service;
    log.info({ instruments: config.campaign.instruments, potStart: config.campaign.potStart, minStake: config.campaign.minStake, structure: config.campaign.structure, ledger: config.campaign.stateFile }, 'CAMPAIGN ENABLED on the paper exchange');
  }
  // Exits of this stage (paper trading and the local mock): channel trailing and the trailing exits that follow an opening order, kept in TRAILING_STATE_FILE.
  const exitState = new ExitStateFile(config.exits.stateFile);
  const trailing = new ChannelTrailingService({ clients, account, orders, market, store, log }, { enabled: config.exits.enabled, state: exitState, isCampaignPosition: (p) => campaignOwns(deps.campaign, p) });
  const exitFollowUp = new ExitFollowUp({ clients, account, orders, channel: trailing, store, log }, { enabled: config.exits.enabled, state: exitState });
  deps.trailing = trailing;
  deps.exitFollowUp = exitFollowUp;
  // The campaign rule read per coin with a plan to follow each signal by hand (GET /api/campaign/signals).
  deps.campaignSignals = new CampaignSignalsService({ config, clients, market, account, risk, journal, campaign: campaign ?? undefined, disabledView: () => disabledCampaignView(config.campaign), log });

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
  // Before the account starts: the journal hears every event of it (and reads what it missed while the API was down).
  await journal.start();
  // Before the account starts as well: the exits hear its order pushes; channel trailing waits for the account by itself.
  exitFollowUp.start();
  trailing.start();
  void account.startWithRetry();
  await app.listen({ host: config.server.host, port: config.server.port });
  log.info({ url: `http://${config.server.host}:${config.server.port}` }, 'pegasus api listening');
  // The ledger, the pot's start or the closes missed while the API was down; it waits for the account by itself.
  if (campaign) void campaign.start().catch((err: unknown) => log.error({ err }, 'the campaign service could not start'));

  const shutdown = async (signal: string) => {
    log.info({ signal }, 'shutting down');
    try {
      await campaign?.stop();
      await journal.stop();
      exitFollowUp.stop();
      await trailing.stop();
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
