import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { MockOkxHandle } from '../src/index.js';
import { rest, start, WsProbe } from './helpers.js';

const BTC = 'BTC-USDT-SWAP';

describe('API key permissions', () => {
  let h: MockOkxHandle;
  beforeAll(async () => {
    h = await start({ perm: 'read_only' });
  });
  afterAll(async () => {
    await h.close();
  });

  it('reports read_only,trade by default and the configured permissions otherwise', async () => {
    const full = await start();
    try {
      expect((await rest(full, 'GET', '/api/v5/account/config')).data[0]?.['perm']).toBe('read_only,trade');
    } finally {
      await full.close();
    }
    expect((await rest(h, 'GET', '/api/v5/account/config')).data[0]?.['perm']).toBe('read_only');
  });

  it('a key without the trade permission can read but every trade endpoint is refused', async () => {
    expect((await rest(h, 'GET', '/api/v5/account/balance')).code).toBe('0');
    expect((await rest(h, 'GET', '/api/v5/trade/orders-pending?instType=SWAP')).code).toBe('0');
    const order = { instId: BTC, tdMode: 'cross', side: 'buy', ordType: 'market', sz: '1' };
    const writes: Array<[string, unknown]> = [
      ['/api/v5/trade/order', order],
      ['/api/v5/trade/batch-orders', [order]],
      ['/api/v5/trade/cancel-order', { instId: BTC, ordId: '1' }],
      ['/api/v5/trade/cancel-batch-orders', [{ instId: BTC, ordId: '1' }]],
      ['/api/v5/trade/amend-order', { instId: BTC, ordId: '1', newSz: '2' }],
      ['/api/v5/trade/close-position', { instId: BTC, mgnMode: 'cross' }],
      ['/api/v5/account/set-leverage', { instId: BTC, lever: '3', mgnMode: 'cross' }],
    ];
    for (const [path, body] of writes) {
      const r = await rest(h, 'POST', path, body);
      expect(r.code, path).not.toBe('0');
      expect(r.data, path).toEqual([]);
      expect(r.msg, path).toMatch(/permission/i);
    }
    expect(h.getState().orders).toEqual([]);
    expect((await rest(h, 'GET', `/api/v5/account/leverage-info?instId=${BTC}&mgnMode=cross`)).data[0]?.['lever']).not.toBe('3');
  });

  it('refuses trade ops over the private websocket too', async () => {
    const ws = await WsProbe.connect(h.wsPrivateUrl);
    ws.send({ op: 'login', args: [{}] });
    ws.send({ id: 'op1', op: 'order', args: [{ instId: BTC, tdMode: 'cross', side: 'buy', ordType: 'market', sz: '1' }] });
    const resp = await ws.next<{ code: string; msg: string; data: unknown[] }>((m) => (m as { id?: string }).id === 'op1');
    expect(resp.code).not.toBe('0');
    expect(resp.msg).toMatch(/permission/i);
    expect(resp.data).toEqual([]);
    expect(h.getState().orders).toEqual([]);
    await ws.close();
  });
});
