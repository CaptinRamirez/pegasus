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

const decision = (action: LeaderDecision['action'], lotShare = 0.1): LeaderDecision => ({ action, lotShare, confidence: 0.5, reasons: ['r'], invalidation: 'i', oneLiner: 'o', recheckMinutes: 240, wakeAbove: null, wakeBelow: null });
const lot = (entryPx: string) => ({ contracts: '0.5', entryPx, openedAt: 0, clOrdId: 'pt1' });
const flat = { lots: [], side: null };

describe('the lead-trader style', () => {
  it('sizes a lot at the share of the equity the model names, in whole lots, none under the minimum order', () => {
    // 1,124 x 10% = 112.4 USDT at 2,240 = 0.0502 ETH = 0.502 contracts of 0.1 ETH, floored to the 0.01 lot: 112 USDT
    expect(leaderLotSize('1124', '2240', eth, '0.1')).toEqual({ contracts: '0.5', notional: '112' });
    expect(leaderLotSize('1124', '2240', eth, 1.5)).toEqual({ contracts: '7.52', notional: '1684.48' });
    expect(leaderLotSize('20', '2240', eth, '0.1')).toBeNull();
    expect(leaderLotSize('1124', '2240', eth, 0)).toBeNull();
  });

  it('opens a long or a short lot of any size within three times the equity, on one side a coin at a time', () => {
    const base = { mark: '2240', equity: '1124', exposure: '0', inst: eth, blocked: null };
    expect(checkLeaderDecision(decision('buy'), { ...base, coin: flat })).toEqual({ ok: true, action: 'buy', contracts: '0.5', notional: '112' });
    expect(checkLeaderDecision(decision('short', 1.5), { ...base, coin: flat })).toEqual({ ok: true, action: 'short', contracts: '7.52', notional: '1684.48' });
    // a lot is added wherever the model says, on the side held; the other side is refused until the lots are closed
    const long = { lots: [lot('2240')], side: 'long' as const };
    expect(checkLeaderDecision(decision('buy'), { ...base, mark: '2250', exposure: '112', coin: long })).toMatchObject({ ok: true, action: 'buy' });
    expect(checkLeaderDecision(decision('short'), { ...base, exposure: '112', coin: long })).toMatchObject({ ok: false, reason: expect.stringContaining('close them before opening a short lot') });
    expect(checkLeaderDecision(decision('buy'), { ...base, coin: { lots: [lot('2240')], side: 'short' } })).toMatchObject({ ok: false, reason: expect.stringContaining('close them before opening a long lot') });
    // all positions at the marks plus this lot may not pass three times the equity: 3,372
    expect(LEADER_RULES.maxExposure).toBe('3');
    expect(checkLeaderDecision(decision('buy', 1), { ...base, exposure: '2200', coin: flat })).toMatchObject({ ok: true });
    expect(checkLeaderDecision(decision('buy', 1), { ...base, exposure: '2300', coin: flat })).toMatchObject({ ok: false, reason: expect.stringContaining('above 3 times the equity (3372.00); 1072.00 may still be opened') });
    expect(checkLeaderDecision(decision('short', 0), { ...base, coin: flat })).toMatchObject({ ok: false, reason: expect.stringContaining('a size above 0') });
    expect(checkLeaderDecision(decision('buy', 0.001), { ...base, coin: flat })).toMatchObject({ ok: false, reason: expect.stringContaining('less than the minimum order') });
    expect(checkLeaderDecision(decision('short'), { ...base, blocked: 'the kill switch is on', coin: flat })).toMatchObject({ ok: false, reason: 'the kill switch is on' });
  });

  it('closes only with a lot, in profit or at a loss and while blocked; holds always', () => {
    const base = { mark: '2240', equity: '1124', exposure: '0', inst: eth, blocked: 'halted' };
    expect(checkLeaderDecision(decision('close'), { ...base, coin: flat })).toEqual({ ok: false, action: 'close', reason: 'close without a lot' });
    expect(checkLeaderDecision(decision('close'), { ...base, coin: { lots: [lot('2300')], side: 'long' } })).toEqual({ ok: true, action: 'close' });
    expect(checkLeaderDecision(decision('close'), { ...base, coin: { lots: [lot('2100')], side: 'short' } })).toEqual({ ok: true, action: 'close' });
    expect(checkLeaderDecision(decision('hold'), { ...base, coin: flat })).toEqual({ ok: true, action: 'hold' });
  });

  it('keeps the recheck within the style s bounds, on a 15-minute close', () => {
    const bar = Date.UTC(2026, 10, 9);
    const bounds = { min: LEADER_RULES.recheckMinMinutes, max: LEADER_RULES.recheckMaxMinutes };
    expect(wakeOf({ ...decision('hold'), recheckMinutes: 20 }, bar, bounds).at).toBe(bar + 60 * 60_000);
    expect(wakeOf({ ...decision('hold'), recheckMinutes: 5000 }, bar, bounds).at).toBe(bar + 1440 * 60_000);
    expect(wakeOf({ ...decision('hold'), recheckMinutes: 20 }, bar).at).toBe(bar + 30 * 60_000);
  });
});
