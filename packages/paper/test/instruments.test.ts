import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { startMockOkx, type MockOkxHandle } from '@pegasus/mock-okx';
import { d, fallbackMmr, type OkxInstrument } from '@pegasus/mock-okx/engine';
import { OkxRestClient } from '@pegasus/okx';
import { CAMPAIGN_INSTRUMENTS } from '@pegasus/shared';
import { DEFAULT_PAPER_INSTRUMENTS, okxTier1Mmr, paperInstruments } from '../src/index.js';
import { T0, open, spec } from './helpers.js';

/** Contract metadata and tier-1 maintenance margin rate of the ten default swaps, as OKX listed them on 2026-10-05. */
const OKX_LISTING: Array<{ coin: string; ctVal: string; lotSz: string; minSz: string; tickSz: string; lever: string; mmr: string }> = [
  { coin: 'BTC', ctVal: '0.01', lotSz: '0.01', minSz: '0.01', tickSz: '0.1', lever: '100', mmr: '0.004' },
  { coin: 'ETH', ctVal: '0.1', lotSz: '0.01', minSz: '0.01', tickSz: '0.01', lever: '100', mmr: '0.004' },
  { coin: 'LTC', ctVal: '1', lotSz: '0.1', minSz: '0.1', tickSz: '0.01', lever: '50', mmr: '0.0065' },
  { coin: 'XRP', ctVal: '100', lotSz: '0.01', minSz: '0.01', tickSz: '0.0001', lever: '100', mmr: '0.004' },
  { coin: 'BCH', ctVal: '0.1', lotSz: '0.1', minSz: '0.1', tickSz: '0.1', lever: '50', mmr: '0.0065' },
  { coin: 'ETC', ctVal: '10', lotSz: '0.01', minSz: '0.01', tickSz: '0.001', lever: '50', mmr: '0.01' },
  { coin: 'LINK', ctVal: '1', lotSz: '0.1', minSz: '0.1', tickSz: '0.001', lever: '50', mmr: '0.0065' },
  { coin: 'ADA', ctVal: '100', lotSz: '0.1', minSz: '0.1', tickSz: '0.0001', lever: '50', mmr: '0.01' },
  { coin: 'DOT', ctVal: '1', lotSz: '1', minSz: '1', tickSz: '0.0001', lever: '50', mmr: '0.01' },
  { coin: 'TRX', ctVal: '1000', lotSz: '0.01', minSz: '0.01', tickSz: '0.00001', lever: '50', mmr: '0.0065' },
];
const listed = (): OkxInstrument[] => OKX_LISTING.map(({ coin, mmr: _mmr, ...meta }) => spec(`${coin}-USDT-SWAP`, meta));
const rates = (): Record<string, string> => Object.fromEntries(OKX_LISTING.map((l) => [`${l.coin}-USDT-SWAP`, l.mmr]));

