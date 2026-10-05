import { describe, expect, it } from 'vitest';
import {
  CAMPAIGN_MAINTENANCE,
  campaignAction,
  campaignAddQuantity,
  campaignAddTriggered,
  campaignContracts,
  campaignEntryQuantity,
  campaignMaintenanceRate,
  campaignSignals,
  campaignStake,
  D,
  DEFAULT_CAMPAIGN_PARAMS,
  DEFAULT_POT_PARAMS,
  exchangeAddRoom,
  harvestContracts,
  harvestDue,
  harvestFraction,
  harvestTarget,
  isolatedLongEquity,
  isolatedLongLiquidationPrice,
  keptAfterHarvest,
  planHarvest,
  potFinished,
  potRungLevel,
  sameCloseOrder,
  type CampaignParams,
  type Candle,
  type HarvestPlan,
  type Instrument,
} from '../src/index.js';

const BTC: Instrument = {
  instId: 'BTC-USDT-SWAP', instType: 'SWAP', uly: 'BTC-USDT', baseCcy: 'BTC', quoteCcy: 'USDT', settleCcy: 'USDT',
  ctVal: '0.01', ctValCcy: 'BTC', ctMult: '1', ctType: 'linear', lotSz: '0.01', minSz: '0.01', tickSz: '0.1',
  maxLmtSz: '100000', maxMktSz: '12000', maxLever: '100', state: 'live',
};

const DAY = 86_400_000;
const T0 = Date.UTC(2024, 0, 1);

/** Daily bars from [high, low, close] rows, oldest first. */
function bars(rows: ReadonlyArray<readonly [number, number, number]>): Candle[] {
  return rows.map(([high, low, close], i) => ({ ts: T0 + i * DAY, open: String(close), high: String(high), low: String(low), close: String(close), vol: '0', volCcy: '0', confirm: true }));
}

/** Channels of 3 and 2 bars keep the hand calculations short. */
const SHORT: CampaignParams = { ...DEFAULT_CAMPAIGN_PARAMS, entryChannel: 3, exitChannel: 2 };

describe('the approved rule', () => {
  it('is a 20-day breakout at 10x with 5% adds, a 10-day exit, a pot of 56 staking half and harvesting half at every tenfold', () => {
    expect(DEFAULT_CAMPAIGN_PARAMS).toEqual({ entryChannel: 20, exitChannel: 10, leverage: '10', structure: 'pyramid', addStep: '0.05', feeRate: '0.0005' });
    expect(DEFAULT_POT_PARAMS).toEqual({ start: '56', minStake: '5.6', stakeFraction: '0.5', rungFactor: '10', bankFraction: '0.5' });
  });

  it('estimates liquidation with the first maintenance tier of the exchange plus the taker fee', () => {
    for (const coin of ['BTC', 'ETH', 'XRP']) expect(campaignMaintenanceRate({ baseCcy: coin })).toBe('0.0045');
    for (const coin of ['LTC', 'BCH', 'LINK', 'TRX']) expect(campaignMaintenanceRate({ baseCcy: coin })).toBe('0.007');
    for (const coin of ['ETC', 'ADA', 'DOT']) expect(campaignMaintenanceRate({ baseCcy: coin })).toBe('0.0105');
    // A coin the table does not list takes the highest tier; the table and the fee are parameters.
    expect(CAMPAIGN_MAINTENANCE.other).toBe('0.01');
    expect(campaignMaintenanceRate({ baseCcy: 'SOL' })).toBe('0.0105');
    expect(campaignMaintenanceRate({ baseCcy: 'SOL' }, { ...DEFAULT_CAMPAIGN_PARAMS, feeRate: '0.0002' }, { rates: { SOL: '0.005' }, other: '0.02' })).toBe('0.0052');
  });
});

