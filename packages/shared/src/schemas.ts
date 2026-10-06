import { z } from 'zod';
import { D, DECIMAL_STRING_RE } from './decimal.js';
import { CANDLE_BARS } from './types.js';

/** A non-negative decimal string. */
export const decimalString = z
  .string()
  .regex(DECIMAL_STRING_RE, 'must be a decimal string like "0.01"');

export const positiveDecimalString = decimalString.refine(
  (s) => !/^-/.test(s) && /[1-9]/.test(s),
  'must be a positive decimal string',
);

export const instIdSchema = z
  .string()
  .regex(/^[A-Z0-9]+-[A-Z0-9]+-SWAP$/, 'instId must look like BTC-USDT-SWAP');

export const sideSchema = z.enum(['buy', 'sell']);
export const posSideSchema = z.enum(['long', 'short', 'net']);
export const tdModeSchema = z.enum(['cross', 'isolated']);
export const ordTypeSchema = z.enum(['market', 'limit', 'post_only', 'fok', 'ioc']);
export const candleBarSchema = z.enum(CANDLE_BARS);

/**
 * Client order ids: OKX accepts up to 32 alphanumeric characters. We reserve a
 * prefix so orders placed by this terminal can be told apart from others.
 */
export const clOrdIdSchema = z.string().regex(/^[A-Za-z0-9]{1,32}$/, 'clOrdId must be 1-32 alphanumeric chars');

export const sizeUnitSchema = z.enum(['contracts', 'coin', 'quote']);
export type SizeUnit = z.infer<typeof sizeUnitSchema>;

export const orderSizeSchema = z.object({
  unit: sizeUnitSchema,
  value: positiveDecimalString,
});
export type OrderSize = z.infer<typeof orderSizeSchema>;

/** A fraction in (0, 1] as a decimal string, e.g. "0.5". */
export const fractionString = positiveDecimalString.refine((s) => D(s).lte(1), 'must be at most 1');

/** One take-profit of an opening order: when its trigger price is reached, `fraction` of the order's filled size is closed at market (mark-triggered). */
export const takeProfitLegSchema = z.object({
  triggerPx: positiveDecimalString,
  /** Share of the filled size this leg closes; the legs of one order add up to at most 1 */
  fraction: fractionString,
});
export type TakeProfitLeg = z.infer<typeof takeProfitLegSchema>;

/**
 * A trailing exit, for the position an opening order creates or for an open position.
 * - channel: Pegasus keeps the position's stop-loss at the lowest low of the last `bars` confirmed daily bars (the
 *   highest high for a short), moving it after each daily close and never against the position. The campaign
 *   rule's exit line is the 10-bar channel. The stop rests at the exchange; moving it needs the API running.
 * - callback: the exchange's own trailing stop (OKX move_order_stop): it closes the position once the price has
 *   fallen `ratio` below the highest price since activation (risen above the lowest, for a short); `activePx`
 *   delays the activation until that price is reached.
 */
export const trailingExitSchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('channel'), bars: z.number().int().min(2).max(100) }),
  z.object({ kind: z.literal('callback'), ratio: fractionString, activePx: positiveDecimalString.optional() }),
]);
export type TrailingExit = z.infer<typeof trailingExitSchema>;

/** Where an order comes from, as the trade journal records it. The campaign service's orders are 'campaign' (client order ids starting with 'pc'). */
export const orderSourceSchema = z.enum(['manual', 'signal']);
export type OrderSource = z.infer<typeof orderSourceSchema>;

/** The signal an order follows, as the page showed it when the order was sent (recorded in the trade journal). */
export const signalSnapshotSchema = z.object({
  rule: z.literal('campaign'),
  /** 'entry': a daily close above the entry channel; 'add': a 12-hour close at least the add step above the last add */
  kind: z.enum(['entry', 'add']),
  /** Open time of the bar whose close gave the signal, epoch ms */
  barTs: z.number().int(),
  close: positiveDecimalString,
  /** The entry channel's level (highest high of the bars before) */
  entryLevel: positiveDecimalString,
  /** The exit channel's level (lowest low of the bars before) */
  exitLevel: positiveDecimalString,
});
export type SignalSnapshot = z.infer<typeof signalSnapshotSchema>;

export const placeOrderRequestSchema = z
  .object({
    instId: instIdSchema,
    side: sideSchema,
    ordType: ordTypeSchema,
    /** Defaults to the server's DEFAULT_TD_MODE when omitted */
    tdMode: tdModeSchema.optional(),
    /** Required in long/short position mode; ignored in net mode */
    posSide: posSideSchema.optional(),
    /** Required for limit/post_only/fok/ioc; ignored for market */
    px: positiveDecimalString.optional(),
    size: orderSizeSchema,
    reduceOnly: z.boolean().optional(),
    /**
     * Stop-loss attached to an opening order: the exchange creates it when the order fills, triggered by the
     * mark price and executed at market. Refused on an order that closes a position.
     */
    slTriggerPx: positiveDecimalString.optional(),
    /** Take-profits attached to an opening order (split take-profits, at most 5). Refused on an order that closes a position. */
    takeProfits: z.array(takeProfitLegSchema).min(1).max(5).optional(),
    /** With slTriggerPx and takeProfits: the stop-loss moves to the average entry price once the first take-profit has filled */
    breakevenAfterTp1: z.boolean().optional(),
    /** A trailing exit for the position this opening order creates, placed once the order has filled */
    trailing: trailingExitSchema.optional(),
    /** For the trade journal; 'manual' when omitted */
    source: orderSourceSchema.optional(),
    /** For the trade journal: the signal a 'signal' order follows */
    signal: signalSnapshotSchema.optional(),
    clOrdId: clOrdIdSchema.optional(),
    /**
     * True when `clOrdId` was already sent in an earlier attempt whose outcome is unknown: the server looks the
     * id up at the exchange before sending anything. Never forwarded to OKX.
     */
    retry: z.boolean().optional(),
  })
  .refine((o) => o.ordType === 'market' || o.px !== undefined, {
    message: 'px is required for non-market orders',
    path: ['px'],
  })
  .refine((o) => o.takeProfits === undefined || o.takeProfits.reduce((sum, leg) => sum.plus(leg.fraction), D(0)).lte(1), {
    message: 'the take-profit fractions add up to more than 1',
    path: ['takeProfits'],
  })
  .refine((o) => o.signal === undefined || o.source === 'signal', {
    message: 'signal is only sent with source "signal"',
    path: ['signal'],
  });
