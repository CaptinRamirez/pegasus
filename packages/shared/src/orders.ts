import { D, ZERO } from './decimal.js';
import type { AlgoOrder, Order, Position } from './types.js';

/**
 * The stop-loss attached to this order does not exist yet. OKX generates an attached stop only once its parent
 * order is completely filled, so while the order is partially filled and still open, the filled part is a
 * position without a stop.
 */
export function stopAwaitsFullFill(order: Order): boolean {
  return order.slTriggerPx !== undefined && order.state === 'partially_filled';
}

/**
 * The order carried a stop-loss and ended cancelled after a partial fill. OKX documents only that a parent
 * cancelled before any fill generates no stop; whether it generates one for the filled part is not stated, so
 * the filled part may have no stop and must be checked on the exchange.
 */
export function stopUnconfirmedAfterCancel(order: Order): boolean {
  return order.slTriggerPx !== undefined && order.state === 'canceled' && D(order.accFillSz || '0').gt(0);
}

/** Whether the position is long or short; null for a flat one. In net mode the sign of `pos` decides. */
export function positionDirection(p: Pick<Position, 'posSide' | 'pos'>): 'long' | 'short' | null {
  const pos = D(p.pos || '0');
  if (pos.isZero()) return null;
  if (p.posSide === 'long' || p.posSide === 'short') return p.posSide;
  return pos.gt(0) ? 'long' : 'short';
}

/** Whether the algo order closes this position when it triggers: same instrument, margin mode and leg, on the closing side. */
export function algoOrderClosesPosition(a: AlgoOrder, p: Position): boolean {
  const direction = positionDirection(p);
  if (direction === null || a.instId !== p.instId || a.tdMode !== p.mgnMode || a.posSide !== p.posSide) return false;
  return a.side === (direction === 'long' ? 'sell' : 'buy');
}

/** The stop-losses resting at the exchange for this position (take-profit only orders are not stops). */
export function stopsOfPosition(p: Position, algoOrders: readonly AlgoOrder[]): AlgoOrder[] {
  return algoOrders.filter((a) => a.slTriggerPx !== '' && algoOrderClosesPosition(a, p));
}

/**
 * How much of a position its stops cover. none: no stop at all; partial: the stops close fewer contracts than
 * the position holds; full: exactly the position (or a stop that closes the whole position whatever its size);
 * over: the stops add up to more contracts than the position holds, as when a lot was closed by hand and its
 * stop was left resting.
 */
export type StopCoverageState = 'none' | 'partial' | 'full' | 'over';

export interface StopCoverage {
  state: StopCoverageState;
  stops: AlgoOrder[];
  /** Contracts the stops close in total; a stop that closes a fraction of the position counts that fraction of it */
  covered: string;
  /** Size of the position in contracts (absolute) */
  size: string;
}

export function stopCoverage(p: Position, algoOrders: readonly AlgoOrder[]): StopCoverage {
  const size = D(p.pos || '0').abs();
  const stops = stopsOfPosition(p, algoOrders);
  let covered = ZERO;
  for (const s of stops) covered = covered.plus(s.closeFraction !== '' ? size.times(s.closeFraction) : D(s.sz || '0'));
  const state: StopCoverageState = stops.length === 0 || covered.lte(0) ? 'none' : covered.lt(size) ? 'partial' : covered.eq(size) ? 'full' : 'over';
  return { state, stops, covered: covered.toFixed(), size: size.toFixed() };
}
