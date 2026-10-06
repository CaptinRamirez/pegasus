import { afterEach, describe, expect, it } from 'vitest';
import { d } from '../src/num.js';
import { OrderStore, algoRecord, type StopJson } from '../src/engine/orders.js';
import type { MockOkxHandle, OkxAlgoAck, OkxAlgoOrder, OkxOrder, OkxOrderAck, OkxPosition, OkxTicker } from '../src/index.js';
import { rest, start } from './helpers.js';

const BTC = 'BTC-USDT-SWAP';

async function place(h: MockOkxHandle, body: Record<string, unknown>): Promise<OkxOrderAck> {
  const ack = (await rest<OkxOrderAck>(h, 'POST', '/api/v5/trade/order', { instId: BTC, tdMode: 'cross', ...body })).data[0];
  if (!ack) throw new Error('no ack');
  return ack;
}

async function order(h: MockOkxHandle, ordId: string): Promise<OkxOrder | undefined> {
  return (await rest<OkxOrder>(h, 'GET', `/api/v5/trade/order?instId=${BTC}&ordId=${ordId}`)).data[0];
}

async function algo(h: MockOkxHandle, body: Record<string, unknown>): Promise<OkxAlgoAck> {
  const ack = (await rest<OkxAlgoAck>(h, 'POST', '/api/v5/trade/order-algo', { instId: BTC, tdMode: 'cross', ...body })).data[0];
  if (!ack) throw new Error('no ack');
  return ack;
}

async function pending(h: MockOkxHandle, ordType: string): Promise<{ code: string; data: OkxAlgoOrder[] }> {
  return rest<OkxAlgoOrder>(h, 'GET', `/api/v5/trade/orders-algo-pending?ordType=${ordType}&instType=SWAP`);
}

/** Open positions as [posSide, pos]. */
async function positions(h: MockOkxHandle): Promise<string[][]> {
  const list = (await rest<OkxPosition>(h, 'GET', '/api/v5/account/positions?instType=SWAP')).data;
  return list.map((p) => [p.posSide, p.pos]).sort();
}

async function last(h: MockOkxHandle): Promise<number> {
  return Number((await rest<OkxTicker>(h, 'GET', `/api/v5/market/ticker?instId=${BTC}`)).data[0]?.last);
}

const tp = (tpTriggerPx: string, sz: string, extra: Record<string, unknown> = {}) => ({ tpTriggerPx, tpOrdPx: '-1', tpTriggerPxType: 'mark', sz, ...extra });
const sl = (slTriggerPx: string, extra: Record<string, unknown> = {}) => ({ slTriggerPx, slOrdPx: '-1', slTriggerPxType: 'mark', ...extra });
const buy10 = { side: 'buy', ordType: 'market', sz: '10' };

