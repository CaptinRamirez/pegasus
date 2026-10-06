import { describe, expect, it } from 'vitest';
import type { CampaignSignalRow } from '@pegasus/shared';
import { en } from '../i18n/en';
import { zh } from '../i18n/zh';
import { BTC, ETH } from '../test/campaign-fixtures';
import { ADA, campaignAccountResponse, signalRows, signalsResponse } from '../test/signals-fixtures';
import { contractsForRisk, estimateLiqPx, followBlock, marginAt, nextDailyClose, reasonText, riskOf, shareOf, signalCloseTs, sortRows, warningText, type FollowContext } from './signals';

const row = (instId: string): CampaignSignalRow => {
  const r = signalRows.find((x) => x.instId === instId);
  if (r === undefined) throw new Error(instId);
  return r;
};
const OK: FollowContext = { ownAccount: false, killSwitch: false, exits: true, tradingBlocked: false };

describe('the coin list', () => {
  it('puts the actionable coins first (entry, add, exit), then holding, near, none and unavailable; near and none closest first', () => {
    const order = sortRows(signalRows).map((r) => `${r.instId.split('-')[0]}:${r.state}`);
    expect(order).toEqual(['BTC:entry', 'ADA:entry', 'ETH:add', 'LTC:exit', 'XRP:holding', 'TRX:near', 'BCH:near', 'ETC:none', 'DOT:none', 'LINK:unavailable']);
  });
});

describe('whether a signal can be followed from the page', () => {
  it('only an entry or an add with a plan, a size, a tracked coin and exits offered', () => {
    expect(followBlock(row('BTC-USDT-SWAP'), OK)).toBeNull();
    expect(followBlock(row('ETH-USDT-SWAP'), OK)).toBeNull();
    for (const instId of ['LTC-USDT-SWAP', 'XRP-USDT-SWAP', 'BCH-USDT-SWAP', 'ETC-USDT-SWAP', 'LINK-USDT-SWAP']) expect(followBlock(row(instId), OK)).toBe('NOT_ACTIONABLE');
  });

  it('says why not, the campaign account first', () => {
    const btc = row('BTC-USDT-SWAP');
    expect(followBlock(btc, { ...OK, ownAccount: true })).toBe('CAMPAIGN_ACCOUNT');
    const fromCampaignStack = campaignAccountResponse.rows.find((r) => r.instId === 'BTC-USDT-SWAP');
    if (fromCampaignStack === undefined) throw new Error('fixture');
    expect(followBlock(fromCampaignStack, OK)).toBe('CAMPAIGN_ACCOUNT');
    expect(followBlock(btc, { ...OK, killSwitch: true })).toBe('KILL_SWITCH');
    expect(followBlock(btc, { ...OK, tradingBlocked: true })).toBe('TRADING_BLOCKED');
    expect(followBlock({ ...btc, tracked: false }, OK)).toBe('NOT_TRACKED');
    expect(followBlock({ ...btc, plan: null }, OK)).toBe('NO_PLAN');
    if (btc.plan === null) throw new Error('fixture');
    expect(followBlock({ ...btc, plan: { ...btc.plan, contracts: null, warnings: [{ code: 'EQUITY_UNKNOWN', params: {} }] } }, OK)).toBe('NO_SIZE');
    expect(followBlock(btc, { ...OK, exits: false })).toBe('EXITS_UNAVAILABLE');
    expect(followBlock(btc, { ...OK, exits: null })).toBe('EXITS_UNKNOWN');
    // warnings alone that the sheet can fix (a late price, a size over a limit) do not block
    expect(followBlock(row('ADA-USDT-SWAP'), OK)).toBeNull();
  });
});

