import { afterEach, describe, expect, it } from 'vitest';
import { ApiError } from '../lib/http';
import { en } from './en';
import { zh } from './zh';
import { LANG_KEY, browserLang, currentT, errorText, explainError, inEveryLang, labelOf, readStoredLang, rejectionText, riskText, useLangStore } from './index';

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
    // the notional rules are worded by the page in both languages, with the unit and separators
    expect(riskText(notional, en)).toBe("the order's notional 6,000.00 USDT is over the per-order limit of 5,000.00 USDT");
    expect(riskText(notional, zh)).toBe('订单名义价值 6,000.00 USDT 超过单笔上限 5,000.00 USDT');
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

describe('the campaign tab in both languages', () => {
  /** Dotted paths of every entry: the leaves are texts and functions. */
  const paths = (o: object, prefix = ''): string[] =>
    Object.entries(o).flatMap(([k, v]) => (typeof v === 'object' && v !== null ? paths(v as object, `${prefix}${k}.`) : [`${prefix}${k}`]));

  it('has the same entries in Chinese as in English', () => {
    expect(paths(zh.campaign).sort()).toEqual(paths(en.campaign).sort());
    expect(paths(zh.tabs).sort()).toEqual(paths(en.tabs).sort());
  });

  it('explains every status reason the API documents', () => {
    const codes = ['CAMPAIGN_DISABLED', 'LEDGER_UNREADABLE', 'ACCOUNT_NOT_DEDICATED', 'ACCOUNT_UNAVAILABLE', 'POT_FINISHED'];
    expect(Object.keys(en.campaign.reasons)).toEqual(codes);
    expect(Object.keys(zh.campaign.reasons)).toEqual(codes);
  });
});

describe('the signals, the confirmation sheet, the exits and the journal in both languages', () => {
  const paths = (o: object, prefix = ''): string[] =>
    Object.entries(o).flatMap(([k, v]) => (typeof v === 'object' && v !== null ? paths(v as object, `${prefix}${k}.`) : [`${prefix}${k}`]));

  it('has the same entries in Chinese as in English', () => {
    for (const section of ['signals', 'follow', 'exits', 'journal', 'common', 'toasts', 'errorWords'] as const) {
      expect(paths(zh[section]).sort()).toEqual(paths(en[section]).sort());
    }
    expect(Object.keys(zh.riskReject)).toEqual(expect.arrayContaining(Object.keys(en.riskReject)));
  });

  it('words every code the API documents', () => {
    const reasons = ['CLOSE_ABOVE_ENTRY', 'NEAR_ENTRY', 'MARK_ABOVE_ENTRY', 'BELOW_ENTRY', 'HOLDING', 'CLOSE_BELOW_EXIT', 'ADD_TRIGGER_REACHED', 'ADDS_OFF', 'ADD_REF_FROM_POSITION', 'SHORT_HELD', 'NOT_ENOUGH_BARS', 'BARS_UNAVAILABLE', 'NO_MARK_PRICE'];
    const warnings = ['STOP_NOT_BELOW_ENTRY', 'STOP_TOO_WIDE', 'STOP_TOO_NARROW', 'BELOW_MIN_ORDER', 'LIMITED_BY_ORDER_NOTIONAL', 'LIMITED_BY_POSITION_NOTIONAL', 'LIMITED_BY_TOTAL_NOTIONAL', 'OVER_ORDER_NOTIONAL', 'OVER_POSITION_NOTIONAL', 'OVER_TOTAL_NOTIONAL', 'SIGNAL_STALE', 'PRICE_FAR_ABOVE_SIGNAL', 'EQUITY_UNKNOWN', 'LINEAR_ONLY', 'LEVERAGE_REDUCED', 'LIQUIDATION_NEAR_STOP', 'NOT_TRACKED', 'CAMPAIGN_ACCOUNT', 'KILL_SWITCH'];
    const errors = ['EXITS_UNAVAILABLE', 'TP_LEG_TOO_SMALL', 'TP_TRIGGERS_NOT_DISTINCT', 'BREAKEVEN_NEEDS_SPLIT_TP', 'TP_EXCEEDS_POSITION', 'TRAILING_EXCEEDS_POSITION', 'CAMPAIGN_POSITION', 'TRAILING_STATE_UNREADABLE', 'TRADE_NOT_FOUND'];
    const kinds = ['order_placed', 'order_cancelled', 'fill', 'stop_placed', 'stop_moved', 'stop_triggered', 'stop_cancelled', 'tp_placed', 'tp_moved', 'tp_triggered', 'tp_cancelled', 'trailing_placed', 'trailing_moved', 'trailing_triggered', 'trailing_cancelled', 'liquidation', 'adopted', 'reconciled'];
    for (const t of [en, zh]) {
      expect(Object.keys(t.signals.reason).sort()).toEqual([...reasons].sort());
      expect(Object.keys(t.signals.warning).sort()).toEqual([...warnings].sort());
      expect(Object.keys(t.errorWords).sort()).toEqual([...errors].sort());
      expect(Object.keys(t.journal.event).sort()).toEqual([...kinds].sort());
      expect(Object.keys(t.journal.eventCode).sort()).toEqual(['POSITION_ADOPTED', 'POSITION_CLOSED', 'POSITION_GONE', 'SIZE_CORRECTED']);
      expect(Object.keys(t.journal.statusReason).sort()).toEqual(['JOURNAL_DISABLED', 'JOURNAL_STARTING', 'JOURNAL_UNREADABLE']);
      expect(Object.keys(t.journal.exitReason).sort()).toEqual(['adl', 'campaign', 'external', 'liquidation', 'manual', 'stop', 'take_profit', 'trailing', 'unknown']);
      expect(Object.keys(t.journal.source).sort()).toEqual(['campaign', 'external', 'manual', 'signal']);
      for (const code of ['TP_WRONG_SIDE', 'CALLBACK_RATIO', 'ACTIVE_PX_WRONG_SIDE']) expect(t.riskReject[code]).toBeDefined();
    }
    expect(zh.journal.source).toEqual({ manual: '手动', signal: '按信号', campaign: '滚仓', external: '外部' });
    expect(zh.tabs.journal).toBe('开仓记录');
    expect(zh.tabs.signals).toBe('信号');
  });

  it('explainError words the codes of the exits from their details, a risk verdict from its code, anything else as before', () => {
    const small = new ApiError('TP_LEG_TOO_SMALL', 'take-profit 2 comes to 0', { leg: 2, sz: '0', minSz: '1', orderSz: '1' }, 400);
    expect(explainError(small, zh)).toBe('止盈 2 只能平 0 张，低于最小下单量 1 张：请减少档数或增加数量。');
    const wrongSide = new ApiError('RISK_REJECTED', 'risk check failed', { ok: false, code: 'TP_WRONG_SIDE', message: 'x', details: { leg: 1, triggerPx: '60000', entryPx: '61000', markPx: '61000' } }, 422);
    expect(explainError(wrongSide, en)).toBe("Take-profit 1 at 60000 is on the wrong side: a long's take-profit must be above both the entry 61000 and the mark 61000 (a short's below both).");
    expect(explainError(new ApiError('NO_PRICE', 'no price', undefined, 503), en)).toBe('NO_PRICE: no price');
    expect(explainError(new ApiError('NO_PRICE', 'no price', undefined, 503), zh)).toBe('NO_PRICE: 暂无该合约的参考价格，或其行情已过期（no price）');
  });
});
