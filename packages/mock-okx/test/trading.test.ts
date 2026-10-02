import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { MockOkxHandle, OkxBalance, OkxFill, OkxOrder, OkxOrderAck, OkxPosition } from '../src/index.js';
import { rest, start } from './helpers.js';

const BTC = 'BTC-USDT-SWAP';

async function place(h: MockOkxHandle, body: Record<string, unknown>): Promise<{ code: string; ack: OkxOrderAck }> {
  const r = await rest<OkxOrderAck>(h, 'POST', '/api/v5/trade/order', body);
  const ack = r.data[0];
  if (!ack) throw new Error('no ack');
  return { code: r.code, ack };
}

async function balance(h: MockOkxHandle): Promise<OkxBalance> {
  const r = await rest<OkxBalance>(h, 'GET', '/api/v5/account/balance');
  const b = r.data[0];
  if (!b) throw new Error('no balance');
  return b;
}

async function positions(h: MockOkxHandle): Promise<OkxPosition[]> {
  return (await rest<OkxPosition>(h, 'GET', '/api/v5/account/positions?instType=SWAP')).data;
}

describe('net_mode trading', () => {
  let h: MockOkxHandle;
  beforeAll(async () => {
    h = await start({ seed: 99 });
  });
  afterAll(async () => {
    await h.close();
  });

  it('fills a market order with slippage, fees and a position', async () => {
    const before = await balance(h);
    const { code, ack } = await place(h, { instId: BTC, tdMode: 'cross', side: 'buy', ordType: 'market', sz: '50' });
    expect(code).toBe('0');
    expect(ack.sCode).toBe('0');
    expect(ack.ordId).toMatch(/^\d+$/);

    const o = (await rest<OkxOrder>(h, 'GET', `/api/v5/trade/order?instId=${BTC}&ordId=${ack.ordId}`)).data[0];
    expect(o).toMatchObject({ state: 'filled', accFillSz: '50', side: 'buy', posSide: 'net', ordType: 'market', px: '', feeCcy: 'USDT', reduceOnly: 'false' });
    expect(Number(o?.fee)).toBeLessThan(0);
    expect(Number(o?.avgPx)).toBeGreaterThan(60000);

    const fills = (await rest<OkxFill>(h, 'GET', `/api/v5/trade/fills?instType=SWAP&instId=${BTC}`)).data;
    expect(fills.length).toBeGreaterThan(1); // walked several levels
    expect(fills.every((f) => f.execType === 'T' && Number(f.fee) < 0 && f.ordId === ack.ordId)).toBe(true);
    const fillSum = fills.reduce((s, f) => s + Number(f.fillSz), 0);
    expect(fillSum).toBeCloseTo(50, 6);
    const feeSum = fills.reduce((s, f) => s + Number(f.fee), 0);
    expect(feeSum).toBeCloseTo(Number(o?.fee), 6);
    expect(Math.abs(feeSum)).toBeCloseTo(50 * 0.01 * Number(o?.avgPx) * 0.0005, 2);

    const pos = await positions(h);
    expect(pos).toHaveLength(1);
    expect(pos[0]).toMatchObject({ instId: BTC, posSide: 'net', pos: '50', mgnMode: 'cross', lever: '10', ccy: 'USDT' });
    expect(pos[0]?.avgPx).toBe(o?.avgPx);
    expect(Number(pos[0]?.liqPx)).toBeLessThan(Number(pos[0]?.avgPx));
    expect(Number(pos[0]?.margin)).toBeCloseTo((50 * 0.01 * Number(o?.avgPx)) / 10, 2);

    const after = await balance(h);
    const d0 = before.details[0];
    const d1 = after.details[0];
    expect(Number(d1?.cashBal)).toBeCloseTo(Number(d0?.cashBal) + feeSum, 6);
    expect(Number(d1?.availEq)).toBeLessThan(Number(d1?.eq) - 2000);
    expect(Number(after.totalEq)).toBeCloseTo(Number(d1?.cashBal) + Number(d1?.upl), 6);
  });

  it('rests a limit order, reserves margin, then cancels it', async () => {
    const { ack } = await place(h, { instId: BTC, tdMode: 'cross', side: 'buy', ordType: 'limit', sz: '10', px: '50000', clOrdId: 'rest1' });
    expect(ack.sCode).toBe('0');
    expect(ack.clOrdId).toBe('rest1');
    const pending = (await rest<OkxOrder>(h, 'GET', `/api/v5/trade/orders-pending?instType=SWAP&instId=${BTC}`)).data;
    expect(pending.map((o) => o.ordId)).toEqual([ack.ordId]);
    expect(pending[0]).toMatchObject({ state: 'live', px: '50000', sz: '10', accFillSz: '0', clOrdId: 'rest1' });
    const bal = await balance(h);
    expect(Number(bal.details[0]?.ordFrozen)).toBeCloseTo((10 * 0.01 * 50000) / 10, 6);

    const dup = await place(h, { instId: BTC, tdMode: 'cross', side: 'buy', ordType: 'limit', sz: '10', px: '50000', clOrdId: 'rest1' });
    expect(dup.code).toBe('1');
    expect(dup.ack.sCode).toBe('51016');

    const cancel = await rest<OkxOrderAck>(h, 'POST', '/api/v5/trade/cancel-order', { instId: BTC, clOrdId: 'rest1' });
    expect(cancel.code).toBe('0');
    expect(cancel.data[0]?.ordId).toBe(ack.ordId);
    expect((await rest<OkxOrder>(h, 'GET', `/api/v5/trade/orders-pending?instType=SWAP`)).data).toEqual([]);
    const hist = (await rest<OkxOrder>(h, 'GET', `/api/v5/trade/orders-history?instType=SWAP&instId=${BTC}&limit=1`)).data;
    expect(hist[0]).toMatchObject({ ordId: ack.ordId, state: 'canceled' });
    expect(Number((await balance(h)).details[0]?.ordFrozen)).toBe(0);
    const again = await rest<OkxOrderAck>(h, 'POST', '/api/v5/trade/cancel-order', { instId: BTC, ordId: ack.ordId });
    expect(again.code).toBe('1');
    expect(again.data[0]?.sCode).toBe('51401');
  });

  it('fills a resting limit when setPrice crosses it, as maker, reducing the position', async () => {
    const { ack } = await place(h, { instId: BTC, tdMode: 'cross', side: 'sell', ordType: 'limit', sz: '20', px: '62000' });
    expect(ack.sCode).toBe('0');
    h.setPrice(BTC, '61000');
    expect((await rest<OkxOrder>(h, 'GET', '/api/v5/trade/orders-pending?instType=SWAP')).data).toHaveLength(1);
    h.setPrice(BTC, '62500');
    expect((await rest<OkxOrder>(h, 'GET', '/api/v5/trade/orders-pending?instType=SWAP')).data).toHaveLength(0);
    const o = (await rest<OkxOrder>(h, 'GET', `/api/v5/trade/order?instId=${BTC}&ordId=${ack.ordId}`)).data[0];
    expect(o?.state).toBe('filled');
    expect(Number(o?.avgPx)).toBeGreaterThanOrEqual(62000);
    expect(Number(o?.pnl)).toBeGreaterThan(0);
    const fill = (await rest<OkxFill>(h, 'GET', `/api/v5/trade/fills?instType=SWAP&limit=1`)).data[0];
    expect(fill?.execType).toBe('M');
    expect(Math.abs(Number(fill?.fee))).toBeCloseTo(Number(fill?.fillSz) * 0.01 * Number(fill?.fillPx) * 0.0002, 4);
    const pos = await positions(h);
    expect(pos[0]?.pos).toBe('30');
  });

  it('rejects a crossing post_only with 51117 and validates parameters', async () => {
    const po = await place(h, { instId: BTC, tdMode: 'cross', side: 'buy', ordType: 'post_only', sz: '1', px: '70000' });
    expect(po.code).toBe('1');
    expect(po.ack.sCode).toBe('51117');
    expect((await place(h, { instId: 'XRP-USDT-SWAP', tdMode: 'cross', side: 'buy', ordType: 'market', sz: '1' })).ack.sCode).toBe('51001');
    expect((await place(h, { instId: BTC, tdMode: 'cross', side: 'buy', ordType: 'limit', sz: '1' })).ack.sCode).toBe('51000');
    expect((await place(h, { instId: BTC, tdMode: 'cross', side: 'buy', ordType: 'limit', sz: '1', px: '50000.05' })).ack.sCode).toBe('51000');
    expect((await place(h, { instId: BTC, tdMode: 'cross', side: 'buy', ordType: 'market', sz: '0.15' })).ack.sCode).toBe('51121');
    expect((await place(h, { instId: BTC, tdMode: 'cross', side: 'buy', ordType: 'market', sz: '0.05' })).ack.sCode).toBe('51121');
    expect((await place(h, { instId: BTC, tdMode: 'cross', side: 'buy', ordType: 'market', sz: '20000' })).ack.sCode).toBe('51004');
    expect((await place(h, { instId: BTC, tdMode: 'cross', side: 'buy', ordType: 'market', sz: '1', posSide: 'long' })).ack.sCode).toBe('51000');
    expect((await place(h, { instId: BTC, tdMode: 'cross', side: 'buy', ordType: 'market', sz: '1', reduceOnly: true })).ack.sCode).toBe('51119');
    expect((await place(h, { instId: BTC, tdMode: 'cross', side: 'buy', ordType: 'market', sz: '11000' })).ack.sCode).toBe('51008');
  });

  it('amends, uses ioc/fok semantics and closes the position', async () => {
    const { ack } = await place(h, { instId: BTC, tdMode: 'cross', side: 'buy', ordType: 'limit', sz: '5', px: '50000' });
    const am = await rest<OkxOrderAck>(h, 'POST', '/api/v5/trade/amend-order', { instId: BTC, ordId: ack.ordId, newPx: '51000', newSz: '6', reqId: 'r1' });
    expect(am.code).toBe('0');
    const o = (await rest<OkxOrder>(h, 'GET', `/api/v5/trade/order?instId=${BTC}&ordId=${ack.ordId}`)).data[0];
    expect(o).toMatchObject({ px: '51000', sz: '6', state: 'live' });
    const batch = await rest<OkxOrderAck>(h, 'POST', '/api/v5/trade/cancel-batch-orders', [{ instId: BTC, ordId: ack.ordId }, { instId: BTC, ordId: '1' }]);
    expect(batch.code).toBe('2');
    expect(batch.data.map((a) => a.sCode)).toEqual(['0', '51400']);

    const ioc = await place(h, { instId: BTC, tdMode: 'cross', side: 'sell', ordType: 'ioc', sz: '5', px: '1000000' });
    expect(ioc.ack.sCode).toBe('0');
    const iocOrder = (await rest<OkxOrder>(h, 'GET', `/api/v5/trade/order?instId=${BTC}&ordId=${ioc.ack.ordId}`)).data[0];
    expect(iocOrder?.state).toBe('canceled');
    const fok = await place(h, { instId: BTC, tdMode: 'cross', side: 'sell', ordType: 'fok', sz: '5', px: '1000000' });
    expect((await rest<OkxOrder>(h, 'GET', `/api/v5/trade/order?instId=${BTC}&ordId=${fok.ack.ordId}`)).data[0]?.state).toBe('canceled');

    const close = await rest(h, 'POST', '/api/v5/trade/close-position', { instId: BTC, mgnMode: 'cross' });
    expect(close.code).toBe('0');
    expect(close.data[0]).toMatchObject({ instId: BTC, posSide: 'net' });
    expect(await positions(h)).toEqual([]);
    const bal = await balance(h);
    expect(bal.details[0]?.upl).toBe('0');
    expect(bal.details[0]?.availEq).toBe(bal.details[0]?.eq);
    expect((await rest(h, 'POST', '/api/v5/trade/close-position', { instId: BTC, mgnMode: 'cross' })).code).toBe('51023');
    const state = h.getState();
    expect(state.positions).toEqual([]);
    expect(state.fills.length).toBeGreaterThan(5);
    expect(state.orders.some((x) => x.state === 'filled')).toBe(true);
  });
});