describe('attached take-profits', () => {
  let h: MockOkxHandle;
  afterEach(async () => {
    await h.close();
  });

  it('split take-profits become one order per leg at the fill; the first one moves the cost-price stop to the fill price', async () => {
    h = await start({ seed: 7 });
    h.setPrice(BTC, '60000');
    const ack = await place(h, { ...buy10, attachAlgoOrds: [tp('61000', '4', { attachAlgoClOrdId: 'tp1x' }), tp('62000', '6', { attachAlgoClOrdId: 'tp2x' }), sl('59000', { attachAlgoClOrdId: 'slx', amendPxOnTriggerType: '1' })] });
    expect(ack.sCode).toBe('0');
    const o = await order(h, ack.ordId);
    expect(o?.state).toBe('filled');
    expect(o?.attachAlgoOrds.map((a) => [a.attachAlgoClOrdId, a.tpTriggerPx, a.sz, a.slTriggerPx, a.amendPxOnTriggerType])).toEqual([
      ['tp1x', '61000', '4', '', '0'],
      ['tp2x', '62000', '6', '', '0'],
      ['slx', '', '', '59000', '1'],
    ]);
    const avgPx = o?.avgPx ?? '';
    expect(h.getState().stops).toEqual([
      { algoId: o?.attachAlgoOrds[0]?.attachAlgoId, algoClOrdId: 'tp1x', ordId: ack.ordId, instId: BTC, tdMode: 'cross', posSide: 'net', side: 'sell', sz: '4', slTriggerPx: '', slTriggerPxType: '', tpTriggerPx: '61000', tpTriggerPxType: 'mark' },
      { algoId: o?.attachAlgoOrds[1]?.attachAlgoId, algoClOrdId: 'tp2x', ordId: ack.ordId, instId: BTC, tdMode: 'cross', posSide: 'net', side: 'sell', sz: '6', slTriggerPx: '', slTriggerPxType: '', tpTriggerPx: '62000', tpTriggerPxType: 'mark' },
      { algoId: o?.attachAlgoOrds[2]?.attachAlgoId, algoClOrdId: 'slx', ordId: ack.ordId, instId: BTC, tdMode: 'cross', posSide: 'net', side: 'sell', sz: '10', slTriggerPx: '59000', slTriggerPxType: 'mark', amendPxOnTriggerType: true },
    ]);
    // the take-profits are listed as conditional orders with their own size
    const listed = (await pending(h, 'conditional,oco')).data;
    expect(listed.map((a) => [a.ordType, a.sz, a.tpTriggerPx, a.slTriggerPx, a.amendPxOnTriggerType]).sort()).toEqual([
      ['conditional', '10', '', '59000', '1'],
      ['conditional', '4', '61000', '', '0'],
      ['conditional', '6', '62000', '', '0'],
    ]);

    // one tick short of the first take-profit, then on it: 4 of 10 are closed and the stop moves to the fill price
    h.setMarkPrice(BTC, '60999.9');
    expect(await positions(h)).toEqual([['net', '10']]);
    h.setMarkPrice(BTC, '61000');
    expect(await positions(h)).toEqual([['net', '6']]);
    expect(h.getState().stops.map((s) => [s.algoClOrdId, s.sz, s.slTriggerPx || s.tpTriggerPx, s.amendPxOnTriggerType ?? false])).toEqual([
      ['tp2x', '6', '62000', false],
      ['slx', '10', avgPx, false],
    ]);
    const closing = h.getState().orders.find((x) => x.side === 'sell');
    expect(closing).toMatchObject({ ordType: 'market', sz: '4', state: 'filled', reduceOnly: 'true' });

    // the moved stop closes the rest at the entry; the last take-profit goes with the position
    h.setMarkPrice(BTC, avgPx);
    expect(await positions(h)).toEqual([]);
    expect(h.getState().stops).toEqual([]);
  });

  it('refuses split take-profits the way OKX documents', async () => {
    h = await start({ seed: 7 });
    h.setPrice(BTC, '60000');
    const code = async (attachAlgoOrds: unknown[], body: Record<string, unknown> = buy10) => (await place(h, { ...body, attachAlgoOrds })).sCode;
    expect(await code([{ ...tp('61000', '4'), ...sl('59000') }, tp('62000', '6')])).toBe('51076');
    expect(await code([tp('61000', '4'), { tpTriggerPx: '62000', tpOrdPx: '-1', tpTriggerPxType: 'mark' }])).toBe('51089');
    expect(await code([tp('61000', '4', { tpOrdPx: '61500' }), tp('62000', '6')])).toBe('51082');
    expect(await code([tp('61000', '4'), tp('62000', '6', { tpTriggerPxType: 'last' })])).toBe('51080');
    expect(await code([tp('61000', '4'), tp('61000', '6')])).toBe('51081');
    expect(await code([tp('61000', '4'), tp('62000', '5')])).toBe('51083');
    expect(await code([tp('61000', '4'), tp('62000', '6'), sl('59000'), sl('58000')])).toBe('51084');
    expect(await code([tp('61000', '10'), sl('59000', { amendPxOnTriggerType: '1' })])).toBe('51085');
    expect(await code([tp('61000', '4.05'), tp('62000', '5.95')])).toBe('51121');
    expect(Array.from({ length: 11 }, (_, i) => tp(String(61000 + i * 10), i === 0 ? '0.1' : '0.9'))).toHaveLength(11);
    expect(await code(Array.from({ length: 11 }, (_, i) => tp(String(61000 + i * 10), i < 10 ? '0.9' : '1')))).toBe('51079');
    // a take-profit the mark has already passed: OKX's code by trigger price type and side
    expect(await code([tp('59000', '4'), tp('62000', '6')])).toBe('51303');
    expect(await code([tp('59000', '4', { tpTriggerPxType: 'last' }), tp('62000', '6', { tpTriggerPxType: 'last' })])).toBe('51279');
    expect(await code([tp('61000', '4'), tp('62000', '6')], { side: 'sell', ordType: 'market', sz: '10' })).toBe('51300');
    // at or beyond the order's own price: no documented code
    expect(await code([tp('60500', '4'), tp('62000', '6')], { side: 'buy', ordType: 'limit', px: '61000', sz: '10' })).toBe('51000');
    // an attached trailing stop and a limit take-profit are not simulated
    expect(await code([{ callbackRatio: '0.05' }])).toBe('51000');
    expect(await code([{ tpTriggerPx: '61000', tpOrdPx: '61000', tpOrdKind: 'limit' }])).toBe('51000');
    expect(h.getState().orders).toEqual([]);
    expect(h.getState().stops).toEqual([]);
  });

  it('one object with both a take-profit and a stop-loss is one oco order: the first leg to trigger ends it', async () => {
    h = await start({ seed: 7 });
    h.setPrice(BTC, '60000');
    const ack = await place(h, { ...buy10, attachAlgoOrds: [{ ...sl('59000'), tpTriggerPx: '61000', tpOrdPx: '-1', tpTriggerPxType: 'mark', attachAlgoClOrdId: 'ocox' }] });
    expect(ack.sCode).toBe('0');
    expect(h.getState().stops).toMatchObject([{ algoClOrdId: 'ocox', ordType: 'oco', sz: '10', slTriggerPx: '59000', tpTriggerPx: '61000' }]);
    expect((await pending(h, 'oco')).data.map((a) => a.algoClOrdId)).toEqual(['ocox']);
    expect((await pending(h, 'conditional')).data).toEqual([]);
    h.setMarkPrice(BTC, '61000');
    expect(await positions(h)).toEqual([]);
    expect(h.getState().stops).toEqual([]);

    // a take-profit alone in one object is a conditional take-profit for the whole fill
    h.setMarkPrice(BTC, null);
    h.setPrice(BTC, '60000');
    expect((await place(h, { side: 'sell', ordType: 'market', sz: '3', attachAlgoOrds: [{ tpTriggerPx: '59000', tpOrdPx: '-1', tpTriggerPxType: 'mark' }] })).sCode).toBe('0');
    expect(h.getState().stops).toMatchObject([{ side: 'buy', sz: '3', slTriggerPx: '', tpTriggerPx: '59000' }]);
    expect(h.getState().stops[0]?.ordType).toBeUndefined();
    h.setMarkPrice(BTC, '59000');
    expect(await positions(h)).toEqual([]);
  });

  it('long/short mode: the take-profits of a short close its leg only', async () => {
    h = await start({ posMode: 'long_short_mode', seed: 7 });
    h.setPrice(BTC, '60000');
    expect((await place(h, { side: 'buy', posSide: 'long', ordType: 'market', sz: '2' })).sCode).toBe('0');
    const ack = await place(h, { side: 'sell', posSide: 'short', ordType: 'market', sz: '10', attachAlgoOrds: [tp('59000', '5'), tp('58000', '5'), sl('61000', { amendPxOnTriggerType: '1' })] });
    expect(ack.sCode).toBe('0');
    expect(h.getState().stops.map((s) => [s.posSide, s.side, s.sz])).toEqual([['short', 'buy', '5'], ['short', 'buy', '5'], ['short', 'buy', '10']]);
    h.setMarkPrice(BTC, '59000');
    expect(await positions(h)).toEqual([['long', '2'], ['short', '5']]);
    h.setMarkPrice(BTC, '58000');
    expect(await positions(h)).toEqual([['long', '2']]);
    expect(h.getState().stops).toEqual([]);
  });
});

