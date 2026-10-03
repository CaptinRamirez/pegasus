import { describe, expect, it } from 'vitest';
import type { Fill, Order } from '@pegasus/shared';
import { MemoryStore } from '../src/db/store.js';

const fill: Fill = { tradeId: '1', ordId: 'o1', clOrdId: '', instId: 'BTC-USDT-SWAP', side: 'buy', posSide: 'net', fillPx: '50000', fillSz: '1', fee: '0', feeCcy: 'USDT', execType: 'T', ts: 1 };
const order: Order = {
  ordId: 'o1', clOrdId: '', instId: 'BTC-USDT-SWAP', side: 'buy', posSide: 'net', tdMode: 'cross', ordType: 'limit', px: '50000', sz: '1', accFillSz: '0', avgPx: '',
  state: 'live', reduceOnly: false, lever: '5', fee: '0', feeCcy: '', pnl: '0', cTime: 1, uTime: 10,
};

describe('MemoryStore', () => {
  it('keys fills by instrument and trade id', async () => {
    const s = new MemoryStore();
    await s.upsertFill(fill);
    await s.upsertFill({ ...fill, instId: 'ETH-USDT-SWAP', fillSz: '7' });
    expect((await s.listFills({ limit: 10 })).map((f) => f.instId).sort()).toEqual(['BTC-USDT-SWAP', 'ETH-USDT-SWAP']);
    expect((await s.listFills({ instId: 'ETH-USDT-SWAP', limit: 10 }))[0]?.fillSz).toBe('7');
  });
  it('never regresses an order to an older snapshot', async () => {
    const s = new MemoryStore();
    await s.upsertOrder({ ...order, state: 'filled', accFillSz: '1', uTime: 20 });
    await s.upsertOrder(order); // older uTime
    expect((await s.listOrders({ limit: 10 }))[0]?.state).toBe('filled');
  });
});
