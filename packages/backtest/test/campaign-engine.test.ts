import { D, dailyBarsFromHalfDays, Decimal, DEFAULT_POT_PARAMS, sameCloseOrder, type Candle, type FundingRecord, type PotParams } from '@pegasus/shared';
import { describe, expect, it } from 'vitest';
import { runCampaigns } from '../src/campaign/engine.js';
import { DEFAULT_CAMPAIGN_COSTS } from '../src/campaign/options.js';
import type { Banking, CampaignConfig, CampaignRecord, CampaignResult } from '../src/campaign/types.js';
import { config, data, day, EXIT_DAY, FLAT_DAY, halves, NOADD, QUIET, RISE_AND_EXIT, SETUP, SHORT, SIGNAL_DAY, type Row } from './campaign-helpers.js';
import { bar, DAY, HALF_DAY, HOUR, instrument, T0 } from './helpers.js';

// Hand arithmetic for a stake of 1 entered at an open of 100 on an instrument of the 'other' tier:
// fill 100.1, quantity 1 / (100.1 x (1/10 + 0.0005)), margin a tenth of the notional.
const FILL = D('100.1');
const Q0 = D(1).div(FILL.mul('0.1005'));
const M0 = Q0.mul(FILL).div(10);
const FEE = '0.0005';

function only(result: CampaignResult): CampaignRecord {
  expect(result.campaigns).toHaveLength(1);
  return result.campaigns[0] as CampaignRecord;
}

/** A multiple or a peak: printed with 15 significant digits. */
const near = (actual: string, expected: Decimal): void => {
  expect(D(actual).minus(expected).abs().lt('1e-12')).toBe(true);
};
/** Money as the records print it: 8 decimals. */
const money = (v: Decimal): string => v.toDecimalPlaces(8).toFixed();

describe('C1: the entry is filled at the next open', () => {
  it('fills at the open of the 12-hour bar after the signal close, with slippage, not at that close', () => {
    const result = runCampaigns([data([...SETUP, [104, 104.5, 103.5, 104], [104, 104.5, 103.8, 104.2]])], config());
    const c = only(result);
    expect(c).toMatchObject({ instId: 'AAA-USDT-SWAP', signalTs: day(3), entryTime: day(4), entryPx: '104.104', end: 'end-of-data', open: true });
    expect(result.signals).toEqual([{ instId: 'AAA-USDT-SWAP', signalTs: day(3), outcome: 'taken' }]);
    expect(result.span).toEqual({ from: T0, to: day(5) });
  });

  it('has no entry without a next bar', () => {
    const result = runCampaigns([data(SETUP)], config());
    expect(result.campaigns).toHaveLength(0);
    expect(result.signals).toEqual([{ instId: 'AAA-USDT-SWAP', signalTs: day(3), outcome: 'no-next-bar' }]);
  });

  it('takes one campaign per instrument: a signal while one is open is not a signal', () => {
    // Day 4 closes at a new high again.
    const result = runCampaigns([data([...SETUP, [104, 104.5, 103.5, 104], [104, 106, 103.8, 104.9], [104.9, 105, 104.5, 104.8]])], config());
    expect(result.campaigns).toHaveLength(1);
    expect(result.signals).toHaveLength(1);
  });

  it('reads the channel through the warm-up bars and trades none of them', () => {
    // One flat day of history, then the signal day: the entry channel of 3 is not full.
    const rows: Row[] = [...FLAT_DAY, ...SIGNAL_DAY, QUIET];
    expect(runCampaigns([data(rows)], config()).signals).toEqual([]);
    const warm = (high: number): Candle[] => [bar(T0 - 2 * DAY, 100, high, 99, 100), bar(T0 - DAY, 100, 101, 99, 100)];
    const c = only(runCampaigns([data(rows, { warmup: warm(101) })], config()));
    expect(c).toMatchObject({ signalTs: day(1), entryTime: day(2) });
    // A warm-up bar that traded higher than the close keeps the signal away.
    expect(runCampaigns([data(rows, { warmup: warm(103.2) })], config()).signals).toEqual([]);
  });

  it('frees the instrument when the campaign is liquidated inside the closing bar: that close may signal again', () => {
    // The second half of day 4 trades down to 90 (liquidation at 91) and closes at a new high.
    const result = runCampaigns([data([...SETUP, QUIET, [100, 108, 90, 107], [107, 107.5, 106.5, 107]])], config());
    expect(result.campaigns).toHaveLength(2);
    expect(result.campaigns[0]).toMatchObject({ entryTime: day(4), endTime: day(4) + HALF_DAY, end: 'liquidated' });
    expect(result.campaigns[1]).toMatchObject({ signalTs: day(4), entryTime: day(5), entryPx: '107.107', open: true });
  });
});

describe('C2: the stake pays the margin and the entry fee', () => {
  it('sizes a stake of 1 in the catalogue without rounding', () => {
    const c = only(runCampaigns([data([...SETUP, QUIET])], config()));
    expect(c).toMatchObject({ stake: '1', contracts: '', entryPx: '100.1' });
    // The fee is 0.05% of the notional; the margin is the rest of the stake.
    expect(c.fees).toBe(money(Q0.mul(FILL).mul(FEE)));
    expect(M0.plus(Q0.mul(FILL).mul(FEE)).toFixed(20)).toBe(D(1).toFixed(20));
  });
});

