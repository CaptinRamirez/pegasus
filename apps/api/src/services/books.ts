import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import type { Logger } from 'pino';
import type { OkxRestClient } from '@pegasus/okx';
import {
  BOOK_KEYS,
  BOOK_SPOT_FEE,
  BOOKS_VERSION,
  CARRY_POS_COINS,
  D,
  DIP_COINS,
  DIP_HOLD_MS,
  DIP_MAX_POSITIONS,
  DIP_RULES,
  DIP_SHARE,
  LADDER_COINS,
  LADDER_SHARE,
  ladderPlan,
  mixVolatility,
  mtfFeatures,
  newBook,
  PLAN_BAND,
  PLAN_COINS,
  planTarget,
  positionValue,
  resizeSpot,
  ruleHolds,
  type MtfBar,
  addBookEvent,
  applyFunding,
  applyInterest,
  bookEquity,
  bookView,
  carryNegPlan,
  closePosition,
  hourlyBorrowRate,
  newBooksState,
  openPosition,
  regimeRead,
  type Book,
  type BookKey,
  type BookPosition,
  type BookPrices,
  type BookQuote,
  type BooksState,
  type BooksView,
  type CarryCandidate,
  type Decimal,
} from '@pegasus/shared';

/**
 * The six paper books (docs/proposals/paper-books-2026-11.md), on the plain paper stack (BOOKS_ENABLED=1, set by the
 * launcher): the two-line regime and its buy-and-hold control on BTC-USDT spot, the positive carry (BTC and ETH spot
 * long, perp short), the negative carry (a long perp hedged by a borrowed coin sold spot), the dip long (packages/
 * shared/src/mtf-features.ts: 5-day longs on the coins whose 1H/4H/1D/1W features meet a rule) and the ladder (ETH and
 * BTC perps bought in lots on the way down, sold together on the bounce, never stopped), and with them the plan of
 * docs/proposals/complete-strategy-2026-11.md (BTC and ETH spot while the two lines read bull, sized by the mix's
 * volatility) and its buy-and-hold control, each a ledger of its own in BOOKS_FILE, settled on OKX's public data
 * (packages/shared/src/books.ts has the arithmetic). Every minute the tickers and marks are read; every ten minutes,
 * and before anything that may close a position, the funding OKX settled on the held perps is booked; every whole hour
 * the borrow interest and a point of each equity curve, and once the hour's 1H bars are confirmed the ladder decides;
 * once a day after 00:00 UTC (and at the very first look) the regime, the plan, the negative carry and the dip long
 * decide. A position whose coin has no quote waits for one. The account of the stack and the paper exchange are never touched.
 */

export interface BooksConfig {
  enabled: boolean;
  file: string;
  /** What each book starts with, USDT */
  start: string;
}

export interface BooksSources {
  /** Best bid and ask of every spot pair and every swap */
  quotes(): Promise<Map<string, BookQuote>>;
  marks(): Promise<Map<string, string>>;
  /** Closes of the confirmed bars, oldest first */
  closes(instId: string, bar: '1Dutc' | '1Wutc'): Promise<string[]>;
  /** Settled funding, any order */
  funding(instId: string): Promise<Array<{ ts: number; rate: string }>>;
  /** Live crypto USDT swaps: the coin and the perp */
  swaps(): Promise<Array<{ coin: string; instId: string }>>;
  /** Spot pairs OKX lends on (its MARGIN instruments) */
  marginPairs(): Promise<Set<string>>;
  /** Posted base borrow rate (daily) and quota (coins) per currency */
  loanQuota(): Promise<Map<string, { rate: string; quota: string }>>;
  /** The latest Simple Earn lending rate of a currency, annual */
  lendingRate(ccy: string): Promise<string | undefined>;
  /** Up to 300 closed bars of a swap, oldest first, with the quote volume */
  bars(instId: string, bar: '1H' | '4H' | '1Dutc' | '1Wutc'): Promise<MtfBar[]>;
}

