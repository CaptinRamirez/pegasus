import { describe, expect, it } from 'vitest';
import type { OkxInstrument, OkxOrder } from '@pegasus/okx';
import { fillFromOrderPush, mapInstrument, mapOrder } from '../src/okx/mappers.js';

const rawInst: OkxInstrument = {
  instType: 'SWAP', instId: 'BTC-USDT-SWAP', uly: 'BTC-USDT', instFamily: 'BTC-USDT', baseCcy: '', quoteCcy: '', settleCcy: 'USDT',
  ctVal: '0.01', ctMult: '1', ctValCcy: 'BTC', ctType: 'linear', lotSz: '0.1', minSz: '0.1', tickSz: '0.1', maxLmtSz: '100000', maxMktSz: '12000',
  lever: '100', state: 'live', listTime: '0', expTime: '',
};

const rawOrder: OkxOrder = {
  instType: 'SWAP', instId: 'BTC-USDT-SWAP', ordId: '1', clOrdId: 'pgabc', tag: '', tdMode: 'cross', side: 'buy', posSide: 'net', ordType: 'limit',
  px: '50000', sz: '2', accFillSz: '1', fillPx: '49999.9', fillSz: '1', fillTime: '1700000000123', tradeId: 't1', avgPx: '49999.9', state: 'partially_filled',
  lever: '5', reduceOnly: 'false', fee: '-0.25', feeCcy: 'USDT', pnl: '0', category: 'normal', cTime: '1700000000000', uTime: '1700000000123', execType: 'M', fillFee: '-0.1', fillFeeCcy: 'USDT',
};

describe('mappers', () => {
  it('derives base/quote from the underlying for swaps', () => {
    const inst = mapInstrument(rawInst);
    expect(inst.baseCcy).toBe('BTC');
    expect(inst.quoteCcy).toBe('USDT');
    expect(inst.ctType).toBe('linear');
    expect(inst.maxLever).toBe('100');
  });
  it('maps orders and extracts fills from pushes', () => {
    const o = mapOrder(rawOrder);
    expect(o.state).toBe('partially_filled');
    expect(o.reduceOnly).toBe(false);
    expect(o.cTime).toBe(1700000000000);
    const f = fillFromOrderPush(rawOrder);
    expect(f).toMatchObject({ tradeId: 't1', fillPx: '49999.9', fillSz: '1', fee: '-0.1', execType: 'M', ts: 1700000000123 });
    expect(fillFromOrderPush({ ...rawOrder, tradeId: '', fillSz: '0' })).toBeNull();
  });
});
