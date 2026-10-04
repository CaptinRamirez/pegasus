import { describe, expect, it } from 'vitest';
import type { OkxInstrument, OkxOrder, OkxPosition } from '@pegasus/okx';
import { CANDLE_BARS } from '@pegasus/shared';
import { fillFromOrderPush, fromOkxBar, mapInstrument, mapOrder, mapPosition, toOkxBar } from '../src/okx/mappers.js';

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

describe('position margin', () => {
  const raw: OkxPosition = {
    instType: 'SWAP', instId: 'BTC-USDT-SWAP', mgnMode: 'cross', posId: '1', posSide: 'long', pos: '3', availPos: '3', avgPx: '60000', markPx: '61000',
    upl: '30', uplRatio: '0.05', lever: '3', liqPx: '', margin: '', imr: '610', notionalUsd: '1830', ccy: 'USDT', cTime: '1700000000000', uTime: '1700000000123',
  };
  it('takes the requirement (imr) for a cross position, which OKX reports without a margin', () => {
    expect(mapPosition(raw).margin).toBe('610');
  });
  it('takes the posted margin of an isolated position', () => {
    expect(mapPosition({ ...raw, mgnMode: 'isolated', margin: '600', imr: '' }).margin).toBe('600');
  });
  it('leaves the margin empty when OKX reports neither, instead of claiming 0', () => {
    expect(mapPosition({ ...raw, imr: '' }).margin).toBe('');
  });
});

describe('candle bar names on the wire', () => {
  it('sends the bars OKX aligns to UTC+8 as their UTC variant and maps them back', () => {
    expect(CANDLE_BARS.map(toOkxBar)).toEqual(['1m', '3m', '5m', '15m', '30m', '1H', '2H', '4H', '6Hutc', '12Hutc', '1Dutc', '1Wutc']);
    for (const bar of CANDLE_BARS) expect(fromOkxBar(toOkxBar(bar))).toBe(bar);
    // the UTC+8 day is a different bar: it must never be taken for the terminal's 1D
    expect(fromOkxBar('1D')).toBeNull();
    expect(fromOkxBar('1M')).toBeNull();
  });
});
