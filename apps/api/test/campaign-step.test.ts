/**
 * The campaign service's decisions at a close (services/campaign-step.ts), case by case, without any I/O: entries and
 * exits at 00:00 UTC only, adds and the ladder at every 12-hour close, the order of the same close, the stake and its
 * minimum, the adds' caps and reference, the ladder from the free cash and by sales, a finished pot, missed closes.
 */
import { describe, expect, it } from 'vitest';
import {
  campaignAddQuantity,
  campaignContracts,
  campaignEntryQuantity,
  D,
  DEFAULT_CAMPAIGN_PARAMS,
  DEFAULT_POT_PARAMS,
  harvestContracts,
  keptAfterHarvest,
  planHarvest,
  potFinished,
  sameCloseOrder,
  type CampaignParams,
  type Candle,
  type Instrument,
} from '@pegasus/shared';
import {
  afterSale,
  barsAt,
  closeAtOrBefore,
  closesAfter,
  DAY_MS,
  decideClose,
  HALF_DAY_MS,
  resizeAddToSpare,
  sizeAdd,
  sizeEntry,
  walkMissedCloses,
  type CloseBars,
  type DecideInput,
  type PlannedAction,
  type StepCampaign,
} from '../src/services/campaign-step.js';

const T0 = Date.UTC(2026, 0, 1);
const day = (n: number): number => T0 + n * DAY_MS;
const P = DEFAULT_CAMPAIGN_PARAMS;
const NOADD: CampaignParams = { ...P, structure: 'noadd' };

function instrument(instId: string, over: Partial<Instrument> = {}): Instrument {
  const [base = ''] = instId.split('-');
  return {
    instId, instType: 'SWAP', uly: `${base}-USDT`, baseCcy: base, quoteCcy: 'USDT', settleCcy: 'USDT', ctVal: '1', ctValCcy: base, ctMult: '1', ctType: 'linear',
    lotSz: '0.01', minSz: '0.01', tickSz: '0.01', maxLmtSz: '100000', maxMktSz: '100000', maxLever: '100', state: 'live', ...over,
  };
}
const AAA = instrument('AAA-USDT-SWAP');
const BBB = instrument('BBB-USDT-SWAP');
const CCC = instrument('CCC-USDT-SWAP');

const candle = (ts: number, open: number, high: number, low: number, close: number, confirm = true): Candle => ({ ts, open: String(open), high: String(high), low: String(low), close: String(close), vol: '0', volCcy: '0', confirm });

/** Daily bars from [high, low, close], day 0 first; the forming bar of the next day after them, unconfirmed. */
function days(rows: ReadonlyArray<readonly [number, number, number]>): Candle[] {
  const out = rows.map(([high, low, close], i) => candle(day(i), close, high, low, close));
  const last = rows[rows.length - 1];
  if (last) out.push(candle(day(rows.length), last[2], last[2], last[2], last[2], false));
  return out;
}

/** n quiet days: high 101, low 99, close 100. */
const flat = (n: number): Array<[number, number, number]> => Array.from({ length: n }, () => [101, 99, 100] as [number, number, number]);

/** The 12-hour bar that closes at `closeTs` (closing at `close`) and the one running after it, which opens at `next` (absent when null). */
function halves(closeTs: number, close: number, next: number | null): Candle[] {
  const out = [candle(closeTs - HALF_DAY_MS, close, close, close, close)];
  if (next !== null) out.push(candle(closeTs, next, next, next, next, false));
  return out;
}

/** The bars of an instrument at a close: its days and the 12-hour bars around the close; the running bar opens at the last close unless `next` says otherwise. */
function at(inst: Instrument, closeTs: number, dailyRows: ReadonlyArray<readonly [number, number, number]>, next?: number, params: CampaignParams = P): { inst: Instrument; bars: CloseBars } {
  const lastClose = dailyRows[dailyRows.length - 1]?.[2] ?? 100;
  return { inst, bars: barsAt(inst.instId, halves(closeTs, lastClose, next ?? lastClose), days(dailyRows), closeTs, params) };
}

function input(over: Partial<DecideInput>): DecideInput {
  return { closeTs: day(21), params: P, pot: DEFAULT_POT_PARAMS, rungs: 0, freeCash: '56', campaigns: [], instruments: [], foreign: new Set(), ...over };
}

const kinds = (actions: PlannedAction[]): string[] => actions.map((a) => ('instId' in a ? `${a.kind}:${a.instId}` : a.kind));

