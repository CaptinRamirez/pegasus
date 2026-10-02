import { d, fmt, fmtStep, roundToStep, ZERO, type Dec } from '../num.js';
import type { Prng } from '../prng.js';
import type { OkxCandleRow, OkxFundingRate, OkxInstrument, OkxMarkPrice, OkxSide, OkxTicker, OkxTrade } from '../wire.js';
import { SyntheticBook, type BooksPush } from './book.js';
import { BAR_MS, BARS, barStart, CandleSeries, candleRow, type Bar } from './candles.js';

const HISTORY_BARS = 300;
const HISTORY_VOL_PER_MINUTE = 0.0005;
const FUNDING_INTERVAL_MS = 8 * 60 * 60 * 1000;

export interface CandlePush {
  bar: Bar;
  live: OkxCandleRow;
  closed: OkxCandleRow | null;
}

export interface TickResult {
  trades: OkxTrade[];
  candles: CandlePush[];
  books: BooksPush | null;
}

export interface MarketSimOptions {
  volatility: number;
  tickIntervalMs: number;
}

/** Price process, synthetic book, prints, candles and ticker for one instrument. */
export class MarketSim {
  readonly book: SyntheticBook;
  readonly candles = new Map<Bar, CandleSeries>();
  private mid: Dec;
  private last: Dec;
  private lastSz: Dec = ZERO;
  private tradeSeq = 0;
  private readonly tick: Dec;
  private readonly lot: Dec;
  private readonly ctVal: Dec;

  constructor(
    readonly inst: OkxInstrument,
    initialPx: Dec,
    private readonly rng: Prng,
    private readonly opts: MarketSimOptions,
    now: number,
  ) {
    this.tick = d(inst.tickSz);
    this.lot = d(inst.lotSz);
    this.ctVal = d(inst.ctVal);
    this.mid = initialPx;
    this.last = roundToStep(initialPx, this.tick);
    this.book = new SyntheticBook(inst);
    for (const bar of BARS) {
      const series = new CandleSeries(bar, this.ctVal, this.tick);
      // Back-history uses a realistic ~0.05%/minute scale regardless of the live tick volatility.
      const perBar = HISTORY_VOL_PER_MINUTE * Math.sqrt(BAR_MS[bar] / 60_000);
      series.seedHistory(now, this.last, rng, perBar, HISTORY_BARS);
      this.candles.set(bar, series);
    }
    this.book.rebuild(this.mid, rng);
    // Publish the initial state so the first delta is relative to it.
    this.book.delta(now);
    this.touchCandles(now, this.last, ZERO);
  }

  get midPx(): Dec {
    return this.mid;
  }

  get markPx(): Dec {
    return roundToStep(this.mid, this.tick);
  }

  /** Advances the price process by one tick, or jumps to `forcedMid`. */
  step(now: number, forcedMid?: Dec): TickResult {
    if (forcedMid) {
      this.mid = forcedMid;
    } else {
      const factor = 1 + this.rng.gaussian() * this.opts.volatility;
      this.mid = this.mid.mul(d(factor)).toDecimalPlaces(12);
      if (this.mid.lte(this.tick)) this.mid = this.tick.mul(10);
    }
    this.book.rebuild(this.mid, this.rng);
    const books = this.book.delta(now);
    const trades: OkxTrade[] = [];
    const prints = this.rng.int(1, 3);
    const closedByBar = new Map<Bar, OkxCandleRow>();
    for (let i = 0; i < prints; i++) {
      const side: OkxSide = this.rng.bool() ? 'buy' : 'sell';
      const top = side === 'buy' ? this.book.bestAsk() : this.book.bestBid();
      const px = top ? top.px : this.markPx;
      const sz = roundToStep(d(this.rng.between(0.1, 8)), this.lot);
      const t = this.recordTrade(px, sz.lte(0) ? this.lot : sz, side, now);
      trades.push(t.trade);
      for (const [bar, row] of t.closed) closedByBar.set(bar, row);
    }
    const candles: CandlePush[] = [];
    for (const bar of BARS) {
      const live = this.candles.get(bar)?.liveRow();
      if (live) candles.push({ bar, live, closed: closedByBar.get(bar) ?? null });
    }
    return { trades, candles, books };
  }