describe('take-profit and oco orders placed on their own', () => {
  let h: MockOkxHandle;
  afterEach(async () => {
    await h.close();
  });

  it('a conditional take-profit, an oco order, and a conditional order with both legs (OKX performs the stop-loss only)', async () => {
    h = await start({ seed: 7 });
    h.setPrice(BTC, '60000');
    await place(h, buy10);
    const base = { side: 'sell', reduceOnly: true, cxlOnClosePos: true };
    expect(await algo(h, { ...base, ordType: 'conditional', sz: '4', tpTriggerPx: '59500', tpOrdPx: '-1', tpTriggerPxType: 'mark' })).toMatchObject({ sCode: '51303' });
    expect((await algo(h, { ...base, ordType: 'oco', sz: '4', tpTriggerPx: '61000', tpOrdPx: '-1' })).sCode).toBe('51000');
    expect((await algo(h, { ...base, ordType: 'conditional', sz: '11', tpTriggerPx: '61000', tpOrdPx: '-1' })).sCode).toBe('51119');
    const tpAck = await algo(h, { ...base, ordType: 'conditional', sz: '4', tpTriggerPx: '61000', tpOrdPx: '-1', tpTriggerPxType: 'mark', algoClOrdId: 'tpone' });
    const ocoAck = await algo(h, { ...base, ordType: 'oco', sz: '3', tpTriggerPx: '62000', tpOrdPx: '-1', tpTriggerPxType: 'mark', slTriggerPx: '59000', slOrdPx: '-1', slTriggerPxType: 'mark' });
    const bothAck = await algo(h, { ...base, ordType: 'conditional', sz: '3', tpTriggerPx: '61500', tpOrdPx: '-1', tpTriggerPxType: 'mark', slTriggerPx: '58000', slOrdPx: '-1', slTriggerPxType: 'mark' });
    expect([tpAck.sCode, ocoAck.sCode, bothAck.sCode]).toEqual(['0', '0', '0']);
    const both = h.getState().stops.find((s) => s.algoId === bothAck.algoId);
    expect(both).toMatchObject({ slTriggerPx: '58000' });
    expect(both?.tpTriggerPx).toBeUndefined();

    // the take-profit closes its 4; the conditional with both legs does not take profit at 61500
    h.setMarkPrice(BTC, '61600');
    expect(await positions(h)).toEqual([['net', '6']]);
    // the oco order's take-profit closes its 3 and ends it
    h.setMarkPrice(BTC, '62000');
    expect(await positions(h)).toEqual([['net', '3']]);
    expect(h.getState().stops.map((s) => s.algoId)).toEqual([bothAck.algoId]);
  });

  it('amends a take-profit leg; a leg the order does not have cannot be added', async () => {
    h = await start({ seed: 7 });
    h.setPrice(BTC, '60000');
    await place(h, buy10);
    const ack = await algo(h, { side: 'sell', reduceOnly: true, cxlOnClosePos: true, ordType: 'conditional', sz: '10', tpTriggerPx: '61000', tpOrdPx: '-1', tpTriggerPxType: 'mark' });
    const amend = async (body: Record<string, unknown>) => (await rest<OkxAlgoAck>(h, 'POST', '/api/v5/trade/amend-algos', { instId: BTC, algoId: ack.algoId, ...body })).data[0];
    expect(await amend({ newTpTriggerPx: '62000' })).toMatchObject({ sCode: '0' });
    expect(h.getState().stops).toMatchObject([{ tpTriggerPx: '62000' }]);
    expect((await amend({ newTpTriggerPx: '59000' }))?.sCode).toBe('51303');
    expect((await amend({ newSlTriggerPx: '59000' }))?.sCode).toBe('51526');
    expect((await amend({ newTpTriggerPx: '0' }))?.sCode).toBe('51526');
    expect((await amend({ newTpTriggerPxType: 'last' }))?.sCode).toBe('51528');
    h.setMarkPrice(BTC, '62000');
    expect(await positions(h)).toEqual([]);
  });
});

