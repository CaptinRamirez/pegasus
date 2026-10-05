import { readFileSync, writeFileSync } from 'node:fs';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { d, type OkxBalanceDetail, type OkxOrder, type OkxPosition } from '@pegasus/mock-okx/engine';
import type { PaperExchange } from '../src/index.js';
import { BTC, ETH, FakeHistory, MIN, T0, bar, open, place, quote, spec, stopAt, tempStateFile, type Opened } from './helpers.js';

const HOUR = 60 * MIN;
/** The settlement after T0. */
const T8 = T0 + 8 * HOUR;

const usdt = (paper: PaperExchange): OkxBalanceDetail => {
  const detail = paper.engine.state().balance.details[0];
  if (!detail) throw new Error('no balance');
  return detail;
};
const position = (paper: PaperExchange, instId = BTC): OkxPosition | undefined => paper.engine.state().positions.find((p) => p.instId === instId && p.mgnMode === 'isolated');
const liquidation = (paper: PaperExchange): OkxOrder | undefined => paper.engine.state().orders.find((o) => o.category === 'full_liquidation');

/**
 * A 10x isolated long of 10 contracts (0.1 BTC) bought at the quoted ask 60000.1: notional 6000.01, margin 600.001,
 * taker fee 3.000005. With the maintenance margin rate 0.5% it is liquidated at
 * (600.001 - 6000.01) / (0.1 x (0.005 + 0.0005 - 1)) = 54298.733..; the account then holds 100000 - 3.000005 - 600.001.
 */
function long10(paper: PaperExchange, extra: Record<string, unknown> = {}): void {
  paper.engine.setLeverage(BTC, 'isolated', d(10), undefined);
  expect(place(paper, { tdMode: 'isolated', side: 'buy', ordType: 'market', sz: '10', ...extra }).sCode).toBe('0');
}
const LIQ_PX = '54298.73303167';
const CASH_OPEN = '99996.999995';
const CASH_LIQUIDATED = '99396.998995';

/** Closes the program at `at` with what `prepare` left in the account, and opens it again at `reopenAt` over `history`. */
async function restart(prepare: (o: Opened) => void, history: FakeHistory, reopenAt: number, at = T0 + 30_000): Promise<Opened> {
  vi.setSystemTime(at);
  const first = open();
  quote(first.paper, BTC, 60000);
  prepare(first);
  first.paper.close();
  vi.setSystemTime(reopenAt);
  const second = open({ stateFile: first.stateFile, history });
  await second.paper.catchUp();
  return second;
}

