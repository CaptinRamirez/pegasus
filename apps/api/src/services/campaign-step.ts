import {
  campaignAction,
  campaignAddQuantity,
  campaignContracts,
  campaignEntryQuantity,
  campaignSignals,
  campaignStake,
  contractsToCoin,
  D,
  Decimal,
  harvestContracts,
  isolatedLongEquity,
  keptAfterHarvest,
  notionalQuote,
  planHarvest,
  sameCloseOrder,
  ZERO,
  type CampaignParams,
  type CampaignSignals,
  type CampaignStepInput,
  type Candle,
  type DecimalInput,
  type Instrument,
  type PotParams,
} from '@pegasus/shared';
import { spareMargin } from './campaign-orders.js';

/**
 * The decisions of the campaign service at one close, without any I/O: given the ledger's open campaigns with their
 * positions as the exchange reports them, the confirmed bars of each instrument, the pot's free cash and the close,
 * what the rule of packages/shared/src/campaign.ts does, in the order of the replay's C9
 * (packages/backtest/src/campaign/engine.ts): the ladder on the pot as marked at the close (C13), then at the open
 * the harvest sales, the exits, the adds, and the entries in sameCloseOrder. The liquidations of the close come
 * first and are the caller's: it removes the campaigns the exchange has liquidated before it asks.
 *
 * Entries and exits are read at 00:00 UTC only, from the daily bar (OKX 1Dutc) that closed then; adds and the ladder
 * at every 12-hour close (OKX 12Hutc). Only confirmed bars count, and a close without its bar gives no signal (C8).
 * The quantities of entries and adds are not fixed here but at execution time (sizeEntry, sizeAdd), with the free
 * cash and the position as they are then and the open of the 12-hour bar that runs after the close: the price the
 * replay fills at.
 */

export const HALF_DAY_MS = 43_200_000;
export const DAY_MS = 86_400_000;

/** A 00:00 UTC close: the daily bars close there, and with them the entry and exit signals. */
export const isDailyClose = (closeTs: number): boolean => closeTs % DAY_MS === 0;

/** The latest 12-hour close at or before `t`. */
export const closeAtOrBefore = (t: number): number => Math.floor(t / HALF_DAY_MS) * HALF_DAY_MS;

/** The 12-hour closes after `last` up to `t`, oldest first. */
export function closesAfter(last: number, t: number): number[] {
  const out: number[] = [];
  for (let c = closeAtOrBefore(last) + HALF_DAY_MS; c <= t; c += HALF_DAY_MS) out.push(c);
  return out;
}

const money = (v: Decimal): string => v.toFixed();

/** What one instrument's bars say at one close. */
export interface CloseBars {
  /** For the decision log */
  input: CampaignStepInput;
  /** Close of the 12-hour bar that closed then; null when that bar is not confirmed (no decision at this close) */
  close: Decimal | null;
  /** The price of the quantities and of the add reference: the open of the 12-hour bar after the close, its close while that bar is not known */
  price: Decimal | null;
  /** At a 00:00 UTC close, the signals of the daily bar that closed then; null otherwise and when that bar is not confirmed */
  daily: CampaignSignals | null;
}

/**
 * The bars of an instrument at a close. `halfDay` and `daily` are its 12-hour and daily UTC bars, oldest first, the
 * forming one included or not: only confirmed bars are read, except the open of the bar that runs after the close.
 */