describe('C3, C4: liquidation', () => {
  // A stake entered at 100.1 with a tenth as margin and 1% maintenance is liquidated at 100.1 x 0.9 / 0.99 = 91.
  it('tests the low of the entry bar too, and pays nothing', () => {
    const c = only(runCampaigns([data([...SETUP, [100, 100.5, 90.99, 95], QUIET])], config()));
    expect(c).toMatchObject({ end: 'liquidated', endTime: day(4), multiple: '0', proceeds: '0', open: false });
    const safe = only(runCampaigns([data([...SETUP, [100, 100.5, 91.01, 95]])], config()));
    expect(safe.end).toBe('end-of-data');
  });

  it('liquidates at an open at or below the liquidation price before the exit decided at the last close is filled', () => {
    // Day 4 closes below the lows of days 2 and 3: out at the next open.
    const gone = only(runCampaigns([data([...SETUP, ...EXIT_DAY, [90.9, 92, 90.5, 91.5]])], config()));
    expect(gone).toMatchObject({ end: 'liquidated', endTime: day(5), multiple: '0' });
    const out = only(runCampaigns([data([...SETUP, ...EXIT_DAY, [91.1, 92, 91.05, 91.5]])], config()));
    expect(out.end).toBe('exit');
    expect(D(out.multiple).gt(0)).toBe(true);
  });

  it('takes a bar that adds and then trades down in the worse order: the low is tested against the price after the add', () => {
    // Day 4 closes at 105: an add at the next open. After it the liquidation price is about 95.5; before it, 91.
    const rows: Row[] = [...SETUP, QUIET, [100, 105.5, 99.8, 105], [105, 105.5, 95, 104], [104, 104.5, 103.5, 104]];
    expect(only(runCampaigns([data(rows)], config()))).toMatchObject({ end: 'liquidated', endTime: day(5), adds: 1, multiple: '0' });
    expect(only(runCampaigns([data(rows)], config({ params: NOADD })))).toMatchObject({ end: 'end-of-data', adds: 0 });
  });

  it('liquidates at a close where the funding has taken the equity down to the maintenance margin', () => {
    // Close 91.6: equity 1.51 a coin against 0.916 of maintenance. A settlement of 1% takes 0.916 away.
    const rows: Row[] = [...SETUP, [100, 100.5, 91.5, 91.6], [91.6, 92, 91.5, 91.8]];
    const funding: FundingRecord[] = [{ fundingTime: day(4) + 8 * HOUR, fundingRate: '0.01' }];
    expect(only(runCampaigns([data(rows, { funding })], config()))).toMatchObject({ end: 'liquidated', endTime: day(4), multiple: '0' });
    expect(only(runCampaigns([data(rows, { funding })], config({ funding: false }))).end).toBe('end-of-data');
  });

  it('uses the slippage and the maintenance rate of the instrument tier', () => {
    // BTC: fill 100.05, liquidation at 100.05 x 0.9 / 0.995 = 90.4975. A low of 90.6 liquidates the other tier only.
    const rows: Row[] = [...SETUP, [100, 100.5, 90.6, 95]];
    const btc = only(runCampaigns([data(rows, { inst: instrument('BTC-USDT-SWAP') })], config()));
    expect(btc).toMatchObject({ entryPx: '100.05', end: 'end-of-data' });
    expect(only(runCampaigns([data(rows)], config())).end).toBe('liquidated');
  });
});

describe('C5: the exit', () => {
  const rows: Row[] = [...SETUP, ...EXIT_DAY, [98, 98.5, 97, 97.5], [97.5, 98, 97, 97.5]];

  it('leaves at the open after a daily close below the exit channel, at the open less slippage, less the fee', () => {
    const c = only(runCampaigns([data(rows)], config()));
    expect(c).toMatchObject({ end: 'exit', endTime: day(5), open: false, adds: 0 });
    const fill = D(98).mul('0.9975');
    const proceeds = M0.plus(Q0.mul(fill.minus(FILL))).minus(Q0.mul(fill).mul(FEE));
    near(c.multiple, proceeds);
    expect(c.proceeds).toBe(money(proceeds));
    expect(c.fees).toBe(money(Q0.mul(FILL).mul(FEE).plus(Q0.mul(fill).mul(FEE))));
    // Not at the signal bar's close of 98.5.
    expect(D(c.multiple).lt(M0.plus(Q0.mul(D('98.5').minus(FILL))))).toBe(true);
  });

  it('never returns less than nothing', () => {
    // An absurd exit slippage of 12% takes the fill to 86.24, past what the margin covers.
    const costs = { ...config().costs, exitSlippage: { major: '0.12', other: '0.12' } };
    expect(only(runCampaigns([data(rows)], config({ costs })))).toMatchObject({ end: 'exit', proceeds: '0', multiple: '0' });
  });
});

describe('C6: adds', () => {
  it('adds at the open after a 12-hour close 5% above the entry open, cut to the cap', () => {
    const rows: Row[] = [...SETUP, QUIET, [100, 105.5, 99.8, 105], [106, 107, 105.5, 106.5], [106.5, 107, 106, 106.8]];
    const c = only(runCampaigns([data(rows)], config()));
    expect(c.adds).toBe(1);
    // At 106 the equity is 10.01 + 5.9 a coin; the cap leaves (159.1 - 106.106) / (106.106 x 1.005) of the entry quantity.
    const fill = D(106).mul('1.001');
    const added = Q0.mul(D('159.1').minus(fill)).div(fill.mul('1.005'));
    expect(added.lt(Q0)).toBe(true);
    const qty = Q0.plus(added);
    const avg = Q0.mul(FILL).plus(added.mul(fill)).div(qty);
    const margin = M0.minus(added.mul(fill).mul(FEE));
    // Open at the end: marked at the last close, less the fee of closing.
    near(c.multiple, margin.plus(qty.mul(D('106.8').minus(avg))).minus(qty.mul('106.8').mul(FEE)));
    expect(c.fees).toBe(money(Q0.mul(FILL).mul(FEE).plus(added.mul(fill).mul(FEE))));
    // The step is measured from the entry open (100), not from the fill (100.1): 105 is enough.
    expect(only(runCampaigns([data([...SETUP, QUIET, [100, 105.5, 99.8, 104.99], [106, 107, 105.5, 106.5]])], config())).adds).toBe(0);
  });

  it('adds the whole entry quantity when the cap leaves room for it', () => {
    // At 130 the equity is 39.91 a coin: twice the quantity is well within ten times that.
    const c = only(runCampaigns([data([...SETUP, QUIET, [100, 131, 99.8, 130], [130, 131, 129, 130.5]])], config()));
    expect(c.adds).toBe(1);
    const fill = D(130).mul('1.001');
    const avg = FILL.plus(fill).div(2);
    const margin = M0.minus(Q0.mul(fill).mul(FEE));
    near(c.multiple, margin.plus(Q0.mul(2).mul(D('130.5').minus(avg))).minus(Q0.mul(2).mul('130.5').mul(FEE)));
  });

  it('measures the next step from the open at which an add was due, also when the cap left nothing to add', () => {
    const rows: Row[] = [
      ...SETUP,
      QUIET,
      [100, 106.5, 99.8, 106], // 106 >= 105: an add is due
      [94, 95, 93.5, 94.5], // at 94 the position is beyond the cap: nothing added, the next step is 94 x 1.05 = 98.7
      [94.5, 99.8, 94, 99.6], // 99.6 >= 98.7: due again
      [99.7, 100, 99.2, 99.8], // nothing again at 99.7; the next step is 104.685
      [99.8, 105, 99.5, 104.7], // 104.7 >= 104.685 (and below the 105 the entry open would ask for)
      [104.8, 105, 104.5, 104.9], // the add happens here
    ];
    const c = only(runCampaigns([data(rows)], config()));
    expect(c).toMatchObject({ adds: 1, end: 'end-of-data' });
  });

  it('never adds in the noadd structure', () => {
    const rows: Row[] = [...SETUP, QUIET, [100, 131, 99.8, 130], [130, 131, 129, 130.5]];
    const c = only(runCampaigns([data(rows)], config({ params: NOADD })));
    expect(c.adds).toBe(0);
    near(c.multiple, M0.plus(Q0.mul(D('130.5').minus(FILL))).minus(Q0.mul('130.5').mul(FEE)));
  });

  it('does not add at a close that gives the exit signal', () => {
    // Exit channel of 1 day. Day 5 opens 6% lower, recovers 5% from that open and still closes below day 4's low.
    const rows: Row[] = [...SETUP, QUIET, [100, 106.5, 99.8, 106], [94, 95, 93.5, 94.5], [94.5, 99.3, 94, 99], [99, 99.5, 98.5, 99.2], [99.2, 99.5, 98.9, 99.1]];
    const c = only(runCampaigns([data(rows)], config({ params: { ...SHORT, exitChannel: 1 } })));
    expect(c).toMatchObject({ end: 'exit', endTime: day(6), adds: 0 });
  });
});

