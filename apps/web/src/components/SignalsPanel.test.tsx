import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { D, DEFAULT_TREND_PARAMS, utcDayStart, type Instrument, type InstrumentSignalReport, type Order, type Position, type SignalsResponse, type SizingPlan } from '@pegasus/shared';
import { useLangStore } from '../i18n';
import { api } from '../lib/api';
import { useStore } from '../store/store';
import { initialState } from '../store/types';
import { OrderTicket } from './OrderTicket';
import { SignalsPanel } from './SignalsPanel';
import { RISK_KEY } from './signals/riskPref';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

vi.mock('../lib/api', async (importOriginal) => {
  const mod = await importOriginal<typeof import('../lib/api')>();
  return {
    ...mod,
    api: {
      signals: vi.fn(),
      leverage: vi.fn(() => Promise.resolve([{ instId: 'BTC-USDT-SWAP', mgnMode: 'cross', posSide: 'net', lever: '5' }])),
      previewOrder: vi.fn(() => new Promise(() => undefined)),
    },
  };
});

const btc: Instrument = {
  instId: 'BTC-USDT-SWAP',
  instType: 'SWAP',
  uly: 'BTC-USDT',
  baseCcy: 'BTC',
  quoteCcy: 'USDT',
  settleCcy: 'USDT',
  ctVal: '0.01',
  ctValCcy: 'BTC',
  ctMult: '1',
  ctType: 'linear',
  lotSz: '1',
  minSz: '1',
  tickSz: '0.1',
  maxLmtSz: '100000',
  maxMktSz: '10000',
  maxLever: '100',
  state: 'live',
};

const DAY = 86_400_000;
/** The clock every test runs at: the real one would make the bar-age assertions depend on the time of day (they broke just after 00:00 UTC). */
const NOW = Date.UTC(2026, 9, 4, 13, 30);
/** Open time of the last closed UTC daily bar: it closed at today's 00:00 UTC. */
const LAST_BAR = utcDayStart(NOW) - DAY;

const longPlan: SizingPlan = {
  entryPx: '61000',
  stopLong: '57250',
  stopShort: '64750',
  stopDistancePct: '0.0614',
  rawNotional: '12195.12',
  targetNotional: '10000.00',
  notional: '10000.00',
  capped: true,
  multiplier: '1',
  adjustments: [],
  contracts: '16',
  coin: '0.16',
  riskQuote: '599.67',
  minUnitRiskQuote: '37.48',
  note: 'notional capped at 10% of equity; actual risk below 0.75%',
};

const shortPlan: SizingPlan = {
  ...longPlan,
  targetNotional: '5000.00',
  notional: '5000.00',
  multiplier: '0.5',
  adjustments: ['short x0.5'],
  contracts: '8',
  coin: '0.08',
  riskQuote: '299.83',
  note: 'notional capped at 10% of equity; actual risk below 0.75%; size x0.5 (short x0.5)',
};

const report: InstrumentSignalReport = {
  instId: 'BTC-USDT-SWAP',
  phase: 0,
  indicators: {
    asOf: LAST_BAR,
    bars: 299,
    close: '61000',
    ma: '55000',
    atr: '1500',
    atrPct: '0.02459',
    entryHigh: '60500',
    entryLow: '48000',
    exitHigh: '60200',
    exitLow: '52000',
    nextExitHigh: '61500',
    nextExitLow: '52400',
    efficiencyRatio: '0.4123',
    volShort: '0.52',
    volLong: '0.48',
    volRatio: '1.0833',
    dailyReturn: '0.01',
    dailySigma: '0.027',
    shockBars: [],
    crisisDaysAgo: null,
    maDistanceAtr: '4',
  },
  regime: 'trend',
  funding: { avg8h: '0.0001', latest8h: '0.00012', samples: 9, annualized: '0.1095' },
  signals: {
    longEntry: true,
    shortEntry: false,
    longExit: false,
    shortExit: true,
    reasons: ['close 61000 vs 55d high 60500: breakout up', 'regime trend: new entries allowed'],
  },
  sizing: { long: longPlan, short: shortPlan },
  structure: {
    book: { spreadPct: '0.00003', bidNotional: '1234567.00', askNotional: '912345.00', imbalance: '0.1201', levels: 20, ts: 1_700_000_000_000 },
    openInterest: { current: '4210000000', unit: 'usd', source: 'history', change1d: '0.012', change10d: '0.083', percentile30d: '0.867', points: 30 },
  },
  dataFetchedAt: LAST_BAR + DAY + 60_000,
  params: DEFAULT_TREND_PARAMS,
};

