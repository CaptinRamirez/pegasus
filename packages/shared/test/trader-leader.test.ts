import { describe, expect, it } from 'vitest';
import { checkLeaderDecision, LEADER_RULES, leaderLotSize, wakeOf, type LeaderDecision } from '../src/trader.js';
import type { Instrument } from '../src/types.js';

const eth: Instrument = {
  instId: 'ETH-USDT-SWAP',
  instType: 'SWAP',
  uly: 'ETH-USDT',
  baseCcy: 'ETH',
  quoteCcy: 'USDT',
  settleCcy: 'USDT',
  ctVal: '0.1',
  ctValCcy: 'ETH',
  ctMult: '1',
  ctType: 'linear',
  lotSz: '0.01',
  minSz: '0.01',
  tickSz: '0.01',
  maxLmtSz: '0',
  maxMktSz: '0',
  maxLever: '100',
  state: 'live',
};

const decision = (action: LeaderDecision['action']): LeaderDecision => ({ action, confidence: 0.5, reasons: ['r'], invalidation: 'i', oneLiner: 'o', recheckMinutes: 240, wakeAbove: null, wakeBelow: null });
const lot = (entryPx: string) => ({ contracts: '0.5', entryPx, openedAt: 0, clOrdId: 'pt1' });

describe('the lead-trader style', () => {
  it('sizes a lot at a tenth of the equity in whole lots, none under the minimum order', () => {
    // 1,124 x 10% = 112.4 USDT at 2,240 = 0.0502 ETH = 0.502 contracts of 0.1 ETH, floored to the 0.01 lot: 112 USDT
    expect(leaderLotSize('1124', '2240', eth)).toEqual({ contracts: '0.5', notional: '112' });
    expect(leaderLotSize('20', '2240', eth)).toBeNull();
  });

  it('buys a first lot, adds only a daily ATR under the last lot, and stops at five lots or the exposure cap', () => {
    const base = { mark: '2240', equity: '1124', exposure: '0', atr: '60', inst: eth, blocked: null };
    expect(checkLeaderDecision(decision('buy'), { ...base, coin: { lots: [], lastLotPx: null } })).toEqual({ ok: true, action: 'buy', contracts: '0.5', notional: '112' });
    // the last lot at 2,240: a lot is added at or under 2,180
    const one = { lots: [lot('2240')], lastLotPx: '2240' };
    expect(checkLeaderDecision(decision('buy'), { ...base, mark: '2200', coin: one })).toMatchObject({ ok: false, reason: expect.stringContaining('at or under 2180') });
    expect(checkLeaderDecision(decision('buy'), { ...base, mark: '2180', exposure: '109', coin: one })).toMatchObject({ ok: true, action: 'buy' });
    expect(checkLeaderDecision(decision('buy'), { ...base, mark: '2180', atr: null, coin: one })).toMatchObject({ ok: false, reason: expect.stringContaining('no daily ATR') });
    const five = { lots: [lot('2400'), lot('2300'), lot('2200'), lot('2100'), lot('2000')], lastLotPx: '2000' };
    expect(checkLeaderDecision(decision('buy'), { ...base, mark: '1900', coin: five })).toMatchObject({ ok: false, reason: '5 lots held: the most a coin may have' });
    // all positions at the marks plus this lot may not pass the equity
    expect(checkLeaderDecision(decision('buy'), { ...base, exposure: '1100', coin: { lots: [], lastLotPx: null } })).toMatchObject({ ok: false, reason: expect.stringContaining('above 100% of the equity') });
    expect(checkLeaderDecision(decision('buy'), { ...base, blocked: 'the kill switch is on', coin: { lots: [], lastLotPx: null } })).toMatchObject({ ok: false, reason: 'the kill switch is on' });
  });

  it('sells only with a lot, holds always', () => {
    const base = { mark: '2240', equity: '1124', exposure: '0', atr: '60', inst: eth, blocked: 'halted' };
    expect(checkLeaderDecision(decision('sell'), { ...base, coin: { lots: [], lastLotPx: null } })).toEqual({ ok: false, action: 'sell', reason: 'sell without a lot' });
    expect(checkLeaderDecision(decision('sell'), { ...base, coin: { lots: [lot('2300')], lastLotPx: '2300' } })).toEqual({ ok: true, action: 'sell' });
    expect(checkLeaderDecision(decision('hold'), { ...base, coin: { lots: [], lastLotPx: null } })).toEqual({ ok: true, action: 'hold' });
  });

  it('keeps the recheck within the style s bounds, on a 15-minute close', () => {
    const bar = Date.UTC(2026, 10, 9);
    const bounds = { min: LEADER_RULES.recheckMinMinutes, max: LEADER_RULES.recheckMaxMinutes };
    expect(wakeOf({ ...decision('hold'), recheckMinutes: 20 }, bar, bounds).at).toBe(bar + 60 * 60_000);
    expect(wakeOf({ ...decision('hold'), recheckMinutes: 5000 }, bar, bounds).at).toBe(bar + 1440 * 60_000);
    expect(wakeOf({ ...decision('hold'), recheckMinutes: 20 }, bar).at).toBe(bar + 30 * 60_000);
  });
});