const HOUR = 3_600_000;
const DAY = 86_400_000;
const FUNDING_EVERY_MS = 10 * 60_000;
const DECIDE_AFTER_MS = 5 * 60_000;
const LADDER_AFTER_MS = 2 * 60_000;
const CURVE_KEPT = 20_000;
// the owner, 2026-11-05: the big direction is held in spot (「拿住大方向就搞现货」): no funding, no liquidation
const BTC_SPOT = 'BTC-USDT';
const utcDate = (ts: number): string => new Date(ts).toISOString().slice(0, 10);

export function okxBooksSources(rest: OkxRestClient, sleep: (ms: number) => Promise<void> = (ms) => new Promise((r) => setTimeout(r, ms))): BooksSources {
  return {
    async quotes() {
      const out = new Map<string, BookQuote>();
      for (const t of [...(await rest.getTickers('SPOT')), ...(await rest.getTickers('SWAP'))]) if (t.bidPx !== '' && t.askPx !== '' && D(t.bidPx).gt(0)) out.set(t.instId, { bid: t.bidPx, ask: t.askPx });
      return out;
    },
    async marks() {
      return new Map((await rest.getMarkPrice('SWAP')).map((m) => [m.instId, m.markPx]));
    },
    async closes(instId, bar) {
      return (await rest.getCandles(instId, bar, { limit: 300 })).filter((r) => r[8] === '1').map((r) => r[4]).reverse();
    },
    async funding(instId) {
      // OKX allows 10 of these per 2 seconds
      await sleep(220);
      return (await rest.getFundingRateHistory(instId, { limit: 24 })).map((f) => ({ ts: Number(f.fundingTime), rate: f.realizedRate !== '' ? f.realizedRate : f.fundingRate }));
    },
    async swaps() {
      return (await rest.getInstruments('SWAP')).filter((i) => i.settleCcy === 'USDT' && i.state === 'live' && (i.instCategory ?? '1') === '1').map((i) => ({ coin: i.instId.split('-')[0] ?? i.instId, instId: i.instId }));
    },
    async marginPairs() {
      return new Set((await rest.getInstruments('MARGIN')).filter((i) => i.state === 'live').map((i) => i.instId));
    },
    async loanQuota() {
      const out = new Map<string, { rate: string; quota: string }>();
      for (const row of await rest.getLoanQuota()) for (const b of row.basic ?? []) out.set(b.ccy, { rate: b.rate, quota: b.quota });
      return out;
    },
    async lendingRate(ccy) {
      return (await rest.getLendingRateHistory(ccy, { limit: 1 }))[0]?.rate;
    },
    async bars(instId, bar) {
      // OKX allows 40 of these per 2 seconds
      await sleep(60);
      return (await rest.getCandles(instId, bar, { limit: 300 })).filter((r) => r[8] === '1').map((r): MtfBar => [Number(r[0]), r[1], r[2], r[3], r[4], r[7]]).reverse();
    },
  };
}

/** The books' file; null when there is none yet. A file that is there and cannot be read throws: new books must never be written over it. */
export function loadBooks(file: string): BooksState | null {
  let text: string;
  try {
    text = readFileSync(file, 'utf8');
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return null;
    throw err;
  }
  const v = JSON.parse(text) as BooksState;
  if (v.version !== BOOKS_VERSION || !Array.isArray(v.books)) throw new Error(`${file}: not a books file of version ${BOOKS_VERSION}`);
  // a book added after the file was written starts when it is first read
  const now = Date.now();
  const books = BOOK_KEYS.map((k) => v.books.find((b) => b.key === k) ?? newBook(k, v.books[0]?.start ?? '10000', now));
  return { ...v, books, regime: v.regime ?? null, ladderHour: v.ladderHour ?? null, plan: v.plan ?? null };
}

export function saveBooks(file: string, state: BooksState): void {
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(`${file}.tmp`, JSON.stringify(state));
  renameSync(`${file}.tmp`, file);
}

