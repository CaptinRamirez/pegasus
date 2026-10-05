import type { Dec, Engine } from '@pegasus/mock-okx/engine';
import { BAR_MS, planSegments, type Bar, type BarSize, type BarSource } from './bars.js';

export interface ReplayResult {
  /** Bars the span was replayed with; 0 when there was nothing to replay */
  bars: number;
  /** Resting orders filled */
  filled: number;
  /** Stops that closed (part of) a position */
  stopped: number;
  /** Isolated positions liquidated */
  liquidated: number;
  /**
   * The lowest and the highest mark price since the positions of the instrument last changed in the replay; null
   * when no bar was read. Funding of the span is settled after the replay, into the margin of an isolated position:
   * the caller holds this range against the liquidation price the settlement leaves (PaperExchange.retest).
   */
  markRange: { low: Dec; high: Dec } | null;
}

/**
 * Replays a time span the exchange did not watch (the program was closed, or the feed was down) for one
 * instrument, from candles:
 *
 * - An isolated position is liquidated in the first bar whose mark price low (a long) or high (a short) reached
 *   its liquidation price. This is tested before anything else in the bar, and again after the bar's fills for a
 *   position they opened or added to: a bar cannot tell whether its extreme came before or after a stop or a
 *   resting order of the same bar, and the worse is taken. The whole margin is lost, as in a liquidation that was
 *   watched; the bar's range says nothing more than that the price was reached.
 * - A resting limit order fills in full at its price in the first bar that traded THROUGH it (low below a buy,
 *   high above a sell). A bar that only touched the price fills nothing: the order may not have been reached in
 *   the queue. Neither does the bar the order was placed in: its extreme may be older than the order.
 * - A stop triggers in the first bar whose low (a stop that sells) or high (one that buys) reached its trigger,
 *   on mark price bars for a mark-triggered stop and on traded prices for a last-triggered one. It closes at
 *   the worse of the bar's open and the trigger: a bar that opened beyond the trigger is a gap. A stop created
 *   in that same bar (its entry filled there) closes at the trigger.
 * - Events are stamped with the end of their bar, never later than `to`.
 *
 * All candles are read before anything is applied: when the history cannot be read, nothing has changed.
 * Funding is not settled here (see FundingSettler). Cross positions are never liquidated.
 */
export async function replayInstrument(engine: Engine, source: BarSource, instId: string, from: number, to: number): Promise<ReplayResult> {
  const result: ReplayResult = { bars: 0, filled: 0, stopped: 0, liquidated: 0, markRange: null };
  if (to <= from) return result;
  // With neither a resting order nor a stop nor an isolated position no price of the span can change anything.
  const isolated = engine.account.all().some((p) => p.instId === instId && p.mgnMode === 'isolated');
  if (engine.orders.liveOrders(instId).length === 0 && engine.orders.activeStops(instId).length === 0 && !isolated) return result;

  const loaded: Array<{ bar: BarSize; trade: Bar[]; mark: Map<number, Bar> }> = [];
  for (const seg of planSegments(from, to)) {
    const [trade, mark] = await Promise.all([source.tradeBars(instId, seg.bar, seg.from, seg.to), source.markBars(instId, seg.bar, seg.from, seg.to)]);
    loaded.push({ bar: seg.bar, trade, mark: new Map(mark.map((b) => [b.ts, b])) });
  }

  try {
    for (const seg of loaded) {
      const barMs = BAR_MS[seg.bar];
      for (const trade of seg.trade) {
        result.bars++;
        // Without a mark price bar for the minute the traded prices stand in for it.
        const mark = seg.mark.get(trade.ts) ?? trade;
        engine.clockOverride = Math.min(trade.ts + barMs, to);
        const changes = result.filled + result.stopped + result.liquidated;

        result.liquidated += engine.matcher.checkLiquidations(instId, mark);

        const filled = result.filled;
        for (const o of engine.orders.liveOrders(instId)) {
          // The bar an order was placed in may have made its low before the order existed: it fills nothing.
          if (!o.px || o.cTime > trade.ts) continue;
          const through = o.side === 'buy' ? trade.low.lt(o.px) : trade.high.gt(o.px);
          if (through && engine.matcher.fillRestingAt(o.ordId, instId, o.px)) result.filled++;
        }
        // The extreme of the bar may have come after its fills: what they opened or added to is tested again.
        if (result.filled > filled) result.liquidated += engine.matcher.checkLiquidations(instId, mark);

        for (const stop of engine.orders.activeStops(instId)) {
          const ref = stop.slTriggerPxType === 'last' ? trade : mark;
          const sells = stop.side === 'sell';
          if (sells ? ref.low.gt(stop.slTriggerPx) : ref.high.lt(stop.slTriggerPx)) continue;
          const createdInBar = stop.cTime > trade.ts;
          const gapped = sells ? trade.open.lt(stop.slTriggerPx) : trade.open.gt(stop.slTriggerPx);
          if (engine.matcher.fireStop(stop, !createdInBar && gapped ? trade.open : stop.slTriggerPx)) result.stopped++;
        }
        engine.account.markToMarket(instId, mark.close);

        const changed = result.filled + result.stopped + result.liquidated > changes;
        const range = result.markRange;
        result.markRange = changed || !range ? { low: mark.low, high: mark.high } : { low: mark.low.lt(range.low) ? mark.low : range.low, high: mark.high.gt(range.high) ? mark.high : range.high };
      }
    }
  } finally {
    engine.clockOverride = null;
  }
  return result;
}