describe('campaign signals', () => {
  it('enters on a close above the highest high of the bars before it', () => {
    const s = campaignSignals(bars([[10, 8, 9], [12, 9, 11], [11, 9, 10], [13, 10, 12.5]]), SHORT);
    expect(s).toEqual({ asOf: T0 + 3 * DAY, close: '12.5', entryHigh: '12', exitLow: '9', entry: true, exit: false });
  });

  it('does not enter on a close at the channel, nor because the bar itself traded above it', () => {
    expect(campaignSignals(bars([[10, 8, 9], [12, 9, 11], [11, 9, 10], [13, 10, 12]]), SHORT).entry).toBe(false);
    expect(campaignSignals(bars([[10, 8, 9], [12, 9, 11], [11, 9, 10], [15, 10, 11.9]]), SHORT).entry).toBe(false);
  });

  it('looks at exactly the channel: a higher high one bar further back does not count', () => {
    const s = campaignSignals(bars([[20, 8, 9], [10, 8, 9], [12, 9, 11], [11, 9, 10], [13, 10, 12.5]]), SHORT);
    expect(s.entryHigh).toBe('12');
    expect(s.entry).toBe(true);
  });

  it('exits on a close below the lowest low of the bars before it, not on a close at it', () => {
    const below = campaignSignals(bars([[10, 8, 9], [12, 9, 11], [11, 9.5, 10], [10, 8, 8.9]]), SHORT);
    expect(below).toMatchObject({ exitLow: '9', exit: true, entry: false });
    expect(campaignSignals(bars([[10, 8, 9], [12, 9, 11], [11, 9.5, 10], [10, 8, 9]]), SHORT).exit).toBe(false);
    // The exit channel is the shorter one: the low of 8 three bars back is outside it.
    expect(campaignSignals(bars([[10, 8, 9], [12, 9, 11], [11, 9.5, 10], [10, 8, 8.5]]), SHORT).exit).toBe(true);
  });

  it('gives no signal from a channel that does not have its bars yet', () => {
    // Three bars: the exit channel (2) is complete, the entry channel (3) is not.
    const s = campaignSignals(bars([[10, 8, 9], [12, 9, 11], [14, 7, 13]]), SHORT);
    expect(s).toMatchObject({ entryHigh: null, exitLow: '8', entry: false, exit: false });
    expect(campaignSignals(bars([[10, 8, 9], [12, 9, 6]]), SHORT)).toMatchObject({ entryHigh: null, exitLow: null, entry: false, exit: false });
    expect(() => campaignSignals([], SHORT)).toThrow(/no confirmed/);
  });

  it('ignores the forming bar', () => {
    const candles = bars([[10, 8, 9], [12, 9, 11], [11, 9, 10], [13, 10, 12.5], [30, 12, 29]]);
    (candles[4] as Candle).confirm = false;
    expect(campaignSignals(candles, SHORT)).toMatchObject({ asOf: T0 + 3 * DAY, close: '12.5', entry: true });
  });

  it('uses the 20 and 10 bars of the rule by default', () => {
    const flat = Array.from({ length: 20 }, (): [number, number, number] => [101, 99, 100]);
    expect(campaignSignals(bars([...flat, [103, 100, 101.5]]))).toMatchObject({ entryHigh: '101', exitLow: '99', entry: true, exit: false });
    expect(campaignSignals(bars([...flat, [100, 97, 98.5]]))).toMatchObject({ entry: false, exit: true });
    // One bar short of the entry channel.
    expect(campaignSignals(bars([...flat.slice(1), [103, 100, 101.5]]))).toMatchObject({ entryHigh: null, entry: false });
  });
});

