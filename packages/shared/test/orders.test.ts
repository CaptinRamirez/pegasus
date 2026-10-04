import { describe, expect, it } from 'vitest';
import { algoOrderClosesPosition, positionDirection, stopCoverage, stopsOfPosition, type AlgoOrder, type Position } from '../src/index.js';

const BTC = 'BTC-USDT-SWAP';

const position = (overrides: Partial<Position> = {}): Position => ({
  instId: BTC, posSide: 'net', mgnMode: 'cross', pos: '10', avgPx: '60000', markPx: '61000', upl: '0', uplRatio: '0', lever: '3', liqPx: '', margin: '', notionalUsd: '6100', cTime: 1, uTime: 1,
  ...overrides,
});

const stop = (overrides: Partial<AlgoOrder> = {}): AlgoOrder => ({
  algoId: 'a1', algoClOrdId: '', instId: BTC, side: 'sell', posSide: 'net', tdMode: 'cross', sz: '10', closeFraction: '', slTriggerPx: '59000', slTriggerPxType: 'mark', slOrdPx: '-1', tpTriggerPx: '', cTime: 1, uTime: 1,
  ...overrides,
});

describe('positionDirection', () => {
  it('reads the leg in long/short mode and the sign of the size in net mode', () => {
    expect(positionDirection({ posSide: 'long', pos: '3' })).toBe('long');
    expect(positionDirection({ posSide: 'short', pos: '3' })).toBe('short');
    expect(positionDirection({ posSide: 'net', pos: '3' })).toBe('long');
    expect(positionDirection({ posSide: 'net', pos: '-3' })).toBe('short');
    expect(positionDirection({ posSide: 'net', pos: '0' })).toBeNull();
    expect(positionDirection({ posSide: 'long', pos: '' })).toBeNull();
  });
});

describe('stops of a position', () => {
  it('a stop belongs to the position of its instrument, margin mode and leg, on the closing side', () => {
    expect(algoOrderClosesPosition(stop(), position())).toBe(true);
    expect(algoOrderClosesPosition(stop({ side: 'buy' }), position({ pos: '-10' }))).toBe(true);
    // the wrong side would add to the position, not close it
    expect(algoOrderClosesPosition(stop({ side: 'buy' }), position())).toBe(false);
    expect(algoOrderClosesPosition(stop(), position({ pos: '-10' }))).toBe(false);
    expect(algoOrderClosesPosition(stop({ instId: 'ETH-USDT-SWAP' }), position())).toBe(false);
    expect(algoOrderClosesPosition(stop({ tdMode: 'isolated' }), position())).toBe(false);
    // long/short mode: each leg has its own stops
    expect(algoOrderClosesPosition(stop({ posSide: 'long' }), position({ posSide: 'long' }))).toBe(true);
    expect(algoOrderClosesPosition(stop({ posSide: 'long' }), position({ posSide: 'short' }))).toBe(false);
    expect(algoOrderClosesPosition(stop({ posSide: 'short', side: 'buy' }), position({ posSide: 'short' }))).toBe(true);
    expect(algoOrderClosesPosition(stop(), position({ pos: '0' }))).toBe(false);
  });

  it('a take-profit only order is not a stop', () => {
    const tp = stop({ algoId: 'tp', slTriggerPx: '', slTriggerPxType: '', slOrdPx: '', tpTriggerPx: '65000' });
    expect(stopsOfPosition(position(), [tp, stop()]).map((s) => s.algoId)).toEqual(['a1']);
    expect(stopCoverage(position(), [tp]).state).toBe('none');
  });
});

describe('stopCoverage', () => {
  it('none without a stop, full when the stops close exactly the position', () => {
    expect(stopCoverage(position(), [])).toEqual({ state: 'none', stops: [], covered: '0', size: '10' });
    expect(stopCoverage(position(), [stop()])).toMatchObject({ state: 'full', covered: '10', size: '10' });
    // two lots of the two daily cuts, each with its own stop
    const lots = [stop({ algoId: 'a1', sz: '5', slTriggerPx: '59000' }), stop({ algoId: 'a2', sz: '5', slTriggerPx: '58000' })];
    expect(stopCoverage(position(), lots)).toMatchObject({ state: 'full', covered: '10' });
    expect(stopCoverage(position({ pos: '-10' }), [stop({ side: 'buy' })]).state).toBe('full');
  });

  it('partial when part of the position has no stop, over when a closed lot left its stop behind', () => {
    expect(stopCoverage(position(), [stop({ sz: '4' })])).toMatchObject({ state: 'partial', covered: '4', size: '10' });
    expect(stopCoverage(position({ pos: '5' }), [stop({ algoId: 'a1', sz: '5' }), stop({ algoId: 'a2', sz: '5' })])).toMatchObject({ state: 'over', covered: '10', size: '5' });
  });

  it('a stop that closes the whole position covers it whatever its size; with a sized stop beside it the two overlap', () => {
    const whole = stop({ sz: '', closeFraction: '1' });
    expect(stopCoverage(position({ pos: '37' }), [whole])).toMatchObject({ state: 'full', covered: '37', size: '37' });
    expect(stopCoverage(position(), [whole, stop({ algoId: 'a2', sz: '5' })]).state).toBe('over');
    expect(stopCoverage(position(), [stop({ sz: '', closeFraction: '0.5' })])).toMatchObject({ state: 'partial', covered: '5' });
  });

  it('counts fractional contract sizes exactly', () => {
    expect(stopCoverage(position({ pos: '0.3' }), [stop({ algoId: 'a1', sz: '0.1' }), stop({ algoId: 'a2', sz: '0.2' })])).toMatchObject({ state: 'full', covered: '0.3' });
  });
});