/** An open campaign of 1 coin bought at 100 with a margin of 10, marked at `markPx`. */
function campaign(inst: Instrument, over: Partial<StepCampaign> = {}, markPx = '100'): StepCampaign {
  return { id: `${inst.instId}@x`, instId: inst.instId, addRef: '100', addUnit: '1', pendingExit: false, position: { contracts: '1', avgPx: '100', margin: '10', markPx }, ...over };
}

describe('closes', () => {
  it('are the UTC midnights and noons; the walk lists the ones after the last processed, oldest first', () => {
    expect(closeAtOrBefore(day(3) + 5 * 3_600_000)).toBe(day(3));
    expect(closeAtOrBefore(day(3) + 13 * 3_600_000)).toBe(day(3) + HALF_DAY_MS);
    expect(closesAfter(day(1), day(2) + 1)).toEqual([day(1) + HALF_DAY_MS, day(2)]);
    expect(closesAfter(day(1), day(1) + HALF_DAY_MS - 1)).toEqual([]);
  });
});

describe('entries', () => {
  // 20 quiet days, then a day that closes at 102, above the 101 of the 20 days before it.
  const breakout = [...flat(20), [103, 100, 102] as const];

  it('open at a 00:00 UTC close above the 20-day high, priced at the open of the bar after the close', () => {
    const d = decideClose(input({ instruments: [at(AAA, day(21), breakout, 102.5)] }));
    expect(d.actions).toEqual([{ kind: 'enter', instId: AAA.instId, signalTs: day(20), price: D('102.5'), close: D('102'), entryHigh: '101' }]);
  });

  it('never at a 12:00 close, and never without a close above the high', () => {
    // the same bars looked at from the noon after: no daily signal there
    const noon = day(21) + HALF_DAY_MS;
    expect(decideClose(input({ closeTs: noon, instruments: [{ inst: AAA, bars: barsAt(AAA.instId, halves(noon, 102, 102), days(breakout), noon, P) }] })).actions).toEqual([]);
    // a close at the high is not above it
    expect(decideClose(input({ instruments: [at(AAA, day(21), [...flat(20), [101, 99, 101]])] })).actions).toEqual([]);
    // 19 days do not fill the channel
    const short = [...flat(19), [103, 100, 102] as const];
    expect(decideClose(input({ closeTs: day(20), instruments: [at(AAA, day(20), short)] })).actions).toEqual([]);
  });

  it('only on an instrument without a campaign and without a position the ledger does not know', () => {
    const held = decideClose(input({ instruments: [at(AAA, day(21), breakout)], campaigns: [campaign(AAA)] }));
    expect(kinds(held.actions)).toEqual([]);
    const foreign = decideClose(input({ instruments: [at(AAA, day(21), breakout)], foreign: new Set([AAA.instId]) }));
    expect(foreign.actions).toEqual([]);
    expect(foreign.skips).toEqual([{ kind: 'enter', instId: AAA.instId, campaignId: null, reason: 'foreign-position', plan: { close: '102', entryHigh: '101' } }]);
    // an open campaign whose position is gone but not explained yet keeps its instrument
    expect(decideClose(input({ instruments: [at(AAA, day(21), breakout)], unresolved: new Set([AAA.instId]) })).actions).toEqual([]);
  });

  it('need the confirmed daily bar of that close and the 12-hour bar closing with it (C8)', () => {
    const unconfirmed = days(breakout).map((c) => (c.ts === day(20) ? { ...c, confirm: false } : c));
    const bars = barsAt(AAA.instId, halves(day(21), 102, 102), unconfirmed, day(21), P);
    expect(bars.daily).toBeNull();
    expect(bars.input.note).toMatch(/daily bar that closed then is not confirmed/);
    expect(decideClose(input({ instruments: [{ inst: AAA, bars }] })).actions).toEqual([]);
    const no12h = barsAt(AAA.instId, [], days(breakout), day(21), P);
    expect(no12h).toMatchObject({ close: null, price: null, daily: null });
    // without the bar after the close its price is the close
    const notYet = barsAt(AAA.instId, halves(day(21), 102, null), days(breakout), day(21), P);
    expect(notYet.price?.toFixed()).toBe('102');
    expect(notYet.input).toMatchObject({ price: '102', halfDay: { ts: day(21) - HALF_DAY_MS, close: '102' }, daily: { entry: true, entryHigh: '101', exitLow: '99' } });
  });

  it('of one close are taken in the order of sameCloseOrder, whatever order the instruments come in', () => {
    const insts = [AAA, BBB, CCC];
    const expected = sameCloseOrder(insts.map((i) => i.instId), day(21));
    for (const order of [insts, [...insts].reverse(), [BBB, CCC, AAA]]) {
      const d = decideClose(input({ instruments: order.map((i) => at(i, day(21), breakout)) }));
      expect(d.actions.map((a) => (a.kind === 'enter' ? a.instId : ''))).toEqual(expected);
    }
    // another close shuffles them otherwise
    const other = sameCloseOrder(insts.map((i) => i.instId), day(22));
    expect(other).not.toEqual(expected);
  });
});

