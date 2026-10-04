import { create } from 'zustand';
import type { AlgoOrderList, CandleBar, Fill, InstId, Instrument, Localized, Order, RiskState, ServerMessage } from '@pegasus/shared';
import { readStoredToken, writeStoredToken } from '../lib/http';
import type { WsStatus } from '../lib/ws';
import { applyAlgoOrders, applyOrderHistorySeed, applyRiskReply, applyServerMessage, applyWsStatus, mergeFills, pushToast, stampMessage } from './reducers';
import { emptyMarket, initialState, type MarketData, type TerminalState, type TicketPrefillInput, type ToastKind } from './types';

export interface TerminalActions {
  setToken: (token: string | null) => void;
  applyMessage: (msg: ServerMessage) => void;
  /** Applies the risk state returned by an HTTP call (the kill-switch toggle). */
  applyRiskReply: (risk: RiskState) => void;
  /** Applies the algo order list returned by an HTTP call (the Refresh of the Stops tab). */
  applyAlgoOrders: (list: AlgoOrderList) => void;
  setWsStatus: (status: WsStatus) => void;
  selectInstrument: (instId: InstId) => void;
  setBar: (bar: CandleBar) => void;
  /** A plain message is shown as it is; one given in both languages follows the language of the page. */
  pushToast: (kind: ToastKind, message: string | Localized) => void;
  dismissToast: (id: number) => void;
  seedOrderHistory: (orders: Order[]) => void;
  seedFills: (fills: Fill[]) => void;
  setTicketPrice: (px: string) => void;
  /** Selects the prefill's instrument and hands the whole ticket to the order form. */
  applyTicketPrefill: (prefill: TicketPrefillInput) => void;
  reset: () => void;
}

export type TerminalStore = TerminalState & TerminalActions;

export const useStore = create<TerminalStore>()((set, get) => ({
  ...initialState(readStoredToken()),

  setToken: (token) => {
    writeStoredToken(token);
    set({ token });
  },
  applyMessage: (msg) => set((s) => ({ ...applyServerMessage(s, msg), ...stampMessage(s, msg, Date.now()) })),
  applyRiskReply: (risk) => set(applyRiskReply(risk)),
  applyAlgoOrders: (list) => set((s) => applyAlgoOrders(s, list)),
  setWsStatus: (wsStatus) => set((s) => applyWsStatus(s, wsStatus, Date.now())),
  selectInstrument: (instId) => {
    if (get().selectedInstId === instId) return;
    set({ selectedInstId: instId, ticketPrice: null, ticketPrefill: null });
  },
  setBar: (bar) => {
    if (get().bar === bar) return;
    // candles are keyed by ts for one bar only: drop everything when the bar changes
    const market: Record<string, MarketData> = {};
    for (const [id, m] of Object.entries(get().market)) market[id] = { ...m, candles: {} };
    set({ bar, market });
  },
  pushToast: (kind, message) => set((s) => pushToast(s, kind, message)),
  dismissToast: (id) => set((s) => ({ toasts: s.toasts.filter((t) => t.id !== id) })),
  seedOrderHistory: (orders) => set((s) => applyOrderHistorySeed(s, orders, Date.now())),
  seedFills: (fills) => set((s) => ({ fills: mergeFills(s.fills, fills) })),
  setTicketPrice: (px) => set((s) => ({ ticketPrice: { px, nonce: (s.ticketPrice?.nonce ?? 0) + 1 } })),
  applyTicketPrefill: (prefill) =>
    set((s) => ({
      selectedInstId: prefill.instId,
      ticketPrice: null,
      ticketPrefill: { ...prefill, nonce: (s.ticketPrefill?.nonce ?? 0) + 1 },
    })),
  reset: () => set({ ...initialState(get().token) }),
}));

// ---- selectors ----

const EMPTY_MARKET = emptyMarket();

export const getSelectedInstrument = (s: TerminalState): Instrument | null =>
  s.instruments.find((i) => i.instId === s.selectedInstId) ?? null;

export const getSelectedMarket = (s: TerminalState): MarketData =>
  (s.selectedInstId !== null ? s.market[s.selectedInstId] : undefined) ?? EMPTY_MARKET;

export const getKillSwitch = (s: TerminalState): boolean => s.risk?.killSwitch ?? false;

/** Why nothing can be sent to the exchange from this terminal, in both languages. */
export type TradingBlock = Localized;

export const READ_ONLY_KEY_BLOCK: TradingBlock = { en: 'Read-only API key: trading from Pegasus is disabled', zh: '只读 key：无法从 Pegasus 下单' };
/** The position mode is unknown, so an order could be built for the wrong kind of account. */
export const ACCOUNT_NOT_LOADED_BLOCK: TradingBlock = { en: 'Account not loaded: trading from Pegasus is disabled', zh: '账户未加载：无法从 Pegasus 下单' };

export const getTradingBlock = (s: TerminalState): TradingBlock | null =>
  s.account === null ? ACCOUNT_NOT_LOADED_BLOCK : s.account.canTrade ? null : READ_ONLY_KEY_BLOCK;

