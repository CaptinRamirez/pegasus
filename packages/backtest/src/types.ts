import type { Candle, EntrySide, FundingRecord, Instrument, Regime, SignalPhase, SizingParams, TrendParams } from '@pegasus/shared';

export type ExitMode = 'trail' | 'close';
/** 'history': as the live service; 'none': every change unknown; 'calm': an unknown per-bar change counts as no deleveraging */
export type OiMode = 'history' | 'none' | 'calm';
export type LongVenue = 'perp' | 'spot';

/** Fractions of the fill notional. */
export interface CostParams {
  /** Entries and channel exits */
  fee: string;
  slippage: string;
  /** Stop exits */
  stopFee: string;
  stopSlippage: string;
  /** Replaces the fee of a long held in spot (longVenue = 'spot') */
  spotFee: string;
}

export interface EngineConfig {
  /** The daily cuts traded, in row order */
  phases: readonly SignalPhase[];
  params: TrendParams;
  /** Risk and notional cap of ONE unit; split across the cuts by the engine */
  sizing: SizingParams;
  /** Starting equity, quote currency */
  equity: string;
  /** No decision before this instant; earlier bars only warm the indicators up. null = as soon as there are enough bars */
  from: number | null;
  /** Bars that close after this instant are dropped. null = all the data */
  to: number | null;
  exitMode: ExitMode;
  oiMode: OiMode;
  /** Trim an instrument back to this fraction of equity; "0" = off */
  trimPct: string;
  longVenue: LongVenue;
  /** Charge funding on open lots */
  funding: boolean;
  costs: CostParams;
  /** Most instruments with open lots */
  maxInstruments: number;
  /** Marked notional of all lots over equity */
  maxGrossPct: string;
  /** Portfolio heat over equity; null = off */
  heatCap: string | null;
}

/** Open interest of an instrument at one instant, in base coin. */
export interface OiLevel {
  ts: number;
  value: string;
}

/** Everything the engine knows about one instrument. All arrays oldest first, completed periods only. */
export interface InstrumentData {
  inst: Instrument;
  /** UTC daily bars (OKX 1Dutc): the 00:00 cut, the marks at 00:00 and the benchmark */
  daily: Candle[];
  /** 12-hour UTC bars (OKX 12Hutc), the source of the 12:00 cut; empty when only the 00:00 cut runs */
  halfDay: Candle[];
  /** Funding settlements; null when there is no history: no funding filter and no funding charge */
  funding: FundingRecord[] | null;
  /** Open interest levels; null when there is no history */
  oi: OiLevel[] | null;
}

export type ExitReason = 'stop' | 'trail' | 'channel' | 'end-of-data';

export interface TradeFlags {
  /** Entered in the crisis regime (half size) */
  crisis: boolean;
  /** Entered on the crowded side (x0.75) */
  crowded: boolean;
  /** The notional cap bound the size */
  capped: boolean;
  /** Part of the lot was sold by the trim rule */
  trimmed: boolean;
}

/** One lot from entry to exit. Money as decimal strings in the quote currency. */
export interface Trade {
  instId: string;
  phase: SignalPhase;
  side: EntrySide;
  /** Open time of the bar whose close gave the signal */
  signalTs: number;
  entryTime: number;
  entryPx: string;
  initialStop: string;
  exitTime: number;
  exitPx: string;
  reason: ExitReason;
  /** Contracts bought at the entry */
  contracts: string;
  /** Entry notional */
  notional: string;
  /** Initial risk: contracts at the distance from the entry to the initial stop */
  riskQuote: string;
  /** Fees and slippage of every fill, positive = paid */
  fees: string;
  /** Funding cash flow, negative = paid */
  funding: string;
  /** Price P&L of every fill, before costs and funding */
  grossPnl: string;
  netPnl: string;
  /** netPnl / riskQuote */
  r: string;
  /** grossPnl / riskQuote */
  grossR: string;
  flags: TradeFlags;
  holdingDays: string;
  /** Still open at the end of the data: marked at the last price, kept out of the R statistics */
  open: boolean;
}

export type GateRule = 'max-instruments' | 'max-gross' | 'heat';

/** What became of an entry signal. */
export interface SignalEvent {
  instId: string;
  phase: SignalPhase;
  signalTs: number;
  side: EntrySide;
  outcome: 'filled' | 'skipped' | 'blocked' | 'no-next-bar';
  /** 'min-size' / 'no-equity' for skipped, the gate for blocked */
  rule?: GateRule | 'min-size' | 'no-equity';
}

/** What the engine saw and decided at one close of one cut. */
export interface DecisionRecord {
  instId: string;
  phase: SignalPhase;
  /** Open time of the bar that closed */
  ts: number;
  closeTs: number;
  /** Equity the report was sized from */
  equity: string;
  regime: Regime;
  longEntry: boolean;
  shortEntry: boolean;
  longExit: boolean;
  shortExit: boolean;
  /** Planned contracts per side, '' when there was no equity to size from */
  contractsLong: string;
  contractsShort: string;
  /** The open interest change of the bar was known from the history */
  oiKnown: boolean;
  nextExitLow: string;
  nextExitHigh: string;
  /** Resting stop of this cut's lot after the close; null when the cut is flat or its lot leaves at the next open */
  stop: string | null;
}

/** The portfolio at one 00:00 UTC. */
export interface EquitySample {
  ts: number;
  equity: string;
  /** Equity with the funding paid so far added back: the same trades without funding */
  equityNoFunding: string;
  /** Marked notional of all open lots */
  gross: string;
  lots: number;
  /** Last price per instrument, in the order of BacktestResult.instIds; '' before the first bar */
  marks: string[];
}

export interface BacktestResult {
  instIds: string[];
  /** Sizing of ONE cut's lot, as passed to buildSignalReport */
  sizing: SizingParams;
  /** Closed lots and, last, the lots still open at the end; by entry time */
  trades: Trade[];
  signals: SignalEvent[];
  decisions: DecisionRecord[];
  series: EquitySample[];
}
