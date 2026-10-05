import { stopUnconfirmedAfterCancel, type AlgoOrderList, type CampaignView, type Candle, type Fill, type HelloPayload, type Localized, type Order, type RiskState, type ServerMessage, type Trade } from '@pegasus/shared';
import type { WsStatus } from '../lib/ws';
import { LIMITS, emptyMarket, type MarketData, type TerminalState, type Toast, type ToastKind } from './types';

/**
 * Pure reducers: each returns the slice of state that changes for a server
 * message. No React, no side effects, so they are trivially unit-testable.
 */
export function applyServerMessage(state: TerminalState, msg: ServerMessage): Partial<TerminalState> {
  switch (msg.type) {
    case 'hello':
      return applyHello(state, msg.data);
    case 'ticker':
      return updateMarket(state, msg.data.instId, (m) => ({ ...m, ticker: msg.data }));
    case 'book':
      return updateMarket(state, msg.data.instId, (m) => ({ ...m, book: msg.data }));
    case 'trades':
      return applyTrades(state, msg.data);
    case 'candle':
      if (msg.data.bar !== state.bar) return {};
      return updateMarket(state, msg.data.instId, (m) => ({ ...m, candles: upsertCandle(m.candles, msg.data.candle) }));
    case 'markPrice':
      return updateMarket(state, msg.data.instId, (m) => ({ ...m, markPrice: msg.data }));
    case 'fundingRate':
      return updateMarket(state, msg.data.instId, (m) => ({ ...m, fundingRate: msg.data }));
    case 'order':
      return applyOrder(state, msg.data);
    case 'fill':
      return { fills: mergeFills(state.fills, [msg.data]) };
    case 'positions':
      return { positions: msg.data };
    case 'algoOrders':
      return applyAlgoOrders(state, msg.data);
    case 'balance':
      return { balance: msg.data };
    case 'account':
      return { account: msg.data };
    case 'risk':
      return { risk: msg.data };
    case 'connection':
      return { connection: msg.data, accountLoaded: state.accountLoaded || msg.data.account.lastSyncAt !== null };
    case 'subscribed':
      return {};
    case 'error':
      return pushToast(state, 'error', `${msg.data.code}: ${msg.data.message}`);
    case 'campaign':
      return applyCampaign(state, msg.data);
    case 'pong':
      return {};
  }
}

/**
 * The campaign's state, from the socket (the `campaign` message) or from the reply of GET /api/campaign: an older
 * view never replaces a newer one (the reply of a slow request after a push), as the server's time tells. A hello
 * keeps the view: the server sends its own right after it, and a server whose campaign was switched off is read
 * again over HTTP.
 */
export function applyCampaign(state: TerminalState, view: CampaignView): Partial<TerminalState> {
  return state.campaign !== null && state.campaign.serverTime > view.serverTime ? {} : { campaign: view };
}

/** Receive times kept next to the message's own changes: every message proves the server is alive. */
export function stampMessage(state: TerminalState, msg: ServerMessage, now: number): Partial<TerminalState> {
  if (msg.type !== 'hello' && msg.type !== 'connection') return { lastMessageAt: now };
  const connection = msg.type === 'hello' ? msg.data.connection : msg.data;
  const privateDownSince = connection.okxPrivate === 'connected' ? null : (state.privateDownSince ?? now);
  return { lastMessageAt: now, connectionAt: now, privateDownSince };
}

/**
 * A risk state that came back from an HTTP call. Not routed through applyServerMessage: only messages
 * from the socket may move lastMessageAt, the time the disconnect banner quotes.
 */
export function applyRiskReply(risk: RiskState): Partial<TerminalState> {
  return { risk };
}

/**
 * The socket to the server changed state. While it is not open nothing the server said about its exchange
 * connections is known to hold, so that status is dropped instead of being shown as current.
 */
export function applyWsStatus(state: TerminalState, status: WsStatus, now: number): Partial<TerminalState> {
  if (status === 'open') return { wsStatus: status, wsDownSince: null };
  return { wsStatus: status, connection: null, connectionAt: null, privateDownSince: null, wsDownSince: state.wsDownSince ?? now };
}

