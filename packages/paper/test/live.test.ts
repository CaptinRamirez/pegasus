import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { d } from '@pegasus/mock-okx/engine';
import { LiveBook } from '../src/index.js';
import { BTC, ETH, MIN, T0, open, place, quote, stopAt } from './helpers.js';

describe('LiveBook', () => {
  const book = new LiveBook();
  book.set(
    [['59999.9', '5'], ['59999.8', '7'], ['59999.7', '9']],
    [['60000.1', '4'], ['60000.2', '6'], ['60000.3', '8']],
  );
  const fills = (rows: Array<{ px: { toFixed(): string }; sz: { toFixed(): string } }>): string[][] => rows.map((f) => [f.px.toFixed(), f.sz.toFixed()]);

  it('a buy takes the asks level by level, a sell the bids, and the book is not consumed', () => {
    expect(fills(book.walk('buy', d(7)))).toEqual([['60000.1', '4'], ['60000.2', '3']]);
    expect(fills(book.walk('sell', d(6)))).toEqual([['59999.9', '5'], ['59999.8', '1']]);
    expect(fills(book.walk('buy', d(7)))).toEqual([['60000.1', '4'], ['60000.2', '3']]);
  });

  it('never fills beyond the limit price, and tells whether a limit price is reached', () => {
    expect(fills(book.walk('buy', d(20), d('60000.2')))).toEqual([['60000.1', '4'], ['60000.2', '6']]);
    expect(book.available('buy', d('60000.2')).toFixed()).toBe('10');
    expect(book.crosses('buy', d('60000.1'))).toBe(true);
    expect(book.crosses('buy', d('60000'))).toBe(false);
    expect(book.crosses('sell', d('59999.9'))).toBe(true);
    expect(book.crosses('sell', d('60000'))).toBe(false);
  });

  it('a market order larger than the known levels fills the rest at the last one', () => {
    expect(fills(book.walk('buy', d(30)))).toEqual([['60000.1', '4'], ['60000.2', '6'], ['60000.3', '8'], ['60000.3', '12']]);
  });

  it('an empty book fills nothing', () => {
    const empty = new LiveBook();
    expect(empty.walk('buy', d(1))).toEqual([]);
    expect(empty.crosses('buy', d('1000000'))).toBe(false);
    expect(empty.empty).toBe(true);
  });
});

