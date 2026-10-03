import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { DEFAULT_TREND_PARAMS, type Instrument, type InstrumentSignalReport } from '@pegasus/shared';
import { api, type SignalsResponse } from '../lib/api';
import { useStore } from '../store/store';
import { initialState } from '../store/types';
import { OrderTicket } from './OrderTicket';
import { SignalsPanel } from './SignalsPanel';

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

const report: InstrumentSignalReport = {
  instId: 'BTC-USDT-SWAP',
  indicators: {
    asOf: 1_700_000_000_000,
    bars: 299,
    close: '61000',
    ma: '55000',
    atr: '1500',
    atrPct: '0.02459',
    entryHigh: '60500',
    entryLow: '48000',
    exitHigh: '60200',
    exitLow: '52000',
    efficiencyRatio: '0.4123',
    volShort: '0.52',
    volLong: '0.48',
    volRatio: '1.0833',
    dailyReturn: '0.01',
    dailySigma: '0.027',
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
  sizing: {
    entryPx: '61000',
    stopLong: '57250',
    stopShort: '64750',
    stopDistancePct: '0.0614',
    rawNotional: '12195.12',
    notional: '10000.00',
    capped: true,
    contracts: '16',
    coin: '0.16',
    riskQuote: '599.67',
    minUnitRiskQuote: '37.48',
    note: 'notional capped at 10% of equity; actual risk below 0.75%',
  },
  structure: {
    book: { spreadPct: '0.00003', bidNotional: '1234567.00', askNotional: '912345.00', imbalance: '0.1201', levels: 20, ts: 1_700_000_000_000 },
    openInterest: { current: '4210000000', unit: 'usd', change1d: '0.012', change10d: '0.083', percentile30d: '0.867', points: 30 },
  },
  params: DEFAULT_TREND_PARAMS,
};

/** Cells of the first signal row: 10 = Book, 11 = OI (after instrument, regime, close, MA, ATR, entry, exit, ER, vol ratio, funding). */
const BOOK_CELL = 10;
const OI_CELL = 11;
const rowCells = (container: HTMLElement): HTMLTableCellElement[] => [...container.querySelectorAll<HTMLTableCellElement>('tr.signal-row td')];

const response: SignalsResponse = {
  generatedAt: 1_700_000_000_000,
  equity: '100000',
  reports: [report, { instId: 'ETH-USDT-SWAP', error: { code: 'NOT_ENOUGH_DATA', message: 'need at least 101 confirmed daily bars, got 40' } }],
};

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
    signals.mockReset();
    signals.mockResolvedValue(response);
    useStore.setState({
      ...initialState('tok'),
      instruments: [btc],
      account: { posMode: 'net_mode', acctLv: '2' },
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
  });

  const render = async (withTicket = false) => {
    const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    await act(async () => {
      root.render(
        <QueryClientProvider client={qc}>
          <SignalsPanel />
          {withTicket && <OrderTicket />}
        </QueryClientProvider>,
      );
    });
    await flush(container, 'LONG ENTRY');
  };

  it('renders regime and signal badges, formatted indicators and the error row', async () => {
    await render();
    expect(signals).toHaveBeenCalledWith({ equity: '10123.45' });

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

  it('expands a row to show the reasons verbatim and the sizing note', async () => {
    await render();
    expect(container.querySelector('.signal-reasons')).toBeNull();
    await click(container.querySelector('tr.signal-row'));
    const reasons = container.querySelector('.signal-reasons');
    expect(reasons?.textContent).toBe('close 61000 vs 55d high 60500: breakout up\nregime trend: new entries allowed');
    expect(container.querySelector('.signal-note:not(.signal-structure)')?.textContent).toContain(report.sizing?.note);
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
      openInterest: { current: '1234567', unit: 'contracts', change1d: '', change10d: '-0.0712', percentile30d: '', points: 12 },
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
      nonce: 1,
    });
    // the row click must not have toggled the details
    expect(container.querySelector('.signal-reasons')).toBeNull();

    // price and size inputs come before the leverage control's input
    const inputs = [...container.querySelectorAll<HTMLInputElement>('.form input.num')].map((i) => i.value);
    expect(inputs.slice(0, 2)).toEqual(['61000', '16']);
    const unit = container.querySelector<HTMLSelectElement>('.input-group select');
    expect(unit?.value).toBe('contracts');
    expect(container.querySelector('.btn-group .btn.active.buy')).not.toBeNull();
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
  });
});
