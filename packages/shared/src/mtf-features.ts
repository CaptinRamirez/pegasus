import { D, ZERO, type Decimal } from './decimal.js';

/**
 * The 36 multi-timeframe features of docs/proposals/mtf-reversal-2026-11.md, computed as its study did (scratchpad
 * mtflib.py): per frame (1H, 4H, 1D, 1W) at its last bar closed by a time T. EMA(n) seeded with the mean of the first n
 * closes; RSI14 and ATR14 Wilder's, the ATR's first value the mean of the first 14 true ranges (the first bar's is its
 * range); MACD 12/26 with a 9-bar signal seeded the same way. A frame needs 61 bars up to its bar. The values are numbers
 * for comparing with the rules' thresholds only, never for money. The rules of the fifth paper book (DIP_RULES) were
 * chosen on Binance spot 2018-2023 (docs/proposals/audit-2026-11-05.md, gap 3).
 */

export type MtfFrame = '1H' | '4H' | '1D' | '1W';
export const MTF_FRAMES: readonly MtfFrame[] = ['1H', '4H', '1D', '1W'];
export const MTF_DUR: Record<MtfFrame, number> = { '1H': 3_600_000, '4H': 14_400_000, '1D': 86_400_000, '1W': 604_800_000 };
/** A closed bar: open time (ms), open, high, low, close, volume in the quote currency. */
export type MtfBar = [ts: number, open: string, high: string, low: string, close: string, volume: string];
export type MtfFeatures = Record<string, number>;
export type MtfRule = ReadonlyArray<readonly [key: string, op: 'le' | 'ge' | 'gt' | 'eq', value: number]>;

export function emaSeq(v: readonly Decimal[], n: number): Array<Decimal | null> {
  const out: Array<Decimal | null> = v.map(() => null);
  if (v.length < n) return out;
  const k = D(2).div(n + 1);
  let e = v.slice(0, n).reduce<Decimal>((s, x) => s.plus(x), ZERO).div(n);
  out[n - 1] = e;
  for (let i = n; i < v.length; i++) {
    e = (v[i] as Decimal).minus(e).mul(k).plus(e);
    out[i] = e;
  }
  return out;
}

export function rsiSeq(v: readonly Decimal[], n = 14): Array<Decimal | null> {
  const out: Array<Decimal | null> = v.map(() => null);
  let g = ZERO;
  let l = ZERO;
  for (let i = 1; i < v.length; i++) {
    const d = (v[i] as Decimal).minus(v[i - 1] as Decimal);
    const up = d.gt(0) ? d : ZERO;
    const down = d.lt(0) ? d.neg() : ZERO;
    if (i <= n) {
      g = g.plus(up);
      l = l.plus(down);
      if (i < n) continue;
      g = g.div(n);
      l = l.div(n);
    } else {
      g = g.mul(n - 1).plus(up).div(n);
      l = l.mul(n - 1).plus(down).div(n);
    }
    out[i] = l.isZero() ? D(100) : D(100).minus(D(100).div(g.div(l).plus(1)));
  }
  return out;
}

export function atrSeq(b: readonly MtfBar[], n = 14): Array<Decimal | null> {
  const out: Array<Decimal | null> = b.map(() => null);
  let a = ZERO;
  for (let i = 0; i < b.length; i++) {
    const [, , h, l] = b[i] as MtfBar;
    const prev = i > 0 ? D((b[i - 1] as MtfBar)[4]) : null;
    const tr = prev === null ? D(h).minus(l) : Decimal_max(D(h).minus(l), D(h).minus(prev).abs(), D(l).minus(prev).abs());
    if (i < n) {
      a = a.plus(tr);
      if (i === n - 1) {
        a = a.div(n);
        out[i] = a;
      }
    } else {
      a = a.mul(n - 1).plus(tr).div(n);
      out[i] = a;
    }
  }
  return out;
}

const Decimal_max = (...xs: Decimal[]): Decimal => xs.reduce((m, x) => (x.gt(m) ? x : m));

