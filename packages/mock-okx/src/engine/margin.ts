import { d, isDecimalString, ONE, ZERO, type Dec } from '../num.js';
import type { OkxInstrument } from '../wire.js';

/**
 * Isolated margin of USDT-margined linear swaps, by the rules OKX publishes in its help centre (read 2026-10-05):
 *
 * - "Futures PnL calculation rules", section 3 "The isolated margin of Single/Multi-Currency/Portfolio Margin
 *   mode" (https://www.okx.com/help/futures-pnl-calculation-rules): the margin balance of a position is its
 *   initial margin (contract value x contracts x average open price / leverage) plus what was added to or taken
 *   from it; the estimated liquidation price and the margin level are the two formulas below.
 * - "Introduction to the isolated mode of Futures mode/Multi-currency/Portfolio margin", "Isolated
 *   perpetual/futures positions" (https://www.okx.com/help/vii-introduction-to-the-isolated-mode-of-single-multi-currency-portfolio-margin):
 *   at a margin level of 100% or less "the system will cancel all orders related to your position" and a
 *   position of tier 1 is liquidated in full. The mark price decides, never the last price.
 * - "How does liquidation work in futures trading?" (https://www.okx.com/help/frequently-issues-of-contracts-for-compulsory-liquidation):
 *   "the entire margin portion corresponding to that position is lost".
 * - "Perpetual funding fee mechanism" (https://www.okx.com/help/perps-funding-fee-mechanism): the funding of an
 *   isolated position is deducted from, and credited to, its margin.
 *
 * Simulated (Account, Matcher, Engine): opening and adding post notional / leverage as margin; reducing gives the
 * same share of the margin back; margin can be added to a position and taken out of it by hand, down to its
 * initial margin (POST /api/v5/account/position/margin-balance), and a change of leverage moves the difference
 * of the initial margin; the available balance is what the positions' margins, the cross requirement and the
 * resting orders leave; a position whose liquidation price the mark has reached is closed by the exchange and
 * loses its whole margin.
 *
 * Not simulated: auto-deleveraging; the partial liquidation of the higher position tiers (every position is
 * treated as tier 1: one maintenance margin rate per instrument and its highest leverage, liquidated in full,
 * whatever its size); the order loss OKX adds to the cost of an order priced through the mark; the liquidation
 * of cross positions; inverse contracts.
 */

/**
 * The mark price at which an isolated position is liquidated: its margin level is exactly 100% there. `size` is
 * the coin it holds (contract value x contracts), `feeRate` the taker rate the liquidation fee is charged at.
 *
 *   long:  (margin - size x avgPx) / (size x (mmr + feeRate - 1))
 *   short: (margin + size x avgPx) / (size x (mmr + feeRate + 1))
 */
export function liquidationPx(dir: 1 | -1, margin: Dec, size: Dec, avgPx: Dec, mmr: Dec, feeRate: Dec): Dec {
  const notional = size.mul(avgPx);
  return dir > 0 ? margin.sub(notional).div(size.mul(mmr.add(feeRate).sub(ONE))) : margin.add(notional).div(size.mul(mmr.add(feeRate).add(ONE)));
}

/** (margin + unrealised P&L) / (position value at the mark x (mmr + feeRate)): OKX's `mgnRatio` of an isolated position, 1 being 100%. */
export function marginLevel(margin: Dec, upl: Dec, notional: Dec, mmr: Dec, feeRate: Dec): Dec {
  return margin.add(upl).div(notional.mul(mmr.add(feeRate)));
}

/**
 * The price at which closing the position and paying the fee on it uses up its margin exactly. OKX, "System
 * Liquidation Mechanism" (https://www.okx.com/help/vi-system-liquidation-mechanism): "Bankruptcy Price: The
 * price at which a user loses all margin".
 */
export function bankruptcyPx(dir: 1 | -1, margin: Dec, size: Dec, avgPx: Dec, feeRate: Dec): Dec {
  const notional = size.mul(avgPx);
  return dir > 0 ? notional.sub(margin).div(size.mul(ONE.sub(feeRate))) : notional.add(margin).div(size.mul(ONE.add(feeRate)));
}

/**
 * The maintenance margin rate of an instrument whose tier-1 rate is not known: half the initial margin rate of
 * its highest leverage, 1 / (2 x lever). On 2026-10-05 no USDT swap sampled from every leverage class of OKX had a
 * tier-1 rate above that (100x: 0.4% against 0.5%; 50x: 0.65% or 1% against 1%; 20x: 2% against 2.5%; 10x: 2% or
 * 5% against 5%), so a position is liquidated no later than OKX would liquidate it.
 */
export function fallbackMmr(inst: Pick<OkxInstrument, 'lever'>): Dec {
  const lever = isDecimalString(inst.lever) ? d(inst.lever) : ZERO;
  // An instrument without a usable leverage gets the rate of 1x.
  return ONE.div((lever.gte(ONE) ? lever : ONE).mul(2));
}