describe('C7: funding', () => {
  // Entry at day 4, exit signal at its close, out at the open of day 5.
  const rows: Row[] = [...SETUP, ...EXIT_DAY, [98, 98.5, 97, 97.5]];
  const E = day(4);
  const funding: FundingRecord[] = [
    { fundingTime: E, fundingRate: '0.01' }, // at the entry instant: before the campaign
    { fundingTime: E + 8 * HOUR, fundingRate: '0.001' }, // first bar, charged at its close of 100
    { fundingTime: E + 12 * HOUR, fundingRate: '0.002' }, // at that close: first bar too
    { fundingTime: E + 16 * HOUR, fundingRate: '0.003' }, // second bar, charged at its close of 98.5
    { fundingTime: E + 24 * HOUR, fundingRate: '-0.004' }, // at the exit instant: still the campaign's, and received
    { fundingTime: E + 32 * HOUR, fundingRate: '0.05' }, // after the exit
  ];

  it('charges the settlements in (entry, exit] at the close of the bar they fall in, on the quantity at that close', () => {
    const c = only(runCampaigns([data(rows, { funding })], config()));
    const paid = Q0.mul(100).mul('0.003').plus(Q0.mul('98.5').mul('-0.001'));
    expect(c.funding).toBe(money(paid.neg()));
    const fill = D(98).mul('0.9975');
    near(c.multiple, M0.minus(paid).plus(Q0.mul(fill.minus(FILL))).minus(Q0.mul(fill).mul(FEE)));
  });

  it('charges nothing when funding is off', () => {
    const c = only(runCampaigns([data(rows, { funding })], config({ funding: false })));
    expect(c.funding).toBe('0');
  });

  it('charges a settlement inside a hole at the close of the next bar the campaign sees', () => {
    // The second half of day 4 is missing; its settlement is charged at the close of day 5's first half (97.5).
    const halfDay = halves(rows).filter((c) => c.ts !== E + HALF_DAY);
    const c = only(runCampaigns([{ inst: instrument(), halfDay, daily: dailyBarsFromHalfDays(halfDay, 0), funding: [{ fundingTime: E + 16 * HOUR, fundingRate: '0.003' }] }], config()));
    expect(c.funding).toBe(money(Q0.mul('97.5').mul('0.003').neg()));
  });
});

describe('C8: holes in the data', () => {
  it('fills a decision at the open after the hole', () => {
    // The first half of day 4 is missing: the entry is at the open of its second half.
    const halfDay = halves([...SETUP, QUIET, [101, 101.5, 100.5, 101]]).filter((c) => c.ts !== day(4));
    const c = only(runCampaigns([{ inst: instrument(), halfDay, daily: dailyBarsFromHalfDays(halfDay, 0), funding: null }], config()));
    expect(c).toMatchObject({ signalTs: day(3), entryTime: day(4) + HALF_DAY, entryPx: '101.101' });
  });

  it('gives no signal at a daily close whose daily bar is missing, or that no 12-hour bar closes with', () => {
    const d = data([...SETUP, QUIET]);
    expect(runCampaigns([{ ...d, daily: d.daily.filter((c) => c.ts !== day(3)) }], config()).signals).toEqual([]);
    // The daily bar of day 3 is there, its second half is not.
    expect(runCampaigns([{ ...d, halfDay: d.halfDay.filter((c) => c.ts !== day(3) + HALF_DAY) }], config()).signals).toEqual([]);
    expect(runCampaigns([d], config()).signals).toHaveLength(1);
  });
});

