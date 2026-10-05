import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { CAMPAIGN_INSTRUMENTS } from '@pegasus/shared';
import { FileCache } from '../data/cache.js';
import { loadData } from '../data/load.js';
import { offlineFetchers, ReadOnlyCache } from '../data/offline.js';
import { createFetchers } from '../data/sources.js';
import { UsageError } from '../options.js';
import { checkCampaigns, compareWithReference, parseReference, referenceConfig, referenceWarmup, type CampaignReference } from './check.js';
import { runCampaigns } from './engine.js';
import { CAMPAIGN_HELP, parseCampaignCli, type CampaignCliOptions } from './options.js';
import { formatPotReplay, parseLedger, replayPot, replayView } from './pot.js';
import { bankingsCsv, buildCampaignSummary, campaignsCsv, formatCampaignSummary, potCsv } from './report.js';
import type { CampaignInstrument } from './types.js';

/**
 * pnpm backtest:campaign: load the history (cache first, or the cache alone), replay the campaign
 * rule, print the summary and write the campaigns, the pot's daily path and its harvests. With --check the replay is
 * that of a reference run and is compared with it. With --reconcile the pot of a campaign ledger is replayed and the
 * ledger reconciled with it (nothing is written). Progress goes to stderr, the result to stdout.
 */

const PACKAGE_DIR = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');
/** pnpm runs the script in the package directory; paths the user typed are relative to where they typed them. */
const USER_DIR = process.env['INIT_CWD'] ?? process.cwd();

const progress = (message: string): void => {
  process.stderr.write(`${message}\n`);
};

function readReference(file: string): CampaignReference {
  let parsed: unknown;
  try {
    parsed = JSON.parse(readFileSync(resolve(USER_DIR, file), 'utf8'));
  } catch (err) {
    throw new UsageError(`--check: cannot read ${file} (${(err as Error).message})`);
  }
  try {
    return parseReference(parsed);
  } catch (err) {
    throw new UsageError(`--check: ${file} is ${(err as Error).message}`);
  }
}

/**
 * --reconcile: the pot of a campaign ledger replayed from its start with its own rule, the other structure beside
 * it, its start value held in BTC, and the ledger reconciled with the replay (pot.ts). OKX's own funding history,
 * cached apart from the proxy venue's.
 */
async function reconcile(opts: CampaignCliOptions, file: string): Promise<void> {
  let ledger: ReturnType<typeof parseLedger>;
  try {
    ledger = parseLedger(JSON.parse(readFileSync(resolve(USER_DIR, file), 'utf8')));
  } catch (err) {
    throw new UsageError(`--reconcile: cannot use ${file} (${(err as Error).message})`);
  }
  const cacheDir = opts.cache !== null ? resolve(USER_DIR, opts.cache) : join(PACKAGE_DIR, '.cache');
  const files = new FileCache(cacheDir);
  const now = Date.now();
  const replay = await replayPot(
    { pot: ledger.pot, campaigns: ledger.campaigns, instruments: opts.instIds ?? CAMPAIGN_INSTRUMENTS, now },
    { fetchers: opts.offline ? offlineFetchers('okx') : createFetchers({ funding: 'okx' }), cache: opts.offline ? new ReadOnlyCache(files) : files, refresh: opts.refresh, log: progress },
  );
  progress(`replayed in ${((Date.now() - now) / 1000).toFixed(1)} s (cache ${cacheDir}${opts.offline ? ', offline' : ''})`);
  process.stdout.write(opts.json ? `${JSON.stringify(replayView(replay, now), null, 2)}\n` : `${formatPotReplay(replay, ledger.pot)}\n`);
}

async function main(): Promise<void> {
  const opts = parseCampaignCli(process.argv.slice(2));
  if (opts.help) {
    process.stdout.write(CAMPAIGN_HELP);
    return;
  }
  if (opts.reconcile !== null) {
    await reconcile(opts, opts.reconcile);
    return;
  }
  const reference = opts.check !== null ? readReference(opts.check) : null;
  const { structure } = opts.config.params;
  const config = reference ? referenceConfig(reference, structure, opts.exchangeLimits) : opts.config;
  const instIds = opts.instIds ?? (reference ? Object.values(reference.instruments) : CAMPAIGN_INSTRUMENTS);
  const cacheDir = opts.cache !== null ? resolve(USER_DIR, opts.cache) : join(PACKAGE_DIR, '.cache');
  const outDir = opts.out !== null ? resolve(USER_DIR, opts.out) : join(PACKAGE_DIR, 'out');

  const started = Date.now();
  const files = new FileCache(cacheDir);
  const { data, notes } = await loadData(
    { instIds, phases: [0, 12], openInterest: false, funding: config.funding, now: started, refresh: opts.refresh, log: progress },
    opts.offline ? offlineFetchers() : createFetchers(),
    opts.offline ? new ReadOnlyCache(files) : files,
  );
  for (const d of data) {
    if (d.daily.length === 0 || d.halfDay.length === 0) throw new Error(`${d.inst.instId}: no daily or no 12-hour candles${opts.offline ? ` in the cache ${cacheDir}` : ''}`);
  }
  const loaded = Date.now();
  progress(`history loaded in ${((loaded - started) / 1000).toFixed(1)} s (cache ${cacheDir}${opts.offline ? ', offline' : ''})`);

  const instruments: CampaignInstrument[] = data.map((d) => (reference ? { ...d, warmup: referenceWarmup(reference, d.inst.instId) } : d));
  const result = runCampaigns(instruments, config);
  progress(`replay done in ${((Date.now() - loaded) / 1000).toFixed(1)} s`);
  const summary = buildCampaignSummary(result, config, notes);
  if (reference) {
    summary.check = opts.exchangeLimits ? compareWithReference(result, reference, structure) : checkCampaigns(result, reference, structure);
    if (!summary.check.ok) process.exitCode = 1;
  }
  mkdirSync(outDir, { recursive: true });
  writeFileSync(join(outDir, 'campaigns.csv'), campaignsCsv(result.campaigns));
  // The catalogue has no pot.
  if (result.end) {
    writeFileSync(join(outDir, 'pot.csv'), potCsv(result.pot));
    writeFileSync(join(outDir, 'bankings.csv'), bankingsCsv(result.bankings));
  }
  writeFileSync(join(outDir, 'campaign-summary.json'), `${JSON.stringify(summary, null, 2)}\n`);
  process.stdout.write(opts.json ? `${JSON.stringify(summary, null, 2)}\n` : `${formatCampaignSummary(summary)}\n`);
  progress(`campaigns.csv, ${result.end ? 'pot.csv, bankings.csv, ' : ''}campaign-summary.json written to ${outDir}`);
}

main().catch((err: unknown) => {
  if (err instanceof UsageError) {
    process.stderr.write(`${err.message}\n\n${CAMPAIGN_HELP}`);
    process.exitCode = 2;
    return;
  }
  process.stderr.write(`campaign replay failed: ${(err as Error).message}\n`);
  process.exitCode = 1;
});