describe('the stake', () => {
  it('is half the free cash, never less than the minimum stake; below it the signal is skipped', () => {
    const stake = (cash: string): string | null => {
      const s = sizeEntry(cash, '100', null, AAA, P, DEFAULT_POT_PARAMS);
      return s.ok ? s.planned.toFixed() : s.reason;
    };
    expect(stake('56')).toBe('28');
    expect(stake('28')).toBe('14');
    expect(stake('14')).toBe('7');
    // half of 10 is below 5.6: the minimum stake
    expect(stake('10')).toBe('5.6');
    expect(stake('5.6')).toBe('5.6');
    expect(stake('5.59')).toBe('cash');
  });

  it('buys whole lots at the open of the running bar; the margin is the notional at the fill over the leverage', () => {
    const s = sizeEntry('56', '100', '100.5', AAA, P, DEFAULT_POT_PARAMS);
    if (!s.ok) throw new Error('not sized');
    // 28 / (100 x 0.1005) = 2.786 coin: 2.78 contracts of 1 coin
    expect(s.contracts.toFixed()).toBe(campaignContracts(campaignEntryQuantity('28', '100'), AAA).toFixed());
    expect(s.contracts.toFixed()).toBe('2.78');
    expect(s.margin.toFixed()).toBe(D('2.78').mul('100.5').div(10).toFixed());
    expect(s.fee.toFixed()).toBe(D('2.78').mul('100.5').mul('0.0005').toFixed());
    expect(s.fillPx.toFixed()).toBe('100.5');
  });

  it('is bought at the fill when the market has risen so far since the open that the stake would not fit in the free cash', () => {
    // the minimum stake of 5.6 out of 5.7: at the open 0.55 contracts, at a fill 4% higher they would cost 5.75
    const s = sizeEntry('5.7', '100', '104', AAA, P, DEFAULT_POT_PARAMS);
    if (!s.ok) throw new Error('not sized');
    expect(s.contracts.toFixed()).toBe(campaignContracts(campaignEntryQuantity('5.6', '104'), AAA).toFixed());
    expect(s.margin.plus(s.fee).lte('5.7')).toBe(true);
  });

  it('that does not buy the minimum order is a skip', () => {
    const big = instrument('BIG-USDT-SWAP', { minSz: '1', lotSz: '1' });
    expect(sizeEntry('56', '1000', null, big, P, DEFAULT_POT_PARAMS)).toEqual({ ok: false, reason: 'min-size', planned: D('28') });
  });
});

