import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';
import { CAMPAIGN_INSTRUMENTS, type CampaignParams } from '@pegasus/shared';
import { FileCache } from '../data/cache.js';
import { loadData } from '../data/load.js';
import { offlineFetchers, ReadOnlyCache } from '../data/offline.js';
import { createFetchers } from '../data/sources.js';
import { runCampaigns } from './engine.js';
import { DEFAULT_CAMPAIGN_CONFIG } from './options.js';
import { multipleStats } from './report.js';
import type { CampaignConfig, CampaignInstrument, CampaignResult } from './types.js';

/**
 * The cut-hour experiment (docs/proposals/cut-hour.md): does the hour of the daily close change what the rule does?
 * The pot of the approved rule, and of the 3 ATR variant beside it, is replayed from every monthly start of the
 * evidence (docs/strategy.md 3.2: 2020-02 to 2026-04, 75 starts) at each daily cut asked for: 0 is the exchange's own
 * 00:00 UTC bars, the others (4, 8, 12, 16, 20) are built from its 4-hour candles (loadData's cutHour). One row per cut
 * and variant: what the 75 pots banked together, how many banked at least 3,000, the median days a pot lived, how many
 * were alive at the end; then the catalogue of every signal at that cut. Every start goes to out/cut-hour-sweep.csv.
 *
 *   pnpm --filter @pegasus/backtest cut-hour-sweep [--cuts 0,20] [--offline] [--cache dir] [--out dir]
 */

const PACKAGE_DIR = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');
const USER_DIR = process.env['INIT_CWD'] ?? process.cwd();
const DAY_MS = 86_400_000;
const FIRST_START = Date.UTC(2020, 1, 1);
const LAST_START = Date.UTC(2026, 3, 1);
/** The pass line of the proposal counts the starts that banked this much */
const BIG_BANK = 3000;

const VARIANTS: Record<string, Partial<CampaignParams>> = { base: {}, atr3: { atrLeverage: '3' } };

const progress = (message: string): void => {
  process.stderr.write(`${message}\n`);
};

function monthlyStarts(): number[] {
  const starts: number[] = [];
  for (let t = FIRST_START; t <= LAST_START; ) {
    starts.push(t);
    const d = new Date(t);
    t = Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + 1, 1);
  }
  return starts;
}

interface StartRow {
  cut: number;
  variant: string;
  start: number;
  banked: number;
  endValue: number;
  finishedAt: number | null;
  survivalDays: number;
  campaigns: number;
  liquidated: number;
}

function row(cut: number, variant: string, start: number, r: CampaignResult): StartRow {
  const end = r.end;
  const to = r.finishedAt ?? r.span?.to ?? start;
  return {
    cut,
    variant,
    start,
    banked: end ? Number(end.banked) : 0,
    endValue: end ? Number(end.value) : 0,
    finishedAt: r.finishedAt,
    survivalDays: Math.round((to - start) / DAY_MS),
    campaigns: r.campaigns.length,
    liquidated: r.campaigns.filter((c) => c.end === 'liquidated').length,
  };
}

const median = (xs: readonly number[]): number => {
  const s = [...xs].sort((a, b) => a - b);
  const mid = Math.floor(s.length / 2);
  return s.length === 0 ? 0 : s.length % 2 === 1 ? (s[mid] as number) : ((s[mid - 1] as number) + (s[mid] as number)) / 2;
};
const isoDate = (ts: number): string => new Date(ts).toISOString().slice(0, 10);