describe('trailing stops (move_order_stop)', () => {
  let h: MockOkxHandle;
  afterEach(async () => {
    await h.close();
  });

  it('trails the highest last price from its placement and closes the position once the price has come back by the callback', async () => {
    h = await start({ seed: 7 });
    h.setPrice(BTC, '60000');
    await place(h, buy10);
    const ack = await algo(h, { side: 'sell', ordType: 'move_order_stop', sz: '10', callbackRatio: '0.05', reduceOnly: true, algoClOrdId: 'trone' });
    expect(ack).toMatchObject({ algoClOrdId: 'trone', sCode: '0' });
    const at = await last(h);
    expect(h.getState().stops).toMatchObject([{ algoClOrdId: 'trone', ordType: 'move_order_stop', side: 'sell', sz: '10', callbackRatio: '0.05', slTriggerPx: '' }]);
    expect(Number(h.getState().stops[0]?.moveTriggerPx)).toBeCloseTo(at * 0.95, 6);
    // listed on its own: OKX takes move_order_stop alone, never with the TP/SL types
    expect((await pending(h, 'move_order_stop')).data).toMatchObject([{ algoId: ack.algoId, ordType: 'move_order_stop', callbackRatio: '0.05', activePx: '', reduceOnly: 'true' }]);
    expect((await pending(h, 'conditional,oco')).data).toEqual([]);
    expect((await pending(h, 'conditional,move_order_stop')).code).toBe('51000');

    // the price rises: the trigger rises with it; the mark alone moves nothing
    h.setPrice(BTC, '63000');
    const high = await last(h);
    expect(Number(h.getState().stops[0]?.moveTriggerPx)).toBeCloseTo(high * 0.95, 6);
    h.setMarkPrice(BTC, '50000');
    expect(await positions(h)).toEqual([['net', '10']]);
    h.setMarkPrice(BTC, null);
    // a fall of less than 5% from the high keeps it; reaching the trigger closes the position
    h.setPrice(BTC, String(Math.ceil(high * 0.96)));
    expect(await positions(h)).toEqual([['net', '10']]);
    h.setPrice(BTC, String(Math.floor(high * 0.95) - 1));
    expect(await positions(h)).toEqual([]);
    expect(h.getState().stops).toEqual([]);
    const closing = h.getState().orders.find((o) => o.side === 'sell');
    expect(closing).toMatchObject({ ordType: 'market', sz: '10', state: 'filled', reduceOnly: 'true' });
  });

  it('with an activation price it starts trailing only once the last price reaches it; refusals by OKX code', async () => {
    h = await start({ seed: 7 });
    h.setPrice(BTC, '60000');
    await place(h, buy10);
    const base = { side: 'sell', ordType: 'move_order_stop', sz: '10', reduceOnly: true };
    expect((await algo(h, { ...base, callbackRatio: '0.05', activePx: '59000' })).sCode).toBe('51258');
    expect((await algo(h, { ...base, callbackRatio: '1' })).sCode).toBe('51257');
    expect((await algo(h, { ...base, callbackRatio: '0.05', callbackSpread: '100' })).sCode).toBe('51000');
    expect((await algo(h, { ...base })).sCode).toBe('51000');
    expect((await algo(h, { ...base, callbackRatio: '0.05', slTriggerPx: '59000', slOrdPx: '-1' })).sCode).toBe('51000');
    const ack = await algo(h, { ...base, callbackSpread: '500', activePx: '61000' });
    expect(ack.sCode).toBe('0');
    expect(h.getState().stops).toMatchObject([{ activePx: '61000', callbackSpread: '500', moveTriggerPx: '' }]);
    // not active: a fall far below the activation price triggers nothing
    h.setPrice(BTC, '58000');
    expect(await positions(h)).toEqual([['net', '10']]);
    h.setPrice(BTC, '61500');
    const high = await last(h);
    expect(high).toBeGreaterThanOrEqual(61000);
    expect(Number(h.getState().stops[0]?.moveTriggerPx)).toBeCloseTo(high - 500, 6);
    // an amend of a trailing stop is refused: amend-algos supports stop and trigger orders only
    expect((await rest<OkxAlgoAck>(h, 'POST', '/api/v5/trade/amend-algos', { instId: BTC, algoId: ack.algoId, newSz: '5' })).data[0]?.sCode).toBe('51000');
    h.setPrice(BTC, String(Math.floor(high - 501)));
    expect(await positions(h)).toEqual([]);
  });

  it('a buy trailing stop protects a short: it trails the lowest price; it stays after its position is closed and then closes nothing', async () => {
    h = await start({ seed: 7 });
    h.setPrice(BTC, '60000');
    await place(h, { side: 'sell', ordType: 'market', sz: '10' });
    expect((await algo(h, { side: 'buy', ordType: 'move_order_stop', sz: '10', callbackRatio: '0.02', reduceOnly: true, activePx: '61000' })).sCode).toBe('51259');
    const ack = await algo(h, { side: 'buy', ordType: 'move_order_stop', sz: '10', callbackRatio: '0.02', reduceOnly: true });
    expect(ack.sCode).toBe('0');
    // the trailing stop has no cxlOnClosePos: closing the position by hand leaves it resting
    expect((await rest(h, 'POST', '/api/v5/trade/close-position', { instId: BTC, mgnMode: 'cross' })).code).toBe('0');
    expect(await positions(h)).toEqual([]);
    expect(h.getState().stops).toMatchObject([{ algoId: ack.algoId, ordType: 'move_order_stop', cxlOnClosePos: false }]);
    // when it triggers there is nothing to reduce: the order ends and opens nothing
    h.setPrice(BTC, '57000');
    h.setPrice(BTC, '60000');
    expect(await positions(h)).toEqual([]);
    expect(h.getState().stops).toEqual([]);
  });
});