export function barsAt(instId: string, halfDay: readonly Candle[], daily: readonly Candle[], closeTs: number, params: CampaignParams): CloseBars {
  const input: CampaignStepInput = { instId, closeTs, halfDay: null, price: null, daily: null };
  const closed = halfDay.find((c) => c.confirm && c.ts === closeTs - HALF_DAY_MS);
  if (!closed) {
    input.note = 'the 12-hour bar that closed then is not confirmed: no decision';
    return { input, close: null, price: null, daily: null };
  }
  input.halfDay = { ts: closed.ts, open: closed.open, high: closed.high, low: closed.low, close: closed.close };
  const next = halfDay.find((c) => c.ts === closeTs);
  const price = D(next ? next.open : closed.close);
  input.price = price.toFixed();
  const notes: string[] = [];
  if (!next) notes.push('the bar after the close is not known yet: the close stands for its open');
  let signals: CampaignSignals | null = null;
  if (isDailyClose(closeTs)) {
    // C8: a daily close without its daily bar gives no signal. The bars before it fill the channels.
    const days = daily.filter((c) => c.confirm && c.ts + DAY_MS <= closeTs);
    const last = days[days.length - 1];
    if (last && last.ts === closeTs - DAY_MS) {
      signals = campaignSignals(days.slice(-(Math.max(params.entryChannel, params.exitChannel) + 1)), params);
      input.daily = signals;
    } else notes.push('the daily bar that closed then is not confirmed: no entry or exit signal');
  }
  if (notes.length > 0) input.note = notes.join('; ');
  return { input, close: D(closed.close), price, daily: signals };
}

/** A campaign's isolated long as the exchange reports it. */
export interface StepPosition {
  /** Contracts held, positive */
  contracts: string;
  avgPx: string;
  margin: string;
  /** The mark price the exchange values it at */
  markPx: string;
}

/** Equity of a campaign's position at the exchange's mark: its margin plus the open P&L. */
export function positionEquity(pos: StepPosition, inst: Instrument): Decimal {
  return isolatedLongEquity({ qty: contractsToCoin(pos.contracts, inst), avgPx: pos.avgPx, margin: pos.margin }, pos.markPx);
}

/** An open campaign of the ledger whose position the exchange shows. */
export interface StepCampaign {
  id: string;
  instId: string;
  /** The price the next add is measured from */
  addRef: string;
  /** Base coin of one add */
  addUnit: string;
  /** An exit decided at an earlier close and not carried out yet */
  pendingExit: boolean;
  position: StepPosition;
}

export interface DecideInput {
  closeTs: number;
  params: CampaignParams;
  pot: PotParams;
  /** Rungs of the ladder passed */
  rungs: number;
  /** The account's available USDT less the banked amount */
  freeCash: DecimalInput;
  /** The open campaigns, with the positions the exchange reports (the liquidated ones already removed) */
  campaigns: readonly StepCampaign[];
  /** Every instrument of the campaign and of the open campaigns, with its bars at this close */
  instruments: ReadonlyArray<{ inst: Instrument; bars: CloseBars }>;
  /** Instruments with a position the ledger does not know: no entry there */
  foreign: ReadonlySet<string>;
  /** Instruments whose open campaign's position the exchange no longer shows, not explained yet: no entry there either */
  unresolved?: ReadonlySet<string>;
}

/** What the rule does at this close, in the order it is carried out. */
export type PlannedAction =
  /** C13: the pot is at or above the next rung: `fromCash` leaves the free cash for good, `fraction` of every open campaign is sold */
  | { kind: 'bank'; value: Decimal; target: Decimal; fromCash: Decimal; fraction: Decimal; rungs: number }
  /** C13: the sale of `contracts` of the `held` */
  | { kind: 'sell'; campaignId: string; instId: string; held: Decimal; contracts: Decimal; fraction: Decimal }
  /** C5: `signal` true for the exit signal of this close, false for an exit decided earlier and not carried out */
  | { kind: 'exit'; campaignId: string; instId: string; signal: boolean; signalTs: number | null }
  /** C6: an add is due: `price` is the new reference, whatever comes of the add */
  | { kind: 'add'; campaignId: string; instId: string; close: Decimal; ref: Decimal; price: Decimal }
  /** C1: an entry, sized at execution time with the free cash left then */
  | { kind: 'enter'; instId: string; signalTs: number; price: Decimal; close: Decimal; entryHigh: string };

/** A signal or a sale the rule does not carry out, with the rule's reason. */
export interface PlannedSkip {
  kind: 'sell' | 'enter';
  instId: string;
  campaignId: string | null;
  /** min-size: less than the minimum order; foreign-position: a position the ledger does not know is on the instrument */
  reason: string;
  plan: Record<string, string | number | boolean | null>;
}

