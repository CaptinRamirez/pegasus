import { describe, expect, it } from 'vitest';
import { bankruptcyPx } from '../src/engine/margin.js';
import { d, fmt } from '../src/num.js';
import type { OkxBalance, OkxOrder, OkxPosition } from '../src/wire.js';
import { ABC, T0, XYZ, rig, type Rig } from './engine-helpers.js';

const TEN = d(10);

describe('isolated margin: open, add, reduce, close', () => {
  it('a 10x isolated long holds notional / leverage as its margin, and the available balance falls by it', () => {
    const r = rig();
    expect(r.engine.setLeverage(ABC, 'isolated', TEN, undefined)).toEqual([{ instId: ABC, mgnMode: 'isolated', posSide: 'net', lever: '10' }]);
    const ack = r.place({ side: 'buy', ordType: 'market', sz: '2' });
    expect(ack.sCode).toBe('0');
    // 2 coin at 100: notional 200, margin 20, taker fee 0.1
    expect(r.order(ack.ordId)).toMatchObject({ state: 'filled', tdMode: 'isolated', lever: '10', avgPx: '100', fee: '-0.1', category: 'normal' });
    expect(r.position()).toMatchObject({
      mgnMode: 'isolated', posSide: 'net', pos: '2', avgPx: '100', lever: '10', margin: '20', imr: '',
      // (20 - 200) / (2 x (0.005 + 0.0005 - 1)); 20 / (200 x 0.0055); 200 x 0.005
      liqPx: '90.49773756', mgnRatio: '18.18181818', mmr: '1', upl: '0', uplRatio: '0', notionalUsd: '200',
    });
    expect(r.usdt()).toMatchObject({ cashBal: '999.9', eq: '999.9', availEq: '979.9', availBal: '979.9', isoEq: '20', isoUpl: '0', frozenBal: '20', imr: '0', mmr: '0', mgnRatio: '', ordFrozen: '0' });

    // a gain of the isolated position is equity, but nothing of it is available before it is realised
    r.move('110');
    expect(r.position()).toMatchObject({ markPx: '110', upl: '20', uplRatio: '1', margin: '20', liqPx: '90.49773756', mgnRatio: '33.05785124', mmr: '1.1' });
    expect(r.usdt()).toMatchObject({ cashBal: '999.9', eq: '1019.9', availEq: '979.9', isoEq: '40', isoUpl: '20', upl: '20' });
    expect(r.engine.balance().totalEq).toBe('1019.9');
  });

  it('adding posts the notional of what is added; reducing gives the same share of the margin back; closing returns the rest', () => {
    const r = rig();
    r.engine.setLeverage(ABC, 'isolated', TEN, undefined);
    r.place({ side: 'buy', ordType: 'market', sz: '2' });
    r.move('110');
    // 2 more at 110: margin 20 + 22, average 105, fee 0.11
    expect(r.place({ side: 'buy', ordType: 'market', sz: '2' }).sCode).toBe('0');
    // (42 - 420) / (4 x -0.9945) = 378 / 3.978
    expect(r.position()).toMatchObject({ pos: '4', avgPx: '105', margin: '42', liqPx: '95.02262443', upl: '20' });
    expect(r.usdt()).toMatchObject({ cashBal: '999.79', availEq: '957.79', isoEq: '62', frozenBal: '42' });

    r.move('120');
    // a quarter of the position: a quarter of the margin (10.5) comes back, with the profit 15 less the fee 0.06
    const reduce = r.place({ side: 'sell', ordType: 'market', sz: '1', reduceOnly: true });
    expect(r.order(reduce.ordId)).toMatchObject({ state: 'filled', pnl: '15', fee: '-0.06', reduceOnly: 'true' });
    expect(r.position()).toMatchObject({ pos: '3', avgPx: '105', margin: '31.5', liqPx: '95.02262443', pnl: '15' });
    expect(r.usdt()).toMatchObject({ cashBal: '1014.73', availEq: '983.23', isoEq: '76.5', frozenBal: '31.5' });

    // the rest: profit 45, fee 0.18
    expect(r.engine.matcher.closePosition({ instId: ABC, mgnMode: 'isolated' }).code).toBe('0');
    expect(r.engine.positions()).toEqual([]);
    expect(r.usdt()).toMatchObject({ cashBal: '1059.55', eq: '1059.55', availEq: '1059.55', isoEq: '0', frozenBal: '0' });
  });

  it('net mode: an order through the position closes it, returns its margin and opens the other side with its own', () => {
    const r = rig();
    r.place({ side: 'buy', ordType: 'market', sz: '2' });
    r.move('95');
    // 2 closed at a loss of 10, 3 opened short at 95: margin 28.5; fee on all 5: 0.2375
    expect(r.place({ side: 'sell', ordType: 'market', sz: '5' }).sCode).toBe('0');
    // (28.5 + 285) / (3 x 1.0055)
    expect(r.position()).toMatchObject({ pos: '-3', avgPx: '95', margin: '28.5', liqPx: '103.92839383' });
    expect(r.usdt()).toMatchObject({ cashBal: '989.6625', availEq: '961.1625' });
  });

  it('long/short mode: each side is a position with its own margin, at the leverage set for that side', () => {
    const r = rig({ posMode: 'long_short_mode' });
    r.engine.setLeverage(ABC, 'isolated', TEN, 'long');
    r.engine.setLeverage(ABC, 'isolated', d(5), 'short');
    expect(r.engine.leverageInfo(ABC, 'isolated').map((l) => [l.posSide, l.lever])).toEqual([['long', '10'], ['short', '5']]);
    expect(r.place({ side: 'buy', posSide: 'long', ordType: 'market', sz: '2' }).sCode).toBe('0');
    expect(r.place({ side: 'sell', posSide: 'short', ordType: 'market', sz: '1' }).sCode).toBe('0');
    expect(r.position(ABC, 'isolated', 'long')).toMatchObject({ pos: '2', lever: '10', margin: '20', liqPx: '90.49773756' });
    // 100 / 5 = 20; (20 + 100) / 1.0055
    expect(r.position(ABC, 'isolated', 'short')).toMatchObject({ pos: '1', lever: '5', margin: '20', liqPx: '119.34361014' });
    expect(r.usdt()).toMatchObject({ isoEq: '40', availEq: '959.85' });
  });

  it('an isolated order needs its margin and its fee in the available balance', () => {
    const r = rig({ balance: '56' });
    // 5.6 coin: margin 56, which leaves nothing for the fee
    expect(r.place({ side: 'buy', ordType: 'market', sz: '5.6' })).toMatchObject({ sCode: '51008' });
    // 5.5 coin: margin 55 and fee 0.275
    expect(r.place({ side: 'buy', ordType: 'market', sz: '5.5' }).sCode).toBe('0');
    expect(r.usdt()).toMatchObject({ cashBal: '55.725', availEq: '0.725', isoEq: '55' });
    expect(r.place({ side: 'buy', ordType: 'market', sz: '0.1' }).sCode).toBe('51008');
    // a resting order reserves the margin it would post
    const other = r.engine.matcher.place({ instId: XYZ, tdMode: 'isolated', side: 'buy', ordType: 'limit', px: '40', sz: '0.1' });
    expect(other.sCode).toBe('0');
    expect(r.usdt()).toMatchObject({ ordFrozen: '0.4', availEq: '0.325' });
    // reducing needs none
    expect(r.place({ side: 'sell', ordType: 'market', sz: '5.5', reduceOnly: true }).sCode).toBe('0');
  });

  it('a cross and an isolated position of one instrument are two positions; the cross one reports what it always did', () => {
    const r = rig();
    expect(r.place({ tdMode: 'cross', side: 'buy', ordType: 'market', sz: '2' }).sCode).toBe('0');
    expect(r.place({ side: 'buy', ordType: 'market', sz: '1' }).sCode).toBe('0');
    expect(r.engine.positions(ABC).map((p) => [p.mgnMode, p.pos])).toEqual([['cross', '2'], ['isolated', '1']]);
    // the requirement in both imr and margin, no margin level, the rough liquidation estimate 100 x (1 - 0.95 / 10), mmr at 0.4%
    expect(r.position(ABC, 'cross')).toMatchObject({ pos: '2', lever: '10', imr: '20', margin: '20', mgnRatio: '', liqPx: '90.5', mmr: '0.8', upl: '0' });
    // equity 999.85 less the isolated 10 over the cross mmr 0.8
    expect(r.usdt()).toMatchObject({ cashBal: '999.85', availEq: '969.85', imr: '20', mmr: '0.8', isoEq: '10', frozenBal: '30', mgnRatio: '1237.3125' });
  });
});