describe('C9: the pot', () => {
  // One contract is 0.01 coin, whole contracts. A stake S at a fill of 100.1 buys S / 10.06005 coins.
  const POT: PotParams = { ...DEFAULT_POT_PARAMS };
  const pot = (over: Partial<CampaignConfig> = {}): CampaignConfig => config({ mode: 'pot', params: NOADD, ...over });
  /** Margin plus fee of `contracts` bought at 100.1. */
  const cost = (contracts: number): Decimal => D(contracts).mul('0.01').mul(FILL).mul('0.1005');

  it('stakes half the free cash in whole lots and leaves the rest of the stake in the free cash', () => {
    const result = runCampaigns([data([...SETUP, QUIET, QUIET])], pot());
    const c = only(result);
    // 28 / 10.06005 = 2.7833 coins = 278.33 contracts -> 278.
    expect(c.contracts).toBe('278');
    expect(c.stake).toBe(cost(278).toFixed());
    expect(result.end).toMatchObject({ ts: day(5), freeCash: D(56).minus(cost(278)).toFixed(), open: 1, banked: '0' });
    // Marked at the last close of 100: margin less the slippage of the entry.
    const equity = D('2.78').mul(FILL).div(10).plus(D('2.78').mul(D(100).minus(FILL)));
    expect(result.end?.openEquity).toBe(equity.toFixed());
    expect(result.end?.value).toBe(D(56).minus(cost(278)).plus(equity).toFixed());
    expect(result.finishedAt).toBeNull();
  });

  it('takes the signals of one close in the order of sameCloseOrder, each from the free cash that is left', () => {
    const ids = ['AAA-USDT-SWAP', 'BBB-USDT-SWAP'];
    const result = runCampaigns(
      ids.map((id) => data([...SETUP, QUIET], { inst: instrument(id) })),
      pot(),
    );
    const [first, second] = sameCloseOrder(ids, day(4)) as [string, string];
    expect(result.signals.map((s) => s.instId)).toEqual([first, second]);
    const stakes = new Map(result.campaigns.map((c) => [c.instId, c]));
    expect(stakes.get(first)?.contracts).toBe('278');
    // (56 - 27.966939) / 2 = 14.0165 -> 139.33 contracts -> 139.
    expect(stakes.get(second)?.contracts).toBe('139');
    expect(result.end?.freeCash).toBe(D(56).minus(cost(278)).minus(cost(139)).toFixed());
  });

  it('settles the exits of an open before the entries of the same open are staked', () => {
    // AAA leaves at the open of day 5; BBB, one day behind, enters at that open.
    const a = data([...SETUP, ...EXIT_DAY, [98, 98.5, 97.5, 98]]);
    const b = data([...FLAT_DAY, ...SETUP, [98, 98.5, 97.5, 98]], { inst: instrument('BBB-USDT-SWAP') });
    const result = runCampaigns([a, b], pot());
    const [first, second] = result.campaigns as [CampaignRecord, CampaignRecord];
    expect(first).toMatchObject({ instId: 'AAA-USDT-SWAP', end: 'exit', endTime: day(5) });
    expect(second).toMatchObject({ instId: 'BBB-USDT-SWAP', entryTime: day(5), entryPx: '98.098' });
    const fill = D(98).mul('0.9975');
    const back = D('2.78').mul(FILL).div(10).plus(D('2.78').mul(fill.minus(FILL))).minus(D('2.78').mul(fill).mul(FEE));
    expect(first.proceeds).toBe(money(back));
    // Half of the cash after the exit, at a fill of 98.098.
    const cash = D(56).minus(cost(278)).plus(back);
    const contracts = cash.div(2).div(D('98.098').mul('0.1005')).div('0.01').floor();
    expect(second.contracts).toBe(contracts.toFixed());
    expect(contracts.gt(D(56).minus(cost(278)).div(2).div(D('98.098').mul('0.1005')).div('0.01').floor())).toBe(true);
  });

  it('never stakes less than the minimum stake and skips a signal the free cash does not cover', () => {
    // 10 in the pot: the first stake is 5.6, not 5, and what is left is below 5.6.
    const a = data([...SETUP, QUIET, QUIET, QUIET]);
    const b = data([...FLAT_DAY, ...SETUP, QUIET], { inst: instrument('BBB-USDT-SWAP') });
    const result = runCampaigns([a, b], pot({ pot: { ...POT, start: '10' } }));
    // 5.6 / 10.06005 = 0.5567 coins -> 55 contracts.
    expect(only(result)).toMatchObject({ instId: 'AAA-USDT-SWAP', contracts: '55' });
    expect(result.signals).toEqual([
      { instId: 'AAA-USDT-SWAP', signalTs: day(3), outcome: 'taken' },
      { instId: 'BBB-USDT-SWAP', signalTs: day(4), outcome: 'skipped', rule: 'cash' },
    ]);
  });

  it('skips a signal whose stake does not buy the minimum order', () => {
    const result = runCampaigns([data([...SETUP, QUIET], { inst: instrument('AAA-USDT-SWAP', { minSz: '1000' }) })], pot());
    expect(result.campaigns).toHaveLength(0);
    expect(result.signals).toEqual([{ instId: 'AAA-USDT-SWAP', signalTs: day(3), outcome: 'skipped', rule: 'min-size' }]);
    expect(result.end?.freeCash).toBe('56');
  });

  it('stops when the pot is finished: nothing open and the free cash below the minimum stake', () => {
    // 10 in the pot: 5.533 staked and lost on day 4; 4.467 is left, below 5.6. The signal of day 5 is never looked at.
    const rows: Row[] = [...SETUP, [100, 100.5, 90, 95], [95, 96, 94, 95], [95, 120, 94, 119], [119, 120, 118, 119], [119, 120, 118, 119.5]];
    const result = runCampaigns([data(rows)], pot({ pot: { ...POT, start: '10' } }));
    expect(only(result)).toMatchObject({ end: 'liquidated', contracts: '55' });
    expect(result.finishedAt).toBe(day(4) + HALF_DAY);
    expect(result.end).toMatchObject({ ts: day(4) + HALF_DAY, freeCash: D(10).minus(cost(55)).toFixed(), open: 0 });
    expect(result.signals).toHaveLength(1);
    // The catalogue has no pot to finish: it goes on and takes the next signal.
    expect(runCampaigns([data(rows)], config({ params: NOADD })).campaigns).toHaveLength(2);
  });

  it('samples the pot at every 00:00 UTC', () => {
    const result = runCampaigns([data([...SETUP, QUIET, QUIET])], pot());
    expect(result.pot.map((s) => s.ts)).toEqual([0, 1, 2, 3, 4, 5].map(day));
    expect(result.pot[3]).toEqual({ ts: day(3), freeCash: '56', openEquity: '0', value: '56', banked: '0', open: 0 });
    // At the entry open the campaign is marked at that open.
    expect(result.pot[4]).toMatchObject({ freeCash: D(56).minus(cost(278)).toFixed(), open: 1 });
  });

  it('samples every 12-hour close with sampleEveryClose, and starts the free cash at startCash, the rungs staying on the start', () => {
    const result = runCampaigns([data([...SETUP, QUIET, QUIET])], pot({ sampleEveryClose: true, startCash: '55.5', from: day(1) }));
    expect(result.pot.map((s) => s.ts)).toEqual([2, 3, 4, 5, 6, 7, 8, 9, 10].map((n) => day(0) + n * HALF_DAY));
    expect(result.pot[0]).toEqual({ ts: day(1), freeCash: '55.5', openEquity: '0', value: '55.5', banked: '0', open: 0 });
    // 27.75 / 10.06005 = 2.7584 coins -> 275 contracts
    expect(only(result).contracts).toBe('275');
    expect(result.end?.freeCash).toBe(D('55.5').minus(cost(275)).toFixed());
    // with the default the free cash starts at the pot's start
    expect(runCampaigns([data([...SETUP, QUIET, QUIET])], pot()).pot[0]?.freeCash).toBe('56');
  });

  it('rounds an add down to whole lots', () => {
    // 278 contracts; at 106 the cap leaves 0.4969 of them = 138.2 contracts -> 138.
    const rows: Row[] = [...SETUP, QUIET, [100, 105.5, 99.8, 105], [106, 107, 105.5, 106.5]];
    const result = runCampaigns([data(rows)], pot({ params: SHORT }));
    const c = only(result);
    expect(c.adds).toBe(1);
    const fill = D(106).mul('1.001');
    const qty = D('2.78').plus('1.38');
    const avg = D('2.78').mul(FILL).plus(D('1.38').mul(fill)).div(qty);
    const margin = D('2.78').mul(FILL).div(10).minus(D('1.38').mul(fill).mul(FEE));
    expect(result.end?.openEquity).toBe(margin.plus(qty.mul(D('106.5').minus(avg))).toDecimalPlaces(8).toFixed());
    // The add took nothing from the free cash.
    expect(result.end?.freeCash).toBe(D(56).minus(cost(278)).toFixed());
  });
});

