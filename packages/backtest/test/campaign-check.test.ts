import { readFileSync } from 'node:fs';
import { DEFAULT_CAMPAIGN_PARAMS } from '@pegasus/shared';
import { describe, expect, it } from 'vitest';
import {
  checkCampaigns,
  compareWithReference,
  MULTIPLE_TOLERANCE,
  parseReference,
  referenceConfig,
  referenceWarmup,
  type CampaignReference,
  type ReferenceRow,
  type ReferenceTotals,
} from '../src/campaign/check.js';
import { runCampaigns } from '../src/campaign/engine.js';
import { DEFAULT_CAMPAIGN_COSTS, REFERENCE_CAMPAIGN_COSTS } from '../src/campaign/options.js';
import { multipleStats } from '../src/campaign/report.js';
import type { CampaignInstrument, CampaignResult } from '../src/campaign/types.js';
import { data, day, EXIT_DAY, QUIET, SETUP, type Row } from './campaign-helpers.js';
import { DAY, HALF_DAY, instrument, T0 } from './helpers.js';

const iso = (ts: number): string => new Date(ts).toISOString().slice(0, 10);

/** AAA: a campaign that adds once (day 5) and leaves at the exit (open of day 8). */
const AAA_ROWS: Row[] = [
  ...SETUP,
  QUIET,
  [100, 105.5, 99.8, 105],
  [106, 107, 105.5, 106.5],
  [106.5, 107, 106, 106.8],
  [106.8, 107, 105.8, 106],
  [106, 106.5, 105.6, 106.2],
  [106.2, 106.5, 104.8, 105],
  [105, 105.2, 104.5, 104.9],
  [104.9, 105, 104, 104.5],
];
/** BBB: a campaign liquidated in its entry bar on a day that closes at a new high, then one open at the end. */
const BBB_ROWS: Row[] = [...SETUP, [100, 100.5, 90, 95], [95, 110, 94, 109], [109, 110, 108, 109.5], [109.5, 110, 109, 109.8]];
const instruments = (): CampaignInstrument[] => [data(AAA_ROWS), data(BBB_ROWS, { inst: instrument('BBB-USDT-SWAP') })];

/** A reference in the research engine's terms: channels of 3 and 2 days, the costs of the rule, no warm-up. */
function reference(over: Partial<CampaignReference> = {}): CampaignReference {
  const base: CampaignReference = {
    note: 'synthetic',
    instruments: { AAA: 'AAA-USDT-SWAP', BBB: 'BBB-USDT-SWAP' },
    sampleEnd: day(9),
    params: { L: 10, add: 1, step: 0.05, ex: 'EX2' },
    entry: 'BO3',
    fee: '0.0005',
    majors: ['BTC', 'ETH'],
    slippage: { major: '0.0005', other: '0.001' },
    exitSlippage: { major: '0.0015', other: '0.0025' },
    maintenance: { major: '0.005', other: '0.01' },
    warmup: {},
    campaigns: [],
    noadd: { n: 0, lost: 0, lose: 0, median: 0, mean: 0, meanEx1: 0, meanEx2: 0, p2: 0, p5: 0, p20: 0, p100: 0, max: 0 },
  };
  const pyramid = runCampaigns(instruments(), referenceConfig(base, 'pyramid'));
  const stats = multipleStats(runCampaigns(instruments(), referenceConfig(base, 'noadd')).campaigns);
  const noadd: ReferenceTotals = {
    n: stats.count,
    lost: stats.lost,
    lose: stats.belowStake,
    median: stats.median,
    mean: stats.mean,
    meanEx1: stats.meanWithoutTop1 ?? 0,
    meanEx2: stats.meanWithoutTop2 ?? 0,
    p2: stats.atLeast2,
    p5: stats.atLeast5,
    p20: stats.atLeast20,
    p100: stats.atLeast100,
    max: stats.max,
  };
  const campaigns = pyramid.campaigns
    .map((c) => ({
      asset: c.instId.split('-')[0] as string,
      entry: iso(c.entryTime),
      end: iso(c.endTime),
      mult: Number(Number(c.multiple).toFixed(4)),
      liquidated: c.end === 'liquidated',
      adds: c.adds,
      peak: Number(Number(c.peak).toFixed(3)),
      multExact: Number(c.multiple),
      peakExact: Number(c.peak),
    }))
    .sort((a, b) => (a.asset + a.entry < b.asset + b.entry ? -1 : 1));
  return { ...base, campaigns, noadd, ...over };
}

