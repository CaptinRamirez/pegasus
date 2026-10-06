/** The trade journal's bookkeeping (services/journal-book.ts): trades assembled from fills, their sources, exits and figures. */
import { describe, expect, it } from 'vitest';
import { D, type AlgoOrder, type Fill, type Instrument, type JournalTrade, type Order, type PlaceOrderRequest, type Position } from '@pegasus/shared';
import { JournalBook, journalFillKey, lastOpeningOf, type OrderFacts } from '../src/services/journal-book.js';
import { emptyJournal } from '../src/services/journal-file.js';

const BTC: Instrument = {
  instId: 'BTC-USDT-SWAP',
  instType: 'SWAP',
  uly: 'BTC-USDT',
  baseCcy: 'BTC',
  quoteCcy: 'USDT',
  settleCcy: 'USDT',
  ctVal: '0.01',
  ctValCcy: 'BTC',
  ctMult: '1',
  ctType: 'linear',
  lotSz: '0.01',
  minSz: '0.01',
  tickSz: '0.1',
  maxLmtSz: '10000',
  maxMktSz: '5000',
  maxLever: '100',
  state: 'live',
};

let clock = 1_000_000;
const book = (): JournalBook => new JournalBook(emptyJournal(), { specOf: () => BTC, now: () => clock });

let tradeSeq = 1;
function fill(f: Partial<Fill> & Pick<Fill, 'ordId' | 'side' | 'fillPx' | 'fillSz'>): Fill {
  return { tradeId: String(tradeSeq++), clOrdId: '', instId: 'BTC-USDT-SWAP', posSide: 'net', fee: '-0.1', feeCcy: 'USDT', execType: 'T', ts: clock, ...f };
}
const facts = (ordId: string, more: Partial<OrderFacts> = {}): OrderFacts => ({ ordId, clOrdId: '', tdMode: 'isolated', reduceOnly: false, lever: '5', ...more });

function order(o: Partial<Order> & Pick<Order, 'ordId' | 'clOrdId' | 'side'>): Order {
  return { instId: 'BTC-USDT-SWAP', posSide: 'net', tdMode: 'isolated', ordType: 'market', px: '', sz: '2', accFillSz: '0', avgPx: '', state: 'live', reduceOnly: false, lever: '5', fee: '0', feeCcy: 'USDT', pnl: '0', cTime: clock, uTime: clock, ...o };
}

const request = (more: Partial<PlaceOrderRequest> = {}): PlaceOrderRequest => ({ instId: 'BTC-USDT-SWAP', side: 'buy', ordType: 'market', tdMode: 'isolated', size: { unit: 'contracts', value: '2' }, ...more });

function algo(a: Partial<AlgoOrder> & Pick<AlgoOrder, 'algoId'>): AlgoOrder {
  return { algoClOrdId: '', instId: 'BTC-USDT-SWAP', side: 'sell', posSide: 'net', tdMode: 'isolated', sz: '', closeFraction: '1', slTriggerPx: '', slTriggerPxType: '', slOrdPx: '-1', tpTriggerPx: '', cTime: clock, uTime: clock, ...a };
}

const position = (pos: string, more: Partial<Position> = {}): Position => ({ instId: 'BTC-USDT-SWAP', posSide: 'net', mgnMode: 'isolated', pos, avgPx: '60000', markPx: '60000', upl: '0', uplRatio: '0', lever: '5', liqPx: '', margin: '240', notionalUsd: '1200', cTime: clock - 60_000, uTime: clock - 60_000, ...more });

const only = (b: JournalBook): JournalTrade => {
  const [summary] = b.list({}, undefined, 10).trades;
  if (!summary) throw new Error('no trade');
  const trade = b.find(summary.id)?.trade;
  if (!trade) throw new Error('no trade');
  return trade;
};