describe('adds', () => {
  // A 12:00 close at 105: 5% above the reference of 100.
  const noon = day(21) + HALF_DAY_MS;
  const bars = (close: number, next = close): { inst: Instrument; bars: CloseBars } => ({ inst: AAA, bars: barsAt(AAA.instId, halves(noon, close, next), [], noon, P) });

  it('are due at a 12-hour close addStep above the reference, in the pyramid only', () => {
    const d = decideClose(input({ closeTs: noon, instruments: [bars(105, 105.2)], campaigns: [campaign(AAA)] }));
    expect(d.actions).toEqual([{ kind: 'add', campaignId: `${AAA.instId}@x`, instId: AAA.instId, close: D('105'), ref: D('100'), price: D('105.2') }]);
    expect(decideClose(input({ closeTs: noon, instruments: [bars(104.99)], campaigns: [campaign(AAA)] })).actions).toEqual([]);
    expect(decideClose(input({ closeTs: noon, params: NOADD, instruments: [bars(110)], campaigns: [campaign(AAA)] })).actions).toEqual([]);
    // nothing at a close whose bar is not confirmed
    expect(decideClose(input({ closeTs: noon, instruments: [{ inst: AAA, bars: barsAt(AAA.instId, [], [], noon, P) }], campaigns: [campaign(AAA)] })).actions).toEqual([]);
  });

  it('none at a close that gives the exit signal: the exit wins', () => {
    // a midnight close below the 10-day low that is also 5% above an old reference
    const rows = [...flat(20), [100, 90, 95] as const];
    const d = decideClose(input({ instruments: [at(AAA, day(21), rows)], campaigns: [campaign(AAA, { addRef: '80' })] }));
    expect(kinds(d.actions)).toEqual([`exit:${AAA.instId}`]);
  });

  it('are sized at the open of the running bar, cut to the cap, and also to what the risk engine and the exchange accept now', () => {
    // 1 coin bought at 100 on a margin of 10, at 105: equity 15. The cap: (10 x 15 - 105) / (105 x 1.005) = 0.4264 coin.
    const pos = { contracts: '1', avgPx: '100', margin: '10', markPx: '105', lever: '100' };
    const atOpen = sizeAdd(pos, '1', '105', null, AAA, P);
    expect(atOpen.atOpen.toFixed()).toBe(campaignAddQuantity({ qty: '1', avgPx: '100', margin: '10' }, '1', '105', '105', P, '100').toFixed());
    expect(atOpen.contracts.toFixed()).toBe('0.42');
    expect(atOpen.live).toBeNull();
    // the market has fallen back to 104 since the open: the equity is 14 and the cap lower
    const now = sizeAdd(pos, '1', '105', { markPx: '104', fillPx: '104.1' }, AAA, P);
    expect(now.live?.lt(now.atOpen)).toBe(true);
    expect(now.contracts.toFixed()).toBe(campaignContracts(now.live ?? 0, AAA).toFixed());
    // within the campaign's leverage at the live prices, as the risk engine checks it
    const added = now.contracts;
    const notional = added.mul('104.1').plus(D(1).mul('104'));
    const equity = D(10).minus(added.mul('104.1').mul('0.0005')).plus(D(1).mul(4));
    expect(notional.div(equity).lte(10)).toBe(true);
  });

  it('a capped add leaves nothing to add: the decision stands (the reference moves), the size is 0', () => {
    // at 105 a position whose margin was eaten by funding: equity 10.5 carries 105 / 10.5 = 10x already
    const thin = { contracts: '1', avgPx: '100', margin: '5.5', markPx: '105', lever: '100' };
    expect(sizeAdd(thin, '1', '105', null, AAA, P).contracts.toFixed()).toBe('0');
    const d = decideClose(input({ closeTs: noon, instruments: [bars(105, 106)], campaigns: [campaign(AAA, { position: { contracts: '1', avgPx: '100', margin: '5.5', markPx: '105' } })] }));
    expect(d.actions).toEqual([{ kind: 'add', campaignId: `${AAA.instId}@x`, instId: AAA.instId, close: D('105'), ref: D('100'), price: D('106') }]);
  });

  it('refused at the exchange cap, are sized again from what the exchange says the margin can spare', () => {
    // 0.5 spare at 100x and a fill of 105: (1/100 + 0.0005) x 105 = 1.1025 a coin; 99% of 0.5 buys 0.449 coin
    expect(resizeAddToSpare(D('0.42'), '0.5', '105', '100', AAA, P).toFixed()).toBe('0.42');
    expect(resizeAddToSpare(D('0.42'), '0.2', '105', '100', AAA, P).toFixed()).toBe('0.17');
    expect(resizeAddToSpare(D('0.42'), '0.001', '105', '100', AAA, P).toFixed()).toBe('0');
  });
});

describe('exits', () => {
  it('at a 00:00 UTC close below the 10-day low; never at 12:00', () => {
    const rows = [...flat(20), [100, 97, 98] as const];
    const d = decideClose(input({ instruments: [at(AAA, day(21), rows)], campaigns: [campaign(AAA)] }));
    expect(d.actions).toEqual([{ kind: 'exit', campaignId: `${AAA.instId}@x`, instId: AAA.instId, signal: true, signalTs: day(20) }]);
    // at the low of the channel it stays
    expect(decideClose(input({ instruments: [at(AAA, day(21), [...flat(20), [100, 99, 99]])], campaigns: [campaign(AAA)] })).actions).toEqual([]);
    const noon = day(21) + HALF_DAY_MS;
    expect(decideClose(input({ closeTs: noon, instruments: [{ inst: AAA, bars: barsAt(AAA.instId, halves(noon, 90, 90), days(rows), noon, P) }], campaigns: [campaign(AAA)] })).actions).toEqual([]);
  });

  it('an exit decided before and not carried out is decided again at every step, bars or not', () => {
    const d = decideClose(input({ closeTs: day(21) + HALF_DAY_MS, campaigns: [campaign(AAA, { pendingExit: true })], instruments: [{ inst: AAA, bars: barsAt(AAA.instId, [], [], day(21) + HALF_DAY_MS, P) }] }));
    expect(d.actions).toEqual([{ kind: 'exit', campaignId: `${AAA.instId}@x`, instId: AAA.instId, signal: false, signalTs: null }]);
  });
});