export class BooksService {
  private state: BooksState | null = null;
  /** The file was read (or found missing): until then nothing is written */
  private loaded = false;
  private quotes = new Map<string, BookQuote>();
  private markMap = new Map<string, string>();
  private fundingAt = 0;
  private loan: { at: number; data: Map<string, { rate: string; quota: string }> } | null = null;
  private error: string | null = null;
  private busy = false;
  private timer: NodeJS.Timeout | null = null;
  private readonly now: () => number;
  private readonly checkEveryMs: number;

  constructor(
    private readonly config: BooksConfig,
    private readonly deps: { sources: BooksSources; log: Logger },
    opts: { now?: () => number; checkEveryMs?: number } = {},
  ) {
    this.now = opts.now ?? Date.now;
    this.checkEveryMs = opts.checkEveryMs ?? 60_000;
  }

  /** Makes the first look, which reads the file; resolves when that look is done. */
  start(): Promise<void> {
    if (this.checkEveryMs > 0) this.timer = setInterval(() => void this.tick(), this.checkEveryMs);
    return this.tick();
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }

  private get prices(): BookPrices {
    return { quote: (id) => this.quotes.get(id), mark: (id) => this.markMap.get(id) };
  }

  /** One look; a look that fails is said in the view and tried again at the next one. */
  async tick(): Promise<void> {
    if (this.busy) return;
    this.busy = true;
    try {
      await this.step();
      this.error = null;
    } catch (err) {
      this.error = (err as Error).message;
      this.deps.log.warn({ err: this.error }, 'the paper books could not be updated; tried again at the next look');
    } finally {
      this.busy = false;
    }
  }

  private async step(): Promise<void> {
    const now = this.now();
    const s = this.deps.sources;
    // a file that cannot be read (locked for a moment on Windows) fails the look, which is tried again: nothing is written until it was read
    if (!this.loaded) {
      this.state = loadBooks(this.config.file);
      this.loaded = true;
    }
    [this.quotes, this.markMap] = await Promise.all([s.quotes(), s.marks()]);
    if (this.state === null) {
      this.state = newBooksState(this.config.start, now);
      this.deps.log.info({ start: this.config.start, file: this.config.file }, 'the paper books start');
    }
    const state = this.state;
    this.openOnce(state, now);
    const hourStart = Math.floor(now / HOUR) * HOUR;
    const dayStart = Math.floor(now / DAY) * DAY;
    const decideDue = state.lastDecisionDay !== utcDate(now) && (state.lastDecisionDay === null || now >= dayStart + DECIDE_AFTER_MS);
    const ladderDue = state.ladderHour !== hourStart && now >= hourStart + LADDER_AFTER_MS;
    // a settlement is booked before anything that may close a position: a position closed first would never be charged it
    if (decideDue || ladderDue || now - this.fundingAt >= FUNDING_EVERY_MS) {
      await this.bookFunding(state, now);
      this.fundingAt = now;
    }
    await this.bookInterest(state, now);
    await this.ladderHour(state, now);
    if (decideDue) {
      await this.decide(state, now);
      state.lastDecisionDay = utcDate(now);
    } else if (state.plan == null && state.regime != null) {
      // a file that decided today before it had the plan: the plan reads the day at once rather than tomorrow
      await this.planDay(state, now, state.regime.bull, await s.closes(BTC_SPOT, '1Dutc'));
    }
    this.curvePoint(state, now);
    saveBooks(this.config.file, state);
  }

  /** Every leg has a quote, so the position can be sold at the market; a coin whose ticker is gone (delisted, suspended) waits. */
  private closable(pos: BookPosition): boolean {
    if (pos.legs.every((l) => this.quotes.has(l.instId))) return true;
    this.deps.log.warn({ coin: pos.coin, legs: pos.legs.map((l) => l.instId) }, 'paper books: no quote for a position that should be closed; it waits');
    return false;
  }

  private book(state: BooksState, key: BookKey): Book {
    const b = state.books.find((x) => x.key === key);
    if (!b) throw new Error(`no book ${key}`);
    return b;
  }