describe('the trade journal book', () => {
  it('assembles a trade from its fills: the plan of its order, the entry, the close, P&L, fees and R', () => {
    const b = book();
    const req = request({ source: 'signal', slTriggerPx: '57000', trailing: { kind: 'channel', bars: 10 }, signal: { rule: 'campaign', kind: 'entry', barTs: 1, close: '59900', entryLevel: '59000', exitLevel: '57000' } });
    b.placed(req, order({ ordId: 'o1', clOrdId: 'pgwab12cd34', side: 'buy', slTriggerPx: '57000' }));
    clock += 100;
    // the order fills in two parts
    b.fill(fill({ ordId: 'o1', clOrdId: 'pgwab12cd34', side: 'buy', fillPx: '60000', fillSz: '1', fee: '-0.3' }), facts('o1', { clOrdId: 'pgwab12cd34' }));
    b.fill(fill({ ordId: 'o1', clOrdId: 'pgwab12cd34', side: 'buy', fillPx: '60100', fillSz: '1', fee: '-0.3' }), facts('o1', { clOrdId: 'pgwab12cd34' }));
    let t = only(b);
    expect(t).toMatchObject({ id: '1-BTC-USDT-SWAP', status: 'open', source: 'signal', direction: 'long', mgnMode: 'isolated', size: '2', initialStop: '57000' });
    expect(t.entry).toMatchObject({ avgPx: '60050', contracts: '2', coin: '0.02', notional: '1201', maxContracts: '2', leverage: '5' });
    expect(t.plan).toEqual({ slTriggerPx: '57000', takeProfits: [], breakevenAfterTp1: false, trailing: { kind: 'channel', bars: 10 }, signal: req.signal });
    // 1 R: 0.02 BTC from 60050 to 57000
    expect(t.initialRisk).toBe('61');
    // the margin the exchange reports while the position holds only its opening order: the leverage it runs at
    b.positions([position('2', { margin: '300.25' })]);
    expect(only(b).entry).toMatchObject({ margin: '300.25', leverage: '4' });

    // closed by a market order of the terminal
    clock += 3_600_000;
    b.fill(fill({ ordId: 'o2', clOrdId: 'pg1abc', side: 'sell', fillPx: '63050', fillSz: '2', fee: '-0.6' }), facts('o2', { clOrdId: 'pg1abc', reduceOnly: true }));
    t = only(b);
    expect(t).toMatchObject({ status: 'closed', size: '0', closeReason: 'manual', realisedPnl: '60', fees: '1.2', netPnl: '58.8', exitPx: '63050', durationMs: 3_600_000 });
    expect(D(t.rMultiple ?? '0').toFixed(4)).toBe('0.9639');
    expect(t.exits).toEqual([{ ts: clock, reason: 'manual', leg: null, ordId: 'o2', clOrdId: 'pg1abc', algoId: null, px: '63050', contracts: '2', coin: '0.02', pnl: '60', fee: '0.6' }]);
    expect(t.fills.map((f) => f.role)).toEqual(['open', 'open', 'close']);
    // the order's placement comes first in the timeline, with its plan
    expect(t.timeline.map((e) => e.kind)).toEqual(['order_placed', 'fill', 'fill', 'fill']);
    expect(t.timeline[0]?.plan?.trailing).toEqual({ kind: 'channel', bars: 10 });
    expect(t.timeline[3]?.reason).toBe('manual');
  });

  it('adds and partial closes: the entry average of all the opening fills, the P&L against the running average', () => {
    const b = book();
    b.fill(fill({ ordId: 'a', side: 'buy', fillPx: '100', fillSz: '2', fee: '0' }), facts('a'));
    clock += 10;
    b.fill(fill({ ordId: 'b', side: 'sell', fillPx: '110', fillSz: '1', fee: '0' }), facts('b', { reduceOnly: true }));
    clock += 10;
    const addTs = clock;
    b.fill(fill({ ordId: 'c', side: 'buy', fillPx: '120', fillSz: '1', fee: '0' }), facts('c'));
    let t = only(b);
    expect(t.size).toBe('2');
    // the entry: (2 x 100 + 1 x 120) / 3; the position after the add: (1 x 100 + 1 x 120) / 2 = 110
    expect(t.entry.avgPx).toBe('106.666666666667');
    expect(t.entry.contracts).toBe('3');
    expect(t.realisedPnl).toBe('0.1');
    clock += 10;
    b.fill(fill({ ordId: 'd', side: 'sell', fillPx: '130', fillSz: '2', fee: '0' }), facts('d', { reduceOnly: true }));
    t = only(b);
    // 2 contracts x 0.01 x (130 - 110)
    expect(t.realisedPnl).toBe('0.5');
    expect(t.fills.map((f) => [f.role, f.posAfter])).toEqual([['open', '2'], ['reduce', '1'], ['add', '2'], ['close', '0']]);
    expect(t.exits.map((e) => [e.ordId, e.contracts, e.pnl])).toEqual([['b', '1', '0.1'], ['d', '2', '0.4']]);
    expect(t.entry.maxContracts).toBe('2');
    // the exits' average: (1 x 110 + 2 x 130) / 3
    expect(t.exitPx).toBe('123.333333333333');
    // the add reference of the campaign signals: the last opening order
    const rec = b.find(t.id);
    expect(rec && lastOpeningOf(rec, BTC)).toEqual({ px: '120', ts: addTs });
  });

  it('a liquidation closes the trade, and the same fill read again from the list of fills is not counted twice', () => {
    const b = book();
    b.fill(fill({ ordId: 'o1', side: 'buy', fillPx: '60000', fillSz: '1', fee: '-0.3' }), facts('o1', { lever: '50' }));
    clock += 60_000;
    const push = fill({ ordId: 'liq1', tradeId: '0', side: 'sell', fillPx: '58900', fillSz: '1', fee: '-0.29', execType: '' });
    b.fill(push, facts('liq1', { category: 'full_liquidation', reduceOnly: true }));
    const t = only(b);
    expect(t).toMatchObject({ status: 'closed', closeReason: 'liquidation', realisedPnl: '-11', fees: '0.59' });
    expect(t.timeline.find((e) => e.kind === 'liquidation')).toMatchObject({ ordId: 'liq1', px: '58900', contracts: '1', pnl: '-11' });
    // the exchange's list carries the same fill with a negative trade id
    expect(journalFillKey({ ...push, tradeId: '-1800000000000000001' })).toBe(journalFillKey(push));
    expect(b.fill({ ...push, tradeId: '-1800000000000000001' }, facts('liq1', { category: 'full_liquidation', reduceOnly: true }))).toBe(false);
    expect(b.list({}, undefined, 10).total).toBe(1);
  });

  it('tells where a trade comes from', () => {
    const b = book();
    // the campaign's own: no plan
    b.fill(fill({ ordId: 'c1', clOrdId: 'pcabc123', side: 'buy', fillPx: '100', fillSz: '1' }), facts('c1', { clOrdId: 'pcabc123' }));
    // a signal order whose request was not seen (placed before a restart)
    b.fill(fill({ ordId: 's1', clOrdId: 'psabc123', instId: 'BTC-USDT-SWAP', posSide: 'long', side: 'buy', fillPx: '100', fillSz: '1' }), facts('s1', { clOrdId: 'psabc123', tdMode: 'cross' }));
    // the terminal's own
    b.fill(fill({ ordId: 'm1', clOrdId: 'pgwabc123', posSide: 'net', side: 'sell', fillPx: '100', fillSz: '1' }), facts('m1', { clOrdId: 'pgwabc123', tdMode: 'cross' }));
    // anything else
    b.fill(fill({ ordId: 'e1', clOrdId: 'myBot42', posSide: 'short', side: 'sell', fillPx: '100', fillSz: '1' }), facts('e1', { clOrdId: 'myBot42' }));
    const sources = b.list({}, undefined, 10).trades.map((t) => [t.seq, t.source, t.plan === null]);
    expect(sources).toEqual([
      [4, 'external', true],
      [3, 'manual', true],
      [2, 'signal', true],
      [1, 'campaign', true],
    ]);
    // a request seen after its fill: the plan and the source are the request's
    b.placed(request({ source: 'manual', slTriggerPx: '90', side: 'sell' }), order({ ordId: 'm1', clOrdId: 'pgwabc123', side: 'sell', tdMode: 'cross', slTriggerPx: '110' }));
    const m = b.find('3-BTC-USDT-SWAP')?.trade;
    expect(m?.plan?.slTriggerPx).toBe('110');
    expect(m?.timeline[0]?.kind).toBe('order_placed');
    // the campaign's request never carries a plan
    b.placed(request({ source: 'signal' }), order({ ordId: 'c1', clOrdId: 'pcabc123', side: 'buy' }));
    expect(b.find('1-BTC-USDT-SWAP')?.trade).toMatchObject({ source: 'campaign', plan: null });
    // filters
    expect(b.list({ source: 'signal' }, undefined, 10).trades.map((t) => t.seq)).toEqual([2]);
    expect(b.list({ status: 'closed' }, undefined, 10).total).toBe(0);
  });

  it('exits by algo orders: the stop, a take-profit leg, a trailing stop, and a close that matches none', () => {
    const b = book();
    const req = request({ slTriggerPx: '57000', takeProfits: [{ triggerPx: '63000', fraction: '0.5' }, { triggerPx: '66000', fraction: '0.5' }] });
    b.placed(req, order({ ordId: 'o1', clOrdId: 'pgwxyz98765432', side: 'buy', sz: '4', slTriggerPx: '57000' }));
    b.fill(fill({ ordId: 'o1', clOrdId: 'pgwxyz98765432', side: 'buy', fillPx: '60000', fillSz: '4' }), facts('o1', { clOrdId: 'pgwxyz98765432' }));
    clock += 1_000;
    // the exchange created the attached stop and the two take-profits
    b.algoOrders([algo({ algoId: 'sl1', algoClOrdId: 'slxyz98765432', slTriggerPx: '57000', slTriggerPxType: 'mark' }), algo({ algoId: 'tp1', algoClOrdId: 'tp1xyz98765432', tpTriggerPx: '63000', sz: '2' }), algo({ algoId: 'tp2', algoClOrdId: 'tp2xyz98765432', tpTriggerPx: '66000', sz: '2' })], clock);
    let t = only(b);
    expect(t.timeline.filter((e) => e.kind.endsWith('_placed') && e.kind !== 'order_placed').map((e) => [e.kind, e.algoId, e.leg ?? null])).toEqual([
      ['stop_placed', 'sl1', null],
      ['tp_placed', 'tp1', 1],
      ['tp_placed', 'tp2', 2],
    ]);
    // take-profit 1 fills a little below its trigger (slippage of the market order)
    clock += 60_000;
    b.fill(fill({ ordId: 'x1', side: 'sell', fillPx: '62950', fillSz: '2' }), facts('x1', { reduceOnly: true }));
    t = only(b);
    expect(t.exits[0]).toMatchObject({ reason: 'take_profit', leg: 1, algoId: 'tp1' });
    // the cost-price stop: moved to the entry
    clock += 1_000;
    b.algoOrders([algo({ algoId: 'sl1', algoClOrdId: 'slxyz98765432', slTriggerPx: '60000', slTriggerPxType: 'mark', uTime: clock }), algo({ algoId: 'tp2', tpTriggerPx: '66000', sz: '2' })], clock);
    t = only(b);
    expect(t.timeline.filter((e) => e.kind === 'tp_triggered' || e.kind === 'stop_moved').map((e) => [e.kind, e.fromPx ?? null, e.px])).toEqual([
      ['tp_triggered', null, '63000'],
      ['stop_moved', '57000', '60000'],
    ]);
    // the stop fires below its trigger: the rest is closed
    clock += 60_000;
    b.fill(fill({ ordId: 'x2', side: 'sell', fillPx: '59800', fillSz: '2' }), facts('x2', { reduceOnly: true }));
    t = only(b);
    expect(t).toMatchObject({ status: 'closed', closeReason: 'stop' });
    expect(t.exits[1]).toMatchObject({ reason: 'stop', leg: null, algoId: 'sl1' });
    // the next read: the stop is gone (it triggered), the second take-profit was cancelled with the position
    clock += 1_000;
    b.algoOrders([], clock);
    t = only(b);
    expect(t.timeline.filter((e) => e.algoId !== undefined).map((e) => e.kind)).toEqual(['stop_placed', 'tp_placed', 'tp_placed', 'tp_triggered', 'stop_moved', 'stop_triggered', 'tp_cancelled']);
    expect(t.timeline.find((e) => e.kind === 'tp_cancelled')).toMatchObject({ algoId: 'tp2', leg: 2, code: 'POSITION_CLOSED' });
    // R: the initial stop was the plan's
    expect(t.initialStop).toBe('57000');
  });

  it('a channel trailing exit: the stop counts as trailing once it was moved; a close that matches no algo order is external', () => {
    const b = book();
    b.placed(request({ slTriggerPx: '57000', trailing: { kind: 'channel', bars: 10 } }), order({ ordId: 'o1', clOrdId: 'pgwtrail0001', side: 'buy', slTriggerPx: '57000' }));
    b.fill(fill({ ordId: 'o1', clOrdId: 'pgwtrail0001', side: 'buy', fillPx: '60000', fillSz: '2' }), facts('o1', { clOrdId: 'pgwtrail0001' }));
    b.algoOrders([algo({ algoId: 'sl1', algoClOrdId: 'sltrail0001', slTriggerPx: '57000' })], clock);
    clock += 86_400_000;
    b.algoOrders([algo({ algoId: 'sl1', algoClOrdId: 'sltrail0001', slTriggerPx: '58500', uTime: clock })], clock);
    expect(only(b).timeline.filter((e) => e.algoId === 'sl1').map((e) => e.kind)).toEqual(['stop_placed', 'trailing_moved']);
    clock += 1_000;
    b.fill(fill({ ordId: 'x1', side: 'sell', fillPx: '58400', fillSz: '2' }), facts('x1', { reduceOnly: true }));
    expect(only(b)).toMatchObject({ closeReason: 'trailing' });
    expect(only(b).timeline.some((e) => e.kind === 'trailing_triggered')).toBe(true);

    // another trade, closed by an order of another program at a price no algo order is near
    const c = book();
    c.fill(fill({ ordId: 'p1', side: 'buy', fillPx: '60000', fillSz: '1' }), facts('p1'));
    c.algoOrders([algo({ algoId: 's9', slTriggerPx: '50000' })], clock);
    c.fill(fill({ ordId: 'p2', clOrdId: 'otherBot1', side: 'sell', fillPx: '61000', fillSz: '1' }), facts('p2', { clOrdId: 'otherBot1', reduceOnly: true }));
    expect(only(c)).toMatchObject({ closeReason: 'external' });
    // the stop was the first one listed before any of the position was closed: the initial stop
    expect(only(c).initialStop).toBe('50000');
  });

  it('a stop matches a fill a little beyond its trigger; a close by hand that cancels a take-profit stays external', () => {
    const b = book();
    b.fill(fill({ ordId: 'o1', side: 'buy', fillPx: '60000', fillSz: '1' }), facts('o1'));
    b.algoOrders([algo({ algoId: 'sl1', slTriggerPx: '59000' })], clock);
    // the market order of the stop filled above its trigger (the stop triggers on the mark), within the tolerance
    clock += 1_000;
    b.fill(fill({ ordId: 'x1', side: 'sell', fillPx: '59480', fillSz: '1' }), facts('x1', { reduceOnly: true }));
    expect(only(b).closeReason).toBe('stop');
    // a close from OKX's app at a price no algo order is near; the take-profit goes with the position
    const c = book();
    c.fill(fill({ ordId: 'o1', side: 'buy', fillPx: '60000', fillSz: '1' }), facts('o1'));
    c.algoOrders([algo({ algoId: 'tpX', tpTriggerPx: '70000' })], clock);
    c.fill(fill({ ordId: 'x1', side: 'sell', fillPx: '64000', fillSz: '1' }), facts('x1', { reduceOnly: true }));
    c.algoOrders([], clock + 1_000);
    expect(only(c).closeReason).toBe('external');
    expect(only(c).timeline.find((e) => e.algoId === 'tpX' && e.kind === 'tp_cancelled')).toMatchObject({ leg: 1, code: 'POSITION_CLOSED' });
    // the stop list read before the fill came: an algo order that ended a moment ago still matches it
    const d = book();
    d.fill(fill({ ordId: 'o1', side: 'buy', fillPx: '60000', fillSz: '1' }), facts('o1'));
    d.algoOrders([algo({ algoId: 'sl2', slTriggerPx: '59000' })], clock);
    d.algoOrders([], clock + 500);
    expect(only(d).timeline.some((e) => e.kind === 'stop_cancelled')).toBe(true);
    d.fill(fill({ ordId: 'x2', side: 'sell', fillPx: '58950', fillSz: '1' }), facts('x2', { reduceOnly: true }));
    expect(only(d).closeReason).toBe('stop');
    expect(only(d).timeline.filter((e) => e.algoId === 'sl2').map((e) => e.kind)).toEqual(['stop_placed', 'stop_triggered']);
  });

  it("the client ids of Pegasus's algo orders: a channel trailing stop switched on later, a take-profit's leg", () => {
    const b = book();
    // opened without a plan for trailing; channel trailing was switched on for the open position afterwards
    b.fill(fill({ ordId: 'o1', clOrdId: 'pgwlater0001', side: 'buy', fillPx: '60000', fillSz: '4' }), facts('o1', { clOrdId: 'pgwlater0001' }));
    b.algoOrders([algo({ algoId: 'ch1', algoClOrdId: 'chpgmuvq1ab2c3d4', slTriggerPx: '57500' }), algo({ algoId: 't2', algoClOrdId: 'tp2later0001', tpTriggerPx: '61000', sz: '2' })], clock);
    let t = only(b);
    expect(t.timeline.filter((e) => e.algoId !== undefined).map((e) => [e.kind, e.leg ?? null])).toEqual([
      ['trailing_placed', null],
      ['tp_placed', 2],
    ]);
    clock += 86_400_000;
    b.algoOrders([algo({ algoId: 'ch1', algoClOrdId: 'chpgmuvq1ab2c3d4', slTriggerPx: '58800', uTime: clock }), algo({ algoId: 't2', algoClOrdId: 'tp2later0001', tpTriggerPx: '61000', sz: '2' })], clock);
    b.fill(fill({ ordId: 'x1', side: 'sell', fillPx: '58750', fillSz: '4' }), facts('x1', { reduceOnly: true }));
    t = only(b);
    expect(t.closeReason).toBe('trailing');
    expect(t.timeline.filter((e) => e.algoId === 'ch1').map((e) => e.kind)).toEqual(['trailing_placed', 'trailing_moved', 'trailing_triggered']);
  });

  it('a stop triggers on the mark: a fill away from the trigger is the stop when the mark at the fill reached it', () => {
    const b = book();
    b.fill(fill({ ordId: 'o1', side: 'buy', fillPx: '60000', fillSz: '1' }), facts('o1'));
    b.algoOrders([algo({ algoId: 'sl1', slTriggerPx: '57000', slTriggerPxType: 'mark' })], clock);
    const close = fill({ ordId: 'x1', side: 'sell', fillPx: '59000', fillSz: '1' });
    // a close the fill does not explain: its mark price is what tells
    expect(b.closesUnexplained(close, facts('x1', { reduceOnly: true }))).toBe(true);
    expect(b.closesUnexplained({ ...close, clOrdId: 'pgw1' }, facts('x1', { clOrdId: 'pgw1', reduceOnly: true }))).toBe(false);
    b.fill(close, facts('x1', { reduceOnly: true }), '56990');
    expect(only(b)).toMatchObject({ closeReason: 'stop' });
    // without the mark the same fill is external
    const c = book();
    c.fill(fill({ ordId: 'o1', side: 'buy', fillPx: '60000', fillSz: '1' }), facts('o1'));
    c.algoOrders([algo({ algoId: 'sl1', slTriggerPx: '57000', slTriggerPxType: 'mark' })], clock);
    c.fill({ ...close, tradeId: 'other' }, facts('x1', { reduceOnly: true }));
    expect(only(c)).toMatchObject({ closeReason: 'external' });
  });

  it("the exchange's trailing stop: placed, then a close the stops do not explain is trailing", () => {
    const b = book();
    b.placed(request({ trailing: { kind: 'callback', ratio: '0.05' } }), order({ ordId: 'o1', clOrdId: 'pgwcb000001', side: 'buy' }));
    b.fill(fill({ ordId: 'o1', clOrdId: 'pgwcb000001', side: 'buy', fillPx: '60000', fillSz: '1' }), facts('o1', { clOrdId: 'pgwcb000001' }));
    b.algoOrders([algo({ algoId: 'mv1', ordType: 'move_order_stop', callbackRatio: '0.05', moveTriggerPx: '57000', sz: '1' })], clock);
    // the price ran up and the trigger with it: no move is logged
    b.algoOrders([algo({ algoId: 'mv1', ordType: 'move_order_stop', callbackRatio: '0.05', moveTriggerPx: '61750', sz: '1' })], clock + 1_000);
    b.fill(fill({ ordId: 'x1', side: 'sell', fillPx: '62300', fillSz: '1' }), facts('x1', { reduceOnly: true }));
    const t = only(b);
    expect(t.closeReason).toBe('trailing');
    expect(t.timeline.filter((e) => e.algoId === 'mv1').map((e) => e.kind)).toEqual(['trailing_placed', 'trailing_triggered']);
  });

  it('a net-mode order larger than the position closes the trade and opens the next one the other way', () => {
    const b = book();
    b.fill(fill({ ordId: 'o1', side: 'buy', fillPx: '100', fillSz: '1', fee: '0' }), facts('o1', { tdMode: 'cross' }));
    clock += 10;
    b.fill(fill({ ordId: 'o2', side: 'sell', fillPx: '90', fillSz: '3', fee: '-0.3' }), facts('o2', { tdMode: 'cross' }));
    const [short, long] = b.list({}, undefined, 10).trades;
    expect(long).toMatchObject({ direction: 'long', status: 'closed', realisedPnl: '-0.1', fees: '0.1' });
    expect(short).toMatchObject({ direction: 'short', status: 'open', size: '2', fees: '0.2' });
    expect(short?.entry.avgPx).toBe('90');
    // a reduce-only close of a position the journal never saw open is not a trade
    const c = book();
    expect(c.fill(fill({ ordId: 'z', side: 'sell', fillPx: '100', fillSz: '1' }), facts('z', { reduceOnly: true }))).toBe(true);
    expect(c.list({}, undefined, 10).total).toBe(0);
  });

  it('cancelled orders and unfilled plans', () => {
    const b = book();
    b.fill(fill({ ordId: 'o1', side: 'buy', fillPx: '100', fillSz: '1' }), facts('o1'));
    clock += 1_000;
    // a limit add placed on the open trade, then cancelled unfilled
    b.placed(request({ ordType: 'limit', px: '95' }), order({ ordId: 'l1', clOrdId: 'pgwlimit01', side: 'buy', ordType: 'limit', px: '95', sz: '1' }));
    b.order(order({ ordId: 'l1', clOrdId: 'pgwlimit01', side: 'buy', ordType: 'limit', px: '95', sz: '1', state: 'canceled' }));
    const t = only(b);
    expect(t.timeline.map((e) => e.kind)).toEqual(['fill', 'order_placed', 'order_cancelled']);
    expect(t.timeline[2]).toMatchObject({ ordId: 'l1', contracts: '1' });
    expect(b.data.pending.some((p) => p.ordId === 'l1')).toBe(false);
  });

  it('adopts a position it did not see open, closes one that is gone, follows a size the exchange shows, records funding', () => {
    const b = book();
    const rec = b.adopt(position('3', { avgPx: '50000', margin: '300', lever: '5' }), 'external');
    expect(rec?.trade).toMatchObject({ adopted: true, size: '3', source: 'external', openedAt: clock - 60_000 });
    expect(rec?.trade.entry).toMatchObject({ avgPx: '50000', contracts: '3', coin: '0.03', notional: '1500', margin: '300', leverage: '5' });
    expect(rec?.trade.timeline[0]).toMatchObject({ kind: 'adopted', code: 'POSITION_ADOPTED' });
    // not twice
    expect(b.adopt(position('3'), 'external')).toBeNull();
    if (!rec) throw new Error('not adopted');
    b.funding('BTC-USDT-SWAP', 'isolated', 'net', '-1.25');
    expect(rec.trade).toMatchObject({ funding: '-1.25', netPnl: '-1.25' });
    b.correctSize(rec, position('2', { avgPx: '51000' }));
    expect(rec.trade).toMatchObject({ size: '2' });
    expect(rec.book.avgPx).toBe('51000');
    // a fill later closes against the exchange's average
    b.fill(fill({ ordId: 'c1', side: 'sell', fillPx: '52000', fillSz: '1', fee: '0' }), facts('c1', { reduceOnly: true }));
    expect(rec.trade.realisedPnl).toBe('10');
    b.closeGone(rec);
    expect(rec.trade).toMatchObject({ status: 'closed', closeReason: 'unknown', size: '0' });
    expect(rec.trade.timeline.map((e) => e.code ?? e.kind)).toEqual(['POSITION_ADOPTED', 'SIZE_CORRECTED', 'fill', 'POSITION_GONE']);
    expect(rec.trade.exits).toHaveLength(1);
  });

  it('pages newest first and reports what changed once', () => {
    const b = book();
    for (let i = 0; i < 5; i++) {
      b.fill(fill({ ordId: `o${i}`, side: 'buy', fillPx: '100', fillSz: '1' }), facts(`o${i}`));
      b.fill(fill({ ordId: `c${i}`, side: 'sell', fillPx: '101', fillSz: '1' }), facts(`c${i}`, { reduceOnly: true }));
    }
    const first = b.list({}, undefined, 2);
    expect(first.trades.map((t) => t.seq)).toEqual([5, 4]);
    expect(first).toMatchObject({ total: 5, next: 4 });
    const second = b.list({}, first.next ?? undefined, 2);
    expect(second.trades.map((t) => t.seq)).toEqual([3, 2]);
    expect(b.list({}, 2, 2)).toMatchObject({ next: null });
    expect(b.takeChanged().map((t) => t.seq)).toEqual([5, 4, 3, 2, 1]);
    expect(b.takeChanged()).toEqual([]);
  });
});
