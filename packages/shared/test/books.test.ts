import { describe, expect, it } from 'vitest';
import { D } from '../src/decimal.js';
import { applyFunding, applyInterest, bookEquity, bookView, carryNegPlan, closePosition, hourlyBorrowRate, newBook, openPosition, regimeRead, type BookPrices, type BookQuote } from '../src/books.js';

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
});