/** The same instrument on a 55-day low with shorts switched on: a short entry in a crisis regime, sized at a quarter. */
const shortReport: InstrumentSignalReport = {
  ...report,
  params: { ...DEFAULT_TREND_PARAMS, allowShort: true },
  regime: 'crisis',
  signals: { longEntry: false, shortEntry: true, longExit: true, shortExit: false, reasons: ['close vs 55d low 48000: breakout down', 'short size: short x0.5', 'short size: crisis x0.5'] },
  sizing: {
    long: { ...longPlan, notional: '5000.00', multiplier: '0.5', adjustments: ['crisis x0.5'], contracts: '8', coin: '0.08', riskQuote: '299.83' },
    short: { ...shortPlan, notional: '2500.00', multiplier: '0.25', adjustments: ['short x0.5', 'crisis x0.5'], contracts: '4', coin: '0.04', riskQuote: '149.92' },
  },
};

/** The same instrument at the 12:00 UTC cut: its bar closed at today's noon, its lot is smaller. */
const noonReport: InstrumentSignalReport = {
  ...report,
  phase: 12,
  indicators: { ...report.indicators, asOf: LAST_BAR + DAY / 2, close: '61800' },
  signals: { ...report.signals, reasons: ['close 61800 vs 55d high 60500: breakout up'] },
  sizing: { long: { ...longPlan, entryPx: '61800', contracts: '7', coin: '0.07', notional: '4326.00', riskQuote: '262.50' }, short: shortPlan },
};

const restingBuy: Order = {
  ordId: 'o1', clOrdId: 'c1', instId: 'BTC-USDT-SWAP', side: 'buy', posSide: 'long', tdMode: 'cross', ordType: 'limit', px: '60900', sz: '16', accFillSz: '0', avgPx: '',
  state: 'live', reduceOnly: false, lever: '3', fee: '0', feeCcy: '', pnl: '0', cTime: 1, uTime: 1,
};

const btcLong: Position = {
  instId: 'BTC-USDT-SWAP', posSide: 'long', mgnMode: 'cross', pos: '3', avgPx: '60000', markPx: '61000', upl: '30', uplRatio: '0.01',
  lever: '3', liqPx: '', margin: '600', notionalUsd: '1830', cTime: 1, uTime: 1,
};

/** Cells of the first signal row: 10 = Book, 11 = OI (after instrument, regime, close, MA, ATR, entry, exit, ER, vol ratio, funding). */
const BOOK_CELL = 10;
const OI_CELL = 11;
const rowCells = (container: HTMLElement): HTMLTableCellElement[] => [...container.querySelectorAll<HTMLTableCellElement>('tr.signal-row td')];

const response: SignalsResponse = {
  generatedAt: LAST_BAR + DAY + 5 * 3_600_000,
  equity: '100000',
  phases: [0, 12],
  // one cut's lot: half of the unit the owner chose (0.5% risk, 10% cap)
  sizingParams: { riskPct: '0.0025', maxNotionalPct: '0.05', atrStopMultiple: '2.5' },
  reports: [report, { instId: 'ETH-USDT-SWAP', phase: 0, error: { code: 'NOT_ENOUGH_DATA', message: 'need at least 101 confirmed daily bars, got 40' } }],
};

/** The same report from a server that computes the 00:00 cut alone: the lot is the whole unit. */
const oneCut: SignalsResponse = { ...response, phases: [0], sizingParams: { ...response.sizingParams, riskPct: '0.005', maxNotionalPct: '0.10' } };

async function flush(container: HTMLElement, needle: string): Promise<void> {
  for (let i = 0; i < 50; i++) {
    if ((container.textContent ?? '').includes(needle)) return;
    await act(async () => {
      await new Promise((r) => setTimeout(r, 5));
    });
  }
  throw new Error(`timeout waiting for "${needle}"`);
}

const click = (el: Element | null): Promise<void> =>
  act(async () => {
    el?.dispatchEvent(new MouseEvent('click', { bubbles: true }));
  });