describe('liquidation of an isolated position', () => {
  /** Engine events in the order they were emitted. */
  function record(r: ReturnType<typeof rig>): { orders: OkxOrder[]; positions: OkxPosition[][]; balances: OkxBalance[]; kinds: string[] } {
    const seen = { orders: [] as OkxOrder[], positions: [] as OkxPosition[][], balances: [] as OkxBalance[], kinds: [] as string[] };
    r.engine.on('order', (o) => {
      seen.orders.push(o);
      seen.kinds.push(`order:${o.category}:${o.state}`);
    });
    r.engine.on('positions', ({ positions }) => {
      seen.positions.push(positions);
      seen.kinds.push('positions');
    });
    r.engine.on('account', (b) => {
      seen.balances.push(b);
      seen.kinds.push('account');
    });
    return seen;
  }

  it('the mark reaching the liquidation price closes the position: the whole margin is lost, and the account sees it as OKX shows it', () => {
    const r = rig();
    const entry = r.place({ side: 'buy', ordType: 'market', sz: '2' });
    const posId = r.position()?.posId;
    // liquidation price 90.4977..: one tick above it nothing happens, whatever the last price does
    r.mark('90.5');
    expect(r.position()).toMatchObject({ pos: '2', markPx: '90.5', upl: '-19', mgnRatio: '1.00452034' });
    r.abc.set('80');
    r.mark('90.5');
    expect(r.position()).toMatchObject({ pos: '2' });

    const seen = record(r);
    r.engine.clockOverride = T0 + 60_000;
    r.mark('90.49');
    expect(r.engine.positions()).toEqual([]);
    // 999.9 after the entry fee, less the margin of 20: nothing else, and nothing stays frozen
    expect(r.usdt()).toMatchObject({ cashBal: '979.9', eq: '979.9', availEq: '979.9', isoEq: '0', frozenBal: '0', upl: '0' });

    // taken over at the bankruptcy price 180 / (2 x 0.9995), where the loss and the taker fee are the margin
    const px = bankruptcyPx(1, d(20), d(2), d(100), d('0.0005'));
    const fee = px.mul(2).mul('0.0005').neg();
    const liquidation = r.engine.state().orders.find((o) => o.category === 'full_liquidation');
    expect(liquidation).toMatchObject({
      instId: ABC, tdMode: 'isolated', side: 'sell', posSide: 'net', ordType: 'market', px: '', sz: '2', accFillSz: '2', state: 'filled', reduceOnly: 'true', lever: '10',
      clOrdId: '', category: 'full_liquidation', avgPx: '90.04502251', fillPx: '90.04502251', fillSz: '2', fee: '-0.09004502', pnl: '-19.90995498',
      // OKX: the trade id of a liquidation is 0 on the order, and it is neither a taker nor a maker fill
      tradeId: '0', execType: '', cTime: String(T0 + 60_000), uTime: String(T0 + 60_000), fillTime: String(T0 + 60_000),
    });
    expect(liquidation?.avgPx).toBe(fmt(px));
    expect(liquidation?.fee).toBe(fmt(fee));
    expect(liquidation?.pnl).toBe(fmt(d(-20).sub(fee)));
    expect(liquidation?.ordId).not.toBe(entry.ordId);

    // the fill: a negative trade id, transaction type 107 (liquidation sell), no taker / maker, the mark that triggered it
    const [fill] = r.engine.fills(ABC, 1);
    expect(fill).toMatchObject({ ordId: liquidation?.ordId, subType: '107', execType: '', side: 'sell', posSide: 'net', fillPx: '90.04502251', fillSz: '2', fee: '-0.09004502', fillPnl: '-19.90995498', fillMarkPx: '90.49', ts: String(T0 + 60_000) });
    expect(fill?.tradeId).toMatch(/^-\d+$/);
    // the fill of the entry is an ordinary buy
    expect(r.engine.fills(ABC, 2)[1]).toMatchObject({ ordId: entry.ordId, subType: '1', execType: 'T' });

    // what the private channels carry: the order, the position at zero, the balance without the margin
    expect(seen.kinds).toEqual(['order:full_liquidation:filled', 'positions', 'account']);
    expect(seen.orders[0]).toMatchObject({ category: 'full_liquidation', tradeId: '0', fillSz: '2' });
    expect(seen.positions[0]).toMatchObject([{ posId, instId: ABC, mgnMode: 'isolated', pos: '0', margin: '', liqPx: '', pnl: '-19.90995498', fee: '-0.19004502', realizedPnl: '-20.1', uTime: String(T0 + 60_000) }]);
    expect(seen.balances[0]?.details[0]).toMatchObject({ cashBal: '979.9', availEq: '979.9' });
    expect(seen.balances[0]?.totalEq).toBe('979.9');
  });

  it('a short is the mirror: it is liquidated when the mark rises to its liquidation price', () => {
    const r = rig();
    r.place({ side: 'sell', ordType: 'market', sz: '2' });
    // (20 + 200) / (2 x 1.0055)
    expect(r.position()).toMatchObject({ pos: '-2', margin: '20', liqPx: '109.3983093' });
    r.mark('109.39');
    expect(r.position()).toMatchObject({ pos: '-2' });
    r.mark('109.4');
    expect(r.engine.positions()).toEqual([]);
    expect(r.usdt()).toMatchObject({ cashBal: '979.9', availEq: '979.9' });
    // bought back at 220 / (2 x 1.0005)
    expect(r.engine.state().orders.find((o) => o.category === 'full_liquidation')).toMatchObject({ side: 'buy', sz: '2', avgPx: '109.94502749', fee: '-0.10994503', pnl: '-19.89005497' });
    expect(r.engine.fills(ABC, 1)[0]).toMatchObject({ subType: '106' });
  });

  it('the loss is the margin however far the mark has gone, and the liquidation comes before the stop and the resting orders of the same move', () => {
    const r = rig();
    const entry = r.place({ side: 'buy', ordType: 'market', sz: '2', attachAlgoOrds: [{ slTriggerPx: '95', slOrdPx: '-1', slTriggerPxType: 'mark' }] });
    expect(r.engine.state().stops).toMatchObject([{ ordId: entry.ordId, side: 'sell', sz: '2', slTriggerPx: '95' }]);
    const takeProfit = r.place({ side: 'sell', ordType: 'limit', px: '120', sz: '2', reduceOnly: true });
    const add = r.place({ side: 'buy', ordType: 'limit', px: '92', sz: '1' });
    // not of this position: the other margin mode, and another instrument
    const cross = r.place({ tdMode: 'cross', side: 'buy', ordType: 'limit', px: '50', sz: '1' });
    const elsewhere = r.engine.matcher.place({ instId: XYZ, tdMode: 'isolated', side: 'buy', ordType: 'limit', px: '40', sz: '1' });
    expect([takeProfit.sCode, add.sCode, cross.sCode, elsewhere.sCode]).toEqual(['0', '0', '0', '0']);

    // one move takes the book and the mark through the add order, the stop and the liquidation price
    r.move('70');
    expect(r.engine.positions()).toEqual([]);
    // 1000 - 0.1 - 20: neither the stop's close at 70 (a loss of 60) nor the add order happened
    expect(r.usdt()).toMatchObject({ cashBal: '979.9', ordFrozen: '9' });
    expect(r.order(takeProfit.ordId)).toMatchObject({ state: 'canceled', cancelSource: '3' });
    expect(r.order(add.ordId)).toMatchObject({ state: 'canceled', cancelSource: '3', accFillSz: '0' });
    expect(r.order(add.ordId)?.cancelSourceReason).toMatch(/forced-liquidation risk/);
    expect(r.engine.state().stops).toEqual([]);
    expect(r.order(cross.ordId)).toMatchObject({ state: 'live' });
    expect(r.order(elsewhere.ordId)).toMatchObject({ state: 'live' });
    expect(r.engine.state().orders.filter((o) => o.category === 'full_liquidation')).toHaveLength(1);
    expect(r.engine.state().orders.filter((o) => o.side === 'sell' && o.state === 'filled' && o.category === 'normal')).toEqual([]);
  });

  it('long/short mode: only the side whose price was reached is liquidated', () => {
    const r = rig({ posMode: 'long_short_mode' });
    r.place({ side: 'buy', posSide: 'long', ordType: 'market', sz: '2' });
    r.place({ side: 'sell', posSide: 'short', ordType: 'market', sz: '1' });
    const hedge = r.place({ side: 'sell', posSide: 'short', ordType: 'limit', px: '130', sz: '1' });
    r.mark('90');
    expect(r.engine.positions().map((p) => [p.posSide, p.pos])).toEqual([['short', '1']]);
    expect(r.engine.fills(ABC, 1)[0]).toMatchObject({ subType: '104', side: 'sell', posSide: 'long' });
    expect(r.order(hedge.ordId)).toMatchObject({ state: 'live' });
    // 1000 less the two entry fees (0.1 and 0.05) and the margin of the long
    expect(r.usdt()).toMatchObject({ cashBal: '979.85' });
  });

  it('a cross position is not liquidated by the same move, and a market without a price liquidates nothing', () => {
    const r = rig();
    r.place({ tdMode: 'cross', side: 'buy', ordType: 'market', sz: '2' });
    r.place({ side: 'buy', ordType: 'market', sz: '2' });
    r.mark('0');
    expect(r.engine.positions()).toHaveLength(2);
    r.mark('60');
    expect(r.engine.positions().map((p) => [p.mgnMode, p.pos, p.upl])).toEqual([['cross', '2', '-80']]);
    expect(r.engine.state().orders.filter((o) => o.category === 'full_liquidation')).toHaveLength(1);
  });

  it('funding of an isolated position goes through its margin and moves the liquidation price; the balance available stays', () => {
    const r = rig();
    r.place({ side: 'buy', ordType: 'market', sz: '2' });
    expect(r.engine.account.applyFunding(ABC, 'isolated', 'net', d('-1'), T0)).toBe(true);
    // (19 - 200) / (2 x -0.9945)
    expect(r.position()).toMatchObject({ margin: '19', fundingFee: '-1', liqPx: '91.00050277' });
    expect(r.usdt()).toMatchObject({ cashBal: '998.9', availEq: '979.9', isoEq: '19' });
    expect(r.engine.account.applyFunding(ABC, 'isolated', 'net', d('0.5'), T0)).toBe(true);
    expect(r.position()).toMatchObject({ margin: '19.5', fundingFee: '-0.5' });
    // a cross position pays from the balance, as before
    r.place({ tdMode: 'cross', side: 'buy', ordType: 'market', sz: '1' });
    expect(r.engine.account.applyFunding(ABC, 'cross', 'net', d('-2'), T0)).toBe(true);
    expect(r.position(ABC, 'cross')).toMatchObject({ margin: '10', fundingFee: '-2' });
    expect(r.usdt()).toMatchObject({ cashBal: '997.35' });

    // the mark between the old liquidation price and the new one: the position is gone, with the margin it had left
    r.mark('90.7');
    expect(r.position()).toBeUndefined();
    expect(r.usdt()).toMatchObject({ cashBal: '977.85' });
  });

  it('a settlement booked after its position was liquidated is not booked: it was part of the lost margin', () => {
    const r = rig();
    r.place({ side: 'buy', ordType: 'market', sz: '2' });
    r.engine.clockOverride = T0 + 600_000;
    r.mark('90');
    expect(r.usdt()).toMatchObject({ cashBal: '979.9' });
    // the settlement fell while the liquidated position was open
    expect(r.engine.account.applyFunding(ABC, 'isolated', 'net', d('-1'), T0 + 300_000)).toBe(false);
    expect(r.usdt()).toMatchObject({ cashBal: '979.9' });
    // a position opened after the settlement is not the one that was charged: its margin is left alone
    r.move('100');
    r.place({ side: 'buy', ordType: 'market', sz: '1' });
    expect(r.engine.account.applyFunding(ABC, 'isolated', 'net', d('-1'), T0 + 300_000)).toBe(false);
    expect(r.position()).toMatchObject({ margin: '10', fundingFee: '0' });
    // a settlement after the liquidation belongs to no liquidated position: one that was closed in the ordinary way pays from the balance
    r.engine.clockOverride = T0 + 900_000;
    r.place({ side: 'sell', ordType: 'market', sz: '1', reduceOnly: true });
    const before = d(r.usdt().cashBal);
    expect(r.engine.account.applyFunding(ABC, 'isolated', 'net', d('-1'), T0 + 700_000)).toBe(true);
    expect(d(r.usdt().cashBal).sub(before).toFixed()).toBe('-1');
  });
});

