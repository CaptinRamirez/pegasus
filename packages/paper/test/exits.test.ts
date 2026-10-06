import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { BTC, FakeHistory, MIN, T0, bar, open, place, quote, type Opened } from './helpers.js';

const tp = (tpTriggerPx: string, sz: string) => ({ tpTriggerPx, tpOrdPx: '-1', tpTriggerPxType: 'mark', sz });
const costSl = (slTriggerPx: string) => ({ slTriggerPx, slOrdPx: '-1', slTriggerPxType: 'mark', amendPxOnTriggerType: '1' });
/** Market buy of 10 contracts (0.1 BTC) with take-profits at 60500 (4) and 61000 (6) and a cost-price stop at 59000. */
const splitEntry = { side: 'buy', ordType: 'market', sz: '10', attachAlgoOrds: [tp('60500', '4'), tp('61000', '6'), costSl('59000')] };

function trailing(o: Opened, body: Record<string, unknown>): string {
  const ack = o.paper.engine.matcher.placeAlgoRequest({ instId: BTC, tdMode: 'cross', side: 'sell', ordType: 'move_order_stop', reduceOnly: true, ...body });
  expect(ack.sCode).toBe('0');
  return ack.algoId;
}

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

const position = (o: Opened): string => o.paper.engine.state().positions.find((p) => p.instId === BTC)?.pos ?? '0';
/** The closing sells, oldest first, as [size, average price]. */
const closes = (o: Opened) =>
  o.paper.engine
    .state()
    .orders.filter((x) => x.side === 'sell' && x.state === 'filled')
    .sort((a, b) => (a.ordId < b.ordId ? -1 : 1))
    .map((x) => [x.sz, x.avgPx]);

