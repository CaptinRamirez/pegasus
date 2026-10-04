import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { d } from '@pegasus/mock-okx/engine';
import { BAR_MS, fetchBars, planSegments, type CandlePage } from '../src/index.js';
import { BTC, ETH, FakeHistory, MIN, T0, bar, open, place, quote, stopAt, type Opened } from './helpers.js';

const HOUR = 60 * MIN;

/** Closes the program at `at` with what `prepare` left in the account, and opens it again at `reopenAt` over `history`. */
async function restart(prepare: (o: Opened) => void, history: FakeHistory, reopenAt: number, at = T0 + 30_000): Promise<Opened> {
  vi.setSystemTime(at);
  const first = open();
  quote(first.paper, BTC, 60000);
  prepare(first);
  first.paper.close();
  vi.setSystemTime(reopenAt);
  const second = open({ stateFile: first.stateFile, history });
  await second.paper.catchUp();
  return second;
}

describe('replay of the time the program was closed', () => {
  beforeEach(() => {
    vi.useFakeTimers({ now: T0 });
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('fills a resting limit order at its price in the first bar that traded through it, stamped with the end of that bar', async () => {
    const history = new FakeHistory();
    history.trade = [
      bar(T0, '60000', '60010', '59950', '59960'), // the bar the order was placed in
      bar(T0 + MIN, '59960', '59970', '59900', '59910'), // touches 59900: no fill
      bar(T0 + 2 * MIN, '59910', '59920', '59880', '59890'), // trades through
      bar(T0 + 3 * MIN, '59890', '59990', '59850', '59980'),
    ];
    const { paper, logs } = await restart((o) => void place(o.paper, { side: 'buy', ordType: 'limit', px: '59900', sz: '10', clOrdId: 'entry1' }), history, T0 + 10 * MIN);
    const order = paper.engine.state().orders.find((o) => o.clOrdId === 'entry1');
    expect(order).toMatchObject({ state: 'filled', accFillSz: '10', avgPx: '59900', execType: 'M', fillTime: String(T0 + 3 * MIN), uTime: String(T0 + 3 * MIN) });
    expect(paper.engine.state().positions).toMatchObject([{ instId: BTC, pos: '10', avgPx: '59900', markPx: '59980' }]);
    expect(paper.engine.state().fills).toMatchObject([{ ordId: order?.ordId, fillPx: '59900', fillSz: '10', ts: String(T0 + 3 * MIN) }]);
    expect(logs.some((l) => l.includes('1 resting order(s) filled, 0 stop(s) triggered'))).toBe(true);
    // the clock is the wall clock again
    expect(paper.engine.now()).toBe(T0 + 10 * MIN);
  });

  it('does not fill an order from the bar it was placed in: that low may be older than the order', async () => {
    const history = new FakeHistory();
    history.trade = [bar(T0, '60000', '60010', '59000', '59960'), bar(T0 + MIN, '59960', '59970', '59950', '59960')];
    const { paper } = await restart((o) => void place(o.paper, { side: 'buy', ordType: 'limit', px: '59900', sz: '10', clOrdId: 'entry1' }), history, T0 + 10 * MIN);
    expect(paper.engine.state().orders.find((o) => o.clOrdId === 'entry1')?.state).toBe('live');
  });

  it('triggers a mark stop on the mark price bars and closes at the trigger; a bar that opened beyond it closes at the open', async () => {
    const history = new FakeHistory();
    history.trade = [bar(T0 + MIN, '59500', '59600', '58900', '59100'), bar(T0 + 2 * MIN, '59100', '59200', '59000', '59150')];
    // the traded low went through 59000 in the first bar, the mark did not: the stop waits for the mark
    history.mark = [bar(T0 + MIN, '59500', '59600', '59050', '59100'), bar(T0 + 2 * MIN, '59100', '59200', '59000', '59150')];
    const stopped = await restart((o) => void place(o.paper, { side: 'buy', ordType: 'market', sz: '10', ...stopAt('59000') }), history, T0 + 10 * MIN);
    expect(stopped.paper.engine.state().positions).toEqual([]);
    expect(stopped.paper.engine.state().stops).toEqual([]);
    expect(stopped.paper.engine.state().orders.find((o) => o.side === 'sell')).toMatchObject({ state: 'filled', avgPx: '59000', reduceOnly: 'true', uTime: String(T0 + 3 * MIN) });

    const gap = new FakeHistory();
    gap.trade = [bar(T0 + MIN, '58700', '58800', '58600', '58750')];
    const gapped = await restart((o) => void place(o.paper, { side: 'buy', ordType: 'market', sz: '10', ...stopAt('59000') }), gap, T0 + 10 * MIN);
    expect(gapped.paper.engine.state().orders.find((o) => o.side === 'sell')).toMatchObject({ state: 'filled', avgPx: '58700' });
  });

  it('an entry and its stop in the same bar: filled at the limit, stopped at the trigger', async () => {
    const history = new FakeHistory();
    history.trade = [bar(T0, '60000', '60010', '59990', '60000'), bar(T0 + MIN, '60000', '60010', '58400', '58500')];
    const { paper } = await restart((o) => void place(o.paper, { side: 'buy', ordType: 'limit', px: '59500', sz: '10', clOrdId: 'entry1', ...stopAt('59000') }), history, T0 + 10 * MIN);
    expect(paper.engine.state().orders.find((o) => o.clOrdId === 'entry1')).toMatchObject({ state: 'filled', avgPx: '59500' });
    expect(paper.engine.state().orders.find((o) => o.side === 'sell')).toMatchObject({ state: 'filled', avgPx: '59000' });
    expect(paper.engine.state().positions).toEqual([]);
    // 0.1 BTC x 500 lost, plus the maker fee in and the taker fee out
    const cash = d(paper.engine.state().balance.details[0]?.cashBal ?? '0');
    expect(cash.toFixed()).toBe(d(100000).sub(50).sub(d('59500').mul('0.1').mul('0.0002')).sub(d('59000').mul('0.1').mul('0.0005')).toFixed());
  });

  it('a short stop is mirrored: it triggers on the high and a gap closes at the higher open', async () => {
    const history = new FakeHistory();
    history.trade = [bar(T0 + MIN, '60500', '61200', '60400', '61100')];
    const { paper } = await restart((o) => void place(o.paper, { side: 'sell', ordType: 'market', sz: '10', ...stopAt('61000') }), history, T0 + 10 * MIN);
    expect(paper.engine.state().orders.find((o) => o.side === 'buy')).toMatchObject({ state: 'filled', avgPx: '61000' });
    expect(paper.engine.state().positions).toEqual([]);
  });

  it('reads no history for an instrument that has neither an order nor a stop', async () => {
    const history = new FakeHistory();
    const { paper } = await restart((o) => void place(o.paper, { side: 'buy', ordType: 'market', sz: '10' }), history, T0 + 10 * MIN);
    expect(history.barReads).toEqual([]);
    expect(paper.engine.state().positions).toMatchObject([{ pos: '10' }]);
  });

  it('when the history cannot be read the start fails and the account is as it was', async () => {
    const history = new FakeHistory();
    history.fail = new Error('could not reach OKX (ECONNRESET)');
    vi.setSystemTime(T0 + 30_000);
    const first = open();
    quote(first.paper, BTC, 60000);
    place(first.paper, { side: 'buy', ordType: 'market', sz: '10', ...stopAt('59000') });
    first.paper.close();
    vi.setSystemTime(T0 + 10 * MIN);
    const second = open({ stateFile: first.stateFile, history });
    await expect(second.paper.catchUp()).rejects.toThrow(/could not reach OKX/);
    expect(second.paper.engine.state().stops).toHaveLength(1);
    // the next start replays the same span again
    history.fail = null;
    history.trade = [bar(T0 + MIN, '59500', '59600', '58900', '59100')];
    const third = open({ stateFile: first.stateFile, history });
    await third.paper.catchUp();
    expect(third.paper.engine.state().positions).toEqual([]);
  });

  it('a long outage of the feed is replayed before orders are matched again; other instruments go on', async () => {
    const history = new FakeHistory();
    const { paper } = open({ history });
    quote(paper, BTC, 60000);
    quote(paper, ETH, 3000);
    place(paper, { side: 'buy', ordType: 'market', sz: '10', ...stopAt('59000') });
    paper.onFeedDown();
    // five minutes later: the mark went through the stop and came back
    vi.setSystemTime(T0 + 5 * MIN);
    history.trade = [bar(T0 + 2 * MIN, '59500', '59600', '58900', '59800')];
    quote(paper, BTC, 59800);
    quote(paper, ETH, 3000);
    await vi.advanceTimersByTimeAsync(0);
    expect(history.barReads.map((r) => r.instId)).toEqual([BTC, BTC]); // ETH has nothing a price could change
    expect(paper.engine.state().positions).toEqual([]);
    expect(paper.engine.state().orders.find((o) => o.side === 'sell')).toMatchObject({ avgPx: '59000', uTime: String(T0 + 3 * MIN) });
    expect(paper.markets.get(BTC)?.live).toBe(true);
  });
});

describe('fetchBars', () => {
  const rows = (from: number, count: number, barMs: number): string[][] =>
    Array.from({ length: count }, (_, i) => [String(from + i * barMs), '100', '110', '90', '105', '1']).reverse();

  it('takes the recent bars first and pages the history backwards until the start is covered', async () => {
    const all = rows(T0, 250, MIN); // newest first
    const calls: Array<number | undefined> = [];
    const recent: CandlePage = async ({ limit }) => all.slice(0, limit);
    const history: CandlePage = async ({ after, limit }) => {
      calls.push(after);
      return all.filter((r) => Number(r[0]) < (after ?? Infinity)).slice(0, limit);
    };
    const bars = await fetchBars(recent, history, MIN, T0 + 30 * MIN + 5_000, T0 + 249 * MIN, { recentLimit: 100, historyLimit: 100 });
    expect(bars[0]?.ts).toBe(T0 + 30 * MIN); // the bar that contains `from`
    expect(bars[bars.length - 1]?.ts).toBe(T0 + 249 * MIN);
    expect(bars).toHaveLength(220);
    expect(calls).toEqual([T0 + 150 * MIN, T0 + 50 * MIN]);
    expect(bars[0]).toMatchObject({ open: d(100), high: d(110), low: d(90), close: d(105) });
  });

  it('stops when the exchange has nothing older', async () => {
    const all = rows(T0 + 100 * MIN, 20, MIN);
    const history: CandlePage = async () => [];
    const bars = await fetchBars(async ({ limit }) => all.slice(0, limit), history, MIN, T0, T0 + 200 * MIN, { recentLimit: 100, historyLimit: 100 });
    expect(bars).toHaveLength(20);
  });
});

describe('planSegments', () => {
  it('replays up to 50 hours with one-minute bars', () => {
    expect(planSegments(T0, T0 + 12 * HOUR)).toEqual([{ bar: '1m', from: T0, to: T0 + 12 * HOUR }]);
    expect(planSegments(T0, T0)).toEqual([]);
  });

  it('a longer span keeps one-minute bars up to the next full hour and takes the smallest size that fits for the rest', () => {
    const from = T0 + 17 * MIN;
    expect(planSegments(from, T0 + 7 * 24 * HOUR)).toEqual([
      { bar: '1m', from, to: T0 + HOUR - 1 },
      { bar: '5m', from: T0 + HOUR, to: T0 + 7 * 24 * HOUR },
    ]);
    expect(planSegments(T0, T0 + 20 * 24 * HOUR).map((s) => s.bar)).toEqual(['15m']);
    expect(planSegments(T0, T0 + 90 * 24 * HOUR).map((s) => s.bar)).toEqual(['1H']);
    expect(BAR_MS['1H']).toBe(HOUR);
  });
});