describe('the instruments of the paper exchange', () => {
  it('are BTC, ETH, LTC, XRP, BCH, ETC, LINK, ADA, DOT and TRX unless PAPER_INSTRUMENTS says otherwise, plus what the terminal tracks', () => {
    expect(DEFAULT_PAPER_INSTRUMENTS).toEqual(['BTC-USDT-SWAP', 'ETH-USDT-SWAP', 'LTC-USDT-SWAP', 'XRP-USDT-SWAP', 'BCH-USDT-SWAP', 'ETC-USDT-SWAP', 'LINK-USDT-SWAP', 'ADA-USDT-SWAP', 'DOT-USDT-SWAP', 'TRX-USDT-SWAP']);
    expect(paperInstruments({})).toEqual([...DEFAULT_PAPER_INSTRUMENTS]);
    // INSTRUMENTS is the API's list: whatever the terminal shows is tradable on paper too
    expect(paperInstruments({ INSTRUMENTS: 'btc-usdt-swap, SOL-USDT-SWAP,' })).toEqual([...DEFAULT_PAPER_INSTRUMENTS, 'SOL-USDT-SWAP']);
    expect(paperInstruments({ PAPER_INSTRUMENTS: 'DOGE-USDT-SWAP, sui-usdt-swap', INSTRUMENTS: 'BTC-USDT-SWAP,DOGE-USDT-SWAP' })).toEqual(['DOGE-USDT-SWAP', 'SUI-USDT-SWAP', 'BTC-USDT-SWAP']);
    // an empty list of its own leaves the terminal's
    expect(paperInstruments({ PAPER_INSTRUMENTS: '', INSTRUMENTS: 'ETH-USDT-SWAP' })).toEqual(['ETH-USDT-SWAP']);
    expect(paperInstruments({ PAPER_INSTRUMENTS: '' })).toEqual([]);
  });

  it('are the campaign default list, and include what the campaign runs on while it is enabled, whatever PAPER_INSTRUMENTS says', () => {
    expect(DEFAULT_PAPER_INSTRUMENTS).toEqual(CAMPAIGN_INSTRUMENTS);
    // enabled: its ten by default, or CAMPAIGN_INSTRUMENTS, after the paper exchange's own and the terminal's
    expect(paperInstruments({ PAPER_INSTRUMENTS: 'SOL-USDT-SWAP', CAMPAIGN_ENABLED: '1' })).toEqual(['SOL-USDT-SWAP', ...CAMPAIGN_INSTRUMENTS]);
    expect(paperInstruments({ PAPER_INSTRUMENTS: '', INSTRUMENTS: 'SOL-USDT-SWAP', CAMPAIGN_ENABLED: '1', CAMPAIGN_INSTRUMENTS: 'btc-usdt-swap, DOGE-USDT-SWAP' })).toEqual(['SOL-USDT-SWAP', 'BTC-USDT-SWAP', 'DOGE-USDT-SWAP']);
    // not enabled: its list is the API's business only
    expect(paperInstruments({ PAPER_INSTRUMENTS: '', CAMPAIGN_ENABLED: '0', CAMPAIGN_INSTRUMENTS: 'DOGE-USDT-SWAP' })).toEqual([]);
    expect(paperInstruments({ PAPER_INSTRUMENTS: '', CAMPAIGN_INSTRUMENTS: 'DOGE-USDT-SWAP' })).toEqual([]);
  });

  describe('with the ten default swaps', () => {
    beforeEach(() => {
      vi.useFakeTimers({ now: T0 });
    });

    afterEach(() => {
      vi.useRealTimers();
    });

    it('each has its own market with the contract metadata and the maintenance margin rate it was started with', () => {
      const { paper } = open({ instruments: listed(), mmr: rates(), initialBalance: '56' });
      expect([...paper.markets.keys()]).toEqual([...DEFAULT_PAPER_INSTRUMENTS]);
      expect(paper.engine.instrumentList().map((i) => [i.instId, i.ctVal, i.lotSz, i.minSz, i.tickSz])).toEqual(OKX_LISTING.map((l) => [`${l.coin}-USDT-SWAP`, l.ctVal, l.lotSz, l.minSz, l.tickSz]));
      expect(Object.fromEntries([...paper.engine.mmr].map(([instId, rate]) => [instId, rate.toFixed()]))).toEqual(rates());

      // DOT: one coin per contract, whole contracts, tick 0.0001. A 10x isolated long of 10 at the ask 4.0001
      const DOT = 'DOT-USDT-SWAP';
      paper.engine.setLeverage(DOT, 'isolated', d(10), undefined);
      const buy = (sz: string) => paper.engine.matcher.place({ instId: DOT, tdMode: 'isolated', side: 'buy', ordType: 'market', sz });
      // nothing fills before the instrument has its own quotes, and its lot size is its own
      paper.onBook('BTC-USDT-SWAP', [['59999.9', '5', '0', '1']], [['60000.1', '5', '0', '1']]);
      paper.onMark('BTC-USDT-SWAP', '60000');
      expect(buy('10').sCode).toBe('0');
      expect(paper.engine.state().orders).toMatchObject([{ instId: DOT, state: 'canceled', accFillSz: '0' }]);
      paper.onBook(DOT, [['3.9999', '900', '0', '3']], [['4.0001', '900', '0', '3']]);
      paper.onMark(DOT, '4');
      paper.onLast(DOT, '4');
      expect(buy('0.5').sCode).toBe('51121');
      expect(buy('10').sCode).toBe('0');
      // margin 40.001 / 10; liquidation at (4.0001 - 40.001) / (10 x (0.01 + 0.0005 - 1))
      expect(paper.engine.state().positions).toMatchObject([{ instId: DOT, mgnMode: 'isolated', pos: '10', avgPx: '4.0001', margin: '4.0001', liqPx: '3.63829207' }]);
      expect(paper.engine.state().balance.details[0]).toMatchObject({ cashBal: '55.9799995', availEq: '51.9798995' });
      // the mark of another instrument does not touch it
      paper.onBook('TRX-USDT-SWAP', [['0.3', '500', '0', '1']], [['0.30001', '500', '0', '1']]);
      paper.onMark('TRX-USDT-SWAP', '0.3');
      expect(paper.engine.state().positions).toHaveLength(1);
      paper.onMark(DOT, '3.6382');
      expect(paper.engine.state().positions).toEqual([]);
      expect(paper.engine.state().balance.details[0]).toMatchObject({ cashBal: '51.9798995' });
    });

    it('an instrument without a rate is liquidated by half the initial margin rate of its highest leverage', () => {
      const { paper } = open({ instruments: listed(), mmr: { 'BTC-USDT-SWAP': '0.004' } });
      expect(paper.engine.mmr.get('BTC-USDT-SWAP')?.toFixed()).toBe('0.004');
      // 100x: 0.5%; 50x: 1%. Never below what OKX listed
      expect(paper.engine.mmr.get('XRP-USDT-SWAP')?.toFixed()).toBe('0.005');
      expect(paper.engine.mmr.get('LTC-USDT-SWAP')?.toFixed()).toBe('0.01');
      for (const l of OKX_LISTING) expect(fallbackMmr(l).gte(l.mmr), l.coin).toBe(true);
    });
  });
});