describe('algo orders when their position is closed', () => {
  let h: MockOkxHandle;
  afterEach(async () => {
    await h.close();
  });

  it('a TP/SL order with cxlOnClosePos goes with its position; one without stays', async () => {
    h = await start({ posMode: 'long_short_mode', seed: 7 });
    h.setPrice(BTC, '60000');
    await place(h, { side: 'buy', posSide: 'long', ordType: 'market', sz: '10' });
    const kept = await algo(h, { side: 'sell', posSide: 'long', ordType: 'conditional', sz: '10', slTriggerPx: '59000', slOrdPx: '-1', slTriggerPxType: 'mark' });
    const gone = await algo(h, { side: 'sell', posSide: 'long', ordType: 'conditional', sz: '10', tpTriggerPx: '62000', tpOrdPx: '-1', tpTriggerPxType: 'mark', cxlOnClosePos: true });
    expect([kept.sCode, gone.sCode]).toEqual(['0', '0']);
    expect((await rest(h, 'POST', '/api/v5/trade/close-position', { instId: BTC, mgnMode: 'cross', posSide: 'long' })).code).toBe('0');
    expect(h.getState().stops.map((s) => s.algoId)).toEqual([kept.algoId]);
    // a new long picks the remaining stop up, as an order not associated with the position would on OKX
    await place(h, { side: 'buy', posSide: 'long', ordType: 'market', sz: '4' });
    h.setMarkPrice(BTC, '59000');
    expect(await positions(h)).toEqual([]);
    expect(h.getState().stops).toEqual([]);
  });

  it('net mode: cxlOnClosePos needs reduceOnly', async () => {
    h = await start({ seed: 7 });
    h.setPrice(BTC, '60000');
    await place(h, buy10);
    expect((await algo(h, { side: 'sell', ordType: 'conditional', sz: '10', slTriggerPx: '59000', slOrdPx: '-1', cxlOnClosePos: true })).sCode).toBe('51000');
  });
});

