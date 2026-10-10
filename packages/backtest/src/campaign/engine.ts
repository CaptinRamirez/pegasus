import {
  atr,
  CAMPAIGN_MAJORS,
  campaignAction,
  campaignAddQuantity,
  campaignContracts,
  campaignEntryQuantity,
  campaignLeverage,
  campaignSignals,
  campaignStake,
  campaignStopPrice,
  coinToContracts,
  contractsToCoin,
  D,
  Decimal,
  harvestContracts,
  isolatedLongEquity,
  isolatedLongLiquidationPrice,
  keptAfterHarvest,
  planHarvest,
  potFinished,
  sameCloseOrder,
  ZERO,
  type CampaignAction,
  type CampaignParams,
  type CampaignSignals,
  type Candle,
  type FundingRecord,
  type Instrument,
} from '@pegasus/shared';
import type { Banking, CampaignConfig, CampaignEnd, CampaignInstrument, CampaignRecord, CampaignResult, CampaignSignalEvent, PotSample, Tiered } from './types.js';

/**
 * The campaign replay: walks the 12-hour bars of every instrument and applies the campaign rule of
 * @pegasus/shared (campaign.ts). The signals, the add trigger, the quantities, the liquidation price,
 * the stake, the ladder and the order of same-close entries are computed there, by the functions the
 * live service calls; the replay only keeps the book: fills, costs, funding, margin, the pot's cash.
 *
 * Timing rules (each pinned by a test in test/campaign-engine.test.ts):
 *
 * C1.  Entry. The signal is read at the close of a daily bar, from that bar and the ones before it
 *      (warm-up bars included), and filled at the OPEN of the instrument's next 12-hour bar, at
 *      open x (1 + slippage), never at the signal bar's close. One campaign per instrument: the signal
 *      is taken only when the instrument has no campaign after that close; a campaign liquidated
 *      inside the closing bar has freed it. Without a next bar there is no entry.
 * C2.  Size. The stake pays the margin (notional / leverage) and the entry fee. In the pot the
 *      quantity is rounded down to whole lots and what the lots do not use stays in the free cash;
 *      a stake that does not buy the minimum order is skipped.
 * C3.  Order inside a 12-hour bar, from the bar after the entry bar on:
 *        at its open   (a) the open is at or below the liquidation price: liquidated;
 *                      (b) the sale of a harvest decided at the last close (C13);
 *                      (c) an exit decided at the last close is filled at open x (1 - exit slippage);
 *                      (d) an add decided at the last close is filled at open x (1 + slippage);
 *        inside it     (e) the low reaches the liquidation price: liquidated. The price is the one
 *                          after the add of (d): a bar that adds and trades down is taken in that,
 *                          the worse, order;
 *        at its close  (f) funding; (g) equity at or below the maintenance margin: liquidated;
 *                      (h) the decision for the next open.
 *      The entry bar starts at (e).
 * C4.  Liquidation pays nothing: the stake is lost. The liquidation price is that of the isolated
 *      position (margin, quantity, average price) at the maintenance rate the run gives the
 *      instrument (costs.maintenance): for the product the exchange's first tier plus the taker fee,
 *      for the reference run its own two tiers.
 * C5.  Exit. A daily close below the exit channel is filled at the next open. What comes back is the
 *      margin plus the price result less the fee, never less than nothing.
 * C6.  Adds ('pyramid' only). A 12-hour close at least addStep above the last add price is followed
 *      by an add at the next open: the entry quantity, cut by the cap of campaignAddQuantity (and to
 *      whole lots in the pot). An add posts no margin; its fee comes out of the margin. The last add
 *      price is the open of the entry bar, then the open of every bar at which an add was due, also
 *      when the cap left nothing to add. A close that gives the exit signal triggers no add.
 *      With the exchange cap (exchangeCap: the product's pot always, the reference run never) an
 *      add is also cut to what the exchange accepts, notional at the open within the instrument's
 *      maxLever x the position's margin (exchangeAddRoom): there, open profit frees no margin. An
 *      add that does not fit is skipped; the last add price moves all the same.
 * C7.  Funding. At every close the campaign sees, the settlements since the entry or since the close
 *      it saw before (time in (that instant, this close]) are charged together: rate x quantity x
 *      this bar's close, out of the margin; a long pays a positive rate. A settlement at the entry
 *      instant is not the campaign's, one at the instant of its exit is; one inside a hole in the
 *      data is charged at the close after the hole.
 * C8.  Holes. The next bar is the next 12-hour bar the data has: a decision taken before a hole is
 *      filled at the open after it. A daily close without its daily bar, or without a 12-hour bar
 *      closing with it, gives no signal.
 * C9.  The pot ('pot' mode). At one instant, in this order: the closes (C3 e-h) of every instrument;
 *      the ladder (C13) on the pot as those closes mark it; the opens (C3 a-d) of every instrument,
 *      the proceeds of the exits going to the free cash; then the entries, in the order of
 *      sameCloseOrder, each staking campaignStake of the free cash that is left and skipped when
 *      that is below the minimum stake. The pot's value is the free cash plus the equity of the open
 *      campaigns at their last close. The replay stops when the pot is finished.
 * C10. The catalogue ('catalogue' mode): every signal of C1 is taken with a stake of 1, without lot
 *      rounding and without a pot. The instruments do not affect each other.
 * C11. A campaign still open when the data ends is listed at its equity at the last close less the
 *      fee of closing, without slippage. It is not closed: its money stays out of the free cash.
 * C12. `from`: no entry is decided before it. `to`: bars that close after it are dropped.
 * C13. The ladder ('pot' mode). At every 12-hour close the pot's value, marked after the liquidations
 *      of that close, is held against the next rung (planHarvest). At or above it, half the value
 *      is to leave the pot for good and the rung advances, once per rung crossed. The free cash goes
 *      first, at that close. For what it does not cover every open campaign sells the same fraction
 *      at its next open, at open x (1 - exit slippage) less the fee, in whole lots (the whole
 *      position when less than the minimum order would be left), and what the sales return is
 *      banked as it comes: nothing is carried forward. A campaign liquidated at that open returns
 *      nothing. A campaign that sold a share g goes on with the rest: quantity, margin, add unit
 *      and stake basis x (1 - g), so its liquidation price does not move. Its multiple is all it
 *      returned, the harvested part included, over its stake; its peak is counted on the stake
 *      basis that is left.
 * C14. The running bar (CampaignInstrument.next, the replay beside a live pot only). When the open
 *      of the 12-hour bar after an instrument's last bar is known, what the last close decided
 *      (entries, exits, adds, harvest sales) is filled at that open, as C1 to C13 fill it once
 *      that bar has closed: the live service trades right after the close. Nothing else of the bar
 *      is known: it is not closed, no funding is charged in it, a liquidation inside it is not
 *      seen, and a campaign it opens is marked at its entry open.
 * C15. The stop (params.stop: an experiment, the approved rule has none). The stop price is the last
 *      add price (C6: the entry open at first) x (1 - stop). At the open of a bar (C3 a) an open at or
 *      below it, above the liquidation price, closes the campaign at open x (1 - exit slippage) less
 *      the fee, before the sales and the exit of (b) and (c); inside the bar (C3 e, the entry bar too)
 *      a low at or below it, the stop price being above the liquidation price, closes it at
 *      stop x (1 - exit slippage) less the fee. A stop price at or below the liquidation price is
 *      never reached before the liquidation. What comes back goes to the free cash, nothing to a
 *      harvest due at that open.
 * C16. The leverage of an entry (params.atrLeverage: an experiment): campaignLeverage at the entry fill
 *      price with the ATR over the entry channel's daily bars up to the signal bar, so that the
 *      liquidation sits atrLeverage ATRs below the entry, params.leverage at most. The campaign keeps
 *      that leverage as the cap of its adds (C6).
 *
 * What the replay knows at a close T: candles that closed at or before T and funding settlements
 * with time <= T. Linear contracts only; long only.
 */