describe('isolated margin on the paper exchange', () => {
  beforeEach(() => {
    vi.useFakeTimers({ now: T0 + 30 * MIN });
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('a 10x isolated long holds its margin apart; the quoted mark reaching the liquidation price takes it, and the file has it', () => {
    const { paper, stateFile } = open();
    quote(paper, BTC, 60000);
    long10(paper);
    expect(position(paper)).toMatchObject({ pos: '10', avgPx: '60000.1', lever: '10', margin: '600.001', imr: '', liqPx: LIQ_PX });
    expect(usdt(paper)).toMatchObject({ cashBal: CASH_OPEN, availEq: CASH_LIQUIDATED, isoEq: '599.991' });
    expect(JSON.parse(readFileSync(stateFile, 'utf8'))).toMatchObject({ account: { positions: [{ instId: BTC, mgnMode: 'isolated', qty: '10', margin: '600.001' }] } });

    vi.setSystemTime(T0 + 31 * MIN);
    quote(paper, BTC, 54298.8);
    expect(position(paper)).toMatchObject({ pos: '10', markPx: '54298.8' });
    vi.setSystemTime(T0 + 32 * MIN);
    quote(paper, BTC, 54298.7);
    expect(paper.engine.state().positions).toEqual([]);
    expect(usdt(paper)).toMatchObject({ cashBal: CASH_LIQUIDATED, availEq: CASH_LIQUIDATED, isoEq: '0' });
    // taken over at the bankruptcy price (6000.01 - 600.001) / (0.1 x 0.9995): the loss and the fee there are the margin
    expect(liquidation(paper)).toMatchObject({ instId: BTC, tdMode: 'isolated', side: 'sell', sz: '10', state: 'filled', avgPx: '54027.10355178', fee: '-2.70135518', pnl: '-597.29964482', tradeId: '0', uTime: String(T0 + 32 * MIN) });
    expect(paper.engine.state().fills[0]).toMatchObject({ subType: '107', execType: '', fillMarkPx: '54298.7' });
    expect(JSON.parse(readFileSync(stateFile, 'utf8'))).toMatchObject({ account: { cashBal: CASH_LIQUIDATED, positions: [], liquidated: [[`${BTC}|isolated|net`, T0 + 30 * MIN, T0 + 32 * MIN]] } });
  });

  it('a new account starts with the configured balance, and a pot of 56 USDT carries a 10x isolated long of its size', () => {
    // TRX as OKX lists it: 1000 TRX per contract, lots of 0.01, tick 0.00001, 50x at most, tier-1 rate 0.65%
    const TRX = 'TRX-USDT-SWAP';
    const { paper, stateFile } = open({ initialBalance: '56', instruments: [spec(TRX, { ctVal: '1000', lotSz: '0.01', minSz: '0.01', tickSz: '0.00001', lever: '50' })], mmr: { [TRX]: '0.0065' } });
    expect(paper.restored).toBe(false);
    expect(paper.engine.state().balance.totalEq).toBe('56');
    paper.onBook(TRX, [['0.3', '500', '0', '1']], [['0.30001', '500', '0', '1']]);
    paper.onMark(TRX, '0.3');
    paper.onLast(TRX, '0.3');
    paper.engine.setLeverage(TRX, 'isolated', d(10), undefined);
    const buy = (sz: string) => paper.engine.matcher.place({ instId: TRX, tdMode: 'isolated', side: 'buy', ordType: 'market', sz });
    // 1.87 contracts: margin 56.10187. 1.86: margin 55.80186, and the fee 0.2790093 no longer fits
    expect(buy('1.87').sCode).toBe('51008');
    expect(buy('1.86').sCode).toBe('51008');
    // 1.8 contracts, 1800 TRX at 0.30001: notional 540.018, margin 54.0018, fee 0.270009
    expect(buy('1.8').sCode).toBe('0');
    // (54.0018 - 540.018) / (1800 x (0.0065 + 0.0005 - 1))
    expect(position(paper, TRX)).toMatchObject({ pos: '1.8', lever: '10', margin: '54.0018', liqPx: '0.27191239' });
    expect(usdt(paper)).toMatchObject({ cashBal: '55.729991', availEq: '1.728191' });
    expect(JSON.parse(readFileSync(stateFile, 'utf8'))).toMatchObject({ initialBalance: '56' });
    // the pot can lose this margin and nothing more
    paper.onMark(TRX, '0.27191');
    expect(paper.engine.state().positions).toEqual([]);
    expect(usdt(paper)).toMatchObject({ cashBal: '1.728191', availEq: '1.728191' });
  });

  it('funding of an isolated position is settled with its margin: the liquidation price moves, the balance available does not', async () => {
    const { paper, history } = open();
    quote(paper, BTC, 60000);
    long10(paper);
    history.fundingRows = [{ fundingTime: T8, rate: '0.0001' }];
    history.marks.set(T8, '61000');
    vi.setSystemTime(T8 + MIN);
    expect(await paper.funding.settle(Date.now())).toBe(1);
    // 0.1 BTC x 61000 x 0.0001 = 0.61 from the margin; (599.391 - 6000.01) / (0.1 x -0.9945)
    expect(position(paper)).toMatchObject({ margin: '599.391', fundingFee: '-0.61', liqPx: '54304.86676722' });
    expect(usdt(paper)).toMatchObject({ cashBal: '99996.389995', availEq: CASH_LIQUIDATED });
    expect(paper.funding.state.ledger).toMatchObject([{ instId: BTC, mgnMode: 'isolated', amount: '-0.61' }]);
    // a mark between the two liquidation prices now liquidates; what is lost is the margin that was left
    quote(paper, BTC, 54300);
    expect(paper.engine.state().positions).toEqual([]);
    expect(usdt(paper)).toMatchObject({ cashBal: CASH_LIQUIDATED });
  });
});

describe('liquidation in the time the program was closed', () => {
  beforeEach(() => {
    vi.useFakeTimers({ now: T0 });
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('liquidates in the first bar whose mark low reached the liquidation price, before the stop and the orders of that bar', async () => {
    const prepare = (o: Opened): void => {
      long10(o.paper, stopAt('59000'));
      expect(place(o.paper, { tdMode: 'isolated', side: 'sell', ordType: 'limit', px: '65000', sz: '10', reduceOnly: true, clOrdId: 'tp1' }).sCode).toBe('0');
    };
    // the low is through the stop at 59000 and through the liquidation price: the liquidation is taken
    const history = new FakeHistory();
    history.trade = [bar(T0 + MIN, '59500', '59600', '54000', '54500')];
    const { paper, logs } = await restart(prepare, history, T0 + 10 * MIN);
    expect(paper.engine.state().positions).toEqual([]);
    expect(paper.engine.state().stops).toEqual([]);
    expect(liquidation(paper)).toMatchObject({ side: 'sell', sz: '10', state: 'filled', avgPx: '54027.10355178', uTime: String(T0 + 2 * MIN), fillTime: String(T0 + 2 * MIN) });
    expect(paper.engine.state().fills[0]).toMatchObject({ subType: '107', fillMarkPx: LIQ_PX, ts: String(T0 + 2 * MIN) });
    expect(paper.engine.state().orders.find((o) => o.clOrdId === 'tp1')).toMatchObject({ state: 'canceled', cancelSource: '3', uTime: String(T0 + 2 * MIN) });
    // the stop did not sell
    expect(paper.engine.state().orders.filter((o) => o.side === 'sell' && o.state === 'filled' && o.category === 'normal')).toEqual([]);
    expect(usdt(paper)).toMatchObject({ cashBal: CASH_LIQUIDATED, availEq: CASH_LIQUIDATED });
    expect(logs.some((l) => l.includes('0 resting order(s) filled, 0 stop(s) triggered, 1 position(s) liquidated'))).toBe(true);
    expect(paper.engine.now()).toBe(T0 + 10 * MIN);

    // a low through the stop only: the stop closes at its trigger, and the margin comes back with the loss taken from the balance
    const stopped = new FakeHistory();
    stopped.trade = [bar(T0 + MIN, '59500', '59600', '58900', '59100')];
    const second = await restart(prepare, stopped, T0 + 10 * MIN);
    expect(liquidation(second.paper)).toBeUndefined();
    expect(second.paper.engine.state().orders.find((o) => o.side === 'sell' && o.state === 'filled')).toMatchObject({ avgPx: '59000', reduceOnly: 'true', category: 'normal' });
    // 0.1 BTC x (59000 - 60000.1) = -100.01, taker fee 2.95
    expect(usdt(second.paper)).toMatchObject({ cashBal: '99894.039995', isoEq: '0' });
  });

  it('takes the mark price bars, not the traded prices; a bar that stays above the liquidation price changes nothing', async () => {
    const history = new FakeHistory();
    history.trade = [bar(T0 + MIN, '59500', '59600', '54000', '54600'), bar(T0 + 2 * MIN, '54600', '54700', '54200', '54650'), bar(T0 + 3 * MIN, '54650', '54700', '54600', '54650')];
    // the trades went through the liquidation price in the first bar, the mark only in the second
    history.mark = [bar(T0 + MIN, '59500', '59600', '54298.8', '54600'), bar(T0 + 2 * MIN, '54600', '54700', '54298.7', '54650'), bar(T0 + 3 * MIN, '54650', '54700', '54600', '54650')];
    const { paper } = await restart((o) => long10(o.paper), history, T0 + 10 * MIN);
    expect(liquidation(paper)).toMatchObject({ uTime: String(T0 + 3 * MIN) });
    expect(usdt(paper)).toMatchObject({ cashBal: CASH_LIQUIDATED });

    const calm = new FakeHistory();
    calm.trade = [bar(T0 + MIN, '59500', '59600', '54298.8', '55000')];
    const kept = await restart((o) => long10(o.paper), calm, T0 + 10 * MIN);
    // an isolated position alone is a reason to read the history: its price is watched even without an order or a stop
    expect(calm.barReads.map((r) => [r.kind, r.instId])).toEqual([['trade', BTC], ['mark', BTC]]);
    expect(position(kept.paper)).toMatchObject({ pos: '10', margin: '600.001', markPx: '55000' });
    expect(kept.logs.some((l) => l.includes('0 position(s) liquidated'))).toBe(true);
  });

  it('an entry filled in a bar that also reached the liquidation price of what it opened is liquidated in that bar', async () => {
    const prepare = (o: Opened): void => {
      o.paper.engine.setLeverage(BTC, 'isolated', d(10), undefined);
      expect(place(o.paper, { tdMode: 'isolated', side: 'buy', ordType: 'limit', px: '59900', sz: '10', clOrdId: 'entry1' }).sCode).toBe('0');
    };
    const history = new FakeHistory();
    history.trade = [bar(T0, '60000', '60010', '59990', '60000'), bar(T0 + MIN, '60000', '60010', '54000', '54500')];
    const { paper, logs } = await restart(prepare, history, T0 + 10 * MIN);
    expect(paper.engine.state().orders.find((o) => o.clOrdId === 'entry1')).toMatchObject({ state: 'filled', avgPx: '59900', execType: 'M', uTime: String(T0 + 2 * MIN) });
    // filled at 59900 as maker (fee 1.198), margin 599, liquidation price 5391 / 0.09945 = 54208.14..: the low 54000 is below it
    expect(liquidation(paper)).toMatchObject({ sz: '10', uTime: String(T0 + 2 * MIN) });
    expect(paper.engine.state().positions).toEqual([]);
    expect(usdt(paper)).toMatchObject({ cashBal: '99399.802' });
    expect(logs.some((l) => l.includes('1 resting order(s) filled, 0 stop(s) triggered, 1 position(s) liquidated'))).toBe(true);

    const above = new FakeHistory();
    above.trade = [bar(T0, '60000', '60010', '59990', '60000'), bar(T0 + MIN, '60000', '60010', '54300', '54500')];
    const kept = await restart(prepare, above, T0 + 10 * MIN);
    expect(position(kept.paper)).toMatchObject({ pos: '10', avgPx: '59900', margin: '599', liqPx: '54208.14479638' });
  });

  it('a long outage of the feed is replayed the same way before the position is watched live again', async () => {
    const history = new FakeHistory();
    const { paper } = open({ history });
    quote(paper, BTC, 60000);
    long10(paper);
    paper.onFeedDown();
    vi.setSystemTime(T0 + 5 * MIN);
    history.trade = [bar(T0 + 2 * MIN, '59500', '59600', '54000', '59800')];
    quote(paper, BTC, 59800);
    await vi.advanceTimersByTimeAsync(0);
    expect(paper.engine.state().positions).toEqual([]);
    expect(liquidation(paper)).toMatchObject({ uTime: String(T0 + 3 * MIN) });
    expect(paper.markets.get(BTC)?.live).toBe(true);
  });

  it('margin moved by hand and the leverage set are kept in the file: the replay liquidates by the margin the position really holds', async () => {
    // 50x with the margin topped up to a stake of 600: 6000.01 / 50 = 120.0002 posted by the order, 479.9998 added
    const prepare = (o: Opened): void => {
      o.paper.engine.setLeverage(BTC, 'isolated', d(50), undefined);
      expect(place(o.paper, { tdMode: 'isolated', side: 'buy', ordType: 'market', sz: '10' }).sCode).toBe('0');
      expect(position(o.paper)).toMatchObject({ lever: '50', margin: '120.0002', liqPx: '59125.28707893' });
      expect(o.paper.engine.adjustMargin({ instId: BTC, type: 'add', amt: '479.9998' }).code).toBe('0');
      o.paper.save();
    };
    // a low of 57000 is far through the liquidation price of the bare 50x position, and far above the one of the stake
    const history = new FakeHistory();
    history.trade = [bar(T0 + MIN, '59500', '59600', '57000', '58000')];
    const { paper, stateFile } = await restart(prepare, history, T0 + 10 * MIN);
    expect(position(paper)).toMatchObject({ pos: '10', lever: '50', margin: '600', liqPx: '54298.74308698', markPx: '58000' });
    expect(liquidation(paper)).toBeUndefined();
    expect(JSON.parse(readFileSync(stateFile, 'utf8'))).toMatchObject({ account: { leverage: [[`${BTC}|isolated|net`, '50']], positions: [{ lever: '50', margin: '600' }] } });
    // what can be taken out is what it holds beyond 0.1 BTC x 58000 / 50 = 116, less the open loss of 200.01
    expect(paper.engine.adjustMargin({ instId: BTC, type: 'reduce', amt: '284' }).code).toBe('59301');
    expect(paper.engine.adjustMargin({ instId: BTC, type: 'reduce', amt: '283.99' }).code).toBe('0');
    expect(position(paper)).toMatchObject({ margin: '316.01' });
  });

  it('funding that fell due before a liquidation of the same gap is not charged on top of the lost margin', async () => {
    const history = new FakeHistory();
    history.fundingRows = [{ fundingTime: T8, rate: '0.0001' }];
    history.marks.set(T8, '60000');
    history.trade = [bar(T8 + HOUR, '56000', '56100', '54000', '54500')];
    const { paper, logs, stateFile } = await restart((o) => long10(o.paper), history, T8 + 2 * HOUR, T0 + HOUR);
    expect(liquidation(paper)).toMatchObject({ uTime: String(T8 + HOUR + MIN) });
    // the position was held at the settlement, and its margin, which would have paid it, is gone whole
    expect(paper.funding.state.ledger).toEqual([]);
    expect(logs.some((l) => l.includes('not booked'))).toBe(true);
    expect(usdt(paper)).toMatchObject({ cashBal: CASH_LIQUIDATED });
    expect(paper.funding.state.lastSettled[BTC]).toBe(T8);
    // and it stays that way after another restart
    paper.close();
    const again = open({ stateFile, history });
    await again.paper.catchUp();
    expect(again.paper.funding.state.ledger).toEqual([]);
    expect(usdt(again.paper)).toMatchObject({ cashBal: CASH_LIQUIDATED });
  });

  it('funding paid in the gap brings the liquidation price up: a mark of the gap between the two is a liquidation', async () => {
    const bars = [bar(T8 - HOUR, '56000', '56100', '54300', '55000')];
    // without the payment the low 54300 stays above 54298.73
    const calm = new FakeHistory();
    calm.trade = bars;
    const kept = await restart((o) => long10(o.paper), calm, T8 + 2 * HOUR, T0 + HOUR);
    expect(position(kept.paper)).toMatchObject({ pos: '10', margin: '600.001' });

    // 0.61 of funding at 08:00 leaves a margin of 599.391 and a liquidation price of 54304.87
    const history = new FakeHistory();
    history.trade = bars;
    history.fundingRows = [{ fundingTime: T8, rate: '0.0001' }];
    history.marks.set(T8, '61000');
    const { paper, logs } = await restart((o) => long10(o.paper), history, T8 + 2 * HOUR, T0 + HOUR);
    expect(paper.funding.state.ledger).toMatchObject([{ fundingTime: T8, mgnMode: 'isolated', amount: '-0.61' }]);
    expect(paper.engine.state().positions).toEqual([]);
    expect(liquidation(paper)).toMatchObject({ uTime: String(T8 + 2 * HOUR) });
    expect(logs.some((l) => l.includes('with the funding of the replayed time taken from the margin'))).toBe(true);
    // the payment came out of the margin, and the rest of the margin went with the liquidation
    expect(usdt(paper)).toMatchObject({ cashBal: CASH_LIQUIDATED });
  });
});

/**
 * An account file exactly as the paper exchange wrote it before isolated margin and liquidation were simulated:
 * positions without `margin`, orders without `category`, fills without `subType`, no `liquidated`. It holds a cross
 * BTC long of 10 contracts with its stop, a resting BTC order, and an isolated ETH short of 20 contracts at 5x.
 */
const OLD_ACCOUNT_FILE =
  '{"version":1,"createdAt":1791160200000,"initialBalance":"50000","posMode":"net_mode","lastSeen":{"BTC-USDT-SWAP":1791160200000,"ETH-USDT-SWAP":1791160200000},"account":{"cashBal":"49996.700005","posSeq":2,"leverage":[["ETH-USDT-SWAP|isolated|net","5"]],"positions":[{"instId":"BTC-USDT-SWAP","mgnMode":"cross","posId":"1900000000000001","posSide":"net","dir":1,"qty":"10","avgPx":"60000.1","lever":"3","markPx":"60000","cTime":1791160200000,"uTime":1791160200000,"tradeId":"1791160200000001","realizedPnl":"0","fee":"-3.000005","fundingFee":"0"},{"instId":"ETH-USDT-SWAP","mgnMode":"isolated","posId":"1900000000000002","posSide":"net","dir":-1,"qty":"20","avgPx":"2999.9","lever":"5","markPx":"3000","cTime":1791160200000,"uTime":1791160200000,"tradeId":"1791160200000001","realizedPnl":"0","fee":"-0.29999","fundingFee":"0"}]},"orders":{"live":[{"ordId":"1700000000000002","clOrdId":"resting1","tag":"","instId":"BTC-USDT-SWAP","tdMode":"cross","side":"buy","posSide":"net","ordType":"limit","px":"58000","sz":"5","accFillSz":"0","avgPx":"0","state":"live","lever":"3","reduceOnly":false,"fee":"0","pnl":"0","cTime":1791160200000,"uTime":1791160200000,"cancelSource":"","cancelSourceReason":"","lastFill":null,"amendResult":"","reqId":"","attachSl":null}],"history":[{"ordId":"1700000000000001","clOrdId":"","tag":"","instId":"BTC-USDT-SWAP","tdMode":"cross","side":"buy","posSide":"net","ordType":"market","px":null,"sz":"10","accFillSz":"10","avgPx":"60000.1","state":"filled","lever":"3","reduceOnly":false,"fee":"-3.000005","pnl":"0","cTime":1791160200000,"uTime":1791160200000,"cancelSource":"","cancelSourceReason":"","lastFill":{"px":"60000.1","sz":"10","time":1791160200000,"tradeId":"1791160200000001","execType":"T","fee":"-3.000005","pnl":"0"},"amendResult":"","reqId":"","attachSl":{"attachAlgoId":"2000000000000001","attachAlgoClOrdId":"","slTriggerPx":"59000","slOrdPx":"-1","slTriggerPxType":"mark"}},{"ordId":"1700000000000003","clOrdId":"","tag":"","instId":"ETH-USDT-SWAP","tdMode":"isolated","side":"sell","posSide":"net","ordType":"market","px":null,"sz":"20","accFillSz":"20","avgPx":"2999.9","state":"filled","lever":"5","reduceOnly":false,"fee":"-0.29999","pnl":"0","cTime":1791160200000,"uTime":1791160200000,"cancelSource":"","cancelSourceReason":"","lastFill":{"px":"2999.9","sz":"20","time":1791160200000,"tradeId":"1791160200000001","execType":"T","fee":"-0.29999","pnl":"0"},"amendResult":"","reqId":"","attachSl":null}],"fills":[{"instType":"SWAP","instId":"BTC-USDT-SWAP","tradeId":"1791160200000001","ordId":"1700000000000001","clOrdId":"","billId":"1800000000000001","tag":"","fillPx":"60000.1","fillSz":"10","fillIdxPx":"60000","fillPnl":"0","fillPxVol":"","fillPxUsd":"","fillMarkVol":"","fillFwdPx":"","fillMarkPx":"60000","side":"buy","posSide":"net","execType":"T","feeCcy":"USDT","fee":"-3.000005","ts":"1791160200000","fillTime":"1791160200000"},{"instType":"SWAP","instId":"ETH-USDT-SWAP","tradeId":"1791160200000001","ordId":"1700000000000003","clOrdId":"","billId":"1800000000000002","tag":"","fillPx":"2999.9","fillSz":"20","fillIdxPx":"3000","fillPnl":"0","fillPxVol":"","fillPxUsd":"","fillMarkVol":"","fillFwdPx":"","fillMarkPx":"3000","side":"sell","posSide":"net","execType":"T","feeCcy":"USDT","fee":"-0.29999","ts":"1791160200000","fillTime":"1791160200000"}],"stops":[{"algoId":"2000000000000001","algoClOrdId":"","ordId":"1700000000000001","instId":"BTC-USDT-SWAP","tdMode":"cross","posSide":"net","side":"sell","sz":"10","slTriggerPx":"59000","slOrdPx":"-1","slTriggerPxType":"mark","cTime":1791160200000,"uTime":1791160200000}],"ordSeq":3,"billSeq":2,"algoSeq":1},"funding":{"lastSettled":{},"sizeLog":{"BTC-USDT-SWAP|cross|net":[{"ts":1791160200000,"pos":"10"}],"ETH-USDT-SWAP|isolated|net":[{"ts":1791160200000,"pos":"-20"}]},"ledger":[]}}\n';

describe('an account file from before isolated margin', () => {
  beforeEach(() => {
    vi.useFakeTimers({ now: T0 + 30 * MIN + 5_000 });
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('loads as it was: the cross position, its stop and the resting order untouched, the isolated position with its initial margin', async () => {
    const stateFile = tempStateFile();
    writeFileSync(stateFile, OLD_ACCOUNT_FILE);
    const { paper } = open({ stateFile, initialBalance: '999' });
    expect(paper.restored).toBe(true);
    const state = paper.engine.state();
    expect(usdt(paper)).toMatchObject({ cashBal: '49996.700005' });
    // the cross long reports what it did: requirement 6000.01 / 3 in imr and margin, no margin level
    expect(state.positions.find((p) => p.instId === BTC)).toMatchObject({ mgnMode: 'cross', pos: '10', avgPx: '60000.1', lever: '3', imr: '2000.00333333', margin: '2000.00333333', mgnRatio: '', fee: '-3.000005' });
    // the isolated short had no margin of its own in the file: 20 x 0.01 x 2999.9 / 5
    expect(position(paper, ETH)).toMatchObject({ pos: '-20', avgPx: '2999.9', lever: '5', margin: '119.996', imr: '' });
    expect(state.stops).toEqual([{ algoId: '2000000000000001', algoClOrdId: '', ordId: '1700000000000001', instId: BTC, tdMode: 'cross', posSide: 'net', side: 'sell', sz: '10', slTriggerPx: '59000', slTriggerPxType: 'mark' }]);
    expect(state.orders.map((o) => [o.ordId, o.clOrdId, o.state, o.tdMode, o.category])).toEqual([
      ['1700000000000002', 'resting1', 'live', 'cross', 'normal'],
      ['1700000000000003', '', 'filled', 'isolated', 'normal'],
      ['1700000000000001', '', 'filled', 'cross', 'normal'],
    ]);
    expect(state.fills.map((f) => [f.billId, f.fillPx, f.subType])).toEqual([['1800000000000002', '2999.9', undefined], ['1800000000000001', '60000.1', undefined]]);
    // equity 49996.670005, less the isolated 119.976, the cross requirement and the resting order (6000.01 / 3 + 2900 / 3)
    expect(usdt(paper)).toMatchObject({ eq: '49996.670005', isoEq: '119.976', availEq: '46910.024005' });
    expect(paper.engine.leverageInfo(ETH, 'isolated')).toEqual([{ instId: ETH, mgnMode: 'isolated', posSide: 'net', lever: '5' }]);

    // it goes on from there: nothing in the few seconds since, the next order continues the numbering, the file is written in the new form
    await paper.catchUp();
    quote(paper, BTC, 60000);
    quote(paper, ETH, 3000);
    const ack = place(paper, { side: 'sell', ordType: 'limit', px: '65000', sz: '1' });
    expect(ack.ordId).toBe('1700000000000004');
    const saved = JSON.parse(readFileSync(stateFile, 'utf8')) as { version: number; account: { positions: Array<Record<string, unknown>> } };
    expect(saved.version).toBe(1);
    expect(saved.account.positions.map((p) => [p['instId'], p['margin']])).toEqual([[BTC, undefined], [ETH, '119.996']]);
    expect(readFileSync(`${stateFile}.bak`, 'utf8')).toBe(OLD_ACCOUNT_FILE);

    // and the isolated short is now liquidated at (119.996 + 599.98) / (0.2 x 1.0055) = 3580.18..
    quote(paper, ETH, 3580.1);
    expect(position(paper, ETH)).toMatchObject({ pos: '-20' });
    quote(paper, ETH, 3580.2);
    expect(position(paper, ETH)).toBeUndefined();
    expect(paper.engine.state().positions.map((p) => p.instId)).toEqual([BTC]);
    expect(d(usdt(paper).cashBal).toFixed()).toBe(d('49996.700005').sub('119.996').toFixed());
  });
});