export interface CloseDecision {
  closeTs: number;
  daily: boolean;
  freeCash: Decimal;
  /** Equity of the open campaigns at the mark */
  openEquity: Decimal;
  /** freeCash + openEquity: what the ladder looked at */
  value: Decimal;
  /** Equity of each open campaign, by id */
  equity: Map<string, Decimal>;
  /** C9 order: bank, sales, exits, adds, entries */
  actions: PlannedAction[];
  skips: PlannedSkip[];
}

/** The rule at one close (see the header). */
export function decideClose(input: DecideInput): CloseDecision {
  const daily = isDailyClose(input.closeTs);
  const byInst = new Map(input.instruments.map((i) => [i.inst.instId, i]));
  const spec = (instId: string): Instrument => {
    const found = byInst.get(instId);
    if (!found) throw new Error(`no specification of ${instId}`);
    return found.inst;
  };
  const freeCash = D(input.freeCash);
  const equity = new Map<string, Decimal>();
  let openEquity = ZERO;
  for (const c of input.campaigns) {
    const e = positionEquity(c.position, spec(c.instId));
    equity.set(c.id, e);
    openEquity = openEquity.plus(e);
  }
  const value = freeCash.plus(openEquity);
  const actions: PlannedAction[] = [];
  const skips: PlannedSkip[] = [];

  // C13: the ladder, on the pot as marked at this close.
  const plan = planHarvest(freeCash, openEquity, input.rungs, input.pot);
  if (plan.rungs !== input.rungs) {
    actions.push({ kind: 'bank', value, target: plan.target, fromCash: plan.fromCash, fraction: plan.fraction, rungs: plan.rungs });
    if (plan.fraction.gt(0)) {
      for (const c of input.campaigns) {
        const held = D(c.position.contracts);
        const contracts = harvestContracts(held, plan.fraction, spec(c.instId));
        if (contracts.isZero()) skips.push({ kind: 'sell', instId: c.instId, campaignId: c.id, reason: 'min-size', plan: { held: held.toFixed(), fraction: plan.fraction.toFixed() } });
        else actions.push({ kind: 'sell', campaignId: c.id, instId: c.instId, held, contracts, fraction: plan.fraction });
      }
    }
  }

  // C5, C6: the open campaigns. The exit wins; a close without its bar decides nothing (C8).
  const exits: PlannedAction[] = [];
  const adds: PlannedAction[] = [];
  for (const c of input.campaigns) {
    if (c.pendingExit) {
      exits.push({ kind: 'exit', campaignId: c.id, instId: c.instId, signal: false, signalTs: null });
      continue;
    }
    const bars = byInst.get(c.instId)?.bars;
    if (!bars || bars.close === null || bars.price === null) continue;
    const action = campaignAction(bars.daily?.exit ?? false, bars.close, c.addRef, input.params);
    if (action === 'exit') exits.push({ kind: 'exit', campaignId: c.id, instId: c.instId, signal: true, signalTs: bars.daily?.asOf ?? null });
    else if (action === 'add') adds.push({ kind: 'add', campaignId: c.id, instId: c.instId, close: bars.close, ref: D(c.addRef), price: bars.price });
  }
  actions.push(...exits, ...adds);

  // C1, C9: the entries of the instruments without a campaign, in the order of the close.
  if (daily) {
    const held = new Set([...input.campaigns.map((c) => c.instId), ...(input.unresolved ?? [])]);
    const entering: string[] = [];
    for (const { inst, bars } of input.instruments) {
      if (held.has(inst.instId) || !bars.daily?.entry || bars.price === null) continue;
      if (input.foreign.has(inst.instId)) {
        skips.push({ kind: 'enter', instId: inst.instId, campaignId: null, reason: 'foreign-position', plan: { close: bars.daily.close, entryHigh: bars.daily.entryHigh } });
        continue;
      }
      entering.push(inst.instId);
    }
    for (const instId of sameCloseOrder(entering, input.closeTs)) {
      const bars = byInst.get(instId)?.bars;
      if (!bars?.daily || bars.price === null) continue;
      actions.push({ kind: 'enter', instId, signalTs: bars.daily.asOf, price: bars.price, close: D(bars.daily.close), entryHigh: bars.daily.entryHigh ?? '' });
    }
  }
  return { closeTs: input.closeTs, daily, freeCash, openEquity, value, equity, actions, skips };
}