describe('SignalsPanel', () => {
  let root: Root;
  let container: HTMLDivElement;
  const signals = vi.mocked(api.signals);

  beforeEach(() => {
    // Only the clock is pinned; the timers the queries and flush() rely on stay real.
    vi.useFakeTimers({ toFake: ['Date'], now: NOW });
    signals.mockReset();
    signals.mockResolvedValue(response);
    localStorage.clear();
    useStore.setState({
      ...initialState('tok'),
      instruments: [btc],
      account: { posMode: 'net_mode', acctLv: '2', canTrade: true },
      balance: { totalEq: '10123.45', details: [], ts: 1 },
    });
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

  const render = async (withTicket = false, needle = 'LONG ENTRY') => {
    const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    await act(async () => {
      root.render(
        <QueryClientProvider client={qc}>
          <SignalsPanel />
          {withTicket && <OrderTicket />}
        </QueryClientProvider>,
      );
    });
    await flush(container, needle);
  };

  it('renders regime and signal badges, formatted indicators and the error row', async () => {
    await render();
    // risk per trade defaults to the framework's first-three-months 0.5%
    expect(signals).toHaveBeenCalledWith({ equity: '10123.45', riskPct: '0.005' });

    const regime = container.querySelector('.signal-badge.regime-trend');
    expect(regime?.textContent).toBe('trend');
    const badges = [...container.querySelectorAll('.signal-badge')].map((b) => b.textContent);
    expect(badges).toContain('LONG ENTRY');
    expect(badges).toContain('SHORT EXIT');
    expect(badges).not.toContain('SHORT ENTRY');
    expect(badges).toContain('capped');

    const text = container.textContent ?? '';
    expect(text).toContain('61,000'); // close, grouped and at tickSz precision
    expect(text).toContain('+4.0 ATR');
    expect(text).toContain('2.46%'); // atrPct
    expect(text).toContain('0.0100%/8h'); // funding 3d avg
    expect(text).toContain('11.0% p.a.');
    expect(text).toContain('10,000.00 USDT');
    expect(text).toContain('599.67 USDT');

    const cells = rowCells(container);
    const book = cells[BOOK_CELL];
    expect(book?.textContent).toBe('+12%0.3 bp · 1.2M / 0.9M');
    expect(book?.getAttribute('title')).toBe('Visible depth over 20 levels; execution context only, not a direction signal.');
    const oi = cells[OI_CELL];
    expect(oi?.textContent).toBe('4.2B+8.3% (+1.2%)');
    expect(oi?.querySelector('.sub .pos')?.textContent).toBe('+8.3%');
    expect(oi?.querySelector('.sub .neg')).toBeNull();

    const error = container.querySelector('.signal-error');
    expect(error?.textContent).toBe('NOT_ENOUGH_DATA: need at least 101 confirmed daily bars, got 40');
    expect(error?.closest('tr')?.textContent).toContain('ETH-USDT-SWAP');
    expect(container.querySelectorAll('button.btn-buy')).toHaveLength(1);
  });

  it('on a Chinese page asks the server for Chinese texts and labels the table in Chinese', async () => {
    useLangStore.setState({ lang: 'zh' });
    await render(false, '做多入场');
    // the reasons and sizing notes are written by the server: it is told the language
    expect(signals).toHaveBeenCalledWith({ equity: '10123.45', riskPct: '0.005', lang: 'zh' });
    expect(container.querySelector('.signal-badge.regime-trend')?.textContent).toBe('趋势');
    const badges = [...container.querySelectorAll('.signal-badge')].map((b) => b.textContent);
    expect(badges).toContain('做多入场');
    expect(badges).toContain('空头离场');
    expect(container.querySelector('button.btn-buy')?.textContent).toBe('应用');
    expect(container.querySelector('.signals-table thead')?.textContent).toContain('市场状态');
    expect(container.querySelector('.signal-error')?.textContent).toBe('NOT_ENOUGH_DATA: 已确认的日K线数量不足（need at least 101 confirmed daily bars, got 40）');
  });

  it('expands a row to show the reasons verbatim and the sizing note', async () => {
    await render();
    expect(container.querySelector('.signal-reasons')).toBeNull();
    await click(container.querySelector('tr.signal-row'));
    const reasons = container.querySelector('.signal-reasons');
    expect(reasons?.textContent).toBe('close 61000 vs 55d high 60500: breakout up\nregime trend: new entries allowed');
    expect(container.querySelector('.signal-note:not(.signal-structure)')?.textContent).toContain(report.sizing?.long.note);
    const notes = [...container.querySelectorAll('.signal-note')].map((n) => n.textContent ?? '');
    // shorts are off by default: the short plan is not offered
    expect(notes).toContain('sizing short: off (short entries are switched off, allowShort = false)');
    // the level the NEXT close is tested against: where the exchange-side stop is trailed to
    expect(notes.some((n) => n.includes('next session') && n.includes('52,400') && n.includes('61,500'))).toBe(true);
    expect(container.querySelector('.signal-structure')?.textContent).toBe(
      'structure: book imbalance +12%, spread 0.3 bp, depth 1.2M/0.9M · OI 4.2B, 1d +1.2%, 10d +8.3%, pct 0.87',
    );
    await click(container.querySelector('tr.signal-row'));
    expect(container.querySelector('.signal-reasons')).toBeNull();
  });

  it('shows n/a for the Book and OI cells when the structure block is missing', async () => {
    signals.mockResolvedValue({ ...response, reports: [{ ...report, structure: null }] });
    await render();
    const cells = rowCells(container);
    expect(cells[BOOK_CELL]?.textContent).toBe('n/a');
    expect(cells[BOOK_CELL]?.classList.contains('dim')).toBe(true);
    expect(cells[OI_CELL]?.textContent).toBe('n/a');
    expect(cells[OI_CELL]?.classList.contains('dim')).toBe(true);
    await click(container.querySelector('tr.signal-row'));
    expect(container.querySelector('.signal-structure')?.textContent).toBe('structure: book n/a · OI n/a');
  });

  it('formats OI in contracts, dashes unavailable changes and colours a large 10d drop red', async () => {
    const structure: InstrumentSignalReport['structure'] = {
      book: null,
      openInterest: { current: '1234567', unit: 'contracts', source: 'history', change1d: '', change10d: '-0.0712', percentile30d: '', points: 12 },
    };
    signals.mockResolvedValue({ ...response, reports: [{ ...report, structure }] });
    await render();
    const cells = rowCells(container);
    expect(cells[BOOK_CELL]?.textContent).toBe('n/a');
    const oi = cells[OI_CELL];
    expect(oi?.textContent).toBe('1,234,567-7.1% (–)');
    expect(oi?.querySelector('.sub .neg')?.textContent).toBe('-7.1%');
    await click(container.querySelector('tr.signal-row'));
    expect(container.querySelector('.signal-structure')?.textContent).toBe('structure: book n/a · OI 1,234,567, 1d –, 10d -7.1%, pct –');
  });

  it('Apply fills the ticket prefill in the store and the order ticket picks it up', async () => {
    await render(true);
    expect(useStore.getState().ticketPrefill).toBeNull();
    await click(container.querySelector('button.btn-buy'));
    expect(useStore.getState().selectedInstId).toBe('BTC-USDT-SWAP');
    expect(useStore.getState().ticketPrefill).toEqual({
      instId: 'BTC-USDT-SWAP',
      side: 'buy',
      ordType: 'limit',
      px: '61000',
      sizeValue: '16',
      sizeUnit: 'contracts',
      // the long plan's stop
      slTriggerPx: '57250',
      nonce: 1,
    });
    // the row click must not have toggled the details
    expect(container.querySelector('.signal-reasons')).toBeNull();

    // price and size inputs come before the leverage control's input
    const inputs = [...container.querySelectorAll<HTMLInputElement>('.form input.num')].map((i) => i.value);
    expect(inputs.slice(0, 3)).toEqual(['61000', '16', '57250']);
    const unit = container.querySelector<HTMLSelectElement>('.input-group select');
    expect(unit?.value).toBe('contracts');
    expect(container.querySelector('.btn-group .btn.active.buy')).not.toBeNull();
  });

  it('Apply says so when the plan has no positive stop to carry into the ticket', async () => {
    // a stop distance wider than the price: the long stop is not a price
    const noStop: InstrumentSignalReport = { ...report, sizing: report.sizing === null ? null : { ...report.sizing, long: { ...report.sizing.long, stopLong: '-250' } } };
    expect(noStop.sizing).not.toBeNull();
    signals.mockResolvedValue({ ...response, reports: [noStop] });
    await render(true);
    await click(container.querySelector('button.btn-buy'));
    expect(useStore.getState().ticketPrefill).toEqual({ instId: 'BTC-USDT-SWAP', side: 'buy', ordType: 'limit', px: '61000', sizeValue: '16', sizeUnit: 'contracts', nonce: 1 });
    expect(useStore.getState().toasts.at(-1)?.message).toBe(
      'Ticket filled: buy 16 contracts BTC-USDT-SWAP @ 61000 (00:00 UTC cut). NO stop was carried into the ticket (the plan has no positive stop price): set the stop yourself',
    );
  });

  it('shows both plans per row and Apply on a short entry fills the reduced short size', async () => {
    signals.mockResolvedValue({ ...response, reports: [shortReport] });
    await render(true, 'SHORT ENTRY');
    const text = container.querySelector('tr.signal-row')?.textContent ?? '';
    // long plan on the main line, short plan on the sub line; the cuts are visible without expanding
    expect(text).toContain('5,000.00 USDT');
    expect(text).toContain('2,500.00 USDT');
    expect(container.querySelector('.signal-adjust')?.textContent).toBe('size ×0.25: short x0.5, crisis x0.5');
    expect(container.querySelectorAll('.signal-side-on').length).toBeGreaterThan(0);
    for (const el of container.querySelectorAll('.signal-side-on')) expect(el.classList.contains('sub')).toBe(true);
    expect(container.querySelector('button.btn-buy')).toBeNull();
    await click(container.querySelector('button.btn-sell'));
    expect(useStore.getState().ticketPrefill).toEqual({ instId: 'BTC-USDT-SWAP', side: 'sell', ordType: 'limit', px: '61000', sizeValue: '4', sizeUnit: 'contracts', slTriggerPx: '64750', nonce: 1 });
    const inputs = [...container.querySelectorAll<HTMLInputElement>('.form input.num')].map((i) => i.value);
    // price, size and the short plan's stop
    expect(inputs.slice(0, 3)).toEqual(['61000', '4', '64750']);
  });

  it('shows the short side as off while short entries are switched off', async () => {
    // a 55-day low with allowShort = false; a stale server that still flagged the entry must not get a badge or a button either
    const off: InstrumentSignalReport = { ...shortReport, params: DEFAULT_TREND_PARAMS };
    expect(off.signals.shortEntry).toBe(true);
    signals.mockResolvedValue({ ...response, reports: [off] });
    await render(false, 'LONG EXIT');
    const badges = [...container.querySelectorAll('.signal-badge')].map((b) => b.textContent);
    expect(badges).not.toContain('SHORT ENTRY');
    expect(container.querySelector('button.btn-sell')).toBeNull();
    const row = container.querySelector('tr.signal-row');
    // no side is signalled: no Apply button at all, and the short plan's size cut is not listed
    expect(row?.querySelector('button')).toBeNull();
    expect(row?.querySelector('.signal-adjust')).toBeNull();
    // the short plan (4 contracts, 2,500 USDT) is not shown; the long plan is
    expect([...(row?.querySelectorAll('.signal-short-off') ?? [])].map((el) => el.textContent)).toEqual(['short off', '–', '–', '–']);
    expect(row?.textContent).not.toContain('2,500.00 USDT');
    expect(row?.textContent).toContain('5,000.00 USDT');
    expect(container.querySelector('.signals-toolbar')?.textContent).toContain('shorts off');
    await click(row);
    const notes = [...container.querySelectorAll('.signal-note')].map((n) => n.textContent ?? '');
    expect(notes).toContain('sizing short: off (short entries are switched off, allowShort = false)');
    // the stop of a short that is still open keeps being shown
    expect(notes.some((n) => n.includes('next session') && n.includes('61,500'))).toBe(true);
  });

  it('shows the short plan again when short entries are switched on', async () => {
    signals.mockResolvedValue({ ...response, reports: [{ ...report, params: { ...DEFAULT_TREND_PARAMS, allowShort: true } }] });
    await render();
    expect(container.querySelector('.signal-short-off')).toBeNull();
    expect(container.querySelector('.signals-toolbar')?.textContent).not.toContain('shorts off');
    await click(container.querySelector('tr.signal-row'));
    const notes = [...container.querySelectorAll('.signal-note')].map((n) => n.textContent ?? '');
    expect(notes.some((n) => n.startsWith('sizing short:') && n.includes('short x0.5'))).toBe(true);
  });

  it('does not show adjustments on a full-size long entry', async () => {
    await render();
    expect(container.querySelector('.signal-adjust')).toBeNull();
    expect(container.querySelector('.signal-unchecked')).toBeNull();
    for (const el of container.querySelectorAll('.signal-side-on')) expect(el.classList.contains('sub')).toBe(false);
  });

  it('names the daily bar the signals come from and warns when a newer one should exist', async () => {
    await render();
    const bar = container.querySelector('.signals-bar');
    const closed = new Date(LAST_BAR + DAY).toISOString().slice(0, 10);
    expect(bar?.textContent).toContain(`bar closed ${closed} 00:00 UTC`);
    expect(bar?.textContent).toMatch(/ago$/);
    expect(bar?.classList.contains('warn')).toBe(false);
  });

  it('does not warn about the bar in the first minutes after 00:00 UTC, while the new one is not published yet', async () => {
    vi.setSystemTime(utcDayStart(NOW) + 5 * 60_000);
    const previous = { ...report, indicators: { ...report.indicators, asOf: LAST_BAR - DAY } };
    signals.mockResolvedValue({ ...response, reports: [previous] });
    await render();
    expect(container.querySelector('.signals-bar')?.classList.contains('warn')).toBe(false);
  });

  it('shows the bar in the warning colour when it closed more than a day ago', async () => {
    const stale = { ...report, indicators: { ...report.indicators, asOf: LAST_BAR - DAY } };
    signals.mockResolvedValue({ ...response, reports: [stale] });
    await render();
    const bar = container.querySelector('.signals-bar');
    expect(bar?.textContent).toContain(`bar closed ${new Date(LAST_BAR).toISOString().slice(0, 10)} 00:00 UTC`);
    expect(bar?.classList.contains('warn')).toBe(true);
  });

  it('lets the owner pick the risk per trade, remembers it and states what the server used', async () => {
    // the server splits the unit the owner chose between the two cuts
    signals.mockImplementation((q) => Promise.resolve({ ...response, sizingParams: { ...response.sizingParams, riskPct: D(q?.riskPct ?? '0.0075').div(2).toFixed() } }));
    await render();
    expect(container.querySelector('.signals-toolbar')?.textContent).toContain('risk 0.50% of equity per unit');
    expect(container.querySelector('.signals-toolbar')?.textContent).toContain('notional cap 10%');
    expect(container.querySelector('.signals-toolbar')?.textContent).toContain('each cut sized at 1/2 of a unit');
    const select = container.querySelector<HTMLSelectElement>('.signals-toolbar select');
    expect(select?.value).toBe('0.005');
    await act(async () => {
      if (select) select.value = '0.0075';
      select?.dispatchEvent(new Event('change', { bubbles: true }));
    });
    await flush(container, 'risk 0.75% of equity per unit');
    expect(signals).toHaveBeenLastCalledWith({ equity: '10123.45', riskPct: '0.0075' });
    expect(localStorage.getItem(RISK_KEY)).toBe('0.0075');
  });

  it('shows one row per instrument and cut, marks the cut that closed last and applies the row\'s own lot', async () => {
    const failedNoon = { instId: 'ETH-USDT-SWAP', phase: 12 as const, error: { code: 'EXCHANGE', message: 'candles unavailable' } };
    signals.mockResolvedValue({ ...response, generatedAt: NOW, reports: [report, noonReport, ...response.reports.slice(1), failedNoon] });
    await render(true);
    const rows = [...container.querySelectorAll('tbody tr')];
    expect(rows.map((r) => r.querySelector('td')?.textContent?.replace(/^\S* /, ''))).toEqual([
      'BTC-USDT-SWAP00:00 UTC',
      'BTC-USDT-SWAP12:00 UTC · latest close',
      'ETH-USDT-SWAP00:00 UTC',
      'ETH-USDT-SWAP12:00 UTC · latest close',
    ]);
    expect(container.querySelectorAll('.signal-cut-latest')).toHaveLength(2);
    expect(rows[3]?.querySelector('.signal-error')?.textContent).toBe('EXCHANGE: candles unavailable');
    const toolbar = container.querySelector('.signals-toolbar')?.textContent ?? '';
    expect(toolbar).toContain('daily closes at 00:00 UTC and 12:00 UTC');
    // the bar named is the one that closed last; the 00:00 one is 13 hours old and not overdue
    expect(container.querySelector('.signals-bar')?.textContent).toContain(`bar closed ${new Date(NOW).toISOString().slice(0, 10)} 12:00 UTC`);
    expect(container.querySelector('.signals-bar')?.classList.contains('warn')).toBe(false);

    // each row expands on its own
    await click(rows[1] ?? null);
    expect([...container.querySelectorAll('.signal-reasons')].map((r) => r.textContent)).toEqual(['close 61800 vs 55d high 60500: breakout up']);
    expect(container.querySelector('.signal-details')?.textContent).toContain(`bar closed ${new Date(NOW).toISOString().slice(0, 10)} 12:00 UTC`);

    // Apply takes the lot and the close of its own row
    const buttons = container.querySelectorAll('tr.signal-row button.btn-buy');
    expect(buttons).toHaveLength(2);
    await click(buttons[1] ?? null);
    expect(useStore.getState().ticketPrefill).toMatchObject({ instId: 'BTC-USDT-SWAP', side: 'buy', px: '61800', sizeValue: '7', sizeUnit: 'contracts' });
    expect(useStore.getState().toasts.at(-1)?.message).toBe('Ticket filled: buy 7 contracts BTC-USDT-SWAP @ 61800 (12:00 UTC cut)');
    await click(buttons[0] ?? null);
    expect(useStore.getState().ticketPrefill).toMatchObject({ px: '61000', sizeValue: '16' });
  });

  it('marks the 00:00 cut in the hours after midnight, and no cut when the server computes one only', async () => {
    signals.mockResolvedValue({ ...response, reports: [report, noonReport] });
    await render();
    // generated at 05:00 UTC: the 00:00 bar is the one that just closed
    expect([...container.querySelectorAll('.signal-cut')].map((el) => el.textContent)).toEqual(['00:00 UTC · latest close', '12:00 UTC']);
    await act(async () => root.unmount());
    root = createRoot(container);
    signals.mockResolvedValue({ ...response, phases: [0], sizingParams: { ...response.sizingParams, riskPct: '0.005', maxNotionalPct: '0.10' }, reports: [report] });
    await render();
    expect([...container.querySelectorAll('.signal-cut')].map((el) => el.textContent)).toEqual(['00:00 UTC']);
    const toolbar = container.querySelector('.signals-toolbar')?.textContent ?? '';
    expect(toolbar).toContain('risk 0.50% of equity per trade');
    expect(toolbar).toContain('UTC daily close');
    expect(toolbar).not.toContain('of a unit');
  });

  it('starts from the remembered risk per trade', async () => {
    localStorage.setItem(RISK_KEY, '0.0075');
    await render();
    expect(signals).toHaveBeenCalledWith({ equity: '10123.45', riskPct: '0.0075' });
  });

  it('refetches when the window regains focus', async () => {
    await render();
    expect(signals).toHaveBeenCalledTimes(1);
    await act(async () => {
      window.dispatchEvent(new Event('visibilitychange'));
      await new Promise((r) => setTimeout(r, 20));
    });
    expect(signals).toHaveBeenCalledTimes(2);
  });

  it('marks an entry whose funding gate was skipped for lack of data', async () => {
    signals.mockResolvedValue({ ...response, reports: [{ ...report, funding: null }] });
    await render();
    expect(container.querySelector('tr.signal-row .signal-unchecked')?.textContent).toBe('funding unchecked');
  });

  it('one cut: flags an open position on the signalled side and does not offer to add to it', async () => {
    signals.mockResolvedValue(oneCut);
    useStore.setState({ positions: [btcLong] });
    await render(true);
    expect(container.querySelector('tr.signal-row .signal-held')?.textContent).toBe('in position');
    const apply = container.querySelector<HTMLButtonElement>('button.btn-buy');
    expect(apply?.disabled).toBe(true);
    expect(apply?.title).toMatch(/not part of the framework yet/);
    await click(apply);
    expect(useStore.getState().ticketPrefill).toBeNull();
  });

  it('two cuts: one lot open or resting leaves the lot of the other cut to apply; what amounts to both lots does not', async () => {
    // 3 contracts held against a lot of 16: the other cut's lot may be in, this row's is still offered
    useStore.setState({ positions: [btcLong] });
    await render(true);
    const held = container.querySelector<HTMLElement>('tr.signal-row .signal-held');
    expect(held?.textContent).toBe('in position');
    expect(held?.title).toMatch(/only if what is open is the other cut's lot/);
    const apply = container.querySelector<HTMLButtonElement>('button.btn-buy');
    expect(apply?.disabled).toBe(false);
    expect(apply?.title).toMatch(/^Fill the ticket: buy 16 contracts @ 61000\. .*other cut's lot/);
    await click(apply);
    expect(useStore.getState().ticketPrefill).toMatchObject({ instId: 'BTC-USDT-SWAP', side: 'buy', sizeValue: '16' });
    // a lot held and a second one resting (9 unfilled of 16): 3 + 12 + 9 = 24 contracts, a lot and a half
    await act(async () => {
      useStore.setState({ positions: [{ ...btcLong, pos: '15' }], orders: { o1: { ...restingBuy, accFillSz: '7' } } });
    });
    expect(container.querySelector<HTMLElement>('tr.signal-row .signal-held')?.title).toMatch(/lots of all the daily cuts/);
    expect(apply?.disabled).toBe(true);
    expect(apply?.title).toMatch(/lots of all the daily cuts/);
    // a resting entry alone of one lot's size: the other cut's lot is still offered
    await act(async () => {
      useStore.setState({ positions: [], orders: { o1: restingBuy } });
    });
    expect(container.querySelector('tr.signal-row .signal-held')?.textContent).toBe('entry pending');
    expect(apply?.disabled).toBe(false);
    // an exit resting on the leg is not an entry: it does not count towards the unit
    await act(async () => {
      useStore.setState({ positions: [{ ...btcLong, pos: '16' }], orders: { o1: { ...restingBuy, side: 'sell' } } });
    });
    expect(apply?.disabled).toBe(false);
  });

  it('one cut: flags a resting entry order on the signalled side and does not offer a second full-size entry', async () => {
    signals.mockResolvedValue(oneCut);
    useStore.setState({ account: { posMode: 'long_short_mode', acctLv: '2', canTrade: true }, orders: { o1: restingBuy } });
    await render(true);
    expect(container.querySelector('tr.signal-row .signal-held')?.textContent).toBe('entry pending');
    const apply = container.querySelector<HTMLButtonElement>('button.btn-buy');
    expect(apply?.disabled).toBe(true);
    expect(apply?.title).toMatch(/entry order on this side is already open/);
    await click(apply);
    expect(useStore.getState().ticketPrefill).toBeNull();
  });

  it('net mode: a same-side order that is not reduce-only is a pending entry, an exit or the other side is not', async () => {
    const net: Order = { ...restingBuy, posSide: 'net' };
    signals.mockResolvedValue(oneCut);
    useStore.setState({ orders: { o1: net } });
    await render();
    expect(container.querySelector('tr.signal-row .signal-held')?.textContent).toBe('entry pending');
    expect(container.querySelector<HTMLButtonElement>('button.btn-buy')?.disabled).toBe(true);
    for (const other of [{ ...net, reduceOnly: true }, { ...net, side: 'sell' as const }, { ...net, instId: 'ETH-USDT-SWAP' }, { ...restingBuy, side: 'sell' as const, posSide: 'short' as const }]) {
      await act(async () => {
        useStore.setState({ orders: { o1: other } });
      });
      expect(container.querySelector('.signal-held')).toBeNull();
      expect(container.querySelector<HTMLButtonElement>('button.btn-buy')?.disabled).toBe(false);
    }
  });

  it('still offers the entry when the open position is on the other side', async () => {
    useStore.setState({ positions: [{ ...btcLong, posSide: 'short' }] });
    await render();
    expect(container.querySelector('.signal-held')).toBeNull();
    expect(container.querySelector<HTMLButtonElement>('button.btn-buy')?.disabled).toBe(false);
  });

  it('labels a live open interest level whose history is unavailable', async () => {
    const structure: InstrumentSignalReport['structure'] = {
      book: null,
      openInterest: { current: '592592400', unit: 'usd', source: 'live', change1d: '', change10d: '', percentile30d: '', points: 1 },
    };
    signals.mockResolvedValue({ ...response, reports: [{ ...report, structure }] });
    await render();
    const oi = rowCells(container)[OI_CELL];
    expect(oi?.textContent).toBe('593Mlive · no history');
    expect(oi?.getAttribute('title')).toMatch(/history is unavailable/);
    await click(container.querySelector('tr.signal-row'));
    expect(container.querySelector('.signal-structure')?.textContent).toBe('structure: book n/a · OI 593M (live level; history and changes unavailable)');
  });

  it('after a failed refresh the old table is dimmed, says since when it is not updated, and cannot be applied', async () => {
    await render();
    expect(container.querySelector('.signals-outdated')).toBeNull();
    expect(container.querySelector('.signals-stale')).toBeNull();
    expect(container.querySelector<HTMLButtonElement>('button.btn-buy')?.disabled).toBe(false);
    // date and time: "updated 05:00:00" alone does not say which day
    expect(container.querySelector('.signals-toolbar')?.textContent).toMatch(/updated \d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}/);

    signals.mockRejectedValue(new Error('boom'));
    await click([...container.querySelectorAll('button')].find((b) => b.textContent === 'Refresh') ?? null);
    await flush(container, 'boom');
    const notice = container.querySelector('.signals-outdated');
    expect(notice?.textContent).toMatch(/^Signals not updated since \d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}\./);
    expect(notice?.textContent).not.toContain('信号');
    expect(container.querySelector('.signals-stale')).not.toBeNull();
    expect(container.textContent).toContain('LONG ENTRY'); // the old table stays readable
    const apply = container.querySelector<HTMLButtonElement>('button.btn-buy');
    expect(apply?.disabled).toBe(true);
    expect(apply?.title).toMatch(/could not be refreshed/);
    await click(apply);
    expect(useStore.getState().ticketPrefill).toBeNull();

    // a successful refresh makes it live again
    signals.mockResolvedValue(response);
    await click([...container.querySelectorAll('button')].find((b) => b.textContent === 'Refresh') ?? null);
    for (let i = 0; i < 50 && container.querySelector('.signals-outdated') !== null; i++) {
      await act(async () => {
        await new Promise((r) => setTimeout(r, 5));
      });
    }
    expect(container.querySelector('.signals-outdated')).toBeNull();
    expect(container.querySelector<HTMLButtonElement>('button.btn-buy')?.disabled).toBe(false);
  });

  it('a report that missed two refreshes without an error is outdated too', async () => {
    vi.useFakeTimers({ toFake: ['Date', 'setInterval', 'clearInterval'], now: NOW });
    await render();
    expect(container.querySelector('.signals-outdated')).toBeNull();
    // refreshes that never come back (the PC slept, the request hangs): no error, only time passing
    signals.mockImplementation(() => new Promise(() => undefined));
    await act(async () => {
      vi.advanceTimersByTime(9 * 60_000);
    });
    expect(container.querySelector('.signals-outdated')).toBeNull();
    await act(async () => {
      vi.advanceTimersByTime(2 * 60_000);
    });
    expect(container.querySelector('.signals-outdated')?.textContent).toContain('Signals not updated since 2026-');
    expect(container.querySelector<HTMLButtonElement>('button.btn-buy')?.disabled).toBe(true);
  });

  it('the size unit a pre-fill brought does not stick to the next instrument; a unit picked by hand does', async () => {
    useStore.setState({ instruments: [btc, { ...btc, instId: 'ETH-USDT-SWAP', uly: 'ETH-USDT', baseCcy: 'ETH', ctVal: '0.1', ctValCcy: 'ETH' }] });
    await render(true);
    const unit = (): HTMLSelectElement | null => container.querySelector<HTMLSelectElement>('.form .input-group select');
    const select = (instId: string): Promise<void> =>
      act(async () => {
        useStore.getState().selectInstrument(instId);
      });
    await select('ETH-USDT-SWAP');
    expect(unit()?.value).toBe('coin');
    await click(container.querySelector('tr.signal-row button.btn-buy'));
    expect(unit()?.value).toBe('contracts');
    // a number typed for ETH with the usual unit in mind must not be read as contracts
    await select('ETH-USDT-SWAP');
    expect(unit()?.value).toBe('coin');

    // applied again, then the owner picks a unit himself: that choice is kept
    await click(container.querySelector('tr.signal-row button.btn-buy'));
    expect(unit()?.value).toBe('contracts');
    await act(async () => {
      const el = unit();
      if (el) el.value = 'quote';
      el?.dispatchEvent(new Event('change', { bubbles: true }));
    });
    await select('ETH-USDT-SWAP');
    expect(unit()?.value).toBe('quote');
  });

  it('shows the fetch error and keeps the Refresh button', async () => {
    signals.mockRejectedValue(new Error('boom'));
    const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    await act(async () => {
      root.render(
        <QueryClientProvider client={qc}>
          <SignalsPanel />
        </QueryClientProvider>,
      );
    });
    await flush(container, 'boom');
    expect(container.textContent).toContain('Signals unavailable');
    expect(container.querySelector('button')?.textContent).toBe('Refresh');
    expect(container.querySelector('.signals-bar')).toBeNull();
  });
});
