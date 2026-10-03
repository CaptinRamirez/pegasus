import { describe, expect, it } from 'vitest';
import postgres from 'postgres';
import type { Fill, Order } from '@pegasus/shared';
import { PgStore } from '../src/db/pg-store.js';

const url = process.env['TEST_DATABASE_URL'];

describe.skipIf(!url)('PgStore', () => {
  it('migrates and round-trips orders, fills, settings and risk events', async () => {
    // Start from a journal created by the first release, whose fills key was trade_id alone.
    const raw = postgres(url!, { max: 1, onnotice: () => {} });
    await raw.unsafe(`DROP TABLE IF EXISTS fills; CREATE TABLE fills (
      trade_id text PRIMARY KEY, ord_id text NOT NULL, cl_ord_id text NOT NULL DEFAULT '', inst_id text NOT NULL, side text NOT NULL,
      pos_side text NOT NULL, fill_px numeric NOT NULL, fill_sz numeric NOT NULL, fee numeric NOT NULL DEFAULT 0, fee_ccy text NOT NULL DEFAULT '',
      exec_type text NOT NULL DEFAULT '', ts bigint NOT NULL)`);
    const store = new PgStore(url!);
    await store.migrate();
    await store.migrate(); // idempotent
    const pk = await raw.unsafe(`SELECT array_length(conkey, 1) AS n FROM pg_constraint WHERE conname = 'fills_pkey' AND conrelid = 'fills'::regclass`);
    expect(Number(pk[0]?.['n'])).toBe(2);
    await raw.end();
    const order: Order = {
      ordId: `o-${Date.now()}`, clOrdId: 'pgtest', instId: 'BTC-USDT-SWAP', side: 'buy', posSide: 'net', tdMode: 'cross', ordType: 'limit', px: '50000.5', sz: '2.5',
      accFillSz: '0', avgPx: '', state: 'live', reduceOnly: false, lever: '5', fee: '0', feeCcy: '', pnl: '0', cTime: Date.now(), uTime: Date.now(),
    };
    await store.upsertOrder(order);
    await store.upsertOrder({ ...order, state: 'filled', accFillSz: '2.5', avgPx: '50000.5', fee: '-0.0625', feeCcy: 'USDT', uTime: order.uTime + 1 });
    const orders = await store.listOrders({ instId: 'BTC-USDT-SWAP', limit: 5 });
    const found = orders.find((o) => o.ordId === order.ordId);
    expect(found?.state).toBe('filled');
    expect(found?.sz).toBe('2.5');
    expect(found?.fee).toBe('-0.0625');
    const fill: Fill = { tradeId: `t-${Date.now()}`, ordId: order.ordId, clOrdId: 'pgtest', instId: 'BTC-USDT-SWAP', side: 'buy', posSide: 'net', fillPx: '50000.5', fillSz: '2.5', fee: '-0.0625', feeCcy: 'USDT', execType: 'M', ts: Date.now() };
    await store.upsertFill(fill);
    await store.upsertFill(fill);
    const fills = await store.listFills({ instId: 'BTC-USDT-SWAP', limit: 5 });
    expect(fills.find((f) => f.tradeId === fill.tradeId)?.fillSz).toBe('2.5');
    // the same trade id on another instrument is a different fill
    await store.upsertFill({ ...fill, instId: 'ETH-USDT-SWAP', fillSz: '7' });
    expect((await store.listFills({ instId: 'ETH-USDT-SWAP', limit: 5 })).find((f) => f.tradeId === fill.tradeId)?.fillSz).toBe('7');
    expect((await store.listFills({ instId: 'BTC-USDT-SWAP', limit: 5 })).find((f) => f.tradeId === fill.tradeId)?.fillSz).toBe('2.5');
    await store.setSetting('risk.state', { killSwitch: true, killSwitchReason: 'x', dayStartTs: 1, dayStartEquity: '10' });
    expect(await store.getSetting<{ killSwitch: boolean }>('risk.state')).toMatchObject({ killSwitch: true });
    await store.addRiskEvent('TEST', { a: 1 });
    await store.close();
  });
});