const replay = (ref: CampaignReference, structure: 'pyramid' | 'noadd', insts = instruments()): CampaignResult => runCampaigns(insts, referenceConfig(ref, structure));
const lastLine = (lines: readonly string[]): string => lines[lines.length - 1] as string;

describe('the replay of a reference run', () => {
  it('is the catalogue with the rule, the costs and the end of the reference', () => {
    const cfg = referenceConfig(reference(), 'noadd');
    expect(cfg).toMatchObject({ mode: 'catalogue', from: null, to: day(9), funding: true, exchangeCap: false });
    expect(cfg.params).toEqual({ entryChannel: 3, exitChannel: 2, leverage: '10', structure: 'noadd', addStep: '0.05', feeRate: '0.0005' });
    expect(cfg.costs).toEqual(REFERENCE_CAMPAIGN_COSTS);
    // Under the exchange's limits: the same run with the pot's cap on adds and its maintenance rates.
    const limited = referenceConfig(reference(), 'noadd', true);
    expect(limited).toMatchObject({ mode: 'catalogue', to: day(9), exchangeCap: true });
    expect(limited.params).toEqual(cfg.params);
    expect(limited.costs).toEqual(DEFAULT_CAMPAIGN_COSTS);
    expect(() => referenceConfig(reference({ majors: ['BTC'] }), 'pyramid')).toThrow(/majors/);
  });

  it('hands the warm-up bars of an instrument to the replay as confirmed daily bars', () => {
    const ref = reference({ warmup: { 'AAA-USDT-SWAP': [[T0 - DAY, '100', '101', '99', '100.5']] } });
    expect(referenceWarmup(ref, 'AAA-USDT-SWAP')).toEqual([{ ts: T0 - DAY, open: '100', high: '101', low: '99', close: '100.5', vol: '0', volCcy: '0', confirm: true }]);
    expect(referenceWarmup(ref, 'BBB-USDT-SWAP')).toEqual([]);
  });
});

describe('the comparison with the campaigns of the reference', () => {
  const ref = reference();

  it('has three campaigns to compare: an exit after an add, a liquidation, one open at the end', () => {
    expect(ref.campaigns.map((c) => [c.asset, c.entry, c.end, c.liquidated, c.adds])).toEqual([
      ['AAA', iso(day(4)), iso(day(8)), false, 1],
      ['BBB', iso(day(4)), iso(day(4)), true, 0],
      ['BBB', iso(day(5)), iso(day(5) + HALF_DAY), false, 0],
    ]);
  });

  it('passes when every campaign matches', () => {
    const outcome = checkCampaigns(replay(ref, 'pyramid'), ref, 'pyramid');
    expect(outcome.ok).toBe(true);
    expect(outcome.lines[1]).toContain('3 of 3 match');
    expect(lastLine(outcome.lines)).toBe('check: PASS');
  });

  it('fails on a multiple outside the tolerance, and not inside it', () => {
    const shift = (factor: number): CampaignReference => ({ ...ref, campaigns: ref.campaigns.map((c, i) => (i === 0 ? { ...c, multExact: c.multExact * factor } : c)) });
    const off = checkCampaigns(replay(ref, 'pyramid'), shift(1 + 3 * MULTIPLE_TOLERANCE), 'pyramid');
    expect(off.ok).toBe(false);
    expect(off.lines.some((l) => l.includes('DIFFERS AAA') && l.includes('multiple'))).toBe(true);
    expect(lastLine(off.lines)).toBe('check: FAIL (1 difference)');
    expect(checkCampaigns(replay(ref, 'pyramid'), shift(1 + MULTIPLE_TOLERANCE / 3), 'pyramid').ok).toBe(true);
  });

  it('fails on a multiple that does not round to the published one', () => {
    const published = { ...ref, campaigns: ref.campaigns.map((c, i) => (i === 0 ? { ...c, mult: c.mult + 0.0002 } : c)) };
    expect(checkCampaigns(replay(ref, 'pyramid'), published, 'pyramid').ok).toBe(false);
  });

  it('says which field of a campaign differs', () => {
    const changed = (patch: Partial<ReferenceRow>): string[] =>
      checkCampaigns(replay(ref, 'pyramid'), { ...ref, campaigns: ref.campaigns.map((c, i) => (i === 0 ? { ...c, ...patch } : c)) }, 'pyramid').lines.filter((l) => l.includes('DIFFERS'));
    expect(changed({ adds: 2 })[0]).toContain('1 adds, reference 2');
    expect(changed({ end: '2022-01-20' })[0]).toContain(`ends ${iso(day(8))}, reference 2022-01-20`);
    expect(changed({ liquidated: true })[0]).toContain('exit, reference liquidated');
    expect(changed({ peakExact: 9, peak: 9 })[0]).toContain('peak');
  });

  it('fails on a campaign only one side has', () => {
    const missing = checkCampaigns(replay(ref, 'pyramid'), { ...ref, campaigns: ref.campaigns.slice(1) }, 'pyramid');
    expect(missing.ok).toBe(false);
    expect(missing.lines.some((l) => l.includes(`AAA ${iso(day(4))}`) && l.includes('not in the reference'))).toBe(true);
    const invented: ReferenceRow = { ...(ref.campaigns[0] as ReferenceRow), entry: '2022-02-01' };
    const extra = checkCampaigns(replay(ref, 'pyramid'), { ...ref, campaigns: [...ref.campaigns, invented] }, 'pyramid');
    expect(extra.ok).toBe(false);
    expect(extra.lines.some((l) => l.includes('AAA 2022-02-01') && l.includes('not in the replay'))).toBe(true);
  });

  it('compares the campaigns of the instruments replayed and says how many that is', () => {
    const outcome = checkCampaigns(replay(ref, 'pyramid', instruments().slice(0, 1)), ref, 'pyramid');
    expect(outcome.ok).toBe(true);
    expect(outcome.lines[0]).toContain('1 of the 3 reference campaigns');
    // Nothing to compare is not a pass.
    expect(checkCampaigns(replay(ref, 'pyramid', []), ref, 'pyramid').ok).toBe(false);
  });
});