  /** The books that only open once (buy and hold, the positive carry, the plan's control), each at the first look after it was made: a book with no event yet. */
  private openOnce(state: BooksState, now: number): void {
    const p = this.prices;
    const fresh = (b: Book): boolean => b.positions.length === 0 && b.events.length === 0;
    const hold = this.book(state, 'hold');
    if (fresh(hold)) {
      const q = p.quote(BTC_SPOT);
      if (!q) throw new Error(`no quote for ${BTC_SPOT}`);
      // the spot is paid from the cash, its fee included
      openPosition(hold, 'BTC', [{ kind: 'spot', instId: BTC_SPOT, qty: D(hold.start).div(D(q.ask).mul(D(1).plus(BOOK_SPOT_FEE))).toFixed(8) }], p, now, 'buy and hold');
    }
    const carry = this.book(state, 'carryPos');
    if (fresh(carry)) {
      // every price first: a coin missing one must not leave the book half opened
      const asks = CARRY_POS_COINS.map((coin) => {
        const spot = p.quote(`${coin}-USDT`);
        if (!spot || !p.quote(`${coin}-USDT-SWAP`)) throw new Error(`no quote for ${coin}-USDT or its swap`);
        return { coin, ask: spot.ask };
      });
      for (const { coin, ask } of asks) {
        // half the book per coin; the spot is paid from the cash, both fees included
        const qty = D(carry.start).div(CARRY_POS_COINS.length).div(D(ask).mul('1.0015')).toFixed(8);
        openPosition(carry, coin, [{ kind: 'spot', instId: `${coin}-USDT`, qty }, { kind: 'perp', instId: `${coin}-USDT-SWAP`, qty: D(qty).neg().toFixed() }], p, now, 'cash and carry');
      }
    }
    const control = this.book(state, 'planHold');
    if (fresh(control)) {
      for (const coin of PLAN_COINS) if (!p.quote(`${coin}-USDT`)) throw new Error(`no quote for ${coin}-USDT`);
      const half = D(control.start).div(PLAN_COINS.length);
      for (const coin of PLAN_COINS) resizeSpot(control, coin, `${coin}-USDT`, half, p, now, 'buy and hold');
    }
  }

  private async bookFunding(state: BooksState, now: number): Promise<void> {
    const held = new Set(state.books.flatMap((b) => b.positions.flatMap((p) => p.legs.filter((l) => l.kind === 'perp').map((l) => l.instId))));
    for (const instId of held) {
      const mark = this.markMap.get(instId);
      if (mark === undefined) continue;
      const seen = state.fundingSeen[instId] ?? 0;
      const fresh = (await this.deps.sources.funding(instId)).filter((f) => f.ts > seen && f.ts <= now).sort((a, b) => a.ts - b.ts);
      for (const f of fresh) {
        for (const b of state.books) applyFunding(b, instId, f.rate, mark, f.ts);
        state.fundingSeen[instId] = f.ts;
      }
    }
  }

  private async bookInterest(state: BooksState, now: number): Promise<void> {
    const hourStart = Math.floor(now / HOUR) * HOUR;
    if (state.interestUntil === null) {
      state.interestUntil = hourStart;
      return;
    }
    const hours = (hourStart - state.interestUntil) / HOUR;
    if (hours < 1) return;
    const b = this.book(state, 'carryNeg');
    const coins = [...new Set(b.positions.map((p) => p.coin))];
    if (coins.length > 0) {
      const loan = await this.loanQuota(now);
      const rates = new Map<string, string>();
      for (const coin of coins) {
        const r = hourlyBorrowRate(loan.get(coin)?.rate, await this.deps.sources.lendingRate(coin));
        if (r !== undefined) rates.set(coin, r.toFixed());
      }
      applyInterest(b, (coin) => rates.get(coin), this.prices, hours, hourStart);
    }
    state.interestUntil = hourStart;
  }