describe('order store snapshot', () => {
  it('keeps every field of the algo orders, and reads a file written before take-profits as stop-losses with the old behaviour', () => {
    const store = new OrderStore();
    const trail = algoRecord({ algoId: '1', algoClOrdId: 'tr', ordId: '', instId: BTC, tdMode: 'cross', posSide: 'net', side: 'sell', sz: d(3), cTime: 1, uTime: 2, ordType: 'move_order_stop', callbackRatio: d('0.05'), activePx: d(61000), extremePx: d(62000), cxlOnClosePos: false });
    const tpRec = algoRecord({ algoId: '2', algoClOrdId: 'tp', ordId: '9', instId: BTC, tdMode: 'cross', posSide: 'net', side: 'sell', sz: d(2), cTime: 1, uTime: 1, tpTriggerPx: d(63000), tpOrdPx: '-1', tpTriggerPxType: 'mark', cxlOnClosePos: true });
    const costSl = algoRecord({ algoId: '3', algoClOrdId: 'sl', ordId: '9', instId: BTC, tdMode: 'cross', posSide: 'net', side: 'sell', sz: d(5), cTime: 1, uTime: 1, slTriggerPx: d(59000), slOrdPx: '-1', slTriggerPxType: 'mark', amendPxOnTriggerType: true, costPx: d('60000.5'), cxlOnClosePos: true });
    for (const s of [trail, tpRec, costSl]) store.addStandaloneStop(s);
    const saved = JSON.parse(JSON.stringify(store.snapshot())) as ReturnType<OrderStore['snapshot']>;
    const restored = new OrderStore();
    restored.restore(saved);
    expect(restored.snapshot()).toEqual(saved);
    expect(restored.activeStops().map((s) => [s.ordType, s.extremePx?.toFixed(), s.costPx?.toFixed(), s.tpTriggerPx?.toFixed()])).toEqual([
      ['move_order_stop', '62000', undefined, undefined],
      ['conditional', undefined, undefined, '63000'],
      ['conditional', undefined, '60000.5', undefined],
    ]);

    const old: StopJson = { algoId: '7', algoClOrdId: 'slold', ordId: '5', instId: BTC, tdMode: 'cross', posSide: 'net', side: 'sell', sz: '10', slTriggerPx: '59000', slOrdPx: '-1', slTriggerPxType: 'mark', cTime: 1, uTime: 1 };
    const fromOld = new OrderStore();
    fromOld.restore({ live: [], history: [], fills: [], stops: [old], ordSeq: 0, billSeq: 0, algoSeq: 7 });
    expect(fromOld.activeStops()).toMatchObject([{ algoId: '7', ordType: 'conditional', tpTriggerPx: null, reduceOnly: true, cxlOnClosePos: true, amendPxOnTriggerType: false }]);
  });
});
