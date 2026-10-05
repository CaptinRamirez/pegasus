import { describe, expect, it } from 'vitest';
import type { OkxAlgoOrder, OkxInstrument, OkxOrder, OkxPosition } from '@pegasus/okx';
import { CANDLE_BARS, isLiquidationOrder } from '@pegasus/shared';
import { failedAttachedStop, fillFromOrderPush, fillKey, fromOkxBar, mapAlgoOrder, mapInstrument, mapOrder, mapPosition, toOkxBar } from '../src/okx/mappers.js';

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
  it('reads the attached stop-loss from attachAlgoOrds, else from the order itself, and leaves it out when there is none', () => {
    expect(mapOrder(rawOrder)).not.toHaveProperty('slTriggerPx');
    expect(mapOrder({ ...rawOrder, slTriggerPx: '', attachAlgoOrds: [] })).not.toHaveProperty('slTriggerPx');
    expect(mapOrder({ ...rawOrder, slTriggerPx: '', attachAlgoOrds: [{ attachAlgoClOrdId: 'slpgabc', slTriggerPx: '48000', slOrdPx: '-1', slTriggerPxType: 'mark' }] }).slTriggerPx).toBe('48000');
    // a take-profit only entry carries no stop
    expect(mapOrder({ ...rawOrder, attachAlgoOrds: [{ tpTriggerPx: '55000', tpOrdPx: '-1', slTriggerPx: '' }] })).not.toHaveProperty('slTriggerPx');
    expect(mapOrder({ ...rawOrder, slTriggerPx: '47000' }).slTriggerPx).toBe('47000');
  });
  it('does not show a stop the exchange failed to create', () => {
    const stop = { attachAlgoClOrdId: 'slpgabc', slTriggerPx: '48000', slOrdPx: '-1', slTriggerPxType: 'mark' as const };
    const failed = { ...rawOrder, slTriggerPx: '', attachAlgoOrds: [{ ...stop, failCode: '1', failReason: 'not created' }] };
    expect(mapOrder(failed)).not.toHaveProperty('slTriggerPx');
    // the reason travels with the order so that the terminal can tell the trader
    expect(mapOrder(failed).slFailReason).toBe('1: not created');
    expect(mapOrder({ ...rawOrder, attachAlgoOrds: [{ ...stop, failCode: '51279' }] }).slFailReason).toBe('51279: ');
    expect(failedAttachedStop(failed)).toMatchObject({ slTriggerPx: '48000', failCode: '1' });
    // an empty or zero failCode is a stop that exists
    for (const failCode of ['', '0']) {
      const ok = { ...rawOrder, attachAlgoOrds: [{ ...stop, failCode, failReason: '' }] };
      expect(mapOrder(ok).slTriggerPx).toBe('48000');
      expect(mapOrder(ok)).not.toHaveProperty('slFailReason');
      expect(failedAttachedStop(ok)).toBeNull();
    }
    expect(mapOrder(rawOrder)).not.toHaveProperty('slFailReason');
    expect(failedAttachedStop(rawOrder)).toBeNull();
  });
});

describe('algo orders', () => {
  const raw: OkxAlgoOrder = {
    instType: 'SWAP', instId: 'BTC-USDT-SWAP', algoId: '2001', algoClOrdId: 'slpgabc', ordType: 'conditional', side: 'sell', posSide: 'net', tdMode: 'cross',
    sz: '10', closeFraction: '', state: 'live', reduceOnly: 'true', tpTriggerPx: '', tpTriggerPxType: '', tpOrdPx: '',
    slTriggerPx: '59000', slTriggerPxType: 'mark', slOrdPx: '-1', cTime: '1700000000000', uTime: '1700000000500',
  };

  it('maps a stop with its trigger price type and times', () => {
    expect(mapAlgoOrder(raw)).toEqual({
      algoId: '2001', algoClOrdId: 'slpgabc', instId: 'BTC-USDT-SWAP', side: 'sell', posSide: 'net', tdMode: 'cross', sz: '10', closeFraction: '',
      slTriggerPx: '59000', slTriggerPxType: 'mark', slOrdPx: '-1', tpTriggerPx: '', cTime: 1700000000000, uTime: 1700000000500,
    });
  });

  it('reads a stop without a trigger price type as last-triggered, and a take-profit only order as having no stop', () => {
    expect(mapAlgoOrder({ ...raw, slTriggerPxType: '' }).slTriggerPxType).toBe('last');
    expect(mapAlgoOrder({ ...raw, slTriggerPx: '', slTriggerPxType: '', slOrdPx: '', tpTriggerPx: '65000' })).toMatchObject({ slTriggerPx: '', slTriggerPxType: '', tpTriggerPx: '65000' });
    expect(mapAlgoOrder({ ...raw, sz: '', closeFraction: '1', posSide: 'long', tdMode: 'isolated' })).toMatchObject({ sz: '', closeFraction: '1', posSide: 'long', tdMode: 'isolated' });
  });
});