describe('the comparison with the totals of the reference without adds', () => {
  const ref = reference();

  it('passes on the same totals and fails on a different one', () => {
    const result = replay(ref, 'noadd');
    const outcome = checkCampaigns(result, ref, 'noadd');
    expect(outcome.ok).toBe(true);
    expect(outcome.lines.filter((l) => l.includes('same')).length).toBe(12);
    const off = checkCampaigns(result, { ...ref, noadd: { ...ref.noadd, mean: ref.noadd.mean * 1.001 } }, 'noadd');
    expect(off.ok).toBe(false);
    expect(off.lines.some((l) => l.includes('DIFFERS mean:'))).toBe(true);
    expect(checkCampaigns(result, { ...ref, noadd: { ...ref.noadd, n: ref.noadd.n + 1 } }, 'noadd').ok).toBe(false);
  });

  it('needs every instrument of the reference', () => {
    const outcome = checkCampaigns(replay(ref, 'noadd', instruments().slice(0, 1)), ref, 'noadd');
    expect(outcome.ok).toBe(false);
    expect(outcome.lines[0]).toContain('all its instruments');
  });
});

describe('the reference next to its replay under the limits of the exchange', () => {
  const ref = reference();

  it('shows the totals of both, without a pass or a fail', () => {
    const limited = runCampaigns(instruments(), referenceConfig(ref, 'pyramid', true));
    const outcome = compareWithReference(limited, ref, 'pyramid');
    expect(outcome.ok).toBe(true);
    expect(outcome.lines[0]).toContain("under the exchange's limits");
    // Three campaigns in the reference; AAA is one of the 'other' coins: 1.05% instead of 1% of maintenance changes none of them here.
    expect(outcome.lines.find((l) => l.includes('campaigns'))).toMatch(/campaigns\s+3\s+3$/);
    expect(outcome.lines.find((l) => l.includes('lost entirely'))).toMatch(/33\.3%\s+33\.3%$/);
    expect(outcome.lines.some((l) => l.startsWith('compare: largest with the limits: AAA-USDT-SWAP'))).toBe(true);
    expect(outcome.lines.every((l) => l.startsWith('compare: '))).toBe(true);
  });

  it('compares the totals without adds only over every instrument of the reference', () => {
    expect(compareWithReference(runCampaigns(instruments(), referenceConfig(ref, 'noadd', true)), ref, 'noadd').ok).toBe(true);
    const part = compareWithReference(runCampaigns(instruments().slice(0, 1), referenceConfig(ref, 'noadd', true)), ref, 'noadd');
    expect(part.ok).toBe(false);
    // The pyramid is compared on the instruments replayed, and says so.
    const one = compareWithReference(runCampaigns(instruments().slice(0, 1), referenceConfig(ref, 'pyramid', true)), ref, 'pyramid');
    expect(one.lines[0]).toContain('on 1 of its 2 instruments');
    expect(one.lines.find((l) => l.includes('campaigns'))).toMatch(/campaigns\s+1\s+1$/);
  });
});

