import { describe, expect, it } from 'vitest';
import type { JournalPage } from '@pegasus/shared';
import { en } from '../i18n/en';
import { zh } from '../i18n/zh';
import { BTC, ETH } from '../test/campaign-fixtures';
import { adoptedTrade, closedManualDetail, closedManualTrade, journalPage, openSignalDetail, openSignalTrade } from '../test/journal-fixtures';
import { eventSentence, exitPlanText, fmtR, tradePlanText } from './describe';
import { NO_FILTER, journalQuery, mergeJournal, tradeForLink } from './journal';

describe('the journal list', () => {
  it('asks the server for the filters and the page before', () => {
    expect(journalQuery(NO_FILTER, null)).toEqual({ limit: 50 });
    expect(journalQuery({ status: 'open', instId: 'BTC-USDT-SWAP', source: 'signal' }, 9)).toEqual({ limit: 50, status: 'open', instId: 'BTC-USDT-SWAP', source: 'signal', before: 9 });
  });

  it('keeps the newest version of every trade, newest trade first; a trade the socket brought joins only where it belongs', () => {
    const page: JournalPage = { ...journalPage, trades: [closedManualTrade, adoptedTrade], next: 8, total: 6 };
    const newer = { ...adoptedTrade, size: '10', updatedAt: adoptedTrade.updatedAt + 1 };
    const older = { ...closedManualTrade, netPnl: '0', updatedAt: closedManualTrade.updatedAt - 1 };
    const fresh = openSignalTrade; // seq 12: newer than the oldest loaded
    const ancient = { ...openSignalTrade, id: '3-BTC-USDT-SWAP', seq: 3 }; // older than the pages loaded: it comes with its page
    const rows = mergeJournal([page], { [newer.id]: newer, [older.id]: older, [fresh.id]: fresh, [ancient.id]: ancient }, NO_FILTER);
    expect(rows.map((r) => r.id)).toEqual(['12-BTC-USDT-SWAP', '11-ETH-USDT-SWAP', '9-XRP-USDT-SWAP']);
    expect(rows[1]?.netPnl).toBe(closedManualTrade.netPnl);
    expect(rows[2]?.size).toBe('10');
    // every page loaded: the old one joins too
    expect(mergeJournal([{ ...page, next: null }], { [ancient.id]: ancient }, NO_FILTER).map((r) => r.seq)).toEqual([11, 9, 3]);
    // an open trade that closed leaves the "open" list
    const closed = { ...adoptedTrade, status: 'closed' as const, updatedAt: adoptedTrade.updatedAt + 5 };
    expect(mergeJournal([{ ...page, trades: [adoptedTrade] }], { [closed.id]: closed }, { ...NO_FILTER, status: 'open' })).toEqual([]);
  });

  it('finds the trade an order went into: of its instrument, margin mode and leg, the open one first', () => {
    const link = { kind: 'journal' as const, instId: 'BTC-USDT-SWAP', mgnMode: 'isolated' as const, posSide: 'net' as const, ordId: 'o' };
    const older = { ...openSignalTrade, id: '2-BTC-USDT-SWAP', seq: 2, status: 'closed' as const };
    expect(tradeForLink([older, openSignalTrade, closedManualTrade], link)?.id).toBe('12-BTC-USDT-SWAP');
    expect(tradeForLink([older], link)?.id).toBe('2-BTC-USDT-SWAP');
    expect(tradeForLink([closedManualTrade], link)).toBeNull();
  });
});

describe('a trade in words', () => {
  it('the exit plan and the R multiple', () => {
    expect(exitPlanText(openSignalTrade.plan ?? {}, BTC, en)).toBe('no take-profit; trailing stop at the 10-day low');
    expect(tradePlanText(closedManualTrade.plan ?? { slTriggerPx: null, takeProfits: [], breakevenAfterTp1: false, trailing: null, signal: null }, ETH, zh)).toBe(
      '止损 2,950；止盈 3,150（50%）、3,240（剩余）；第一档止盈后止损移到成本价；不设移动止损',
    );
    expect(fmtR('2.8957')).toBe('+2.90R');
    expect(fmtR('-1')).toBe('-1.00R');
    expect(fmtR(null)).toBe('');
  });

  it('every event of the timeline as a sentence, in English and in Chinese', () => {
    const say = (lang: typeof en) => closedManualDetail.timeline.map((e) => eventSentence(e, ETH, 'USDT', lang));
    expect(say(en)).toEqual([
      'Order placed: buy 10 contracts at market (Manual); stop 2,950; take-profit 3,150 (50%), 3,240 (rest); stop to the entry after the first take-profit; no trailing stop.',
      'Fill (open): buy 10 contracts at 3,012.4, fee 1.5062 USDT.',
      'Stop-loss placed at 2,950 for 10 contracts.',
      'Take-profit 1 placed at 3,150 for 5 contracts.',
      'Take-profit 2 placed at 3,240 for 5 contracts.',
      'Take-profit 1 triggered at 3,150.',
      'Fill (reduce): sell 5 contracts at 3,151.2, fee 0.7878 USDT, P&L +69.40 USDT — take-profit 1.',
      'Stop-loss moved 2,950 → 3,012.4.',
      'Take-profit 2 triggered at 3,240.',
      'Fill (close): sell 5 contracts at 3,241.2, fee 0.8103 USDT, P&L +114.40 USDT — take-profit 2.',
      'Stop-loss at 3,012.4 cancelled: the position was closed by then.',
    ]);
    expect(say(zh)[6]).toBe('成交（减仓）：卖出 5 张，价格 3,151.2，手续费 0.7878 USDT，盈亏 +69.40 USDT — 止盈 1。');
    expect(eventSentence({ ts: 1, kind: 'reconciled', code: 'POSITION_GONE' }, ETH, 'USDT', zh)).toBe('与交易所核对：仓位已不存在，且没有成交说明原因。');
    expect(eventSentence({ ts: 1, kind: 'adopted', px: '0.622', contracts: '30', code: 'POSITION_ADOPTED' }, undefined, 'USDT', en)).toBe('Found open: 30 contracts at 0.622 (the journal had not seen it open).');
    expect(openSignalDetail.timeline.map((e) => eventSentence(e, BTC, 'USDT', en))[3]).toBe('Trailing stop placed at 58,900 for 4 contracts.');
  });
});
