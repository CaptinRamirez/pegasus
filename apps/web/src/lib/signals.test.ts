import { describe, expect, it } from 'vitest';
import { D, type CampaignPlanWarning, type CampaignSignalRow, type Order, type Position } from '@pegasus/shared';
import { en } from '../i18n/en';
import { zh } from '../i18n/zh';
import { BTC, ETH } from '../test/campaign-fixtures';
import { ADA, ADA_TENTHS, adaScenarioPlan, campaignAccountResponse, signalRows, signalsResponse } from '../test/signals-fixtures';
import {
  capContracts,
  completeWarning,
  contractsForRisk,
  estimateLiqPx,
  exposureNow,
  followBlock,
  liqAfterAdd,
  liqRelationOf,
  liquidationLimitOf,
  marginAt,
  nextDailyClose,
  notionalOf,
  reasonText,
  riskOf,
  safeLeverageAfterAdd,
  safeLeverageFor,
  shareOf,
  signalCloseTs,
  sortRows,
  warningText,
  type FollowContext,
  type SizeLimits,
} from './signals';

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

  it('a reduced leverage names both liquidation prices, computed from the plan when the API sent the leverages only', () => {
    const plan = row('ADA-USDT-SWAP').plan;
    const reduced = plan?.warnings.find((w) => w.code === 'LEVERAGE_REDUCED');
    if (plan === null || plan === undefined || reduced === undefined) throw new Error('fixture');
    const params = completeWarning(reduced, plan, ADA, '0.01');
    // at 10x: (0.4571 - 0.04571) / (1 - 0.0045), above the stop; at 3x the plan's own estimate; the line: the stop less 1%
    expect(params).toMatchObject({ leverage: 3, maxLeverage: 10, liqPx: '0.3065', stopPx: '0.342', limitPx: '0.33858', liqRelation: 'above' });
    expect(String(params['liqPxAtMax']).slice(0, 7)).toBe('0.41324');
    expect(en.signals.warning.LEVERAGE_REDUCED(warningText('LEVERAGE_REDUCED', params, ADA))).toBe(
      'At 10× the estimated liquidation 0.4132 would be above the stop 0.342: the position would be liquidated before the stop. The leverage is lowered to 3×, where the liquidation is 0.3065, below the stop (it must stay at or below 0.3386).',
    );
    // the API's own figures are kept as sent, and where the liquidation stands is added to them
    const sent = adaScenarioPlan.warnings[0];
    if (sent === undefined) throw new Error('fixture');
    expect(completeWarning(sent, adaScenarioPlan, ADA_TENTHS, '0.01')).toEqual({ ...sent.params, liqRelation: 'above' });
    expect(zh.signals.warning.LIMITED_BY_ORDER_NOTIONAL(warningText('LIMITED_BY_ORDER_NOTIONAL', adaScenarioPlan.warnings[1]?.params ?? {}, ADA_TENTHS))).toBe(
      '按风险应为 210 张；单笔名义上限 5,000.00 USDT 只允许 182.7 张（名义 4,974.92 USDT，风险 652.24 USDT）：方案按 182.7 张。',
    );
  });

  it('a leverage reduced for a liquidation below the stop but within the buffer says that, not that it would be above the stop', () => {
    // the API's own case: entry 100, stop 91, cap 10, maintenance 0.7%: at 10x the liquidation 90.634 is below the stop 91 but above the line 90.09
    const near: CampaignPlanWarning = { code: 'LEVERAGE_REDUCED', params: { leverage: 9, maxLeverage: 10, liqPx: '89.6', liqPxAtMax: '90.634', stopPx: '91', limitPx: '90.09' } };
    const params = completeWarning(near, adaScenarioPlan, ADA_TENTHS, '0.01');
    expect(params['liqRelation']).toBe('near');
    expect(en.signals.warning.LEVERAGE_REDUCED(warningText('LEVERAGE_REDUCED', params, undefined))).toBe(
      'At 10× the estimated liquidation 90.634 would be below the stop 91 but within the buffer (it must stay at or below 90.09): a wick could liquidate the position before the stop. The leverage is lowered to 9×, where the liquidation is 89.6, below the stop (it must stay at or below 90.09).',
    );
    expect(zh.signals.warning.LEVERAGE_REDUCED(warningText('LEVERAGE_REDUCED', params, undefined))).toBe(
      '10 倍时强平价 90.634，虽在止损 91 之下但在缓冲区内（要求不高于 90.09），一根插针就可能在止损前被强平；已降到 9 倍，强平价 89.6，在止损之下（要求不高于 90.09）。',
    );
    // at the stop itself the position is liquidated no later than it is stopped: said as above
    expect(completeWarning({ ...near, params: { ...near.params, liqPxAtMax: '91' } }, adaScenarioPlan, ADA_TENTHS, '0.01')['liqRelation']).toBe('above');
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
    expect(notionalOf('210', '0.2723', ADA_TENTHS)?.toFixed()).toBe('5718.3');
    expect(notionalOf('', '0.2723', ADA_TENTHS)).toBeNull();
  });

  it("the highest leverage whose liquidation stays below the stop's line, as the API chooses the plan's", () => {
    // the owner's ADA entry: the stop 0.2366 less 1% is 0.234234; 6x is the highest whole leverage under it (10x liquidates at 0.2477)
    const limit = liquidationLimitOf(D('0.2366'), '0.01');
    expect(limit.toFixed()).toBe('0.234234');
    expect(safeLeverageFor('0.2723', limit, '10', '0.0105', ADA_TENTHS)).toBe(6);
    expect(safeLeverageFor('0.2723', limit, '6', '0.0105', ADA_TENTHS)).toBe(6);
    expect(safeLeverageFor('0.2723', limit, '50', '0.0105', ADA_TENTHS)).toBe(6);
    // a stop far below: 1x at least, whose liquidation is at zero; no leverage, no answer
    expect(safeLeverageFor('0.2723', liquidationLimitOf(D('0.001'), '0.01'), '10', '0.0105', ADA_TENTHS)).toBe(1);
    expect(safeLeverageFor('0.2723', limit, '', '0.0105', ADA_TENTHS)).toBeNull();
    // where a liquidation stands: at or above the stop, below it but above the line, or safely below
    expect(liqRelationOf(D('0.2477'), D('0.2366'), limit)).toBe('above');
    expect(liqRelationOf(D('0.2366'), D('0.2366'), limit)).toBe('above');
    expect(liqRelationOf(D('0.2359'), D('0.2366'), limit)).toBe('near');
    expect(liqRelationOf(D('0.2293'), D('0.2366'), limit)).toBeNull();
  });

  it("an add is judged on the position after it, as the plan's rule: the held coin and margin plus the add's", () => {
    // the ETH add of the fixtures: 20 contracts (2 ETH) at 3,020.5 with 604.1 of margin at 10x, 8 more (0.8 ETH) at 3,188.75
    const holding = { contracts: '20', avgPx: '3020.5', mgnMode: 'isolated' as const, lever: '10', margin: '604.1' };
    const after = liqAfterAdd(holding, '8', '3188.75', '10', '0.0045', ETH);
    expect(after?.toFixed(4)).toBe('2774.1982');
    // the add alone, as a fresh position at its price, would be liquidated above the stop's line; the position after it is not
    const limit = liquidationLimitOf(D('2905.4'), '0.01');
    expect(estimateLiqPx('8', '3188.75', '10', '0.0045', ETH)?.gt(limit)).toBe(true);
    expect(after?.lte(limit)).toBe(true);
    // at another leverage the held margin becomes the position's notional over it: 20x fails, 14x is the highest that passes
    expect(liqAfterAdd(holding, '8', '3188.75', '20', '0.0045', ETH)?.toFixed(4)).toBe('2928.3203');
    expect(safeLeverageAfterAdd(holding, '8', '3188.75', limit, '20', '0.0045', ETH)).toBe(14);
    // a cross holding: the liquidation is the account's
    expect(liqAfterAdd({ ...holding, mgnMode: 'cross' }, '8', '3188.75', '10', '0.0045', ETH)).toBeNull();
    expect(liqAfterAdd(holding, '', '3188.75', '10', '0.0045', ETH)).toBeNull();
  });
});