const DAY_MS = 86_400_000;
const HALF_DAY_MS = DAY_MS / 2;

/** A 12-hour bar with its prices parsed once. */
interface Bar {
  ts: number;
  open: Decimal;
  low: Decimal;
  close: Decimal;
}

/** One instrument as the replay walks it. */
interface Series {
  inst: Instrument;
  bars: Bar[];
  /** Open time of a 12-hour bar -> its index */
  openIndex: Map<number, number>;
  /** Close time of a 12-hour bar -> its index */
  closeIndex: Map<number, number>;
  /** Warm-up bars, then the daily bars */
  days: Candle[];
  /** Close time of a daily bar -> its index in `days`; warm-up bars have no entry */
  dayIndex: Map<number, number>;
  funding: readonly FundingRecord[] | null;
  slippage: Decimal;
  exitSlippage: Decimal;
  maintenance: Decimal;
}

/** An open campaign: the position (the CampaignPosition of the rule) and what the rule remembers about it. */
interface Campaign {
  s: Series;
  /** The rule with this campaign's leverage (C16) */
  p: CampaignParams;
  signalTs: number;
  entryTime: number;
  entryPx: Decimal;
  /** What the campaign took from the pot */
  stake: Decimal;
  /** The part of the stake behind what is still held: the stake less the shares the harvests sold */
  basis: Decimal;
  /** Contracts of the entry; null in the catalogue */
  contracts: Decimal | null;
  /** The size of one add: the quantity of the entry, less the shares the harvests sold */
  qty0: Decimal;
  qty: Decimal;
  avgPx: Decimal;
  margin: Decimal;
  lastAddPx: Decimal;
  /** What the last close decided for the next open */
  action: CampaignAction;
  /** Price the campaign is marked at: its last close, the entry open before the first */
  mark: Decimal;
  adds: number;
  /** Highest equity at a close over the stake basis; starts at 1 */
  peak: Decimal;
  fees: Decimal;
  funding: Decimal;
  /** Instant up to which the funding settlements were charged */
  fundedTo: number;
  /** Banked by the sales of the harvests */
  harvested: Decimal;
  /** Harvest sales made */
  sold: number;
  /** Harvest sales waiting for the next open */
  sales: Sale[];
}

