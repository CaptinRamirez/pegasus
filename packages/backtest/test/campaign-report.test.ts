import { DEFAULT_POT_PARAMS, type Candle, type FundingRecord } from '@pegasus/shared';
import { describe, expect, it } from 'vitest';
import { runCampaigns } from '../src/campaign/engine.js';
import { bankingsCsv, buildCampaignSummary, campaignsCsv, formatCampaignSummary, multipleStats, potCsv, statsOfMultiples } from '../src/campaign/report.js';
import type { CampaignRecord } from '../src/campaign/types.js';
import { MemoryCache } from '../src/data/cache.js';
import { loadData } from '../src/data/load.js';
import { offlineFetchers, ReadOnlyCache } from '../src/data/offline.js';
import { config, data, day, NOADD, QUIET, RISE_AND_EXIT, SETUP } from './campaign-helpers.js';
import { bar, DAY, HALF_DAY, instrument, T0 } from './helpers.js';

function record(multiple: string, end: CampaignRecord['end'] = 'exit'): CampaignRecord {
  const times = { signalTs: T0, entryTime: T0 + DAY, endTime: T0 + 2 * DAY };
  return { instId: 'AAA-USDT-SWAP', ...times, entryPx: '100', end, stake: '1', contracts: '', adds: 0, sales: 0, harvested: '0', proceeds: multiple, multiple, peak: '1', fees: '0', funding: '0', open: end === 'end-of-data' };
}

describe('the distribution of the multiples', () => {
  it('matches a hand calculation', () => {
    const stats = multipleStats([record('0', 'liquidated'), record('0.5'), record('2'), record('10'), record('0', 'exit')]);
    expect(stats).toEqual({
      count: 5,
      // The liquidated one and the exit that returned nothing.
      lost: 0.4,
      belowStake: 0.6,
      median: 0.5,
      mean: 2.5,
      meanWithoutTop1: 0.625,
      meanWithoutTop2: 0.5 / 3,
      atLeast2: 0.4,
      atLeast5: 0.2,
      atLeast20: 0,
      atLeast100: 0,
      max: 10,
    });
  });

  it('copes with few campaigns', () => {
    expect(multipleStats([])).toMatchObject({ count: 0, lost: 0, mean: 0, meanWithoutTop1: null, meanWithoutTop2: null, max: 0 });
    expect(multipleStats([record('3'), record('1')])).toMatchObject({ meanWithoutTop1: 1, meanWithoutTop2: null });
  });

  it('does not count as lost a campaign that was harvested from before it was liquidated', () => {
    // 0.6 of the stake had been banked: the multiple says so, whatever the end.
    expect(multipleStats([record('0.6', 'liquidated'), record('0', 'liquidated')])).toMatchObject({ lost: 0.5, belowStake: 1 });
    expect(statsOfMultiples([0.6, 0])).toEqual(multipleStats([record('0.6', 'liquidated'), record('0', 'liquidated')]));
  });
});

