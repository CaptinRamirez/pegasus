import { D, ZERO, floorToStep, type Decimal, type DecimalInput } from './decimal.js';
import { atrSeq, emaSeq, rsiSeq, type MtfBar } from './mtf-features.js';

/**
 * The six paper books of docs/proposals/paper-books-2026-11.md and the plan of docs/proposals/complete-strategy-2026-11.md
 * with its control: each a ledger of its own, settled on OKX's live public data (tickers for the fills, OKX's funding
 * settlements, OKX's borrow rates) rather than on the paper exchange, which has no spot and no borrowing. Market orders
 * fill at the ask (buys) and the bid (sells) at OKX's taker fees; the hedged legs are not margined, so nothing is
 * liquidated. Pure arithmetic; the service in apps/api/src/services/books.ts fetches the data and keeps the file.
 */

export const BOOK_KEYS = ['regime', 'hold', 'carryPos', 'carryNeg', 'dipLong', 'ladder', 'plan', 'planHold'] as const;
export type BookKey = (typeof BOOK_KEYS)[number];
/** The plan and its control: they have the PLAN tab to themselves, the other six the STRATEGIES tab. */
export const PLAN_KEYS: readonly BookKey[] = ['plan', 'planHold'];

export const BOOK_SPOT_FEE = '0.001';
export const BOOK_SWAP_FEE = '0.0005';
/** The negative-funding book holds a coin while its last 24 hours of settled funding sum to at most this. */
export const CARRY_NEG_THRESHOLD = '-0.003';
export const CARRY_NEG_MAX_POSITIONS = 5;
/** Each negative-funding position is at most this share of the book's equity (and at most the coin's borrow quota). */
export const CARRY_NEG_SHARE = '0.2';
export const CARRY_POS_COINS = ['BTC', 'ETH'] as const;
/** The fifth book (dipLong): each long is this share of the book's equity, held this long, at most this many at once. */
export const DIP_SHARE = '0.05';
export const DIP_HOLD_MS = 5 * 86_400_000;
export const DIP_MAX_POSITIONS = 20;
/**
 * The sixth book (ladder, 第 6 本账 of the proposal): ETH and BTC perps bought in lots on the way down and sold together on the
 * bounce, never stopped out. Each lot is LADDER_SHARE of the book's starting capital in notional; a first lot when the 1H close
 * is under LADDER_POS_MAX of the last 20 closed daily bars' range with 1H RSI14 under LADDER_RSI_IN; one more lot each time the
 * close is LADDER_ADD_ATR daily ATR14 under the last lot, up to LADDER_MAX_LOTS; all lots sold when the 1H close is at or above
 * its EMA20 with RSI14 at or above LADDER_RSI_OUT and the lots' average entry is in profit. Nothing is margined, so a losing
 * ladder is carried (cross margin in practice; the 2024-02 → 2026-11 replay carried one for 235 days).
 */
export const LADDER_COINS = ['ETH', 'BTC'] as const;
export const LADDER_SHARE = '0.1';
export const LADDER_MAX_LOTS = 5;
export const LADDER_ADD_ATR = '1';
export const LADDER_POS_MAX = '0.35';
export const LADDER_RSI_IN = 45;
export const LADDER_RSI_OUT = 50;
/**
 * The plan (docs/proposals/complete-strategy-2026-11.md): BTC and ETH spot, half each, held only while the two lines read
 * bull, at an exposure of PLAN_TARGET_VOL over the mix's volatility of the last PLAN_VOL_DAYS closed days, at most
 * PLAN_MAX_EXPOSURE of the book (no leverage); the holding is traded only when it is off the target by more than PLAN_BAND
 * of the book, and sold whole when the two lines stop reading bull. Its control, planHold, buys half of each at the start
 * and keeps them. PLAN_TARGET_VOL is the dial: the replay of 2017-09 to 2026-11 at 0.30, 0.45 and 0.60 is in the proposal.
 */