async function main(): Promise<void> {
  const { values } = parseArgs({
    args: process.argv.slice(2),
    strict: true,
    options: { cuts: { type: 'string' }, offline: { type: 'boolean' }, cache: { type: 'string' }, out: { type: 'string' } },
  });
  const cuts = (values.cuts ?? '0,4,8,12,16,20').split(',').map((s) => Number(s.trim()));
  if (cuts.some((h) => ![0, 4, 8, 12, 16, 20].includes(h))) throw new Error('--cuts takes hours among 0, 4, 8, 12, 16, 20');
  const cacheDir = values.cache !== undefined ? resolve(USER_DIR, values.cache) : join(PACKAGE_DIR, '.cache');
  const outDir = values.out !== undefined ? resolve(USER_DIR, values.out) : join(PACKAGE_DIR, 'out');
  const files = new FileCache(cacheDir);
  const starts = monthlyStarts();
  const rows: StartRow[] = [];
  const lines: string[] = [`cut | variant | banked (75 starts) | banked >0 | banked >= ${BIG_BANK} | median days alive | alive at end | banked by 2022+ starts`];
  const catalogue: string[] = ['cut | signals | lost | mean | max'];

  for (const cut of cuts) {
    const started = Date.now();
    const { data } = await loadData(
      { instIds: CAMPAIGN_INSTRUMENTS, phases: [0, 12], openInterest: false, funding: true, now: started, refresh: false, log: progress, ...(cut !== 0 ? { cutHour: cut } : {}) },
      values.offline === true ? offlineFetchers() : createFetchers(),
      values.offline === true ? new ReadOnlyCache(files) : files,
    );
    const instruments: CampaignInstrument[] = data;
    progress(`cut ${cut}: history loaded in ${((Date.now() - started) / 1000).toFixed(1)} s`);
    const base: CampaignConfig = { ...DEFAULT_CAMPAIGN_CONFIG, ...(cut !== 0 ? { cutHour: cut } : {}) };

    const cat = runCampaigns(instruments, { ...base, mode: 'catalogue' });
    const stats = multipleStats(cat.campaigns);
    const max = cat.campaigns.reduce((m, c) => Math.max(m, Number(c.multiple)), 0);
    catalogue.push(`${cut} | ${stats.count} | ${(stats.lost * 100).toFixed(0)}% | ${stats.mean.toFixed(2)} | ${max.toFixed(0)}`);

    for (const [variant, over] of Object.entries(VARIANTS)) {
      const config: CampaignConfig = { ...base, params: { ...base.params, ...over } };
      const own: StartRow[] = [];
      for (const start of starts) own.push(row(cut, variant, start, runCampaigns(instruments, { ...config, from: start })));
      rows.push(...own);
      const banked = own.reduce((s, r) => s + r.banked, 0);
      const late = own.filter((r) => r.start >= Date.UTC(2022, 0, 1) && r.banked > 0).length;
      lines.push(
        `${cut} | ${variant} | ${banked.toFixed(0)} | ${own.filter((r) => r.banked > 0).length} | ${own.filter((r) => r.banked >= BIG_BANK).length} | ${median(own.map((r) => r.survivalDays)).toFixed(0)} | ${own.filter((r) => r.finishedAt === null).length} | ${late}`,
      );
      progress(`cut ${cut} ${variant}: ${starts.length} starts replayed (${((Date.now() - started) / 1000).toFixed(0)} s so far)`);
    }
  }

  mkdirSync(outDir, { recursive: true });
  const csv = ['cut,variant,start,banked,endValue,finishedAt,survivalDays,campaigns,liquidated', ...rows.map((r) => [r.cut, r.variant, isoDate(r.start), r.banked.toFixed(2), r.endValue.toFixed(2), r.finishedAt === null ? '' : isoDate(r.finishedAt), r.survivalDays, r.campaigns, r.liquidated].join(','))].join('\n');
  writeFileSync(join(outDir, 'cut-hour-sweep.csv'), `${csv}\n`);
  process.stdout.write(`${lines.join('\n')}\n\n${catalogue.join('\n')}\n`);
  progress(`every start written to ${join(outDir, 'cut-hour-sweep.csv')}`);
}

main().catch((err: unknown) => {
  process.stderr.write(`cut-hour sweep failed: ${(err as Error).message}\n`);
  process.exitCode = 1;
});
