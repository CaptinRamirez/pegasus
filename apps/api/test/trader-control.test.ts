import { describe, expect, it } from 'vitest';
import { settleControlBar } from '../src/services/trader.js';

const short = () => ({ side: 'short' as const, contracts: '10', entryPx: '60000', stopPx: '60300', targetPx: '59400', openedAt: 0, clOrdId: 'control', equityAtEntry: '0', fee: '6', tp1Px: '59850' });

describe('the coin-flip control s ladder', () => {
  it('banks half at the first take-profit, moves the stop to the entry, then ends at the entry or the target', () => {
    const c: ReturnType<typeof short> & { banked?: string } = short();
    expect(settleControlBar(c, '60010', '59900', '0.01')).toBeNull();
    expect(settleControlBar(c, '59950', '59840', '0.01')).toBeNull();
    // 5 contracts of 0.01 BTC, 150 in its favour
    expect(c).toMatchObject({ contracts: '5', stopPx: '60000', banked: '7.5' });
    expect('tp1Px' in c).toBe(false);
    expect(settleControlBar(c, '60001', '59900', '0.01')).toEqual({ exitPx: '60000', end: 'stop' });
    const d = short();
    expect(settleControlBar(d, '59900', '59400', '0.01')).toEqual({ exitPx: '59400', end: 'target' });
    expect(d).toMatchObject({ contracts: '5', banked: '7.5' });
  });

  it('gives the stop a bar that touches both', () => {
    expect(settleControlBar(short(), '60300', '59840', '0.01')).toEqual({ exitPx: '60300', end: 'stop' });
  });
});
