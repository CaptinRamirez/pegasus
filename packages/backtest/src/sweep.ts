import { availableParallelism } from 'node:os';
import { Worker } from 'node:worker_threads';
import { runBacktest } from './engine.js';
import type { SweepGrid } from './options.js';
import { closedR } from './report.js';
import { rStats, seriesStats } from './stats.js';
import type { EngineConfig, InstrumentData } from './types.js';

/**
 * The parameter grid of docs/archive/strategy-breakout.md section 5: the same run for every combination of entry
 * channel, exit channel and stop multiple. A good system earns over a region of the grid, not at a point.
 *
 * A run spends nearly all its time inside buildSignalReport, so the combinations are spread over
 * worker threads; each worker gets the history once.
 */

export interface SweepRow {
  entry: number;
  exit: number;
  atr: string;
  trades: number;
  meanR: number;
  totalR: number;
  sharpe: number | null;
  maxDrawdown: number;
}

export function sweepConfigs(grid: SweepGrid, config: EngineConfig): EngineConfig[] {
  const out: EngineConfig[] = [];
  for (const entryChannel of grid.entry) {
    for (const exitChannel of grid.exit) {
      for (const atrStopMultiple of grid.atr) out.push({ ...config, params: { ...config.params, entryChannel, exitChannel, atrStopMultiple } });
    }
  }
  return out;
}

export function sweepRow(data: readonly InstrumentData[], config: EngineConfig): SweepRow {
  const result = runBacktest(data, config);
  const r = rStats(closedR(result));
  const portfolio = seriesStats(result.series.map((s) => Number(s.equity)));
  return {
    entry: config.params.entryChannel,
    exit: config.params.exitChannel,
    atr: config.params.atrStopMultiple,
    trades: r.count,
    meanR: r.mean,
    totalR: r.total,
    sharpe: portfolio.sharpe,
    maxDrawdown: portfolio.maxDrawdown,
  };
}

/**
 * Runs every configuration and reports each row, in grid order, as soon as it and the rows before it
 * are done. `threads` = 1 runs them here, one after the other.
 */
export async function runSweep(data: readonly InstrumentData[], configs: readonly EngineConfig[], onRow: (row: SweepRow) => void, threads = Math.max(1, availableParallelism() - 1)): Promise<void> {
  const size = Math.min(threads, configs.length);
  if (size <= 1) {
    for (const config of configs) onRow(sweepRow(data, config));
    return;
  }
  const rows = new Map<number, SweepRow>();
  let next = 0;
  let reported = 0;
  await new Promise<void>((resolve, reject) => {
    const workers: Worker[] = [];
    const stop = (err?: Error): void => {
      for (const w of workers) void w.terminate();
      if (err) reject(err);
      else resolve();
    };
    const give = (worker: Worker): void => {
      const config = configs[next];
      if (config !== undefined) worker.postMessage({ index: next++, config });
    };
    for (let k = 0; k < size; k++) {
      // The worker inherits this process's loader, so it runs from source like the CLI.
      const worker = new Worker(new URL('./sweep-worker.ts', import.meta.url), { workerData: { data } });
      workers.push(worker);
      worker.on('error', (err) => stop(err));
      worker.on('message', (done: { index: number; row: SweepRow }) => {
        rows.set(done.index, done.row);
        for (let row = rows.get(reported); row !== undefined; row = rows.get(reported)) {
          onRow(row);
          rows.delete(reported++);
        }
        if (reported === configs.length) stop();
        else give(worker);
      });
      give(worker);
    }
  });
}