export type PlaceOrderRequest = z.infer<typeof placeOrderRequestSchema>;

export const cancelOrderRequestSchema = z
  .object({
    instId: instIdSchema,
    ordId: z.string().min(1).optional(),
    clOrdId: clOrdIdSchema.optional(),
  })
  .refine((o) => o.ordId !== undefined || o.clOrdId !== undefined, {
    message: 'ordId or clOrdId is required',
  });
export type CancelOrderRequest = z.infer<typeof cancelOrderRequestSchema>;

export const cancelAllRequestSchema = z.object({
  instId: instIdSchema.optional(),
});
export type CancelAllRequest = z.infer<typeof cancelAllRequestSchema>;

const algoIdSchema = z.string().regex(/^[A-Za-z0-9]{1,64}$/, 'algoId must be 1-64 alphanumeric chars');

/** Move the stop-loss of an algo order to a new trigger price; nothing else about the order changes. */
export const amendAlgoOrderRequestSchema = z.object({
  instId: instIdSchema,
  algoId: algoIdSchema,
  slTriggerPx: positiveDecimalString,
});
export type AmendAlgoOrderRequest = z.infer<typeof amendAlgoOrderRequestSchema>;

/**
 * Place a stop-loss for an open position: mark-triggered, executed at market. Without `sz` it covers the
 * contracts of the position that no stop covers yet.
 */
export const placeStopRequestSchema = z.object({
  instId: instIdSchema,
  mgnMode: tdModeSchema,
  /** Required in long/short mode */
  posSide: posSideSchema.optional(),
  slTriggerPx: positiveDecimalString,
  /** Contracts; at most what the position's stops leave uncovered */
  sz: positiveDecimalString.optional(),
});
export type PlaceStopRequest = z.infer<typeof placeStopRequestSchema>;

export const cancelAlgoOrderRequestSchema = z.object({
  instId: instIdSchema,
  algoId: algoIdSchema,
});
export type CancelAlgoOrderRequest = z.infer<typeof cancelAlgoOrderRequestSchema>;

export const closePositionRequestSchema = z.object({
  instId: instIdSchema,
  mgnMode: tdModeSchema,
  /** Required in long/short mode */
  posSide: posSideSchema.optional(),
});
export type ClosePositionRequest = z.infer<typeof closePositionRequestSchema>;

export const setLeverageRequestSchema = z.object({
  instId: instIdSchema,
  lever: z.string().regex(/^\d+(\.\d+)?$/),
  mgnMode: tdModeSchema,
  posSide: z.enum(['long', 'short']).optional(),
});
export type SetLeverageRequest = z.infer<typeof setLeverageRequestSchema>;

export const killSwitchRequestSchema = z.object({
  enabled: z.boolean(),
  reason: z.string().max(200).optional(),
  /** Only with enabled false, while the daily loss limit is still breached: release anyway and restart the day's baseline at the current equity */
  rebase: z.boolean().optional(),
});
export type KillSwitchRequest = z.infer<typeof killSwitchRequestSchema>;

export const candlesQuerySchema = z.object({
  instId: instIdSchema,
  bar: candleBarSchema,
  limit: z.coerce.number().int().min(1).max(300).optional(),
  /** Return candles older than this timestamp (epoch ms) */
  before: z.coerce.number().int().optional(),
});
export type CandlesQuery = z.infer<typeof candlesQuerySchema>;

export const ordersHistoryQuerySchema = z.object({
  instId: instIdSchema.optional(),
  limit: z.coerce.number().int().min(1).max(100).optional(),
});
export type OrdersHistoryQuery = z.infer<typeof ordersHistoryQuerySchema>;

export const fillsQuerySchema = z.object({
  instId: instIdSchema.optional(),
  limit: z.coerce.number().int().min(1).max(100).optional(),
});
export type FillsQuery = z.infer<typeof fillsQuerySchema>;

export const subscribeRequestSchema = z.object({
  instId: instIdSchema,
});

/** Uniform HTTP response envelope. */
export interface ApiOk<T> {
  ok: true;
  data: T;
}
export interface ApiErr {
  ok: false;
  error: {
    code: string;
    message: string;
    details?: Record<string, unknown>;
  };
}
export type ApiResponse<T> = ApiOk<T> | ApiErr;

export const ok = <T>(data: T): ApiOk<T> => ({ ok: true, data });
export const err = (code: string, message: string, details?: Record<string, unknown>): ApiErr => ({
  ok: false,
  error: details === undefined ? { code, message } : { code, message, details },
});
