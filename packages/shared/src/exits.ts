import { z } from 'zod';
import { D, Decimal, ZERO, floorToStep, type DecimalInput } from './decimal.js';
import { fractionString, instIdSchema, positiveDecimalString, posSideSchema, takeProfitLegSchema, tdModeSchema, type TrailingExit } from './schemas.js';
import { trailingChannel } from './signals.js';
import type { Candle, PosSide, Side, TdMode } from './types.js';

/**
 * Exit orders: take-profits (also split into legs), the cost-price stop after the first take-profit, the exchange's
 * trailing stop (callback) and channel trailing kept by the API. docs/api.md, "Exits"; the OKX side in
 * docs/okx-api-notes.md 6.10.
 */

/** Client order id prefix of an order that follows a signal (`source: 'signal'`); the terminal's own orders carry `pg`, the campaign's `pc`. */
export const SIGNAL_CL_ORD_PREFIX = 'ps';

/**
 * Bounds of a trailing stop's callback ratio (`TrailingExit` callback `ratio`), both included, as the API enforces
 * them (RiskCheckResult code CALLBACK_RATIO). OKX refuses ratios outside bounds of its own (51257, 51311) that it does
 * not publish. Below 0.1% a trailing stop of a swap would close on the noise of the bid/ask; above 20% it no longer
 * protects anything a leveraged position can afford to lose.
 */
export const CALLBACK_RATIO_MIN = '0.001';
export const CALLBACK_RATIO_MAX = '0.2';

/** How many daily bars channel trailing may use (TrailingExit channel `bars`). */
export const CHANNEL_BARS_MIN = 2;
export const CHANNEL_BARS_MAX = 100;

const DAY_MS = 86_400_000;

/**
 * Sizes take-profit legs in whole lots, in the order given. `whole`: the legs cover all of `size` (OKX refuses split
 * take-profits attached to an order whose sizes do not add up to the order's: 51083), so every leg but the last gets
 * its fraction of `size` rounded down to the lot and the last one what the others leave. `share`: the legs cover their
 * fractions only (take-profits for an open position), the last one taking what the others leave of the fractions'
 * sum of `size`, rounded down to the lot. A leg may come out as zero; the caller refuses legs below the minimum size.
 */
export function sizeTakeProfitLegs(fractions: readonly DecimalInput[], size: DecimalInput, lotSz: DecimalInput, mode: 'whole' | 'share'): Decimal[] {
  const total = mode === 'whole' ? D(size) : floorToStep(fractions.reduce<Decimal>((sum, f) => sum.plus(f), ZERO).mul(size), lotSz);
  const out: Decimal[] = [];
  let used = ZERO;
  fractions.forEach((f, i) => {
    const sz = i === fractions.length - 1 ? Decimal.max(total.minus(used), ZERO) : floorToStep(D(f).mul(size), lotSz);
    used = used.plus(sz);
    out.push(sz);
  });
  return out;
}

/**
 * The level channel trailing keeps a position's stop-loss at once the daily bar ending at `closeTs` has closed: the
 * lowest low (a long) or the highest high (a short) of the last `bars` confirmed daily bars that had closed by then
 * (trailingChannel of packages/shared/src/signals.ts, the exit line of the campaign rule with 10 bars). null with
 * fewer bars than that.
 */
export function channelStopLevel(candles: readonly Candle[], bars: number, direction: 'long' | 'short', closeTs: number, barMs = DAY_MS): Decimal | null {
  const closed = candles.filter((c) => c.confirm && c.ts + barMs <= closeTs).sort((a, b) => a.ts - b.ts);
  if (bars < 1 || closed.length < bars) return null;
  const channel = trailingChannel(closed, bars);
  return direction === 'long' ? channel.low : channel.high;
}

/** The 00:00 UTC daily close at or before `t`. */
export const dailyCloseAtOrBefore = (t: number): number => Math.floor(t / DAY_MS) * DAY_MS;

// ---- requests of the position routes ----

const positionRef = {
  instId: instIdSchema,
  mgnMode: tdModeSchema,
  /** Required in long/short mode */
  posSide: posSideSchema.optional(),
};