/** The nine features of one frame at bar j; null with too little history. */
export function frameFeatures(b: readonly MtfBar[], j: number): Record<string, number> | null {
  if (j < 60 || j >= b.length) return null;
  const upto = b.slice(0, j + 1);
  const c = upto.map((x) => D(x[4]));
  const e5 = emaSeq(c, 5), e10 = emaSeq(c, 10), e21 = emaSeq(c, 21), e50 = emaSeq(c, 50);
  const f12 = emaSeq(c, 12), s26 = emaSeq(c, 26);
  const line = f12.map((f, i) => (f !== null && s26[i] !== null && s26[i] !== undefined ? f.minus(s26[i] as Decimal) : null));
  const i0 = line.findIndex((x) => x !== null);
  const sig: Array<Decimal | null> = [...Array<null>(i0).fill(null), ...emaSeq(line.slice(i0) as Decimal[], 9)];
  const at = atrSeq(upto)[j], r = rsiSeq(c)[j], ln = line[j], sg = sig[j];
  const ej5 = e5[j], ej10 = e10[j], ej21 = e21[j], ej50 = e50[j], e21b = e21[j - 3];
  if (!at || !at.gt(0) || !ej50 || !ln || !sg || !r || !ej5 || !ej10 || !ej21 || !e21b) return null;
  const win = upto.slice(j - 19, j + 1);
  const hi = Decimal_max(...win.map((x) => D(x[2])));
  const lo = win.map((x) => D(x[3])).reduce((m, x) => (x.lt(m) ? x : m));
  const cj = c[j] as Decimal;
  const v20 = upto.slice(j - 20, j).reduce<Decimal>((s, x) => s.plus(x[5]), ZERO).div(20);
  const bar = upto[j] as MtfBar;
  return {
    pos: (hi.gt(lo) ? cj.minus(lo).div(hi.minus(lo)) : D('0.5')).toNumber(),
    rsi: r.toNumber(),
    macd: ln.minus(sg).div(at).toNumber(),
    d21: cj.minus(ej21).div(at).toNumber(),
    d50: cj.minus(ej50).div(at).toNumber(),
    align: ej5.gt(ej10) && ej10.gt(ej21) ? 1 : ej5.lt(ej10) && ej10.lt(ej21) ? -1 : 0,
    slope: ej21.minus(e21b).div(at).toNumber(),
    vol: (v20.gt(0) ? D(bar[5]).div(v20) : D(1)).toNumber(),
    ret: cj.minus(bar[1]).div(at).toNumber(),
  };
}

/** The 36 features at T: each frame at its last bar closed by T (open time + the frame's length ≤ T). null when a frame lacks history. */
export function mtfFeatures(frames: Readonly<Record<MtfFrame, readonly MtfBar[]>>, T: number): MtfFeatures | null {
  const out: MtfFeatures = {};
  for (const tf of MTF_FRAMES) {
    const b = frames[tf];
    let j = -1;
    for (let i = b.length - 1; i >= 0; i--) {
      if ((b[i] as MtfBar)[0] + MTF_DUR[tf] <= T) {
        j = i;
        break;
      }
    }
    const f = frameFeatures(b, j);
    if (f === null) return null;
    for (const [k, v] of Object.entries(f)) out[`${tf}.${k}`] = v;
  }
  return out;
}

export function ruleHolds(f: MtfFeatures, rule: MtfRule): boolean {
  return rule.every(([key, op, v]) => {
    const x = f[key];
    if (x === undefined) return false;
    return op === 'le' ? x <= v : op === 'ge' ? x >= v : op === 'gt' ? x > v : x === v;
  });
}

