import type { Market, MatchingBook } from '../src/engine/context.js';
import { Engine } from '../src/engine/engine.js';
import { resolveInstruments } from '../src/instruments.js';
import { d, type Dec } from '../src/num.js';
import type { OkxBalanceDetail, OkxInstrument, OkxOrder, OkxOrderAck, OkxPosMode, OkxPosition, OkxSide, OkxTrade } from '../src/wire.js';

/** A swap of one coin per contract: sizes in contracts are sizes in coin, so the arithmetic can be done by hand. */
export const ABC = 'ABC-USDT-SWAP';
export const XYZ = 'XYZ-USDT-SWAP';
/** A fixed clock: 2026-10-05 00:00:00 UTC. */
export const T0 = Date.UTC(2026, 9, 5);

const DEEP = d(1_000_000);

/** A market quoted by hand: one price that fills any size on either side, with a mark that can be moved apart from it. */
export class QuotedMarket implements Market {
  readonly book: MatchingBook;
  private px: Dec;
  private mark: Dec;
  private seq = 0;

  constructor(
    readonly inst: OkxInstrument,
    px: string,
  ) {
    this.px = d(px);
    this.mark = d(px);
    const top = (): { px: Dec; sz: Dec } => ({ px: this.px, sz: DEEP });
    const within = (side: OkxSide, limitPx: Dec): boolean => (side === 'buy' ? this.px.lte(limitPx) : this.px.gte(limitPx));
    this.book = {
      bestBid: top,
      bestAsk: top,
      available: () => DEEP,
      crosses: within,
      walk: (side, sz, limitPx) => (limitPx && !within(side, limitPx) ? [] : [{ px: this.px, sz }]),
      delta: () => null,
    };
  }

  get markPx(): Dec {
    return this.mark;
  }

  get lastPx(): Dec {
    return this.px;
  }

  /** Moves the book, the last price and the mark. */
  set(px: string): void {
    this.px = d(px);
    this.mark = d(px);
  }

  /** Moves the mark alone. */
  setMark(px: string): void {
    this.mark = d(px);
  }

  recordTrade(px: Dec, sz: Dec, side: OkxSide, now: number): { trade: OkxTrade } {
    this.seq += 1;
    return { trade: { instId: this.inst.instId, tradeId: String(this.seq), px: px.toFixed(), sz: sz.toFixed(), side, count: '1', ts: String(now) } };
  }

  liveCandles(): [] {
    return [];
  }
}

export interface Rig {
  engine: Engine;
  abc: QuotedMarket;
  xyz: QuotedMarket;
  /** Quotes ABC at `px` (book, last and mark) and lets the engine react. */
  move(px: string): void;
  /** Moves the mark of ABC alone and lets the engine react. */
  mark(px: string): void;
  place(body: Record<string, unknown>): OkxOrderAck;
  order(ordId: string): OkxOrder | undefined;
  position(instId?: string, mgnMode?: 'cross' | 'isolated', posSide?: string): OkxPosition | undefined;
  usdt(): OkxBalanceDetail;
}

/**
 * An engine on two hand-quoted markets (ABC at 100, XYZ at 50; one coin per contract, tick 0.01), with a taker fee
 * of 0.05%, a maker fee of 0.02% and a tier-1 maintenance margin rate of 0.5%: OKX's textbook case.
 */
export function rig(opts: { posMode?: OkxPosMode; balance?: string; mmr?: string } = {}): Rig {
  const instruments = resolveInstruments({ [ABC]: { ctVal: '1', ctValCcy: 'ABC', tickSz: '0.01' }, [XYZ]: { ctVal: '1', ctValCcy: 'XYZ', tickSz: '0.01' } }).filter((i) => i.instId === ABC || i.instId === XYZ);
  const [abcInst, xyzInst] = instruments;
  if (!abcInst || !xyzInst) throw new Error('instruments missing');
  const abc = new QuotedMarket(abcInst, '100');
  const xyz = new QuotedMarket(xyzInst, '50');
  const engine = new Engine({
    posMode: opts.posMode ?? 'net_mode',
    perm: 'read_only,trade',
    instruments,
    initialPrices: {},
    seed: 1,
    volatility: 0,
    tickIntervalMs: 0,
    initialBalanceUsdt: opts.balance ?? '1000',
    takerFeeRate: '0.0005',
    makerFeeRate: '0.0002',
    log: () => {},
    markets: new Map<string, Market>([[ABC, abc], [XYZ, xyz]]),
    mmr: { [ABC]: opts.mmr ?? '0.005', [XYZ]: opts.mmr ?? '0.005' },
  });
  engine.clockOverride = T0;
  return {
    engine,
    abc,
    xyz,
    move: (px) => {
      abc.set(px);
      engine.marketMoved(ABC);
    },
    mark: (px) => {
      abc.setMark(px);
      engine.marketMoved(ABC);
    },
    place: (body) => engine.matcher.place({ instId: ABC, tdMode: 'isolated', ...body }),
    order: (ordId) => engine.state().orders.find((o) => o.ordId === ordId),
    position: (instId = ABC, mgnMode = 'isolated', posSide = 'net') => engine.positions(instId).find((p) => p.mgnMode === mgnMode && p.posSide === posSide),
    usdt: () => {
      const detail = engine.balance().details[0];
      if (!detail) throw new Error('no balance');
      return detail;
    },
  };
}
