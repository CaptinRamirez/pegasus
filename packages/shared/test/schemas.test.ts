import { describe, expect, it } from 'vitest';
import { placeOrderRequestSchema } from '../src/index.js';

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