// shortcut: spot only, and idle USDT earns nothing; the proposal's dials above 1x (perps for the excess) and Simple Earn interest on the cash are built when the owner asks
export const PLAN_COINS = ['BTC', 'ETH'] as const;
export const PLAN_TARGET_VOL = '0.45';
export const PLAN_MAX_EXPOSURE = '1';
export const PLAN_BAND = '0.1';
export const PLAN_VOL_DAYS = 30;
export const BOOKS_VERSION = 1;

/** One leg: coins, signed (+ long, − short); a spot short is borrowed coins sold. */
export interface BookLeg {
  kind: 'perp' | 'spot';
  instId: string;
  qty: string;
  entryPx: string;
}

export interface BookPosition {
  coin: string;
  openedAt: number;
  legs: BookLeg[];
  /** USDT received from funding (paid: negative), interest paid on the borrowed coins and fees, since the opening */
  funding: string;
  interest: string;
  fees: string;
}

export interface BookEvent {
  ts: number;
  kind: 'open' | 'close' | 'funding' | 'interest' | 'decision';
  coin: string | null;
  /** The change of the book's cash in USDT, when the event moved it */
  amount: string | null;
  text: string;
}

export interface Book {
  key: BookKey;
  startedAt: number;
  start: string;
  cash: string;
  positions: BookPosition[];
  /** Hourly equity, [ts, equity] */
  curve: Array<[number, string]>;
  /** Newest last, at most BOOK_EVENTS_KEPT */
  events: BookEvent[];
}

export const BOOK_EVENTS_KEPT = 400;

export interface BooksState {
  version: typeof BOOKS_VERSION;
  books: Book[];
  /** Per perp instrument: the time of the last funding settlement booked */
  fundingSeen: Record<string, number>;
  /** Interest is booked up to this hour */
  interestUntil: number | null;
  /** The UTC date (YYYY-MM-DD) of the last daily decision */
  lastDecisionDay: string | null;
  /** The regime rule as last read */
  regime: RegimeReading | null;
  /** The hour (its start, ms) the ladder last decided on */
  ladderHour: number | null;
  /** The plan as last decided (absent in files written before it) */
  plan?: PlanReading | null;
}

/** What the plan read at its last daily decision; shares of the book as decimals (0.85 = 85%). */
export interface PlanReading {
  ts: number;
  /** The mix's annualised volatility; null with too little history */
  vol: string | null;
  /** The exposure it wants now: 0 while the two lines do not read bull; null when the volatility is unknown */
  target: string | null;
  /** The exposure it would want if the two lines read bull */
  targetIfBull: string | null;
  /** The exposure it held before the decision's trades */
  exposure: string;
}

export interface RegimeReading {
  ts: number;
  bull: boolean;
  close: string;
  sma200: string;
  sma50w: string;
}

export interface BookQuote {
  bid: string;
  ask: string;
}

/** What the books are priced and filled on: the best bid and ask of a spot pair or a perp, the perp's mark. */
export interface BookPrices {
  quote(instId: string): BookQuote | undefined;
  mark(instId: string): string | undefined;
}

export interface BookView {
  key: BookKey;
  startedAt: number;
  start: string;
  equity: string | null;
  cash: string;
  returnPct: string | null;
  maxDrawdownPct: string | null;
  positions: Array<BookPosition & { value: string | null }>;
  curve: Array<[number, string]>;
  events: BookEvent[];
}

export interface BooksView {
  enabled: boolean;
  status: 'disabled' | 'starting' | 'running';
  error: string | null;
  books: BookView[];
  /** The regime rule as last read: bull, the close and its two averages */
  regime: RegimeReading | null;
  /** The plan as last decided */
  plan: PlanReading | null;
  nextDecisionAt: number | null;
  serverTime: number;
}

