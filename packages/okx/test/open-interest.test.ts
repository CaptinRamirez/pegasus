import { describe, expect, it } from 'vitest';
import { normalizeOpenInterestHistory, type OkxOpenInterestHistoryRow, type OpenInterestSnapshot } from '../src/index.js';

const HOUR = 3_600_000;
const DAY = 24 * HOUR;

/** 'YYYY-MM-DD' or 'YYYY-MM-DDTHH' (UTC) as epoch ms. */
const at = (s: string): number => Date.parse(s.length === 10 ? `${s}T00:00:00Z` : `${s}:00:00Z`);

/** Rows newest first like OKX, from [label, oiCcy] pairs: [ts, contracts, coin, USD]. */
function rows(points: Array<[string, string]>): OkxOpenInterestHistoryRow[] {
  return points
    .map(([label, ccy]): OkxOpenInterestHistoryRow => [String(at(label)), String(Math.round(Number(ccy) * 100)), ccy, String(Math.round(Number(ccy) * 60_000))])
    .sort((a, b) => Number(b[0]) - Number(a[0]));
}

const levelAt = (snaps: OpenInterestSnapshot[], label: string): string | undefined => snaps.find((s) => s.ts === at(label))?.oiCcy;

// Real BTC-USDT-SWAP oiCcy values (docs/okx-api-notes.md §5.9).
const START_HALF: Array<[string, string]> = [
  ['2025-10-08T00', '28323.1'], ['2025-10-08T12', '28816.1'], ['2025-10-09T00', '28266.2'], ['2025-10-09T12', '29086.8'], ['2025-10-10T00', '28199.1'],
  ['2025-10-10T12', '28239.5'], ['2025-10-11T00', '22513.2'], ['2025-10-11T12', '21525.2'], ['2025-10-12T00', '21866.3'], ['2025-10-12T12', '21857.5'],
];
const START_DAILY: Array<[string, string]> = [['2025-10-08', '28323.1'], ['2025-10-09', '28266.2'], ['2025-10-10', '28199.1'], ['2025-10-11', '22513.2'], ['2025-10-12', '21866.3']];
const END_HALF: Array<[string, string]> = [
  ['2026-09-20T00', '30679.7'], ['2026-09-20T12', '30247.3'], ['2026-09-21T00', '29605.2'], ['2026-09-21T12', '29475.9'], ['2026-09-22T00', '30643.4'],
  ['2026-09-22T12', '30435.1'], ['2026-09-23T00', '31021.7'], ['2026-09-23T12', '29314.2'], ['2026-09-24T00', '29671.6'], ['2026-09-24T12', '28435.5'],
];
const END_DAILY: Array<[string, string]> = [['2026-09-20', '30247.3'], ['2026-09-21', '29475.9'], ['2026-09-22', '30435.1'], ['2026-09-23', '29314.2'], ['2026-09-24', '28435.5']];

const LATER = at('2026-10-04T12');

