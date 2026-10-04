import { z } from 'zod';
import type {
  AccountConfig,
  AlgoOrderList,
  Balance,
  Candle,
  CandleBar,
  ConnectionStatus,
  Fill,
  FundingRate,
  Instrument,
  MarkPrice,
  Order,
  OrderBook,
  Position,
  RiskConfig,
  RiskState,
  Ticker,
  Trade,
} from './types.js';
import { candleBarSchema, instIdSchema } from './schemas.js';

/**
 * Messages between the web terminal (client) and the API server over the
 * /ws endpoint. The server authenticates the socket with the API token passed
 * as a query parameter (?token=...) at connect time.
 */

// ---- client -> server ----

export const clientMessageSchema = z.discriminatedUnion('type', [
  z.object({ type: z.literal('subscribe'), instId: instIdSchema, bar: candleBarSchema.optional() }),
  z.object({ type: z.literal('unsubscribe'), instId: instIdSchema }),
  z.object({ type: z.literal('setBar'), instId: instIdSchema, bar: candleBarSchema }),
  z.object({ type: z.literal('ping') }),
]);
export type ClientMessage = z.infer<typeof clientMessageSchema>;

// ---- server -> client ----

export interface HelloPayload {
  demo: boolean;
  /** Paper trading: the account is simulated by the local paper exchange on OKX's live prices; nothing reaches an OKX account */
  paper: boolean;
  instruments: Instrument[];
  /** null until the account bootstrap has loaded it (and for good without an API key); corrected by the `account` message */
  account: AccountConfig | null;
  riskConfig: RiskConfig;
  risk: RiskState;
  connection: ConnectionStatus;
  balance: Balance | null;
  positions: Position[];
  openOrders: Order[];
  /** The stop-loss / take-profit algo orders; null until they were read from the exchange once (and for good without an API key) */
  algoOrders: AlgoOrderList | null;
  serverTime: number;
}

export type ServerMessage =
  | { type: 'hello'; data: HelloPayload }
  | { type: 'ticker'; data: Ticker }
  | { type: 'book'; data: OrderBook }
  | { type: 'trades'; data: Trade[] }
  | { type: 'candle'; data: { instId: string; bar: CandleBar; candle: Candle } }
  | { type: 'markPrice'; data: MarkPrice }
  | { type: 'fundingRate'; data: FundingRate }
  | { type: 'order'; data: Order }
  | { type: 'fill'; data: Fill }
  | { type: 'positions'; data: Position[] }
  /** The whole list, sent after every read from the exchange, changed or not: its `ts` is how fresh the list is */
  | { type: 'algoOrders'; data: AlgoOrderList }
  | { type: 'balance'; data: Balance }
  | { type: 'account'; data: AccountConfig }
  | { type: 'risk'; data: RiskState }
  | { type: 'connection'; data: ConnectionStatus }
  | { type: 'subscribed'; data: { instId: string; bar: CandleBar } }
  | { type: 'error'; data: { code: string; message: string } }
  | { type: 'pong'; data: { ts: number } };

export type ServerMessageType = ServerMessage['type'];

export function encodeServerMessage(msg: ServerMessage): string {
  return JSON.stringify(msg);
}

export function decodeServerMessage(raw: string): ServerMessage {
  const parsed: unknown = JSON.parse(raw);
  if (
    typeof parsed !== 'object' ||
    parsed === null ||
    typeof (parsed as { type?: unknown }).type !== 'string'
  ) {
    throw new Error('malformed server message');
  }
  return parsed as ServerMessage;
}