/** The 20 long rules of the fifth book: a 5-day long that won in training (docs/proposals/paper-books-2026-11.md). */
export const DIP_RULES: readonly MtfRule[] = [
  [['1H.macd', 'gt', 0.0087084699915366], ['1H.d50', 'le', 0.08671836973576091], ['4H.vol', 'ge', 1.0892574641233486]],
  [['1D.d21', 'le', -1.0008905116174116], ['1D.ret', 'le', 0.017025471779477747], ['1W.slope', 'ge', 0.32986414406415404]],
  [['4H.rsi', 'le', 40.54000420910345], ['4H.macd', 'gt', 0.007595891833106188], ['1W.rsi', 'gt', 48.68916097570652]],
  [['4H.d50', 'le', -1.615047548871631], ['1D.vol', 'le', 0.8699382980990308], ['1W.rsi', 'ge', 60.593690499255075]],
  [['1D.pos', 'le', 0.22707711803997147], ['1D.rsi', 'le', 39.956130722606936], ['1W.vol', 'ge', 1.5181809461446836]],
  [['4H.d21', 'le', -0.9318628106567437], ['1D.d21', 'le', -1.0008905116174116], ['1W.vol', 'ge', 1.5181809461446836]],
  [['1D.d21', 'le', -1.0008905116174116], ['1W.slope', 'ge', 0.32986414406415404], ['1W.ret', 'le', 0.01549627552489154]],
  [['1D.rsi', 'le', 39.956130722606936], ['1D.ret', 'le', 0.017025471779477747], ['1W.vol', 'ge', 1.5181809461446836]],
  [['1H.macd', 'gt', 0.0087084699915366], ['4H.vol', 'ge', 1.0892574641233486], ['1D.ret', 'le', 0.017025471779477747]],
  [['4H.rsi', 'le', 40.54000420910345], ['4H.macd', 'gt', 0.007595891833106188], ['1W.align', 'eq', 1]],
  [['4H.rsi', 'le', 40.54000420910345], ['1D.vol', 'le', 0.8699382980990308], ['1W.rsi', 'ge', 60.593690499255075]],
  [['4H.slope', 'le', -0.2776040158642018], ['4H.vol', 'ge', 1.0892574641233486], ['1W.rsi', 'le', 40.03870501830153]],
  [['4H.d50', 'le', -1.615047548871631], ['1D.rsi', 'le', 39.956130722606936], ['1W.vol', 'ge', 1.5181809461446836]],
  [['1H.pos', 'le', 0.2685337726523895], ['1D.d21', 'le', -1.0008905116174116], ['1W.align', 'eq', 1]],
  [['4H.slope', 'le', -0.2776040158642018], ['4H.vol', 'ge', 1.0892574641233486], ['1W.pos', 'le', 0.15397999130056542]],
  [['4H.d50', 'le', -1.615047548871631], ['1D.vol', 'le', 0.8699382980990308], ['1W.slope', 'ge', 0.32986414406415404]],
  [['1H.pos', 'le', 0.2685337726523895], ['1H.vol', 'ge', 1.1320533837029312], ['1W.d21', 'le', -0.9900446701510559]],
  [['1H.align', 'eq', -1], ['1D.d21', 'le', -1.0008905116174116], ['1W.vol', 'ge', 1.5181809461446836]],
  [['4H.pos', 'le', 0.2463768115942043], ['1D.slope', 'le', -0.2957580637695918], ['1W.align', 'eq', 1]],
  [['4H.macd', 'gt', 0.007595891833106188], ['4H.d21', 'le', -0.9318628106567437], ['1W.slope', 'gt', -0.019689529138368033]],
];

/** The fifth book's coins: the 30 OKX USDT swaps of its test, in this order (signals beyond its free slots are taken in it). */
export const DIP_COINS: readonly string[] = ['ETH', 'BTC', 'SOL', 'XRP', 'DOGE', 'NEAR', 'UNI', 'LINK', 'ADA', 'FIL', 'BCH', 'AAVE', 'AVAX', 'LTC', 'XLM', 'DOT', 'TRX', 'OP', 'CRV', 'SAND', 'SHIB', 'ALGO', 'ATOM', 'ETC', 'BAT', 'ICP', 'PEOPLE', 'APE', 'XTZ', 'CFX'];