describe('adds', () => {
  it('are triggered by a close at least the step above the last add price', () => {
    expect(campaignAddTriggered('105', '100')).toBe(true);
    expect(campaignAddTriggered('104.99', '100')).toBe(false);
    // Exact where binary floating point is not: 0.0735 / 0.07 - 1 falls just short of 0.05 in doubles.
    expect(0.0735 / 0.07 - 1 >= 0.05).toBe(false);
    expect(campaignAddTriggered('0.0735', '0.07')).toBe(true);
    expect(campaignAddTriggered('110', '100', { ...DEFAULT_CAMPAIGN_PARAMS, addStep: '0.1' })).toBe(true);
    expect(campaignAddTriggered('109', '100', { ...DEFAULT_CAMPAIGN_PARAMS, addStep: '0.1' })).toBe(false);
  });

  it('never happen in the noadd structure', () => {
    expect(campaignAddTriggered('200', '100', { ...DEFAULT_CAMPAIGN_PARAMS, structure: 'noadd' })).toBe(false);
  });

  it('give way to the exit', () => {
    expect(campaignAction(true, '105', '100')).toBe('exit');
    expect(campaignAction(false, '105', '100')).toBe('add');
    expect(campaignAction(false, '104', '100')).toBe('hold');
    expect(campaignAction(false, '105', '100', { ...DEFAULT_CAMPAIGN_PARAMS, structure: 'noadd' })).toBe('hold');
  });

  it('add the entry quantity while the notional stays within leverage x equity', () => {
    // Equity at 105: 60 + 1 x 5 = 65, so 10 x 65 = 650 of notional are allowed; 2 coins at 105 are 210.
    expect(campaignAddQuantity({ qty: '1', avgPx: '100', margin: '60' }, '1', '105', '105').toFixed()).toBe('1');
  });

  it('are cut to the cap: notional after the add = leverage x (equity - the fee of the add)', () => {
    // Entered at 10x: margin 10 on 1 coin at 100. At 105 the equity is 15.
    const pos = { qty: '1', avgPx: '100', margin: '10' };
    const add = campaignAddQuantity(pos, '1', '105', '105');
    // (10 x 15 - 1 x 105) / (105 x (1 + 10 x 0.0005)) = 45 / 105.525
    expect(add.toFixed(12)).toBe(D(45).div('105.525').toFixed(12));
    const fee = add.mul(105).mul('0.0005');
    expect(D(1).plus(add).mul(105).toFixed(12)).toBe(D(15).minus(fee).mul(10).toFixed(12));
    // The equity is marked before slippage, the notional counted at the fill price.
    expect(campaignAddQuantity(pos, '1', '105', '105.105').toFixed(12)).toBe(D(150).minus('105.105').div(D('105.105').mul('1.005')).toFixed(12));
  });

  it('are nothing when the position is already at the cap', () => {
    expect(campaignAddQuantity({ qty: '1', avgPx: '100', margin: '10' }, '1', '100', '100').toFixed()).toBe('0');
    expect(campaignAddQuantity({ qty: '1', avgPx: '100', margin: '10' }, '1', '98', '98').toFixed()).toBe('0');
  });

  it('are cut to what the exchange accepts: notional at the mark within maxLever x the margin, which open profit does not raise', () => {
    // 1 coin from 100 on a margin of 10, now at 200. The equity of 110 would carry two more coins (3 x 200 <= 1100).
    const pos = { qty: '1', avgPx: '100', margin: '10' };
    expect(campaignAddQuantity(pos, '2', '200', '200').toFixed()).toBe('2');
    // The exchange looks at the margin: at 50x, 500 of notional, less what the fee of the add takes from the margin.
    // (50 x 10 - 1 x 200) / (200 + 50 x 0.0005 x 200) = 300 / 205
    const room = D(300).div(205);
    expect(exchangeAddRoom(pos, '200', '200', '50').toFixed(12)).toBe(room.toFixed(12));
    expect(campaignAddQuantity(pos, '2', '200', '200', DEFAULT_CAMPAIGN_PARAMS, '50').toFixed(12)).toBe(room.toFixed(12));
    // After that add the notional is 50 x the margin that is left.
    expect(D(1).plus(room).mul(200).toFixed(10)).toBe(D(10).minus(room.mul(200).mul('0.0005')).mul(50).toFixed(10));
    // At 100x there is room for both coins: the rule's own quantity stands.
    expect(campaignAddQuantity(pos, '2', '200', '200', DEFAULT_CAMPAIGN_PARAMS, '100').toFixed()).toBe('2');
  });

  it('are nothing when the position has outgrown the exchange limit', () => {
    // 1 coin at 600 is 600 of notional against 50 x 10 of margin.
    const pos = { qty: '1', avgPx: '100', margin: '10' };
    expect(exchangeAddRoom(pos, '600', '600', '50').lt(0)).toBe(true);
    expect(campaignAddQuantity(pos, '1', '600', '600', DEFAULT_CAMPAIGN_PARAMS, '50').toFixed()).toBe('0');
    expect(campaignAddQuantity(pos, '1', '600', '600').toFixed()).toBe('1');
  });

  it('count an open loss against the margin, as the exchange does', () => {
    // At 99 the position is 1 under water: 9 of margin count.
    const pos = { qty: '1', avgPx: '100', margin: '10' };
    expect(exchangeAddRoom(pos, '99', '99', '50').toFixed(12)).toBe(D(450).minus(99).div(D(99).plus(D(50).mul('0.0005').mul(99))).toFixed(12));
    expect(() => exchangeAddRoom(pos, '99', '99', '0')).toThrow(/positive/);
  });
});