describe('the summary of a pot run', () => {
  // 10 in the pot, rungs at 100 and 1000: one campaign from 100, marked at 400 (a harvest: 23 of its 49 contracts sold), out at 350.
  const cfg = config({ mode: 'pot', params: NOADD, pot: { ...DEFAULT_POT_PARAMS, start: '10', minStake: '1' } });
  const result = runCampaigns([data(RISE_AND_EXIT)], cfg);
  const summary = buildCampaignSummary(result, cfg, ['a note from the loader']);

  it('says what was run and what became of the signals and the campaigns', () => {
    expect(summary.run).toEqual({
      mode: 'pot',
      instruments: ['AAA-USDT-SWAP'],
      from: '2022-01-01',
      to: '2022-01-09',
      structure: 'noadd',
      entryChannel: 3,
      exitChannel: 2,
      leverage: '10',
      addStep: '0.05',
      feeRate: '0.0005',
      stop: null,
      atrLeverage: null,
      funding: true,
      exchangeCap: false,
      maintenance: { 'AAA-USDT-SWAP': '0.01' },
    });
    expect(summary.signals).toEqual({ entries: 1, taken: 1, skipped: {}, noNextBar: 0 });
    expect(summary.campaigns).toMatchObject({ count: 1, exited: 1, liquidated: 0, harvested: 0, open: 0, adds: 0 });
    expect(summary.campaigns.top).toHaveLength(1);
    expect(summary.campaigns.top[0]).toMatchObject({ instId: 'AAA-USDT-SWAP', entry: '2022-01-05', end: '2022-01-09' });
    expect(summary.campaigns.byInstrument['AAA-USDT-SWAP']).toMatchObject({ count: 1, lost: 0 });
    expect(summary.notes).toEqual(['a note from the loader']);
  });

  it('follows the pot: its peak, what was banked, what is left', () => {
    const pot = summary.pot;
    expect(pot).not.toBeNull();
    // 49 contracts for 4.93. Marked at 400 the pot is worth 156.93, over the rung of 100: 78.46 are to leave,
    // 5.07 of cash and 23 contracts for 71.00. The 26 left come back as 67.30 at the exit.
    expect(pot).toMatchObject({ start: '10', minStake: '1', staked: '4.93', nextRung: '1000', finished: null });
    expect(pot?.bankings).toEqual([{ time: '2022-01-06 12:00', rungs: 1, value: '156.93', target: '78.46', fromCash: '5.07', fraction: '0.4833', fromSales: '71.00', amount: '76.07' }]);
    expect(pot?.end).toEqual({ time: '2022-01-09 12:00', freeCash: '67.30', openEquity: '0.00', value: '67.30', banked: '76.07', total: '143.38', open: 0 });
    // The highest value the pot was marked at is the one the harvest was decided on.
    expect(pot?.peak).toEqual({ date: '2022-01-06', value: '156.93' });
  });

  it('prints the summary and writes the files', () => {
    const text = formatCampaignSummary(summary);
    expect(text).toContain('Campaign replay (pot)  AAA-USDT-SWAP  2022-01-01 to 2022-01-09');
    expect(text).toContain('no adds');
    expect(text).toContain('signals: 1 entries, 1 taken; skipped: none; no next bar: 0');
    expect(text).toContain('liquidation at a maintenance rate of 1.00% (AAA); adds carried by open profit, without the exchange cap');
    expect(text).toContain('banked 76.07 at 2022-01-06 12:00, rung 1: the pot was worth 156.93; 5.07 from the free cash, 71.00 from selling 48.33% of every open campaign');
    expect(text).toContain('the pot is alive; money next leaves it at 1000');
    expect(text).toContain('note: a note from the loader');
    const campaigns = campaignsCsv(result.campaigns).trimEnd().split('\n');
    expect(campaigns[0]).toBe('instId,signalBar,entryTime,entryPx,endTime,end,stake,contracts,adds,harvested,proceeds,multiple,peak,fees,funding,open');
    expect(campaigns).toHaveLength(2);
    expect(campaigns[1]?.startsWith('AAA-USDT-SWAP,2022-01-04T00:00:00.000Z,2022-01-05T00:00:00.000Z,100.1,2022-01-09T00:00:00.000Z,exit,4.9294245,49,0,71.003415,67.30371375,')).toBe(true);
    // One line per harvest: when, the rung, the pot value, the target, the cash, the fraction sold and what the sales returned.
    const bankings = bankingsCsv(result.bankings).trimEnd().split('\n');
    expect(bankings[0]).toBe('time,rungs,potValue,target,fromCash,fraction,fromSales,amount');
    expect(bankings).toHaveLength(2);
    expect(bankings[1]?.startsWith('2022-01-06T12:00:00.000Z,1,156.9264755,78.46323775,5.0705755,0.48330')).toBe(true);
    expect(bankings[1]?.endsWith(',71.003415,76.0739905')).toBe(true);
    const pot = potCsv(result.pot).trimEnd().split('\n');
    expect(pot[0]).toBe('date,freeCash,openEquity,value,banked,total,open');
    expect(pot).toHaveLength(1 + result.pot.length);
    expect(pot[1]).toBe('2022-01-01,10,0,10,0,10,0');
    // After the harvest the total still counts what left the pot.
    expect(pot.at(-1)).toBe('2022-01-09,67.30371375,0,67.30371375,76.0739905,143.37770425,0');
  });

  it('says when the pot is finished, and that the catalogue has no pot', () => {
    const lost = config({ mode: 'pot', params: NOADD, pot: { ...DEFAULT_POT_PARAMS, start: '10' } });
    const finished = buildCampaignSummary(runCampaigns([data([...SETUP, [100, 100.5, 90, 95], [95, 96, 94, 95]])], lost), lost);
    expect(finished.pot?.finished).toBe('2022-01-05 12:00');
    expect(finished.pot?.bankings).toEqual([]);
    const text = formatCampaignSummary(finished);
    expect(text).toContain('the pot was finished at 2022-01-05 12:00');
    expect(text).toContain('nothing banked: the pot was never worth 100 at a 12-hour close');
    const catalogue = buildCampaignSummary(runCampaigns([data([...SETUP, QUIET])], config()), config());
    expect(catalogue.pot).toBeNull();
    expect(formatCampaignSummary(catalogue)).not.toContain('Pot:');
    expect(formatCampaignSummary({ ...catalogue, check: { ok: true, lines: ['check: PASS'] } }).endsWith('check: PASS')).toBe(true);
  });
});