  private async loanQuota(now: number): Promise<Map<string, { rate: string; quota: string }>> {
    if (this.loan === null || now - this.loan.at > DAY) this.loan = { at: now, data: await this.deps.sources.loanQuota() };
    return this.loan.data;
  }

  private async decide(state: BooksState, now: number): Promise<void> {
    const s = this.deps.sources;
    const p = this.prices;
    // the regime: BTC spot's daily close against its 200-day and 50-week averages
    const btcDaily = await s.closes(BTC_SPOT, '1Dutc');
    const reading = regimeRead(btcDaily, await s.closes(BTC_SPOT, '1Wutc'));
    const regime = this.book(state, 'regime');
    if (reading !== null) {
      state.regime = { ts: now, ...reading };
      const held = regime.positions[0];
      const text = `${reading.bull ? 'bull' : 'not bull'}: close ${reading.close}, 200-day ${D(reading.sma200).toFixed(1)}, 50-week ${D(reading.sma50w).toFixed(1)}`;
      this.decisionEvent(regime, now, 'BTC', text);
      if (reading.bull && !held) {
        const eq = bookEquity(regime, p);
        const q = p.quote(BTC_SPOT);
        if (eq !== null && q) openPosition(regime, 'BTC', [{ kind: 'spot', instId: BTC_SPOT, qty: eq.div(D(q.ask).mul(D(1).plus(BOOK_SPOT_FEE))).toFixed(8) }], p, now, 'bull');
      } else if (!reading.bull && held && this.closable(held)) closePosition(regime, held, p, now, 'not bull');
      await this.planDay(state, now, reading.bull, btcDaily);
    }
    // the negative carry: the coins whose last 24 hours of funding sum to -0.3% or below and that OKX lends
    const neg = this.book(state, 'carryNeg');
    const [swaps, pairs, loan] = await Promise.all([s.swaps(), s.marginPairs(), this.loanQuota(now)]);
    const cands: CarryCandidate[] = [];
    for (const sw of swaps) {
      const spotId = `${sw.coin}-USDT`;
      const quota = loan.get(sw.coin)?.quota;
      if (!pairs.has(spotId) || quota === undefined || !D(quota).gt(0)) continue;
      const f = (await s.funding(sw.instId)).filter((x) => x.ts > now - DAY && x.ts <= now);
      cands.push({ coin: sw.coin, perpId: sw.instId, spotId, funding24h: f.reduce((acc, x) => acc.plus(x.rate), D(0)).toFixed(), quota });
    }
    // without a price for one of its coins the book cannot be sized today; the other books still decide
    const eq = bookEquity(neg, p);
    const plan: ReturnType<typeof carryNegPlan> = eq === null ? { close: [], open: [] } : carryNegPlan(cands, neg.positions.map((x) => x.coin), eq, p);
    for (const coin of plan.close) {
      const pos = neg.positions.find((x) => x.coin === coin);
      if (pos && this.closable(pos)) closePosition(neg, pos, p, now, 'funding no longer at -0.3% a day or below');
    }
    for (const { c, usdt } of plan.open) {
      const q = p.quote(c.perpId);
      if (!q) continue;
      // the plan caps the sum at the quota valued at the spot bid; the coins are counted at the perp's ask, so they are capped again
      const want = D(usdt).div(q.ask);
      const qty = (want.gt(c.quota) ? D(c.quota) : want).toFixed(8);
      openPosition(neg, c.coin, [{ kind: 'perp', instId: c.perpId, qty }, { kind: 'spot', instId: c.spotId, qty: D(qty).neg().toFixed() }], p, now, `funding ${D(c.funding24h).mul(100).toFixed(2)}% over 24 h`);
    }
    const dip = await this.dipDay(state, now);
    this.deps.log.info({ regime: reading?.bull ?? null, plan: state.plan ?? null, negCandidates: cands.length, closed: plan.close, opened: plan.open.map((o) => o.c.coin), dip }, 'paper books: the day decided');
  }

