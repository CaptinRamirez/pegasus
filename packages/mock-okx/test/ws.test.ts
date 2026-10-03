import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { bookChecksum } from '../src/checksum.js';
import type { MockOkxHandle, OkxBookData, OkxOrder, OkxPosition } from '../src/index.js';
import { CREDS, isData, isEvent, rest, start, wsLoginArgs, WsProbe } from './helpers.js';

const BTC = 'BTC-USDT-SWAP';

let h: MockOkxHandle;

beforeAll(async () => {
  h = await start({ credentials: CREDS, seed: 2024 });
});
afterAll(async () => {
  await h.close();
});

describe('public websocket', () => {
  it('answers ping with pong and rejects unknown channels', async () => {
    const ws = await WsProbe.connect(`${h.wsPublicUrl}?brokerId=9999`);
    ws.send('ping');
    expect(await ws.next((_m, text) => text === 'pong')).toBe('pong');
    ws.send({ op: 'subscribe', args: [{ channel: 'nope', instId: BTC }] });
    const err = await ws.next(isEvent('error'));
    expect(err['code']).toBe('60018');
    expect(err['msg']).toContain('channel:nope,instId:BTC-USDT-SWAP');
    ws.send({ op: 'subscribe', args: [{ channel: 'orders', instType: 'SWAP' }] });
    const priv = await ws.next(isEvent('error'));
    expect(priv).toMatchObject({ code: '60011', msg: 'Please log in' });
    await ws.close();
  });

  it('pushes tickers, trades, mark price and candles on each tick', async () => {
    const ws = await WsProbe.connect(h.wsPublicUrl);
    ws.send({ op: 'subscribe', args: [{ channel: 'tickers', instId: BTC }, { channel: 'trades', instId: BTC }, { channel: 'mark-price', instId: BTC }, { channel: 'books5', instId: BTC }, { channel: 'bbo-tbt', instId: BTC }] });
    for (const ch of ['tickers', 'trades', 'mark-price', 'books5', 'bbo-tbt']) {
      const ack = await ws.next(isEvent('subscribe', ch));
      expect(ack['arg']).toEqual({ channel: ch, instId: BTC });
    }
    await ws.next(isData('tickers')); // initial push
    h.tick();
    const t = await ws.next<{ data: Array<Record<string, string>> }>(isData('tickers'));
    expect(t.data[0]?.instId).toBe(BTC);
    const tr = await ws.next<{ data: Array<Record<string, string>> }>(isData('trades'));
    expect(tr.data[0]).toMatchObject({ instId: BTC });
    expect(['buy', 'sell']).toContain(tr.data[0]?.side);
    const mp = await ws.next<{ data: Array<Record<string, string>> }>(isData('mark-price'));
    expect(mp.data[0]?.markPx).toMatch(/^\d+(\.\d+)?$/);
    const b5 = await ws.next<{ data: OkxBookData[]; action?: string }>(isData('books5'));
    expect(b5.action).toBeUndefined();
    expect(b5.data[0]?.asks).toHaveLength(5);
    const bbo = await ws.next<{ data: OkxBookData[] }>(isData('bbo-tbt'));
    expect(bbo.data[0]?.bids).toHaveLength(1);
    ws.send({ op: 'unsubscribe', args: [{ channel: 'trades', instId: BTC }] });
    expect((await ws.next(isEvent('unsubscribe')))['arg']).toEqual({ channel: 'trades', instId: BTC });
    await ws.close();

    const biz = await WsProbe.connect(h.wsBusinessUrl);
    biz.send({ op: 'subscribe', args: [{ channel: 'candle1m', instId: BTC }, { channel: 'tickers', instId: BTC }] });
    await biz.next(isEvent('subscribe', 'candle1m'));
    expect((await biz.next(isEvent('error')))['code']).toBe('60018');
    h.tick();
    const c = await biz.next<{ data: string[][] }>(isData('candle1m'));
    expect(c.data[0]).toHaveLength(9);
    expect(c.data[0]?.[8]).toBe('0');
    await biz.close();
  });

  it('keeps a client-side books mirror in sync with every checksum', async () => {
    const ws = await WsProbe.connect(h.wsPublicUrl);
    ws.send({ op: 'subscribe', args: [{ channel: 'books', instId: BTC }] });
    await ws.next(isEvent('subscribe', 'books'));
    const snap = await ws.next<{ action: string; data: OkxBookData[] }>(isData('books', 'snapshot'));
    const bids = new Map<string, string>();
    const asks = new Map<string, string>();
    const apply = (side: Map<string, string>, levels: OkxBookData['asks']): void => {
      for (const [px, sz] of levels) {
        if (sz === '0') side.delete(px);
        else side.set(px, sz);
      }
    };
    const top = (side: Map<string, string>, desc: boolean): Array<[string, string]> =>
      [...side.entries()].sort((a, b) => (desc ? Number(b[0]) - Number(a[0]) : Number(a[0]) - Number(b[0]))).slice(0, 25);
    const first = snap.data[0];
    if (!first) throw new Error('empty snapshot');
    expect(first.prevSeqId).toBe(-1);
    expect(first.asks).toHaveLength(50);
    expect(first.bids).toHaveLength(50);
    apply(bids, first.bids);
    apply(asks, first.asks);
    expect(bookChecksum(top(bids, true), top(asks, false))).toBe(first.checksum);
    let seq = first.seqId ?? -1;
    let updates = 0;
    // mix of random ticks, a price jump and a market order consuming liquidity
    const actions: Array<() => Promise<void> | void> = [
      () => h.tick(),
      () => h.tick(),
      () => h.setPrice(BTC, '60100'),
      async () => {
        const r = await rest(h, 'POST', '/api/v5/trade/order', { instId: BTC, tdMode: 'cross', side: 'buy', ordType: 'market', sz: '30' }, CREDS);
        expect(r.code).toBe('0');
      },
      () => h.tick(),
      () => h.tick(),
    ];
    for (const act of actions) {
      await act();
      const upd = await ws.next<{ action: string; data: OkxBookData[] }>(isData('books', 'update'));
      const u = upd.data[0];
      if (!u) throw new Error('empty update');
      expect(u.prevSeqId).toBe(seq);
      expect(u.seqId ?? -1).toBeGreaterThan(seq);
      seq = u.seqId ?? seq;
      apply(bids, u.bids);
      apply(asks, u.asks);
      expect(bookChecksum(top(bids, true), top(asks, false))).toBe(u.checksum);
      updates += 1;
    }
    expect(updates).toBe(actions.length);
    const restBook = (await rest<OkxBookData>(h, 'GET', `/api/v5/market/books?instId=${BTC}&sz=50`)).data[0];
    expect(top(bids, true).slice(0, 5)).toEqual(restBook?.bids.slice(0, 5).map((l) => [l[0], l[1]]));
    await ws.close();
  });
});