/** POST /api/positions/take-profits: take-profit legs for an open position, each closing its fraction of the position. */
export const placeTakeProfitsRequestSchema = z
  .object({ ...positionRef, takeProfits: z.array(takeProfitLegSchema).min(1).max(5) })
  .refine((o) => o.takeProfits.reduce((sum, leg) => sum.plus(leg.fraction), D(0)).lte(1), { message: 'the take-profit fractions add up to more than 1', path: ['takeProfits'] });
export type PlaceTakeProfitsRequest = z.infer<typeof placeTakeProfitsRequestSchema>;

/** POST /api/positions/trailing-stop: the exchange's trailing stop (OKX move_order_stop) for an open position. */
export const placeTrailingStopRequestSchema = z.object({
  ...positionRef,
  /** Callback ratio, '0.05' is 5%; within CALLBACK_RATIO_MIN and CALLBACK_RATIO_MAX */
  ratio: fractionString,
  /** It starts trailing once the last price reaches this; at once when absent */
  activePx: positiveDecimalString.optional(),
  /** Contracts; the whole position when absent */
  sz: positiveDecimalString.optional(),
});
export type PlaceTrailingStopRequest = z.infer<typeof placeTrailingStopRequestSchema>;

/** POST /api/positions/channel-trailing: keep the position's stop-loss at the channel of the last `bars` daily bars. */
export const setChannelTrailingRequestSchema = z.object({ ...positionRef, bars: z.number().int().min(CHANNEL_BARS_MIN).max(CHANNEL_BARS_MAX) });
export type SetChannelTrailingRequest = z.infer<typeof setChannelTrailingRequestSchema>;

/** POST /api/positions/channel-trailing/clear: stop keeping it; the stop stays where it is. */
export const clearChannelTrailingRequestSchema = z.object(positionRef);
export type ClearChannelTrailingRequest = z.infer<typeof clearChannelTrailingRequestSchema>;

// ---- answers and the view ----

/** One take-profit leg placed for an open position. */
export interface PlacedTakeProfit {
  algoId: string;
  triggerPx: string;
  sz: string;
}

export interface PlaceTakeProfitsResult {
  instId: string;
  posSide: PosSide;
  legs: PlacedTakeProfit[];
}

export interface PlaceTrailingStopResult {
  algoId: string;
  instId: string;
  posSide: PosSide;
  sz: string;
  callbackRatio: string;
  /** '' when it trails from its placement */
  activePx: string;
}

/** A move of the stop channel trailing keeps: placed (there was none), amended, or replaced (cancelled and placed again). */
export interface ChannelMove {
  at: number;
  /** The daily close (00:00 UTC) whose channel it moved to */
  close: number;
  algoId: string;
  action: 'placed' | 'amended' | 'replaced';
  /** The trigger before the move; null for a stop that was placed */
  from: string | null;
  to: string;
}

/** A position whose stop-loss channel trailing keeps at the channel of the last `bars` confirmed daily bars. */
export interface ChannelTrailingEntry {
  instId: string;
  mgnMode: TdMode;
  posSide: PosSide;
  /** The direction of the position when it was set: the stop only ever moves in its favour */
  direction: 'long' | 'short';
  bars: number;
  /** Set with an opening order (`trailing` of POST /api/orders) or through POST /api/positions/channel-trailing */
  source: 'order' | 'route';
  /** The opening order's clOrdId; '' when set through the route */
  clOrdId: string;
  since: number;
  /** The channel level of the last daily close processed (the stop is at it or better); null before the first */
  level: string | null;
  /** That close (00:00 UTC), epoch ms; null before the first */
  levelClose: number | null;
  /** The stop-loss orders it keeps at the level */
  algoIds: string[];
  lastMove: ChannelMove | null;
  /** Why the last attempt did not complete; null once one did */
  lastError: { at: number; message: string } | null;
}

/** An opening order whose `trailing` is placed once it has filled. */
export interface PendingTrailingExit {
  clOrdId: string;
  ordId: string;
  instId: string;
  tdMode: TdMode;
  posSide: PosSide;
  /** Side of the opening order */
  side: Side;
  trailing: TrailingExit;
  createdAt: number;
  attempts: number;
  lastError: string | null;
}

/** GET /api/trailing */
export interface TrailingView {
  /** false outside paper trading and the local mock: exits are not offered there */
  enabled: boolean;
  entries: ChannelTrailingEntry[];
  pending: PendingTrailingExit[];
  /** The next 00:00 UTC daily close the channels are moved at */
  nextCloseAt: number;
  ts: number;
}