/** Sets the isolated leverage of ABC the way the set-leverage endpoint does; the code of the refusal, or '0'. */
function lever(r: Rig, to: string, posSide?: 'long' | 'short'): string {
  const refused = r.engine.changeIsolatedLeverage(ABC, d(to), posSide);
  if (!refused) r.engine.setLeverage(ABC, 'isolated', d(to), posSide);
  return refused?.sCode ?? '0';
}

describe('margin moved by hand (POST /api/v5/account/position/margin-balance)', () => {
  const adjust = (r: Rig, type: string, amt: string, extra: Record<string, unknown> = {}) => r.engine.adjustMargin({ instId: ABC, type, amt, ...extra });

  it('adds margin from the balance and takes it out again: reduce then add leaves the margin as it was, and the liquidation price follows each change', () => {
    const r = rig();
    expect(lever(r, '50')).toBe('0');
    r.place({ side: 'buy', ordType: 'market', sz: '2' });
    // 2 coin at 100 and 50x: margin 4; (4 - 200) / (2 x -0.9945)
    expect(r.position()).toMatchObject({ lever: '50', margin: '4', liqPx: '98.54198089', mgnRatio: '3.63636364' });
    expect(r.usdt()).toMatchObject({ cashBal: '999.9', availEq: '995.9' });

    // topped up to a stake of 20: the position of a 10x entry, at a leverage setting of 50
    expect(adjust(r, 'add', '16')).toEqual({ code: '0', msg: '', data: [{ instId: ABC, posSide: 'net', amt: '16', type: 'add', leverage: '10', ccy: 'USDT' }] });
    expect(r.position()).toMatchObject({ lever: '50', margin: '20', liqPx: '90.49773756' });
    expect(r.usdt()).toMatchObject({ cashBal: '999.9', availEq: '979.9', isoEq: '20', frozenBal: '20' });

    r.engine.clockOverride = T0 + 5_000;
    const pushes: string[] = [];
    r.engine.on('positions', ({ positions }) => pushes.push(`positions:${positions[0]?.margin}:${positions[0]?.liqPx}`));
    r.engine.on('account', (b) => pushes.push(`account:${b.details[0]?.availEq}`));
    // 6 out: (14 - 200) / (2 x -0.9945); the real leverage is 200 / 14
    expect(adjust(r, 'reduce', '6').data).toEqual([{ instId: ABC, posSide: 'net', amt: '6', type: 'reduce', leverage: '14.28571429', ccy: 'USDT' }]);
    expect(r.position()).toMatchObject({ margin: '14', liqPx: '93.51432881', uTime: String(T0 + 5_000) });
    expect(r.usdt()).toMatchObject({ cashBal: '999.9', availEq: '985.9' });
    // and back in
    expect(adjust(r, 'add', '6').code).toBe('0');
    expect(r.position()).toMatchObject({ margin: '20', liqPx: '90.49773756' });
    expect(r.usdt()).toMatchObject({ cashBal: '999.9', availEq: '979.9' });
    expect(pushes).toEqual(['positions:14:93.51432881', 'account:985.9', 'positions:20:90.49773756', 'account:979.9']);
  });

  it('refuses a reduction below the initial margin at the leverage set, on the mark price: an open loss counts against it, an open profit does not count for it', () => {
    const r = rig();
    lever(r, '50');
    r.place({ side: 'buy', ordType: 'market', sz: '2' });
    adjust(r, 'add', '16');
    // at the entry: 20 - 200 / 50 = 16 can go
    expect(adjust(r, 'reduce', '16.01')).toEqual({ code: '59301', msg: 'Margin adjustment failed for exceeding the max limit.', data: [] });
    expect(r.position()).toMatchObject({ margin: '20' });

    // the mark at 110: the profit of 20 frees nothing, and the requirement has grown to 220 / 50 = 4.4
    r.mark('110');
    expect(adjust(r, 'reduce', '15.61').code).toBe('59301');
    expect(adjust(r, 'reduce', '15.6').code).toBe('0');
    expect(r.position()).toMatchObject({ margin: '4.4', liqPx: '98.34087481' });
    expect(adjust(r, 'reduce', '0.01').code).toBe('59301');
    expect(adjust(r, 'add', '15.6').code).toBe('0');

    // the mark at 95: the loss of 10 is held back, with the requirement 190 / 50 = 3.8
    r.mark('95');
    expect(adjust(r, 'reduce', '6.21').code).toBe('59301');
    expect(adjust(r, 'reduce', '6.2').code).toBe('0');
    expect(r.position()).toMatchObject({ margin: '13.8', liqPx: '93.61488185' });
  });

  it('answers with the codes of OKX: no isolated position 59300, an order that closes it resting 59302, more than there is 59301', () => {
    const r = rig({ balance: '100' });
    expect(adjust(r, 'add', '1')).toMatchObject({ code: '59300', msg: 'Margin call failed. Position does not exist.' });
    r.place({ tdMode: 'cross', side: 'buy', ordType: 'market', sz: '1' });
    expect(adjust(r, 'reduce', '1').code).toBe('59300');
    r.place({ side: 'buy', ordType: 'market', sz: '2' });
    // 100 less two fees (0.05, 0.1), the cross requirement 10 and the isolated margin 20
    expect(r.usdt()).toMatchObject({ availEq: '69.85' });
    expect(adjust(r, 'add', '69.86').code).toBe('59301');
    expect(adjust(r, 'add', '69.85').code).toBe('0');
    expect(r.usdt()).toMatchObject({ availEq: '0', isoEq: '89.85' });
    expect(adjust(r, 'reduce', '69.85').code).toBe('0');

    expect(adjust(r, 'increase', '1').code).toBe('51000');
    for (const amt of ['0', '-1', 'abc', '']) expect(adjust(r, 'add', amt).code, amt).toBe('51000');
    expect(adjust(r, 'add', '1', { posSide: 'long' }).code).toBe('51000');
    expect(adjust(r, 'add', '1', { posSide: 'net' }).code).toBe('0');
    expect(adjust(r, 'add', '1', { instId: 'NOPE-USDT-SWAP' }).code).toBe('51001');

    const close = r.place({ side: 'sell', ordType: 'limit', px: '120', sz: '1', reduceOnly: true });
    expect(adjust(r, 'reduce', '1')).toMatchObject({ code: '59302', msg: 'Margin adjustment failed due to pending close order. Please cancel any pending close orders.' });
    expect(adjust(r, 'add', '1').code).toBe('59302');
    expect(r.engine.matcher.cancelRequest({ instId: ABC, ordId: close.ordId }).sCode).toBe('0');
    // an order that adds to the position is no close order
    expect(r.place({ side: 'buy', ordType: 'limit', px: '90', sz: '0.1' }).sCode).toBe('0');
    expect(adjust(r, 'reduce', '1').code).toBe('0');
    expect(r.position()).toMatchObject({ margin: '20' });
  });

  it('long/short mode: posSide names the position', () => {
    const r = rig({ posMode: 'long_short_mode' });
    r.place({ side: 'buy', posSide: 'long', ordType: 'market', sz: '2' });
    expect(adjust(r, 'add', '5').code).toBe('51000');
    expect(adjust(r, 'add', '5', { posSide: 'short' }).code).toBe('59300');
    expect(adjust(r, 'add', '5', { posSide: 'long' }).data).toMatchObject([{ posSide: 'long', leverage: '8' }]);
    expect(r.position(ABC, 'isolated', 'long')).toMatchObject({ margin: '25', liqPx: '87.98391151' });
  });

  it('an add that brings no new money: the leverage set high, the margin kept at the stake, the margin of the add taken out before it and posted again by it', () => {
    const r = rig();
    lever(r, '50');
    r.place({ side: 'buy', ordType: 'market', sz: '2' });
    adjust(r, 'add', '16');
    expect(r.usdt()).toMatchObject({ cashBal: '999.9', availEq: '979.9' });

    r.move('105');
    // 0.8 coin more at 105: notional 84, margin 84 / 50 = 1.68, fee 0.042. Both are taken out of the position first
    expect(adjust(r, 'reduce', '1.722').code).toBe('0');
    expect(r.position()).toMatchObject({ margin: '18.278', liqPx: '91.36349925' });
    expect(r.place({ side: 'buy', ordType: 'market', sz: '0.8' }).sCode).toBe('0');
    // the position holds its stake less the fee of the add; the balance outside it is what it was
    expect(r.position()).toMatchObject({ pos: '2.8', avgPx: '101.42857143', lever: '50', margin: '19.958', liqPx: '94.82223659' });
    expect(r.usdt()).toMatchObject({ cashBal: '999.858', availEq: '979.9' });

    // it ends where the notional would pass 50 x the margin: 8 coin more need 16.8 + 0.42, and 19.958 - 294 / 50 = 14.078 can go
    expect(adjust(r, 'reduce', '17.22').code).toBe('59301');
    expect(adjust(r, 'reduce', '14.078').code).toBe('0');
    expect(adjust(r, 'reduce', '0.001').code).toBe('59301');
  });
});

