import { describe, expect, it } from 'vitest';
import { D } from '../src/decimal.js';
import { applyFunding, applyInterest, bookEquity, bookView, carryNegPlan, closePosition, hourlyBorrowRate, ladderPlan, newBook, openPosition, regimeRead, type BookPosition, type BookPrices, type BookQuote } from '../src/books.js';
import type { MtfBar } from '../src/mtf-features.js';

const pricesOf = (quotes: Record<string, BookQuote>, marks: Record<string, string> = {}): BookPrices => ({ quote: (id) => quotes[id], mark: (id) => marks[id] });

describe('the paper books', () => {
  it('a hedged carry (spot long, perp short) pays the spread and both fees, and earns the funding a short receives', () => {
    const b = newBook('carryPos', '10000', 0);
    const px = pricesOf({ 'BTC-USDT': { bid: '99990', ask: '100010' }, 'BTC-USDT-SWAP': { bid: '100000', ask: '100020' } }, { 'BTC-USDT-SWAP': '100010' });
    const p = openPosition(b, 'BTC', [{ kind: 'spot', instId: 'BTC-USDT', qty: '0.05' }, { kind: 'perp', instId: 'BTC-USDT-SWAP', qty: '-0.05' }], px, 0, 'start');
    // spot 0.05 at 100,010 = 5,000.50 plus 0.1% = 5.0005; the perp's fee 0.05% of 0.05 at 100,000 = 2.5
    expect(b.cash).toBe(D('10000').minus('5000.5').minus('5.0005').minus('2.5').toFixed());
    expect(p.legs.map((l) => l.entryPx)).toEqual(['100010', '100000']);
    // at the market: spot sells at 99,990 (−1), the short's mark 100,010 (−0.5): the spread and the fees are the loss
    expect(bookEquity(b, px)?.toFixed()).toBe(D('10000').minus('5.0005').minus('2.5').minus('1').minus('0.5').toFixed());
    // a short receives a positive rate: 0.01% of 0.05 at 100,010
    expect(applyFunding(b, 'BTC-USDT-SWAP', '0.0001', '100010', 1).toFixed()).toBe('0.50005');
    expect(p.funding).toBe('0.50005');
    closePosition(b, p, px, 2, 'end');
    expect(b.positions).toEqual([]);
    // closing: spot sold at 99,990 (fee 4.9995), the short bought back at 100,020 (−1, fee 2.5005)
    const expected = D('10000').minus('5000.5').minus('5.0005').minus('2.5').plus('0.50005').plus('4999.5').minus('4.9995').minus('1').minus('2.5005');
    expect(b.cash).toBe(expected.toFixed());
  });

  it('a borrowed coin sold short costs interest by the hour on its value at the ask', () => {
    const b = newBook('carryNeg', '10000', 0);
    const px = pricesOf({ 'ZIL-USDT': { bid: '0.0199', ask: '0.0201' }, 'ZIL-USDT-SWAP': { bid: '0.02', ask: '0.0201' } });
    openPosition(b, 'ZIL', [{ kind: 'perp', instId: 'ZIL-USDT-SWAP', qty: '100000' }, { kind: 'spot', instId: 'ZIL-USDT', qty: '-100000' }], px, 0, 'open');
    // sold 100,000 at 0.0199 = 1,990 in, less 1.99 fee; the long perp's fee 0.05% of 2,010 = 1.005
    expect(b.cash).toBe(D('10000').plus('1990').minus('1.99').minus('1.005').toFixed());
    const moved = applyInterest(b, () => '0.0001', px, 3, 3_600_000 * 3);
    expect(moved.toFixed()).toBe('-0.603');
    expect(b.positions[0]?.interest).toBe('0.603');
    // a long perp receives a negative rate
    expect(applyFunding(b, 'ZIL-USDT-SWAP', '-0.002', '0.02', 4).toFixed()).toBe('4');
  });

  it('the borrow rate is the higher of the posted base and the lending rate', () => {
    expect(hourlyBorrowRate('0.0024', '0.876')?.toFixed()).toBe('0.0001');
    expect(hourlyBorrowRate('0.0048', '0.438')?.toFixed()).toBe('0.0002');
    expect(hourlyBorrowRate(undefined, '0.876')?.toFixed()).toBe('0.0001');
    expect(hourlyBorrowRate(undefined, undefined)).toBeUndefined();
  });

  it('reads the two lines: bull only above both the 200-day and the 50-week average', () => {
    const days = Array.from({ length: 200 }, (_, i) => String(100 + i));
    const weeks = Array.from({ length: 50 }, () => '350');
    expect(regimeRead(days.slice(1), weeks)).toBeNull();
    expect(regimeRead(days, weeks)).toMatchObject({ bull: false, close: '299', sma200: '199.5', sma50w: '350' });
    expect(regimeRead(days, weeks.map(() => '200'))?.bull).toBe(true);
  });

  it('plans the negative-funding day: closes what no longer pays, opens the most negative within the quota', () => {
    const q = { bid: '1', ask: '1.01' };
    const px = pricesOf({ 'A-USDT': q, 'A-USDT-SWAP': q, 'B-USDT': q, 'B-USDT-SWAP': q, 'C-USDT': q, 'C-USDT-SWAP': q });
    const c = (coin: string, f: string, quota = '1000000') => ({ coin, perpId: `${coin}-USDT-SWAP`, spotId: `${coin}-USDT`, funding24h: f, quota });
    const plan = carryNegPlan([c('A', '-0.004'), c('B', '-0.01', '500'), c('C', '-0.001')], ['C'], '10000', px);
    expect(plan.close).toEqual(['C']);
    // B first (most negative), capped by its quota (500 coins at the bid 1); A at 20% of 10,000
    expect(plan.open.map((o) => [o.c.coin, o.usdt])).toEqual([['B', '500'], ['A', '2000']]);
  });

  it('views a book: return since the start and the largest fall of its curve', () => {
    const b = newBook('hold', '10000', 0);
    b.curve = [[0, '10000'], [1, '12000'], [2, '9000'], [3, '11000']];
    const v = bookView(b, pricesOf({}));
    expect(v).toMatchObject({ equity: '10000.00', returnPct: '0.00', maxDrawdownPct: '-25.00' });
  });

  it('the ladder buys a first lot at the range low with a weak RSI, adds a daily ATR lower, and sells everything on a bounce in profit', () => {
    const H = 3_600_000;
    const DAY = 86_400_000;
    // 25 closed daily bars ranging 90–120 with ranges of 4: the 20-day range is 90–120, the daily ATR14 about 4
    const d1: MtfBar[] = Array.from({ length: 25 }, (_, i): MtfBar => [i * DAY, '104', String(i === 24 ? 120 : 110 + (i % 3)), String(i === 20 ? 90 : 100 - (i % 3)), '104', '1']);
    const h1Of = (closes: number[]): MtfBar[] => closes.map((c, i): MtfBar => [i * H, String(c), String(c + 0.5), String(c - 0.5), String(c), '1']);
    // 60 falling closes 110 → 80.5: RSI near 0, close in the lower 35% of the range → a first lot
    expect(ladderPlan(h1Of(Array.from({ length: 60 }, (_, i) => 110 - i * 0.5)), d1, [])?.action).toBe('open');
    // the same closes but still in the middle of the range: nothing
    expect(ladderPlan(h1Of(Array.from({ length: 60 }, (_, i) => 130 - i * 0.5)), d1, [])).toBeNull();
    const lot = (px: string, openedAt: number): BookPosition => ({ coin: 'ETH', openedAt, legs: [{ kind: 'perp', instId: 'ETH-USDT-SWAP', qty: '1', entryPx: px }], funding: '0', interest: '0', fees: '0' });
    // a lot at 100, the close at 80.5: more than one ATR (about 4) under it → one more lot
    expect(ladderPlan(h1Of(Array.from({ length: 60 }, (_, i) => 110 - i * 0.5)), d1, [lot('100', 0)])?.action).toBe('add');
    // five lots already: no more
    expect(ladderPlan(h1Of(Array.from({ length: 60 }, (_, i) => 110 - i * 0.5)), d1, [0, 1, 2, 3, 4].map((k) => lot(String(100 - k * 4), k)))).toBeNull();
    // a bounce: 40 falling closes then 20 rising to 100, over the EMA20 with a strong RSI, the average entry 85 in profit → sell everything
    const bounce = h1Of([...Array.from({ length: 40 }, (_, i) => 100 - i * 0.5), ...Array.from({ length: 20 }, (_, i) => 81 + i)]);
    expect(ladderPlan(bounce, d1, [lot('90', 0), lot('80', 1)])?.action).toBe('close');
    // the same bounce with the average entry above the close: carried
    expect(ladderPlan(bounce, d1, [lot('110', 0), lot('105', 1)])?.action).not.toBe('close');
    // too little history
    expect(ladderPlan(h1Of([100, 99]), d1, [])).toBeNull();
  });
});
