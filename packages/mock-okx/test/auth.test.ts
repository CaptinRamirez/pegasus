import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { MockOkxHandle } from '../src/index.js';
import { CREDS, isEvent, rest, start, wsLoginArgs, WsProbe } from './helpers.js';

let h: MockOkxHandle;

beforeAll(async () => {
  h = await start({ credentials: CREDS });
});
afterAll(async () => {
  await h.close();
});

describe('REST signature enforcement', () => {
  it('accepts a correctly signed GET and POST', async () => {
    const cfg = await rest(h, 'GET', '/api/v5/account/config', undefined, CREDS);
    expect(cfg.code).toBe('0');
    expect(cfg.data[0]).toMatchObject({ acctLv: '2', posMode: 'net_mode', autoLoan: false, level: 'Lv1' });
    const bal = await rest(h, 'GET', '/api/v5/account/balance?ccy=USDT', undefined, CREDS);
    expect(bal.code).toBe('0');
    const lev = await rest(h, 'POST', '/api/v5/account/set-leverage', { instId: 'BTC-USDT-SWAP', lever: '20', mgnMode: 'cross' }, CREDS);
    expect(lev.code).toBe('0');
    expect(lev.data[0]).toMatchObject({ instId: 'BTC-USDT-SWAP', mgnMode: 'cross', posSide: 'net', lever: '20' });
    const info = await rest(h, 'GET', '/api/v5/account/leverage-info?instId=BTC-USDT-SWAP&mgnMode=cross', undefined, CREDS);
    expect(info.data[0]?.lever).toBe('20');
  });

  it('leaves public endpoints open', async () => {
    expect((await rest(h, 'GET', '/api/v5/public/time')).code).toBe('0');
  });

  it('rejects a bad signature with 50113', async () => {
    const r = await rest(h, 'GET', '/api/v5/account/config', undefined, CREDS, { sign: 'AAAA' });
    expect(r.code).toBe('50113');
    expect(r.data).toEqual([]);
  });

  it('rejects a signature over a different body', async () => {
    const r = await rest(h, 'POST', '/api/v5/account/set-leverage', { instId: 'BTC-USDT-SWAP', lever: '5', mgnMode: 'cross' }, CREDS, {
      sign: 'bm90LXRoZS1yaWdodC1zaWduYXR1cmU=',
    });
    expect(r.code).toBe('50113');
  });

  it('rejects missing headers and wrong key', async () => {
    expect((await rest(h, 'GET', '/api/v5/account/config')).code).toBe('50103');
    expect((await rest(h, 'GET', '/api/v5/account/config', undefined, CREDS, { omit: ['OK-ACCESS-SIGN'] })).code).toBe('50114');
    expect((await rest(h, 'GET', '/api/v5/account/config', undefined, { ...CREDS, apiKey: 'other' })).code).toBe('50111');
    expect((await rest(h, 'GET', '/api/v5/account/config', undefined, { ...CREDS, passphrase: 'other' })).code).toBe('50105');
  });

  it('rejects expired timestamps with 50102', async () => {
    const r = await rest(h, 'GET', '/api/v5/account/config', undefined, CREDS, { timestamp: new Date(Date.now() - 120_000).toISOString() });
    expect(r.code).toBe('50102');
  });
});

describe('WS login enforcement', () => {
  it('rejects a bad login and accepts a good one', async () => {
    const ws = await WsProbe.connect(h.wsPrivateUrl);
    ws.send({ op: 'login', args: [{ ...wsLoginArgs(CREDS), sign: 'bad' }] });
    const bad = await ws.next(isEvent('error'));
    expect(bad).toMatchObject({ event: 'error', code: '60009', msg: 'Login failed.' });
    ws.send({ op: 'login', args: [wsLoginArgs(CREDS)] });
    const good = await ws.next(isEvent('login'));
    expect(good).toMatchObject({ event: 'login', code: '0', msg: '' });
    expect(typeof good['connId']).toBe('string');
    await ws.close();
  });
});
