import { d, fmt, ZERO, type Dec } from '../num.js';
import type { OkxBalance, OkxInstrument, OkxLeverageInfo, OkxMgnMode, OkxPosMode, OkxPosSide, OkxPosition, OkxSide } from '../wire.js';
import { bankruptcyPx, liquidationPx as liquidationPxOf, marginLevel } from './margin.js';

export interface PositionRec {
  instId: string;
  mgnMode: OkxMgnMode;
  posId: string;
  posSide: OkxPosSide;
  /** +1 long, -1 short */
  dir: 1 | -1;
  /** Unsigned size in contracts */
  qty: Dec;
  avgPx: Dec;
  lever: Dec;
  markPx: Dec;
  cTime: number;
  uTime: number;
  tradeId: string;
  realizedPnl: Dec;
  fee: Dec;
  /** Funding received (positive) or paid (negative) while the position was open */
  fundingFee: Dec;
  /**
   * The margin an isolated position holds (OKX's margin balance): part of the cash balance, and not available to
   * anything else. Zero for a cross position, whose requirement is derived from its size and leverage.
   */
  margin: Dec;
}

/** The account as plain JSON: what the paper exchange keeps across restarts. Decimals are strings. */
export interface AccountSnapshot {
  cashBal: string;
  posSeq: number;
  /** [position key, leverage] */
  leverage: Array<[string, string]>;
  positions: Array<{
    instId: string;
    mgnMode: OkxMgnMode;
    posId: string;
    posSide: OkxPosSide;
    dir: 1 | -1;
    qty: string;
    avgPx: string;
    lever: string;
    markPx: string;
    cTime: number;
    uTime: number;
    tradeId: string;
    realizedPnl: string;
    fee: string;
    fundingFee: string;
    /** Isolated positions only. A file written before isolated margin was simulated has none: the initial margin is taken. */
    margin?: string;
  }>;
  /** [position key, when the liquidated position was opened, when it was liquidated]; absent when there was none */
  liquidated?: Array<[string, number, number]>;
}

export interface FillOutcome {
  pnl: Dec;
  fee: Dec;
  position: OkxPosition;
}

export interface LiquidationOutcome extends FillOutcome {
  /** The bankruptcy price the position was taken over at */
  px: Dec;
}

/** What the liquidation of isolated positions is computed with. */
export interface MarginRules {
  /** Tier-1 maintenance margin rate by instrument */
  mmr: ReadonlyMap<string, Dec>;
  /** The rate of the liquidation fee: the taker rate */
  feeRate: Dec;
}

const MMR_RATE = d('0.004');
const POS_ID_BASE = 1_900_000_000_000_000;

function posKey(instId: string, mgnMode: OkxMgnMode, posSide: OkxPosSide): string {
  return `${instId}|${mgnMode}|${posSide}`;
}

/** Positions, leverage settings and the USDT cash balance of the simulated account. */
export class Account {
  cashBal: Dec;
  private readonly positions = new Map<string, PositionRec>();
  private readonly leverage = new Map<string, Dec>();
  /** The last liquidation of each position key: from when that position was open, and when it was liquidated. */
  private readonly liquidated = new Map<string, { from: number; at: number }>();
  private posSeq = 0;

  constructor(
    initialBalance: Dec,
    readonly posMode: OkxPosMode,
    private readonly instruments: Map<string, OkxInstrument>,
    private readonly defaultLever: Dec = d(10),
    private readonly rules: MarginRules = { mmr: new Map(), feeRate: ZERO },
  ) {
    this.cashBal = initialBalance;
  }

  private ctVal(instId: string): Dec {
    return d(this.instruments.get(instId)?.ctVal ?? '1');
  }

  private mmrOf(instId: string): Dec {
    return this.rules.mmr.get(instId) ?? MMR_RATE;
  }

  leverFor(instId: string, mgnMode: OkxMgnMode, posSide: OkxPosSide): Dec {
    return this.leverage.get(posKey(instId, mgnMode, posSide)) ?? this.leverage.get(posKey(instId, mgnMode, 'net')) ?? this.defaultLever;
  }

