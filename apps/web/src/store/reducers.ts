import type { Candle, Fill, HelloPayload, Order, ServerMessage, Trade } from '@pegasus/shared';
import { LIMITS, emptyMarket, type MarketData, type TerminalState, type ToastKind } from './types';

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
    case 'balance':
      return { balance: msg.data };
    case 'risk':
      return { risk: msg.data };
    case 'connection':
      return { connection: msg.data };
    case 'subscribed':
      return {};
    case 'error':
      return pushToast(state, 'error', `${msg.data.code}: ${msg.data.message}`);
    case 'pong':
      return {};
  }
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

  return {
    helloSeq: state.helloSeq + 1,
    demo: data.demo,
    instruments: data.instruments,
    account: data.account,
    riskConfig: data.riskConfig,
    risk: data.risk,
    connection: data.connection,
    balance: data.balance,
    positions: data.positions,
    orders,
    serverTime: data.serverTime,
    selectedInstId,
    market,
  };
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
  if (!isTerminalOrder(order)) {
    return { orders: { ...state.orders, [order.ordId]: order } };
  }
  const orders: Record<string, Order> = {};
  for (const [id, o] of Object.entries(state.orders)) {
    if (id !== order.ordId) orders[id] = o;
  }
  return { orders, orderHistory: mergeOrderHistory(state.orderHistory, [order]) };
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

export function pushToast(state: TerminalState, kind: ToastKind, message: string): Partial<TerminalState> {
  const toast = { id: state.nextToastId, kind, message, ts: Date.now() };
  return {
    toasts: [...state.toasts, toast].slice(-LIMITS.toasts),
    nextToastId: state.nextToastId + 1,
  };
}
