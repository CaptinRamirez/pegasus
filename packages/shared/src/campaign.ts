import { D, Decimal, ZERO, floorToStep, type DecimalInput } from './decimal.js';
import { previousChannel, SignalError } from './signals.js';
import { coinToContracts } from './sizing.js';
import type { Candle, Instrument } from './types.js';

/**
 * The campaign rule: a hard-capped pot that rolls leveraged long campaigns.
 *
 * A campaign is one isolated-margin long on one instrument. It is opened after a daily close above the
 * entry channel; in the 'pyramid' structure it adds to itself out of open profit each time a 12-hour
 * close has risen by the add step; it ends at a daily close below the exit channel, or by liquidation,
 * which loses the stake. The pot stakes a share of its free cash on every new campaign and takes money
 * out for good each time its value reaches the next rung of a ladder, selling part of the open
 * campaigns when the free cash does not cover it. Nothing is ever paid into it.
 *
 * Everything here is a pure function of what is known at a close: confirmed bars sorted oldest first,
 * the position, the pot's free cash. A decision is taken at a close and traded at the next open.
 * Quantities are in base coin unless the name says contracts; linear contracts only.
 */

/** 'pyramid' adds to a campaign that works; 'noadd' holds the entry quantity to the end. */
export type CampaignStructure = 'pyramid' | 'noadd';

export interface CampaignParams {
  /** Daily bars of the entry channel: a close above their highest high opens a campaign */
  entryChannel: number;
  /** Daily bars of the exit channel: a close below their lowest low ends the campaign */
  exitChannel: number;
  /** Leverage of the entry, on isolated margin; an add never takes the notional above this multiple of the position's equity */
  leverage: string;
  structure: CampaignStructure;
  /** Rise of a 12-hour close over the price of the last add (the entry at first) that triggers the next add (fraction, 0.05 = 5%) */
  addStep: string;
  /** Taker fee the sizing leaves room for, fraction of the fill notional */
  feeRate: string;
}

export const DEFAULT_CAMPAIGN_PARAMS: CampaignParams = {
  entryChannel: 20,
  exitChannel: 10,
  leverage: '10',
  structure: 'pyramid',
  addStep: '0.05',
  feeRate: '0.0005',
};

export interface PotParams {
  /** What the pot starts with, quote currency */
  start: string;
  /** Smallest stake: with less free cash than this no campaign is opened */
  minStake: string;
  /** Share of the free cash a new campaign stakes */
  stakeFraction: string;
  /** The first rung of the ladder is start x rungFactor, every later one the rung before it x rungFactor */
  rungFactor: string;
  /** Share of the pot's value that leaves the pot at a rung */
  bankFraction: string;
}

export const DEFAULT_POT_PARAMS: PotParams = { start: '56', minStake: '5.6', stakeFraction: '0.5', rungFactor: '10', bankFraction: '0.5' };

/** Base coins that count as majors: the lower slippage in the backtest, the lower maintenance rate in the reference run. */
export const CAMPAIGN_MAJORS: readonly string[] = ['BTC', 'ETH'];

/**
 * The ten USDT perpetual swaps the evidence for the rule was computed on: what the campaign runs on unless
 * CAMPAIGN_INSTRUMENTS says otherwise, what the backtest replays by default and what the paper exchange trades.
 */
export const CAMPAIGN_INSTRUMENTS: readonly string[] = ['BTC', 'ETH', 'LTC', 'XRP', 'BCH', 'ETC', 'LINK', 'ADA', 'DOT', 'TRX'].map((coin) => `${coin}-USDT-SWAP`);

/** Maintenance margin rates by base coin; a coin that is not listed takes `other`. */
export interface MaintenanceTable {
  rates: Readonly<Record<string, string>>;
  other: string;
}

/** The exchange's maintenance margin rates of the first position tier (OKX, USDT swaps). */
export const CAMPAIGN_MAINTENANCE: MaintenanceTable = {
  rates: { BTC: '0.004', ETH: '0.004', XRP: '0.004', LTC: '0.0065', BCH: '0.0065', LINK: '0.0065', TRX: '0.0065', ETC: '0.01', ADA: '0.01', DOT: '0.01' },
  other: '0.01',
};

/**
 * Rate the liquidation price of a campaign is estimated with: the maintenance rate of the instrument's
 * first tier plus the taker fee, which the liquidation itself costs. Larger positions sit in higher
 * tiers; the exchange decides the real liquidation.
 */