const mid = (q: BookQuote): Decimal => D(q.bid).plus(q.ask).div(2);
const feeOf = (kind: BookLeg['kind']): string => (kind === 'spot' ? BOOK_SPOT_FEE : BOOK_SWAP_FEE);
/** Adds an event to the book, keeping the last BOOK_EVENTS_KEPT. */
export const addBookEvent = (book: Book, e: BookEvent): void => {
  book.events.push(e);
  if (book.events.length > BOOK_EVENTS_KEPT) book.events.splice(0, book.events.length - BOOK_EVENTS_KEPT);
};

export function newBook(key: BookKey, start: DecimalInput, ts: number): Book {
  return { key, startedAt: ts, start: D(start).toFixed(), cash: D(start).toFixed(), positions: [], curve: [], events: [] };
}

export function newBooksState(start: DecimalInput, ts: number): BooksState {
  return { version: BOOKS_VERSION, books: BOOK_KEYS.map((k) => newBook(k, start, ts)), fundingSeen: {}, interestUntil: null, lastDecisionDay: null, regime: null, ladderHour: null, plan: null };
}

/** The value of one leg at the market: a perp its unrealized PnL at the mark (the mid without one), a spot long what its bid sells it for, a spot short minus what its ask buys it back for. */
export function legValue(leg: BookLeg, prices: BookPrices): Decimal | null {
  const q = prices.quote(leg.instId);
  if (leg.kind === 'perp') {
    const m = prices.mark(leg.instId) ?? (q ? mid(q).toFixed() : undefined);
    return m === undefined ? null : D(leg.qty).mul(D(m).minus(leg.entryPx));
  }
  if (!q) return null;
  return D(leg.qty).mul(D(leg.qty).gt(0) ? q.bid : q.ask);
}

export function positionValue(p: BookPosition, prices: BookPrices): Decimal | null {
  let v = ZERO;
  for (const leg of p.legs) {
    const x = legValue(leg, prices);
    if (x === null) return null;
    v = v.plus(x);
  }
  return v;
}

/** Cash plus every position at the market; null when a price is missing. */
export function bookEquity(book: Book, prices: BookPrices): Decimal | null {
  let e = D(book.cash);
  for (const p of book.positions) {
    const v = positionValue(p, prices);
    if (v === null) return null;
    e = e.plus(v);
  }
  return e;
}

/**
 * Opens a position of legs given in coins at the market: buys at the ask, sells at the bid. A spot buy pays its cost
 * from the cash and a spot sale (of borrowed coins) adds its proceeds; a perp moves only its fee. Throws on a missing price.
 */
export function openPosition(book: Book, coin: string, legs: Array<{ kind: BookLeg['kind']; instId: string; qty: DecimalInput }>, prices: BookPrices, ts: number, why: string): BookPosition {
  let cash = D(book.cash);
  let fees = ZERO;
  const filled: BookLeg[] = legs.map((l) => {
    const q = prices.quote(l.instId);
    if (!q) throw new Error(`no quote for ${l.instId}`);
    const qty = D(l.qty);
    const px = D(qty.gt(0) ? q.ask : q.bid);
    const fee = qty.abs().mul(px).mul(feeOf(l.kind));
    fees = fees.plus(fee);
    if (l.kind === 'spot') cash = cash.minus(qty.mul(px));
    return { kind: l.kind, instId: l.instId, qty: qty.toFixed(), entryPx: px.toFixed() };
  });
  cash = cash.minus(fees);
  const moved = cash.minus(book.cash);
  book.cash = cash.toFixed();
  const p: BookPosition = { coin, openedAt: ts, legs: filled, funding: '0', interest: '0', fees: fees.toFixed() };
  book.positions.push(p);
  addBookEvent(book, { ts, kind: 'open', coin, amount: moved.toFixed(), text: `${why}: ${filled.map((l) => `${l.kind} ${l.instId} ${l.qty} @ ${l.entryPx}`).join(', ')}` });
  return p;
}

