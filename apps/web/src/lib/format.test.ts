import { describe, expect, it } from 'vitest';
import { D, type Instrument } from '@pegasus/shared';
import { DASH, fmtContracts, fmtPx } from './format';

const btc: Instrument = {
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
  lotSz: '0.01',
  minSz: '0.01',
  tickSz: '0.1',
  maxLmtSz: '100000',
  maxMktSz: '10000',
  maxLever: '100',
  state: 'live',
};

describe('fmtPx without an instrument (a position or order outside the tracked list)', () => {
  it('prints small prices as they are instead of rounding them to a 0.01 tick', () => {
    expect(fmtPx('0.0000085')).toBe('0.0000085');
    expect(fmtPx('0.1289')).toBe('0.1289');
    expect(fmtPx('0.15234')).toBe('0.15234');
    expect(fmtPx('0.15234', null)).toBe('0.15234');
  });

  it('keeps ordinary prices readable and a long computed value bounded', () => {
    expect(fmtPx('61234.5')).toBe('61,234.5');
    expect(fmtPx('3000')).toBe('3,000');
    expect(fmtPx(D(1).div(3))).toBe('0.33333333');
    expect(fmtPx(D('61234.123456789'))).toBe('61,234.123');
    expect(fmtPx('123456789.126')).toBe('123,456,789');
    expect(fmtPx('')).toBe(DASH);
  });

  it('still formats to the tick size when the instrument is known', () => {
    expect(fmtPx('61234.56', btc)).toBe('61,234.6');
    expect(fmtPx('0.15234', btc)).toBe('0.2');
  });
});

describe('fmtContracts without an instrument', () => {
  it('prints the exact size instead of rounding it to whole contracts', () => {
    expect(fmtContracts('0.5')).toBe('0.5');
    expect(fmtContracts('0.4')).toBe('0.4');
    expect(fmtContracts('1234.25', null)).toBe('1,234.25');
    expect(fmtContracts('')).toBe(DASH);
  });

  it('still formats to the lot size when the instrument is known', () => {
    expect(fmtContracts('0.567', btc)).toBe('0.57');
  });
});
