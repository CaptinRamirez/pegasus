import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { useLangStore } from '../i18n';
import { api } from '../lib/api';
import { useStore } from '../store/store';
import { initialState } from '../store/types';
import { resetUi, useUi } from '../store/ui';
import { BTC, ETH } from '../test/campaign-fixtures';
import { adoptedTrade, closedManualDetail, journalPage, openSignalDetail, openSignalTrade } from '../test/journal-fixtures';
import { JournalPanel } from './JournalPanel';
import { Toasts } from './Toasts';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

vi.mock('../lib/api', async (importOriginal) => {
  const mod = await importOriginal<typeof import('../lib/api')>();
  return { ...mod, api: { journal: vi.fn(), journalTrade: vi.fn() } };
});

describe('the JOURNAL tab', () => {
  let root: Root;
  let container: HTMLDivElement;
  const journal = vi.mocked(api.journal);
  const journalTrade = vi.mocked(api.journalTrade);

  beforeEach(() => {
    journal.mockReset();
    journal.mockResolvedValue(journalPage);
    journalTrade.mockReset();
    journalTrade.mockImplementation((id) => Promise.resolve(id === closedManualDetail.id ? closedManualDetail : openSignalDetail));
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
    resetUi();
  });

  const render = async () => {
    const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    await act(async () => {
      root.render(
        <QueryClientProvider client={qc}>
          <JournalPanel />
          <Toasts />
        </QueryClientProvider>,
      );
    });
  };
  const until = async (what: string, cond: () => boolean): Promise<void> => {
    for (let i = 0; i < 200; i++) {
      if (cond()) return;
      await act(async () => {
        await new Promise((r) => setTimeout(r, 10));
      });
    }
    throw new Error(`timeout waiting for ${what}`);
  };
  const rows = () => [...container.querySelectorAll<HTMLTableRowElement>('tr.jr-row')];
  const cells = (row: Element | undefined) => [...(row?.querySelectorAll('td') ?? [])].map((td) => td.textContent ?? '');
  const drawer = () => document.body.querySelector<HTMLElement>('.jr-drawer');
  const select = (label: string) => [...container.querySelectorAll<HTMLLabelElement>('.jr-toolbar label')].find((l) => l.textContent?.startsWith(label))?.querySelector('select');
  const choose = (label: string, value: string) =>
    act(async () => {
      const s = select(label);
      if (s === null || s === undefined) throw new Error(label);
      s.value = value;
      s.dispatchEvent(new Event('change', { bubbles: true }));
    });

  it('one row per trade, newest first, with its source, plan, status, result and holding time', async () => {
    await render();
    await until('the trades', () => rows().length === 4);
    expect(journal).toHaveBeenCalledWith({ limit: 50 });
    const header = [...container.querySelectorAll('thead th')].map((th) => th.textContent);
    expect(header).toEqual([
      'Openedlocal · UTC',
      'CoinSide',
      'Source',
      'Entry avgSize',
      'NotionalLeverage / mode',
      'Initial stop',
      'Take-profit planTrailing',
      'Statusexit avg · closed by',
      'Realisednet',
      'R',
      'Held',
    ]);
    const signal = cells(rows()[0]);
    expect(signal[1]).toBe('BTClong');
    expect(signal[2]).toBe('Signal');
    expect(signal[3]).toBe('64,185.24 ct · 0.0400 BTC');
    expect(signal[4]).toBe('2,567.41 USDT10.0× isolated');
    expect(signal[5]).toBe('58,900');
    expect(signal[6]).toBe('–trailing stop at the 10-day low');
    expect(signal[7]).toBe('Open');
    expect(signal[10]).toMatch(/so far$/);
    const manual = cells(rows()[1]);
    expect(manual[2]).toBe('Manual');
    expect(manual[6]).toBe('3,150 / 3,240–');
    expect(manual[7]).toBe('Closed3,196.2 · take-profit 2');
    expect(manual[8]).toBe('+183.80+180.70 USDT');
    expect(manual[9]).toBe('+2.90R');
    expect(manual[10]).toBe('1 d 7 h');
    expect(cells(rows()[2])[2]).toBe('Campaign');
    expect(cells(rows()[3])[1]).toBe('XRPadoptedlong');
    expect(container.querySelector('.jr-toolbar')?.textContent).toContain('4 of 4 trades');
    // the time is shown in UTC as well as local
    expect(manual[0]).toContain('2026-10-01 08:15 UTC');
  });

  it('filters by coin, source and status through the server', async () => {
    await render();
    await until('the trades', () => rows().length === 4);
    await choose('Source', 'signal');
    await until('the filtered read', () => journal.mock.calls.some((c) => c[0]?.source === 'signal'));
    await choose('Status', 'open');
    await choose('Coin', 'BTC-USDT-SWAP');
    await until('all filters', () => journal.mock.calls.some((c) => c[0]?.source === 'signal' && c[0]?.status === 'open' && c[0]?.instId === 'BTC-USDT-SWAP'));
  });

  it('pages back with the cursor the server gives', async () => {
    journal.mockImplementation((q) => Promise.resolve(q?.before === undefined ? { ...journalPage, trades: journalPage.trades.slice(0, 2), next: 11, total: 4 } : { ...journalPage, trades: journalPage.trades.slice(2), next: null, total: 4 }));
    await render();
    await until('the first page', () => rows().length === 2);
    expect(container.querySelector('.jr-toolbar')?.textContent).toContain('2 of 4 trades');
    const older = [...container.querySelectorAll('button')].find((b) => b.textContent === 'Load older trades');
    await act(async () => older?.click());
    await until('the second page', () => rows().length === 4);
    expect(journal).toHaveBeenLastCalledWith({ limit: 50, before: 11 });
    expect([...container.querySelectorAll('button')].some((b) => b.textContent === 'Load older trades')).toBe(false);
  });

  it('a journal message updates a trade in place and brings a new one to the top', async () => {
    await render();
    await until('the trades', () => rows().length === 4);
    const closed = { ...openSignalTrade, status: 'closed' as const, size: '0', closedAt: openSignalTrade.openedAt + 3_600_000, durationMs: 3_600_000, exitPx: '58900', realisedPnl: '-211.2', netPnl: '-213.9', rMultiple: '-1.0118', closeReason: 'trailing' as const, updatedAt: openSignalTrade.updatedAt + 10 };
    const fresh = { ...adoptedTrade, id: '13-XRP-USDT-SWAP', seq: 13, updatedAt: closed.updatedAt };
    await act(async () => {
      useStore.getState().applyMessage({ type: 'journal', data: { status: 'ready', reason: null, trades: [fresh, closed], serverTime: closed.updatedAt } });
    });
    expect(rows()).toHaveLength(5);
    expect(cells(rows()[0])[1]).toBe('XRPadoptedlong');
    const btc = cells(rows()[1]);
    expect(btc[7]).toBe('Closed58,900 · trailing stop');
    expect(btc[9]).toBe('-1.01R');
  });

  it('a row opens the drawer: the plan, every fill and exit, and the timeline in words with UTC and local times', async () => {
    await render();
    await until('the trades', () => rows().length === 4);
    await act(async () => rows()[1]?.click());
    await until('the trade', () => (drawer()?.querySelectorAll('.jr-event').length ?? 0) === 11);
    expect(journalTrade).toHaveBeenCalledWith('11-ETH-USDT-SWAP');
    const text = drawer()?.textContent ?? '';
    expect(text).toContain('ETH-USDT-SWAP');
    expect(text).toContain('Take-profits3,150 (50%), 3,240 (rest)Cost-price');
    expect(text).toContain('Closed bytake-profit 2');
    expect(text).toContain('Cost-price stopyes');
    expect(text).toContain('Initial risk (1R)62.40 USDT');
    expect(drawer()?.querySelectorAll('.jr-table')[0]?.querySelectorAll('tbody tr')).toHaveLength(3);
    const events = [...(drawer()?.querySelectorAll('.jr-event') ?? [])];
    expect(events[0]?.querySelector('.jr-when')?.textContent).toContain('2026-10-01 08:14 UTC');
    expect(events[7]?.querySelector('.jr-what')?.textContent).toBe('Stop-loss moved 2,950 → 3,012.4.');
    await act(async () => useLangStore.setState({ lang: 'zh' }));
    expect(events[7]?.querySelector('.jr-what')?.textContent).toBe('止损移动 2,950 → 3,012.4。');
    await act(async () => drawer()?.querySelector<HTMLButtonElement>('.overlay-close')?.click());
    expect(drawer()).toBeNull();
  });

  it('the signal a trade followed is in its drawer', async () => {
    await render();
    await until('the trades', () => rows().length === 4);
    await act(async () => rows()[0]?.click());
    await until('the trade', () => (drawer()?.querySelectorAll('.jr-event').length ?? 0) === 4);
    expect(drawer()?.querySelector('.jr-signal')?.textContent).toContain('entry: close 64,120 (2026-10-05 00:00 UTC');
    expect(drawer()?.querySelector('.jr-signal')?.textContent).toContain('entry level 63,250, exit level 58,600');
  });

  it('a blocked journal says why; the toast of an order opens its trade', async () => {
    journal.mockResolvedValue({ ...journalPage, status: 'blocked', reason: { code: 'JOURNAL_UNREADABLE', message: 'the journal file data/journal.paper.json cannot be read' } });
    await act(async () => {
      useStore.getState().applyMessage({ type: 'journal', data: { status: 'ready', reason: null, trades: journalPage.trades, serverTime: 1 } });
      useStore.getState().pushToast('success', 'Signal followed', { kind: 'journal', instId: 'BTC-USDT-SWAP', mgnMode: 'isolated', posSide: 'net', ordId: 'o9' });
    });
    await render();
    await until('the trades', () => rows().length === 4);
    expect(container.querySelector('.jr-status-note')?.textContent).toBe('Blocked: The journal file cannot be read: nothing is recorded until it is repaired or moved away.');
    const link = document.body.querySelector<HTMLButtonElement>('.toast-link');
    expect(link?.textContent).toBe('Open in the journal →');
    await act(async () => link?.click());
    expect(useUi.getState().tab).toBe('journal');
    await until('the drawer', () => drawer() !== null);
    expect(journalTrade).toHaveBeenCalledWith('12-BTC-USDT-SWAP');
    expect(useStore.getState().toasts).toHaveLength(0);
  });
});
