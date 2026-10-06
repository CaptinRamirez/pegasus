/**
 * The matching engine and its server, for the paper exchange (packages/paper): the same order, position and
 * stop simulation as the mock, with the markets supplied from outside instead of simulated.
 */
export { Engine, type EngineConfig } from './engine/engine.js';
export type { EngineEvents, Market, MatchingBook } from './engine/context.js';
export type { WalkFill } from './engine/book.js';
export type { CandlePush } from './engine/market.js';
export type { AccountSnapshot, PositionRec } from './engine/account.js';
export type { AlgoLeg, AlgoOrdType, OrderRec, OrderStoreSnapshot, StopJson, StopRec } from './engine/orders.js';
export { trailingTrigger } from './engine/orders.js';
export { bankruptcyPx, fallbackMmr, liquidationPx, marginLevel } from './engine/margin.js';
export { startExchangeServer, type ExchangeServerHandle, type ExchangeServerOptions } from './server.js';
export { D, ZERO, d, fmt, isDecimalString, type Dec } from './num.js';
export type * from './wire.js';