describe('paper account against live quotes', () => {
  beforeEach(() => {
    vi.useFakeTimers({ now: T0 + 30 * MIN });
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('fills nothing before the market is quoted: a market order is cancelled unfilled', () => {
    const { paper } = open();
    const ack = place(paper, { side: 'buy', ordType: 'market', sz: '10' });
    expect(ack.sCode).toBe('0');
    expect(paper.engine.state().orders).toMatchObject([{ ordId: ack.ordId, state: 'canceled', accFillSz: '0' }]);
    expect(paper.engine.state().positions).toEqual([]);
  });

  it('a market order fills at the quoted asks and pays the taker fee; the balance and the position follow the mark', () => {
    const { paper } = open();
    quote(paper, BTC, 60000, { ask: '4' });
    const ack = place(paper, { side: 'buy', ordType: 'market', sz: '10' });
    const order = paper.engine.state().orders.find((o) => o.ordId === ack.ordId);
    // 4 at 60000.1, 4 at 60000.2, 2 at 60000.3: 600001.8 / 10
    expect(order).toMatchObject({ state: 'filled', accFillSz: '10', avgPx: '60000.18' });
    // 0.1 BTC x 60000.18 x 0.0005
    expect(order?.fee).toBe('-3.000009');
    expect(paper.engine.state().positions).toMatchObject([{ instId: BTC, pos: '10', avgPx: '60000.18', lever: '3' }]);
    expect(d(paper.engine.state().balance.details[0]?.cashBal ?? '0').toFixed()).toBe('99996.999991');

    quote(paper, BTC, 61000);
    const [pos] = paper.engine.state().positions;
    expect(pos?.markPx).toBe('61000');
    expect(pos?.upl).toBe('99.982'); // 0.1 BTC x (61000 - 60000.18)
    expect(d(paper.engine.state().balance.totalEq).toFixed()).toBe('100096.981991');
  });

  it('a resting limit order fills in full at its own price, with the maker fee, once the opposite quote reaches it', () => {
    const { paper } = open();
    quote(paper, BTC, 60000);
    const ack = place(paper, { side: 'buy', ordType: 'limit', px: '59900', sz: '10' });
    expect(paper.engine.state().orders.find((o) => o.ordId === ack.ordId)?.state).toBe('live');
    quote(paper, BTC, 59900.1); // best ask 59900.2: not reached
    expect(paper.engine.state().orders.find((o) => o.ordId === ack.ordId)?.state).toBe('live');
    quote(paper, BTC, 59899.9); // best ask 59900
    const order = paper.engine.state().orders.find((o) => o.ordId === ack.ordId);
    expect(order).toMatchObject({ state: 'filled', accFillSz: '10', avgPx: '59900', execType: 'M' });
    expect(order?.fee).toBe('-1.198'); // 0.1 BTC x 59900 x 0.0002
  });

  it('a marketable limit order takes what the book offers up to its price and rests the remainder', () => {
    const { paper } = open();
    quote(paper, BTC, 60000, { ask: '4' });
    const ack = place(paper, { side: 'buy', ordType: 'limit', px: '60000.1', sz: '10' });
    expect(paper.engine.state().orders.find((o) => o.ordId === ack.ordId)).toMatchObject({ state: 'partially_filled', accFillSz: '4', avgPx: '60000.1' });
  });

  it('generates the attached stop at the complete fill and fires it when the real mark reaches the trigger', () => {
    const { paper } = open();
    quote(paper, BTC, 60000);
    expect(place(paper, { side: 'buy', ordType: 'market', sz: '10', ...stopAt('59000') }).sCode).toBe('0');
    expect(paper.engine.state().stops).toMatchObject([{ instId: BTC, side: 'sell', sz: '10', slTriggerPx: '59000', slTriggerPxType: 'mark' }]);
    quote(paper, BTC, 59000.1);
    expect(paper.engine.state().positions).toHaveLength(1);
    quote(paper, BTC, 59000);
    expect(paper.engine.state().positions).toEqual([]);
    expect(paper.engine.state().stops).toEqual([]);
    // closed at the quoted bid, not at the trigger
    const closing = paper.engine.state().orders.find((o) => o.side === 'sell');
    expect(closing).toMatchObject({ ordType: 'market', state: 'filled', avgPx: '58999.9', reduceOnly: 'true' });
  });

  it('while the feed is down nothing fills and no stop fires; a short outage resumes on the first full quote', () => {
    const { paper, history } = open();
    quote(paper, BTC, 60000);
    place(paper, { side: 'buy', ordType: 'market', sz: '10', ...stopAt('59000') });
    paper.onFeedDown();
    expect(place(paper, { side: 'buy', ordType: 'market', sz: '1' }).sCode).toBe('0');
    expect(paper.engine.state().positions).toMatchObject([{ pos: '10' }]); // the order during the outage was cancelled unfilled
    paper.onMark(BTC, '58000'); // a mark without a book: not a full quote
    expect(paper.engine.state().positions).toHaveLength(1);
    vi.setSystemTime(T0 + 30 * MIN + 20_000);
    quote(paper, BTC, 58000); // back after 20 s: the stop fires on the price of now
    expect(paper.engine.state().positions).toEqual([]);
    expect(history.barReads).toEqual([]);
  });

  it('quotes of one instrument do not make another one live', () => {
    const { paper } = open();
    quote(paper, BTC, 60000);
    const ack = place(paper, { instId: ETH, side: 'buy', ordType: 'market', sz: '10' });
    expect(paper.engine.state().orders.find((o) => o.ordId === ack.ordId)).toMatchObject({ state: 'canceled', accFillSz: '0' });
  });
});

describe('the account file', () => {
  beforeEach(() => {
    vi.useFakeTimers({ now: T0 + 30 * MIN });
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('a new account starts with the configured balance; the file keeps it, its positions, orders and stops across a restart', async () => {
    const first = open({ initialBalance: '50000' });
    expect(first.paper.restored).toBe(false);
    quote(first.paper, BTC, 60000);
    place(first.paper, { side: 'buy', ordType: 'market', sz: '10', ...stopAt('59000') });
    place(first.paper, { side: 'buy', ordType: 'limit', px: '58000', sz: '5', clOrdId: 'resting1' });
    paper_setLeverage(first.paper);
    const before = first.paper.engine.state();
    first.paper.close();

    vi.setSystemTime(T0 + 30 * MIN + 5_000);
    // another configured balance does not touch an account that exists
    const second = open({ stateFile: first.stateFile, initialBalance: '999' });
    expect(second.paper.restored).toBe(true);
    const after = second.paper.engine.state();
    expect(after.balance.details[0]?.cashBal).toBe(before.balance.details[0]?.cashBal);
    expect(after.positions).toMatchObject([{ instId: BTC, pos: '10', avgPx: before.positions[0]?.avgPx, lever: '3' }]);
    expect(after.stops).toEqual(before.stops);
    expect(after.orders.map((o) => [o.ordId, o.clOrdId, o.state, o.px, o.sz])).toEqual(before.orders.map((o) => [o.ordId, o.clOrdId, o.state, o.px, o.sz]));
    expect(after.fills).toEqual(before.fills);
    expect(second.paper.engine.leverageInfo(ETH, 'cross')).toEqual([{ instId: ETH, mgnMode: 'cross', posSide: 'net', lever: '7' }]);
    expect(existsSync(`${first.stateFile}.bak`)).toBe(true);

    // ids keep counting: a new order does not reuse one of the old account
    quote(second.paper, BTC, 60000);
    const ack = place(second.paper, { side: 'sell', ordType: 'limit', px: '65000', sz: '1' });
    expect(before.orders.some((o) => o.ordId === ack.ordId)).toBe(false);
  });

  it('writes the file on every order and on every change of a position, not on a mark that only moved', () => {
    const { paper, stateFile } = open();
    quote(paper, BTC, 60000);
    expect(JSON.parse(readFileSync(stateFile, 'utf8'))).toMatchObject({ account: { positions: [] } }); // written when the market went live
    place(paper, { side: 'buy', ordType: 'market', sz: '10' });
    const saved = readFileSync(stateFile, 'utf8');
    expect(JSON.parse(saved)).toMatchObject({ version: 1, posMode: 'net_mode', initialBalance: '100000', account: { positions: [{ instId: BTC, qty: '10' }] } });
    vi.setSystemTime(T0 + 30 * MIN + 2_000);
    quote(paper, BTC, 60500);
    expect(readFileSync(stateFile, 'utf8')).toBe(saved);
  });

  it('refuses a file that is damaged or of another position mode instead of starting a new account over it', () => {
    const { paper, stateFile } = open();
    quote(paper, BTC, 60000);
    place(paper, { side: 'buy', ordType: 'market', sz: '10' });
    paper.close();
    expect(() => open({ stateFile, posMode: 'long_short_mode' })).toThrow(/was created in net_mode/);
    writeFileSync(stateFile, '{"version":1,"account":');
    expect(() => open({ stateFile })).toThrow(/cannot be read/);
    writeFileSync(stateFile, '{"settings":{}}');
    expect(() => open({ stateFile })).toThrow(/not a version 1 paper account/);
  });

  it('refuses an instrument that is not a USDT-margined linear swap', async () => {
    const { spec } = await import('./helpers.js');
    expect(() => open({ instruments: [spec('BTC-USD-SWAP', { ctType: 'inverse', settleCcy: 'BTC' })] })).toThrow(/USDT-margined linear swaps only/);
  });
});

function paper_setLeverage(paper: ReturnType<typeof open>['paper']): void {
  paper.engine.setLeverage(ETH, 'cross', d(7), undefined);
  paper.save();
}