  setLeverage(instId: string, mgnMode: OkxMgnMode, lever: Dec, posSide: 'long' | 'short' | undefined): OkxLeverageInfo[] {
    const sides: OkxPosSide[] = this.posMode === 'long_short_mode' ? (posSide ? [posSide] : ['long', 'short']) : ['net'];
    for (const s of sides) this.leverage.set(posKey(instId, mgnMode, s), lever);
    return sides.map((s) => ({ instId, mgnMode, posSide: s, lever: fmt(lever) }));
  }

  leverageInfo(instId: string, mgnMode: OkxMgnMode): OkxLeverageInfo[] {
    const sides: OkxPosSide[] = this.posMode === 'long_short_mode' ? ['long', 'short'] : ['net'];
    return sides.map((s) => ({ instId, mgnMode, posSide: s, lever: fmt(this.leverFor(instId, mgnMode, s)) }));
  }

  find(instId: string, mgnMode: OkxMgnMode, posSide: OkxPosSide): PositionRec | undefined {
    return this.positions.get(posKey(instId, mgnMode, posSide));
  }

  all(): PositionRec[] {
    return [...this.positions.values()];
  }

  /** Direction of a fill for the given order side/posSide. */
  fillDir(side: OkxSide, posSide: OkxPosSide): 1 | -1 {
    if (this.posMode === 'net_mode') return side === 'buy' ? 1 : -1;
    return posSide === 'long' ? 1 : -1;
  }

  /** Whether an order of this side/posSide increases exposure on its position. */
  isOpening(side: OkxSide, posSide: OkxPosSide, existing: PositionRec | undefined): boolean {
    if (this.posMode === 'long_short_mode') return (side === 'buy') === (posSide === 'long');
    return !existing || existing.qty.isZero() || existing.dir === (side === 'buy' ? 1 : -1);
  }

  /** Contracts of `sz` that open new exposure (and therefore need margin). */
  openingQty(instId: string, mgnMode: OkxMgnMode, side: OkxSide, posSide: OkxPosSide, sz: Dec): Dec {
    const existing = this.find(instId, mgnMode, posSide);
    if (this.posMode === 'long_short_mode') return this.isOpening(side, posSide, existing) ? sz : ZERO;
    if (this.isOpening(side, posSide, existing)) return sz;
    const flip = sz.sub(existing?.qty ?? ZERO);
    return flip.gt(0) ? flip : ZERO;
  }

  applyFill(instId: string, mgnMode: OkxMgnMode, side: OkxSide, posSide: OkxPosSide, px: Dec, sz: Dec, feeRate: Dec, markPx: Dec, tradeId: string, now: number): FillOutcome {
    const key = posKey(instId, mgnMode, posSide);
    const dir = this.fillDir(side, posSide);
    let p = this.positions.get(key);
    if (!p) {
      this.posSeq += 1;
      p = { instId, mgnMode, posId: String(POS_ID_BASE + this.posSeq), posSide, dir, qty: ZERO, avgPx: ZERO, lever: this.leverFor(instId, mgnMode, posSide), markPx, cTime: now, uTime: now, tradeId, realizedPnl: ZERO, fee: ZERO, fundingFee: ZERO, margin: ZERO };
      this.positions.set(key, p);
    }
    const ctVal = this.ctVal(instId);
    const isolated = mgnMode === 'isolated';
    const lever = p.lever;
    // What an isolated position posts for the contracts it opens: their notional at the fill over its leverage.
    const posted = (contracts: Dec): Dec => contracts.mul(ctVal).mul(px).div(lever);
    let pnl = ZERO;
    if (p.qty.isZero() || this.isOpening(side, posSide, p)) {
      p.avgPx = p.qty.mul(p.avgPx).add(sz.mul(px)).div(p.qty.add(sz));
      p.qty = p.qty.add(sz);
      p.dir = dir;
      if (isolated) p.margin = p.margin.add(posted(sz));
    } else {
      const closed = sz.lt(p.qty) ? sz : p.qty;
      pnl = px.sub(p.avgPx).mul(closed).mul(ctVal).mul(p.dir);
      // The closed share of the margin goes back to the balance; the P&L of the close is settled there too.
      if (isolated) p.margin = closed.eq(p.qty) ? ZERO : p.margin.sub(p.margin.mul(closed).div(p.qty));
      p.qty = p.qty.sub(closed);
      const remaining = sz.sub(closed);
      // Only net mode can flip through zero; long/short mode orders never exceed the position.
      if (remaining.gt(0) && this.posMode === 'net_mode') {
        p.dir = dir;
        p.qty = remaining;
        p.avgPx = px;
        if (isolated) p.margin = posted(remaining);
      }
    }
    // The fee of an isolated fill is taken from the balance like any other, not from the position's margin.
    const fee = sz.mul(ctVal).mul(px).mul(feeRate).neg();
    this.cashBal = this.cashBal.add(pnl).add(fee);
    p.realizedPnl = p.realizedPnl.add(pnl);
    p.fee = p.fee.add(fee);
    p.uTime = now;
    p.tradeId = tradeId;
    p.markPx = markPx;
    const wire = this.positionWire(p, now);
    if (p.qty.isZero()) this.positions.delete(key);
    return { pnl, fee, position: wire };
  }

