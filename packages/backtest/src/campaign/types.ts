import type { CampaignParams, Candle, FundingRecord, Instrument, PotParams } from '@pegasus/shared';

/**
 * 'pot': the product, one pot staking on the campaigns as they come.
 * 'catalogue': every signal as a campaign of its own with a stake of 1, no pot and no lot rounding;
 * what the research reference lists.
 */
export type CampaignMode = 'pot' | 'catalogue';

/** A fraction for BTC and ETH and one for every other coin (CAMPAIGN_MAJORS in @pegasus/shared). */
export interface Tiered {
  major: string;
  other: string;
}

/** Maintenance margin rates of the liquidation price, by base coin. */
export interface MaintenanceRates {
  rates: Readonly<Record<string, string>>;
  /** Rate of a coin that is not listed */
  other: string;
  /** Add the taker fee to the rate: the exchange liquidates where the equity is down to the maintenance margin plus the fee of the liquidation */
  plusFee: boolean;
}

/** What the replay assumes about fills and liquidation. The taker fee is the rule's feeRate. */
export interface CampaignCosts {
  /** Slippage of entries and adds, fraction of the price */
  slippage: Tiered;
  /** Slippage of exits and of the sales of a harvest */
  exitSlippage: Tiered;
  maintenance: MaintenanceRates;
}

export interface CampaignConfig {
  mode: CampaignMode;
  params: CampaignParams;
  /** Not used by the catalogue */
  pot: PotParams;
  /** No entry is decided before this instant; earlier bars only fill the channels. null = as soon as they are full */
  from: number | null;
  /** Bars that close after this instant are dropped. null = all the data */
  to: number | null;
  /** Charge funding on open campaigns */
  funding: boolean;
  /**
   * Cut an add to what the exchange accepts: notional within the instrument's maxLever x the position's
   * margin, which open profit does not raise. On in the pot; off in the reference run, which let open
   * profit carry any add.
   */
  exchangeCap: boolean;
  costs: CampaignCosts;
  /**
   * What the free cash starts with ('pot' mode); pot.start when not given. The ladder's rungs stay multiples of
   * pot.start. The replay beside a live pot starts with what the pot's paper account held (within 1% of its start).
   */
  startCash?: string;
  /** Sample the pot at every 12-hour close, not at 00:00 UTC only: the replay beside a live pot, whose ledger samples every close */
  sampleEveryClose?: boolean;
}

/** What the replay knows about one instrument. All arrays oldest first, completed periods only. */
export interface CampaignInstrument {
  inst: Instrument;
  /** UTC daily bars (OKX 1Dutc): the signals */
  daily: Candle[];
  /** 12-hour UTC bars (OKX 12Hutc): the fills, the adds and the liquidation test */
  halfDay: Candle[];
  /** Funding settlements; null when there is no history: no funding is charged */
  funding: FundingRecord[] | null;
  /** Daily bars older than `daily` that only fill the channels: nothing is decided or traded on them */
  warmup?: readonly Candle[];
  /**
   * C14: the open of the 12-hour bar after the last one of `halfDay` (the forming bar, or one cut by `to`), when it
   * is known: what the decisions of the last close are filled at. Ignored unless it opens at that close.
   */
  next?: { ts: number; open: string };
}

/**
 * 'harvest': the sale of a harvest closed the campaign, because less than the minimum order would have been left.
 * 'stop': the stop of the experiment (C15) was reached.
 */
export type CampaignEnd = 'exit' | 'stop' | 'liquidated' | 'harvest' | 'end-of-data';

/** One campaign from entry to end. Money as decimal strings in the quote currency. */
export interface CampaignRecord {
  instId: string;
  /** Open time of the daily bar whose close gave the signal */
  signalTs: number;
  entryTime: number;
  /** Fill price of the entry */
  entryPx: string;
  /** Open time of the 12-hour bar in which the campaign ended: an exit is filled at that open, a liquidation happens at it or inside the bar */
  endTime: number;
  end: CampaignEnd;
  /** Margin plus entry fee: what the campaign took from the pot (1 in the catalogue) */
  stake: string;
  /** Contracts bought at the entry; '' in the catalogue, which does not round to lots */
  contracts: string;
  adds: number;
  /** Harvest sales of it (C13), the one that closed it included */
  sales: number;
  /** What the harvests sold of it, banked; "0" when it was never part of one */
  harvested: string;
  /** What came back to the free cash at the end; for a campaign still open its equity at the last close less the fee of closing */
  proceeds: string;
  /** (harvested + proceeds) / stake: money returned per money staked */
  multiple: string;
  /** Highest equity at a 12-hour close over the stake behind it (the stake less the shares the harvests sold); 1 when it never rose above that */
  peak: string;
  /** Fees of every fill, positive = paid */
  fees: string;
  /** Funding cash flow, negative = paid */
  funding: string;
  /** Still open at the end of the data: marked, not closed */
  open: boolean;
}

/** What became of an entry signal on an instrument without a campaign. */
export interface CampaignSignalEvent {
  instId: string;
  signalTs: number;
  outcome: 'taken' | 'skipped' | 'no-next-bar';
  /** For skipped: 'cash' = the free cash is below the minimum stake, 'min-size' = the stake does not buy the minimum order */
  rule?: 'cash' | 'min-size';
}

/** The pot at one instant. */
export interface PotSample {
  ts: number;
  freeCash: string;
  /** Equity of the open campaigns at their last close */
  openEquity: string;
  /** freeCash + openEquity */
  value: string;
  /** Taken out for good so far */
  banked: string;
  /** Open campaigns */
  open: number;
}

/** A harvest: money leaving the pot for good at a rung of the ladder. */
export interface Banking {
  /** The 12-hour close at which the pot was at or above the rung */
  ts: number;
  /** Rungs passed after this harvest: one more per rung the pot value had crossed */
  rungs: number;
  /** Pot value at that close, before the money left */
  value: string;
  /** What the harvest aimed to bank */
  target: string;
  /** Taken from the free cash, at the close */
  fromCash: string;
  /** Fraction of every open campaign sold at its next open; "0" when the free cash covered the target */
  fraction: string;
  /** What those sales returned */
  fromSales: string;
  /** fromCash + fromSales: what was banked */
  amount: string;
}

export interface CampaignResult {
  mode: CampaignMode;
  /** The instruments replayed, in the order given */
  instIds: string[];
  /** First open and last close of the 12-hour bars replayed; null without bars */
  span: { from: number; to: number } | null;
  /** Maintenance rate each instrument's liquidation price was computed with */
  maintenance: Record<string, string>;
  /** Ended campaigns and, last, the ones still open at the end; each group by entry time */
  campaigns: CampaignRecord[];
  signals: CampaignSignalEvent[];
  /** The pot at every 00:00 UTC (every 12-hour close with sampleEveryClose), after the fills of that instant; empty in the catalogue */
  pot: PotSample[];
  /** The highest value the pot was marked at, at a 12-hour close, before the harvest of that close; null in the catalogue */
  peak: { ts: number; value: string } | null;
  bankings: Banking[];
  /** The pot when the replay stopped; null in the catalogue */
  end: PotSample | null;
  /** When the pot was finished (free cash below the minimum stake, nothing open); null when it was not */
  finishedAt: number | null;
  /** What the replay left out, for the report */
  notes: string[];
}
