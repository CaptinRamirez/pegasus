import { d, fmt, ZERO, type Dec } from '../num.js';
import type { OkxBalance, OkxInstrument, OkxLeverageInfo, OkxMgnMode, OkxPosMode, OkxPosSide, OkxPosition, OkxSide } from '../wire.js';

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
  }>;
}

export interface FillOutcome {
  pnl: Dec;
  fee: Dec;
  position: OkxPosition;
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
  private posSeq = 0;

  constructor(
    initialBalance: Dec,
    readonly posMode: OkxPosMode,
    private readonly instruments: Map<string, OkxInstrument>,
    private readonly defaultLever: Dec = d(10),
  ) {
    this.cashBal = initialBalance;
  }

  private ctVal(instId: string): Dec {
    return d(this.instruments.get(instId)?.ctVal ?? '1');
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
      p = { instId, mgnMode, posId: String(POS_ID_BASE + this.posSeq), posSide, dir, qty: ZERO, avgPx: ZERO, lever: this.leverFor(instId, mgnMode, posSide), markPx, cTime: now, uTime: now, tradeId, realizedPnl: ZERO, fee: ZERO, fundingFee: ZERO };
      this.positions.set(key, p);
    }
    const ctVal = this.ctVal(instId);
    let pnl = ZERO;
    if (p.qty.isZero() || this.isOpening(side, posSide, p)) {
      p.avgPx = p.qty.mul(p.avgPx).add(sz.mul(px)).div(p.qty.add(sz));
      p.qty = p.qty.add(sz);
      p.dir = dir;
    } else {
      const closed = sz.lt(p.qty) ? sz : p.qty;
      pnl = px.sub(p.avgPx).mul(closed).mul(ctVal).mul(p.dir);
      p.qty = p.qty.sub(closed);
      const remaining = sz.sub(closed);
      // Only net mode can flip through zero; long/short mode orders never exceed the position.
      if (remaining.gt(0) && this.posMode === 'net_mode') {
        p.dir = dir;
        p.qty = remaining;
        p.avgPx = px;
      }
    }
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
   */
  applyFunding(instId: string, mgnMode: OkxMgnMode, posSide: OkxPosSide, amount: Dec): void {
    this.cashBal = this.cashBal.add(amount);
    const p = this.positions.get(posKey(instId, mgnMode, posSide));
    if (p) p.fundingFee = p.fundingFee.add(amount);
  }

  snapshot(): AccountSnapshot {
    return {
      cashBal: this.cashBal.toFixed(),
      posSeq: this.posSeq,
      leverage: [...this.leverage].map(([key, lever]) => [key, lever.toFixed()]),
      positions: this.all().map((p) => ({
        instId: p.instId, mgnMode: p.mgnMode, posId: p.posId, posSide: p.posSide, dir: p.dir, qty: p.qty.toFixed(), avgPx: p.avgPx.toFixed(), lever: p.lever.toFixed(),
        markPx: p.markPx.toFixed(), cTime: p.cTime, uTime: p.uTime, tradeId: p.tradeId, realizedPnl: p.realizedPnl.toFixed(), fee: p.fee.toFixed(), fundingFee: p.fundingFee.toFixed(),
      })),
    };
  }

  /** Replaces the whole account with a snapshot taken earlier. */
  restore(s: AccountSnapshot): void {
    this.cashBal = d(s.cashBal);
    this.posSeq = s.posSeq;
    this.leverage.clear();
    for (const [key, lever] of s.leverage) this.leverage.set(key, d(lever));
    this.positions.clear();
    for (const p of s.positions) {
      this.positions.set(posKey(p.instId, p.mgnMode, p.posSide), {
        instId: p.instId, mgnMode: p.mgnMode, posId: p.posId, posSide: p.posSide, dir: p.dir, qty: d(p.qty), avgPx: d(p.avgPx), lever: d(p.lever),
        markPx: d(p.markPx), cTime: p.cTime, uTime: p.uTime, tradeId: p.tradeId, realizedPnl: d(p.realizedPnl), fee: d(p.fee), fundingFee: d(p.fundingFee),
      });
    }
  }

  markToMarket(instId: string, markPx: Dec): void {
    for (const p of this.positions.values()) if (p.instId === instId) p.markPx = markPx;
  }

  private upl(p: PositionRec): Dec {
    return p.markPx.sub(p.avgPx).mul(p.qty).mul(this.ctVal(p.instId)).mul(p.dir);
  }

  private margin(p: PositionRec): Dec {
    return p.qty.mul(this.ctVal(p.instId)).mul(p.avgPx).div(p.lever);
  }

  private notional(p: PositionRec): Dec {
    return p.qty.mul(this.ctVal(p.instId)).mul(p.markPx);
  }

  positionWire(p: PositionRec, now: number): OkxPosition {
    const upl = this.upl(p);
    const margin = this.margin(p);
    const notional = this.notional(p);
    const liq = p.avgPx.mul(d(1).sub(d('0.95').div(p.lever).mul(p.dir)));
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
      liqPx: num(liq),
      imr: num(margin),
      margin: num(margin),
      mgnRatio: '',
      mmr: num(notional.mul(MMR_RATE)),
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
    for (const p of this.positions.values()) {
      const u = this.upl(p);
      const m = this.margin(p);
      upl = upl.add(u);
      imr = imr.add(m);
      mmr = mmr.add(this.notional(p).mul(MMR_RATE));
      notional = notional.add(this.notional(p));
      if (p.mgnMode === 'isolated') {
        isoEq = isoEq.add(m).add(u);
        isoUpl = isoUpl.add(u);
      }
    }
    const eq = this.cashBal.add(upl);
    const availEq = eq.sub(imr).sub(ordFrozen);
    const mgnRatio = mmr.isZero() ? '' : fmt(eq.div(mmr), 4);
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
          frozenBal: fmt(imr.add(ordFrozen)),
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
