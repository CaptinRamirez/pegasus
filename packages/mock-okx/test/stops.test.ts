import { afterEach, describe, expect, it } from 'vitest';
import type { MockOkxHandle, OkxBookData, OkxOrder, OkxOrderAck, OkxPosition, OkxTicker } from '../src/index.js';
import { CREDS, WsProbe, isData, isEvent, rest, start, wsLoginArgs } from './helpers.js';

const BTC = 'BTC-USDT-SWAP';

async function place(h: MockOkxHandle, body: Record<string, unknown>): Promise<OkxOrderAck> {
  const ack = (await rest<OkxOrderAck>(h, 'POST', '/api/v5/trade/order', { instId: BTC, tdMode: 'cross', ...body })).data[0];
  if (!ack) throw new Error('no ack');
  return ack;
}

async function order(h: MockOkxHandle, ordId: string): Promise<OkxOrder | undefined> {
  return (await rest<OkxOrder>(h, 'GET', `/api/v5/trade/order?instId=${BTC}&ordId=${ordId}`)).data[0];
}

/** Open positions as [posSide, pos]. */
async function positions(h: MockOkxHandle): Promise<string[][]> {
  const list = (await rest<OkxPosition>(h, 'GET', '/api/v5/account/positions?instType=SWAP')).data;
  return list.map((p) => [p.posSide, p.pos]).sort();
}

async function last(h: MockOkxHandle): Promise<number> {
  return Number((await rest<OkxTicker>(h, 'GET', `/api/v5/market/ticker?instId=${BTC}`)).data[0]?.last);
}

/** A limit buy with a stop that takes the whole best ask and rests its remaining 5 contracts. */
async function placePartial(h: MockOkxHandle, slTriggerPx: string): Promise<{ ack: OkxOrderAck; askPx: string; askSz: string; sz: string }> {
  const book = (await rest<OkxBookData>(h, 'GET', `/api/v5/market/books?instId=${BTC}&sz=5`)).data[0];
  const [askPx, askSz] = book?.asks[0] ?? [];
  if (askPx === undefined || askSz === undefined) throw new Error('no ask');
  const sz = (Number(askSz) + 5).toFixed(1);
  const ack = await place(h, { side: 'buy', ordType: 'limit', px: askPx, sz, ...stop(slTriggerPx) });
  expect(ack.sCode).toBe('0');
  return { ack, askPx, askSz, sz };
}

const stop = (slTriggerPx: string, extra: Record<string, unknown> = {}): { attachAlgoOrds: unknown[] } => ({ attachAlgoOrds: [{ slTriggerPx, slOrdPx: '-1', slTriggerPxType: 'mark', ...extra }] });