describe('C10: the catalogue', () => {
  it('takes every signal with a stake of 1, whatever the others do', () => {
    const ids = ['AAA-USDT-SWAP', 'BBB-USDT-SWAP', 'CCC-USDT-SWAP'];
    const result = runCampaigns(
      ids.map((id) => data([...SETUP, QUIET], { inst: instrument(id) })),
      config(),
    );
    expect(result.campaigns.map((c) => [c.stake, c.contracts])).toEqual([['1', ''], ['1', ''], ['1', '']]);
    expect(result).toMatchObject({ mode: 'catalogue', pot: [], bankings: [], end: null, finishedAt: null });
  });
});

describe('C11: a campaign open at the end of the data', () => {
  it('is listed at its equity at the last close less the fee of closing, and is not closed', () => {
    const c = only(runCampaigns([data([...SETUP, QUIET, [100, 102.5, 99.8, 102]])], config({ params: NOADD })));
    expect(c).toMatchObject({ end: 'end-of-data', open: true, endTime: day(4) + HALF_DAY });
    near(c.multiple, M0.plus(Q0.mul(D(102).minus(FILL))).minus(Q0.mul(102).mul(FEE)));
    // The peak is the highest equity at a close, over the stake.
    near(c.peak, M0.plus(Q0.mul(D(102).minus(FILL))));
  });

  it('keeps a peak of 1 for a campaign that never rose above its stake', () => {
    expect(only(runCampaigns([data([...SETUP, [100, 100.5, 99, 99.5]])], config())).peak).toBe('1');
  });
});

describe('C12: the range of the run', () => {
  const rows: Row[] = [...SETUP, QUIET, [100, 106, 99.8, 105.5], [105.5, 106, 105, 105.6], [105.6, 106, 105, 105.8]];

  it('decides no entry before `from`', () => {
    // The signal of day 3 is decided at day(4); the next one, of day 4, at day(5).
    const result = runCampaigns([data(rows)], config({ from: day(4) + 1 }));
    expect(only(result)).toMatchObject({ signalTs: day(4), entryTime: day(5) });
    expect(runCampaigns([data(rows)], config({ from: day(4) })).campaigns[0]).toMatchObject({ signalTs: day(3) });
  });

  it('drops the bars that close after `to`', () => {
    const result = runCampaigns([data(rows)], config({ to: day(4) + HALF_DAY }));
    expect(only(result)).toMatchObject({ entryTime: day(4), endTime: day(4), end: 'end-of-data' });
    expect(result.span).toEqual({ from: T0, to: day(4) + HALF_DAY });
  });
});

