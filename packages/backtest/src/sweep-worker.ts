import { parentPort, workerData } from 'node:worker_threads';
import { sweepRow } from './sweep.js';
import type { EngineConfig, InstrumentData } from './types.js';

/** One worker of the sweep pool: holds the history, runs the configurations it is sent. */
const data = (workerData as { data: InstrumentData[] }).data;
parentPort?.on('message', (job: { index: number; config: EngineConfig }) => {
  parentPort?.postMessage({ index: job.index, row: sweepRow(data, job.config) });
});
