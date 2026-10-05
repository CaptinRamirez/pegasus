import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import type { CampaignView } from '@pegasus/shared';
import type { LineChartSeries } from '../hooks/useLineChart';
import { useLangStore } from '../i18n';
import { en } from '../i18n/en';
import { api } from '../lib/api';
import { ApiError } from '../lib/http';
import { useStore } from '../store/store';
import { initialState } from '../store/types';
import {
  BTC,
  ETH,
  LAST_CLOSE,
  NOT_DEDICATED,
  NOW,
  REPLAY_FAILURE,
  blockedView,
  campaigns,
  disabledView,
  logPage1,
  logPage2,
  replayFailed,
  replayFailedEarlier,
  replayReady,
  runningView,
} from '../test/campaign-fixtures';
import { CampaignPanel } from './CampaignPanel';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

vi.mock('../lib/api', async (importOriginal) => {
  const mod = await importOriginal<typeof import('../lib/api')>();
  return { ...mod, api: { campaign: vi.fn(), campaignLog: vi.fn(), campaignReplay: vi.fn() } };
});

// The canvas chart does not run in jsdom: the lines it is given are recorded instead.
const chart = vi.hoisted(() => ({ series: [] as LineChartSeries[] }));
vi.mock('../hooks/useLineChart', () => ({
  useLineChart: (_container: unknown, series: LineChartSeries[]) => {
    chart.series = series;
  },
}));

const notFound = new ApiError('NOT_FOUND', 'route not found', undefined, 404);

async function flush(container: HTMLElement, needle: string): Promise<void> {
  for (let i = 0; i < 50; i++) {
    if ((container.textContent ?? '').includes(needle)) return;
    await act(async () => {
      await new Promise((r) => setTimeout(r, 5));
    });
  }
  throw new Error(`timeout waiting for "${needle}"`);
}

const settle = (): Promise<void> =>
  act(async () => {
    await new Promise((r) => setTimeout(r, 10));
  });

const click = (el: Element | null | undefined): Promise<void> =>
  act(async () => {
    el?.dispatchEvent(new MouseEvent('click', { bubbles: true }));
  });

const texts = (container: HTMLElement, selector: string): string[] => [...container.querySelectorAll(selector)].map((el) => el.textContent ?? '');

