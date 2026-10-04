import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { useStore } from '../store/store';
import { initialState } from '../store/types';
import { Toasts } from './Toasts';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

describe('Toasts', () => {
  let root: Root;
  let container: HTMLDivElement;

  beforeEach(() => {
    vi.useFakeTimers();
    useStore.setState({ ...initialState('tok') });
    container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);
  });

  afterEach(async () => {
    await act(async () => root.unmount());
    container.remove();
    useStore.setState({ ...initialState(null) });
    vi.useRealTimers();
  });

  it('info and success toasts leave after 6 s; an error stays until it is clicked away', async () => {
    await act(async () => root.render(<Toasts />));
    await act(async () => {
      useStore.getState().pushToast('info', 'Cancel requested for o1');
      useStore.getState().pushToast('error', 'Close failed: EXCHANGE_UNREACHABLE: timeout');
      useStore.getState().pushToast('success', 'Leverage set to 3x');
    });
    const shown = (): string[] => [...container.querySelectorAll('.toast')].map((t) => t.textContent ?? '');
    expect(shown()).toHaveLength(3);
    await act(async () => {
      vi.advanceTimersByTime(5_900);
    });
    expect(shown()).toHaveLength(3);
    await act(async () => {
      vi.advanceTimersByTime(60_000);
    });
    expect(shown()).toEqual(['Close failed: EXCHANGE_UNREACHABLE: timeout']);
    await act(async () => {
      container.querySelector('.toast')?.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    });
    expect(shown()).toEqual([]);
  });
});
