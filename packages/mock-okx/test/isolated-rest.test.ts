import { afterEach, describe, expect, it } from 'vitest';
import { liquidationPx } from '../src/engine/margin.js';
import { d, fmt, ROUND_CEIL, ROUND_FLOOR, ZERO } from '../src/num.js';
import type { MockCredentials, MockOkxHandle, OkxBalance, OkxFill, OkxLeverageInfo, OkxOrder, OkxOrderAck, OkxPosition } from '../src/index.js';
import { CREDS, WsProbe, isData, isEvent, rest, start, wsLoginArgs } from './helpers.js';

const BTC = 'BTC-USDT-SWAP';
/** The mock's BTC swap: 0.01 BTC per contract, tier-1 maintenance margin rate 0.4%, taker fee 0.05%. */
const CT_VAL = d('0.01');

async function cash(h: MockOkxHandle, creds?: MockCredentials): Promise<{ cashBal: string; availEq: string; isoEq: string; totalEq: string }> {
  const b = (await rest<OkxBalance>(h, 'GET', '/api/v5/account/balance', undefined, creds)).data[0];
  const detail = b?.details[0];
  if (!b || !detail) throw new Error('no balance');
  return { cashBal: detail.cashBal, availEq: detail.availEq, isoEq: detail.isoEq, totalEq: b.totalEq };
}

