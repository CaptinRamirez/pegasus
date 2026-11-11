import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import type { BooksView, BookView } from '@pegasus/shared';
import type { LineChartSeries } from '../hooks/useLineChart';
import { useLangStore } from '../i18n';
import { BooksBody } from './BooksPanel';
import { PlanBody } from './PlanPanel';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const charted: LineChartSeries[][] = [];
vi.mock('../hooks/useLineChart', () => ({
  useLineChart: (_container: unknown, series: LineChartSeries[]) => {
    charted.push(series);
  },
}));

const NOW = Date.UTC(2026, 10, 10, 18, 0);
const book = (key: BookView['key'], equity: string, positions: BookView['positions'] = []): BookView => ({
  key,
  startedAt: NOW - 3_600_000,
  start: '10000',
  equity,
  cash: '10000.00',
  returnPct: (((Number(equity) - 10000) / 10000) * 100).toFixed(2),
  maxDrawdownPct: '-0.40',
  positions,
  curve: [[NOW - 3_600_000, '10000'], [NOW, equity]],
  events: [{ ts: NOW - 3_600_000, kind: 'decision', coin: null, amount: null, text: `${key} read the day` }],
});
const spot = (coin: string, qty: string, entryPx: string, value: string): BookView['positions'][number] => ({ coin, openedAt: NOW - 3_600_000, legs: [{ kind: 'spot', instId: `${coin}-USDT`, qty, entryPx }], funding: '0', interest: '0', fees: '4.25', value });
const flat: BooksView = {
  enabled: true,
  status: 'running',
  error: null,
  books: [book('regime', '9705.66'), book('plan', '10000.00'), book('planHold', '9980.00', [spot('BTC', '0.0682', '73200.1', '4990.00'), spot('ETH', '2.44', '2046.1', '4990.00')])],
  regime: { ts: NOW, bull: false, close: '75361.9', sma200: '73209.1', sma50w: '75535.4' },
  plan: { ts: NOW, vol: '0.4321', target: '0.0000', targetIfBull: '1.0000', exposure: '0.0000' },
  nextDecisionAt: NOW + 6 * 3_600_000 + 5 * 60_000,
  serverTime: NOW,
};

describe('PlanBody', () => {
  let root: Root;
  let container: HTMLDivElement;
  beforeEach(() => {
    vi.useFakeTimers({ toFake: ['Date'], now: NOW });
    useLangStore.setState({ lang: 'en' });
    charted.length = 0;
    container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);
  });
  afterEach(() => {
    act(() => root.unmount());
    container.remove();
    vi.useRealTimers();
  });

  it('not bull: says it waits in USDT, the line the close must clear and what it would then buy; charts the plan against its control', () => {
    act(() => root.render(<PlanBody view={flat} />));
    const text = container.textContent ?? '';
    expect(container.querySelector('.campaign-badge')?.textContent).toBe('Not bull');
    // the higher of the two lines is the 50-week average, 0.2% above the last close
    expect(text).toContain('all in USDT, waiting');
    expect(text).toContain('above 75,535.4 (0.2% from the last close)');
    expect(text).toContain('100% of the book in all');
    for (const s of ['The plan', 'Control: half each, held', 'Dial 45% (this book)', 'Ladder, no stop', 'The rules', 'plan read the day']) expect(text).toContain(s);
    // the dial, the volatility read and the replay's figures
    expect(text).toContain('45%');
    expect(text).toContain('43%');
    expect(text).toContain('+35.9%');
    expect(text).toContain('-44.8%');
    expect(charted.at(-1)?.map((s) => s.id)).toEqual(['plan', 'planHold']);
    // the control's coins are listed; the regime book belongs to the other tab
    expect(text).toContain('ETH-USDT');
    expect(text).not.toContain('regime read the day');
  });

  it('bull: says the target, the volatility and what is held at the market, and the close that sells everything', () => {
    const held = [spot('BTC', '0.0565', '75600.0', '4300.00'), spot('ETH', '2.05', '2100.0', '4200.00')];
    const view: BooksView = { ...flat, books: [book('plan', '10000.00', held), flat.books[2] as BookView], regime: { ts: NOW, bull: true, close: '79000.0', sma200: '73209.1', sma50w: '75535.4' }, plan: { ts: NOW, vol: '0.5294', target: '0.8500', targetIfBull: '0.8500', exposure: '0.0000' } };
    act(() => root.render(<PlanBody view={view} />));
    const text = container.textContent ?? '';
    expect(container.querySelector('.campaign-badge')?.textContent).toBe('Bull');
    expect(text).toContain('the target is 85% of the book (30-day volatility 53%), 85% is held');
    expect(text).toContain('falls under 75,535.4');
  });

  it('in Chinese, and where the books do not run; the strategies tab keeps its own books', () => {
    useLangStore.setState({ lang: 'zh' });
    act(() => root.render(<PlanBody view={flat} />));
    expect(container.textContent).toContain('现在不是牛市：全部是 USDT，等着');
    expect(container.textContent).toContain('油门 45%（这本账）');
    act(() => root.render(<PlanBody view={{ ...flat, enabled: false, status: 'disabled', books: [], regime: null, plan: null, nextDecisionAt: null }} />));
    expect(container.textContent).toContain('本栈不运行纸面账');
    act(() => root.render(<BooksBody view={flat} />));
    expect(charted.at(-1)?.map((s) => s.id)).toEqual(['regime']);
  });
});
