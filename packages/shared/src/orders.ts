import { D } from './decimal.js';
import type { Order } from './types.js';

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