describe('normalizeOpenInterestHistory', () => {
  it('reads START-type rows as snapshots at their label: the 2025-10-10 cascade is a -20.2% day', () => {
    const snaps = normalizeOpenInterestHistory(rows(START_DAILY), rows(START_HALF), { now: LATER });
    expect(snaps.map((s) => s.ts)).toEqual(START_HALF.map(([label]) => at(label)));
    expect(snaps[0]).toEqual({ ts: at('2025-10-08'), oi: '2832310', oiCcy: '28323.1', oiUsd: '1699386000' });
    const open = Number(levelAt(snaps, '2025-10-10'));
    const close = Number(levelAt(snaps, '2025-10-11'));
    expect(open).toBe(28199.1);
    expect(close).toBe(22513.2);
    expect(close / open - 1).toBeCloseTo(-0.202, 3);
    // the cascade came at about 21:15 UTC: open interest was still intact at noon
    expect(levelAt(snaps, '2025-10-10T12')).toBe('28239.5');
  });

  it('reads END-type rows as the level at the end of their period', () => {
    const snaps = normalizeOpenInterestHistory(rows(END_DAILY), rows(END_HALF), { now: LATER });
    // every row moves to the end of its period: the first instant is noon of the first day
    expect(snaps.map((s) => s.ts)).toEqual(END_HALF.map(([label]) => at(label) + 12 * HOUR));
    expect(levelAt(snaps, '2026-09-23')).toBe('30435.1');
    expect(levelAt(snaps, '2026-09-24')).toBe('29314.2');
    expect(Number(levelAt(snaps, '2026-09-24')) / Number(levelAt(snaps, '2026-09-23')) - 1).toBeCloseTo(29314.2 / 30435.1 - 1, 12);
  });

  it('leaves one instant missing where START gives way to END and pairs nothing wrongly', () => {
    // days 1 and 2 are snapshots at the label, days 3 and 4 hold the level at the end of the period
    const half: Array<[string, string]> = [
      ['2026-08-12T00', '100'], ['2026-08-12T12', '110'], ['2026-08-13T00', '120'], ['2026-08-13T12', '130'],
      ['2026-08-14T00', '150'], ['2026-08-14T12', '160'], ['2026-08-15T00', '170'], ['2026-08-15T12', '180'],
    ];
    const daily: Array<[string, string]> = [['2026-08-12', '100'], ['2026-08-13', '120'], ['2026-08-14', '160'], ['2026-08-15', '180']];
    const snaps = normalizeOpenInterestHistory(rows(daily), rows(half), { now: LATER });
    expect(snaps.map((s) => [new Date(s.ts).toISOString().slice(0, 13), s.oiCcy])).toEqual([
      ['2026-08-12T00', '100'], ['2026-08-12T12', '110'], ['2026-08-13T00', '120'], ['2026-08-13T12', '130'],
      // nothing says what the level was at 2026-08-14 00:00
      ['2026-08-14T12', '150'], ['2026-08-15T00', '160'], ['2026-08-15T12', '170'], ['2026-08-16T00', '180'],
    ]);
  });

  it('drops an instant two rows disagree on and keeps one row when they agree', () => {
    // END then START: the second half of day 1 and the first half of day 2 both claim 2026-08-13 00:00
    const half: Array<[string, string]> = [['2026-08-12T00', '100'], ['2026-08-12T12', '110'], ['2026-08-13T00', '140'], ['2026-08-13T12', '150']];
    const daily: Array<[string, string]> = [['2026-08-12', '110'], ['2026-08-13', '140']];
    expect(normalizeOpenInterestHistory(rows(daily), rows(half), { now: LATER }).map((s) => s.oiCcy)).toEqual(['100', '150']);
    const agreeing: Array<[string, string]> = [['2026-08-12T00', '100'], ['2026-08-12T12', '140.001'], ['2026-08-13T00', '140'], ['2026-08-13T12', '150']];
    const agreed = normalizeOpenInterestHistory(rows([['2026-08-12', '140.001'], ['2026-08-13', '140']]), rows(agreeing), { now: LATER });
    expect(agreed.map((s) => s.oiCcy)).toEqual(['100', '140.001', '150']);
  });

  it('lets a flat day take the type of the nearest day that can tell, the earlier one on a tie', () => {
    const half: Array<[string, string]> = [
      ['2026-09-20T00', '30679.7'], ['2026-09-20T12', '30247.3'],
      // 2026-09-21: open interest did not move, the daily row matches both halves
      ['2026-09-21T00', '30247.3'], ['2026-09-21T12', '30247.5'],
      ['2026-09-22T00', '30643.4'], ['2026-09-22T12', '30435.1'],
    ];
    const daily: Array<[string, string]> = [['2026-09-20', '30247.3'], ['2026-09-21', '30247.5'], ['2026-09-22', '30435.1']];
    const snaps = normalizeOpenInterestHistory(rows(daily), rows(half), { now: LATER });
    expect(levelAt(snaps, '2026-09-21T12')).toBe('30247.3');
    expect(levelAt(snaps, '2026-09-22')).toBe('30247.5');
    expect(snaps).toHaveLength(6);
    // between a START day and an END day at the same distance the earlier one decides
    const tie: Array<[string, string]> = [
      ['2026-08-12T00', '100'], ['2026-08-12T12', '110'], ['2026-08-13T00', '120'], ['2026-08-13T12', '120'], ['2026-08-14T00', '150'], ['2026-08-14T12', '160'],
    ];
    const tied = normalizeOpenInterestHistory(rows([['2026-08-12', '100'], ['2026-08-13', '120'], ['2026-08-14', '160']]), rows(tie), { now: LATER });
    expect(levelAt(tied, '2026-08-13')).toBe('120');
    expect(levelAt(tied, '2026-08-13T12')).toBe('120');
  });

  it('never emits a forming END row', () => {
    const daily = rows([...END_DAILY, ['2026-09-25', '28000']]);
    const morning = rows([...END_HALF, ['2026-09-25T00', '28100']]);
    // 09:00 on the forming day: its first half-day row is still moving
    const early = normalizeOpenInterestHistory(daily, morning, { now: at('2026-09-25T09') });
    expect(early[early.length - 1]).toMatchObject({ ts: at('2026-09-25'), oiCcy: '28435.5' });
    // 15:00: the first half is complete, the second half and the day are not
    const afternoon = rows([...END_HALF, ['2026-09-25T00', '28200'], ['2026-09-25T12', '27900']]);
    const late = normalizeOpenInterestHistory(daily, afternoon, { now: at('2026-09-25T15') });
    expect(late[late.length - 1]).toMatchObject({ ts: at('2026-09-25T12'), oiCcy: '28200' });
    expect(late.some((s) => s.oiCcy === '27900' || s.oiCcy === '28000')).toBe(false);
  });

  it('emits the forming START rows whose label has been reached', () => {
    const daily = rows([...START_DAILY, ['2025-10-13', '21900']]);
    const half = rows([...START_HALF, ['2025-10-13T00', '21900'], ['2025-10-13T12', '22000']]);
    const snaps = normalizeOpenInterestHistory(daily, half, { now: at('2025-10-13T09') });
    expect(snaps[snaps.length - 1]).toMatchObject({ ts: at('2025-10-13'), oiCcy: '21900' });
  });

  it('skips days older than the half-day rows unless asked to extend', () => {
    const daily = rows([['2025-10-06', '27000'], ['2025-10-07', '27500'], ...START_DAILY]);
    const plain = normalizeOpenInterestHistory(daily, rows(START_HALF), { now: LATER });
    expect(plain[0]?.ts).toBe(at('2025-10-08'));
    const extended = normalizeOpenInterestHistory(daily, rows(START_HALF), { now: LATER, extendBeforeHalfDayCoverage: true });
    expect(extended.slice(0, 3).map((s) => [s.ts, s.oiCcy])).toEqual([[at('2025-10-06'), '27000'], [at('2025-10-07'), '27500'], [at('2025-10-08'), '28323.1']]);
    // END type: an older daily row is the level at the end of its day
    const older = rows([['2026-09-18', '31000'], ['2026-09-19', '30679.7'], ...END_DAILY]);
    const end = normalizeOpenInterestHistory(older, rows(END_HALF), { now: LATER, extendBeforeHalfDayCoverage: true });
    expect(end.slice(0, 3).map((s) => [s.ts, s.oiCcy])).toEqual([[at('2026-09-19'), '31000'], [at('2026-09-20'), '30679.7'], [at('2026-09-20T12'), '30679.7']]);
  });

  it('gives nothing for input that fits neither convention', () => {
    const daily: Array<[string, string]> = [['2026-09-20', '25000'], ['2026-09-21', '26000'], ['2026-09-22', '27000']];
    expect(normalizeOpenInterestHistory(rows(daily), rows(END_HALF), { now: LATER })).toEqual([]);
    expect(normalizeOpenInterestHistory(rows(END_DAILY), [], { now: LATER })).toEqual([]);
    expect(normalizeOpenInterestHistory([], rows(END_HALF), { now: LATER })).toEqual([]);
    // rows that are not numbers are ignored, not guessed at
    const junk: OkxOpenInterestHistoryRow[] = [['x', '1', 'abc', '1'], [String(at('2026-09-20') + 5), '1', '1', '1']];
    expect(normalizeOpenInterestHistory(junk, junk, { now: LATER })).toEqual([]);
  });
});
