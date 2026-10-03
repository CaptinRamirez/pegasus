import { describe, expect, it } from 'vitest';
import {
  D,
  coinToContracts,
  contractsToCoin,
  floorToStep,
  normalizePrice,
  notionalQuote,
  quoteToContracts,
  sizeToContracts,
  SizingError,
  type Instrument,
} from '../src/index.js';

const BTC_USDT: Instrument = {
  instId: 'BTC-USDT-SWAP',
  instType: 'SWAP',
  uly: 'BTC-USDT',
  baseCcy: 'BTC',
  quoteCcy: 'USDT',
  settleCcy: 'USDT',
  ctVal: '0.01',
  ctValCcy: 'BTC',
  ctMult: '1',
  ctType: 'linear',
  lotSz: '0.1',
  minSz: '0.1',
  tickSz: '0.1',
  maxLmtSz: '100000',
  maxMktSz: '12000',
  maxLever: '100',
  state: 'live',
};

const BTC_USD: Instrument = {
  ...BTC_USDT,
  instId: 'BTC-USD-SWAP',
  uly: 'BTC-USD',
  quoteCcy: 'USD',
  settleCcy: 'BTC',
  ctVal: '100',
  ctValCcy: 'USD',
  ctType: 'inverse',
  lotSz: '1',
  minSz: '1',
};

describe('decimal helpers', () => {
  it('floors to step without float error', () => {
    expect(floorToStep('0.3', '0.1').toFixed()).toBe('0.3');
    expect(floorToStep('1.2345', '0.01').toFixed()).toBe('1.23');
    expect(floorToStep('0.29999999', '0.1').toFixed()).toBe('0.2');
  });
});

describe('linear contract sizing', () => {
  it('converts coin to contracts and back', () => {
    expect(coinToContracts('0.5', BTC_USDT).toFixed()).toBe('50');
    expect(contractsToCoin('50', BTC_USDT).toFixed()).toBe('0.5');
  });
  it('converts quote notional to contracts at a price', () => {
    // 1000 USDT at 50_000 -> 0.02 BTC -> 2 contracts
    expect(quoteToContracts('1000', '50000', BTC_USDT).toFixed()).toBe('2');
  });
  it('computes notional in quote', () => {
    expect(notionalQuote('2', '50000', BTC_USDT).toFixed()).toBe('1000');
    expect(notionalQuote('-2', '50000', BTC_USDT).toFixed()).toBe('1000');
  });
  it('rounds down to lot size and validates min', () => {
    const r = sizeToContracts({ unit: 'coin', value: '0.00123' }, BTC_USDT, 'limit', '50000');
    // 0.00123 BTC = 0.123 contracts -> floor to 0.1
    expect(r.sz).toBe('0.1');
    expect(r.coin.toFixed()).toBe('0.001');
    expect(() => sizeToContracts({ unit: 'coin', value: '0.0005' }, BTC_USDT, 'limit')).toThrowError(SizingError);
    try {
      sizeToContracts({ unit: 'coin', value: '0.0005' }, BTC_USDT, 'limit');
    } catch (e) {
      expect((e as SizingError).code).toBe('SIZE_BELOW_MIN');
    }
  });
  it('rejects sizes above the market max', () => {
    expect(() => sizeToContracts({ unit: 'contracts', value: '12000.1' }, BTC_USDT, 'market')).toThrow(/exceeds/);
    expect(sizeToContracts({ unit: 'contracts', value: '12000' }, BTC_USDT, 'market').sz).toBe('12000');
  });
  it('rejects non-positive sizes', () => {
    expect(() => sizeToContracts({ unit: 'contracts', value: '0' }, BTC_USDT, 'limit')).toThrow(/positive/);
  });
});

describe('inverse contract sizing', () => {
  it('needs a price to size from coin', () => {
    expect(() => coinToContracts('1', BTC_USD)).toThrow(SizingError);
    // 1 BTC at 50_000 = 50_000 USD = 500 contracts
    expect(coinToContracts('1', BTC_USD, '50000').toFixed()).toBe('500');
    expect(contractsToCoin('500', BTC_USD, '50000').toFixed()).toBe('1');
  });
  it('notional is contracts * ctVal regardless of price', () => {
    expect(notionalQuote('500', '12345', BTC_USD).toFixed()).toBe('50000');
  });
});

describe('price normalisation', () => {
  it('keeps prices already on tick', () => {
    expect(normalizePrice('50000.1', BTC_USDT, 'buy')).toBe('50000.1');
  });
  it('rounds buys down and sells up', () => {
    expect(normalizePrice('50000.17', BTC_USDT, 'buy')).toBe('50000.1');
    expect(normalizePrice('50000.12', BTC_USDT, 'sell')).toBe('50000.2');
  });
  it('rejects non-positive', () => {
    expect(() => normalizePrice('0', BTC_USDT, 'buy')).toThrow(SizingError);
  });
  it('D handles strings exactly', () => {
    expect(D('0.1').plus('0.2').toFixed()).toBe('0.3');
  });
});