describe('exits on live quotes', () => {
  beforeEach(() => {
    vi.useFakeTimers({ now: T0 });
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('split take-profits close their legs on the mark; the first moves the cost-price stop to the fill price', () => {
    const o = open();
    quote(o.paper, BTC, 60000);
    expect(place(o.paper, splitEntry).sCode).toBe('0');
    const avgPx = o.paper.engine.state().orders.find((x) => x.side === 'buy')?.avgPx ?? '';
    expect(avgPx).toBe('60000.1');
    expect(o.paper.engine.state().stops.map((s) => [s.sz, s.tpTriggerPx ?? '', s.slTriggerPx])).toEqual([['4', '60500', ''], ['6', '61000', ''], ['10', '', '59000']]);
    quote(o.paper, BTC, 60500);
    expect(position(o)).toBe('6');
    expect(o.paper.engine.state().stops.map((s) => [s.sz, s.tpTriggerPx ?? '', s.slTriggerPx])).toEqual([['6', '61000', ''], ['10', '', avgPx]]);
    quote(o.paper, BTC, 60000);
    expect(position(o)).toBe('0');
    expect(o.paper.engine.state().stops).toEqual([]);
  });

  it('a trailing stop follows the last price, not the mark, and keeps its extreme across a restart', () => {
    const o = open();
    quote(o.paper, BTC, 60000);
    place(o.paper, { side: 'buy', ordType: 'market', sz: '10' });
    trailing(o, { sz: '10', callbackRatio: '0.01' });
    o.paper.onLast(BTC, '61000');
    // the mark alone moves nothing
    o.paper.onMark(BTC, '59000');
    expect(position(o)).toBe('10');
    expect(o.paper.engine.state().stops).toMatchObject([{ moveTriggerPx: '60390' }]);
    o.paper.close();

    const again = open({ stateFile: o.stateFile });
    expect(again.paper.engine.state().stops).toMatchObject([{ ordType: 'move_order_stop', callbackRatio: '0.01', moveTriggerPx: '60390' }]);
    quote(again.paper, BTC, 60500);
    expect(position(again)).toBe('10');
    quote(again.paper, BTC, 60390);
    expect(position(again)).toBe('0');
  });
});

describe('exits in the replay of the time the program was closed', () => {
  beforeEach(() => {
    vi.useFakeTimers({ now: T0 });
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('a take-profit closes at its trigger, or at the open of a bar that gapped beyond it; nearest first', async () => {
    const history = new FakeHistory();
    history.trade = [bar(T0 + MIN, '60100', '60600', '60050', '60550'), bar(T0 + 2 * MIN, '61200', '61300', '61100', '61250')];
    const o = await restart((x) => void place(x.paper, splitEntry), history, T0 + 10 * MIN);
    expect(closes(o)).toEqual([['4', '60500'], ['6', '61200']]);
    expect(position(o)).toBe('0');
    expect(o.paper.engine.state().stops).toEqual([]);
  });

  it('the cost-price stop moved by a take-profit is tested against the close of that bar only', async () => {
    // the bar reaches the first take-profit and closes below the entry: the moved stop closes the rest at the entry
    const history = new FakeHistory();
    history.trade = [bar(T0 + MIN, '60100', '60600', '59800', '59900')];
    const o = await restart((x) => void place(x.paper, splitEntry), history, T0 + 10 * MIN);
    expect(closes(o)).toEqual([['4', '60500'], ['6', '60000.1']]);
    expect(position(o)).toBe('0');

    // a close above the entry keeps it: the low of the bar may have come before the take-profit
    const above = new FakeHistory();
    above.trade = [bar(T0 + MIN, '60100', '60600', '59800', '60200')];
    const kept = await restart((x) => void place(x.paper, splitEntry), above, T0 + 10 * MIN);
    expect(position(kept)).toBe('6');
    expect(kept.paper.engine.state().stops.map((s) => s.slTriggerPx)).toEqual(['', '60000.1']);
  });

  it('a bar that reached both legs of an oco order stopped it: the loss is taken first', async () => {
    const history = new FakeHistory();
    history.trade = [bar(T0 + MIN, '60000', '61500', '58500', '60000')];
    const oco = { side: 'buy', ordType: 'market', sz: '10', attachAlgoOrds: [{ tpTriggerPx: '61000', tpOrdPx: '-1', tpTriggerPxType: 'mark', slTriggerPx: '59000', slOrdPx: '-1', slTriggerPxType: 'mark' }] };
    const o = await restart((x) => void place(x.paper, oco), history, T0 + 10 * MIN);
    expect(closes(o)).toEqual([['10', '59000']]);
    expect(o.paper.engine.state().stops).toEqual([]);
  });

  it('a trailing stop: the trigger it had at the open first, then the new extreme against the close', async () => {
    // bar 1: a new high of 61000 and a close above 61000 x 0.99; bar 2 opens above 60390 and its low reaches it
    const history = new FakeHistory();
    history.trade = [bar(T0 + MIN, '60000', '61000', '59950', '60900'), bar(T0 + 2 * MIN, '60800', '60850', '60300', '60400')];
    const o = await restart((x) => {
      place(x.paper, { side: 'buy', ordType: 'market', sz: '10' });
      trailing(x, { sz: '10', callbackRatio: '0.01' });
    }, history, T0 + 10 * MIN);
    expect(closes(o)).toEqual([['10', '60390']]);

    // the close of the bar that made the new high is already below the trigger that high gives
    const fell = new FakeHistory();
    fell.trade = [bar(T0 + MIN, '60000', '61000', '59950', '60300')];
    const p = await restart((x) => {
      place(x.paper, { side: 'buy', ordType: 'market', sz: '10' });
      trailing(x, { sz: '10', callbackRatio: '0.01' });
    }, fell, T0 + 10 * MIN);
    expect(closes(p)).toEqual([['10', '60390']]);

    // a bar that opened below the trigger it had: a gap, closed at the open
    const gap = new FakeHistory();
    gap.trade = [bar(T0 + MIN, '59000', '59100', '58900', '59050')];
    const q = await restart((x) => {
      place(x.paper, { side: 'buy', ordType: 'market', sz: '10' });
      trailing(x, { sz: '10', callbackRatio: '0.01' });
    }, gap, T0 + 10 * MIN);
    expect(closes(q)).toEqual([['10', '59000']]);
  });

  it('a trailing stop with an activation price starts at it when a bar reaches it, tested against the close only', async () => {
    const history = new FakeHistory();
    // bar 1 reaches 61000 and closes at 60500, above 61000 x 0.99; bar 2 trades down through 60390
    history.trade = [bar(T0 + MIN, '60000', '61000', '59000', '60500'), bar(T0 + 2 * MIN, '60500', '60600', '60000', '60100')];
    const o = await restart((x) => {
      place(x.paper, { side: 'buy', ordType: 'market', sz: '10' });
      trailing(x, { sz: '10', callbackRatio: '0.01', activePx: '61000' });
    }, history, T0 + 10 * MIN);
    // the low of 59000 in bar 1 came before or after the activation: not taken as a trigger
    expect(closes(o)).toEqual([['10', '60390']]);
  });

  it('take-profits generated by an entry that filled in a bar are not tested in that bar', async () => {
    const history = new FakeHistory();
    // the limit entry fills in bar 2 (traded through 59900); the same bar's high is above the first take-profit
    history.trade = [bar(T0, '60000', '60010', '59990', '60000'), bar(T0 + MIN, '60000', '60700', '59800', '60100'), bar(T0 + 2 * MIN, '60100', '60200', '60050', '60150')];
    const entry = { side: 'buy', ordType: 'limit', px: '59900', sz: '10', attachAlgoOrds: [tp('60500', '4'), tp('61000', '6'), { slTriggerPx: '59000', slOrdPx: '-1', slTriggerPxType: 'mark' }] };
    const o = await restart((x) => void place(x.paper, entry), history, T0 + 10 * MIN);
    expect(o.paper.engine.state().orders.find((x) => x.side === 'buy')).toMatchObject({ state: 'filled', avgPx: '59900' });
    expect(position(o)).toBe('10');
    expect(o.paper.engine.state().stops).toHaveLength(3);
    expect(o.logs.some((l) => l.includes('1 resting order(s) filled, 0 stop(s) triggered, 0 position(s) liquidated, 0 take-profit(s) triggered'))).toBe(true);
  });
});
