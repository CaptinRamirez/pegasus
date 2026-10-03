import type { AppConfig } from './config.js';
import type { Store } from './db/store.js';
import type { Logger } from './logger.js';
import type { OkxClients } from './okx/clients.js';
import type { AccountService } from './services/account.js';
import type { MarketDataService } from './services/market-data.js';
import type { OrderService } from './services/order-service.js';
import type { RiskEngine } from './services/risk-engine.js';
import type { SignalsService } from './services/signals.js';
import type { Hub } from './ws/hub.js';

export interface Deps {
  config: AppConfig;
  log: Logger;
  clients: OkxClients;
  store: Store;
  market: MarketDataService;
  account: AccountService;
  risk: RiskEngine;
  orders: OrderService;
  signals: SignalsService;
  hub: Hub;
}
