import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import type { TraderView } from '@pegasus/shared';
import { useLangStore } from '../i18n';
import { en } from '../i18n/en';
import { api } from '../lib/api';
import { NOW } from '../test/campaign-fixtures';
import { disabledTraderView, enabledView, traderLog } from '../test/trader-fixtures';
import { TraderPanel } from './TraderPanel';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

vi.mock('../lib/api', async (importOriginal) => {
  const mod = await importOriginal<typeof import('../lib/api')>();
  return { ...mod, api: { trader: vi.fn(), traderLog: vi.fn() } };
});

async function flush(container: HTMLElement, needle: string): Promise<void> {
  for (let i = 0; i < 50; i++) {
    if ((container.textContent ?? '').includes(needle)) return;
    await act(async () => {
      await new Promise((r) => setTimeout(r, 5));
    });
  }
  throw new Error(`timeout waiting for "${needle}"`);
}

describe('TraderPanel', () => {
  let root: Root;
  let container: HTMLDivElement;

  beforeEach(() => {
    vi.useFakeTimers({ toFake: ['Date'], now: NOW });
    vi.mocked(api.traderLog).mockResolvedValue({ records: traderLog });
    container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);
  });

  afterEach(async () => {
    await act(async () => root.unmount());
    container.remove();
    useLangStore.setState({ lang: 'en' });
    vi.useRealTimers();
  });

  const render = async (view: TraderView, needle: string) => {
    vi.mocked(api.trader).mockResolvedValue(view);
    const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    await act(async () => {
      root.render(
        <QueryClientProvider client={qc}>
          <TraderPanel />
        </QueryClientProvider>,
      );
    });
    await flush(container, needle);
  };

  it('an enabled view: status, last decision, position, today, control, results and the log', async () => {
    await render(enabledView, en.trader.statusLabel.holding);
    await flush(container, 'model timed out');
    const text = container.textContent ?? '';
    expect(text).toContain('claude-sonnet-5-5');
    expect(text).toContain('Long the retest of the VWAP');
    expect(text).toContain('EMA 5 > 10 > 21 on 1H');
    expect(text).toContain(en.trader.executed);
    expect(text).toContain('65%');
    expect(text).toContain('hourly close, VWAP retest');
    expect(container.querySelector('.trader-position')?.textContent).toContain('82,000');
    expect(container.querySelector('.trader-today')?.textContent).toContain('2026-10-05');
    expect(container.querySelector('.trader-control')?.textContent).toContain(en.trader.controlNote);
    expect(container.querySelectorAll('.trader-recent tbody tr')).toHaveLength(1);
    expect(container.querySelectorAll('.trader-log tbody tr')).toHaveLength(2);
  });

  it('the log shows the one-liner, expands to the reasons, and the status shows the wake levels and releases', async () => {
    await render(enabledView, en.trader.statusLabel.holding);
    await flush(container, 'model timed out');
    const log = container.querySelector('.trader-log') as HTMLElement;
    expect(log.textContent).toContain('Waiting for the CPI print');
    expect(log.textContent).not.toContain('Volume is thin');
    const toggle = log.querySelector('button[aria-expanded]') as HTMLButtonElement;
    expect(toggle.getAttribute('aria-expanded')).toBe('false');
    await act(async () => toggle.click());
    expect(toggle.getAttribute('aria-expanded')).toBe('true');
    expect(log.textContent).toContain('Volume is thin before the release');
    expect(log.textContent).toContain('A break of 83,000 on volume');
    expect(log.textContent).toContain('hourly close');
    expect(log.textContent).toContain('earlier above 83,000');
    const status = container.querySelector('.trader-status')?.textContent ?? '';
    expect(status).toContain('above 83,000');
    expect(status).toContain('below 81,200');
    expect(status).toContain(en.trader.cadenceLabel.model);
    expect(container.querySelector('.trader-upcoming')?.textContent).toContain('CPI m/m');
  });

  it('a disabled view: only the note about the trader stack', async () => {
    await render(disabledTraderView, en.trader.disabledTitle);
    expect(container.textContent).toContain('pnpm start --trader');
    expect(container.textContent).toContain('5176');
    expect(container.querySelector('.trader-status')).toBeNull();
  });
});