export function campaignMaintenanceRate(inst: Pick<Instrument, 'baseCcy'>, p: CampaignParams = DEFAULT_CAMPAIGN_PARAMS, table: MaintenanceTable = CAMPAIGN_MAINTENANCE): string {
  return D(table.rates[inst.baseCcy] ?? table.other).plus(p.feeRate).toFixed();
}

// ---- signals ----

export interface CampaignSignals {
  /** Open time of the last confirmed bar */
  asOf: number;
  close: string;
  /** Highest high of the entryChannel bars before the last one; null with too few bars */
  entryHigh: string | null;
  /** Lowest low of the exitChannel bars before the last one; null with too few bars */
  exitLow: string | null;
  /** The close is above entryHigh: a campaign opens at the next open, when the instrument has none */
  entry: boolean;
  /** The close is below exitLow: an open campaign leaves at the next open */
  exit: boolean;
}

/**
 * Entry and exit signal at the close of the last confirmed daily bar. Bars that are not confirmed are
 * ignored. The two signals are never true together: both channels hold the bar before the last one.
 */
export function campaignSignals(candles: readonly Candle[], p: CampaignParams = DEFAULT_CAMPAIGN_PARAMS): CampaignSignals {
  const confirmed = candles.filter((c) => c.confirm);
  const last = confirmed[confirmed.length - 1];
  if (!last) throw new SignalError('NOT_ENOUGH_DATA', 'no confirmed daily bar');
  const close = D(last.close);
  const entryHigh = confirmed.length > p.entryChannel ? previousChannel(confirmed, p.entryChannel).high : null;
  const exitLow = confirmed.length > p.exitChannel ? previousChannel(confirmed, p.exitChannel).low : null;
  return {
    asOf: last.ts,
    close: close.toFixed(),
    entryHigh: entryHigh?.toFixed() ?? null,
    exitLow: exitLow?.toFixed() ?? null,
    entry: entryHigh !== null && close.gt(entryHigh),
    exit: exitLow !== null && close.lt(exitLow),
  };
}

/**
 * Whether a 12-hour close has risen by the add step over `lastAddPx`: the price of the entry, then the
 * price at which the last add was made. Never in the 'noadd' structure.
 */
export function campaignAddTriggered(close: DecimalInput, lastAddPx: DecimalInput, p: CampaignParams = DEFAULT_CAMPAIGN_PARAMS): boolean {
  return p.structure === 'pyramid' && D(close).gte(D(lastAddPx).mul(D(1).plus(p.addStep)));
}

/** What an open campaign does at the next open. */
export type CampaignAction = 'hold' | 'add' | 'exit';

/**
 * The decision for an open campaign at a 12-hour close. `exitSignal` is the daily exit signal when
 * the close is also a daily close, false otherwise. The exit wins: a campaign that leaves does not add.
 */
export function campaignAction(exitSignal: boolean, close: DecimalInput, lastAddPx: DecimalInput, p: CampaignParams = DEFAULT_CAMPAIGN_PARAMS): CampaignAction {
  if (exitSignal) return 'exit';
  return campaignAddTriggered(close, lastAddPx, p) ? 'add' : 'hold';
}

// ---- position ----

/**
 * A campaign's position as far as the rule needs it: what the exchange reports in live trading, the
 * replay's own book in the backtest.
 */
export interface CampaignPosition {
  /** Base coin held */
  qty: DecimalInput;
  /** Average entry price */
  avgPx: DecimalInput;
  /** Isolated margin: what was posted at the entry, less the fees of the adds and the funding paid since */
  margin: DecimalInput;
}

/** Equity of an isolated long at `px`: its margin plus the open profit. */
export function isolatedLongEquity(pos: CampaignPosition, px: DecimalInput): Decimal {
  return D(pos.margin).plus(D(pos.qty).mul(D(px).minus(pos.avgPx)));
}

/**
 * Price at which an isolated long is liquidated: where its equity is down to the maintenance margin,
 * margin + qty x (px - avgPx) = maintenance x qty x px.
 */
export function isolatedLongLiquidationPrice(pos: CampaignPosition, maintenance: DecimalInput): Decimal {
  const qty = D(pos.qty);
  if (!qty.gt(0)) throw new SignalError('BAD_INPUT', 'the position must hold a positive quantity');
  return qty.mul(pos.avgPx).minus(pos.margin).div(qty.mul(D(1).minus(maintenance)));
}

/**
 * Base coin a stake buys at `fillPx`. The stake pays the margin (notional / leverage) and the entry
 * fee, so quantity x price x (1 / leverage + feeRate) = stake.
 */