/** Closes the position at the market: sells longs at the bid, buys back shorts at the ask; the perp's PnL and every fee settle in cash. */
export function closePosition(book: Book, p: BookPosition, prices: BookPrices, ts: number, why: string): void {
  let cash = D(book.cash);
  let fees = ZERO;
  const parts: string[] = [];
  for (const l of p.legs) {
    const q = prices.quote(l.instId);
    if (!q) throw new Error(`no quote for ${l.instId}`);
    const qty = D(l.qty);
    const px = D(qty.gt(0) ? q.bid : q.ask);
    fees = fees.plus(qty.abs().mul(px).mul(feeOf(l.kind)));
    cash = l.kind === 'spot' ? cash.plus(qty.mul(px)) : cash.plus(qty.mul(px.minus(l.entryPx)));
    parts.push(`${l.kind} ${l.instId} @ ${px.toFixed()}`);
  }
  cash = cash.minus(fees);
  const moved = cash.minus(book.cash);
  book.cash = cash.toFixed();
  p.fees = D(p.fees).plus(fees).toFixed();
  book.positions = book.positions.filter((x) => x !== p);
  addBookEvent(book, { ts, kind: 'close', coin: p.coin, amount: moved.toFixed(), text: `${why}: ${parts.join(', ')}; funding ${D(p.funding).toFixed(2)}, interest ${D(p.interest).toFixed(2)}, fees ${D(p.fees).toFixed(2)}` });
}

/**
 * Trades the book's spot holding of one coin to `targetValue` USDT at the market: what is missing is bought at the ask, its
 * fee paid out of the same sum; what is over is sold at the bid; a target of zero sells the holding whole. One position per
 * coin, its entry the average of the buys. Returns the coins traded (bought positive, sold negative). Throws on a missing price.
 */
export function resizeSpot(book: Book, coin: string, instId: string, targetValue: DecimalInput, prices: BookPrices, ts: number, why: string): Decimal {
  const q = prices.quote(instId);
  if (!q) throw new Error(`no quote for ${instId}`);
  const held = book.positions.find((p) => p.coin === coin && p.legs.length === 1 && p.legs[0]?.kind === 'spot' && p.legs[0].instId === instId);
  const leg = held?.legs[0];
  const have = leg ? D(leg.qty) : ZERO;
  const target = D(targetValue);
  if (!target.gt(0)) {
    if (held) closePosition(book, held, prices, ts, why);
    return have.neg();
  }
  const diff = target.minus(have.mul(q.bid));
  if (diff.gt(0)) {
    const qty = floorToStep(diff.div(D(q.ask).mul(D(1).plus(BOOK_SPOT_FEE))), '0.00000001');
    if (!qty.gt(0)) return ZERO;
    if (!held || !leg) {
      openPosition(book, coin, [{ kind: 'spot', instId, qty }], prices, ts, why);
      return qty;
    }
    const cost = qty.mul(q.ask);
    const fee = cost.mul(BOOK_SPOT_FEE);
    leg.entryPx = have.mul(leg.entryPx).plus(cost).div(have.plus(qty)).toFixed();
    leg.qty = have.plus(qty).toFixed();
    held.fees = D(held.fees).plus(fee).toFixed();
    book.cash = D(book.cash).minus(cost).minus(fee).toFixed();
    addBookEvent(book, { ts, kind: 'open', coin, amount: cost.plus(fee).neg().toFixed(), text: `${why}: spot ${instId} +${qty.toFixed()} @ ${q.ask}` });
    return qty;
  }
  if (!held || !leg) return ZERO;
  const qty = floorToStep(diff.neg().div(q.bid), '0.00000001');
  if (!qty.gt(0)) return ZERO;
  if (qty.gte(have)) {
    closePosition(book, held, prices, ts, why);
    return have.neg();
  }
  const proceeds = qty.mul(q.bid);
  const fee = proceeds.mul(BOOK_SPOT_FEE);
  leg.qty = have.minus(qty).toFixed();
  held.fees = D(held.fees).plus(fee).toFixed();
  book.cash = D(book.cash).plus(proceeds).minus(fee).toFixed();
  addBookEvent(book, { ts, kind: 'close', coin, amount: proceeds.minus(fee).toFixed(), text: `${why}: spot ${instId} -${qty.toFixed()} @ ${q.bid}` });
  return qty.neg();
}