describe('the size the risk limits allow', () => {
  const limits: SizeLimits = {
    maxOrderNotional: '5000',
    maxPositionNotionalPerInstrument: '40000',
    maxTotalPositionNotional: '100000',
    slippagePct: '0.005',
    instrumentNotional: '0',
    totalNotional: '0',
    availEq: '99960',
    leverage: '6',
    feeRate: '0.0005',
  };

  it("cuts the owner's 210 ADA contracts to the per-order limit, each contract valued at the mark plus the slippage the engine tolerates", () => {
    // 5,000 over 27.23 x 1.005 = 182.72 contracts, in lots of a tenth
    expect(capContracts('210', '0.2723', ADA_TENTHS, limits)).toEqual({ contracts: '182.7', perContract: '27.36615', bound: 'order', limit: '5000', max: '182.7', belowMin: false });
    // within the limits nothing is cut; a limit order is valued at its price alone (5,000 over 27.23 = 183.6)
    expect(capContracts('100', '0.2723', ADA_TENTHS, limits)).toMatchObject({ contracts: '100', bound: null });
    expect(capContracts('210', '0.2723', ADA_TENTHS, { ...limits, slippagePct: null })).toMatchObject({ contracts: '183.6', perContract: '27.23', bound: 'order', max: '183.6' });
  });

  it('the tightest of the coin, the total and the balance wins; below the minimum order the minimum is filled in and flagged', () => {
    // 40,000 less 36,000 held on the coin: 4,000 over 27.366 = 146.1
    expect(capContracts('210', '0.2723', ADA_TENTHS, { ...limits, instrumentNotional: '36000' })).toMatchObject({ contracts: '146.1', bound: 'instrument', limit: '40000' });
    expect(capContracts('210', '0.2723', ADA_TENTHS, { ...limits, totalNotional: '97000' })).toMatchObject({ contracts: '109.6', bound: 'total', limit: '100000' });
    // 1,000 USDT over a contract's 27.366 x (1 / 6 + 0.0005) = 4.5748: 218.5 contracts
    expect(capContracts('210', '0.2723', ADA_TENTHS, { ...limits, maxOrderNotional: '10000', availEq: '1000' })).toMatchObject({ contracts: '210', bound: null });
    expect(capContracts('210', '0.2723', ADA_TENTHS, { ...limits, maxOrderNotional: '10000', availEq: '500' })).toMatchObject({ contracts: '109.2', bound: 'balance', limit: '500' });
    expect(capContracts('210', '0.2723', ADA_TENTHS, { ...limits, maxOrderNotional: '2' })).toEqual({ contracts: '0.1', perContract: '27.36615', bound: 'order', limit: '2', max: '0', belowMin: true });
    // unknown limits do not cut
    expect(capContracts('210', '0.2723', ADA_TENTHS, { ...limits, maxOrderNotional: null, maxPositionNotionalPerInstrument: null, maxTotalPositionNotional: null, availEq: null })).toMatchObject({ contracts: '210', bound: null });
    expect(capContracts('', '0.2723', ADA_TENTHS, limits)).toBeNull();
  });

  it('counts what is held as the engine projects it: positions gross, resting opening orders at their price, closing orders not at all', () => {
    const position = (instId: string, pos: string, notionalUsd: string): Position => ({ instId, posSide: 'net', mgnMode: 'isolated', pos, avgPx: '1', markPx: '1', upl: '0', uplRatio: '0', lever: '10', liqPx: '', margin: '', notionalUsd, cTime: 1, uTime: 1 });
    const order = (o: Partial<Order>): Order => ({ ordId: 'o', clOrdId: '', instId: 'ADA-USDT-SWAP', side: 'buy', posSide: 'net', tdMode: 'isolated', ordType: 'limit', px: '0.25', sz: '10', accFillSz: '0', avgPx: '', state: 'live', reduceOnly: false, lever: '10', fee: '0', feeCcy: '', pnl: '0', cTime: 1, uTime: 1, ...o });
    const positions = [position('ADA-USDT-SWAP', '-100', '2700'), position('BTC-USDT-SWAP', '1', '640')];
    const orders = [order({}), order({ ordId: 'half', sz: '10', accFillSz: '4' }), order({ ordId: 'closing', reduceOnly: true }), order({ ordId: 'market', ordType: 'market', px: '' }), order({ ordId: 'btc', instId: 'BTC-USDT-SWAP', px: '60000', sz: '1' })];
    const held = exposureNow('ADA-USDT-SWAP', positions, orders, [ADA_TENTHS, BTC]);
    // 2,700 of the short, 250 of the resting buy, 150 of the half-filled one
    expect(held.instrument.toFixed()).toBe('3100');
    expect(held.total.toFixed()).toBe('4340');
  });
});
