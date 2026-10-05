/**
 * @pegasus/backtest/campaign: the campaign replay as a library, for the API's replay beside the live pot. The rule is
 * @pegasus/shared's; the replay (engine.ts) keeps the book; pot.ts runs it from a pot's start and reconciles the
 * pot's ledger with it; the data comes through the fetchers and the cache of ../data.
 */
export { FileCache, MemoryCache, type CacheStore } from '../data/cache.js';
export type { Fetchers, HistoryBar } from '../data/load.js';
export { offlineFetchers, ReadOnlyCache } from '../data/offline.js';
export { createFetchers, type SourceOptions } from '../data/sources.js';
export { runCampaigns } from './engine.js';
export { DEFAULT_CAMPAIGN_CONFIG } from './options.js';
export {
  DEFAULT_RECONCILE_TOLERANCES,
  formatPotReplay,
  HELD_INSTRUMENT,
  heldInBtc,
  parseLedger,
  reconcileCampaigns,
  reconcileMismatches,
  replayPot,
  replayView,
  type PotReplay,
  type PotReplayInput,
  type PotReplaySources,
  type ReconcileTolerances,
} from './pot.js';
export type { CampaignConfig, CampaignInstrument, CampaignRecord, CampaignResult } from './types.js';
