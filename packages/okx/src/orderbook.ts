import type { OkxBookData, OkxBookLevel } from './types.js';

export interface BookSnapshot {
  bids: Array<[string, string]>;
  asks: Array<[string, string]>;
  ts: number;
  seqId: number;
}

/**
 * Maintains a local copy of an OKX `books` (400-level) order book from
 * snapshot + incremental updates, verifying sequence numbers. Prices are
 * kept as the exact strings OKX sent.
 */
export class LocalOrderBook {
  private bids = new Map<string, string>();
  private asks = new Map<string, string>();
  private sortedBids: Array<[string, string]> | null = null;
  private sortedAsks: Array<[string, string]> | null = null;
  private _ts = 0;
  private _seqId = -1;
  private _ready = false;

  constructor(public readonly instId: string) {}

  get ready(): boolean {
    return this._ready;
  }

  get ts(): number {
    return this._ts;
  }

  get seqId(): number {
    return this._seqId;
  }

  reset(): void {
    this.bids.clear();
    this.asks.clear();
    this.sortedBids = null;
    this.sortedAsks = null;
    this._ts = 0;
    this._seqId = -1;
    this._ready = false;
  }

  /**
   * Apply a `books` message. Returns an error string when the book must be
   * resynchronised (sequence gap or update before snapshot); the caller
   * should reset() and resubscribe.
   */
  apply(action: 'snapshot' | 'update' | undefined, data: OkxBookData): string | null {
    if (action === 'snapshot' || !this._ready) {
      if (action !== 'snapshot') return 'update received before snapshot';
      this.bids.clear();
      this.asks.clear();
      this.applyLevels(this.bids, data.bids);
      this.applyLevels(this.asks, data.asks);
      this._ready = true;
    } else {
      if (data.prevSeqId !== undefined && data.prevSeqId !== this._seqId) {
        return `sequence gap: expected prevSeqId ${this._seqId}, got ${data.prevSeqId}`;
      }
      this.applyLevels(this.bids, data.bids);
      this.applyLevels(this.asks, data.asks);
    }
    this.sortedBids = null;
    this.sortedAsks = null;
    this._ts = Number(data.ts);
    if (data.seqId !== undefined) this._seqId = data.seqId;
    // OKX retired the checksum (2026-06-23): the field is still sent but fixed to 0 and must not be used for verification; seqId/prevSeqId is the integrity check.
    return null;
  }

  private applyLevels(side: Map<string, string>, levels: OkxBookLevel[]): void {
    for (const lvl of levels) {
      const px = lvl[0];
      const sz = lvl[1];
      if (sz === '0') side.delete(px);
      else side.set(px, sz);
    }
  }

  private sortBids(): Array<[string, string]> {
    if (!this.sortedBids) {
      this.sortedBids = [...this.bids.entries()].sort((a, b) => Number(b[0]) - Number(a[0]));
    }
    return this.sortedBids;
  }

  private sortAsks(): Array<[string, string]> {
    if (!this.sortedAsks) {
      this.sortedAsks = [...this.asks.entries()].sort((a, b) => Number(a[0]) - Number(b[0]));
    }
    return this.sortedAsks;
  }

  topBids(n: number): Array<[string, string]> {
    return this.sortBids().slice(0, n);
  }

  topAsks(n: number): Array<[string, string]> {
    return this.sortAsks().slice(0, n);
  }

  snapshot(depth = 50): BookSnapshot {
    return { bids: this.topBids(depth), asks: this.topAsks(depth), ts: this._ts, seqId: this._seqId };
  }

  bestBid(): [string, string] | undefined {
    return this.sortBids()[0];
  }

  bestAsk(): [string, string] | undefined {
    return this.sortAsks()[0];
  }
}