export function applyHello(state: TerminalState, data: HelloPayload): Partial<TerminalState> {
  const orders: Record<string, Order> = {};
  for (const o of data.openOrders) orders[o.ordId] = o;

  const market: Record<string, MarketData> = { ...state.market };
  for (const inst of data.instruments) {
    if (market[inst.instId] === undefined) market[inst.instId] = emptyMarket();
  }

  const stillTracked =
    state.selectedInstId !== null && data.instruments.some((i) => i.instId === state.selectedInstId);
  const selectedInstId = stillTracked ? state.selectedInstId : (data.instruments[0]?.instId ?? null);

  // an open order whose stop was not created is as urgent after a reload or a reconnect as on its push
  // (an order cancelled after a partial fill is not open: the history seed tells that one)
  let notices: Partial<TerminalState> = {};
  for (const o of data.openOrders) notices = { ...notices, ...noteLostStop({ ...state, ...notices }, o) };

  return {
    ...notices,
    helloSeq: state.helloSeq + 1,
    demo: data.demo,
    paper: data.paper,
    instruments: data.instruments,
    account: data.account,
    riskConfig: data.riskConfig,
    risk: data.risk,
    connection: data.connection,
    balance: data.balance,
    // hello replaces positions, orders and balance wholesale, so it also decides whether they are loaded
    accountLoaded: data.connection.account.lastSyncAt !== null,
    positions: data.positions,
    // like positions and orders, replaced wholesale: after a server restart null says "not read yet"
    algoOrders: data.algoOrders,
    orders,
    serverTime: data.serverTime,
    selectedInstId,
    market,
  };
}

/** A list of the algo orders, from the socket or from the reply of a read asked over HTTP: an older read never replaces a newer one. */
export function applyAlgoOrders(state: TerminalState, list: AlgoOrderList): Partial<TerminalState> {
  return state.algoOrders !== null && state.algoOrders.ts > list.ts ? {} : { algoOrders: list };
}

export function updateMarket(
  state: TerminalState,
  instId: string,
  fn: (m: MarketData) => MarketData,
): Partial<TerminalState> {
  const current = state.market[instId] ?? emptyMarket();
  return { market: { ...state.market, [instId]: fn(current) } };
}

function applyTrades(state: TerminalState, incoming: Trade[]): Partial<TerminalState> {
  const first = incoming[0];
  if (first === undefined) return {};
  const sorted = [...incoming].sort((a, b) => b.ts - a.ts);
  return updateMarket(state, first.instId, (m) => {
    const seen = new Set(sorted.map((t) => t.tradeId));
    const kept = m.trades.filter((t) => !seen.has(t.tradeId));
    return { ...m, trades: [...sorted, ...kept].slice(0, LIMITS.trades) };
  });
}

export function upsertCandle(candles: Record<number, Candle>, candle: Candle): Record<number, Candle> {
  const next: Record<number, Candle> = { ...candles, [candle.ts]: candle };
  const keys = Object.keys(next);
  if (keys.length <= LIMITS.candles) return next;
  const sorted = keys.map(Number).sort((a, b) => a - b);
  const trimmed: Record<number, Candle> = {};
  for (const ts of sorted.slice(sorted.length - LIMITS.candles)) {
    const c = next[ts];
    if (c !== undefined) trimmed[ts] = c;
  }
  return trimmed;
}

export function isTerminalOrder(o: Order): boolean {
  return o.state === 'filled' || o.state === 'canceled';
}

export function applyOrder(state: TerminalState, order: Order): Partial<TerminalState> {
  const notice = noteLostStop(state, order);
  if (!isTerminalOrder(order)) {
    return { ...notice, orders: { ...state.orders, [order.ordId]: order } };
  }
  const orders: Record<string, Order> = {};
  for (const [id, o] of Object.entries(state.orders)) {
    if (id !== order.ordId) orders[id] = o;
  }
  return { ...notice, orders, orderHistory: mergeOrderHistory(state.orderHistory, [order]) };
}

/**
 * The error toast for an order whose position may have no stop-loss: the exchange did not create the stop
 * attached to it (Order.slFailReason), or the order was cancelled after a partial fill, where OKX does not say
 * whether the filled part gets its stop (stopUnconfirmedAfterCancel). An error toast stays until it is clicked
 * away, and this one is sticky: later toasts do not push it out. Every push of the order repeats the
 * condition, so the order is remembered and told once, for whichever of the two comes first.
 */