describe('the ladder', () => {
  const noon = day(21) + HALF_DAY_MS;
  const quiet = (inst: Instrument): { inst: Instrument; bars: CloseBars } => ({ inst, bars: barsAt(inst.instId, halves(noon, 100, 100), [], noon, P) });

  it('banks from the free cash alone while it covers the target, and sells nothing', () => {
    // 600 of free cash and a campaign worth 10: 610 is past the rung of 560; half of it, 305, comes from the cash
    const d = decideClose(input({ closeTs: noon, freeCash: '600', campaigns: [campaign(AAA)], instruments: [quiet(AAA)] }));
    expect(d.value.toFixed()).toBe('610');
    expect(d.actions).toEqual([{ kind: 'bank', value: D('610'), target: D('305'), fromCash: D('305'), fraction: D('0'), rungs: 1 }]);
  });

  it('sells the same fraction of every open campaign for what the cash does not cover, in whole lots', () => {
    // 100 of free cash, two campaigns of 10 coins at 100 on a margin of 10 marked at 150: 510 each. The pot: 1120.
    const rich = (inst: Instrument): StepCampaign => campaign(inst, { position: { contracts: '10', avgPx: '100', margin: '10', markPx: '150' } }, '150');
    const d = decideClose(input({ closeTs: noon, freeCash: '100', campaigns: [rich(AAA), rich(BBB)], instruments: [quiet(AAA), quiet(BBB)] }));
    const plan = planHarvest('100', '1020', 0, DEFAULT_POT_PARAMS);
    expect(d.actions[0]).toEqual({ kind: 'bank', value: D('1120'), target: plan.target, fromCash: D('100'), fraction: plan.fraction, rungs: 1 });
    // (560 - 100) / 1020 = 0.45098: 4.5 of the 10 contracts of each
    const contracts = harvestContracts('10', plan.fraction, AAA);
    expect(contracts.toFixed()).toBe('4.5');
    expect(d.actions.slice(1)).toEqual([
      { kind: 'sell', campaignId: `${AAA.instId}@x`, instId: AAA.instId, held: D('10'), contracts, fraction: plan.fraction },
      { kind: 'sell', campaignId: `${BBB.instId}@x`, instId: BBB.instId, held: D('10'), contracts, fraction: plan.fraction },
    ]);
  });

  it('a sale too small for the minimum order is not made', () => {
    const lots = instrument('LOT-USDT-SWAP', { lotSz: '1', minSz: '1' });
    const one = campaign(lots, { addRef: '300', position: { contracts: '3', avgPx: '100', margin: '10', markPx: '300' } }, '300');
    // 600 marked against 40 of free cash: past 560, the cash covers 40 of the 320, a fraction of 0.47 of 3 contracts
    const d = decideClose(input({ closeTs: noon, freeCash: '40', campaigns: [one], instruments: [{ inst: lots, bars: barsAt(lots.instId, halves(noon, 300, 300), [], noon, P) }] }));
    expect(kinds(d.actions)).toEqual(['bank', `sell:${lots.instId}`]);
    const tiny = decideClose(input({ closeTs: noon, freeCash: '530', campaigns: [one], instruments: [{ inst: lots, bars: barsAt(lots.instId, halves(noon, 300, 300), [], noon, P) }] }));
    expect(kinds(tiny.actions)).toEqual(['bank']);
    expect(tiny.skips).toMatchObject([{ kind: 'sell', instId: lots.instId, reason: 'min-size' }]);
  });

  it('a campaign that sold a share keeps its add unit and stake basis less that share (keptAfterHarvest)', () => {
    const kept = afterSale('2', '28', '10', '4.5');
    expect(kept.addUnit.toFixed()).toBe(keptAfterHarvest('2', '10', '4.5').toFixed());
    expect(kept.addUnit.toFixed()).toBe('1.1');
    expect(kept.basis.toFixed()).toBe('15.4');
  });

  it('is not looked at below the next rung; past the first, the next one is ten times higher', () => {
    expect(kinds(decideClose(input({ closeTs: noon, freeCash: '549', campaigns: [campaign(AAA)], instruments: [quiet(AAA)] })).actions)).toEqual([]);
    expect(kinds(decideClose(input({ closeTs: noon, freeCash: '700', rungs: 1, campaigns: [campaign(AAA)], instruments: [quiet(AAA)] })).actions)).toEqual([]);
  });
});

