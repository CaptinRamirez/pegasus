import { create } from 'zustand';

/** The tabs under the chart. */
export type Tab = 'campaign' | 'signals' | 'journal' | 'positions' | 'orders' | 'stops' | 'history' | 'fills';

/** A request to show the trade journal: one trade's drawer, or the trades of one coin. */
export interface JournalFocus {
  /** The trade whose drawer opens; null opens none */
  tradeId: string | null;
  /** The coin filter the journal is set to; null leaves it */
  instId: string | null;
  /** Changes on every request so the same one can be made again */
  nonce: number;
}

interface UiState {
  /** The tab the trader picked, or a link opened; null until then, when the page's default applies */
  tab: Tab | null;
  /** The coin shown in the signals tab; null for the first of the list */
  signalsCoin: string | null;
  journalFocus: JournalFocus | null;
  setTab: (tab: Tab) => void;
  setSignalsCoin: (instId: string) => void;
  /** Switches to the journal tab and opens the trade, or filters the journal to the coin. */
  showJournal: (focus: Omit<JournalFocus, 'nonce'>) => void;
}

/**
 * Where the page is: kept apart from the terminal store, which mirrors the server. Links between the tabs (a toast
 * that opens the journal, a signal that opens the ticket) go through it.
 */
export const useUi = create<UiState>()((set) => ({
  tab: null,
  signalsCoin: null,
  journalFocus: null,
  setTab: (tab) => set({ tab }),
  setSignalsCoin: (signalsCoin) => set({ signalsCoin }),
  showJournal: (focus) => set((s) => ({ tab: 'journal', journalFocus: { ...focus, nonce: (s.journalFocus?.nonce ?? 0) + 1 } })),
}));

/** Back to a page that was just opened (tests, sign-out). */
export function resetUi(): void {
  useUi.setState({ tab: null, signalsCoin: null, journalFocus: null });
}
