import { describe, expect, it } from 'vitest';
import type { CampaignStepAction } from '@pegasus/shared';
import { defaultTab } from '../components/BottomTabs';
import { en } from '../i18n/en';
import { zh } from '../i18n/zh';
import { LAST_CLOSE, campaigns, replayFailed, replayFailedEarlier, replayReady, runningView } from '../test/campaign-fixtures';
import {
  ACCEPTANCE_TARGET,
  acceptanceCounts,
  campaignChartLines,
  campaignState,
  fmtLogRecord,
  fmtMultiple,
  groupActions,
  potMultiple,
  replayResult,
  replayState,
  splitDuration,
  valueAt,
} from './campaign';
import { ApiError } from './http';

describe('the paper-stage acceptance', () => {
  it('counts the campaigns the program ran to their end: exit, liquidated and harvest; not external, unknown or open', () => {
    expect(ACCEPTANCE_TARGET).toBe(20);
    expect(acceptanceCounts(campaigns)).toEqual({ ranToEnd: 3, external: 1, unknown: 0, open: 1 });
    const unknown = { end: { kind: 'unknown' as const, ts: 1, proceeds: '', fill: null } };
    expect(acceptanceCounts([...campaigns, unknown])).toEqual({ ranToEnd: 3, external: 1, unknown: 1, open: 1 });
    expect(acceptanceCounts([])).toEqual({ ranToEnd: 0, external: 0, unknown: 0, open: 0 });
    expect(campaigns.map(campaignState)).toEqual(['open', 'external', 'harvest', 'liquidated', 'exit']);
  });
});

describe('the pot', () => {
  it('(value + banked) / start value, in decimals', () => {
    const pot = runningView.pot;
    if (pot === null) throw new Error('fixture without a pot');
    // (175.75 + 300) / 56
    expect(potMultiple(pot)).toBe('8.495535714285714285714285714285714285714');
    expect(fmtMultiple(potMultiple(pot))).toBe('×8.50');
    // decimal, not binary floating point: 0.1 + 0.2 over 0.3 is exactly 1
    expect(potMultiple({ value: '0.1', banked: '0.2', startValue: '0.3', start: '56' })).toBe('1');
    // the configured start when the start value was not recorded
    expect(potMultiple({ value: '112', banked: '0', startValue: '', start: '56' })).toBe('2');
    // unknown while the account does not show the value
    expect(potMultiple({ ...pot, value: null })).toBeNull();
  });

  it('formats multiples, the dash for none and for one that was not measured', () => {
    expect(fmtMultiple('1.517857142857142857142857143')).toBe('×1.52');
    expect(fmtMultiple('164.2')).toBe('×164.20');
    expect(fmtMultiple('0')).toBe('×0.00');
    expect(fmtMultiple(null)).toBe('–');
    expect(fmtMultiple('')).toBe('–');
  });
});

describe('the countdown', () => {
  it('splits a duration into whole hours, minutes and seconds', () => {
    expect(splitDuration(2 * 3_600_000 + 30 * 60_000 + 59_999)).toEqual({ h: 2, m: 30, s: 59 });
    expect(splitDuration(-5_000)).toEqual({ h: 0, m: 0, s: 0 });
  });

  it('reads in both languages, with seconds in the last hour', () => {
    expect(en.campaign.countdown(2 * 3_600_000 + 5 * 60_000)).toBe('in 2 h 05 min');
    expect(en.campaign.countdown(12 * 60_000 + 7_000)).toBe('in 12 min 07 s');
    expect(en.campaign.countdown(0)).toBe('due now');
    expect(zh.campaign.countdown(2 * 3_600_000 + 5 * 60_000)).toBe('2 小时 05 分后');
    expect(zh.campaign.countdown(12 * 60_000 + 7_000)).toBe('12 分 07 秒后');
    expect(zh.campaign.countdown(-1)).toBe('已到时间');
  });
});

