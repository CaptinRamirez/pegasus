import { bookChecksum } from '../checksum.js';
import { d, fmt, fmtStep, roundToStep, ROUND_FLOOR, ZERO, type Dec } from '../num.js';
import type { Prng } from '../prng.js';
import type { OkxBookData, OkxBookLevel, OkxInstrument, OkxSide } from '../wire.js';

interface Level {
  /** Exact wire string; checksums are computed over it. */
  px: string;
  sz: Dec;
  ordCount: number;
}

export interface BooksPush extends OkxBookData {
  checksum: number;
  seqId: number;
  prevSeqId: number;
}

export interface WalkFill {
  px: Dec;
  sz: Dec;
}

/** Level spacing in ticks: dense near the top, sparser deeper down. */
function tickOffset(i: number): number {
  return i + Math.floor((i * i) / 10);
}

/**
 * A synthetic 50-level-per-side order book rebuilt around the mid price on
 * every tick. It tracks what was last published so that `delta()` yields an
 * OKX-style incremental `books` update with a seqId chain and checksum.
 */
export class SyntheticBook {
  private asks: Level[] = [];
  private bids: Level[] = [];
  private pubAsks = new Map<string, string>();
  private pubBids = new Map<string, string>();
  private _seqId = 0;
  private readonly tick: Dec;
  private readonly lot: Dec;

  constructor(
    inst: Pick<OkxInstrument, 'tickSz' | 'lotSz'>,
    readonly depth = 50,
  ) {
    this.tick = d(inst.tickSz);
    this.lot = d(inst.lotSz);
  }

  get seqId(): number {
    return this._seqId;
  }

  bestBid(): { px: Dec; sz: Dec } | undefined {
    const l = this.bids[0];
    return l ? { px: d(l.px), sz: l.sz } : undefined;
  }

  bestAsk(): { px: Dec; sz: Dec } | undefined {
    const l = this.asks[0];
    return l ? { px: d(l.px), sz: l.sz } : undefined;
  }

  /** Rebuilds both sides around `mid`, keeping ~70% of surviving level sizes for smaller deltas. */
  rebuild(mid: Dec, rng: Prng): void {
    const bestBid = roundToStep(mid, this.tick, ROUND_FLOOR);
    const bestAsk = bestBid.add(this.tick);
    const prevAsks = new Map(this.asks.map((l) => [l.px, l]));
    const prevBids = new Map(this.bids.map((l) => [l.px, l]));
    this.asks = this.buildSide(bestAsk, 1, prevAsks, rng);
    this.bids = this.buildSide(bestBid, -1, prevBids, rng);
  }

  private buildSide(best: Dec, dir: 1 | -1, prev: Map<string, Level>, rng: Prng): Level[] {
    const out: Level[] = [];
    for (let i = 0; i < this.depth; i++) {
      const px = fmtStep(best.add(this.tick.mul(tickOffset(i) * dir)), this.tick);
      const old = prev.get(px);
      if (old && old.sz.gt(0) && rng.bool(0.7)) {
        out.push(old);
        continue;
      }
      const raw = d(rng.between(1, 20) * (1 + i * 0.1));
      const sz = roundToStep(raw, this.lot, ROUND_FLOOR);
      out.push({ px, sz: sz.lte(0) ? this.lot : sz, ordCount: rng.int(1, 12) });
    }
    return out;
  }

  /** Total size on one side within the limit price (for FOK checks). */
  available(side: OkxSide, limitPx?: Dec): Dec {
    const levels = side === 'buy' ? this.asks : this.bids;
    let total = ZERO;
    for (const l of levels) {
      if (limitPx && !this.withinLimit(side, d(l.px), limitPx)) break;
      total = total.add(l.sz);
    }
    return total;
  }

  crosses(side: OkxSide, limitPx: Dec): boolean {
    const top = side === 'buy' ? this.bestAsk() : this.bestBid();
    return top !== undefined && this.withinLimit(side, top.px, limitPx);
  }

  private withinLimit(side: OkxSide, px: Dec, limitPx: Dec): boolean {
    return side === 'buy' ? px.lte(limitPx) : px.gte(limitPx);
  }

  /**
   * Consumes liquidity: a buy walks the asks, a sell walks the bids, never
   * beyond `limitPx`. Without a limit the remainder fills at the last level
   * when the book is exhausted. Mutates the book.
   */
  walk(side: OkxSide, sz: Dec, limitPx?: Dec): WalkFill[] {
    const levels = side === 'buy' ? this.asks : this.bids;
    const fills: WalkFill[] = [];
    let remaining = sz;
    let lastPx: Dec | undefined;
    while (remaining.gt(0) && levels.length > 0) {
      const lvl = levels[0];
      if (!lvl) break;
      const px = d(lvl.px);
      if (limitPx && !this.withinLimit(side, px, limitPx)) break;
      const take = remaining.lt(lvl.sz) ? remaining : lvl.sz;
      fills.push({ px, sz: take });
      remaining = remaining.sub(take);
      lvl.sz = lvl.sz.sub(take);
      lastPx = px;
      if (lvl.sz.lte(0)) levels.shift();
    }
    if (remaining.gt(0) && !limitPx) {
      const px = lastPx ?? (side === 'buy' ? this.bestBid()?.px : this.bestAsk()?.px);
      if (px) fills.push({ px, sz: remaining });
    }
    return fills;
  }

  private levelsOf(side: Level[], n: number): OkxBookLevel[] {
    const out: OkxBookLevel[] = [];
    for (const l of side.slice(0, n)) out.push([l.px, fmt(l.sz), '0', String(l.ordCount)]);
    return out;
  }

  /** Top-n levels (best first) in wire format. */
  levels(n: number): { asks: OkxBookLevel[]; bids: OkxBookLevel[] } {
    return { asks: this.levelsOf(this.asks, n), bids: this.levelsOf(this.bids, n) };
  }

  private checksum(): number {
    return bookChecksum(this.levelsOf(this.bids, 25), this.levelsOf(this.asks, 25));
  }

  /** Full-depth snapshot for a new `books` subscriber. */
  snapshot(ts: number): BooksPush {
    const { asks, bids } = this.levels(this.depth);
    return { asks, bids, ts: String(ts), checksum: this.checksum(), seqId: this._seqId, prevSeqId: -1 };
  }

  /** Incremental update since the last publish, or null when nothing changed. */
  delta(ts: number): BooksPush | null {
    const asks = this.diffSide(this.asks, this.pubAsks);
    const bids = this.diffSide(this.bids, this.pubBids);
    if (asks.length === 0 && bids.length === 0) return null;
    const prevSeqId = this._seqId;
    this._seqId += 1;
    return { asks, bids, ts: String(ts), checksum: this.checksum(), seqId: this._seqId, prevSeqId };
  }

  private diffSide(current: Level[], published: Map<string, string>): OkxBookLevel[] {
    const out: OkxBookLevel[] = [];
    const seen = new Set<string>();
    for (const l of current) {
      const sz = fmt(l.sz);
      seen.add(l.px);
      if (published.get(l.px) !== sz) {
        out.push([l.px, sz, '0', String(l.ordCount)]);
        published.set(l.px, sz);
      }
    }
    for (const px of [...published.keys()]) {
      if (!seen.has(px)) {
        out.push([px, '0', '0', '0']);
        published.delete(px);
      }
    }
    return out;
  }
}