describe('a change of leverage on an open isolated position', () => {
  it('moves the difference of the initial margin between the position and the balance, both ways and back', () => {
    const r = rig();
    r.place({ side: 'buy', ordType: 'market', sz: '2' });
    expect(r.position()).toMatchObject({ lever: '10', margin: '20', liqPx: '90.49773756' });
    // 10x to 20x: the initial margin 200 / 10 becomes 200 / 20, and 10 goes back to the balance
    expect(lever(r, '20')).toBe('0');
    expect(r.position()).toMatchObject({ lever: '20', margin: '10', liqPx: '95.52538964' });
    expect(r.usdt()).toMatchObject({ cashBal: '999.9', availEq: '989.9' });
    expect(r.engine.leverageInfo(ABC, 'isolated')).toEqual([{ instId: ABC, mgnMode: 'isolated', posSide: 'net', lever: '20' }]);
    // 20x to 5x: 200 / 5 - 200 / 20 = 30 comes from the balance
    expect(lever(r, '5')).toBe('0');
    expect(r.position()).toMatchObject({ lever: '5', margin: '40', liqPx: '80.44243338' });
    expect(r.usdt()).toMatchObject({ availEq: '959.9' });
    expect(lever(r, '10')).toBe('0');
    expect(r.position()).toMatchObject({ lever: '10', margin: '20', liqPx: '90.49773756' });

    // what was added by hand stays in the position through the change
    r.engine.adjustMargin({ instId: ABC, type: 'add', amt: '5' });
    expect(lever(r, '20')).toBe('0');
    expect(r.position()).toMatchObject({ margin: '15', liqPx: '93.0115636' });
    expect(lever(r, '10')).toBe('0');
    expect(r.position()).toMatchObject({ margin: '25', liqPx: '87.98391151' });
    // what is added to the position posts at the leverage it now has
    expect(lever(r, '20')).toBe('0');
    r.place({ side: 'buy', ordType: 'market', sz: '1' });
    expect(r.position()).toMatchObject({ pos: '3', lever: '20', margin: '20' });
  });

  it('is refused when the position would be left at its liquidation threshold, when the balance cannot pay for it, and while isolated orders rest', () => {
    const r = rig();
    r.place({ side: 'buy', ordType: 'market', sz: '2' });
    // 18 down at 91: with the 10 a leverage of 20 would give back, nothing would be left
    r.mark('91');
    expect(lever(r, '20')).toBe('59102');
    expect(r.position()).toMatchObject({ lever: '10', margin: '20' });
    expect(r.engine.leverageInfo(ABC, 'isolated')[0]?.lever).toBe('10');

    const poor = rig({ balance: '26' });
    poor.place({ side: 'buy', ordType: 'market', sz: '2' });
    // 5.9 available: a leverage of 5 needs 20 more, one of 8 needs 5
    expect(lever(poor, '5')).toBe('59108');
    expect(poor.position()).toMatchObject({ lever: '10', margin: '20' });
    expect(lever(poor, '8')).toBe('0');
    expect(poor.position()).toMatchObject({ lever: '8', margin: '25' });
    expect(poor.usdt()).toMatchObject({ cashBal: '25.9', availEq: '0.9' });

    const resting = rig();
    const order = resting.place({ side: 'buy', ordType: 'limit', px: '90', sz: '1' });
    expect(lever(resting, '20')).toBe('59101');
    // the leverage it already has is no change
    expect(lever(resting, '10')).toBe('0');
    resting.engine.matcher.cancelRequest({ instId: ABC, ordId: order.ordId });
    expect(lever(resting, '20')).toBe('0');
    // the cross leverage is its own setting and moves nothing
    resting.place({ side: 'buy', ordType: 'market', sz: '1' });
    resting.engine.setLeverage(ABC, 'cross', d(3), undefined);
    expect(resting.position()).toMatchObject({ lever: '20', margin: '5' });
  });
});