export function noteLostStop(state: TerminalState, order: Order): Partial<TerminalState> {
  if (state.lostStopNotified.includes(order.ordId)) return {};
  let en: string;
  let zh: string;
  if (order.slFailReason !== undefined) {
    en = `STOP-LOSS NOT CREATED: ${order.instId} order ${order.ordId} (${order.side} ${order.sz} contracts). The exchange did NOT create the stop attached to it (${order.slFailReason}): the position has no stop. Place the stop on OKX now.`;
    zh = `止损单未创建：${order.instId} 订单 ${order.ordId}（${order.side === 'buy' ? '买入' : '卖出'} ${order.sz} 张）。交易所没有创建它附带的止损（${order.slFailReason}）：该仓位没有止损，请立即在 OKX 上设置止损。`;
  } else if (stopUnconfirmedAfterCancel(order)) {
    en = `STOP-LOSS MAY BE MISSING: ${order.instId} order ${order.ordId} (${order.side}) was cancelled after filling ${order.accFillSz} of ${order.sz} contracts. OKX creates the attached stop only when an order is completely filled: the filled part may have no stop. Check the Stops tab now and place the stop on OKX by hand if it is missing.`;
    zh = `止损单可能缺失：${order.instId} 订单 ${order.ordId}（${order.side === 'buy' ? '买入' : '卖出'}）在成交 ${order.accFillSz}/${order.sz} 张后被撤销。OKX 只在订单完全成交后才创建附带的止损：已成交部分可能没有止损。请立即在“止损单”标签页核对，缺失则在 OKX 上手动补上。`;
  } else {
    return {};
  }
  return {
    ...pushToast(state, 'error', { en, zh }, true),
    lostStopNotified: [...state.lostStopNotified, order.ordId].slice(-LIMITS.lostStopNotified),
  };
}

/** How far back an order of the REST history still raises the lost-stop notice: older ones were dealt with long ago. */
export const LOST_STOP_RECENT_MS = 24 * 60 * 60 * 1000;

/**
 * Order history loaded over REST (page load, and again after every reconnect). An order that was filled or
 * canceled while the page was not listening never arrives as a push and is not among hello's open orders, so
 * a recent one whose stop was not created, or may be missing after a cancel, is told here.
 */
export function applyOrderHistorySeed(state: TerminalState, incoming: Order[], now: number): Partial<TerminalState> {
  let notices: Partial<TerminalState> = {};
  for (const o of incoming) {
    if (o.uTime >= now - LOST_STOP_RECENT_MS) notices = { ...notices, ...noteLostStop({ ...state, ...notices }, o) };
  }
  return { ...notices, orderHistory: mergeOrderHistory(state.orderHistory, incoming) };
}

/** Merges terminal orders into the history list (newest first, deduped by ordId, capped). */
export function mergeOrderHistory(history: Order[], incoming: Order[]): Order[] {
  const byId = new Map<string, Order>();
  for (const o of history) byId.set(o.ordId, o);
  for (const o of incoming) {
    const prev = byId.get(o.ordId);
    if (prev === undefined || o.uTime >= prev.uTime) byId.set(o.ordId, o);
  }
  return [...byId.values()].sort((a, b) => b.uTime - a.uTime).slice(0, LIMITS.orderHistory);
}

/** Merges fills (newest first, deduped by tradeId+ordId, capped). */
export function mergeFills(fills: Fill[], incoming: Fill[]): Fill[] {
  const key = (f: Fill): string => `${f.ordId}:${f.tradeId}`;
  const byKey = new Map<string, Fill>();
  for (const f of fills) byKey.set(key(f), f);
  for (const f of incoming) byKey.set(key(f), f);
  return [...byKey.values()].sort((a, b) => b.ts - a.ts).slice(0, LIMITS.fills);
}

/**
 * Appends a toast and keeps the newest LIMITS.toasts of those that may be dropped. A sticky toast (the
 * lost-stop notice) is outside the cap: it leaves only when the trader clicks it away. A message given in
 * both languages is kept in both, so the toast follows a later switch of the language.
 */
export function pushToast(state: TerminalState, kind: ToastKind, message: string | Localized, sticky = false): Partial<TerminalState> {
  const toast: Toast = { id: state.nextToastId, kind, message: typeof message === 'string' ? message : message.en, ts: Date.now() };
  if (typeof message !== 'string') toast.zh = message.zh;
  if (sticky) toast.sticky = true;
  const all = [...state.toasts, toast];
  const droppable = all.filter((t) => t.sticky !== true);
  const dropped = new Set(droppable.slice(0, Math.max(0, droppable.length - LIMITS.toasts)).map((t) => t.id));
  return {
    toasts: all.filter((t) => !dropped.has(t.id)),
    nextToastId: state.nextToastId + 1,
  };
}