/**
 * A funding settlement of a perp at `ts`: a long pays a positive rate on its value at the mark, a short receives it;
 * only positions opened before the settlement take part. Returns the cash moved.
 */
export function applyFunding(book: Book, instId: string, rate: DecimalInput, markPx: DecimalInput, ts: number): Decimal {
  let total = ZERO;
  for (const p of book.positions) {
    if (p.openedAt >= ts) continue;
    for (const l of p.legs) {
      if (l.kind !== 'perp' || l.instId !== instId) continue;
      const amount = D(l.qty).mul(markPx).mul(rate).neg();
      p.funding = D(p.funding).plus(amount).toFixed();
      total = total.plus(amount);
    }
  }
  if (!total.isZero()) {
    book.cash = D(book.cash).plus(total).toFixed();
    addBookEvent(book, { ts, kind: 'funding', coin: instId.split('-')[0] ?? instId, amount: total.toFixed(), text: `funding ${instId} ${D(rate).mul(100).toFixed()}%` });
  }
  return total;
}

/** Interest on the borrowed coins (spot shorts) for `hours` at an hourly rate per coin, on their value at the ask. Returns the cash moved (negative). */
export function applyInterest(book: Book, hourlyRate: (coin: string) => DecimalInput | undefined, prices: BookPrices, hours: number, ts: number): Decimal {
  let total = ZERO;
  for (const p of book.positions) {
    for (const l of p.legs) {
      if (l.kind !== 'spot' || !D(l.qty).lt(0)) continue;
      const r = hourlyRate(p.coin);
      const q = prices.quote(l.instId);
      if (r === undefined || !q) continue;
      const cost = D(l.qty).abs().mul(q.ask).mul(r).mul(hours);
      p.interest = D(p.interest).plus(cost).toFixed();
      total = total.minus(cost);
    }
  }
  if (!total.isZero()) {
    book.cash = D(book.cash).plus(total).toFixed();
    addBookEvent(book, { ts, kind: 'interest', coin: null, amount: total.toFixed(), text: `interest on borrowed coins, ${hours} h` });
  }
  return total;
}

/** The hourly borrow rate: the higher of OKX's posted base daily rate over 24 and the latest Simple Earn lending rate (annual) over 8,760. */
export function hourlyBorrowRate(baseDaily: DecimalInput | undefined, lendingAnnual: DecimalInput | undefined): Decimal | undefined {
  const a = baseDaily === undefined ? undefined : D(baseDaily).div(24);
  const b = lendingAnnual === undefined ? undefined : D(lendingAnnual).div(8760);
  if (a === undefined) return b;
  if (b === undefined) return a;
  return a.gt(b) ? a : b;
}

const sma = (v: readonly DecimalInput[]): Decimal => v.reduce<Decimal>((s, x) => s.plus(x), ZERO).div(v.length);

/** The two-line rule: the last daily close above both the 200-day average and the 50-week average of closed weeks. null with too little history. */
export function regimeRead(dailyCloses: readonly DecimalInput[], weeklyCloses: readonly DecimalInput[]): { bull: boolean; close: string; sma200: string; sma50w: string } | null {
  if (dailyCloses.length < 200 || weeklyCloses.length < 50) return null;
  const close = D(dailyCloses[dailyCloses.length - 1] as DecimalInput);
  const s200 = sma(dailyCloses.slice(-200));
  const s50 = sma(weeklyCloses.slice(-50));
  return { bull: close.gt(s200) && close.gt(s50), close: close.toFixed(), sma200: s200.toFixed(), sma50w: s50.toFixed() };
}

