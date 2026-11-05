import { describe, expect, it } from 'vitest';
import { DIP_RULES, mtfFeatures, ruleHolds, type MtfBar, type MtfFrame } from '../src/mtf-features.js';

const H = 3_600_000;
const durOf: Record<MtfFrame, number> = { '1H': H, '4H': 4 * H, '1D': 24 * H, '1W': 168 * H };
/** 300 bars ending before T, closes rising by `step` each bar (or falling when negative), high/low 1 either side. */
function frames(T: number, step: number): Record<MtfFrame, MtfBar[]> {
  const out = {} as Record<MtfFrame, MtfBar[]>;
  for (const tf of ['1H', '4H', '1D', '1W'] as MtfFrame[]) {
    out[tf] = Array.from({ length: 300 }, (_, k): MtfBar => {
      const c = 1000 + step * k;
      return [T - (300 - k) * durOf[tf], String(c - step), String(c + 1), String(c - 1), String(c), '100'];
    });
  }
  return out;
}

describe('the multi-timeframe features', () => {
  const T = Date.UTC(2026, 10, 5);
  it('a steady rise: EMAs in bull order, the close at the top of its range, RSI 100, a rising EMA21', () => {
    const f = mtfFeatures(frames(T, 2), T);
    expect(f).not.toBeNull();
    for (const tf of ['1H', '4H', '1D', '1W']) {
      expect(f?.[`${tf}.align`]).toBe(1);
      expect(f?.[`${tf}.rsi`]).toBe(100);
      // the last 20 bars: lows from 1,559, highs to 1,599, the close 1,598
      expect(f?.[`${tf}.pos`]).toBeCloseTo(39 / 40, 9);
      expect(f?.[`${tf}.slope`]).toBeGreaterThan(0);
      expect(f?.[`${tf}.vol`]).toBe(1);
    }
  });

  it('uses only bars closed by T and needs 61 of them', () => {
    const fr = frames(T, 2);
    // the last weekly bar jumps; it closes at T, so one hour earlier it is not used yet
    const last = fr['1W'][299] as MtfBar;
    fr['1W'][299] = [last[0], last[1], '5000', last[3], '4990', last[5]];
    expect(mtfFeatures(fr, T)?.['1W.pos']).toBeCloseTo((4990 - 1559) / (5000 - 1559), 9);
    expect(mtfFeatures(fr, T - H)?.['1W.pos']).toBeCloseTo(39 / 40, 9);
    const short = { ...fr, '1W': fr['1W'].slice(-60) };
    expect(mtfFeatures(short, T)).toBeNull();
  });

  it('reads the rules: every condition must hold', () => {
    const f = { '1H.pos': 0.2, '1D.d21': -1.5, '1W.align': 1 };
    const rule = DIP_RULES[13];
    expect(rule).toEqual([['1H.pos', 'le', 0.2685337726523895], ['1D.d21', 'le', -1.0008905116174116], ['1W.align', 'eq', 1]]);
    expect(ruleHolds(f, rule ?? [])).toBe(true);
    expect(ruleHolds({ ...f, '1W.align': 0 }, rule ?? [])).toBe(false);
    expect(ruleHolds({ '1H.pos': 0.2 }, rule ?? [])).toBe(false);
  });
});