describe('the figures of a code, formatted for its sentence', () => {
  it('prices to the tick, shares as percentages, the close of the bar of a barTs', () => {
    const near = row('BCH-USDT-SWAP').reasons[0];
    if (near === undefined) throw new Error('fixture');
    const text = reasonText(near.code, near.params, undefined);
    expect(text).toMatchObject({ markPx: '409.12', level: '418.5', distancePct: '2.29%', nearPct: '3.00%', close: '' });
    const add = row('ETH-USDT-SWAP').reasons[1];
    if (add === undefined) throw new Error('fixture');
    expect(reasonText(add.code, add.params, ETH)).toMatchObject({ close: '3,192.4', trigger: '3,171.53', barClose: '2026-10-05 00:00 UTC' });
    const plan = row('ADA-USDT-SWAP').plan;
    if (plan === null) throw new Error('fixture');
    const words = plan.warnings.map((w) => en.signals.warning[w.code](warningText(w.code, w.params, ADA)));
    expect(words).toEqual([
      'The bar of the signal closed at 2026-10-04 00:00 UTC, more than a bar ago: a newer bar is not confirmed yet. Check before following.',
      'The price 0.4571 is already 6.01% above the signal\'s close 0.4312 (more than 5.00%): a late entry, with the stop further away.',
      'The stop is 25.18% below the entry, wider than 20.00%: the position is small for its risk.',
      'Leverage 3× instead of 10×, so that the liquidation stays below the stop.',
      'The risk buys only 0 contracts, below the minimum order of 1: the plan holds the minimum, which risks 11.51 USDT.',
    ]);
    const first = plan.warnings[0];
    if (first === undefined) throw new Error('fixture');
    expect(zh.signals.warning[first.code](warningText(first.code, first.params, ADA))).toBe('信号所在K线收于 2026-10-04 00:00 UTC，已超过一根K线：更新的K线尚未确认。跟随前请先核实。');
  });

  it('the signal closed at the end of its bar: a day for an entry, twelve hours for an add', () => {
    expect(signalCloseTs({ kind: 'entry', barTs: Date.UTC(2026, 9, 4) })).toBe(Date.UTC(2026, 9, 5));
    expect(signalCloseTs({ kind: 'add', barTs: Date.UTC(2026, 9, 4, 12) })).toBe(Date.UTC(2026, 9, 5));
    expect(nextDailyClose(Date.UTC(2026, 9, 5, 9, 30))).toBe(Date.UTC(2026, 9, 6));
  });
});

describe('the arithmetic of the confirmation sheet', () => {
  it('sizes a long from the risk in whole lots, at least the minimum order, as the API does', () => {
    // 25,000 x 1% = 250 over 5,280.5 x 0.01 BTC = 52.805 per contract: 4.73 -> 4
    expect(contractsForRisk('25000', '0.01', '64180.5', '58900', BTC)).toEqual({ contracts: '4', belowMin: false });
    // 56 x 1% = 0.56: less than one contract, the minimum order then
    expect(contractsForRisk('56', '0.01', '64180.5', '58900', BTC)).toEqual({ contracts: '1', belowMin: true });
    expect(contractsForRisk(null, '0.01', '64180.5', '58900', BTC)).toBeNull();
    expect(contractsForRisk('25000', '0.01', '58000', '58900', BTC)).toBeNull();
  });

  it('what a size risks, its share of the equity, the margin and the estimated liquidation of an isolated long', () => {
    expect(riskOf('4', '64180.5', '58900', BTC)?.toFixed()).toBe('211.22');
    expect(shareOf('211.22', signalsResponse.equity)?.toFixed()).toBe('0.0084488');
    expect(marginAt('2567.22', '10')?.toFixed()).toBe('256.722');
    // margin + qty x (px - avg) = maintenance x qty x px: (2,567.22 - 256.722) / (0.04 x 0.9955) at 10x and 0.45%
    const liq = estimateLiqPx('4', '64180.5', '10', '0.0045', BTC);
    expect(liq?.toDecimalPlaces(1).toFixed()).toBe('58023.6');
    expect(estimateLiqPx('4', '64180.5', '0', '0.0045', BTC)).toBeNull();
  });
});
