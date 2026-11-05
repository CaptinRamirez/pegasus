import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import type { BooksView } from '@pegasus/shared';
import type { LineChartSeries } from '../hooks/useLineChart';
import { useLangStore } from '../i18n';
import { BooksBody } from './BooksPanel';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const charted: LineChartSeries[][] = [];
vi.mock('../hooks/useLineChart', () => ({
  useLineChart: (_container: unknown, series: LineChartSeries[]) => {
    charted.push(series);
  },
}));

const NOW = Date.UTC(2026, 10, 5, 12, 0);
const book = (key: 'regime' | 'hold' | 'carryPos' | 'carryNeg', equity: string) => ({
  key,
  startedAt: NOW - 3_600_000,
  start: '10000',
  equity,
  cash: '9995.00',
  returnPct: (((Number(equity) - 10000) / 10000) * 100).toFixed(2),
  maxDrawdownPct: '-0.40',
  positions:
    key === 'carryNeg'
      ? [{ coin: 'HUMA', openedAt: NOW - 3_600_000, legs: [{ kind: 'perp' as const, instId: 'HUMA-USDT-SWAP', qty: '129533.67', entryPx: '0.01544' }, { kind: 'spot' as const, instId: 'HUMA-USDT', qty: '-129533.67', entryPx: '0.01565' }], funding: '12.5', interest: '0.8', fees: '4.0', value: '-2034.97' }]
      : [],
  curve: [[NOW - 3_600_000, '10000'], [NOW, equity]] as Array<[number, string]>,
  events: [{ ts: NOW - 3_600_000, kind: 'open' as const, coin: 'BTC', amount: '-5', text: `${key} opened` }],
});
const view: BooksView = {
  enabled: true,
  status: 'running',
  error: null,
  books: [book('regime', '10010'), book('hold', '10010'), book('carryPos', '9990'), book('carryNeg', '10005')],
  regime: { ts: NOW, bull: true, close: '80466.1', sma200: '73197.5', sma50w: '75739.4' },
  nextDecisionAt: NOW + 12 * 3_600_000,
  serverTime: NOW,
};

describe('BooksBody', () => {
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

  it('shows the four books, the regime reading, one curve per book, the positions and the ledger', () => {
    act(() => root.render(<BooksBody view={view} />));
    const text = container.textContent ?? '';
    for (const name of ['Two lines', 'Buy and hold', 'Positive funding', 'Negative funding']) expect(text).toContain(name);
    expect(text).toContain('bull. BTC daily close 80,466.1');
    expect(text).toContain('HUMA-USDT-SWAP');
    expect(text).toContain('regime opened');
    expect(charted.at(-1)?.map((s) => s.id)).toEqual(['regime', 'hold', 'carryPos', 'carryNeg']);
  });

  it('says where the books run when they do not run here, and in Chinese', () => {
    useLangStore.setState({ lang: 'zh' });
    act(() => root.render(<BooksBody view={{ ...view, enabled: false, status: 'disabled', books: [], regime: null, nextDecisionAt: null }} />));
    expect(container.textContent).toContain('本栈不运行纸面账');
  });
});