// ---- sizes at execution time ----

export type EntrySizing =
  | { ok: true; planned: Decimal; contracts: Decimal; qty: Decimal; margin: Decimal; fee: Decimal; fillPx: Decimal }
  /** cash: the free cash is below the minimum stake; min-size: the stake does not buy the minimum order */
  | { ok: false; reason: 'cash' | 'min-size'; planned: Decimal | null };

/**
 * C2 at execution time. The stake is campaignStake of the free cash then; its quantity is bought at `price`, the open
 * of the 12-hour bar running after the close, in whole lots. The margin is the notional at `fillPx`, the book's
 * estimate of the fill (the price when there is none), over the leverage: the position runs at the campaign's
 * leverage from its fill, which is what the risk engine checks the buy against. When the stake at that fill would be
 * more than the free cash (the market has risen since the open), the quantity is bought at the fill instead.
 */
export function sizeEntry(freeCash: DecimalInput, price: DecimalInput, fillPx: DecimalInput | null, inst: Instrument, params: CampaignParams, pot: PotParams): EntrySizing {
  const cash = D(freeCash);
  const planned = campaignStake(cash, pot);
  if (planned === null) return { ok: false, reason: 'cash', planned: null };
  const fill = D(fillPx ?? price);
  const cost = (n: Decimal): Decimal => notionalQuote(n, fill, inst).mul(D(1).div(params.leverage).plus(params.feeRate));
  let contracts = campaignContracts(campaignEntryQuantity(planned, price, params), inst);
  if (contracts.gt(0) && cost(contracts).gt(cash)) contracts = campaignContracts(campaignEntryQuantity(planned, fill, params), inst);
  if (contracts.isZero()) return { ok: false, reason: 'min-size', planned };
  const notional = notionalQuote(contracts, fill, inst);
  return { ok: true, planned, contracts, qty: contractsToCoin(contracts, inst), margin: notional.div(params.leverage), fee: notional.mul(params.feeRate), fillPx: fill };
}

export interface AddSizing {
  /** What to order, whole lots; 0 when a cap leaves less than the minimum order */
  contracts: Decimal;
  /** Base coin the rule adds at the open of the running bar: the add unit cut by the campaign's cap and the exchange's cap of the instrument's maxLever (C6) */
  atOpen: Decimal;
  /** Base coin the risk engine and the exchange accept at the live mark and fill; null without live prices */
  live: Decimal | null;
}

/**
 * C6 at execution time: the add unit cut by the campaign's cap and by the exchange's (campaignAddQuantity with the
 * instrument's maxLever) at `price`, the open of the running 12-hour bar, as the replay does; and, with `live` prices,
 * also cut to what the risk engine (the campaign's leverage over the equity at the mark, the add at its fill) and the
 * exchange (spareMargin: the margin the position can spare at the leverage set, the add posted at its fill) accept
 * now, so that a market that moved since the open does not turn the add into a refusal. `position.lever` is the
 * leverage set for the position.
 */
export function sizeAdd(position: StepPosition & { lever: string }, addUnit: DecimalInput, price: DecimalInput, live: { markPx: string; fillPx: string } | null, inst: Instrument, params: CampaignParams): AddSizing {
  const pos = { qty: contractsToCoin(position.contracts, inst), avgPx: position.avgPx, margin: position.margin };
  const atOpen = campaignAddQuantity(pos, addUnit, price, price, params, inst.maxLever);
  let qty = atOpen;
  let liveQty: Decimal | null = null;
  if (live) {
    const lever = D(position.lever || '0').gt(0) ? position.lever : inst.maxLever;
    const rule = campaignAddQuantity(pos, addUnit, live.markPx, live.fillPx, params);
    const spare = spareMargin({ margin: position.margin, upl: pos.qty.mul(D(live.markPx).minus(pos.avgPx)).toFixed(), notionalUsd: pos.qty.mul(live.markPx).toFixed(), lever });
    const exchange = spare.div(D(live.fillPx).mul(D(1).div(lever).plus(params.feeRate)));
    liveQty = Decimal.max(ZERO, Decimal.min(rule, exchange));
    qty = Decimal.min(qty, liveQty);
  }
  return { contracts: campaignContracts(Decimal.max(ZERO, qty), inst), atOpen, live: liveQty };
}

