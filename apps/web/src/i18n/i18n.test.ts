import { afterEach, describe, expect, it } from 'vitest';
import { ApiError } from '../lib/http';
import { en } from './en';
import { zh } from './zh';
import { LANG_KEY, browserLang, currentT, errorText, inEveryLang, labelOf, readStoredLang, rejectionText, riskText, useLangStore } from './index';

describe('language choice', () => {
  afterEach(() => {
    localStorage.clear();
    useLangStore.setState({ lang: 'en' });
  });

  it('starts from the browser language and keeps the choice in localStorage', () => {
    // jsdom reports en-US
    expect(browserLang()).toBe('en');
    expect(readStoredLang()).toBeNull();
    useLangStore.getState().setLang('zh');
    expect(localStorage.getItem(LANG_KEY)).toBe('zh');
    expect(readStoredLang()).toBe('zh');
    expect(currentT()).toBe(zh);
    useLangStore.getState().setLang('en');
    expect(currentT()).toBe(en);
    // anything else in storage is not a choice
    localStorage.setItem(LANG_KEY, 'fr');
    expect(readStoredLang()).toBeNull();
  });
});

describe('texts of the server in the language of the page', () => {
  it('errorText explains a known code in Chinese and keeps the server message for the specifics', () => {
    const refused = new ApiError('NO_PRICE', 'no reference price for BTC-USDT-SWAP', undefined, 503);
    expect(errorText(refused, en)).toBe('NO_PRICE: no reference price for BTC-USDT-SWAP');
    expect(errorText(refused, zh)).toBe('NO_PRICE: 暂无该合约的参考价格，或其行情已过期（no reference price for BTC-USDT-SWAP）');
    // a code the dictionary does not know, and anything that is not an API error: as it came
    expect(errorText(new ApiError('SOMETHING_NEW', 'HTTP 503', undefined, 503), zh)).toBe('SOMETHING_NEW: HTTP 503');
    expect(errorText(new Error('boom'), zh)).toBe('boom');
  });

  it('riskText words a rejection from its code and details in Chinese, and falls back to the server message', () => {
    const notional = { code: 'MAX_ORDER_NOTIONAL', message: 'order notional 6000.00 exceeds the limit 5000', details: { notional: '6000.00', limit: '5000' } };
    expect(riskText(notional, en)).toBe('order notional 6000.00 exceeds the limit 5000');
    expect(riskText(notional, zh)).toBe('订单名义价值 6000.00 超过单笔上限 5000');
    const band = { code: 'PRICE_BAND', message: 'x', details: { px: '70000', refPrice: '61000', deviationPct: '0.147541' } };
    expect(riskText(band, zh)).toBe('限价 70000 与标记价格 61000 相差 14.75%，超出价格偏离限制');
    expect(riskText({ code: 'FUTURE_RULE', message: 'a rule added later' }, zh)).toBe('a rule added later');
  });

  it('rejectionText reads the verdict a RISK_REJECTED error carries', () => {
    const rejected = new ApiError('RISK_REJECTED', 'risk check failed', { ok: false, code: 'MAX_LEVERAGE', message: 'leverage 20x exceeds the limit 10x', details: { lever: '20', limit: '10' } }, 422);
    expect(rejectionText(rejected, en)).toBe('leverage 20x exceeds the limit 10x');
    expect(rejectionText(rejected, zh)).toBe('杠杆 20x 超过上限 10x');
    expect(rejectionText(new ApiError('EXCHANGE', 'refused', undefined, 502), zh)).toBeNull();
  });

  it('labelOf names a known value and passes an unknown one through', () => {
    expect(labelOf(zh.enums.orderState, 'partially_filled')).toBe('部分成交');
    expect(labelOf(zh.enums.orderState, 'mmp_canceled')).toBe('mmp_canceled');
    expect(labelOf(en.enums.orderState, 'partially_filled')).toBe('partially_filled');
  });

  it('inEveryLang builds a text in both languages', () => {
    expect(inEveryLang((t) => t.ticket.errDuplicate)).toEqual({ en: en.ticket.errDuplicate, zh: zh.ticket.errDuplicate });
  });
});