export function campaignEntryQuantity(stake: DecimalInput, fillPx: DecimalInput, p: CampaignParams = DEFAULT_CAMPAIGN_PARAMS): Decimal {
  const px = D(fillPx);
  if (px.lte(0)) throw new SignalError('BAD_INPUT', 'price must be positive');
  return D(stake).div(px.mul(D(1).div(p.leverage).plus(p.feeRate)));
}

/**
 * The most an isolated long can add as the exchange sees it. Open profit frees no margin, so after
 * the add the notional at `markPx` must stay within maxLever x the position's margin: the margin as
 * it stands, less the fee of the add, less an open loss. The margin is never raised by an add. Can be
 * negative: the position is beyond the limit already.
 */
export function exchangeAddRoom(pos: CampaignPosition, markPx: DecimalInput, fillPx: DecimalInput, maxLever: DecimalInput, p: CampaignParams = DEFAULT_CAMPAIGN_PARAMS): Decimal {
  const mark = D(markPx);
  const lever = D(maxLever);
  if (mark.lte(0) || D(fillPx).lte(0) || lever.lte(0)) throw new SignalError('BAD_INPUT', 'prices and the maximum leverage must be positive');
  const qty = D(pos.qty);
  const usable = D(pos.margin).plus(Decimal.min(0, qty.mul(mark.minus(pos.avgPx))));
  return lever.mul(usable).minus(qty.mul(mark)).div(mark.plus(lever.mul(p.feeRate).mul(fillPx)));
}

/**
 * Base coin of one add: the quantity of the entry, cut so that the notional after the add, at
 * `fillPx`, stays within leverage x the position's equity after the fee of the add. The equity is
 * taken at `markPx` (the price before slippage). The add posts no margin: it is carried by the open
 * profit, never by new money. With `maxLever` (the instrument's) the add is cut to what the exchange
 * accepts as well (exchangeAddRoom). 0 when the position is at or beyond a cap already.
 */
export function campaignAddQuantity(
  pos: CampaignPosition,
  initialQty: DecimalInput,
  markPx: DecimalInput,
  fillPx: DecimalInput,
  p: CampaignParams = DEFAULT_CAMPAIGN_PARAMS,
  maxLever?: DecimalInput,
): Decimal {
  const px = D(fillPx);
  if (px.lte(0)) throw new SignalError('BAD_INPUT', 'price must be positive');
  const leverage = D(p.leverage);
  const room = leverage.mul(isolatedLongEquity(pos, markPx)).minus(D(pos.qty).mul(px)).div(px.mul(leverage.mul(p.feeRate).plus(1)));
  const qty = Decimal.min(initialQty, room);
  return Decimal.max(ZERO, maxLever === undefined ? qty : Decimal.min(qty, exchangeAddRoom(pos, markPx, px, maxLever, p)));
}

/**
 * Contracts of a base-coin quantity, rounded down to lotSz: what can be ordered. 0 when that is below
 * the instrument's minimum order.
 */
export function campaignContracts(qty: DecimalInput, inst: Instrument): Decimal {
  const contracts = floorToStep(coinToContracts(qty, inst), inst.lotSz);
  return contracts.lt(inst.minSz) ? ZERO : contracts;
}

// ---- pot ----

/**
 * Stake of a new campaign: stakeFraction of the free cash, but not less than the minimum stake.
 * null when the free cash is below the minimum stake: the signal is skipped.
 */
export function campaignStake(freeCash: DecimalInput, pot: PotParams = DEFAULT_POT_PARAMS): Decimal | null {
  const cash = D(freeCash);
  if (cash.lt(pot.minStake)) return null;
  return Decimal.max(pot.minStake, cash.mul(pot.stakeFraction));
}

/** Pot value of the rung after `rungs` rungs have been passed: start x rungFactor^(rungs + 1). */
export function potRungLevel(rungs: number, pot: PotParams = DEFAULT_POT_PARAMS): Decimal {
  return D(pot.start).mul(D(pot.rungFactor).pow(rungs + 1));
}

/** Whether a harvest is due: the pot's value (free cash plus the marked equity of the open campaigns) is at or above the next rung. */
export function harvestDue(potValue: DecimalInput, rungs: number, pot: PotParams = DEFAULT_POT_PARAMS): boolean {
  return D(potValue).gte(potRungLevel(rungs, pot));
}

/** What a harvest aims to take out of the pot for good: bankFraction of the pot's value. */
export function harvestTarget(potValue: DecimalInput, pot: PotParams = DEFAULT_POT_PARAMS): Decimal {
  return D(potValue).mul(pot.bankFraction);
}

/**
 * Fraction of every open campaign a harvest sells: what the free cash leaves of the target, over the
 * marked equity of the open campaigns. 0 when the free cash covers the target; never more than 1.
 */
