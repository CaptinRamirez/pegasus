import type { CampaignSignals } from './campaign.js';
import { D, Decimal, type DecimalInput } from './decimal.js';
import { atr, SignalError, type FundingRecord } from './signals.js';
import type { Candle } from './types.js';

/**
 * The regime layers of the campaign rule (docs/proposals/regime-snowball-v2.1.md, sections 4 and 8), a shadow
 * beside the approved rule until the board adopts them. Three layers over the unchanged entry trigger:
 *
 *   - the light: BTC's 3-day funding mean at or above `vetoFunding` per 8 hours, or BTC's ATR20 over its close at
 *     or above `vetoWild`, is RED: no campaign opens on any instrument; open campaigns add, exit and harvest as ever;
 *   - the vetoes of one instrument: its own funding or ATR at those thresholds, or a liquidation of its last campaign
 *     within `cooldownDays`: its signal is not taken;
 *   - the waiting: a close over the entry channel by less than `thinMargin` does not enter; the level is kept
 *     (`pendingBars` daily closes) and the entry comes at the next close still above it (acceptance), or at a close
 *     back at the level and above it (retest).
 *
 * Everything is a pure function of what is known at a daily close: confirmed bars, funding settled strictly before
 * the close, the instrument's own campaign history. Thresholds and their provenance: section 11.5 of the proposal.
 */

export type RegimeEntryModes = 'breakout' | 'accept' | 'either';

export interface RegimeParams {
  /** Funding mean per 8 hours over the last 3 days at or above which BTC is red and an instrument is vetoed (fraction) */
  vetoFunding: string;
  /** ATR20 over the close at or above which BTC is red and an instrument is vetoed (fraction) */
  vetoWild: string;
  /** Days after the liquidation of an instrument's campaign during which it does not enter */
  cooldownDays: number;
  /** A close over the entry channel by less than this fraction waits (acceptance or retest) instead of entering */
  thinMargin: string;
  /** Daily closes a pending level is kept for after the close that set it (the acceptance is the first of them) */
  pendingBars: number;
  /** breakout: thin breakouts enter at once; accept: they wait for the next close; either: or for a retest */
  entry: RegimeEntryModes;
}

export const DEFAULT_REGIME_PARAMS: RegimeParams = { vetoFunding: '0.001', vetoWild: '0.06', cooldownDays: 10, thinMargin: '0.01', pendingBars: 5, entry: 'either' };

export type RegimeState = 'RED' | 'GREEN';
export type RegimeVeto = 'veto-funding' | 'veto-wild' | 'veto-cooldown';
export type RegimeEntry = 'breakout' | 'acceptance' | 'retest';
/** Why a close gave no entry: thin = the level was just set, pending-wait = kept but not confirmed */
export type RegimeSkip = 'no-signal' | 'thin' | 'pending-wait' | 'regime-red' | RegimeVeto;

const DAY_MS = 86_400_000;
export const FUNDING_WINDOW_MS = 3 * DAY_MS;
export const FUNDING_PERIOD_MS = 8 * 3_600_000;
/** Fewer settlements than this in the window: the mean is not known (null) and vetoes nothing */
export const FUNDING_MIN_RECORDS = 6;
export const ATR_BARS = 20;
/** A daily high within this fraction of the channel high counts as a test of it */
export const TEST_BAND = '0.01';

/**
 * Mean funding rate per 8 hours over (closeTs - 3 days, closeTs), the settlement at closeTs itself excluded (it is
 * not known at the close). Each settlement's rate is scaled from its own period, the time since the settlement
 * before it (8 hours for the first one known), to 8 hours: the exchange shortens the period when the rate is capped.
 * null with fewer than FUNDING_MIN_RECORDS settlements in the window. Settlements without a rate are skipped.
 */
export function fundingMean(records: readonly FundingRecord[], closeTs: number): Decimal | null {
  const rated = records.filter((r) => r.fundingRate !== '');
  let sum = D(0);
  let n = 0;
  for (let i = 0; i < rated.length; i++) {
    const r = rated[i] as FundingRecord;
    if (r.fundingTime <= closeTs - FUNDING_WINDOW_MS || r.fundingTime >= closeTs) continue;
    const before = rated[i - 1];
    const period = before && r.fundingTime > before.fundingTime ? r.fundingTime - before.fundingTime : FUNDING_PERIOD_MS;
    sum = sum.plus(D(r.fundingRate).mul(FUNDING_PERIOD_MS).div(period));
    n++;
  }
  return n < FUNDING_MIN_RECORDS ? null : sum.div(n);
}

/** ATR over the last `n` of the confirmed daily bars, over the last close; null with fewer than n + 1 bars. */
export function atrPct(days: readonly Candle[], n = ATR_BARS): Decimal | null {
  const confirmed = days.filter((c) => c.confirm);
  const last = confirmed[confirmed.length - 1];
  if (!last || confirmed.length < n + 1) return null;
  return atr(confirmed.slice(-(n + 1)), n).div(last.close);
}

/**
 * Tests of the entry channel's high in the `n` confirmed bars before the last one: the bars whose high is within
 * TEST_BAND of the highest of them (the bar that set it counts as one). null with fewer than n + 1 bars.
 */
export function channelTests(days: readonly Candle[], n: number): number | null {
  const confirmed = days.filter((c) => c.confirm);
  if (confirmed.length < n + 1) return null;
  const window = confirmed.slice(-(n + 1), -1);
  const top = window.reduce((best, c) => Decimal.max(best, c.high), D(0));
  const floor = top.mul(D(1).minus(TEST_BAND));
  return window.filter((c) => D(c.high).gte(floor)).length;
}