describe('attached stop-loss', () => {
  let h: MockOkxHandle;
  afterEach(async () => {
    await h.close();
  });

  it('validates attachAlgoOrds and refuses a stop on the wrong side or on a closing order', async () => {
    h = await start({ seed: 7 });
    h.setPrice(BTC, '60000');
    const buy = { side: 'buy', ordType: 'market', sz: '10' };
    const sell = { side: 'sell', ordType: 'market', sz: '10' };
    // OKX's codes for a stop on the wrong side, by trigger price type and side
    expect(await place(h, { ...buy, ...stop('61000') })).toMatchObject({ sCode: '51304', sMsg: 'SL trigger price cannot be higher than the mark price' });
    expect(await place(h, { ...sell, ...stop('59000') })).toMatchObject({ sCode: '51302', sMsg: 'SL trigger price cannot be lower than the mark price' });
    expect((await place(h, { ...buy, ...stop('61000', { slTriggerPxType: 'last' }) })).sCode).toBe('51280');
    expect((await place(h, { ...sell, attachAlgoOrds: [{ slTriggerPx: '59000', slOrdPx: '-1' }] })).sCode).toBe('51278');
    expect((await place(h, { ...buy, ...stop('61000', { slTriggerPxType: 'index' }) })).sCode).toBe('51308');
    expect((await place(h, { ...sell, ...stop('59000', { slTriggerPxType: 'index' }) })).sCode).toBe('51306');
    // the type decides which price is compared: this stop is below the mark but above the last price
    h.setMarkPrice(BTC, '62000');
    expect((await place(h, { ...buy, ...stop('61000', { slTriggerPxType: 'last' }) })).sCode).toBe('51280');
    h.setMarkPrice(BTC, null);
    // below the mark but not below the limit price: no documented code, a parameter error
    expect((await place(h, { side: 'buy', ordType: 'limit', px: '58000', sz: '10', ...stop('59000') })).sCode).toBe('51000');
    expect((await place(h, { ...buy, ...stop('59000.05') })).sCode).toBe('51000');
    expect((await place(h, { ...buy, attachAlgoOrds: [{ slTriggerPx: '59000' }] })).sCode).toBe('51000');
    expect((await place(h, { ...buy, ...stop('59000', { slTriggerPxType: 'bid' }) })).sCode).toBe('51000');
    expect((await place(h, { ...buy, ...stop('59000', { tpTriggerPx: '62000', tpOrdPx: '-1' }) })).sCode).toBe('51000');
    expect((await place(h, { ...buy, attachAlgoOrds: 'x' })).sCode).toBe('51000');
    expect(h.getState().orders).toEqual([]);
    expect(h.getState().stops).toEqual([]);

    // an empty list is no stop at all
    expect((await place(h, { ...buy, attachAlgoOrds: [] })).sCode).toBe('0');
    expect((await place(h, { side: 'sell', ordType: 'market', sz: '5', reduceOnly: true, ...stop('61000') })).sCode).toBe('51000');
    expect(await positions(h)).toEqual([['net', '10']]);
    expect(h.getState().stops).toEqual([]);
  });

  it('generates the stop when the order is filled, echoes it on the order, and triggers on the mark price, not on the last price', async () => {
    h = await start({ seed: 7 });
    h.setPrice(BTC, '60000');
    const ack = await place(h, { side: 'buy', ordType: 'market', sz: '10', ...stop('59000', { attachAlgoClOrdId: 'slabc1' }) });
    expect(ack.sCode).toBe('0');
    const o = await order(h, ack.ordId);
    expect(o?.state).toBe('filled');
    expect(o?.attachAlgoOrds).toHaveLength(1);
    expect(o?.attachAlgoOrds[0]).toMatchObject({ attachAlgoClOrdId: 'slabc1', slTriggerPx: '59000', slOrdPx: '-1', slTriggerPxType: 'mark' });
    expect(h.getState().stops).toEqual([
      { algoId: o?.attachAlgoOrds[0]?.attachAlgoId, algoClOrdId: 'slabc1', ordId: ack.ordId, instId: BTC, tdMode: 'cross', posSide: 'net', side: 'sell', sz: '10', slTriggerPx: '59000', slTriggerPxType: 'mark' },
    ]);
    // an algo order is not an open order
    expect((await rest<OkxOrder>(h, 'GET', '/api/v5/trade/orders-pending?instType=SWAP')).data).toEqual([]);

    // the last price falls through the trigger while the mark stays above it: nothing happens
    h.setMarkPrice(BTC, '60000');
    h.setPrice(BTC, '58000');
    h.tick();
    expect(await last(h)).toBeLessThan(59000);
    expect(await positions(h)).toEqual([['net', '10']]);
    expect(h.getState().stops).toHaveLength(1);

    // the mark above the trigger by one tick, then on it
    h.setMarkPrice(BTC, '59000.1');
    expect(await positions(h)).toEqual([['net', '10']]);
    h.setMarkPrice(BTC, '59000');
    expect(await positions(h)).toEqual([]);
    expect(h.getState().stops).toEqual([]);
    const closing = h.getState().orders.find((x) => x.ordId !== ack.ordId);
    expect(closing).toMatchObject({ side: 'sell', posSide: 'net', ordType: 'market', sz: '10', accFillSz: '10', state: 'filled', reduceOnly: 'true' });
  });

  it("without a trigger type the stop follows the last price (OKX's default)", async () => {
    h = await start({ seed: 7 });
    h.setPrice(BTC, '60000');
    expect((await place(h, { side: 'sell', ordType: 'market', sz: '10', attachAlgoOrds: [{ slTriggerPx: '61000', slOrdPx: '-1' }] })).sCode).toBe('0');
    expect(h.getState().stops).toMatchObject([{ side: 'buy', sz: '10', slTriggerPxType: 'last' }]);
    h.setMarkPrice(BTC, '62000');
    expect(await positions(h)).toEqual([['net', '-10']]);
    h.setPrice(BTC, '61500');
    expect(await positions(h)).toEqual([]);
    expect(h.getState().stops).toEqual([]);
  });

  it('a partially filled order has no stop until it is completely filled; the stop is cancelled with the position', async () => {
    h = await start({ seed: 7 });
    h.setPrice(BTC, '60000');
    const { ack, askPx, askSz, sz } = await placePartial(h, '58000');
    const partial = await order(h, ack.ordId);
    expect(partial?.state).toBe('partially_filled');
    expect(Number(partial?.accFillSz)).toBe(Number(askSz));
    expect(await positions(h)).toEqual([['net', partial?.accFillSz]]);
    // the filled part is a position without a stop: the mark going through the trigger closes nothing
    expect(h.getState().stops).toEqual([]);
    h.setMarkPrice(BTC, '57000');
    expect(await positions(h)).toEqual([['net', partial?.accFillSz]]);
    h.setMarkPrice(BTC, null);

    // the book comes down to the resting remainder
    h.setPrice(BTC, String(Number(askPx) - 100));
    expect((await order(h, ack.ordId))?.state).toBe('filled');
    expect(h.getState().stops).toHaveLength(1);
    expect(Number(h.getState().stops[0]?.sz)).toBe(Number(sz));

    expect((await rest(h, 'POST', '/api/v5/trade/close-position', { instId: BTC, mgnMode: 'cross' })).code).toBe('0');
    expect(await positions(h)).toEqual([]);
    expect(h.getState().stops).toEqual([]);
    // nothing is left to fire
    h.setMarkPrice(BTC, '57000');
    expect(await positions(h)).toEqual([]);
  });

  it('a partially filled order that is cancelled gets the stop for its filled part (unverified on OKX)', async () => {
    h = await start({ seed: 7 });
    h.setPrice(BTC, '60000');
    const { ack, askSz } = await placePartial(h, '58000');
    expect(h.getState().stops).toEqual([]);
    expect((await rest<OkxOrderAck>(h, 'POST', '/api/v5/trade/cancel-order', { instId: BTC, ordId: ack.ordId })).data[0]?.sCode).toBe('0');
    const canceled = await order(h, ack.ordId);
    expect(canceled?.state).toBe('canceled');
    expect(h.getState().stops).toMatchObject([{ ordId: ack.ordId, side: 'sell', sz: canceled?.accFillSz, slTriggerPx: '58000', slTriggerPxType: 'mark' }]);
    expect(Number(h.getState().stops[0]?.sz)).toBe(Number(askSz));
    h.setMarkPrice(BTC, '58000');
    expect(await positions(h)).toEqual([]);
    expect(h.getState().stops).toEqual([]);

    // cancelled before any fill: no stop is generated
    h.setMarkPrice(BTC, null);
    const resting = await place(h, { side: 'buy', ordType: 'limit', px: '50000', sz: '3', ...stop('49000') });
    expect(resting.sCode).toBe('0');
    expect((await rest<OkxOrderAck>(h, 'POST', '/api/v5/trade/cancel-order', { instId: BTC, ordId: resting.ordId })).data[0]?.sCode).toBe('0');
    expect((await order(h, resting.ordId))?.state).toBe('canceled');
    expect(h.getState().stops).toEqual([]);
  });

  it('long/short mode: the stop closes the position side of its order and leaves the other side alone', async () => {
    h = await start({ posMode: 'long_short_mode', seed: 7 });
    h.setPrice(BTC, '60000');
    expect((await place(h, { side: 'buy', posSide: 'long', ordType: 'market', sz: '3' })).sCode).toBe('0');
    expect((await place(h, { side: 'sell', posSide: 'short', ordType: 'market', sz: '5', ...stop('59000') })).sCode).toBe('51302');
    const ack = await place(h, { side: 'sell', posSide: 'short', ordType: 'market', sz: '5', ...stop('61000') });
    expect(ack.sCode).toBe('0');
    // a closing order cannot carry a stop
    expect((await place(h, { side: 'buy', posSide: 'short', ordType: 'market', sz: '1', ...stop('59000') })).sCode).toBe('51000');
    expect(h.getState().stops).toMatchObject([{ ordId: ack.ordId, posSide: 'short', side: 'buy', sz: '5' }]);

    h.setMarkPrice(BTC, '60999.9');
    expect(await positions(h)).toEqual([['long', '3'], ['short', '5']]);
    h.setMarkPrice(BTC, '61000');
    expect(await positions(h)).toEqual([['long', '3']]);
    expect(h.getState().stops).toEqual([]);
    const closing = h.getState().orders.find((x) => x.side === 'buy' && x.posSide === 'short');
    expect(closing).toMatchObject({ ordType: 'market', sz: '5', state: 'filled' });
  });

  it('keeps a triggered stop whose closing order the exchange refuses', async () => {
    h = await start({ seed: 7, initialBalanceUsdt: '100000000' });
    h.setPrice(BTC, '60000');
    // one limit order larger than the largest market order (maxMktSz 12000): its stop cannot close it in one order
    const ack = await place(h, { side: 'buy', ordType: 'limit', px: '60500', sz: '12500', ...stop('59000') });
    expect(ack.sCode).toBe('0');
    // each new book fills more of the resting remainder
    for (let i = 0; i < 200 && (await order(h, ack.ordId))?.state !== 'filled'; i += 1) h.setPrice(BTC, i % 2 === 0 ? '60010' : '60000');
    expect((await order(h, ack.ordId))?.state).toBe('filled');
    expect(h.getState().stops).toMatchObject([{ ordId: ack.ordId, sz: '12500' }]);

    // the mark reaches the trigger: the close of 12500 contracts is refused (51004), so nothing was closed
    const ordersBefore = h.getState().orders.length;
    h.setMarkPrice(BTC, '59000');
    expect(await positions(h)).toEqual([['net', '12500']]);
    expect(h.getState().orders).toHaveLength(ordersBefore);
    // the stop is still there instead of having vanished as if it had fired
    expect(h.getState().stops).toMatchObject([{ ordId: ack.ordId, sz: '12500', slTriggerPx: '59000' }]);

    // once the position fits one market order the same stop closes it
    expect((await place(h, { side: 'sell', ordType: 'market', sz: '1000', reduceOnly: true })).sCode).toBe('0');
    h.setMarkPrice(BTC, '58990');
    expect(await positions(h)).toEqual([]);
    expect(h.getState().stops).toEqual([]);
  });

  it('accepts attachAlgoOrds on the WebSocket order op and pushes the mark it is pinned at', async () => {
    h = await start({ seed: 7, credentials: CREDS });
    h.setPrice(BTC, '60000');
    const ws = await WsProbe.connect(h.wsPrivateUrl);
    ws.send({ op: 'login', args: [wsLoginArgs(CREDS)] });
    expect((await ws.next(isEvent('login')))['code']).toBe('0');
    ws.send({ id: 'sl1', op: 'order', args: [{ instId: BTC, tdMode: 'cross', side: 'buy', ordType: 'market', sz: '2', ...stop('61000') }] });
    const refused = await ws.next<{ code: string; data: OkxOrderAck[] }>((m) => (m as { id?: string }).id === 'sl1');
    expect(refused.data[0]?.sCode).toBe('51304');
    ws.send({ id: 'sl2', op: 'order', args: [{ instId: BTC, tdMode: 'cross', side: 'buy', ordType: 'market', sz: '2', ...stop('59000') }] });
    const accepted = await ws.next<{ code: string; data: OkxOrderAck[] }>((m) => (m as { id?: string }).id === 'sl2');
    expect(accepted.code).toBe('0');
    expect(h.getState().stops).toMatchObject([{ ordId: accepted.data[0]?.ordId, sz: '2', slTriggerPx: '59000', slTriggerPxType: 'mark' }]);
    await ws.close();

    const pub = await WsProbe.connect(h.wsPublicUrl);
    pub.send({ op: 'subscribe', args: [{ channel: 'mark-price', instId: BTC }] });
    await pub.next(isEvent('subscribe', 'mark-price'));
    h.setMarkPrice(BTC, '58999');
    await pub.next((m) => isData('mark-price')(m) && (m as { data: Array<{ markPx: string }> }).data[0]?.markPx === '58999');
    expect(h.getState().positions).toEqual([]);
    await pub.close();
  });
});
