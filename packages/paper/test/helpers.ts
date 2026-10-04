import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { d, type OkxInstrument, type OkxOrderAck } from '@pegasus/mock-okx/engine';
import { PaperExchange, type Bar, type BarSize, type BarSource, type FundingSource, type PaperConfig } from '../src/index.js';

export const BTC = 'BTC-USDT-SWAP';
export const ETH = 'ETH-USDT-SWAP';
export const MIN = 60_000;
/** 2026-10-05 00:00:00 UTC: a funding time, and the start of an hour. */
export const T0 = Date.UTC(2026, 9, 5);

export const spec = (instId: string, overrides: Partial<OkxInstrument> = {}): OkxInstrument => ({
  instType: 'SWAP', instId, uly: instId.replace('-SWAP', ''), instFamily: instId.replace('-SWAP', ''), baseCcy: '', quoteCcy: '', settleCcy: 'USDT',
  ctVal: '0.01', ctMult: '1', ctValCcy: instId.split('-')[0] ?? '', ctType: 'linear', lotSz: '1', minSz: '1', tickSz: '0.1', maxLmtSz: '100000', maxMktSz: '10000',
  lever: '100', state: 'live', listTime: '0', expTime: '', category: '1', optType: '', stk: '', alias: '', maxIcebergSz: '', maxTriggerSz: '', maxStopSz: '', maxTwapSz: '',
  ...overrides,
});

export const bar = (ts: number, open: string, high: string, low: string, close: string): Bar => ({ ts, open: d(open), high: d(high), low: d(low), close: d(close) });

/** History the tests write themselves; every read is recorded. */
export class FakeHistory implements BarSource, FundingSource {
  trade: Bar[] = [];
  /** Mark price bars; where none is given for a time the replay falls back on the traded prices. */
  mark: Bar[] = [];
  fundingRows: Array<{ fundingTime: number; rate: string }> = [];
  marks = new Map<number, string>();
  fail: Error | null = null;
  barReads: Array<{ kind: 'trade' | 'mark'; instId: string; bar: BarSize; from: number; to: number }> = [];
  fundingReads: Array<{ instId: string; after: number }> = [];

  private read(kind: 'trade' | 'mark', rows: Bar[], instId: string, size: BarSize, from: number, to: number): Promise<Bar[]> {
    this.barReads.push({ kind, instId, bar: size, from, to });
    if (this.fail) return Promise.reject(this.fail);
    const first = Math.floor(from / MIN) * MIN;
    return Promise.resolve(rows.filter((b) => b.ts >= first && b.ts <= to));
  }

  tradeBars(instId: string, size: BarSize, from: number, to: number): Promise<Bar[]> {
    return this.read('trade', this.trade, instId, size, from, to);
  }

  markBars(instId: string, size: BarSize, from: number, to: number): Promise<Bar[]> {
    return this.read('mark', this.mark, instId, size, from, to);
  }

  settlements(instId: string, after: number, now: number): Promise<Array<{ fundingTime: number; rate: string }>> {
    this.fundingReads.push({ instId, after });
    if (this.fail) return Promise.reject(this.fail);
    return Promise.resolve(this.fundingRows.filter((r) => r.fundingTime > after && r.fundingTime <= now));
  }

  markAt(_instId: string, ts: number): Promise<ReturnType<typeof d> | null> {
    const px = this.marks.get(ts);
    return Promise.resolve(px === undefined ? null : d(px));
  }
}

export const tempStateFile = (): string => join(mkdtempSync(join(tmpdir(), 'pegasus-paper-')), 'paper-account.json');

export interface Opened {
  paper: PaperExchange;
  history: FakeHistory;
  logs: string[];
  stateFile: string;
}

/** Opens (or re-opens, with the same `stateFile` and `history`) a paper account on BTC and ETH. */
export function open(opts: Partial<PaperConfig> & { history?: FakeHistory; instruments?: OkxInstrument[] } = {}): Opened {
  const history = opts.history ?? new FakeHistory();
  const logs: string[] = [];
  const stateFile = opts.stateFile ?? tempStateFile();
  const config: PaperConfig = {
    stateFile,
    initialBalance: opts.initialBalance ?? '100000',
    posMode: opts.posMode ?? 'net_mode',
    takerFeeRate: opts.takerFeeRate ?? '0.0005',
    makerFeeRate: opts.makerFeeRate ?? '0.0002',
    defaultLever: opts.defaultLever ?? '3',
  };
  const paper = new PaperExchange(config, { instruments: opts.instruments ?? [spec(BTC), spec(ETH)], bars: history, funding: history, log: (msg) => logs.push(msg) });
  return { paper, history, logs, stateFile };
}

/** Quotes a market: a five-level book around `mid` with 100 contracts per level one tick apart, and the mark at `mid`. */
export function quote(paper: PaperExchange, instId: string, mid: number, sizes: { bid?: string; ask?: string } = {}): void {
  const levels = (start: number, step: number, sz: string): string[][] => Array.from({ length: 5 }, (_, i) => [(start + i * step).toFixed(1), sz, '0', '1']);
  paper.onBook(instId, levels(mid - 0.1, -0.1, sizes.bid ?? '100'), levels(mid + 0.1, 0.1, sizes.ask ?? '100'));
  paper.onMark(instId, mid.toFixed(1));
  paper.onLast(instId, mid.toFixed(1));
}

export function place(paper: PaperExchange, body: Record<string, unknown>): OkxOrderAck {
  return paper.engine.matcher.place({ instId: BTC, tdMode: 'cross', ...body });
}

export const stopAt = (slTriggerPx: string): { attachAlgoOrds: unknown[] } => ({ attachAlgoOrds: [{ slTriggerPx, slOrdPx: '-1', slTriggerPxType: 'mark' }] });