describe('CampaignPanel', () => {
  let root: Root;
  let container: HTMLDivElement;
  const campaign = vi.mocked(api.campaign);
  const campaignLog = vi.mocked(api.campaignLog);
  const campaignReplay = vi.mocked(api.campaignReplay);

  beforeEach(() => {
    // Only the clock is pinned; the timers the queries and flush() rely on stay real.
    vi.useFakeTimers({ toFake: ['Date'], now: NOW });
    campaign.mockReset();
    campaignLog.mockReset();
    campaignReplay.mockReset();
    campaign.mockImplementation(() => Promise.resolve(useStore.getState().campaign ?? disabledView));
    campaignLog.mockImplementation((q) => Promise.resolve(q?.before === undefined ? logPage1 : logPage2));
    campaignReplay.mockResolvedValue(replayReady);
    chart.series = [];
    useStore.setState({ ...initialState('tok'), instruments: [BTC, ETH] });
    container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);
  });

  afterEach(async () => {
    await act(async () => root.unmount());
    container.remove();
    useStore.setState({ ...initialState(null) });
    useLangStore.setState({ lang: 'en' });
    vi.useRealTimers();
  });

  const render = async (view: CampaignView | null, needle?: string) => {
    useStore.setState({ campaign: view });
    const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    await act(async () => {
      root.render(
        <QueryClientProvider client={qc}>
          <CampaignPanel />
        </QueryClientProvider>,
      );
    });
    if (needle !== undefined) await flush(container, needle);
  };

  const ids = (): string[] => chart.series.map((s) => s.id);

  it('a disabled campaign: the status and its reason in words, no pot, and no replay or log is read', async () => {
    await render(disabledView);
    await settle();
    expect(container.querySelector('.campaign-status')?.textContent).toBe('disabled');
    expect(container.querySelector('.campaign-reason')?.textContent).toBe(en.campaign.reasons.CAMPAIGN_DISABLED);
    expect(container.querySelector('.campaign-reason')?.getAttribute('title')).toBe(`CAMPAIGN_DISABLED: ${disabledView.reason?.message ?? ''}`);
    // the reason says it all: no second line with the API's words
    expect(container.querySelector('.campaign-reason-detail')).toBeNull();
    expect(container.querySelector('.campaign-pot')?.textContent).toContain('The pot has not started.');
    expect(container.querySelector('.campaign-next-step')?.textContent).toBe('none: the campaign is not running');
    expect(container.querySelector('.campaign-rule')?.textContent).toContain('10 instruments · pyramid · 10× isolated longs');
    expect(container.querySelector('.campaign-chart')).toBeNull();
    expect(campaignReplay).not.toHaveBeenCalled();
    expect(campaignLog).not.toHaveBeenCalled();
  });

  it('a blocked campaign: the reason in words with the API\'s specifics under it; an unknown code shows the API\'s message', async () => {
    await render(blockedView);
    await settle();
    expect(container.querySelector('.campaign-status')?.textContent).toBe('blocked');
    expect(container.querySelector('.campaign-status')?.classList.contains('campaign-status-blocked')).toBe(true);
    expect(container.querySelector('.campaign-reason')?.textContent).toBe(en.campaign.reasons.ACCOUNT_NOT_DEDICATED);
    expect(container.querySelector('.campaign-reason-detail')?.textContent).toBe(NOT_DEDICATED);
    // the pot has not started: nothing to replay, no log
    expect(campaignReplay).not.toHaveBeenCalled();
    expect(campaignLog).not.toHaveBeenCalled();

    await act(async () => {
      useStore.setState({ campaign: { ...blockedView, reason: { code: 'SOMETHING_NEW', message: 'a reason added later' }, serverTime: NOW + 1 } });
    });
    expect(container.querySelector('.campaign-reason')?.textContent).toBe('a reason added later');
    expect(container.querySelector('.campaign-reason-detail')).toBeNull();

    // the codes the page knows are explained in Chinese; the API's specifics stay as they came
    await act(async () => {
      useStore.setState({ campaign: blockedView });
      useLangStore.setState({ lang: 'zh' });
    });
    expect(container.querySelector('.campaign-status')?.textContent).toBe('受阻');
    expect(container.querySelector('.campaign-reason')?.textContent).toContain('这个纸面账户不是资金池专用的');
    expect(container.querySelector('.campaign-reason-detail')?.textContent).toBe(NOT_DEDICATED);
  });

  it('a running pot: the steps, the acceptance with the last errors, and the pot', async () => {
    await render(runningView, 'Replay through');
    expect(container.querySelector('.campaign-status')?.textContent).toBe('running');
    expect(container.querySelector('.campaign-reason')).toBeNull();

    // the last step and the next one in UTC, with the time left until it
    const last = container.querySelector('.campaign-last-step')?.textContent ?? '';
    expect(last).toContain('#42 · 2026-10-05 00:00 UTC · close');
    expect(last).toContain('ended 2026-10-05 00:01:05 UTC');
    expect(last).toContain('0 execution errors');
    expect(container.querySelector('.campaign-next-step')?.textContent).toBe('2026-10-05 12:00 UTC · in 2 h 30 min12-hour close: adds and the ladder');
    expect(container.querySelector('.campaign-missed')?.textContent).toBe('1');
    expect(container.querySelector('.campaign-missed')?.classList.contains('warn')).toBe(true);
    expect(container.querySelector('.campaign-foreign')?.textContent).toContain('the ledger does not know: DOT-USDT-SWAP isolated net 3');

    // campaigns the program ran to their end, of the 20 stage G0 asks for; external and open ones do not count
    expect(container.querySelector('.campaign-ran')?.textContent).toBe('3 of 20');
    expect(container.querySelector('.campaign-acceptance')?.textContent).toContain('Not counted: 1 open, 1 closed by hand (external), 0 ended without explanation (unknown).');
    expect(container.querySelector('.campaign-errcount')?.textContent).toBe('2 (target 0)');
    expect(container.querySelector('.campaign-errcount b')?.classList.contains('neg')).toBe(true);
    const errors = [...container.querySelectorAll('tr.campaign-error-row')].map((r) => [...r.querySelectorAll('td')].map((td) => td.textContent));
    expect(errors).toEqual([
      ['2026-10-04 00:01:10 UTC', 'CAMPAIGN_PARTIAL_FILL', 'ETH-USDT-SWAP', 'add', 'the add filled 5 of 6 contracts'],
      ['2026-10-02 12:00:50 UTC', 'CAMPAIGN_POSITION_UNEXPLAINED', 'ADA-USDT-SWAP', 'reconcile', 'the position is gone and the order history does not say why'],
    ]);

    const pot = container.querySelector('.campaign-pot')?.textContent ?? '';
    expect(pot).toContain('Start value56.00 USDT2026-09-20 00:01 UTC');
    expect(pot).toContain('Value now175.75 USDT');
    expect(pot).toContain('Free cash100.25 USDT');
    expect(pot).toContain('Open equity75.50 USDT');
    expect(pot).toContain('Banked300.00 USDT');
    expect(pot).toContain('Next rung5,600.00 USDT (1 passed)');
    expect(pot).toContain('Peak612.50 USDT2026-09-28 12:00 UTC');
    expect(pot).toContain('Structurepyramid');
    // (175.75 + 300) / 56
    expect(container.querySelector('.campaign-pot-multiple')?.textContent).toBe('×8.50');
  });

  it('the campaigns newest first: entry, adds, harvested, proceeds, status and multiple; an open one with its value now and liquidation price', async () => {
    await render(runningView, 'Replay through');
    const rows = [...container.querySelectorAll('tr.campaign-row')].map((r) => [...r.querySelectorAll('td')].map((td) => td.textContent));
    expect(rows).toEqual([
      // prices at the instrument's tick, in their shortest exact form (the terminal's convention)
      ['ETH-USDT-SWAP', '2026-10-03 00:00 UTC', '2,400.528.00 USDT', '2', '0.00', '–', 'open', '×2.70now', '2,210.4'],
      ['ADA-USDT-SWAP', '2026-10-01 00:00 UTC', '2,400.528.00 USDT', '0', '0.00', 'not measured', 'external', '–', '–'],
      ['LTC-USDT-SWAP', '2026-09-26 00:00 UTC', '2,400.528.00 USDT', '0', '150.00', '0.00', 'harvest', '×5.36', '–'],
      ['XRP-USDT-SWAP', '2026-09-24 00:00 UTC', '2,400.528.00 USDT', '0', '0.00', '0.00', 'liquidated', '×0.00', '–'],
      ['BTC-USDT-SWAP', '2026-09-21 00:00 UTC', '2,400.528.00 USDT', '0', '0.00', '42.50', 'exit', '×1.52', '–'],
    ]);
    const eth = container.querySelector('tr.campaign-row');
    expect(eth?.querySelectorAll('td')[3]?.getAttribute('title')).toBe(
      '2026-10-03 12:00 UTC: +5 contracts @ 2,520.25\n2026-10-04 00:00 UTC: +5 contracts @ 2,646.1',
    );
    expect(eth?.querySelectorAll('td')[2]?.getAttribute('title')).toBe('filled 2026-10-03 00:01:00 UTC: 5 contracts; sized at 2,400');
    expect(container.querySelector('.campaign-state-unknown')).toBeNull();

    const banking = [...container.querySelectorAll('tr.campaign-banking-row td')].map((td) => td.textContent);
    expect(banking).toEqual(['2026-09-28 12:00 UTC', '1', '612.50', '306.25', '156.25', '60.0%', '143.75', '300.00']);
  });

  it('the replay: held BTC and both structures beside the pot, labelled by structure, and the rows that are not a match', async () => {
    await render(runningView, 'Replay through');
    expect(ids()).toEqual(['value', 'banked', 'heldBtc', 'replaySame', 'replayOther']);
    expect(chart.series.find((s) => s.id === 'replaySame')).toMatchObject({ color: '#3987e5', dashed: true });
    expect(chart.series.find((s) => s.id === 'value')).toMatchObject({ color: '#3987e5', dashed: false });
    expect(texts(container, '.campaign-legend-label')).toEqual(['Pot value', 'Banked', 'Start value held in BTC', "Replay, pyramid (the pot's)", 'Replay, no-add']);
    // the latest values, money in decimals
    expect(texts(container, '.campaign-legend-item b')).toEqual(['175.75', '300.00', '62.25', '176.00', '99.00']);
    expect(container.querySelector('.campaign-chart .campaign-replay-note')?.textContent).toBe(
      'Replay through the 2026-10-05 00:00 UTC close, computed 2026-10-05 00:02:00 UTC.',
    );

    const recon = container.querySelector('.campaign-recon');
    expect(texts(container, '.campaign-recon-counts .campaign-badge')).toEqual(['match 3', 'differs 1', 'live only 1', 'replay only 0']);
    expect(recon?.textContent).toContain('Tolerances: entryPx ±0.50%, stake ±1.00%.');
    const rows = [...(recon?.querySelectorAll('tr.campaign-recon-row') ?? [])].map((r) => [...r.querySelectorAll('td')].map((td) => td.textContent));
    // the signal close is the day after the open of the signal bar: the same close as the campaign's entry
    expect(rows).toEqual([
      ['ADA-USDT-SWAP', '2026-10-01 00:00 UTC', campaigns[1]?.id, 'live only', 'campaign: live external, replay –'],
      ['ETH-USDT-SWAP', '2026-10-03 00:00 UTC', campaigns[0]?.id, 'differs', 'entryPx: live 2400.5, replay 2390adds: live 2, replay 1'],
    ]);
  });

  it('a replay the API does not offer (404) shows the replay parts as unavailable, asked once', async () => {
    campaignReplay.mockRejectedValue(notFound);
    await render(runningView, 'does not offer it yet');
    await settle();
    expect(ids()).toEqual(['value', 'banked']);
    expect(texts(container, '.campaign-replay-note')).toEqual([en.campaign.replayMissing, en.campaign.replayMissing]);
    expect(container.querySelector('.campaign-replay-note')?.classList.contains('warn')).toBe(true);
    expect(container.querySelector('.campaign-recon-counts')).toBeNull();
    expect(campaignReplay).toHaveBeenCalledTimes(1);
    // the rest of the page does not depend on it
    expect(container.querySelectorAll('tr.campaign-row')).toHaveLength(5);
  });

  it('a failed replay says why; one that keeps an earlier result still draws and reconciles it', async () => {
    campaignReplay.mockResolvedValue(replayFailed);
    await render({ ...runningView, replay: { status: 'failed', computedAt: null, mismatches: null } }, REPLAY_FAILURE);
    expect(ids()).toEqual(['value', 'banked']);
    expect(container.querySelector('.campaign-chart .campaign-replay-note')?.textContent).toBe(`Replay failed: ${REPLAY_FAILURE}`);
    expect(container.querySelector('.campaign-recon-counts')).toBeNull();

    campaignReplay.mockResolvedValue(replayFailedEarlier);
    await act(async () => {
      useStore.setState({ campaign: { ...runningView, replay: { status: 'failed', computedAt: replayReady.computedAt, mismatches: 2 }, serverTime: NOW + 1 } });
    });
    await flush(container, 'the earlier result is shown');
    expect(ids()).toEqual(['value', 'banked', 'heldBtc', 'replaySame', 'replayOther']);
    expect(container.querySelector('.campaign-chart .campaign-replay-note')?.textContent).toBe(`The last replay failed (${REPLAY_FAILURE}); the earlier result is shown.`);
    expect(texts(container, '.campaign-recon-counts .campaign-badge')[0]).toBe('match 3');
  });

  it('reads the replay again when its computedAt changes, not on every change of the view', async () => {
    await render(runningView, 'Replay through');
    expect(campaignReplay).toHaveBeenCalledTimes(1);
    await act(async () => {
      useStore.setState({ campaign: { ...runningView, errorCount: 3, serverTime: NOW + 1 } });
    });
    await settle();
    expect(campaignReplay).toHaveBeenCalledTimes(1);
    await act(async () => {
      useStore.setState({ campaign: { ...runningView, replay: { status: 'ready', computedAt: LAST_CLOSE + 999_000, mismatches: 0 }, serverTime: NOW + 2 } });
    });
    await settle();
    expect(campaignReplay).toHaveBeenCalledTimes(2);
  });

  it('the decision log: newest first, a step expands to its inputs and actions, older pages load on demand', async () => {
    await render(runningView, '2 of 3 steps');
    expect(campaignLog).toHaveBeenCalledWith({ limit: 20 });
    const seqs = (): string[] => [...container.querySelectorAll('tr.campaign-step')].map((r) => r.querySelector('td')?.textContent?.replace(/^\S+ /, '') ?? '');
    expect(seqs()).toEqual(['42', '41']);
    const rows = [...container.querySelectorAll('tr.campaign-step')].map((r) => [...r.querySelectorAll('td')].slice(1).map((td) => td.textContent));
    expect(rows[0]).toEqual(['2026-10-05 00:00 UTC', 'close', '2026-10-05 00:00:05 UTC', '2026-10-05 00:01:05 UTC', '170.50', 'add skipped ×1', '0']);
    expect(rows[1]).toEqual(['2026-10-04 12:00 UTC', 'catch-up', '2026-10-04 15:00:00 UTC', '2026-10-04 15:01:30 UTC', 'account not read', 'enter missed ×1 · exit failed ×1', '1']);
    expect(container.querySelector('tr.campaign-step-error')?.textContent).toContain('41');
    expect(container.querySelector('.campaign-step-details')).toBeNull();

    // the catch-up: the closes it looked at, the bars, and the actions with their outcome, reason and attempts
    await click(container.querySelectorAll('tr.campaign-step')[1]);
    const details = container.querySelector('.campaign-step-details');
    expect(details?.textContent).toContain('Closes looked at: 2026-10-04 00:00 UTC, 2026-10-04 12:00 UTC');
    const input = [...(details?.querySelectorAll('tr.campaign-input td') ?? [])].map((td) => td.textContent);
    expect(input).toEqual(['BCH-USDT-SWAP', '2026-10-04 00:00 UTC', '590 / 612 / 588 / 611', '611.5', '611', '600', '540', 'ENTRY', '']);
    const actions = [...(details?.querySelectorAll('tr.campaign-action') ?? [])].map((r) => [...r.querySelectorAll('td')].map((td) => td.textContent));
    expect(actions).toEqual([
      ['enter', '2026-10-04 00:00 UTC', 'BCH-USDT-SWAP', 'missed', '–', 'signalTs=2026-10-03 00:00 UTC, close=611, entryHigh=600', '–', '0', '2026-10-04 15:00:01 UTC'],
      ['exit', '2026-10-04 00:00 UTC', 'BTC-USDT-SWAP', 'failedexecution error', 'EXCHANGE', 'late=true', 'proceeds=12.5', '3', '2026-10-04 15:00:50 UTC'],
    ]);
    expect(details?.querySelector('.campaign-notes')?.textContent).toBe('the service was not running at the 00:00 close');

    // the close step: a bar that was not confirmed in time, and a skip the rule foresees
    await click(container.querySelectorAll('tr.campaign-step')[0]);
    const first = container.querySelector('.campaign-step-details');
    expect(first?.textContent).toContain('Pot before the step: 170.50 USDT · free cash 100.25 · open equity 70.25 · banked 300.00 · rungs passed 1');
    expect(texts(first as HTMLElement, 'tr.campaign-input')[1]).toContain('not confirmed in time');
    expect(texts(first as HTMLElement, 'tr.campaign-action')[0]).toContain('add cap reached');

    // the older page
    await click([...container.querySelectorAll('button')].find((b) => b.textContent === 'Load older steps'));
    await flush(container, '3 of 3 steps');
    expect(campaignLog).toHaveBeenLastCalledWith({ before: 41, limit: 20 });
    expect(seqs()).toEqual(['42', '41', '40']);
    expect([...container.querySelectorAll('button')].some((b) => b.textContent === 'Load older steps')).toBe(false);
  });

  it('reads the log again from its newest step when a step ends', async () => {
    await render(runningView, '2 of 3 steps');
    expect(campaignLog).toHaveBeenCalledTimes(1);
    const lastStep = runningView.lastStep;
    if (lastStep === null) throw new Error('fixture without a last step');
    await act(async () => {
      useStore.setState({ campaign: { ...runningView, lastStep: { ...lastStep, seq: 43, endedAt: null }, serverTime: NOW + 1 } });
    });
    await settle();
    expect(campaignLog).toHaveBeenCalledTimes(2);
    expect(campaignLog).toHaveBeenLastCalledWith({ limit: 20 });
  });

  it('before the view is loaded: loading, and a failed load with a retry', async () => {
    campaign.mockRejectedValue(new ApiError('NETWORK', 'fetch failed', undefined, 0));
    await render(null);
    await flush(container, 'Could not load the campaign:');
    expect(container.querySelector('.load-failed button')?.textContent).toBe('Retry');
    campaign.mockImplementation(() => new Promise(() => undefined));
    await click(container.querySelector('.load-failed button'));
    expect(campaign).toHaveBeenCalledTimes(2);
  });

  it('the scoreboard in Chinese', async () => {
    useLangStore.setState({ lang: 'zh' });
    await render(runningView, '回放截至');
    expect(container.querySelector('.campaign-status')?.textContent).toBe('运行中');
    expect(container.querySelector('.campaign-ran')?.textContent).toBe('3 / 20');
    expect(container.querySelector('.campaign-next-step')?.textContent).toContain('2 小时 30 分后');
    expect(texts(container, '.campaign-state')).toEqual(['持仓中', '外部平仓', '取回卖完', '强平', '离场']);
    expect(texts(container, '.campaign-legend-label')).toEqual(['资金池估值', '已取回', '起始价值改持 BTC', '回放：浮盈加仓（本资金池）', '回放：不加仓']);
    expect(texts(container, '.campaign-recon-counts .campaign-badge')).toEqual(['一致 3', '有差异 1', '仅账本有 1', '仅回放有 0']);
  });
});