describe('C13: the ladder', () => {
  // 10 in the pot: rungs at 100, 1000, 10000. Half of it staked at a fill of 100.1 buys 49 contracts for
  // 4.9294245 and leaves 5.0705755. A coin held is worth its price less 90.09: 10.01 of margin less the 100.1 paid.
  const ladder = (over: Partial<CampaignConfig> = {}): CampaignConfig => config({ mode: 'pot', params: NOADD, pot: { ...DEFAULT_POT_PARAMS, start: '10', minStake: '1' }, ...over });
  const STAKE = D('4.9294245');
  const CASH = D(10).minus(STAKE);
  /** What `coins` sold at an open of `open` return: their equity at the fill less the fee. */
  const sold = (coins: string, open: number): Decimal => {
    const fill = D(open).mul('0.9975');
    return D(coins).mul(fill.minus('90.09')).minus(D(coins).mul(fill).mul(FEE));
  };
  /** A quiet 12 hours at `px`. */
  const at = (px: number): Row => [px, px + 1, px - 1, px];
  const first = (result: CampaignResult): Banking => {
    expect(result.bankings).toHaveLength(1);
    return result.bankings[0] as Banking;
  };
  const closeTo = (actual: string, expected: Decimal): void => {
    expect(D(actual).minus(expected).abs().lt('1e-7')).toBe(true);
  };

  it('harvests at the close that marks the pot at the rung: the free cash first, the rest by selling a fraction at the next open', () => {
    const result = runCampaigns([data(RISE_AND_EXIT)], ladder());
    // Day 5, 12:00: the campaign is marked at 400 and nothing ends. 5.0705755 + 0.49 x 309.91 = 156.9264755 >= 100.
    const equity = D('0.49').mul('309.91');
    const value = CASH.plus(equity);
    const target = value.div(2);
    const fraction = target.minus(CASH).div(equity);
    // 0.4833 x 49 contracts = 23.68 -> 23, sold at the open of the next bar, 400, with the costs of an exit.
    const fromSales = sold('0.23', 400);
    expect(first(result)).toEqual({
      ts: day(5) + HALF_DAY,
      rungs: 1,
      value: money(value),
      target: money(target),
      fromCash: money(CASH),
      fraction: fraction.toSignificantDigits(15).toFixed(),
      fromSales: money(fromSales),
      amount: money(CASH.plus(fromSales)),
    });
    // The campaign goes on with 26 contracts and leaves at the exit, filled at 350: that comes back to the free cash.
    const c = only(result);
    const back = sold('0.26', 350);
    expect(c).toMatchObject({ end: 'exit', endTime: day(8), stake: money(STAKE), contracts: '49', sales: 1, harvested: money(fromSales), proceeds: money(back) });
    // Money returned per money staked, the harvested part included.
    near(c.multiple, fromSales.plus(back).div(STAKE));
    // The peak is counted on the stake that is left: 151.8559 on 4.9294245 before the sale, the same ratio after it.
    near(c.peak, equity.div(STAKE));
    expect(result.end).toMatchObject({ freeCash: money(back), banked: money(CASH.plus(fromSales)), open: 0 });
    expect(result.peak).toEqual({ ts: day(5) + HALF_DAY, value: money(value) });
  });

  it('harvests from the free cash alone when that covers half the pot', () => {
    // Marked at 280 the pot is worth 98.13: no harvest. The exit is filled after a gap, at 400, and the pot is 156.34 of cash.
    const rows: Row[] = [...SETUP, QUIET, QUIET, at(280), at(280), at(280), at(280), [280, 280.5, 249, 250], [250, 251, 249, 250], at(400)];
    const result = runCampaigns([data(rows)], ladder());
    const cash = CASH.plus(sold('0.49', 400));
    // Looked at when the next close marks the pot, 12 hours after the exit.
    expect(first(result)).toEqual({ ts: day(8) + HALF_DAY, rungs: 1, value: money(cash), target: money(cash.div(2)), fromCash: money(cash.div(2)), fraction: '0', fromSales: '0', amount: money(cash.div(2)) });
    expect(only(result)).toMatchObject({ end: 'exit', sales: 0, harvested: '0' });
    expect(result.end).toMatchObject({ freeCash: money(cash.div(2)), banked: money(cash.div(2)), open: 0 });
  });

  it('advances one rung per crossing: a pot still above the rung it has harvested does not harvest again', () => {
    const result = runCampaigns([data([...SETUP, QUIET, QUIET, at(600), at(600), at(600), at(600)])], ladder());
    // 254.93 at the first close at 600: 24 of the 49 contracts go. The 25 left are worth 127.48, above 100, below 1000.
    expect(first(result)).toMatchObject({ ts: day(5) + HALF_DAY, rungs: 1, fromSales: money(sold('0.24', 600)) });
    expect(result.end).toMatchObject({ freeCash: '0', openEquity: money(D('0.25').mul('509.91')), open: 1 });
  });

  it('advances two rungs when the value has jumped two: one harvest, each rung taking half of what the one before left', () => {
    const result = runCampaigns([data([...SETUP, QUIET, QUIET, at(4500), at(4500), at(4500)])], ladder());
    // 2165.93: half leaves at the rung of 100, half of the 1082.96 left at the rung of 1000.
    const equity = D('0.49').mul('4409.91');
    const value = CASH.plus(equity);
    const target = value.mul('0.75');
    // (1624.44 - 5.07) / 2160.86 = 0.7494 of 49 contracts = 36.72 -> 36.
    const fromSales = sold('0.36', 4500);
    const b = first(result);
    expect(b).toMatchObject({ ts: day(5) + HALF_DAY, rungs: 2, value: money(value), fromCash: money(CASH), fromSales: money(fromSales), amount: money(CASH.plus(fromSales)) });
    closeTo(b.target, target);
    closeTo(b.fraction, target.minus(CASH).div(equity));
    expect(result.end).toMatchObject({ openEquity: money(D('0.13').mul('4409.91')), open: 1 });
  });

  it('never sells more than everything', () => {
    // A bank fraction of 2 asks for twice the pot: the fraction is capped at 1 and the campaign is sold out.
    const result = runCampaigns([data(RISE_AND_EXIT)], ladder({ pot: { ...DEFAULT_POT_PARAMS, start: '10', minStake: '1', bankFraction: '2' } }));
    const fromSales = sold('0.49', 400);
    expect(first(result)).toMatchObject({ rungs: 1, fromCash: money(CASH), fraction: '1', fromSales: money(fromSales) });
    expect(only(result)).toMatchObject({ end: 'harvest', endTime: day(5) + HALF_DAY, sales: 1, harvested: money(fromSales), proceeds: '0', open: false });
    // Nothing is left in the pot.
    expect(result.finishedAt).toBe(day(5) + HALF_DAY);
  });

  it('sells the whole position when the sale would leave less than the minimum order', () => {
    // Minimum order 30 contracts: selling 23 of 49 would leave 26.
    const result = runCampaigns([data(RISE_AND_EXIT, { inst: instrument('AAA-USDT-SWAP', { minSz: '30' }) })], ladder());
    const fromSales = sold('0.49', 400);
    const c = only(result);
    expect(c).toMatchObject({ end: 'harvest', endTime: day(5) + HALF_DAY, harvested: money(fromSales), proceeds: '0' });
    near(c.multiple, fromSales.div(STAKE));
    // What the fills returned is banked, though it is more than the harvest aimed at.
    const b = first(result);
    expect(b).toMatchObject({ fromSales: money(fromSales), amount: money(CASH.plus(fromSales)) });
    expect(D(b.amount).gt(b.target)).toBe(true);
  });

  // Two campaigns from the same close: 49 contracts for the first signal, 25 for the second, 2.555563 of cash left.
  const ids = ['AAA-USDT-SWAP', 'BBB-USDT-SWAP'];
  const [riser, other] = sameCloseOrder(ids, day(4)) as [string, string];
  const rising = data([...SETUP, QUIET, QUIET, QUIET, [100, 401, 99.8, 400], at(400), at(400)], { inst: instrument(riser) });
  /** The second campaign with an exit signal at the close that marks the first at 400, and `next` as its bar after that. */
  const leaving = (next: Row): ReturnType<typeof data> => data([...SETUP, QUIET, QUIET, ...EXIT_DAY, next, next], { inst: instrument(other) });
  const POT_CASH = D(10).minus(STAKE).minus(D('0.25').mul('100.1').mul('0.1005'));

  it('sells the same fraction of every open campaign, at the open at which an exit is filled, and keeps the books', () => {
    const result = runCampaigns([rising, leaving([98.5, 99, 98, 98.5])], ladder());
    // Day 6, 00:00: 2.555563 + 0.49 x 309.91 + 0.25 x 8.41 = 156.513963. The fraction is 0.4917: 24 of 49 and 12 of 25 contracts.
    const b = first(result);
    const up = sold('0.24', 400);
    const down = sold('0.12', 98.5);
    expect(b).toMatchObject({ ts: day(6), rungs: 1, fromCash: money(POT_CASH) });
    closeTo(b.fraction, D('156.513963').div(2).minus(POT_CASH).div('153.9584'));
    closeTo(b.fromSales, up.plus(down));
    // The campaign with the exit signal: its harvested share is banked, the rest of the exit goes to the free cash.
    const byId = new Map(result.campaigns.map((c) => [c.instId, c]));
    expect(byId.get(other)).toMatchObject({ end: 'exit', endTime: day(6), harvested: money(down), proceeds: money(sold('0.13', 98.5)) });
    expect(byId.get(riser)).toMatchObject({ end: 'end-of-data', harvested: money(up), open: true });
    // Cash conservation: what is in the pot and in the bank is the start, less every stake, plus what the campaigns returned.
    const sum = (values: string[]): Decimal => values.reduce((acc, v) => acc.plus(v), D(0));
    const { campaigns, end } = result;
    const returned = sum(campaigns.filter((c) => !c.open).map((c) => c.proceeds)).plus(sum(campaigns.map((c) => c.harvested)));
    closeTo(D(end?.freeCash ?? 0).plus(end?.banked ?? 0).toFixed(), D(10).minus(sum(campaigns.map((c) => c.stake))).plus(returned));
    closeTo(end?.banked ?? '', sum(result.bankings.map((x) => x.amount)));
    closeTo(b.fromSales, sum(campaigns.map((c) => c.harvested)));
    closeTo(end?.freeCash ?? '', sold('0.13', 98.5));
  });

  it('gets nothing from a campaign that is liquidated at that open', () => {
    const result = runCampaigns([rising, leaving([90, 91, 89, 90])], ladder());
    const b = first(result);
    expect(b.fromSales).toBe(money(sold('0.24', 400)));
    // Less than the harvest aimed at, and nothing is carried forward: the next closes do not harvest.
    expect(D(b.amount).lt(b.target)).toBe(true);
    expect(result.campaigns.find((c) => c.instId === other)).toMatchObject({ end: 'liquidated', endTime: day(6), harvested: '0', multiple: '0' });
  });

  it('lets a campaign that was sold from go on with what is left: its add unit shrinks with it', () => {
    // Pyramid. The close at 400 is the harvest and, 5% above the entry, an add: at the next open 23 contracts
    // are sold, then the add buys the 26 that are one unit now.
    const result = runCampaigns([data([...SETUP, QUIET, QUIET, at(400), at(400)])], ladder({ params: SHORT }));
    expect(only(result)).toMatchObject({ adds: 1, harvested: money(sold('0.23', 400)), open: true });
    const fill = D(400).mul('1.001');
    const margin = D('0.26').mul('10.01').minus(D('0.26').mul(fill).mul(FEE));
    const avg = FILL.plus(fill).div(2);
    expect(result.end?.openEquity).toBe(money(margin.plus(D('0.52').mul(D(400).minus(avg)))));
  });

  it('does not look at the pot of the catalogue', () => {
    expect(runCampaigns([data(RISE_AND_EXIT)], config({ params: NOADD }))).toMatchObject({ bankings: [], peak: null });
  });
});