  /**
   * A funding settlement: `amount` (negative when paid) goes to the cash balance, and to the funding total of
   * the position it was charged on when that position is still open.
   *
   * The funding of an isolated position is taken from its margin and credited there (so it moves the liquidation
   * price and leaves the available balance alone). `at` is the settlement time, for one that is booked late: a
   * position opened after it is not the one that was charged, and a settlement of the position that was
   * liquidated since then is not booked at all (false) - it was part of the margin the liquidation took.
   */
  applyFunding(instId: string, mgnMode: OkxMgnMode, posSide: OkxPosSide, amount: Dec, at?: number): boolean {
    const key = posKey(instId, mgnMode, posSide);
    const p = this.positions.get(key);
    if (mgnMode === 'isolated') {
      const charged = p && (at === undefined || p.cTime <= at) ? p : undefined;
      const gone = this.liquidated.get(key);
      if (!charged && at !== undefined && gone && gone.from <= at && at <= gone.at) return false;
      this.cashBal = this.cashBal.add(amount);
      if (charged) {
        charged.margin = charged.margin.add(amount);
        charged.fundingFee = charged.fundingFee.add(amount);
      }
      return true;
    }
    this.cashBal = this.cashBal.add(amount);
    if (p) p.fundingFee = p.fundingFee.add(amount);
    return true;
  }

  /**
   * The mark price at which an isolated position is liquidated (see margin.ts); null for a cross position, whose
   * liquidation is not simulated, and for a position no price can liquidate (its margin covers its whole notional).
   */
  liquidationPx(p: PositionRec): Dec | null {
    if (p.mgnMode !== 'isolated' || p.qty.isZero()) return null;
    const px = liquidationPxOf(p.dir, p.margin, p.qty.mul(this.ctVal(p.instId)), p.avgPx, this.mmrOf(p.instId), this.rules.feeRate);
    return px.gt(0) ? px : null;
  }

  /**
   * The most that can be taken out of the margin of an isolated position (POST
   * /api/v5/account/position/margin-balance, type reduce): what it holds beyond its initial margin at the leverage
   * set for it, with that requirement computed on the mark price:
   *
   *   max(0, margin + min(0, unrealised P&L) - contract value x contracts x mark price / leverage)
   *
   * OKX documents the operation ("Increase or decrease the margin of the isolated position. Margin reduction may
   * result in the change of the actual leverage."), its refusal (59301 "Margin adjustment failed for exceeding the
   * max limit.") and that what can be transferred out of an isolated position depends on the leverage
   * (estAvailTrans of GET /api/v5/account/adjust-leverage-info), but it publishes no formula. Assumption, the
   * conservative reading throughout: the requirement is taken on the mark price, an unrealised loss counts against
   * the margin, and an unrealised profit does not count for it (nothing of an open profit can be taken out).
   */
  maxReducible(p: PositionRec): Dec {
    if (p.mgnMode !== 'isolated' || p.qty.isZero()) return ZERO;
    const upl = this.upl(p);
    const spare = p.margin.add(upl.lt(0) ? upl : ZERO).sub(this.notional(p).div(p.lever));
    return spare.gt(0) ? spare : ZERO;
  }

  /**
   * Moves `delta` from the balance into the margin of an isolated position (negative: out of it). Both are part
   * of the cash balance, so only what is available changes; the liquidation price follows the margin.
   */
  moveMargin(p: PositionRec, delta: Dec, now: number): void {
    p.margin = p.margin.add(delta);
    p.uTime = now;
  }