/**
 * An add the exchange refused at its cap (CAMPAIGN_ADD_CAP), sized again from what it said the margin can spare:
 * contracts whose margin at the leverage set and fee at `fillPx` fit in 99% of `spare`, never more than `before`.
 */
export function resizeAddToSpare(before: Decimal, spare: DecimalInput, fillPx: DecimalInput, lever: DecimalInput, inst: Instrument, params: CampaignParams): Decimal {
  const perCoin = D(fillPx).mul(D(1).div(lever).plus(params.feeRate));
  if (!perCoin.gt(0)) return ZERO;
  const coin = Decimal.max(ZERO, D(spare).mul('0.99')).div(perCoin);
  return Decimal.min(before, campaignContracts(coin, inst));
}

/** C13: what a sale of `sold` of the `held` contracts leaves of a campaign's add unit and stake basis. */
export function afterSale(addUnit: DecimalInput, basis: DecimalInput, held: DecimalInput, sold: DecimalInput): { addUnit: Decimal; basis: Decimal } {
  return { addUnit: keptAfterHarvest(addUnit, held, sold), basis: keptAfterHarvest(basis, held, sold) };
}

// ---- closes the service did not process in time ----

export interface MissedCampaign {
  id: string;
  instId: string;
  addRef: string;
  /** An exit is due already: nothing else is looked at for it */
  exiting: boolean;
}

export interface MissedWalk {
  inputs: CampaignStepInput[];
  /** Exit signals at a missed close: carried out now, late */
  exits: Array<{ campaignId: string; instId: string; closeTs: number; signalTs: number }>;
  /** Adds and entries that were due at a missed close and are not carried out */
  missed: Array<{ closeTs: number; kind: 'add' | 'enter'; instId: string; campaignId: string | null; plan: Record<string, string | number | boolean | null> }>;
  /** The add reference of every campaign after the walk, by id (C6: it moves at every close an add was due at) */
  addRefs: Map<string, string>;
}

/**
 * The closes the service did not process (it was not running), oldest first, for the campaigns open now: an exit
 * signal at any of them is an exit to carry out now; an add or an entry that was due is not carried out, only
 * recorded, and the add reference moves as C6 says, to the open after that close.
 */
export function walkMissedCloses(
  closes: readonly number[],
  campaigns: readonly MissedCampaign[],
  instruments: ReadonlyArray<{ instId: string; halfDay: readonly Candle[]; daily: readonly Candle[] }>,
  params: CampaignParams,
): MissedWalk {
  const state = new Map(campaigns.map((c) => [c.instId, { ...c }]));
  const walk: MissedWalk = { inputs: [], exits: [], missed: [], addRefs: new Map() };
  for (const closeTs of closes) {
    for (const i of instruments) {
      const bars = barsAt(i.instId, i.halfDay, i.daily, closeTs, params);
      walk.inputs.push(bars.input);
      const c = state.get(i.instId);
      if (c) {
        if (c.exiting || bars.close === null || bars.price === null) continue;
        const action = campaignAction(bars.daily?.exit ?? false, bars.close, c.addRef, params);
        if (action === 'exit' && bars.daily) {
          c.exiting = true;
          walk.exits.push({ campaignId: c.id, instId: c.instId, closeTs, signalTs: bars.daily.asOf });
        } else if (action === 'add') {
          walk.missed.push({ closeTs, kind: 'add', instId: c.instId, campaignId: c.id, plan: { close: money(bars.close), ref: c.addRef, price: money(bars.price) } });
          c.addRef = money(bars.price);
        }
      } else if (bars.daily?.entry) {
        walk.missed.push({ closeTs, kind: 'enter', instId: i.instId, campaignId: null, plan: { close: bars.daily.close, entryHigh: bars.daily.entryHigh, signalTs: bars.daily.asOf } });
      }
    }
  }
  for (const c of state.values()) walk.addRefs.set(c.id, c.addRef);
  return walk;
}