describe('a finished pot', () => {
  it('is one without a campaign whose free cash is below the minimum stake: no entry can be sized there', () => {
    expect(potFinished('5.5', 0, DEFAULT_POT_PARAMS)).toBe(true);
    expect(potFinished('5.5', 1, DEFAULT_POT_PARAMS)).toBe(false);
    expect(potFinished('5.6', 0, DEFAULT_POT_PARAMS)).toBe(false);
    expect(sizeEntry('5.5', '100', null, AAA, P, DEFAULT_POT_PARAMS)).toEqual({ ok: false, reason: 'cash', planned: null });
  });
});

describe('missed closes', () => {
  // Days 0-19 quiet; day 20 closes at 106 (an entry signal, and 6% above a reference of 100); the noon after it at
  // 112 (5% above 106.5, the open after the day-20 close); day 21 closes at 95, below the 10-day low (an exit).
  const daily = days([...flat(20), [107, 100, 106], [113, 94, 95]]);
  const halfDay = [
    candle(day(20), 100, 104, 100, 103),
    candle(day(20) + HALF_DAY_MS, 103, 107, 102, 106),
    candle(day(21), 106.5, 112.5, 106, 112),
    candle(day(21) + HALF_DAY_MS, 112, 113, 94, 95),
    candle(day(22), 95.5, 96, 95, 95.5, false),
  ];
  const closes = [day(21), day(21) + HALF_DAY_MS, day(22)];

  it('carry out the exit signal now, record the adds and the entries that were due, and move the reference as C6 says', () => {
    const walk = walkMissedCloses(
      closes,
      [{ id: 'A', instId: AAA.instId, addRef: '100', exiting: false }],
      [
        { instId: AAA.instId, halfDay, daily },
        { instId: BBB.instId, halfDay, daily },
      ],
      P,
    );
    expect(walk.exits).toEqual([{ campaignId: 'A', instId: AAA.instId, closeTs: day(22), signalTs: day(21) }]);
    expect(walk.missed).toEqual([
      // day 20's close: AAA adds (106 >= 105) and moves its reference to the open after it; BBB has no campaign: an entry
      { closeTs: day(21), kind: 'add', instId: AAA.instId, campaignId: 'A', plan: { close: '106', ref: '100', price: '106.5' } },
      { closeTs: day(21), kind: 'enter', instId: BBB.instId, campaignId: null, plan: { close: '106', entryHigh: '101', signalTs: day(20) } },
      // the noon after: 112 is 5% above 106.5
      { closeTs: day(21) + HALF_DAY_MS, kind: 'add', instId: AAA.instId, campaignId: 'A', plan: { close: '112', ref: '106.5', price: '112' } },
    ]);
    expect(walk.addRefs.get('A')).toBe('112');
    // what each close showed, for the decision log
    expect(walk.inputs).toHaveLength(6);
    expect(walk.inputs.find((i) => i.instId === BBB.instId && i.closeTs === day(22))?.daily).toMatchObject({ exit: true, exitLow: '99' });
  });

  it('look no further at a campaign whose exit is due already', () => {
    const walk = walkMissedCloses(closes, [{ id: 'A', instId: AAA.instId, addRef: '100', exiting: true }], [{ instId: AAA.instId, halfDay, daily }], P);
    expect(walk.exits).toEqual([]);
    expect(walk.missed).toEqual([]);
    expect(walk.addRefs.get('A')).toBe('100');
  });

  it('give no signal where the bars are missing (C8)', () => {
    const walk = walkMissedCloses(closes, [{ id: 'A', instId: AAA.instId, addRef: '100', exiting: false }], [{ instId: AAA.instId, halfDay: [], daily: [] }], P);
    expect(walk).toMatchObject({ exits: [], missed: [] });
    expect(walk.inputs.every((i) => i.halfDay === null && i.note !== undefined)).toBe(true);
  });
});