describe('the tier-1 maintenance margin rates read at start', () => {
  let okx: MockOkxHandle | null = null;

  afterEach(async () => {
    await okx?.close();
    okx = null;
  });

  it('come from the position tiers endpoint, five instrument families per request', async () => {
    // the mock stands in for OKX: seven swaps, three of them with a rate of their own
    okx = await startMockOkx({
      port: 0,
      tickIntervalMs: 0,
      instruments: { 'LTC-USDT-SWAP': { lever: '50' }, 'XRP-USDT-SWAP': {}, 'BCH-USDT-SWAP': { lever: '50' }, 'ETC-USDT-SWAP': { lever: '50' }, 'LINK-USDT-SWAP': { lever: '50' } },
      mmr: { 'LTC-USDT-SWAP': '0.0065', 'ETC-USDT-SWAP': '0.01', 'ETH-USDT-SWAP': '0.0045' },
    });
    const requests: string[] = [];
    const rest = new OkxRestClient({
      baseUrl: okx.restUrl,
      fetchImpl: (input, init) => {
        requests.push(String(input));
        return fetch(input, init);
      },
    });
    const instruments = (await rest.getInstruments('SWAP')) as OkxInstrument[];
    expect(instruments).toHaveLength(7);
    requests.length = 0;
    const logs: string[] = [];
    expect(await okxTier1Mmr(rest, instruments, (msg) => logs.push(msg))).toEqual({
      'BTC-USDT-SWAP': '0.004',
      'ETH-USDT-SWAP': '0.0045',
      'LTC-USDT-SWAP': '0.0065',
      'XRP-USDT-SWAP': '0.005',
      'BCH-USDT-SWAP': '0.01',
      'ETC-USDT-SWAP': '0.01',
      'LINK-USDT-SWAP': '0.01',
    });
    expect(logs).toEqual([]);
    expect(requests).toHaveLength(2);
    for (const url of requests) {
      const query = new URL(url).searchParams;
      expect(new URL(url).pathname).toBe('/api/v5/public/position-tiers');
      expect([query.get('instType'), query.get('tdMode'), query.get('tier')]).toEqual(['SWAP', 'isolated', '1']);
      expect((query.get('instFamily') ?? '').split(',').length).toBeLessThanOrEqual(5);
    }
  });

  it('fall back, instrument by instrument, when the endpoint cannot be read or gives no usable rate', async () => {
    const instruments = [spec('BTC-USDT-SWAP'), spec('ETH-USDT-SWAP'), spec('DOT-USDT-SWAP', { lever: '50' })];
    const logs: string[] = [];
    const offline = new OkxRestClient({
      baseUrl: 'http://127.0.0.1:9',
      fetchImpl: () => Promise.reject(new Error('offline')),
    });
    expect(await okxTier1Mmr(offline, instruments, (msg) => logs.push(msg))).toEqual({});
    expect(logs).toHaveLength(2);
    expect(logs[0]).toMatch(/position tiers of BTC-USDT, ETH-USDT, DOT-USDT could not be read/);
    expect(logs[1]).toMatch(/no tier-1 maintenance margin rate from OKX for BTC-USDT-SWAP, ETH-USDT-SWAP, DOT-USDT-SWAP/);

    // a rate that is not one, a row of another tier and a family that is missing: only the good row is taken
    const odd = new OkxRestClient({
      baseUrl: 'http://127.0.0.1:9',
      fetchImpl: () =>
        Promise.resolve(
          new Response(
            JSON.stringify({
              code: '0',
              msg: '',
              data: [
                { instFamily: 'BTC-USDT', uly: 'BTC-USDT', tier: '1', mmr: '' },
                { instFamily: 'ETH-USDT', uly: 'ETH-USDT', tier: '2', mmr: '0.005' },
                { instFamily: 'ETH-USDT', uly: 'ETH-USDT', tier: '1', mmr: '0.004' },
                { instFamily: 'DOT-USDT', uly: 'DOT-USDT', tier: '1', mmr: '1.5' },
              ],
            }),
          ),
        ),
    });
    logs.length = 0;
    expect(await okxTier1Mmr(odd, instruments, (msg) => logs.push(msg))).toEqual({ 'ETH-USDT-SWAP': '0.004' });
    expect(logs).toHaveLength(1);
    expect(logs[0]).toMatch(/for BTC-USDT-SWAP, DOT-USDT-SWAP: /);
  });
});