  /** The day's reading in the book's ledger, once: a decision tried again after a failed look does not repeat it. */
  private decisionEvent(book: Book, now: number, coin: string | null, text: string): void {
    const last = book.events[book.events.length - 1];
    if (last && last.kind === 'decision' && last.text === text && utcDate(last.ts) === utcDate(now)) return;
    addBookEvent(book, { ts: now, kind: 'decision', coin, amount: null, text });
  }

  /**
   * The plan's day (docs/proposals/complete-strategy-2026-11.md): while the two lines read bull, BTC and ETH spot, half each,
   * at the share of the book planTarget gives for the mix's 30-day volatility, traded only when the holding is off it by more
   * than PLAN_BAND of the book; everything sold for USDT when they do not. A day without a price or a volatility is left as it is.
   */
  private async planDay(state: BooksState, now: number, bull: boolean, btcDaily: string[]): Promise<void> {
    const p = this.prices;
    const book = this.book(state, 'plan');
    const vol = mixVolatility([btcDaily, await this.deps.sources.closes('ETH-USDT', '1Dutc')]);
    const target = planTarget(bull, vol);
    const eq = bookEquity(book, p);
    if (eq === null || !eq.gt(0) || PLAN_COINS.some((coin) => !p.quote(`${coin}-USDT`))) return;
    const held = book.positions.reduce((s, pos) => s.plus(positionValue(pos, p) ?? 0), D(0));
    const exposure = held.div(eq);
    const pct = (x: Decimal | null): string => (x === null ? 'unknown' : `${x.mul(100).toFixed(0)}%`);
    state.plan = { ts: now, vol: vol === null ? null : vol.toFixed(4), target: target === null ? null : target.toFixed(4), targetIfBull: planTarget(true, vol)?.toFixed(4) ?? null, exposure: exposure.toFixed(4) };
    this.decisionEvent(book, now, null, `${bull ? 'bull' : 'not bull'}: volatility ${pct(vol)}, target ${pct(target)}, held ${pct(exposure)}`);
    if (target === null) return;
    // sold whole when not bull; while bull only a holding more than the band away from the target is traded
    if (target.isZero() ? held.isZero() : target.minus(exposure).abs().lte(PLAN_BAND)) return;
    const why = target.isZero() ? 'not bull' : `to ${pct(target)} of the book`;
    for (const coin of PLAN_COINS) resizeSpot(book, coin, `${coin}-USDT`, eq.mul(target).div(PLAN_COINS.length), p, now, why);
  }

  /**
   * The fifth book's day: the longs held five days are sold; then each coin of DIP_COINS not held whose features at
   * today's 00:00 UTC close meet one of DIP_RULES is bought, DIP_SHARE of the book each, while fewer than DIP_MAX_POSITIONS
   * are open, in the list's order.
   */
  private async dipDay(state: BooksState, now: number): Promise<{ closed: string[]; opened: string[] }> {
    const p = this.prices;
    const book = this.book(state, 'dipLong');
    const closed: string[] = [];
    // an hour's slack: a decision can run a little earlier in the day than the one that opened the position
    for (const pos of [...book.positions]) {
      if (now - pos.openedAt >= DIP_HOLD_MS - 3_600_000 && this.closable(pos)) {
        closePosition(book, pos, p, now, 'held five days');
        closed.push(pos.coin);
      }
    }
    const T = Math.floor(now / DAY) * DAY;
    const opened: string[] = [];
    for (const coin of DIP_COINS) {
      if (book.positions.length >= DIP_MAX_POSITIONS) break;
      if (book.positions.some((x) => x.coin === coin)) continue;
      const instId = `${coin}-USDT-SWAP`;
      const s = this.deps.sources;
      const frames = { '1H': await s.bars(instId, '1H'), '4H': await s.bars(instId, '4H'), '1D': await s.bars(instId, '1Dutc'), '1W': await s.bars(instId, '1Wutc') };
      const f = mtfFeatures(frames, T);
      if (f === null) continue;
      const fired = DIP_RULES.map((r, i) => (ruleHolds(f, r) ? i + 1 : 0)).filter((i) => i > 0);
      if (fired.length === 0) continue;
      const q = p.quote(instId);
      const eq = bookEquity(book, p);
      if (!q || eq === null) continue;
      openPosition(book, coin, [{ kind: 'perp', instId, qty: eq.mul(DIP_SHARE).div(q.ask).toFixed(8) }], p, now, `rules ${fired.join(', ')}`);
      opened.push(coin);
    }
    return { closed, opened };
  }