describe('C14: the running bar', () => {
  it('fills the entry decided at the last close at the open of the running bar, which never closes', () => {
    // The signal close is the last close of the data: without the running bar there is no next bar.
    expect(runCampaigns([data(SETUP)], config()).signals).toEqual([{ instId: 'AAA-USDT-SWAP', signalTs: day(3), outcome: 'no-next-bar' }]);
    const result = runCampaigns([data(SETUP, { next: { ts: day(4), open: '104' } })], config());
    const c = only(result);
    expect(c).toMatchObject({ signalTs: day(3), entryTime: day(4), entryPx: '104.104', end: 'end-of-data', open: true, endTime: day(4), adds: 0 });
    expect(result.signals).toEqual([{ instId: 'AAA-USDT-SWAP', signalTs: day(3), outcome: 'taken' }]);
    // marked at its entry open, less the fee of closing: nothing of the bar but its open is known
    const fill = D('104.104');
    const qty = D(1).div(fill.mul('0.1005'));
    near(c.multiple, qty.mul(fill).div(10).plus(qty.mul(D(104).minus(fill))).minus(qty.mul(104).mul(FEE)));
    expect(result.span).toEqual({ from: T0, to: day(4) });
  });

  it('fills the exit decided at the last close at its open, and liquidates at an open at or below the liquidation price', () => {
    // Entry at the open of day 4, the exit signal at its close (day 5): without the running bar the campaign is still open.
    const rows: Row[] = [...SETUP, ...EXIT_DAY];
    expect(only(runCampaigns([data(rows)], config({ params: NOADD })))).toMatchObject({ end: 'end-of-data' });
    const c = only(runCampaigns([data(rows, { next: { ts: day(5), open: '98' } })], config({ params: NOADD })));
    expect(c).toMatchObject({ end: 'exit', endTime: day(5), open: false });
    const px = D(98).mul('0.9975');
    expect(c.proceeds).toBe(money(M0.plus(Q0.mul(px.minus(FILL))).minus(Q0.mul(px).mul(FEE))));
    expect(only(runCampaigns([data(rows, { next: { ts: day(5), open: '85' } })], config({ params: NOADD })))).toMatchObject({ end: 'liquidated', endTime: day(5), multiple: '0' });
  });

  it('is left out unless it opens at the last close', () => {
    const result = runCampaigns([data(SETUP, { next: { ts: day(4) + HALF_DAY, open: '104' } })], config());
    expect(result.campaigns).toHaveLength(0);
    expect(result.signals).toEqual([{ instId: 'AAA-USDT-SWAP', signalTs: day(3), outcome: 'no-next-bar' }]);
  });
});

