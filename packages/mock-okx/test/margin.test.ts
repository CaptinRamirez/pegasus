import { describe, expect, it } from 'vitest';
import { bankruptcyPx, fallbackMmr, liquidationPx, marginLevel } from '../src/engine/margin.js';
import { d } from '../src/num.js';

const MMR = d('0.005');
const FEE = d('0.0005');

describe('liquidation price of an isolated position (OKX, USDT-margined)', () => {
  it('a 10x long at 100 with mmr 0.5% and a taker fee of 0.05% is liquidated at about 90.50', () => {
    // margin 10 on one coin: (10 - 100) / (0.005 + 0.0005 - 1) = 90 / 0.9945
    const px = liquidationPx(1, d(10), d(1), d(100), MMR, FEE);
    expect(px.toFixed(2)).toBe('90.50');
    expect(px.toFixed(10)).toBe('90.4977375566');
  });

  it('the short is the mirror: (10 + 100) / (1 + 0.005 + 0.0005) = 110 / 1.0055', () => {
    expect(liquidationPx(-1, d(10), d(1), d(100), MMR, FEE).toFixed(10)).toBe('109.3983092989');
  });

  it('depends on the leverage through the margin, not on the size', () => {
    // 5x long at 200: margin 40 per coin; (40 - 200) / (0.01 + 0.0005 - 1) = 160 / 0.9895
    expect(liquidationPx(1, d(120), d(3), d(200), d('0.01'), FEE).toFixed(8)).toBe('161.69782719');
    expect(liquidationPx(1, d(40), d(1), d(200), d('0.01'), FEE).toFixed(8)).toBe('161.69782719');
    // 3x short at 50 on 20 coin: margin 1000 / 3; (333.33.. + 1000) / (20 x 1.007)
    expect(liquidationPx(-1, d(1000).div(3), d(20), d(50), d('0.0065'), FEE).toFixed(8)).toBe('66.20324396');
  });

  it('BTC: 50 contracts of 0.01 BTC at 60000 and 10x, mmr 0.4%; funding paid from the margin brings it closer', () => {
    // 0.5 BTC, notional 30000, margin 3000: (3000 - 30000) / (0.5 x (0.004 + 0.0005 - 1)) = 27000 / 0.49775
    expect(liquidationPx(1, d(3000), d('0.5'), d(60000), d('0.004'), FEE).toFixed(6)).toBe('54244.098443');
    // 30 USDT of funding later the margin is 2970: 27030 / 0.49775
    expect(liquidationPx(1, d(2970), d('0.5'), d(60000), d('0.004'), FEE).toFixed(6)).toBe('54304.369663');
  });

  it('is where the margin level is exactly 100%', () => {
    const long = liquidationPx(1, d(10), d(1), d(100), MMR, FEE);
    expect(marginLevel(d(10), long.sub(100), long, MMR, FEE).toFixed(20)).toBe('1.00000000000000000000');
    const short = liquidationPx(-1, d(10), d(1), d(100), MMR, FEE);
    expect(marginLevel(d(10), d(100).sub(short), short, MMR, FEE).toFixed(20)).toBe('1.00000000000000000000');
    // at the entry: 10 / (100 x 0.0055)
    expect(marginLevel(d(10), d(0), d(100), MMR, FEE).toFixed(8)).toBe('18.18181818');
  });

  it('a long whose margin covers its whole notional (1x) has none', () => {
    expect(liquidationPx(1, d(100), d(1), d(100), MMR, FEE).isZero()).toBe(true);
  });
});

describe('bankruptcy price', () => {
  it('is the price at which the loss and the fee of closing use up the margin exactly', () => {
    // long: (100 - 10) / (1 - 0.0005) = 90 / 0.9995; short: (100 + 10) / 1.0005
    const long = bankruptcyPx(1, d(10), d(1), d(100), FEE);
    expect(long.toFixed(10)).toBe('90.0450225113');
    expect(d(10).add(long.sub(100)).sub(long.mul(FEE)).abs().lt('1e-30')).toBe(true);
    const short = bankruptcyPx(-1, d(10), d(1), d(100), FEE);
    expect(short.toFixed(10)).toBe('109.9450274863');
    expect(d(10).add(d(100).sub(short)).sub(short.mul(FEE)).abs().lt('1e-30')).toBe(true);
  });

  it('lies beyond the liquidation price: what is left there goes to the exchange', () => {
    expect(bankruptcyPx(1, d(10), d(1), d(100), FEE).lt(liquidationPx(1, d(10), d(1), d(100), MMR, FEE))).toBe(true);
    expect(bankruptcyPx(-1, d(10), d(1), d(100), FEE).gt(liquidationPx(-1, d(10), d(1), d(100), MMR, FEE))).toBe(true);
  });
});

describe('fallback maintenance margin rate', () => {
  it('is half the initial margin rate of the highest leverage, never below the tier-1 rates OKX listed on 2026-10-05', () => {
    // [highest leverage, the highest tier-1 rate OKX had for an instrument of that leverage]
    const seen: Array<[string, string]> = [['100', '0.004'], ['75', '0.0065'], ['50', '0.01'], ['25', '0.02'], ['20', '0.02'], ['10', '0.05'], ['5', '0.05'], ['3', '0.1']];
    for (const [lever, okx] of seen) expect(fallbackMmr({ lever }).gte(okx), lever).toBe(true);
    expect(fallbackMmr({ lever: '100' }).toFixed()).toBe('0.005');
    expect(fallbackMmr({ lever: '50' }).toFixed()).toBe('0.01');
    // no usable leverage: the rate of 1x
    expect(fallbackMmr({ lever: '' }).toFixed()).toBe('0.5');
    expect(fallbackMmr({ lever: '0' }).toFixed()).toBe('0.5');
  });
});
