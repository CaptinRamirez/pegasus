import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { FileCache } from './data/cache.js';
import { loadData } from './data/load.js';
import { createFetchers } from './data/sources.js';
import { runBacktest } from './engine.js';
import { HELP, parseCli, UsageError, type CliOptions } from './options.js';
import { buildSummary, equityCsv, formatSummary, tradesCsv } from './report.js';
import { runSweep, sweepConfigs, type SweepRow } from './sweep.js';
import type { InstrumentData } from './types.js';

/**
 * pnpm backtest: load the history (cache first), run the engine, print the summary and write the
 * trades and the daily equity series. Progress goes to stderr, the result to stdout.
 */

const PACKAGE_DIR = resolve(dirname(fileURLToPath(import.meta.url)), '..');
/** pnpm runs the script in the package directory; paths the user typed are relative to where they typed them. */
const USER_DIR = process.env['INIT_CWD'] ?? process.cwd();

const progress = (message: string): void => {
  process.stderr.write(`${message}\n`);
};

function readLiveR(file: string): number[] {
  const parsed: unknown = JSON.parse(readFileSync(resolve(USER_DIR, file), 'utf8'));
  if (!Array.isArray(parsed) || parsed.length === 0 || !parsed.every((v) => typeof v === 'number' && Number.isFinite(v))) throw new UsageError(`--live-r: ${file} must hold a non-empty JSON array of numbers`);
  return parsed as number[];
}

/** One line per combination of the grid: is the result a plateau or a single point (docs/strategy.md section 5)? */
async function sweep(opts: CliOptions, data: readonly InstrumentData[]): Promise<void> {
  if (!opts.sweep) return;
  const configs = sweepConfigs(opts.sweep, opts.config);
  progress(`sweep: ${configs.length} combinations`);
  const rows: SweepRow[] = [];
  if (!opts.json) process.stdout.write('entry exit  atr   trades  meanR   totalR  Sharpe   maxDD\n');
  await runSweep(data, configs, (row) => {
    rows.push(row);
    if (opts.json) return;
    process.stdout.write(
      `${String(row.entry).padStart(5)} ${String(row.exit).padStart(4)} ${row.atr.padStart(4)} ${String(row.trades).padStart(8)} ${row.meanR.toFixed(2).padStart(6)} ${row.totalR.toFixed(1).padStart(8)} ` +
        `${(row.sharpe ?? 0).toFixed(2).padStart(7)} ${(row.maxDrawdown * 100).toFixed(1).padStart(6)}%\n`,
    );
  });
  if (opts.json) process.stdout.write(`${JSON.stringify(rows, null, 2)}\n`);
}

async function main(): Promise<void> {
  const opts = parseCli(process.argv.slice(2));
  if (opts.help) {
    process.stdout.write(HELP);
    return;
  }
  const liveR = opts.liveR !== null ? readLiveR(opts.liveR) : null;
  const cacheDir = opts.cache !== null ? resolve(USER_DIR, opts.cache) : join(PACKAGE_DIR, '.cache');
  const outDir = opts.out !== null ? resolve(USER_DIR, opts.out) : join(PACKAGE_DIR, 'out');

  const started = Date.now();
  const { data, notes } = await loadData(
    { instIds: opts.instIds, phases: opts.config.phases, openInterest: opts.config.oiMode !== 'none', funding: true, now: started, refresh: opts.refresh, log: progress },
    createFetchers(),
    new FileCache(cacheDir),
  );
  const loaded = Date.now();
  progress(`history loaded in ${((loaded - started) / 1000).toFixed(1)} s (cache ${cacheDir})`);

  if (opts.sweep) {
    await sweep(opts, data);
    progress(`sweep done in ${((Date.now() - loaded) / 1000).toFixed(1)} s`);
    return;
  }

  const result = runBacktest(data, opts.config);
  progress(`backtest done in ${((Date.now() - loaded) / 1000).toFixed(1)} s`);
  const summary = buildSummary(result, opts.config, notes, liveR);
  mkdirSync(outDir, { recursive: true });
  writeFileSync(join(outDir, 'trades.csv'), tradesCsv(result.trades));
  writeFileSync(join(outDir, 'equity.csv'), equityCsv(result));
  writeFileSync(join(outDir, 'summary.json'), `${JSON.stringify(summary, null, 2)}\n`);
  process.stdout.write(opts.json ? `${JSON.stringify(summary, null, 2)}\n` : `${formatSummary(summary)}\n`);
  progress(`trades.csv, equity.csv and summary.json written to ${outDir}`);
}

main().catch((err: unknown) => {
  if (err instanceof UsageError) {
    process.stderr.write(`${err.message}\n\n${HELP}`);
    process.exitCode = 2;
    return;
  }
  process.stderr.write(`backtest failed: ${(err as Error).message}\n`);
  process.exitCode = 1;
});