describe('position arithmetic', () => {
  it('sizes the entry so that the stake pays the margin and the entry fee', () => {
    const qty = campaignEntryQuantity('28', '50000');
    // 28 / (50000 x (0.1 + 0.0005))
    expect(qty.toFixed(12)).toBe(D(28).div(5025).toFixed(12));
    const notional = qty.mul(50000);
    expect(notional.div(10).plus(notional.mul('0.0005')).toFixed(12)).toBe('28.000000000000');
    expect(() => campaignEntryQuantity('28', '0')).toThrow(/positive/);
  });

  it('marks an isolated long at its margin plus the open profit', () => {
    expect(isolatedLongEquity({ qty: '2', avgPx: '100', margin: '20' }, '103').toFixed()).toBe('26');
    expect(isolatedLongEquity({ qty: '2', avgPx: '100', margin: '20' }, '95').toFixed()).toBe('10');
  });

  it('puts the liquidation price where the equity equals the maintenance margin', () => {
    const pos = { qty: '1', avgPx: '100', margin: '10' };
    const liq = isolatedLongLiquidationPrice(pos, '0.01');
    // (100 - 10) / (1 - 0.01)
    expect(liq.toFixed(10)).toBe('90.9090909091');
    expect(isolatedLongEquity(pos, liq).toFixed(12)).toBe(liq.mul('0.01').toFixed(12));
    // A lower maintenance rate lets the position live a little longer.
    expect(isolatedLongLiquidationPrice(pos, '0.005').toFixed(10)).toBe('90.4522613065');
    expect(() => isolatedLongLiquidationPrice({ qty: '0', avgPx: '100', margin: '10' }, '0.01')).toThrow(/positive/);
  });

  it('rounds a quantity down to whole lots and to nothing below the minimum order', () => {
    // 0.00123456 BTC = 0.123456 contracts -> 0.12
    expect(campaignContracts('0.00123456', BTC).toFixed()).toBe('0.12');
    expect(campaignContracts('0.0001', BTC).toFixed()).toBe('0.01');
    expect(campaignContracts('0.00009999', BTC).toFixed()).toBe('0');
    expect(campaignContracts('0.05', { ...BTC, lotSz: '1', minSz: '10' }).toFixed()).toBe('0');
  });
});