/** The light: RED when either BTC reading is at or above its threshold; a reading that is not known (null) is not red. */
export function regimeState(btc: { atrPct: DecimalInput | null; funding: DecimalInput | null }, p: RegimeParams = DEFAULT_REGIME_PARAMS): RegimeState {
  const wild = btc.atrPct !== null && D(btc.atrPct).gte(p.vetoWild);
  const hot = btc.funding !== null && D(btc.funding).gte(p.vetoFunding);
  return wild || hot ? 'RED' : 'GREEN';
}

/** The close until which an instrument whose campaign was liquidated at `liquidatedAt` is in cooldown; null without one. */
export function cooldownUntil(liquidatedAt: number | null, p: RegimeParams = DEFAULT_REGIME_PARAMS): number | null {
  return liquidatedAt === null ? null : liquidatedAt + p.cooldownDays * DAY_MS;
}

/** The vetoes of one instrument at `closeTs`, in the order they are reported. */
export function regimeVetoes(
  coin: { atrPct: DecimalInput | null; funding: DecimalInput | null; liquidatedAt: number | null },
  closeTs: number,
  p: RegimeParams = DEFAULT_REGIME_PARAMS,
): RegimeVeto[] {
  const out: RegimeVeto[] = [];
  if (coin.funding !== null && D(coin.funding).gte(p.vetoFunding)) out.push('veto-funding');
  if (coin.atrPct !== null && D(coin.atrPct).gte(p.vetoWild)) out.push('veto-wild');
  const until = cooldownUntil(coin.liquidatedAt, p);
  if (until !== null && closeTs <= until) out.push('veto-cooldown');
  return out;
}

/** A thin breakout's level, kept for the acceptance or the retest. */
export interface PendingLevel {
  /** The entry channel's high the close cleared by less than thinMargin */
  level: string;
  /** Open time of the daily bar whose close set it (CampaignSignals.asOf) */
  setAt: number;
  /** Daily closes seen since it was set; 0 at the close that set it */
  bars: number;
}

export interface RegimeDecision {
  /** The entry the close decided, filled at the next open; null for none */
  entry: RegimeEntry | null;
  skip: RegimeSkip | null;
  /** The pending level after this close; null when none, or when the entry clears it */
  pending: PendingLevel | null;
  /** close / entryHigh - 1 at this close; null without a channel */
  margin: string | null;
}

/**
 * The entry decision of one instrument without a campaign at a daily close (proposal section 4, C17 to C19):
 *
 *   - a close above the entry channel by at least thinMargin (or any close above it with entry 'breakout') is a
 *     breakout; by less, the level is set as pending when none is, and nothing enters at this close (C19: a later
 *     thin close does not move a pending level);
 *   - acceptance: at the one close after the level was set (bars = 1), a close above it;
 *   - retest ('either' only): at any close while the level is kept, a low within thinMargin above it and a close
 *     above it; a close that is both is the acceptance (C18);
 *   - the level is kept for pendingBars closes after the one that set it (bars 1 to pendingBars), then expires; an
 *     entry clears it;
 *   - a RED light, then the vetoes in order, keep any entry from being taken; the level stays pending, and a crossing
 *     kept out that way sets it when none is pending (the proposal's pending level is the earliest close over the
 *     channel without a campaign since, whatever kept it out).
 *
 * `low` is the closing bar's low. `pending` is the level as the close before left it.
 */
export function regimeDecision(
  input: { signals: CampaignSignals; low: DecimalInput; pending: PendingLevel | null; state: RegimeState; vetoes: readonly RegimeVeto[] },
  p: RegimeParams = DEFAULT_REGIME_PARAMS,
): RegimeDecision {
  const { signals } = input;
  if (p.pendingBars < 1 || D(p.thinMargin).lt(0)) throw new SignalError('BAD_INPUT', 'pendingBars must be at least 1 and thinMargin at least 0');
  const close = D(signals.close);
  const margin = signals.entryHigh === null ? null : close.div(signals.entryHigh).minus(1);
  let pending: PendingLevel | null = input.pending === null ? null : { ...input.pending, bars: input.pending.bars + 1 };
  if (pending !== null && pending.bars > p.pendingBars) pending = null;

  let entry: RegimeEntry | null = null;
  let skip: RegimeSkip | null = 'no-signal';
  if (signals.entry && margin !== null) {
    if (p.entry === 'breakout' || margin.gte(p.thinMargin)) entry = 'breakout';
    else if (pending === null) {
      pending = { level: signals.entryHigh as string, setAt: signals.asOf, bars: 0 };
      skip = 'thin';
    }
  }
  if (entry === null && pending !== null && pending.bars >= 1) {
    const level = D(pending.level);
    const retest = p.entry === 'either' && D(input.low).lte(level.mul(D(1).plus(p.thinMargin)));
    if (close.gt(level) && (pending.bars === 1 || retest)) entry = pending.bars === 1 ? 'acceptance' : 'retest';
    else skip = 'pending-wait';
  }
  if (entry !== null) {
    const blocked: RegimeSkip | null = input.state === 'RED' ? 'regime-red' : (input.vetoes[0] ?? null);
    if (blocked !== null) {
      // A crossing kept out by the light or a veto is still the level the retest (or the next close) can enter at.
      if (pending === null && signals.entry) pending = { level: signals.entryHigh as string, setAt: signals.asOf, bars: 0 };
      return { entry: null, skip: blocked, pending, margin: margin?.toFixed() ?? null };
    }
    return { entry, skip: null, pending: null, margin: margin?.toFixed() ?? null };
  }
  return { entry: null, skip, pending, margin: margin?.toFixed() ?? null };
}
