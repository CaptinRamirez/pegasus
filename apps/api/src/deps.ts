import type { AppConfig } from './config.js';
import type { Store } from './db/store.js';
import type { Logger } from './logger.js';
import type { OkxClients } from './okx/clients.js';
import type { AccountService } from './services/account.js';
import type { CampaignService } from './services/campaign.js';
import type { CampaignOrders } from './services/campaign-orders.js';
import type { ChannelTrailingService } from './services/channel-trailing.js';
import type { ExitFollowUp } from './services/exit-orders.js';
import type { CampaignSignalsService } from './services/campaign-signals.js';
import type { JournalService } from './services/journal.js';
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
  /** The campaign's order operations; only while the campaign is enabled (CAMPAIGN_ENABLED=1, paper trading only). */
  campaignOrders?: CampaignOrders;
  /** The service that runs the campaigns and keeps the pot's ledger; only while the campaign is enabled. */
  campaign?: CampaignService;
  /** The trade journal (services/journal.ts); absent in a server built without one (GET /api/journal then answers status 'disabled'). */
  journal?: JournalService;
  /** The campaign rule read per coin (GET /api/campaign/signals); created by the route on first use when absent. */
  campaignSignals?: CampaignSignalsService;
  /** Channel trailing (services/channel-trailing.ts); absent in a server built without it, where its routes answer EXITS_UNAVAILABLE. */
  trailing?: ChannelTrailingService;
  /** The trailing exits that follow an opening order, and the leftovers of closed positions (services/exit-orders.ts). */
  exitFollowUp?: ExitFollowUp;
}