describe('isolated margin over the OKX protocol', () => {
  let h: MockOkxHandle;
  afterEach(async () => {
    await h.close();
  });

  it('a client opens a 10x isolated long: set-leverage for the instrument and margin mode, then an order with tdMode isolated', async () => {
    h = await start({ seed: 21, initialBalanceUsdt: '1000' });
    h.setPrice(BTC, '60000');
    const set = await rest<OkxLeverageInfo>(h, 'POST', '/api/v5/account/set-leverage', { instId: BTC, lever: '10', mgnMode: 'isolated' });
    expect(set).toMatchObject({ code: '0', data: [{ instId: BTC, mgnMode: 'isolated', posSide: 'net', lever: '10' }] });
    // the leverage of the other margin mode is its own
    expect((await rest(h, 'POST', '/api/v5/account/set-leverage', { instId: BTC, lever: '3', mgnMode: 'cross' })).code).toBe('0');
    expect((await rest<OkxLeverageInfo>(h, 'GET', `/api/v5/account/leverage-info?instId=${BTC}&mgnMode=isolated`)).data).toEqual([{ instId: BTC, mgnMode: 'isolated', posSide: 'net', lever: '10' }]);
    expect((await rest<OkxLeverageInfo>(h, 'GET', `/api/v5/account/leverage-info?instId=${BTC}&mgnMode=cross`)).data[0]?.lever).toBe('3');

    const ack = (await rest<OkxOrderAck>(h, 'POST', '/api/v5/trade/order', { instId: BTC, tdMode: 'isolated', side: 'buy', ordType: 'market', sz: '1' })).data[0];
    expect(ack?.sCode).toBe('0');
    const order = (await rest<OkxOrder>(h, 'GET', `/api/v5/trade/order?instId=${BTC}&ordId=${ack?.ordId}`)).data[0];
    expect(order).toMatchObject({ state: 'filled', tdMode: 'isolated', lever: '10', category: 'normal' });

    // what the fills must have posted: notional / 10 each
    const fills = (await rest<OkxFill>(h, 'GET', `/api/v5/trade/fills?instType=SWAP&instId=${BTC}`)).data;
    let margin = ZERO;
    let notional = ZERO;
    let fees = ZERO;
    for (const f of fills) {
      expect(f).toMatchObject({ subType: '1', execType: 'T' });
      notional = notional.add(d(f.fillSz).mul(CT_VAL).mul(f.fillPx));
      margin = margin.add(d(f.fillSz).mul(CT_VAL).mul(f.fillPx).div(10));
      fees = fees.add(f.fee);
    }
    const positions = (await rest<OkxPosition>(h, 'GET', '/api/v5/account/positions?instType=SWAP')).data;
    expect(positions).toHaveLength(1);
    const [pos] = positions;
    expect(pos).toMatchObject({ instId: BTC, mgnMode: 'isolated', posSide: 'net', pos: '1', lever: '10', margin: fmt(margin), imr: '', ccy: 'USDT' });
    expect(pos?.liqPx).toBe(fmt(liquidationPx(1, margin, CT_VAL, notional.div(CT_VAL), d('0.004'), d('0.0005'))));
    // about 9.6% below the entry: (1 - 1 / 10) / (1 - 0.004 - 0.0005)
    expect(Number(pos?.liqPx) / Number(pos?.avgPx)).toBeCloseTo(0.9 / 0.9955, 6);
    expect(Number(pos?.mgnRatio)).toBeGreaterThan(15);

    const bal = await cash(h);
    expect(bal.cashBal).toBe(fmt(d(1000).add(fees)));
    expect(bal.availEq).toBe(fmt(d(1000).add(fees).sub(margin)));
    expect(d(bal.isoEq).sub(margin).toFixed()).toBe(d(pos?.upl ?? '0').toFixed());
  });

  it('set-leverage on an open isolated position moves its margin; it is refused under resting isolated orders and when the balance cannot pay', async () => {
    h = await start({ seed: 21, initialBalanceUsdt: '100' });
    h.setPrice(BTC, '60000');
    const set = (body: Record<string, unknown>) => rest<OkxLeverageInfo>(h, 'POST', '/api/v5/account/set-leverage', { instId: BTC, mgnMode: 'isolated', ...body });
    const position = async () => (await rest<OkxPosition>(h, 'GET', '/api/v5/account/positions?instType=SWAP')).data[0];
    expect((await set({ lever: '10' })).code).toBe('0');
    expect((await rest<OkxOrderAck>(h, 'POST', '/api/v5/trade/order', { instId: BTC, tdMode: 'isolated', side: 'buy', ordType: 'market', sz: '1' })).data[0]?.sCode).toBe('0');
    // one contract at 60000.1: notional 600.001, margin 60.0001
    expect(await position()).toMatchObject({ lever: '10', margin: '60.0001' });
    // 20x: half of it goes back; 10x again: it comes back in
    expect((await set({ lever: '20' })).data).toEqual([{ instId: BTC, mgnMode: 'isolated', posSide: 'net', lever: '20' }]);
    expect(await position()).toMatchObject({ lever: '20', margin: '30.00005' });
    expect((await set({ lever: '10' })).code).toBe('0');
    expect(await position()).toMatchObject({ lever: '10', margin: '60.0001' });
    // 5x would need another 60.0001, and less than 40 is available
    expect(await set({ lever: '5' })).toMatchObject({ code: '59108', data: [] });
    expect(await position()).toMatchObject({ lever: '10', margin: '60.0001' });
    // the cross leverage of the same instrument is its own
    expect((await set({ lever: '5', mgnMode: 'cross' })).code).toBe('0');
    expect(await position()).toMatchObject({ lever: '10', margin: '60.0001' });
    expect((await rest(h, 'POST', '/api/v5/trade/close-position', { instId: BTC, mgnMode: 'isolated' })).code).toBe('0');

    const resting = (await rest<OkxOrderAck>(h, 'POST', '/api/v5/trade/order', { instId: BTC, tdMode: 'isolated', side: 'buy', ordType: 'limit', px: '50000', sz: '1' })).data[0];
    expect(resting?.sCode).toBe('0');
    expect(await set({ lever: '5' })).toMatchObject({ code: '59101', msg: "Leverage can't be modified. Please cancel all pending isolated margin orders before adjusting the leverage." });
    expect((await rest<OkxOrderAck>(h, 'POST', '/api/v5/trade/cancel-order', { instId: BTC, ordId: resting?.ordId })).code).toBe('0');
    expect((await set({ lever: '5' })).data).toEqual([{ instId: BTC, mgnMode: 'isolated', posSide: 'net', lever: '5' }]);
  });

  it('margin-balance adds margin to an isolated position and takes it out; the private channels carry the new margin and liquidation price', async () => {
    h = await start({ seed: 21, credentials: CREDS, initialBalanceUsdt: '1000' });
    h.setPrice(BTC, '60000');
    const post = <T>(path: string, body: unknown) => rest<T>(h, 'POST', path, body, CREDS);
    expect((await post('/api/v5/account/set-leverage', { instId: BTC, lever: '50', mgnMode: 'isolated' })).code).toBe('0');
    expect((await post<OkxOrderAck>('/api/v5/trade/order', { instId: BTC, tdMode: 'isolated', side: 'buy', ordType: 'market', sz: '1' })).data[0]?.sCode).toBe('0');
    const position = async () => (await rest<OkxPosition>(h, 'GET', '/api/v5/account/positions?instType=SWAP', undefined, CREDS)).data[0];
    // one contract at 60000.1 and 50x: margin 12.00002
    const opened = await position();
    expect(opened).toMatchObject({ lever: '50', margin: '12.00002' });

    const ws = await WsProbe.connect(h.wsPrivateUrl);
    ws.send({ op: 'login', args: [wsLoginArgs(CREDS)] });
    await ws.next(isEvent('login'));
    ws.send({ op: 'subscribe', args: [{ channel: 'positions', instType: 'SWAP' }, { channel: 'account' }] });
    await ws.next(isEvent('subscribe', 'account'));
    await ws.next(isData('account'));
    await ws.next(isData('positions'));

    // up to a stake of 60: the liquidation price of a 10x position
    const add = await post<Record<string, string>>('/api/v5/account/position/margin-balance', { instId: BTC, posSide: 'net', type: 'add', amt: '47.99998' });
    expect(add).toMatchObject({ code: '0', data: [{ instId: BTC, posSide: 'net', type: 'add', amt: '47.99998', ccy: 'USDT' }] });
    const staked = await position();
    expect(staked).toMatchObject({ lever: '50', margin: '60' });
    expect(Number(staked?.liqPx)).toBeLessThan(Number(opened?.liqPx));
    const pushed = await ws.next<{ data: OkxPosition[] }>((m) => isData('positions')(m) && (m as { data: OkxPosition[] }).data[0]?.margin === '60');
    expect(pushed.data[0]).toMatchObject({ instId: BTC, mgnMode: 'isolated', margin: '60', liqPx: staked?.liqPx });
    const account = await ws.next<{ data: OkxBalance[] }>((m) => isData('account')(m) && (m as { data: OkxBalance[] }).data[0]?.details[0]?.frozenBal === '60');
    expect(account.data[0]?.details[0]?.cashBal).toBe((await cash(h, CREDS)).cashBal);
    await ws.close();

    // out again, down to the initial margin at 50x on the mark (60000 x 0.01 / 50 = 12) less the open loss of 0.001
    expect((await post('/api/v5/account/position/margin-balance', { instId: BTC, type: 'reduce', amt: '48' })).code).toBe('59301');
    expect((await post('/api/v5/account/position/margin-balance', { instId: BTC, type: 'reduce', amt: '47.999' })).code).toBe('0');
    expect(await position()).toMatchObject({ margin: '12.001' });
    expect((await post('/api/v5/account/position/margin-balance', { instId: 'ETH-USDT-SWAP', type: 'add', amt: '1' })).code).toBe('59300');
  });

  it('a key without the trade permission cannot move margin', async () => {
    h = await start({ seed: 21, perm: 'read_only' });
    const r = await rest(h, 'POST', '/api/v5/account/position/margin-balance', { instId: BTC, type: 'add', amt: '1' });
    expect(r.code).not.toBe('0');
    expect(r.msg).toMatch(/permission/i);
  });

  it('long/short mode: the isolated leverage is set per side, and posSide is required', async () => {
    h = await start({ seed: 21, posMode: 'long_short_mode' });
    expect((await rest(h, 'POST', '/api/v5/account/set-leverage', { instId: BTC, lever: '10', mgnMode: 'isolated' })).code).toBe('51000');
    expect((await rest<OkxLeverageInfo>(h, 'POST', '/api/v5/account/set-leverage', { instId: BTC, lever: '20', mgnMode: 'isolated', posSide: 'long' })).data).toEqual([{ instId: BTC, mgnMode: 'isolated', posSide: 'long', lever: '20' }]);
    expect((await rest<OkxLeverageInfo>(h, 'GET', `/api/v5/account/leverage-info?instId=${BTC}&mgnMode=isolated`)).data.map((l) => [l.posSide, l.lever])).toEqual([['long', '20'], ['short', '10']]);
  });

  it('a liquidation reaches the private channels as OKX sends it: the order of category full_liquidation, the position at zero, the balance without the margin', async () => {
    h = await start({ seed: 21, credentials: CREDS, initialBalanceUsdt: '1000' });
    h.setPrice(BTC, '60000');
    expect((await rest<OkxOrderAck>(h, 'POST', '/api/v5/trade/order', { instId: BTC, tdMode: 'isolated', side: 'buy', ordType: 'market', sz: '1' }, CREDS)).data[0]?.sCode).toBe('0');
    const pos = (await rest<OkxPosition>(h, 'GET', '/api/v5/account/positions?instType=SWAP', undefined, CREDS)).data[0];
    if (!pos) throw new Error('no position');
    const before = await cash(h, CREDS);

    const ws = await WsProbe.connect(h.wsPrivateUrl);
    ws.send({ op: 'login', args: [wsLoginArgs(CREDS)] });
    expect((await ws.next(isEvent('login')))['code']).toBe('0');
    ws.send({ op: 'subscribe', args: [{ channel: 'orders', instType: 'SWAP' }, { channel: 'positions', instType: 'SWAP' }, { channel: 'account' }] });
    await ws.next(isEvent('subscribe', 'account'));
    await ws.next(isData('account')); // the snapshots sent on subscribing
    await ws.next(isData('positions'));

    // the mark on the tick above the liquidation price, then on the tick below it; the last price stays where it was
    const liqPx = d(pos.liqPx);
    h.setMarkPrice(BTC, liqPx.toDecimalPlaces(1, ROUND_CEIL).toFixed());
    expect((await rest<OkxPosition>(h, 'GET', '/api/v5/account/positions?instType=SWAP', undefined, CREDS)).data).toHaveLength(1);
    h.setMarkPrice(BTC, liqPx.toDecimalPlaces(1, ROUND_FLOOR).toFixed());

    const pushed = await ws.next<{ arg: Record<string, string>; data: OkxOrder[] }>((m) => isData('orders')(m) && (m as { data: OkxOrder[] }).data[0]?.category === 'full_liquidation');
    expect(pushed.data[0]).toMatchObject({ instId: BTC, tdMode: 'isolated', side: 'sell', posSide: 'net', state: 'filled', sz: '1', accFillSz: '1', fillSz: '1', tradeId: '0', execType: '', category: 'full_liquidation' });
    // the loss and the fee of the liquidation order are the margin
    expect(d(pushed.data[0]?.pnl ?? '0').add(pushed.data[0]?.fee ?? '0').neg().toDecimalPlaces(6).toFixed()).toBe(d(pos.margin).toDecimalPlaces(6).toFixed());
    const gone = await ws.next<{ data: OkxPosition[] }>((m) => isData('positions')(m) && (m as { data: OkxPosition[] }).data.some((p) => p.posId === pos.posId && p.pos === '0'));
    expect(gone.data.find((p) => p.posId === pos.posId)).toMatchObject({ instId: BTC, mgnMode: 'isolated', pos: '0', margin: '' });
    const account = await ws.next<{ data: OkxBalance[] }>((m) => isData('account')(m) && (m as { data: OkxBalance[] }).data[0]?.details[0]?.isoEq === '0');
    expect(account.data[0]?.details[0]?.cashBal).toBe(fmt(d(before.cashBal).sub(pos.margin)));
    await ws.close();

    expect((await rest<OkxPosition>(h, 'GET', '/api/v5/account/positions?instType=SWAP', undefined, CREDS)).data).toEqual([]);
    const after = await cash(h, CREDS);
    expect(after).toMatchObject({ cashBal: fmt(d(before.cashBal).sub(pos.margin)), isoEq: '0' });
    expect(after.availEq).toBe(after.cashBal);
    // the history and the fills carry it too
    const history = (await rest<OkxOrder>(h, 'GET', `/api/v5/trade/orders-history?instType=SWAP&instId=${BTC}&limit=1`, undefined, CREDS)).data;
    expect(history[0]).toMatchObject({ category: 'full_liquidation', state: 'filled' });
    const fill = (await rest<OkxFill>(h, 'GET', '/api/v5/trade/fills?instType=SWAP&limit=1', undefined, CREDS)).data[0];
    expect(fill).toMatchObject({ ordId: history[0]?.ordId, subType: '107', execType: '' });
    expect(fill?.tradeId).toMatch(/^-\d+$/);
  });

  it('serves the tier-1 position tier of its instruments like OKX, with the refusals of the endpoint', async () => {
    h = await start({ seed: 21, mmr: { 'ETH-USDT-SWAP': '0.0065' } });
    const tiers = (query: string) => rest<Record<string, string>>(h, 'GET', `/api/v5/public/position-tiers?${query}`);
    const both = await tiers('instType=SWAP&tdMode=isolated&instFamily=BTC-USDT,ETH-USDT&tier=1');
    expect(both.code).toBe('0');
    expect(both.data).toEqual([
      { baseMaxLoan: '', imr: '0.01', instFamily: 'BTC-USDT', instId: '', maxLever: '100', maxSz: '100000', minSz: '0', mmr: '0.004', optMgnFactor: '0', quoteMaxLoan: '', tier: '1', uly: 'BTC-USDT' },
      { baseMaxLoan: '', imr: '0.0133', instFamily: 'ETH-USDT', instId: '', maxLever: '75', maxSz: '100000', minSz: '0', mmr: '0.0065', optMgnFactor: '0', quoteMaxLoan: '', tier: '1', uly: 'ETH-USDT' },
    ]);
    // an unknown family among known ones is left out; alone it is an error
    expect((await tiers('instType=SWAP&tdMode=isolated&instFamily=NOPE-USDT,BTC-USDT')).data.map((t) => t['instFamily'])).toEqual(['BTC-USDT']);
    expect(await tiers('instType=SWAP&tdMode=isolated&instFamily=NOPE-USDT')).toMatchObject({ code: '51000', msg: 'Parameter instFamily error' });
    expect((await tiers('instType=SWAP&tdMode=isolated&instFamily=BTC-USDT&tier=2')).data).toEqual([]);
    expect(await tiers('instType=SWAP&instFamily=BTC-USDT')).toMatchObject({ code: '50014', msg: 'Parameter tdMode can not be empty.' });
    expect(await tiers('instType=SWAP&tdMode=isolated')).toMatchObject({ code: '50015' });
    expect(await tiers('instType=SWAP&tdMode=isolated&instFamily=A-USDT,B-USDT,C-USDT,D-USDT,E-USDT,F-USDT')).toMatchObject({ code: '50025' });
  });
});