describe('private websocket', () => {
  it('pushes orders, positions and account after login; supports trade ops', async () => {
    const ws = await WsProbe.connect(h.wsPrivateUrl);
    ws.send({ op: 'subscribe', args: [{ channel: 'orders', instType: 'SWAP' }] });
    expect((await ws.next(isEvent('error')))['code']).toBe('60011');
    ws.send({ op: 'login', args: [wsLoginArgs(CREDS)] });
    expect((await ws.next(isEvent('login')))['code']).toBe('0');
    ws.send({ op: 'subscribe', args: [{ channel: 'orders', instType: 'SWAP' }, { channel: 'positions', instType: 'ANY' }, { channel: 'account' }] });
    await ws.next(isEvent('subscribe', 'orders'));
    await ws.next(isEvent('subscribe', 'positions'));
    await ws.next(isEvent('subscribe', 'account'));
    await ws.next(isData('account')); // initial snapshot
    await ws.next(isData('positions')); // initial (empty) snapshot

    const r = await rest(h, 'POST', '/api/v5/trade/order', { instId: 'ETH-USDT-SWAP', tdMode: 'cross', side: 'sell', ordType: 'market', sz: '10', clOrdId: 'wsflow1' }, CREDS);
    expect(r.code).toBe('0');
    const live = await ws.next<{ arg: Record<string, string>; data: OkxOrder[] }>(isData('orders'));
    expect(live.arg).toMatchObject({ channel: 'orders', instType: 'SWAP' });
    expect(live.data[0]).toMatchObject({ clOrdId: 'wsflow1', state: 'live', fillSz: '0' });
    let last: OkxOrder | undefined;
    for (;;) {
      const m = await ws.next<{ data: OkxOrder[] }>(isData('orders'));
      last = m.data[0];
      expect(last?.clOrdId).toBe('wsflow1');
      expect(['partially_filled', 'filled']).toContain(last?.state);
      expect(last?.execType).toBe('T');
      expect(Number(last?.fillSz)).toBeGreaterThan(0);
      expect(Number(last?.fillFee)).toBeLessThan(0);
      expect(last?.tradeId).toMatch(/^\d+$/);
      expect(last?.fillTime).toMatch(/^\d+$/);
      if (last?.state === 'filled') break;
    }
    expect(last?.accFillSz).toBe('10');
    const pos = await ws.next<{ arg: Record<string, string>; data: OkxPosition[] }>(isData('positions'));
    expect(pos.arg).toMatchObject({ channel: 'positions', instType: 'ANY' });
    expect(pos.data.find((p) => p.instId === 'ETH-USDT-SWAP')).toMatchObject({ pos: '-10', posSide: 'net' });
    const acct = await ws.next<{ data: Array<{ details: Array<Record<string, string>> }> }>(isData('account'));
    expect(Number(acct.data[0]?.details[0]?.cashBal)).toBeLessThan(100000);

    ws.send({ id: 'op1', op: 'order', args: [{ instId: 'ETH-USDT-SWAP', tdMode: 'cross', side: 'buy', ordType: 'market', sz: '10', reduceOnly: true }] });
    const resp = await ws.next<{ id: string; op: string; code: string; data: Array<Record<string, string>> }>((m) => (m as { id?: string }).id === 'op1');
    expect(resp).toMatchObject({ id: 'op1', op: 'order', code: '0' });
    expect(resp.data[0]?.sCode).toBe('0');
    let closed: OkxPosition | undefined;
    for (let i = 0; i < 5 && !closed; i++) {
      const p = await ws.next<{ data: OkxPosition[] }>(isData('positions'));
      closed = p.data.find((x) => x.instId === 'ETH-USDT-SWAP' && x.pos === '0');
    }
    expect(closed).toBeDefined();
    ws.send({ id: 'op2', op: 'cancel-order', args: [{ instId: 'ETH-USDT-SWAP', ordId: '42' }] });
    const bad = await ws.next<{ code: string; data: Array<Record<string, string>> }>((m) => (m as { id?: string }).id === 'op2');
    expect(bad.code).toBe('1');
    expect(bad.data[0]?.sCode).toBe('51400');
    await ws.close();
  });
});