  /**
   * What a new leverage does to the margin of an open isolated position: the difference of its initial margin,
   * contract value x contracts x average open price x (1 / new leverage - 1 / leverage). Positive: that much more
   * is needed from the balance; negative: that much goes back to it.
   *
   * Assumption. OKX defines the margin balance of an isolated position as "Initial margin + margin added to or
   * reduced from this position", the initial margin as contract value x contracts x average open price /
   * leverage, and says of a position whose leverage is raised that "the margin required to sustain your current
   * position will be reduced", of one whose leverage is lowered that it needs "enough funds in your trading
   * account to cover the increased margin requirement" ("Futures margin calculation rules", 2 and 6). Read as:
   * the new leverage re-computes the initial margin part and the difference moves between the position and the
   * balance; what was added, taken out or settled as funding stays in the position. Whether OKX hands the
   * difference back at once when the leverage is raised is not stated (its leverage estimate, GET
   * /api/v5/account/adjust-leverage-info, gives no transferable amount for that case, which fits); doing so
   * leaves the position the smaller margin, the less favourable of the two readings for it.
   */
  leverageMarginChange(p: PositionRec, lever: Dec): Dec {
    const atAvg = p.qty.mul(this.ctVal(p.instId)).mul(p.avgPx);
    return atAvg.div(lever).sub(atAvg.div(p.lever));
  }

  /** Whether an isolated position would stay above its liquidation threshold (a margin level over 100%) with `margin`. */
  survivesWith(p: PositionRec, margin: Dec): boolean {
    const notional = this.notional(p);
    return notional.lte(0) || marginLevel(margin, this.upl(p), notional, this.mmrOf(p.instId), this.rules.feeRate).gt(1);
  }

  /** Gives an open isolated position the leverage that was set for it, with the margin that leverage moves (see leverageMarginChange). */
  relever(p: PositionRec, lever: Dec, now: number): void {
    p.margin = p.margin.add(this.leverageMarginChange(p, lever));
    p.lever = lever;
    p.uTime = now;
  }

  /**
   * The exchange takes an isolated position over: all of it, at its bankruptcy price, so that the loss of the
   * close and the liquidation fee (the taker rate on its value there) are together exactly its margin. The
   * account loses that margin and nothing else, whatever the mark was when the liquidation was triggered.
   *
   * Assumption: OKX documents that "the entire margin portion corresponding to that position is lost" and that
   * a liquidation fee at the taker rate is charged, not how the lost margin is split between the P&L and the fee
   * of the liquidation order. Booking it at the bankruptcy price makes the two add up to the margin.
   */
  liquidate(p: PositionRec, markPx: Dec, now: number): LiquidationOutcome {
    const key = posKey(p.instId, p.mgnMode, p.posSide);
    const size = p.qty.mul(this.ctVal(p.instId));
    // Funding can have taken more than the margin: the balance has paid for that already.
    const lost = p.margin.gt(0) ? p.margin : ZERO;
    const px = bankruptcyPx(p.dir, lost, size, p.avgPx, this.rules.feeRate);
    const fee = size.mul(px).mul(this.rules.feeRate).neg();
    const pnl = lost.neg().sub(fee);
    this.cashBal = this.cashBal.sub(lost);
    p.realizedPnl = p.realizedPnl.add(pnl);
    p.fee = p.fee.add(fee);
    p.qty = ZERO;
    p.margin = ZERO;
    p.uTime = now;
    p.markPx = markPx;
    this.positions.delete(key);
    this.liquidated.set(key, { from: p.cTime, at: now });
    return { px, pnl, fee, position: this.positionWire(p, now) };
  }

