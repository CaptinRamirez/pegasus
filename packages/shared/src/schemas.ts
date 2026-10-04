import { z } from 'zod';
import { DECIMAL_STRING_RE } from './decimal.js';
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