describe('the state the paper exchange keeps', () => {
  it('carries the margin of an isolated position, the liquidations and the category of an order through a snapshot', () => {
    const r = rig();
    r.place({ side: 'buy', ordType: 'market', sz: '2' });
    r.engine.clockOverride = T0 + 1_000;
    r.mark('90');
    r.engine.clockOverride = T0 + 2_000;
    r.move('100');
    r.place({ side: 'buy', ordType: 'market', sz: '3' });
    r.place({ tdMode: 'cross', side: 'buy', ordType: 'market', sz: '1' });
    r.engine.account.applyFunding(ABC, 'isolated', 'net', d('-0.5'), T0 + 2_000);
    const account = r.engine.account.snapshot();
    const orders = r.engine.orders.snapshot();
    expect(account.positions.map((p) => [p.mgnMode, p.margin])).toEqual([['isolated', '29.5'], ['cross', undefined]]);
    expect(account.liquidated).toEqual([[`${ABC}|isolated|net`, T0, T0 + 1_000]]);
    expect(orders.history.map((o) => o.category)).toEqual(['normal', 'full_liquidation', 'normal', 'normal']);

    const again = rig();
    again.engine.clockOverride = T0 + 2_000;
    again.engine.account.restore(JSON.parse(JSON.stringify(account)) as typeof account);
    again.engine.orders.restore(JSON.parse(JSON.stringify(orders)) as typeof orders);
    expect(again.engine.positions()).toEqual(r.engine.positions());
    expect(again.engine.balance()).toEqual(r.engine.balance());
    expect(again.engine.state().orders).toEqual(r.engine.state().orders);
    // the liquidation is remembered: a settlement of the liquidated position is still not booked
    expect(again.engine.account.applyFunding(ABC, 'isolated', 'net', d('-1'), T0 + 500)).toBe(false);
    expect(again.engine.balance()).toEqual(r.engine.balance());
  });

  it('reads a snapshot written before isolated margin was simulated: the position gets its initial margin, the orders are normal ones', () => {
    const r = rig();
    r.place({ side: 'buy', ordType: 'market', sz: '2' });
    r.place({ side: 'buy', ordType: 'limit', px: '90', sz: '1' });
    const account = r.engine.account.snapshot();
    const orders = r.engine.orders.snapshot();
    // the shape of the old file: no margin on a position, no category on an order, no transaction type on a fill
    for (const p of account.positions) delete p.margin;
    for (const o of [...orders.live, ...orders.history]) delete o.category;
    for (const f of orders.fills) delete f.subType;

    const again = rig();
    again.engine.account.restore(account);
    again.engine.orders.restore(orders);
    expect(again.position()).toMatchObject({ pos: '2', margin: '20', liqPx: '90.49773756' });
    expect(again.engine.state().orders.map((o) => [o.state, o.category])).toEqual([['live', 'normal'], ['filled', 'normal']]);
    expect(again.usdt()).toMatchObject({ cashBal: '999.9', availEq: '970.9', ordFrozen: '9' });
  });
});
