import { createHmac } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { restAuthHeaders, restTimestamp, signRest, signWsLogin, wsLoginArgs, wsTimestamp } from '../src/index.js';

const creds = { apiKey: 'key', apiSecret: 'secret', passphrase: 'pass' };

describe('signing', () => {
  it('formats the REST timestamp as ISO-8601 with milliseconds', () => {
    expect(restTimestamp(1607418537715)).toBe('2020-12-08T09:08:57.715Z');
  });
  it('formats the WS timestamp as unix seconds', () => {
    expect(wsTimestamp(1607418537715)).toBe('1607418537');
  });
  it('signs REST requests over timestamp + METHOD + path(with query) + body', () => {
    const ts = '2020-12-08T09:08:57.715Z';
    const expected = createHmac('sha256', 'secret').update(`${ts}GET/api/v5/account/balance?ccy=BTC`).digest('base64');
    expect(signRest('secret', ts, 'get', '/api/v5/account/balance?ccy=BTC', '')).toBe(expected);
    const body = JSON.stringify({ instId: 'BTC-USDT-SWAP' });
    const expectedPost = createHmac('sha256', 'secret').update(`${ts}POST/api/v5/trade/order${body}`).digest('base64');
    expect(signRest('secret', ts, 'POST', '/api/v5/trade/order', body)).toBe(expectedPost);
  });
  it('builds the four auth headers', () => {
    const h = restAuthHeaders(creds, 'GET', '/api/v5/account/config', '', 1607418537715);
    expect(h['OK-ACCESS-KEY']).toBe('key');
    expect(h['OK-ACCESS-PASSPHRASE']).toBe('pass');
    expect(h['OK-ACCESS-TIMESTAMP']).toBe('2020-12-08T09:08:57.715Z');
    expect(h['OK-ACCESS-SIGN']).toBe(signRest('secret', '2020-12-08T09:08:57.715Z', 'GET', '/api/v5/account/config', ''));
  });
  it('signs the WS login over timestamp + GET + /users/self/verify', () => {
    const expected = createHmac('sha256', 'secret').update('1607418537GET/users/self/verify').digest('base64');
    expect(signWsLogin('secret', '1607418537')).toBe(expected);
    const args = wsLoginArgs(creds, 1607418537715);
    expect(args).toEqual({ apiKey: 'key', passphrase: 'pass', timestamp: '1607418537', sign: expected });
  });
});