/**
 * The annualised (365 days) standard deviation of the daily returns of the equal-weight mix of the coins over the last
 * `days` closed days. Each list is one coin's daily closes, oldest first, all ending on the same day. null with too little history.
 */
export function mixVolatility(closes: readonly (readonly DecimalInput[])[], days = PLAN_VOL_DAYS): Decimal | null {
  if (closes.length === 0 || closes.some((c) => c.length < days + 1)) return null;
  const rets: Decimal[] = [];
  for (let k = days; k >= 1; k--) {
    let r = ZERO;
    for (const c of closes) r = r.plus(D(c[c.length - k] as DecimalInput).div(c[c.length - k - 1] as DecimalInput).minus(1));
    rets.push(r.div(closes.length));
  }
  const mean = rets.reduce((s, x) => s.plus(x), ZERO).div(days);
  const variance = rets.reduce((s, x) => s.plus(x.minus(mean).pow(2)), ZERO).div(days - 1);
  return variance.mul(365).sqrt();
}

/**
 * The share of the book the plan wants in the market: nothing while the two lines do not read bull; otherwise PLAN_TARGET_VOL
 * over the mix's volatility, at most PLAN_MAX_EXPOSURE. null while bull with the volatility unknown (or zero): the holding is then left as it is.
 */
export function planTarget(bull: boolean, vol: DecimalInput | null): Decimal | null {
  if (!bull) return ZERO;
  if (vol === null || !D(vol).gt(0)) return null;
  const x = D(PLAN_TARGET_VOL).div(vol);
  return x.gt(PLAN_MAX_EXPOSURE) ? D(PLAN_MAX_EXPOSURE) : x;
}

export interface CarryCandidate {
  coin: string;
  perpId: string;
  spotId: string;
  /** Settled funding over the last 24 hours, summed */
  funding24h: string;
  /** What OKX lends of the coin, in coins */
  quota: string;
}

/**
 * The negative-funding book's day: the held coins whose last 24 hours no longer sum to the threshold or below are
 * closed; then the most negative candidates are opened, while fewer than the maximum are held, each at the smaller
 * of the book's share and the borrow quota at the spot bid.
 */
export function carryNegPlan(candidates: readonly CarryCandidate[], held: readonly string[], equity: DecimalInput, prices: BookPrices): { close: string[]; open: Array<{ c: CarryCandidate; usdt: string }> } {
  const byCoin = new Map(candidates.map((c) => [c.coin, c]));
  const close = held.filter((coin) => {
    const c = byCoin.get(coin);
    return c === undefined || D(c.funding24h).gt(CARRY_NEG_THRESHOLD);
  });
  const keep = held.filter((c) => !close.includes(c));
  const open: Array<{ c: CarryCandidate; usdt: string }> = [];
  const share = D(equity).mul(CARRY_NEG_SHARE);
  for (const c of [...candidates].filter((x) => D(x.funding24h).lte(CARRY_NEG_THRESHOLD) && !keep.includes(x.coin)).sort((a, b) => D(a.funding24h).cmp(b.funding24h))) {
    if (keep.length + open.length >= CARRY_NEG_MAX_POSITIONS) break;
    const q = prices.quote(c.spotId);
    if (!q || !prices.quote(c.perpId)) continue;
    const cap = D(c.quota).mul(q.bid);
    const usdt = share.lt(cap) ? share : cap;
    if (usdt.lte(10)) continue;
    open.push({ c, usdt: usdt.toFixed() });
  }
  return { close, open };
}

export interface LadderPlan {
  action: 'open' | 'add' | 'close';
  why: string;
}

