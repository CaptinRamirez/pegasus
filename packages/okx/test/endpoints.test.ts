import { describe, expect, it } from 'vitest';
import { defaultEndpoints } from '../src/index.js';

describe('default endpoints', () => {
  it('never carry an explicit port (OKX stops accepting WebSocket connections on 8443 on 2026-10-31)', () => {
    for (const demo of [false, true]) {
      const e = defaultEndpoints(demo);
      for (const url of [e.rest, e.wsPublic, e.wsPrivate, e.wsBusiness]) expect(new URL(url).port, url).toBe('');
    }
  });

  it('keeps the host, path and demo brokerId query', () => {
    expect(defaultEndpoints(false)).toMatchObject({
      wsPublic: 'wss://ws.okx.com/ws/v5/public',
      wsPrivate: 'wss://ws.okx.com/ws/v5/private',
      wsBusiness: 'wss://ws.okx.com/ws/v5/business',
    });
    expect(defaultEndpoints(true)).toMatchObject({
      wsPublic: 'wss://wspap.okx.com/ws/v5/public?brokerId=9999',
      wsPrivate: 'wss://wspap.okx.com/ws/v5/private?brokerId=9999',
      wsBusiness: 'wss://wspap.okx.com/ws/v5/business?brokerId=9999',
    });
  });
});
