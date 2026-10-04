import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { d } from '@pegasus/mock-okx/engine';
import { BTC, FakeHistory, MIN, T0, open, place, quote } from './helpers.js';

const HOUR = 60 * MIN;
/** The settlement after T0. */
const T8 = T0 + 8 * HOUR;
const cash = (paper: ReturnType<typeof open>['paper']): string => d(paper.engine.state().balance.details[0]?.cashBal ?? '0').toFixed();

describe('funding', () => {
  beforeEach(() => {
    vi.useFakeTimers({ now: T0 + HOUR });
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('charges a long the rate on its contracts at the mark price of the settlement time, once', async () => {
    const { paper, history, logs } = open();
    quote(paper, BTC, 60000);
    place(paper, { side: 'buy', ordType: 'market', sz: '10' });
    const before = cash(paper);
    history.fundingRows = [{ fundingTime: T8, rate: '0.0001' }];
    history.marks.set(T8, '61000');

    vi.setSystemTime(T8 - MIN);
    expect(await paper.funding.settle(Date.now())).toBe(0); // not due yet
    vi.setSystemTime(T8 + MIN);
    expect(await paper.funding.settle(Date.now())).toBe(1);
    // 0.1 BTC x 61000 x 0.0001 = 0.61 paid
    expect(d(before).sub(cash(paper)).toFixed()).toBe('0.61');
    expect(paper.funding.state.ledger).toEqual([{ instId: BTC, mgnMode: 'cross', posSide: 'net', fundingTime: T8, rate: '0.0001', pos: '10', markPx: '61000', amount: '-0.61' }]);
    expect(paper.engine.state().positions[0]).toMatchObject({ fundingFee: '-0.61' });
    expect(logs.some((l) => l.includes('-0.6100 USDT'))).toBe(true);
    expect(await paper.funding.settle(Date.now())).toBe(0);
    expect(d(before).sub(cash(paper)).toFixed()).toBe('0.61');
  });

  it('a short receives a positive rate; a negative rate reverses both', async () => {
    const { paper, history } = open();
    quote(paper, BTC, 60000);
    place(paper, { side: 'sell', ordType: 'market', sz: '10' });
    const before = cash(paper);
    history.fundingRows = [{ fundingTime: T8, rate: '0.0001' }, { fundingTime: T8 + 8 * HOUR, rate: '-0.0002' }];
    history.marks.set(T8, '60000');
    history.marks.set(T8 + 8 * HOUR, '60000');
    vi.setSystemTime(T8 + 9 * HOUR);
    expect(await paper.funding.settle(Date.now())).toBe(2);
    expect(paper.funding.state.ledger.map((e) => e.amount)).toEqual(['0.6', '-1.2']);
    expect(d(cash(paper)).sub(before).toFixed()).toBe('-0.6');
  });

  it('uses the size held at the settlement: a position opened after it or closed before it pays nothing', async () => {
    const { paper, history } = open();
    quote(paper, BTC, 60000);
    history.fundingRows = [{ fundingTime: T8, rate: '0.0001' }, { fundingTime: T8 + 8 * HOUR, rate: '0.0001' }, { fundingTime: T8 + 16 * HOUR, rate: '0.0001' }];
    for (const r of history.fundingRows) history.marks.set(r.fundingTime, '60000');

    vi.setSystemTime(T8 + HOUR); // opened an hour after the first settlement
    quote(paper, BTC, 60000);
    place(paper, { side: 'buy', ordType: 'market', sz: '10' });
    vi.setSystemTime(T8 + 9 * HOUR); // 4 of the 10 closed after the second
    quote(paper, BTC, 60000);
    place(paper, { side: 'sell', ordType: 'market', sz: '4', reduceOnly: true });
    vi.setSystemTime(T8 + 15 * HOUR); // the rest closed before the third
    quote(paper, BTC, 60000);
    place(paper, { side: 'sell', ordType: 'market', sz: '6', reduceOnly: true });

    vi.setSystemTime(T8 + 17 * HOUR);
    expect(await paper.funding.settle(Date.now())).toBe(1);
    expect(paper.funding.state.ledger).toMatchObject([{ fundingTime: T8 + 8 * HOUR, pos: '10', amount: '-0.6' }]);
    // nothing is owed before the position existed: the read starts at its opening, not at the account's creation
    expect(history.fundingReads[0]?.after).toBe(T8 + HOUR - 1);
    // a closed position leaves no size history behind
    expect(paper.funding.state.sizeLog).toEqual({});
    expect(paper.funding.state.lastSettled[BTC]).toBe(T8 + 16 * HOUR);
  });

  it('waits for the mark price of the settlement time instead of using another price', async () => {
    const { paper, history, logs } = open();
    quote(paper, BTC, 60000);
    place(paper, { side: 'buy', ordType: 'market', sz: '10' });
    history.fundingRows = [{ fundingTime: T8, rate: '0.0001' }];
    vi.setSystemTime(T8 + MIN);
    expect(await paper.funding.settle(Date.now())).toBe(0);
    expect(paper.funding.state.lastSettled[BTC]).toBeUndefined();
    expect(logs.some((l) => l.includes('mark price could not be read'))).toBe(true);
    history.marks.set(T8, '60000');
    expect(await paper.funding.settle(Date.now())).toBe(1);
  });

  it('settles what fell due while the program was closed, on the position as it was then', async () => {
    const first = open();
    quote(first.paper, BTC, 60000);
    place(first.paper, { side: 'buy', ordType: 'market', sz: '10' });
    const before = cash(first.paper);
    first.paper.close();

    vi.setSystemTime(T8 + 17 * HOUR);
    const { history } = first;
    history.fundingRows = [{ fundingTime: T8, rate: '0.0001' }, { fundingTime: T8 + 8 * HOUR, rate: '0.0003' }, { fundingTime: T8 + 16 * HOUR, rate: '-0.0001' }];
    history.marks.set(T8, '60000');
    history.marks.set(T8 + 8 * HOUR, '62000');
    history.marks.set(T8 + 16 * HOUR, '61000');
    const second = open({ stateFile: first.stateFile, history });
    await second.paper.catchUp();
    expect(second.paper.funding.state.ledger.map((e) => e.amount)).toEqual(['-0.6', '-1.86', '0.61']);
    expect(d(before).sub(cash(second.paper)).toFixed()).toBe('1.85');
    // and it is in the file
    const third = open({ stateFile: first.stateFile, history });
    expect(cash(third.paper)).toBe(cash(second.paper));
    expect(third.paper.funding.state.ledger).toHaveLength(3);
  });

  it('the housekeeping tick settles at one and at six minutes past the hour, once each', async () => {
    const { paper, history } = open();
    quote(paper, BTC, 60000);
    place(paper, { side: 'buy', ordType: 'market', sz: '10' });
    history.fundingRows = [{ fundingTime: T8, rate: '0.0001' }];
    history.marks.set(T8, '60000');
    history.fundingReads.length = 0;

    vi.setSystemTime(T8 + 30_000);
    await paper.tick();
    expect(history.fundingReads).toHaveLength(0); // the first minute: the rate may not be published yet
    vi.setSystemTime(T8 + MIN + 5_000);
    await paper.tick();
    await paper.tick();
    expect(history.fundingReads).toHaveLength(1);
    expect(paper.funding.state.ledger).toHaveLength(1);
    vi.setSystemTime(T8 + 6 * MIN);
    await paper.tick();
    expect(history.fundingReads).toHaveLength(2);
    vi.setSystemTime(T8 + 30 * MIN);
    await paper.tick();
    expect(history.fundingReads).toHaveLength(2);
  });

  it('a failed read is logged and tried again; the account goes on', async () => {
    const { paper, history, logs } = open();
    quote(paper, BTC, 60000);
    place(paper, { side: 'buy', ordType: 'market', sz: '10' });
    history.fail = new Error('Too Many Requests');
    vi.setSystemTime(T8 + MIN + 5_000);
    await paper.tick();
    expect(logs.some((l) => l.includes('funding could not be settled now (Too Many Requests)'))).toBe(true);
    history.fail = null;
    history.fundingRows = [{ fundingTime: T8, rate: '0.0001' }];
    history.marks.set(T8, '60000');
    vi.setSystemTime(T8 + 6 * MIN);
    await paper.tick();
    expect(paper.funding.state.ledger).toHaveLength(1);
  });
});