/**
 * The ladder's decision for one coin at a 1H close: `h1` and `d1` its closed 1H and daily bars (oldest first, the last 1H bar the
 * one just closed), `lots` the book's open positions in the coin. null with too little history or nothing to do.
 */
export function ladderPlan(h1: readonly MtfBar[], d1: readonly MtfBar[], lots: readonly BookPosition[]): LadderPlan | null {
  if (h1.length < 50 || d1.length < 21) return null;
  const closes = h1.map((b) => D(b[4]));
  const c = closes[closes.length - 1] as Decimal;
  const rsi = rsiSeq(closes)[closes.length - 1] ?? null;
  const e20 = emaSeq(closes, 20)[closes.length - 1] ?? null;
  const atr = atrSeq(d1)[d1.length - 1] ?? null;
  if (rsi === null || e20 === null || atr === null || atr.lte(0)) return null;
  const last20 = d1.slice(-20);
  const hi = last20.reduce<Decimal>((m, b) => (D(b[2]).gt(m) ? D(b[2]) : m), D(last20[0]![2]));
  const lo = last20.reduce<Decimal>((m, b) => (D(b[3]).lt(m) ? D(b[3]) : m), D(last20[0]![3]));
  if (hi.lte(lo)) return null;
  const pos20 = c.minus(lo).div(hi.minus(lo));
  if (lots.length === 0) {
    return pos20.lt(LADDER_POS_MAX) && rsi.lt(LADDER_RSI_IN) ? { action: 'open', why: `range ${pos20.mul(100).toFixed(0)}%, RSI ${rsi.toFixed(0)}` } : null;
  }
  const legs = lots.flatMap((p) => p.legs);
  const qty = legs.reduce<Decimal>((s, l) => s.plus(l.qty), ZERO);
  if (qty.lte(0)) return null;
  const avg = legs.reduce<Decimal>((s, l) => s.plus(D(l.qty).mul(l.entryPx)), ZERO).div(qty);
  if (c.gte(e20) && rsi.gte(LADDER_RSI_OUT) && c.gt(avg)) return { action: 'close', why: `bounce: close ${c.toFixed()} over EMA20 ${e20.toFixed(1)}, RSI ${rsi.toFixed(0)}, average ${avg.toFixed(1)}` };
  const lastLot = lots.reduce((m, p) => (p.openedAt > m.openedAt ? p : m));
  const lastPx = D(lastLot.legs[0]?.entryPx ?? avg);
  if (lots.length < LADDER_MAX_LOTS && c.lte(lastPx.minus(atr.mul(LADDER_ADD_ATR)))) return { action: 'add', why: `lot ${lots.length + 1}: close ${c.toFixed()}, ${LADDER_ADD_ATR} ATR (${atr.toFixed(1)}) under the last lot ${lastPx.toFixed()}` };
  return null;
}

/** The view of one book: its equity at the market, return since its start and largest fall of its hourly curve. */
export function bookView(book: Book, prices: BookPrices, curveKept = 2000): BookView {
  const eq = bookEquity(book, prices);
  let peak: Decimal | null = null;
  let dd = ZERO;
  for (const [, v] of book.curve) {
    const x = D(v);
    if (peak === null || x.gt(peak)) peak = x;
    const fall = x.div(peak).minus(1);
    if (fall.lt(dd)) dd = fall;
  }
  return {
    key: book.key,
    startedAt: book.startedAt,
    start: book.start,
    equity: eq === null ? null : eq.toFixed(2),
    cash: D(book.cash).toFixed(2),
    returnPct: eq === null ? null : eq.div(book.start).minus(1).mul(100).toFixed(2),
    maxDrawdownPct: book.curve.length === 0 ? null : dd.mul(100).toFixed(2),
    positions: book.positions.map((p) => {
      const v = positionValue(p, prices);
      return { ...p, value: v === null ? null : v.toFixed(2) };
    }),
    curve: book.curve.slice(-curveKept),
    events: book.events.slice(-60).reverse(),
  };
}