  /** Records a print (synthetic or from a user fill) and updates candles/last. */
  recordTrade(px: Dec, sz: Dec, side: OkxSide, now: number): { trade: OkxTrade; closed: Map<Bar, OkxCandleRow> } {
    this.last = px;
    this.lastSz = sz;
    this.tradeSeq += 1;
    const trade: OkxTrade = {
      instId: this.inst.instId,
      tradeId: String(this.tradeSeq),
      px: fmtStep(px, this.tick),
      sz: fmt(sz),
      side,
      count: '1',
      ts: String(now),
    };
    return { trade, closed: this.touchCandles(now, px, sz) };
  }

  private touchCandles(now: number, px: Dec, sz: Dec): Map<Bar, OkxCandleRow> {
    const closed = new Map<Bar, OkxCandleRow>();
    for (const [bar, series] of this.candles) {
      const rolled = series.update(now, px, sz);
      if (rolled) closed.set(bar, candleRow(rolled, true));
    }
    return closed;
  }

  /** Live candle rows for every bar (used after user fills). */
  liveCandles(): CandlePush[] {
    const out: CandlePush[] = [];
    for (const bar of BARS) {
      const live = this.candles.get(bar)?.liveRow();
      if (live) out.push({ bar, live, closed: null });
    }
    return out;
  }

  ticker(now: number): OkxTicker {
    const bid = this.book.bestBid();
    const ask = this.book.bestAsk();
    const hourly = this.candles.get('1H');
    const stats = hourly?.stats(now - 24 * 60 * 60 * 1000);
    const daily = this.candles.get('1D');
    const sod0 = daily?.openAt(barStart('1D', now)) ?? this.last;
    const sod8Ts = barStart('1D', now + 8 * 60 * 60 * 1000) - 8 * 60 * 60 * 1000;
    const sod8 = hourly?.openAt(sod8Ts) ?? sod0;
    return {
      instType: 'SWAP',
      instId: this.inst.instId,
      last: fmtStep(this.last, this.tick),
      lastSz: fmt(this.lastSz),
      askPx: ask ? fmtStep(ask.px, this.tick) : '',
      askSz: ask ? fmt(ask.sz) : '',
      bidPx: bid ? fmtStep(bid.px, this.tick) : '',
      bidSz: bid ? fmt(bid.sz) : '',
      open24h: fmtStep(stats?.open ?? this.last, this.tick),
      high24h: fmtStep(stats?.high ?? this.last, this.tick),
      low24h: fmtStep(stats?.low ?? this.last, this.tick),
      volCcy24h: fmt(stats?.volCcy ?? ZERO),
      vol24h: fmt(stats?.vol ?? ZERO),
      sodUtc0: fmtStep(sod0, this.tick),
      sodUtc8: fmtStep(sod8, this.tick),
      ts: String(now),
    };
  }

  markPrice(now: number): OkxMarkPrice {
    return { instType: 'SWAP', instId: this.inst.instId, markPx: fmtStep(this.markPx, this.tick), ts: String(now) };
  }

  fundingRate(now: number): OkxFundingRate {
    const fundingTime = Math.floor(now / FUNDING_INTERVAL_MS) * FUNDING_INTERVAL_MS + FUNDING_INTERVAL_MS;
    return {
      instType: 'SWAP',
      instId: this.inst.instId,
      method: 'current_period',
      fundingRate: '0.0001',
      nextFundingRate: '',
      fundingTime: String(fundingTime),
      nextFundingTime: String(fundingTime + FUNDING_INTERVAL_MS),
      minFundingRate: '-0.00375',
      maxFundingRate: '0.00375',
      settState: 'settled',
      settFundingRate: '0.0001',
      premium: '0',
      interestRate: '0.0001',
      impactValue: '1000',
      ts: String(now),
    };
  }
}