  snapshot(): AccountSnapshot {
    const snapshot: AccountSnapshot = {
      cashBal: this.cashBal.toFixed(),
      posSeq: this.posSeq,
      leverage: [...this.leverage].map(([key, lever]) => [key, lever.toFixed()]),
      positions: this.all().map((p) => ({
        instId: p.instId, mgnMode: p.mgnMode, posId: p.posId, posSide: p.posSide, dir: p.dir, qty: p.qty.toFixed(), avgPx: p.avgPx.toFixed(), lever: p.lever.toFixed(),
        markPx: p.markPx.toFixed(), cTime: p.cTime, uTime: p.uTime, tradeId: p.tradeId, realizedPnl: p.realizedPnl.toFixed(), fee: p.fee.toFixed(), fundingFee: p.fundingFee.toFixed(),
        ...(p.mgnMode === 'isolated' ? { margin: p.margin.toFixed() } : {}),
      })),
    };
    if (this.liquidated.size > 0) snapshot.liquidated = [...this.liquidated].map(([key, l]) => [key, l.from, l.at]);
    return snapshot;
  }

  /** Replaces the whole account with a snapshot taken earlier. */
  restore(s: AccountSnapshot): void {
    this.cashBal = d(s.cashBal);
    this.posSeq = s.posSeq;
    this.leverage.clear();
    for (const [key, lever] of s.leverage) this.leverage.set(key, d(lever));
    this.positions.clear();
    for (const p of s.positions) {
      const rec: PositionRec = {
        instId: p.instId, mgnMode: p.mgnMode, posId: p.posId, posSide: p.posSide, dir: p.dir, qty: d(p.qty), avgPx: d(p.avgPx), lever: d(p.lever),
        markPx: d(p.markPx), cTime: p.cTime, uTime: p.uTime, tradeId: p.tradeId, realizedPnl: d(p.realizedPnl), fee: d(p.fee), fundingFee: d(p.fundingFee), margin: ZERO,
      };
      if (rec.mgnMode === 'isolated') rec.margin = p.margin === undefined ? this.initialMargin(rec) : d(p.margin);
      this.positions.set(posKey(p.instId, p.mgnMode, p.posSide), rec);
    }
    this.liquidated.clear();
    for (const [key, from, at] of s.liquidated ?? []) this.liquidated.set(key, { from, at });
  }

  markToMarket(instId: string, markPx: Dec): void {
    for (const p of this.positions.values()) if (p.instId === instId) p.markPx = markPx;
  }

  private upl(p: PositionRec): Dec {
    return p.markPx.sub(p.avgPx).mul(p.qty).mul(this.ctVal(p.instId)).mul(p.dir);
  }

  /** Notional at the average open price over the leverage: the requirement of a cross position, and what an isolated one posted for its size. */
  private initialMargin(p: PositionRec): Dec {
    return p.qty.mul(this.ctVal(p.instId)).mul(p.avgPx).div(p.lever);
  }

  private notional(p: PositionRec): Dec {
    return p.qty.mul(this.ctVal(p.instId)).mul(p.markPx);
  }

  positionWire(p: PositionRec, now: number): OkxPosition {
    const upl = this.upl(p);
    const margin = this.initialMargin(p);
    const notional = this.notional(p);
    const isolated = p.mgnMode === 'isolated';
    // A cross position gets a rough estimate; an isolated one the price it is liquidated at.
    const liq = isolated ? this.liquidationPx(p) : p.avgPx.mul(d(1).sub(d('0.95').div(p.lever).mul(p.dir)));
    const pos = this.posMode === 'net_mode' ? p.qty.mul(p.dir) : p.qty;
    const num = (v: Dec): string => (p.qty.isZero() ? '' : fmt(v));
    return {
      instType: 'SWAP',
      instId: p.instId,
      mgnMode: p.mgnMode,
      posId: p.posId,
      posSide: p.posSide,
      pos: fmt(pos),
      baseBal: '',
      quoteBal: '',
      posCcy: '',
      availPos: fmt(p.qty),
      avgPx: num(p.avgPx),
      markPx: fmt(p.markPx),
      upl: num(upl),
      uplRatio: p.qty.isZero() || margin.isZero() ? '' : fmt(upl.div(margin)),
      uplLastPx: num(upl),
      uplRatioLastPx: p.qty.isZero() || margin.isZero() ? '' : fmt(upl.div(margin)),
      lever: fmt(p.lever),
      liqPx: liq ? num(liq) : '',
      // OKX: imr "only applicable to cross", margin "only applicable to isolated". The cross position keeps both
      // filled here, as it always was in this simulator.
      imr: isolated ? '' : num(margin),
      margin: num(isolated ? p.margin : margin),
      mgnRatio: isolated && notional.gt(0) ? num(marginLevel(p.margin, upl, notional, this.mmrOf(p.instId), this.rules.feeRate)) : '',
      mmr: num(notional.mul(isolated ? this.mmrOf(p.instId) : MMR_RATE)),
      liab: '',
      liabCcy: '',
      interest: '0',
      tradeId: p.tradeId,
      notionalUsd: fmt(notional),
      adl: '1',
      ccy: 'USDT',
      last: fmt(p.markPx),
      idxPx: fmt(p.markPx),
      usdPx: '',
      bePx: num(p.avgPx),
      deltaBS: '',
      deltaPA: '',
      gammaBS: '',
      gammaPA: '',
      thetaBS: '',
      thetaPA: '',
      vegaBS: '',
      vegaPA: '',
      spotInUseAmt: '',
      spotInUseCcy: '',
      realizedPnl: fmt(p.realizedPnl.add(p.fee).add(p.fundingFee)),
      pnl: fmt(p.realizedPnl),
      fee: fmt(p.fee),
      fundingFee: fmt(p.fundingFee),
      liqPenalty: '0',
      closeOrderAlgo: [],
      cTime: String(p.cTime),
      uTime: String(p.uTime),
      pTime: String(now),
    };
  }

