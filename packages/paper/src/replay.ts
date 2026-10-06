import { trailingTrigger, type Dec, type Engine, type StopRec } from '@pegasus/mock-okx/engine';
import { BAR_MS, planSegments, type Bar, type BarSize, type BarSource } from './bars.js';

export interface ReplayResult {
  /** Bars the span was replayed with; 0 when there was nothing to replay */
  bars: number;
  /** Resting orders filled */
  filled: number;
  /** Stop-losses and trailing stops that closed (part of) a position */
  stopped: number;
  /** Take-profits that closed part of a position */
  takeProfits: number;
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
 * instrument, from candles. A bar gives its open, high, low and close but not the order in which its high and its
 * low came, so the order of the events inside one bar is fixed by a rule. The rule takes the order that is worse for
 * the position: what loses is applied before what gains, and what a gain changes is tested against the bar's close
 * only (the one price known to come after everything else in the bar).
 *
 * Inside one bar, in this order:
 *
 * 1. Liquidation. An isolated position is liquidated when the bar's mark price low (a long) or high (a short) reached
 *    its liquidation price. The whole margin is lost, as in a liquidation that was watched; the bar's range says
 *    nothing more than that the price was reached.
 * 2. Resting limit orders. One fills in full at its price when the bar traded THROUGH it (low below a buy, high above
 *    a sell). A bar that only touched the price fills nothing: the order may not have been reached in the queue.
 *    Neither does the bar the order was placed in: its extreme may be older than the order.
 * 3. Liquidation again, for a position step 2 opened or added to: the bar's extreme may have come after its fills.
 * 4. Stop-losses (a conditional stop-loss, the stop-loss leg of an oco order). One triggers when the bar's low (a stop
 *    that sells) or high (one that buys) reached its trigger, on mark price bars for a mark-triggered stop and on
 *    traded prices for a last-triggered one. It closes at the worse of the bar's open and the trigger: a bar that
 *    opened beyond the trigger is a gap. A stop created in that same bar (its entry filled there) closes at the
 *    trigger. An oco order whose two legs the bar reached has stopped: its take-profit is gone with it.
 * 5. Trailing stops, on traded-price bars (OKX trails the latest price). One that is active is tested first at the
 *    trigger it had when the bar opened: when the bar's low (one that sells; the high, one that buys) reached it, it
 *    closes at the worse of the open and that trigger. Otherwise its extreme moves to the bar's high (low), and the
 *    bar's close is tested against the trigger that gives: a close at or beyond it closes at that trigger. One that is
 *    not active yet is activated when the bar reached its activation price, with that price as its extreme, and is
 *    tested against the bar's close only.
 * 6. Take-profits (a conditional take-profit, the take-profit leg of an oco order). One triggers when the bar's high (a
 *    take-profit that sells) or low (one that buys) reached its trigger, on the bars of its trigger price type,
 *    nearest trigger first. It closes at the better of the bar's open and the trigger: a bar that opened beyond the
 *    trigger is a gap in the position's favour. One created in that same bar is not tested in it: its entry may have
 *    filled after the bar's extreme.
 * 7. The cost-price stop of split take-profits that step 6 moved (the first take-profit of its order triggered) is
 *    tested against the bar's close only: a close at or beyond the entry price closes at it.
 *
 * Events are stamped with the end of their bar, never later than `to`. All candles are read before anything is
 * applied: when the history cannot be read, nothing has changed. Funding is not settled here (see FundingSettler).
 * Cross positions are never liquidated.
 */