  /**
   * The sixth book's hour: once the 1H bars that closed at the top of the hour are confirmed, each of LADDER_COINS is read
   * (ladderPlan in packages/shared/src/books.ts): a first lot of LADDER_SHARE of the start at the ask, one more lot a daily ATR
   * under the last, or every lot sold at the bid on the bounce in profit. A bar not yet confirmed leaves the hour for the next look.
   */
  private async ladderHour(state: BooksState, now: number): Promise<void> {
    const hourStart = Math.floor(now / HOUR) * HOUR;
    if (state.ladderHour === hourStart || now < hourStart + LADDER_AFTER_MS) return;
    const s = this.deps.sources;
    const p = this.prices;
    const book = this.book(state, 'ladder');
    const plans: Array<{ coin: string; instId: string; plan: ReturnType<typeof ladderPlan> }> = [];
    for (const coin of LADDER_COINS) {
      const instId = `${coin}-USDT-SWAP`;
      const h1 = await s.bars(instId, '1H');
      const last = h1[h1.length - 1];
      if (!last || last[0] !== hourStart - HOUR) return;
      plans.push({ coin, instId, plan: ladderPlan(h1, await s.bars(instId, '1Dutc'), book.positions.filter((x) => x.coin === coin)) });
    }
    state.ladderHour = hourStart;
    const moved: string[] = [];
    for (const { coin, instId, plan } of plans) {
      if (plan === null) continue;
      if (plan.action === 'close') {
        for (const pos of book.positions.filter((x) => x.coin === coin)) if (this.closable(pos)) closePosition(book, pos, p, now, plan.why);
      } else {
        const q = p.quote(instId);
        if (!q) continue;
        openPosition(book, coin, [{ kind: 'perp', instId, qty: D(book.start).mul(LADDER_SHARE).div(q.ask).toFixed(8) }], p, now, `${plan.action === 'add' ? 'add' : 'first lot'}: ${plan.why}`);
      }
      moved.push(`${coin} ${plan.action}`);
    }
    if (moved.length > 0) this.deps.log.info({ moved, lots: book.positions.length }, 'paper books: the ladder moved');
  }

  private curvePoint(state: BooksState, now: number): void {
    const hourStart = Math.floor(now / HOUR) * HOUR;
    for (const b of state.books) {
      const last = b.curve[b.curve.length - 1];
      if (last && last[0] >= hourStart) continue;
      const eq = bookEquity(b, this.prices);
      if (eq === null) continue;
      b.curve.push([hourStart, eq.toFixed(2)]);
      if (b.curve.length > CURVE_KEPT) b.curve.splice(0, b.curve.length - CURVE_KEPT);
    }
  }

  view(): BooksView {
    const now = this.now();
    const state = this.state;
    const next = Math.floor(now / DAY) * DAY + DAY + DECIDE_AFTER_MS;
    return {
      enabled: true,
      status: state === null ? 'starting' : 'running',
      error: this.error,
      books: state === null ? [] : BOOK_KEYS.map((k) => bookView(this.book(state, k), this.prices)),
      regime: state?.regime ?? null,
      plan: state?.plan ?? null,
      nextDecisionAt: next,
      serverTime: now,
    };
  }
}

export function disabledBooksView(now = Date.now()): BooksView {
  return { enabled: false, status: 'disabled', error: null, books: [], regime: null, plan: null, nextDecisionAt: null, serverTime: now };
}