describe('an offline run', () => {
  const halfDay: Candle[] = [bar(T0, 100, 101, 99, 100), bar(T0 + HALF_DAY, 100, 101, 99, 100.5)];
  const daily: Candle[] = [bar(T0, 100, 101, 99, 100.5)];
  const funding: FundingRecord[] = [{ fundingTime: T0 + 8 * 3_600_000, fundingRate: '0.0001' }];
  const opts = { instIds: ['AAA-USDT-SWAP'], phases: [0, 12] as const, openInterest: false, funding: true, now: day(2), refresh: false };

  function cache(): MemoryCache {
    const store = new MemoryCache();
    store.write('AAA-USDT-SWAP.instrument', instrument());
    store.write('AAA-USDT-SWAP.candles-1Dutc', daily);
    store.write('AAA-USDT-SWAP.candles-12Hutc', halfDay);
    store.write('AAA-USDT-SWAP.funding', funding);
    return store;
  }

  it('returns exactly what the cache holds and writes nothing', async () => {
    const store = cache();
    const before = new Map(store.entries);
    const { data: loaded, notes } = await loadData(opts, offlineFetchers(), new ReadOnlyCache(store));
    expect(loaded[0]).toMatchObject({ inst: instrument(), daily, halfDay, funding, oi: null });
    expect(notes).toEqual([]);
    expect(store.entries).toEqual(before);
  });

  it('fails for an instrument the cache does not have, and leaves a missing series empty without creating it', async () => {
    await expect(loadData({ ...opts, instIds: ['BBB-USDT-SWAP'] }, offlineFetchers(), new ReadOnlyCache(cache()))).rejects.toThrow(/BBB-USDT-SWAP: not in the cache/);
    const store = cache();
    store.entries.delete('AAA-USDT-SWAP.candles-12Hutc');
    store.entries.delete('AAA-USDT-SWAP.funding');
    const { data: loaded, notes } = await loadData(opts, offlineFetchers(), new ReadOnlyCache(store));
    expect(loaded[0]).toMatchObject({ halfDay: [], funding: null });
    expect(notes[0]).toContain('no funding history');
    expect([...store.entries.keys()].sort()).toEqual(['AAA-USDT-SWAP.candles-1Dutc', 'AAA-USDT-SWAP.instrument']);
  });
});