/** A harvest (C13) while its sales are still to come. */
interface Harvest {
  ts: number;
  rungs: number;
  value: Decimal;
  target: Decimal;
  fromCash: Decimal;
  fraction: Decimal;
  fromSales: Decimal;
}

/** The share of a campaign a harvest sells at the campaign's next open. */
interface Sale {
  fraction: Decimal;
  harvest: Harvest;
}

/** Index of the first element with time > t in an array sorted by time. */
function upperBound(rows: readonly FundingRecord[], t: number): number {
  let lo = 0;
  let hi = rows.length;
  while (lo < hi) {
    const mid = (lo + hi) >>> 1;
    if ((rows[mid] as FundingRecord).fundingTime <= t) lo = mid + 1;
    else hi = mid;
  }
  return lo;
}

const money = (v: Decimal): string => v.toDecimalPlaces(8).toFixed();
const ratio = (v: Decimal): string => v.toSignificantDigits(15).toFixed();

export function runCampaigns(data: readonly CampaignInstrument[], config: CampaignConfig): CampaignResult {
  const { params, pot } = config;
  const catalogue = config.mode === 'catalogue';
  const fee = D(params.feeRate);
  const channel = Math.max(params.entryChannel, params.exitChannel);
  const tier = (t: Tiered, inst: Instrument): Decimal => D(CAMPAIGN_MAJORS.includes(inst.baseCcy) ? t.major : t.other);
  const maintenance = (inst: Instrument): Decimal => {
    const { rates, other, plusFee } = config.costs.maintenance;
    return D(rates[inst.baseCcy] ?? other).plus(plusFee ? fee : 0);
  };
  const inRange = (c: Candle, barMs: number): boolean => c.confirm && (config.to === null || c.ts + barMs <= config.to);
  const notes: string[] = [];

  // ---- series and the timeline ----
  const series = new Map<string, Series>();
  for (const d of data) {
    const { inst } = d;
    if (inst.ctType !== 'linear') throw new Error(`${inst.instId}: the campaign replay handles linear contracts only`);
    if (D(inst.maxLever).lt(params.leverage)) {
      notes.push(`${inst.instId}: left out, the exchange offers ${inst.maxLever}x at most and the rule takes ${params.leverage}x`);
      continue;
    }
    const closed = d.halfDay.filter((c) => inRange(c, HALF_DAY_MS)).map((c): Bar => ({ ts: c.ts, open: D(c.open), low: D(c.low), close: D(c.close) }));
    // C14: the running bar is opened, never closed.
    const lastClosed = closed[closed.length - 1];
    const running = d.next !== undefined && lastClosed !== undefined && d.next.ts === lastClosed.ts + HALF_DAY_MS ? D(d.next.open) : null;
    const bars = running === null || d.next === undefined ? closed : [...closed, { ts: d.next.ts, open: running, low: running, close: running }];
    const daily = d.daily.filter((c) => inRange(c, DAY_MS));
    const firstDay = daily[0]?.ts ?? Number.POSITIVE_INFINITY;
    const days = [...(d.warmup ?? []).filter((c) => c.confirm && c.ts < firstDay), ...daily];
    const dayIndex = new Map<number, number>();
    for (let k = days.length - daily.length; k < days.length; k++) dayIndex.set((days[k] as Candle).ts + DAY_MS, k);
    series.set(inst.instId, {
      inst,
      bars,
      openIndex: new Map(bars.map((b, i) => [b.ts, i])),
      closeIndex: new Map(closed.map((b, i) => [b.ts + HALF_DAY_MS, i])),
      days,
      dayIndex,
      funding: config.funding ? d.funding : null,
      slippage: tier(config.costs.slippage, inst),
      exitSlippage: tier(config.costs.exitSlippage, inst),
      maintenance: maintenance(inst),
    });
  }
  const instants = [...new Set([...series.values()].flatMap((s) => [...s.openIndex.keys(), ...s.closeIndex.keys()]))].sort((a, b) => a - b);

  // ---- state ----
  let cash = D(config.startCash ?? pot.start);
  let banked = ZERO;
  let rungs = 0;
  let finishedAt: number | null = null;
  const open = new Map<string, Campaign>();
  /** Instrument -> open time of the daily bar whose signal waits for the next open */
  const waiting = new Map<string, number>();
  const ended: CampaignRecord[] = [];
  const signals: CampaignSignalEvent[] = [];
  const samples: PotSample[] = [];
  const harvests: Harvest[] = [];
  /** The highest value the pot was marked at (assigned inside harvest, hence the assertion) */
  let top = null as { ts: number; value: Decimal } | null;

  const openEquity = (): Decimal => {
    let equity = ZERO;
    for (const c of open.values()) equity = equity.plus(isolatedLongEquity(c, c.mark));
    return equity;
  };
  const sample = (ts: number): PotSample => {
    const equity = openEquity();
    return { ts, freeCash: money(cash), openEquity: money(equity), value: money(cash.plus(equity)), banked: money(banked), open: open.size };
  };

  const record = (c: Campaign, endTime: number, end: CampaignEnd, proceeds: Decimal): CampaignRecord => ({
    instId: c.s.inst.instId,
    signalTs: c.signalTs,
    entryTime: c.entryTime,
    entryPx: c.entryPx.toFixed(),
    endTime,
    end,
    stake: money(c.stake),
    contracts: c.contracts?.toFixed() ?? '',
    adds: c.adds,
    sales: c.sold,
    harvested: money(c.harvested),
    proceeds: money(proceeds),
    multiple: ratio(c.harvested.plus(proceeds).div(c.stake)),
    peak: ratio(c.peak),
    fees: money(c.fees),
    funding: money(c.funding),
    open: end === 'end-of-data',
  });

  /** The campaign is over: what it returns goes to the free cash. */
  const finish = (c: Campaign, bar: Bar, end: CampaignEnd, proceeds: Decimal): void => {
    open.delete(c.s.inst.instId);
    ended.push(record(c, bar.ts, end, proceeds));
    if (!catalogue) cash = cash.plus(proceeds);
  };

  /** C13: the ladder, on the pot as the closes of this instant mark it. */
  const harvest = (now: number): void => {
    const equity = openEquity();
    const value = cash.plus(equity);
    if ((config.from === null || now >= config.from) && (top === null || value.gt(top.value))) top = { ts: now, value };
    const plan = planHarvest(cash, equity, rungs, pot);
    if (plan.rungs === rungs) return;
    const due: Harvest = { ts: now, rungs: plan.rungs, value, target: plan.target, fromCash: plan.fromCash, fraction: plan.fraction, fromSales: ZERO };
    harvests.push(due);
    cash = cash.minus(plan.fromCash);
    banked = banked.plus(plan.fromCash);
    rungs = plan.rungs;
    if (plan.fraction.gt(0)) for (const c of open.values()) c.sales.push({ fraction: plan.fraction, harvest: due });
  };

  /** C13: the sale of a harvest at the open of `bar`, banked. Returns whether it closed the campaign. */
  const sell = (c: Campaign, bar: Bar, sale: Sale): boolean => {
    const { inst } = c.s;
    const held = coinToContracts(c.qty, inst);
    const contracts = harvestContracts(held, sale.fraction, inst);
    if (contracts.isZero()) return false;
    const qty = contractsToCoin(contracts, inst);
    const px = bar.open.mul(D(1).minus(c.s.exitSlippage));
    const cost = fee.mul(qty).mul(px);
    const proceeds = Decimal.max(ZERO, isolatedLongEquity(c, px).mul(contracts).div(held).minus(cost));
    c.fees = c.fees.plus(cost);
    c.harvested = c.harvested.plus(proceeds);
    c.sold++;
    banked = banked.plus(proceeds);
    sale.harvest.fromSales = sale.harvest.fromSales.plus(proceeds);
    if (contracts.eq(held)) {
      finish(c, bar, 'harvest', ZERO);
      return true;
    }
    c.qty = c.qty.minus(qty);
    c.margin = keptAfterHarvest(c.margin, held, contracts);
    c.qty0 = keptAfterHarvest(c.qty0, held, contracts);
    c.basis = keptAfterHarvest(c.basis, held, contracts);
    return false;
  };

  /** C7: the settlements not yet charged, up to `until`, at the quantity held and the close of `bar`. */
  const chargeFunding = (c: Campaign, bar: Bar, until: number): void => {
    const records = c.s.funding;
    const since = c.fundedTo;
    c.fundedTo = until;
    if (!records) return;
    let rate = ZERO;
    for (let k = upperBound(records, since); k < records.length; k++) {
      const r = records[k] as FundingRecord;
      if (r.fundingTime > until) break;
      if (r.fundingRate !== '') rate = rate.plus(r.fundingRate);
    }
    const paid = rate.mul(c.qty).mul(bar.close);
    c.margin = c.margin.minus(paid);
    c.funding = c.funding.minus(paid);
  };

  /** C5, C15: the campaign is closed at `trigger` less the exit slippage; the equity after the fee comes back. */
  const close = (c: Campaign, bar: Bar, end: CampaignEnd, trigger: Decimal): void => {
    const px = trigger.mul(D(1).minus(c.s.exitSlippage));
    const cost = fee.mul(c.qty).mul(px);
    c.fees = c.fees.plus(cost);
    finish(c, bar, end, Decimal.max(ZERO, isolatedLongEquity(c, px).minus(cost)));
  };

  /** C3 e-g: the bar that just closed. Returns whether the campaign ended in it. */
  const closeBar = (c: Campaign, bar: Bar, now: number): boolean => {
    const { maintenance } = c.s;
    const liquidation = isolatedLongLiquidationPrice(c, maintenance);
    const stop = campaignStopPrice(c.lastAddPx, params);
    if (stop !== null && stop.gt(liquidation) && bar.low.lte(stop)) {
      close(c, bar, 'stop', stop);
      return true;
    }
    if (bar.low.lte(liquidation)) {
      finish(c, bar, 'liquidated', ZERO);
      return true;
    }
    chargeFunding(c, bar, now);
    const equity = isolatedLongEquity(c, bar.close);
    if (equity.lte(maintenance.mul(c.qty).mul(bar.close))) {
      finish(c, bar, 'liquidated', ZERO);
      return true;
    }
    c.mark = bar.close;
    const height = equity.div(c.basis);
    if (height.gt(c.peak)) c.peak = height;
    return false;
  };

  /** What can be ordered of a quantity: whole lots in the pot, all of it in the catalogue. */
  const orderable = (qty: Decimal, inst: Instrument): Decimal => (catalogue ? qty : contractsToCoin(campaignContracts(qty, inst), inst));

  /** C3 a-d: the bar that opens. */
  const openBar = (c: Campaign, bar: Bar): void => {
    const { s, action } = c;
    c.action = 'hold';
    if (bar.open.lte(isolatedLongLiquidationPrice(c, s.maintenance))) {
      finish(c, bar, 'liquidated', ZERO);
      return;
    }
    const stop = campaignStopPrice(c.lastAddPx, params);
    if (stop !== null && bar.open.lte(stop)) {
      close(c, bar, 'stop', bar.open);
      return;
    }
    for (const sale of c.sales.splice(0)) if (sell(c, bar, sale)) return;
    if (action === 'exit') {
      close(c, bar, 'exit', bar.open);
      return;
    }
    if (action === 'add') {
      const px = bar.open.mul(s.slippage.plus(1));
      const qty = orderable(campaignAddQuantity(c, c.qty0, bar.open, px, c.p, config.exchangeCap ? s.inst.maxLever : undefined), s.inst);
      if (qty.gt(0)) {
        const cost = fee.mul(qty).mul(px);
        c.avgPx = c.qty.mul(c.avgPx).plus(qty.mul(px)).div(c.qty.plus(qty));
        c.qty = c.qty.plus(qty);
        c.margin = c.margin.minus(cost);
        c.fees = c.fees.plus(cost);
        c.adds++;
      }
      c.lastAddPx = bar.open;
    }
  };

  /** C16: the ATR over the entry channel's daily bars up to the signal bar that opened at `signalTs` (a signal has them all). */
  const atrAt = (s: Series, signalTs: number): Decimal => {
    const k = s.dayIndex.get(signalTs + DAY_MS) as number;
    return atr(s.days.slice(k - params.entryChannel, k + 1), params.entryChannel);
  };

  /** C1, C2, C16: the entry at the open of `bar`. */
  const enter = (s: Series, bar: Bar, signalTs: number): void => {
    const event = { instId: s.inst.instId, signalTs };
    const px = bar.open.mul(s.slippage.plus(1));
    const p = params.atrLeverage === undefined ? params : { ...params, leverage: campaignLeverage(px, atrAt(s, signalTs), s.maintenance, params).toFixed() };
    let qty: Decimal;
    let contracts: Decimal | null = null;
    if (catalogue) {
      qty = campaignEntryQuantity(1, px, p);
    } else {
      const planned = campaignStake(cash, pot);
      if (planned === null) {
        signals.push({ ...event, outcome: 'skipped', rule: 'cash' });
        return;
      }
      contracts = campaignContracts(campaignEntryQuantity(planned, px, p), s.inst);
      if (contracts.isZero()) {
        signals.push({ ...event, outcome: 'skipped', rule: 'min-size' });
        return;
      }
      qty = contractsToCoin(contracts, s.inst);
    }
    const notional = qty.mul(px);
    const margin = notional.div(p.leverage);
    const cost = fee.mul(notional);
    const stake = catalogue ? D(1) : margin.plus(cost);
    if (!catalogue) cash = cash.minus(stake);
    open.set(s.inst.instId, {
      s,
      p,
      signalTs,
      entryTime: bar.ts,
      entryPx: px,
      stake,
      basis: stake,
      contracts,
      qty0: qty,
      qty,
      avgPx: px,
      margin,
      lastAddPx: bar.open,
      action: 'hold',
      mark: bar.open,
      adds: 0,
      peak: D(1),
      fees: cost,
      funding: ZERO,
      fundedTo: bar.ts,
      harvested: ZERO,
      sold: 0,
      sales: [],
    });
    signals.push({ ...event, outcome: 'taken' });
  };

  /** The signals of the daily bar that closes at `now`; null when none does. */
  const daySignals = (s: Series, now: number): CampaignSignals | null => {
    const k = s.dayIndex.get(now);
    return k === undefined ? null : campaignSignals(s.days.slice(Math.max(0, k - channel), k + 1), params);
  };

  // ---- the replay ----
  for (const now of instants) {
    // C3 e-h: the bars that close now, then C1: the signals of the day that closes with them.
    let closed = false;
    for (const s of series.values()) {
      const i = s.closeIndex.get(now);
      if (i === undefined) continue;
      closed = true;
      const bar = s.bars[i] as Bar;
      const { instId } = s.inst;
      const held = open.get(instId);
      const liquidated = held !== undefined && closeBar(held, bar, now);
      const day = daySignals(s, now);
      if (held && !liquidated) held.action = campaignAction(day?.exit ?? false, bar.close, held.lastAddPx, params);
      else if (day?.entry && (config.from === null || now >= config.from)) waiting.set(instId, day.asOf);
    }
    // C13: the ladder looks at the pot these closes have marked.
    if (closed && !catalogue) harvest(now);

    // C3 a-d: the bars that open now.
    const entering: string[] = [];
    for (const s of series.values()) {
      const j = s.openIndex.get(now);
      if (j === undefined) continue;
      const held = open.get(s.inst.instId);
      if (held) openBar(held, s.bars[j] as Bar);
      if (waiting.has(s.inst.instId)) entering.push(s.inst.instId);
    }

    // C1, C9: the entries, one after the other.
    for (const instId of sameCloseOrder(entering, now)) {
      const s = series.get(instId) as Series;
      enter(s, s.bars[s.openIndex.get(now) as number] as Bar, waiting.get(instId) as number);
      waiting.delete(instId);
    }

    if (catalogue) continue;
    if ((now % DAY_MS === 0 || config.sampleEveryClose === true) && (config.from === null || now >= config.from)) samples.push(sample(now));
    if (potFinished(cash, open.size, pot)) {
      finishedAt = now;
      break;
    }
  }

  // C1: a signal at the last close of an instrument has no next bar. (A finished pot looks at no signal any more.)
  if (finishedAt === null) for (const [instId, signalTs] of waiting) signals.push({ instId, signalTs, outcome: 'no-next-bar' });

  // C11: campaigns still open are listed at their mark, never closed.
  const first = instants[0];
  const last = instants[instants.length - 1];
  const end = catalogue || last === undefined ? null : sample(finishedAt ?? last);
  const stillOpen = [...open.values()].map((c) => {
    const bar = c.s.bars[c.s.bars.length - 1] as Bar;
    const value = isolatedLongEquity(c, c.mark).minus(fee.mul(c.qty).mul(c.mark));
    return record(c, bar.ts, 'end-of-data', Decimal.max(ZERO, value));
  });
  const byEntry = (a: CampaignRecord, b: CampaignRecord): number => a.entryTime - b.entryTime;
  return {
    mode: config.mode,
    instIds: [...series.keys()],
    span: first === undefined || last === undefined ? null : { from: first, to: last },
    maintenance: Object.fromEntries([...series].map(([instId, s]) => [instId, s.maintenance.toFixed()])),
    campaigns: [...ended.sort(byEntry), ...stillOpen.sort(byEntry)],
    signals,
    pot: samples,
    peak: top === null ? null : { ts: top.ts, value: money(top.value) },
    bankings: harvests.map(
      (h): Banking => ({
        ts: h.ts,
        rungs: h.rungs,
        value: money(h.value),
        target: money(h.target),
        fromCash: money(h.fromCash),
        fraction: ratio(h.fraction),
        fromSales: money(h.fromSales),
        amount: money(h.fromCash.plus(h.fromSales)),
      }),
    ),
    end,
    finishedAt,
    notes,
  };
}