describe('long_short_mode trading', () => {
  let h: MockOkxHandle;
  beforeAll(async () => {
    h = await start({ posMode: 'long_short_mode', seed: 5 });
  });
  afterAll(async () => {
    await h.close();
  });

  it('requires posSide and keeps long and short positions apart', async () => {
    expect((await rest(h, 'GET', '/api/v5/account/config')).data[0]?.posMode).toBe('long_short_mode');
    const missing = await place(h, { instId: BTC, tdMode: 'cross', side: 'buy', ordType: 'market', sz: '1' });
    expect(missing.ack.sCode).toBe('51000');
    expect((await place(h, { instId: BTC, tdMode: 'cross', side: 'buy', ordType: 'market', sz: '1', posSide: 'net' })).ack.sCode).toBe('51000');
    expect((await place(h, { instId: BTC, tdMode: 'cross', side: 'buy', ordType: 'market', sz: '2', posSide: 'long' })).ack.sCode).toBe('0');
    expect((await place(h, { instId: BTC, tdMode: 'cross', side: 'sell', ordType: 'market', sz: '3', posSide: 'short' })).ack.sCode).toBe('0');
    const pos = await positions(h);
    expect(pos.map((p) => [p.posSide, p.pos]).sort()).toEqual([
      ['long', '2'],
      ['short', '3'],
    ]);
    // closing more than the position on the closing side is refused
    expect((await place(h, { instId: BTC, tdMode: 'cross', side: 'sell', ordType: 'market', sz: '5', posSide: 'long' })).ack.sCode).toBe('51119');
    expect((await place(h, { instId: BTC, tdMode: 'cross', side: 'sell', ordType: 'market', sz: '2', posSide: 'long' })).ack.sCode).toBe('0');
    const info = (await rest(h, 'GET', '/api/v5/account/leverage-info?instId=BTC-USDT-SWAP&mgnMode=cross')).data;
    expect(info.map((i) => i.posSide)).toEqual(['long', 'short']);
    const close = await rest(h, 'POST', '/api/v5/trade/close-position', { instId: BTC, mgnMode: 'cross', posSide: 'short' });
    expect(close.code).toBe('0');
    expect(await positions(h)).toEqual([]);
  });
});