describe("the exchange's limits", () => {
  // 56 in the pot: 278 contracts, 27.8278 of margin. A close at 105 and an add at 106, where the rule would add 138 contracts.
  const rows: Row[] = [...SETUP, QUIET, [100, 105.5, 99.8, 105], [106, 107, 105.5, 106.5]];
  const capped = (maxLever: string, bars: readonly Row[] = rows, exchangeCap = true): CampaignResult =>
    runCampaigns([data(bars, { inst: instrument('AAA-USDT-SWAP', { maxLever }) })], config({ mode: 'pot', params: SHORT, exchangeCap }));

  it('cut an add to the notional the exchange carries on the margin: maxLever x margin at the open', () => {
    // At 12x: (12 x 27.8278 - 2.78 x 106) / (106 + 12 x 0.0005 x 106.106) = 0.3681 coins -> 36 contracts.
    const result = capped('12');
    expect(only(result).adds).toBe(1);
    const fill = D(106).mul('1.001');
    const qty = D('2.78').plus('0.36');
    const avg = D('2.78').mul(FILL).plus(D('0.36').mul(fill)).div(qty);
    const margin = D('2.78').mul(FILL).div(10).minus(D('0.36').mul(fill).mul(FEE));
    expect(result.end?.openEquity).toBe(money(margin.plus(qty.mul(D('106.5').minus(avg)))));
    // The notional at the open stays within 12 x the margin that is left.
    expect(qty.mul(106).lte(margin.mul(12))).toBe(true);
    expect(D('3.15').mul(106).gt(margin.mul(12))).toBe(true);
    // Without the cap, and with room on the exchange, the rule's 138 contracts.
    expect(capped('12', rows, false).end?.openEquity).toBe(capped('100').end?.openEquity);
    expect(capped('100').end?.openEquity).not.toBe(result.end?.openEquity);
  });

  it('skip the add when nothing fits, and still move the price the next step is measured from', () => {
    // At 11x the position has room below 110.11 only. The add due at 111 is skipped; the close at 106 is 5% above the
    // entry, not above 111: nothing is due at the next open, where 10 contracts would fit.
    const bars: Row[] = [...SETUP, QUIET, [100, 111.5, 99.8, 111], [111, 111.5, 105.5, 106], [106, 106.5, 105.5, 106.2]];
    expect(only(capped('11', bars)).adds).toBe(0);
    expect(only(capped('11', bars, false)).adds).toBe(1);
  });

  it('liquidate at the maintenance rate of the instrument: the first tier of the exchange plus the fee in the pot', () => {
    const product = (instId: string, low: number): CampaignResult =>
      runCampaigns([data([...SETUP, [100, 100.5, low, 95]], { inst: instrument(instId) })], config({ costs: DEFAULT_CAMPAIGN_COSTS }));
    const reference = (instId: string, low: number): CampaignResult => runCampaigns([data([...SETUP, [100, 100.5, low, 95]], { inst: instrument(instId) })], config());
    // BTC: 0.45% puts the liquidation at 100.05 x 0.9 / 0.9955 = 90.452; the reference's 0.5% at 90.4975.
    expect(product('BTC-USDT-SWAP', 90.47).maintenance).toEqual({ 'BTC-USDT-SWAP': '0.0045' });
    expect(only(product('BTC-USDT-SWAP', 90.47)).end).toBe('end-of-data');
    expect(only(reference('BTC-USDT-SWAP', 90.47)).end).toBe('liquidated');
    // LTC: 0.70% -> 100.1 x 0.9 / 0.993 = 90.725; the reference's 1% -> 91.
    expect(product('LTC-USDT-SWAP', 90.9).maintenance).toEqual({ 'LTC-USDT-SWAP': '0.007' });
    expect(only(product('LTC-USDT-SWAP', 90.9)).end).toBe('end-of-data');
    expect(only(reference('LTC-USDT-SWAP', 90.9)).end).toBe('liquidated');
    // A coin the table does not list: 1.05% -> 91.046.
    expect(product('AAA-USDT-SWAP', 91.03).maintenance).toEqual({ 'AAA-USDT-SWAP': '0.0105' });
    expect(only(product('AAA-USDT-SWAP', 91.03)).end).toBe('liquidated');
    expect(only(reference('AAA-USDT-SWAP', 91.03)).end).toBe('end-of-data');
  });
});

describe('what the replay leaves out', () => {
  it('leaves out an instrument that does not offer the leverage of the rule, and says so', () => {
    const result = runCampaigns([data([...SETUP, QUIET], { inst: instrument('AAA-USDT-SWAP', { maxLever: '5' }) })], config());
    expect(result.instIds).toEqual([]);
    expect(result.campaigns).toHaveLength(0);
    expect(result.notes[0]).toContain('AAA-USDT-SWAP');
  });

  it('handles linear contracts only', () => {
    expect(() => runCampaigns([data(SETUP, { inst: instrument('AAA-USD-SWAP', { ctType: 'inverse' }) })], config())).toThrow(/linear/);
  });
});