describe('the chart', () => {
  it('draws the pot value and the banked total; the replay adds held BTC and both structures, the pot\'s own first', () => {
    const own = campaignChartLines(runningView, null);
    expect(own.map((l) => l.id)).toEqual(['value', 'banked']);
    expect(own[0]?.points.at(-1)).toEqual({ ts: LAST_CLOSE, value: '175.75' });
    expect(own[1]?.points.at(-1)).toEqual({ ts: LAST_CLOSE, value: '300' });

    const all = campaignChartLines(runningView, replayReady);
    expect(all.map((l) => [l.id, l.structure])).toEqual([
      ['value', null],
      ['banked', null],
      ['heldBtc', null],
      ['replaySame', 'pyramid'],
      ['replayOther', 'noadd'],
    ]);
    expect(all[3]?.points.at(-1)).toEqual({ ts: LAST_CLOSE, value: '176' });
    // a failed first attempt has nothing to draw
    expect(campaignChartLines(runningView, replayFailed).map((l) => l.id)).toEqual(['value', 'banked']);
  });

  it('the legend reads the value at the close under the crosshair, or the latest', () => {
    const points = [
      { ts: 100, value: '1' },
      { ts: 300, value: '3' },
      { ts: 200, value: '2' },
    ];
    expect(valueAt(points, null)).toBe('3');
    expect(valueAt(points, 200)).toBe('2');
    expect(valueAt(points, 250)).toBe('2');
    expect(valueAt(points, 50)).toBeNull();
    expect(valueAt([], null)).toBeNull();
  });
});

describe('the replay', () => {
  const notFound = new ApiError('NOT_FOUND', 'route not found', undefined, 404);

  it('is off without a pot, missing on a 404, an error otherwise, and loaded with the API\'s answer', () => {
    expect(replayState(false, replayReady, null)).toEqual({ kind: 'off' });
    expect(replayState(true, undefined, null)).toEqual({ kind: 'loading' });
    expect(replayState(true, undefined, notFound)).toEqual({ kind: 'missing' });
    const boom = new ApiError('INTERNAL', 'HTTP 500', undefined, 500);
    expect(replayState(true, undefined, boom)).toEqual({ kind: 'error', error: boom });
    expect(replayState(true, replayReady, null)).toEqual({ kind: 'loaded', replay: replayReady });
    // a failed attempt is an answer of the API: its earlier result is still drawn
    expect(replayResult(replayState(true, replayFailedEarlier, null))).toBe(replayFailedEarlier);
    expect(replayResult({ kind: 'missing' })).toBeNull();
  });
});

describe('the decision log', () => {
  const action = (kind: CampaignStepAction['kind'], outcome: CampaignStepAction['outcome'], error = false): CampaignStepAction => ({
    kind,
    closeTs: LAST_CLOSE,
    instId: null,
    campaignId: null,
    plan: {},
    outcome,
    reason: '',
    result: null,
    attempts: 1,
    error,
    ts: LAST_CLOSE,
  });

  it('groups the actions of a step by kind and outcome, in the order they come', () => {
    expect(groupActions([action('add', 'done'), action('enter', 'skipped'), action('add', 'done'), action('add', 'failed', true)])).toEqual([
      { kind: 'add', outcome: 'done', count: 2, error: false },
      { kind: 'enter', outcome: 'skipped', count: 1, error: false },
      { kind: 'add', outcome: 'failed', count: 1, error: true },
    ]);
  });

  it('writes a plan or a result in one line, with its times in UTC', () => {
    expect(fmtLogRecord({ contracts: 5, price: '2611.2', late: true, fill: null, signalTs: Date.UTC(2026, 9, 3) })).toBe(
      'contracts=5, price=2611.2, late=true, fill=–, signalTs=2026-10-03 00:00 UTC',
    );
    expect(fmtLogRecord(null)).toBe('–');
    expect(fmtLogRecord({})).toBe('–');
  });
});

describe('the tab a page opens on', () => {
  it('is the campaign unless it is disabled; undecided until the status is known', () => {
    expect(defaultTab(null)).toBeNull();
    expect(defaultTab('disabled')).toBe('signals');
    for (const status of ['blocked', 'running', 'finished'] as const) expect(defaultTab(status)).toBe('campaign');
  });
});