  positionsWire(instId: string | undefined, now: number): OkxPosition[] {
    return this.all()
      .filter((p) => !instId || p.instId === instId)
      .map((p) => this.positionWire(p, now));
  }

  balance(ordFrozen: Dec, now: number): OkxBalance {
    let upl = ZERO;
    let imr = ZERO;
    let mmr = ZERO;
    let notional = ZERO;
    let isoEq = ZERO;
    let isoUpl = ZERO;
    let isoMargin = ZERO;
    for (const p of this.positions.values()) {
      const u = this.upl(p);
      upl = upl.add(u);
      notional = notional.add(this.notional(p));
      // An isolated position holds its own margin: it is no part of the cross requirement, and neither its
      // margin nor its unrealised P&L is available to anything else.
      if (p.mgnMode === 'isolated') {
        isoMargin = isoMargin.add(p.margin);
        isoEq = isoEq.add(p.margin).add(u);
        isoUpl = isoUpl.add(u);
        continue;
      }
      imr = imr.add(this.initialMargin(p));
      mmr = mmr.add(this.notional(p).mul(MMR_RATE));
    }
    const eq = this.cashBal.add(upl);
    const availEq = eq.sub(isoEq).sub(imr).sub(ordFrozen);
    const mgnRatio = mmr.isZero() ? '' : fmt(eq.sub(isoEq).div(mmr), 4);
    const ts = String(now);
    return {
      totalEq: fmt(eq),
      adjEq: fmt(eq),
      isoEq: fmt(isoEq),
      ordFroz: fmt(ordFrozen),
      imr: fmt(imr),
      mmr: fmt(mmr),
      mgnRatio,
      notionalUsd: fmt(notional),
      upl: fmt(upl),
      borrowFroz: '0',
      uTime: ts,
      details: [
        {
          ccy: 'USDT',
          eq: fmt(eq),
          eqUsd: fmt(eq),
          availEq: fmt(availEq),
          cashBal: fmt(this.cashBal),
          availBal: fmt(availEq),
          upl: fmt(upl),
          uplLiab: '0',
          frozenBal: fmt(imr.add(ordFrozen).add(isoMargin)),
          ordFrozen: fmt(ordFrozen),
          isoEq: fmt(isoEq),
          isoUpl: fmt(isoUpl),
          imr: fmt(imr),
          mmr: fmt(mmr),
          mgnRatio,
          notionalLever: eq.isZero() ? '0' : fmt(notional.div(eq), 4),
          disEq: fmt(eq),
          liab: '0',
          interest: '0',
          crossLiab: '0',
          isoLiab: '0',
          maxLoan: '',
          twap: '0',
          stgyEq: '0',
          spotInUseAmt: '',
          uTime: ts,
        },
      ],
    };
  }

  /** eq - imr - ordFrozen, used for the 51008 check. */
  availEq(ordFrozen: Dec): Dec {
    const b = this.balance(ordFrozen, 0);
    return d(b.details[0]?.availEq ?? '0');
  }
}