describe('pot', () => {
  it('stakes half the free cash, never less than the minimum stake, and nothing below it', () => {
    expect(campaignStake('56')?.toFixed()).toBe('28');
    expect(campaignStake('8')?.toFixed()).toBe('5.6');
    expect(campaignStake('5.6')?.toFixed()).toBe('5.6');
    expect(campaignStake('5.59')).toBeNull();
    expect(campaignStake('100', { ...DEFAULT_POT_PARAMS, stakeFraction: '0.25' })?.toFixed()).toBe('25');
  });

  it('has rungs at ten, a hundred, a thousand times the start', () => {
    expect([0, 1, 2].map((n) => potRungLevel(n).toFixed())).toEqual(['560', '5600', '56000']);
  });

  const plain = (plan: HarvestPlan): { rungs: number; target: string; fromCash: string; fraction: string } => ({
    rungs: plan.rungs,
    target: plan.target.toFixed(),
    fromCash: plan.fromCash.toFixed(),
    fraction: plan.fraction.toFixed(),
  });

  it('harvests when the pot is worth the next rung or more', () => {
    expect(harvestDue('559.99', 0)).toBe(false);
    expect(harvestDue('560', 0)).toBe(true);
    // One rung passed: the next is at 5600.
    expect(harvestDue('560', 1)).toBe(false);
    expect(harvestDue('5600', 1)).toBe(true);
  });

  it('aims at half the pot value', () => {
    expect(harvestTarget('560').toFixed()).toBe('280');
    expect(harvestTarget('1000', { ...DEFAULT_POT_PARAMS, bankFraction: '0.25' }).toFixed()).toBe('250');
  });

  it('sells of every open campaign the fraction the free cash leaves uncovered, never more than all', () => {
    // Target 500, free cash 100: 400 out of an open equity of 900.
    expect(harvestFraction('500', '100', '900').toFixed(12)).toBe(D(400).div(900).toFixed(12));
    expect(harvestFraction('500', '500', '900').toFixed()).toBe('0');
    expect(harvestFraction('500', '800', '900').toFixed()).toBe('0');
    // More missing than the campaigns are worth: capped at everything.
    expect(harvestFraction('500', '10', '200').toFixed()).toBe('1');
    expect(harvestFraction('500', '300', '200').toFixed()).toBe('1');
    // Nothing open: nothing to sell.
    expect(harvestFraction('500', '100', '0').toFixed()).toBe('0');
  });

  it('plans nothing below the next rung', () => {
    expect(plain(planHarvest('500', '59.99', 0))).toEqual({ rungs: 0, target: '0', fromCash: '0', fraction: '0' });
    // The rung behind does not harvest again.
    expect(plain(planHarvest('700', '0', 1))).toEqual({ rungs: 1, target: '0', fromCash: '0', fraction: '0' });
  });

  it('takes half the pot from the free cash when that covers it', () => {
    expect(plain(planHarvest('560', '0', 0))).toEqual({ rungs: 1, target: '280', fromCash: '280', fraction: '0' });
    // 400 of cash and 200 in campaigns: 300 of the cash go, nothing is sold.
    expect(plain(planHarvest('400', '200', 0))).toEqual({ rungs: 1, target: '300', fromCash: '300', fraction: '0' });
  });

  it('takes all the free cash and sells a fraction of every campaign for the rest', () => {
    // Value 1000: target 500; 100 of cash; 400 of the 900 in campaigns.
    const plan = planHarvest('100', '900', 0);
    expect({ rungs: plan.rungs, target: plan.target.toFixed(), fromCash: plan.fromCash.toFixed() }).toEqual({ rungs: 1, target: '500', fromCash: '100' });
    expect(plan.fraction.toFixed(12)).toBe(D(400).div(900).toFixed(12));
    // Everything in campaigns: half of each is sold.
    expect(plain(planHarvest('0', '2000', 0))).toEqual({ rungs: 1, target: '1000', fromCash: '0', fraction: '0.5' });
  });

  it('harvests once per rung when the value has jumped several, each time on what the harvest before leaves', () => {
    // 60000 >= 560: 30000; 30000 >= 5600: 15000; 15000 < 56000. Three quarters of every campaign.
    expect(plain(planHarvest('0', '60000', 0))).toEqual({ rungs: 2, target: '45000', fromCash: '0', fraction: '0.75' });
    // With 1000 of cash the sales are 45000 - 1000 of the 59000 in campaigns.
    const plan = planHarvest('1000', '59000', 0);
    expect({ rungs: plan.rungs, target: plan.target.toFixed(), fromCash: plan.fromCash.toFixed() }).toEqual({ rungs: 2, target: '45000', fromCash: '1000' });
    expect(plan.fraction.toFixed(12)).toBe(D(44000).div(59000).toFixed(12));
    // All in cash: 30000, then 15000.
    expect(plain(planHarvest('60000', '0', 0))).toEqual({ rungs: 2, target: '45000', fromCash: '45000', fraction: '0' });
    // From the second rung on only one is crossed.
    expect(plain(planHarvest('0', '60000', 1))).toEqual({ rungs: 2, target: '30000', fromCash: '0', fraction: '0.5' });
  });

  it('keeps of a campaign the share of the contracts that were not sold, exactly', () => {
    // 26 of 49 contracts are left: an add unit of 0.49 coins becomes 0.26, not 0.2599...
    expect(keptAfterHarvest('0.49', '49', '23').toFixed()).toBe('0.26');
    expect(keptAfterHarvest('4.9049', '49', '23').toFixed()).toBe('2.6026');
    expect(keptAfterHarvest('10', '4', '4').toFixed()).toBe('0');
    expect(() => keptAfterHarvest('10', '0', '0')).toThrow(/positive/);
  });

  it('rejects a ladder that does not rise', () => {
    expect(() => planHarvest('10', '0', 0, { ...DEFAULT_POT_PARAMS, rungFactor: '1' })).toThrow(/ladder/);
    expect(() => planHarvest('10', '0', 0, { ...DEFAULT_POT_PARAMS, start: '0' })).toThrow(/ladder/);
  });

  it('sells whole lots, the whole position when less than the minimum order would be left, and nothing below the minimum order', () => {
    // 0.49 x 0.37 contracts = 0.1813 -> 0.18 (lots of 0.01).
    expect(harvestContracts('0.37', '0.49', BTC).toFixed()).toBe('0.18');
    expect(harvestContracts('0.37', '1', BTC).toFixed()).toBe('0.37');
    expect(harvestContracts('0.37', '0', BTC).toFixed()).toBe('0');
    // Minimum order of 30 contracts, lots of 1: selling 23 of 49 would leave 26, so all 49 go.
    const coarse: Instrument = { ...BTC, lotSz: '1', minSz: '30' };
    expect(harvestContracts('49', '0.48', coarse).toFixed()).toBe('49');
    // Selling 14 of 100 leaves 86, but 14 is below the minimum order: no sale.
    expect(harvestContracts('100', '0.14', coarse).toFixed()).toBe('0');
    expect(harvestContracts('100', '0.3', coarse).toFixed()).toBe('30');
    expect(harvestContracts('100', '0.69', coarse).toFixed()).toBe('69');
    expect(harvestContracts('100', '0.71', coarse).toFixed()).toBe('100');
  });

  it('is finished when nothing is open and the free cash is below the minimum stake', () => {
    expect(potFinished('5.59', 0)).toBe(true);
    expect(potFinished('5.6', 0)).toBe(false);
    expect(potFinished('0', 1)).toBe(false);
  });
});