export function harvestFraction(target: DecimalInput, freeCash: DecimalInput, openEquity: DecimalInput): Decimal {
  const short = D(target).minus(freeCash);
  const equity = D(openEquity);
  if (short.lte(0) || equity.lte(0)) return ZERO;
  return Decimal.min(1, short.div(equity));
}

export interface HarvestPlan {
  /** Rungs passed once the harvest is done: the next one is potRungLevel(rungs). The number passed in when no harvest is due */
  rungs: number;
  /** What the harvest aims to bank: for every rung crossed, bankFraction of the pot value the rung before it left */
  target: Decimal;
  /** The part of the target that leaves the free cash at once */
  fromCash: Decimal;
  /** Fraction of every open campaign to sell at the next open for the rest; 0 when the free cash covers the target */
  fraction: Decimal;
}

/**
 * The ladder, looked at whenever the pot has been marked at a 12-hour close. While the pot's value is
 * at or above the next rung, bankFraction of it leaves the pot for good and the rung after it becomes
 * the next one: out of the free cash first, and what the free cash does not cover by selling the same
 * fraction of every open campaign at the next open. A value that has jumped several rungs is harvested
 * once per rung, each time on what the harvest before it leaves; the fractions compound into the one
 * returned. What the sales return is banked as it comes: the plan is not corrected afterwards.
 */
export function planHarvest(freeCash: DecimalInput, openEquity: DecimalInput, rungs: number, pot: PotParams = DEFAULT_POT_PARAMS): HarvestPlan {
  if (!D(pot.start).gt(0) || !D(pot.rungFactor).gt(1)) throw new SignalError('BAD_INPUT', 'the ladder needs a positive start and a rung factor above 1');
  let cash = D(freeCash);
  let equity = D(openEquity);
  let passed = rungs;
  let target = ZERO;
  let fromCash = ZERO;
  let kept = D(1);
  while (harvestDue(cash.plus(equity), passed, pot)) {
    const aim = harvestTarget(cash.plus(equity), pot);
    const fraction = harvestFraction(aim, cash, equity);
    const taken = Decimal.min(cash, aim);
    target = target.plus(aim);
    fromCash = fromCash.plus(taken);
    cash = cash.minus(taken);
    equity = equity.mul(D(1).minus(fraction));
    kept = kept.mul(D(1).minus(fraction));
    passed++;
  }
  return { rungs: passed, target, fromCash, fraction: D(1).minus(kept) };
}

/**
 * Contracts a harvest sells of a position of `held` contracts: the fraction, rounded down to whole
 * lots. A sale that would leave less than the minimum order sells the whole position; a sale that is
 * itself less than the minimum order is not made (0).
 */
export function harvestContracts(held: DecimalInput, fraction: DecimalInput, inst: Instrument): Decimal {
  const all = D(held);
  if (D(fraction).lte(0) || all.lte(0)) return ZERO;
  const sell = floorToStep(all.mul(Decimal.min(1, fraction)), inst.lotSz);
  if (all.minus(sell).lt(inst.minSz)) return all;
  return sell.lt(inst.minSz) ? ZERO : sell;
}

/**
 * What a harvest that sold `sold` of the `held` contracts leaves of a campaign's margin, add unit or
 * stake basis: value x (held - sold) / held.
 */
export function keptAfterHarvest(value: DecimalInput, held: DecimalInput, sold: DecimalInput): Decimal {
  const all = D(held);
  if (!all.gt(0)) throw new SignalError('BAD_INPUT', 'the position must hold a positive quantity');
  return D(value).mul(all.minus(sold)).div(all);
}

/** The pot is finished when no campaign is open and the free cash no longer covers the minimum stake. */
export function potFinished(freeCash: DecimalInput, openCampaigns: number, pot: PotParams = DEFAULT_POT_PARAMS): boolean {
  return openCampaigns === 0 && D(freeCash).lt(pot.minStake);
}

/** mulberry32: the same numbers for the same seed on every machine. */
function seededRandom(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4_294_967_296;
  };
}

/**
 * The order in which the entry signals of one close are taken: a shuffle seeded by the close time
 * (its epoch second). It depends on the close and on which instruments signalled, not on the order
 * they are passed in.
 */
export function sameCloseOrder(instIds: readonly string[], closeTs: number): string[] {
  const order = [...instIds].sort();
  const random = seededRandom(Math.floor(closeTs / 1000));
  for (let i = order.length - 1; i > 0; i--) {
    const j = Math.floor(random() * (i + 1));
    const held = order[i] as string;
    order[i] = order[j] as string;
    order[j] = held;
  }
  return order;
}