export async function replayInstrument(engine: Engine, source: BarSource, instId: string, from: number, to: number): Promise<ReplayResult> {
  const result: ReplayResult = { bars: 0, filled: 0, stopped: 0, takeProfits: 0, liquidated: 0, markRange: null };
  if (to <= from) return result;
  // With neither a resting order nor an algo order nor an isolated position no price of the span can change anything.
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
        const changes = result.filled + result.stopped + result.takeProfits + result.liquidated;
        const barOf = (type: StopRec['slTriggerPxType']): Bar => (type === 'last' ? trade : mark);

        // 1.
        result.liquidated += engine.matcher.checkLiquidations(instId, mark);

        // 2.
        const filled = result.filled;
        for (const o of engine.orders.liveOrders(instId)) {
          // The bar an order was placed in may have made its low before the order existed: it fills nothing.
          if (!o.px || o.cTime > trade.ts) continue;
          const through = o.side === 'buy' ? trade.low.lt(o.px) : trade.high.gt(o.px);
          if (through && engine.matcher.fillRestingAt(o.ordId, instId, o.px)) result.filled++;
        }
        // 3.
        if (result.filled > filled) result.liquidated += engine.matcher.checkLiquidations(instId, mark);

        // 4.
        for (const stop of engine.orders.activeStops(instId)) {
          if (!engine.orders.hasStop(stop.algoId) || stop.slTriggerPx === null) continue;
          const bar = barOf(stop.slTriggerPxType);
          const sells = stop.side === 'sell';
          if (sells ? bar.low.gt(stop.slTriggerPx) : bar.high.lt(stop.slTriggerPx)) continue;
          const createdInBar = stop.cTime > trade.ts;
          const gapped = sells ? bar.open.lt(stop.slTriggerPx) : bar.open.gt(stop.slTriggerPx);
          if (engine.matcher.fireStop(stop, !createdInBar && gapped ? bar.open : stop.slTriggerPx, 'sl')) result.stopped++;
        }

        // 5.
        for (const stop of engine.orders.activeStops(instId)) {
          if (!engine.orders.hasStop(stop.algoId) || stop.ordType !== 'move_order_stop') continue;
          const sells = stop.side === 'sell';
          let px: Dec | null = null;
          if (stop.extremePx === null) {
            const activePx = stop.activePx ?? trade.open;
            if (sells ? trade.high.lt(activePx) : trade.low.gt(activePx)) continue;
            stop.extremePx = activePx;
            stop.uTime = engine.now();
          } else {
            const before = trailingTrigger(stop);
            if (before !== null && (sells ? trade.low.lte(before) : trade.high.gte(before))) {
              const gapped = sells ? trade.open.lt(before) : trade.open.gt(before);
              px = stop.cTime <= trade.ts && gapped ? trade.open : before;
            } else {
              const extreme = sells ? trade.high : trade.low;
              if (sells ? extreme.gt(stop.extremePx) : extreme.lt(stop.extremePx)) {
                stop.extremePx = extreme;
                stop.uTime = engine.now();
              }
            }
          }
          if (px === null) {
            const after = trailingTrigger(stop);
            if (after !== null && (sells ? trade.close.lte(after) : trade.close.gte(after))) px = after;
          }
          if (px !== null && engine.matcher.fireStop(stop, px, 'trail')) result.stopped++;
        }

        // 6.
        const costStops = new Map(engine.orders.activeStops(instId).filter((s) => s.amendPxOnTriggerType).map((s) => [s.algoId, s.slTriggerPx]));
        const takeProfits = engine.orders
          .activeStops(instId)
          .filter((s) => s.tpTriggerPx !== null && s.cTime <= trade.ts)
          .sort((a, b) => {
            const at = a.tpTriggerPx as Dec;
            const bt = b.tpTriggerPx as Dec;
            // nearest first: ascending for a take-profit that sells (closes a long), descending for one that buys
            return a.side === 'sell' ? at.comparedTo(bt) : bt.comparedTo(at);
          });
        for (const stop of takeProfits) {
          if (!engine.orders.hasStop(stop.algoId) || stop.tpTriggerPx === null) continue;
          const bar = barOf(stop.tpTriggerPxType);
          const sells = stop.side === 'sell';
          if (sells ? bar.high.lt(stop.tpTriggerPx) : bar.low.gt(stop.tpTriggerPx)) continue;
          const gapped = sells ? bar.open.gt(stop.tpTriggerPx) : bar.open.lt(stop.tpTriggerPx);
          if (engine.matcher.fireStop(stop, gapped ? bar.open : stop.tpTriggerPx, 'tp')) result.takeProfits++;
        }

        // 7.
        for (const stop of engine.orders.activeStops(instId)) {
          if (!costStops.has(stop.algoId) || stop.amendPxOnTriggerType || stop.slTriggerPx === null) continue;
          const bar = barOf(stop.slTriggerPxType);
          if (stop.side === 'sell' ? bar.close.gt(stop.slTriggerPx) : bar.close.lt(stop.slTriggerPx)) continue;
          if (engine.matcher.fireStop(stop, stop.slTriggerPx, 'sl')) result.stopped++;
        }
        engine.account.markToMarket(instId, mark.close);

        const changed = result.filled + result.stopped + result.takeProfits + result.liquidated > changes;
        const range = result.markRange;
        result.markRange = changed || !range ? { low: mark.low, high: mark.high } : { low: mark.low.lt(range.low) ? mark.low : range.low, high: mark.high.gt(range.high) ? mark.high : range.high };
      }
    }
  } finally {
    engine.clockOverride = null;
  }
  return result;
}
