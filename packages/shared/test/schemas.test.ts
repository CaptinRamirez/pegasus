import { describe, expect, it } from 'vitest';
import { amendAlgoOrderRequestSchema, cancelAlgoOrderRequestSchema, placeOrderRequestSchema, placeStopRequestSchema } from '../src/index.js';

describe('placeOrderRequestSchema', () => {
  const base = { instId: 'BTC-USDT-SWAP', side: 'buy', ordType: 'limit', px: '50000', size: { unit: 'contracts', value: '1' } };

  it('accepts an order without a stop and leaves slTriggerPx out', () => {
    const parsed = placeOrderRequestSchema.parse(base);
    expect(parsed).not.toHaveProperty('slTriggerPx');
  });

  it('accepts a positive decimal string as the stop-loss trigger', () => {
    expect(placeOrderRequestSchema.parse({ ...base, slTriggerPx: '48000.5' }).slTriggerPx).toBe('48000.5');
    expect(placeOrderRequestSchema.parse({ ...base, ordType: 'market', px: undefined, slTriggerPx: '48000' }).slTriggerPx).toBe('48000');
  });

  it('refuses a stop-loss trigger that is not a positive decimal string', () => {
    for (const slTriggerPx of ['0', '0.00', '-48000', '', 'abc', '1e5', 48000, null]) {
      const res = placeOrderRequestSchema.safeParse({ ...base, slTriggerPx });
      expect(res.success, String(slTriggerPx)).toBe(false);
      if (!res.success) expect(res.error.issues[0]?.path).toEqual(['slTriggerPx']);
    }
  });
});

describe('algo order requests', () => {
  const base = { instId: 'BTC-USDT-SWAP', algoId: '2000000000000001' };

  it('accepts a move of the stop to a positive price and a cancel by algoId', () => {
    expect(amendAlgoOrderRequestSchema.parse({ ...base, slTriggerPx: '59500.5' })).toEqual({ ...base, slTriggerPx: '59500.5' });
    expect(cancelAlgoOrderRequestSchema.parse(base)).toEqual(base);
  });

  it('refuses a stop price that is not a positive decimal string: 0 would remove the stop', () => {
    for (const slTriggerPx of ['0', '-1', '', 'abc', 59500, undefined]) {
      expect(amendAlgoOrderRequestSchema.safeParse({ ...base, slTriggerPx }).success, String(slTriggerPx)).toBe(false);
    }
  });

  it('refuses a missing or malformed algoId and an instrument that is not a swap', () => {
    expect(cancelAlgoOrderRequestSchema.safeParse({ instId: 'BTC-USDT-SWAP' }).success).toBe(false);
    expect(cancelAlgoOrderRequestSchema.safeParse({ instId: 'BTC-USDT-SWAP', algoId: '' }).success).toBe(false);
    expect(cancelAlgoOrderRequestSchema.safeParse({ instId: 'BTC-USDT-SWAP', algoId: '1&instId=x' }).success).toBe(false);
    expect(amendAlgoOrderRequestSchema.safeParse({ instId: 'BTC-USDT', algoId: '1', slTriggerPx: '1' }).success).toBe(false);
  });
});

describe('placeStopRequestSchema', () => {
  const base = { instId: 'BTC-USDT-SWAP', mgnMode: 'cross', slTriggerPx: '59000' };

  it('takes a stop price for a position, with or without a size and a side', () => {
    expect(placeStopRequestSchema.parse(base)).toEqual(base);
    expect(placeStopRequestSchema.parse({ ...base, posSide: 'long', sz: '5' })).toEqual({ ...base, posSide: 'long', sz: '5' });
  });

  it('refuses a price or a size that is not a positive decimal string, and a missing margin mode', () => {
    for (const slTriggerPx of ['0', '-1', '', 'abc', 59000]) expect(placeStopRequestSchema.safeParse({ ...base, slTriggerPx }).success, String(slTriggerPx)).toBe(false);
    for (const sz of ['0', '-5', 'all', 5]) expect(placeStopRequestSchema.safeParse({ ...base, sz }).success, String(sz)).toBe(false);
    expect(placeStopRequestSchema.safeParse({ instId: 'BTC-USDT-SWAP', slTriggerPx: '59000' }).success).toBe(false);
  });
});