describe('the reference file', () => {
  const file = new URL('../reference/campaigns-okx.json', import.meta.url);
  const ref = parseReference(JSON.parse(readFileSync(file, 'utf8')));

  it('lists the 497 campaigns of the research run on ten instruments', () => {
    expect(ref.campaigns).toHaveLength(497);
    expect(Object.keys(ref.instruments)).toEqual(['BTC', 'ETH', 'LTC', 'XRP', 'BCH', 'ETC', 'LINK', 'ADA', 'DOT', 'TRX']);
    expect(ref.params).toEqual({ L: 10, add: 1, step: 0.05, ex: 'EX10' });
    expect(ref.sampleEnd).toBe(Date.UTC(2026, 9, 4, 12));
    expect(ref.campaigns.filter((c) => c.liquidated)).toHaveLength(439);
    // The published values are the exact ones, rounded.
    for (const c of ref.campaigns) {
      expect(Number(c.multExact.toFixed(4))).toBe(c.mult);
      expect(Number(c.peakExact.toFixed(3))).toBe(c.peak);
      expect(ref.instruments[c.asset]).toBeDefined();
    }
    expect(ref.campaigns.reduce((a, c) => a + c.multExact, 0) / 497).toBeCloseTo(1.7611897776593208, 9);
    expect(ref.noadd).toMatchObject({ n: 399, mean: 1.533696906224175 });
  });

  it('carries at most 20 warm-up days per instrument, all before the exchange history', () => {
    for (const instId of Object.values(ref.instruments)) {
      const bars = referenceWarmup(ref, instId);
      expect(bars.length).toBeGreaterThan(0);
      expect(bars.length).toBeLessThanOrEqual(20);
      expect(bars.every((b, i) => i === 0 || b.ts === (bars[i - 1]?.ts ?? 0) + DAY)).toBe(true);
    }
    expect(referenceWarmup(ref, 'BTC-USDT-SWAP').at(-1)?.ts).toBe(Date.UTC(2019, 11, 31));
  });

  it('was run with the rule that is the default of the product, and the fills and liquidation the catalogue defaults to', () => {
    const cfg = referenceConfig(ref, 'pyramid');
    expect(cfg.params).toEqual(DEFAULT_CAMPAIGN_PARAMS);
    expect(cfg.costs).toEqual(REFERENCE_CAMPAIGN_COSTS);
    expect(cfg.exchangeCap).toBe(false);
  });

  it('is refused when it is not what the check needs', () => {
    const raw = JSON.parse(readFileSync(file, 'utf8')) as Record<string, unknown>;
    expect(() => parseReference([])).toThrow(/not a campaign reference/);
    expect(() => parseReference({ ...raw, params: { L: 10 } })).toThrow(/params/);
    expect(() => parseReference({ ...raw, params: { L: 10, add: 0, step: 0.05, ex: 'EX10' } })).toThrow(/pyramid/);
    expect(() => parseReference({ ...raw, entry: 'breakout' })).toThrow(/entry/);
    expect(() => parseReference({ ...raw, campaigns: [{ asset: 'BTC' }] })).toThrow(/campaigns/);
    expect(() => parseReference({ ...raw, warmup: { 'BTC-USDT-SWAP': [[1, 2, 3, 4, 5]] } })).toThrow(/warmup/);
    expect(() => parseReference({ ...raw, noadd: { n: 399 } })).toThrow(/noadd/);
    expect(() => parseReference({ ...raw, slippage: '0.001' })).toThrow(/slippage/);
  });
});