describe('signals of the same close', () => {
  const ids = ['BTC-USDT-SWAP', 'ETH-USDT-SWAP', 'LTC-USDT-SWAP', 'XRP-USDT-SWAP', 'BCH-USDT-SWAP'];
  const close = Date.UTC(2024, 10, 11);

  it('are taken in an order fixed by the close time, whatever order they arrive in', () => {
    // Pinned: the live service and the backtest must shuffle alike.
    const order = ['XRP-USDT-SWAP', 'LTC-USDT-SWAP', 'ETH-USDT-SWAP', 'BTC-USDT-SWAP', 'BCH-USDT-SWAP'];
    expect(sameCloseOrder(ids, close)).toEqual(order);
    expect(sameCloseOrder([...ids].reverse(), close)).toEqual(order);
    expect(ids).toEqual(['BTC-USDT-SWAP', 'ETH-USDT-SWAP', 'LTC-USDT-SWAP', 'XRP-USDT-SWAP', 'BCH-USDT-SWAP']);
  });

  it('change from close to close and favour no instrument', () => {
    expect(sameCloseOrder(ids, close + DAY)).toEqual(['BTC-USDT-SWAP', 'XRP-USDT-SWAP', 'LTC-USDT-SWAP', 'ETH-USDT-SWAP', 'BCH-USDT-SWAP']);
    const first = new Map<string, number>();
    for (let d = 0; d < 2000; d++) {
      const order = sameCloseOrder(ids, close + d * DAY);
      expect([...order].sort()).toEqual([...ids].sort());
      first.set(order[0] as string, (first.get(order[0] as string) ?? 0) + 1);
    }
    // 400 expected each; far outside 300..500 would be a broken shuffle.
    for (const id of ids) expect(Math.abs((first.get(id) ?? 0) - 400)).toBeLessThan(100);
  });

  it('leave one signal alone', () => {
    expect(sameCloseOrder(['BTC-USDT-SWAP'], close)).toEqual(['BTC-USDT-SWAP']);
    expect(sameCloseOrder([], close)).toEqual([]);
  });
});