describe('position margin', () => {
  const raw: OkxPosition = {
    instType: 'SWAP', instId: 'BTC-USDT-SWAP', mgnMode: 'cross', posId: '1', posSide: 'long', pos: '3', availPos: '3', avgPx: '60000', markPx: '61000',
    upl: '30', uplRatio: '0.05', lever: '3', liqPx: '', margin: '', imr: '610', mgnRatio: '', mmr: '7.32', notionalUsd: '1830', ccy: 'USDT', cTime: '1700000000000', uTime: '1700000000123',
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
  it('carries what an isolated position is liquidated by: its liquidation price, margin level and maintenance requirement', () => {
    // a 10x isolated long of the mock's BTC swap (0.004 maintenance rate, 0.0005 taker fee)
    const isolated: OkxPosition = { ...raw, mgnMode: 'isolated', posSide: 'net', pos: '1', avgPx: '60000.1', markPx: '60000', upl: '-0.001', lever: '100', liqPx: '54249.48', margin: '60.0001', imr: '', mgnRatio: '22.72', mmr: '2.4', notionalUsd: '600' };
    expect(mapPosition(isolated)).toMatchObject({ mgnMode: 'isolated', posSide: 'net', pos: '1', lever: '100', liqPx: '54249.48', margin: '60.0001', mgnRatio: '22.72', mmr: '2.4', notionalUsd: '600' });
    // not reported is left out, never 0: a margin level of 0 would read as a position about to be liquidated
    expect(mapPosition(raw)).not.toHaveProperty('mgnRatio');
    expect(mapPosition({ ...raw, mmr: '' })).not.toHaveProperty('mmr');
    expect(mapPosition({ ...raw, mmr: '' })).not.toHaveProperty('mgnRatio');
  });
});

describe('orders and fills of a liquidation', () => {
  // the order OKX closes a liquidated isolated position with, as the orders channel pushes it
  const liquidation: OkxOrder = {
    ...rawOrder, ordId: '901', clOrdId: '', tdMode: 'isolated', side: 'sell', ordType: 'market', px: '', sz: '1', accFillSz: '1', fillPx: '54030.2', fillSz: '1', tradeId: '0',
    avgPx: '54030.2', state: 'filled', lever: '100', reduceOnly: 'true', fee: '-0.27', pnl: '-59.73', category: 'full_liquidation', execType: '', fillFee: '-0.27',
  };

  it('maps the category, so that a liquidation can be told from a close of the trader', () => {
    expect(mapOrder(liquidation)).toMatchObject({ ordId: '901', state: 'filled', tdMode: 'isolated', category: 'full_liquidation' });
    expect(isLiquidationOrder(mapOrder(liquidation))).toBe(true);
    expect(mapOrder(rawOrder).category).toBe('normal');
    expect(isLiquidationOrder(mapOrder(rawOrder))).toBe(false);
    expect(mapOrder({ ...liquidation, category: 'partial_liquidation' }).category).toBe('partial_liquidation');
    // one this code does not know is left out rather than guessed
    expect(mapOrder({ ...rawOrder, category: 'something_new' })).not.toHaveProperty('category');
    expect(mapOrder({ ...rawOrder, category: '' })).not.toHaveProperty('category');
  });

  it('keys the fills of two liquidations of one instrument apart: both carry trade id 0', () => {
    const first = fillFromOrderPush(liquidation);
    const second = fillFromOrderPush({ ...liquidation, ordId: '902', fillSz: '2' });
    expect(first).toMatchObject({ tradeId: '0', ordId: '901', fillSz: '1', fee: '-0.27', execType: '' });
    expect(second).toMatchObject({ tradeId: '0', ordId: '902', fillSz: '2' });
    if (!first || !second) throw new Error('no fill');
    expect(fillKey(first)).not.toBe(fillKey(second));
    // the same fill pushed twice has one key
    expect(fillKey(first)).toBe(fillKey({ ...first }));
    // trade ids are unique per instrument only
    expect(fillKey({ ...first, instId: 'ETH-USDT-SWAP' })).not.toBe(fillKey(first));
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
