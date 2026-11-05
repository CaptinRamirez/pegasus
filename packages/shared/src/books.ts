import { D, ZERO, type Decimal, type DecimalInput } from './decimal.js';

/**
 * The five paper books of docs/proposals/paper-books-2026-11.md: each a ledger of its own, settled on OKX's live public
 * data (tickers for the fills, OKX's funding settlements, OKX's borrow rates) rather than on the paper exchange, which
 * has no spot and no borrowing. Market orders fill at the ask (buys) and the bid (sells) at OKX's taker fees; the
 * hedged legs are not margined, so nothing is liquidated. Pure arithmetic; the service in apps/api/src/services/books.ts
 * fetches the data and keeps the file.
 */

export const BOOK_KEYS = ['regime', 'hold', 'carryPos', 'carryNeg', 'dipLong'] as const;
export type BookKey = (typeof BOOK_KEYS)[number];

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
  return { version: BOOKS_VERSION, books: BOOK_KEYS.map((k) => newBook(k, start, ts)), fundingSeen: {}, interestUntil: null, lastDecisionDay: null, regime: null };
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
