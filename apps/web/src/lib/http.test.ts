import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ApiError, TOKEN_KEY, http } from './http';

function reply(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });
}

describe('http', () => {
  const fetchMock = vi.fn<(input: RequestInfo | URL, init?: RequestInit) => Promise<Response>>();
  beforeEach(() => {
    localStorage.setItem(TOKEN_KEY, 'secret');
    vi.stubGlobal('fetch', fetchMock);
    fetchMock.mockReset();
  });
  afterEach(() => {
    vi.unstubAllGlobals();
    localStorage.clear();
  });

  it('attaches the bearer token, builds the query string and unwraps data', async () => {
    fetchMock.mockResolvedValue(reply(200, { ok: true, data: [{ instId: 'BTC-USDT-SWAP' }] }));
    const data = await http<{ instId: string }[]>('/api/candles', { query: { instId: 'BTC-USDT-SWAP', bar: '1m', limit: 300, before: undefined } });
    expect(data).toEqual([{ instId: 'BTC-USDT-SWAP' }]);
    const [url, init] = fetchMock.mock.calls[0] ?? [];
    expect(url).toBe('/api/candles?instId=BTC-USDT-SWAP&bar=1m&limit=300');
    expect(init?.method).toBe('GET');
    expect((init?.headers as Record<string, string>)['Authorization']).toBe('Bearer secret');
  });

  it('posts JSON bodies and prefers an explicit token', async () => {
    fetchMock.mockResolvedValue(reply(200, { ok: true, data: { canceled: 2 } }));
    await http('/api/orders/cancel-all', { body: {}, token: 'other' });
    const [, init] = fetchMock.mock.calls[0] ?? [];
    expect(init?.method).toBe('POST');
    expect(init?.body).toBe('{}');
    expect((init?.headers as Record<string, string>)['Authorization']).toBe('Bearer other');
  });

  it('throws ApiError with code/message/details on ok=false', async () => {
    fetchMock.mockResolvedValue(
      reply(400, { ok: false, error: { code: 'RISK_REJECTED', message: 'too big', details: { code: 'MAX_ORDER_NOTIONAL' } } }),
    );
    const err = await http('/api/orders', { body: {} }).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(ApiError);
    const apiErr = err as ApiError;
    expect(apiErr.code).toBe('RISK_REJECTED');
    expect(apiErr.message).toBe('too big');
    expect(apiErr.details).toEqual({ code: 'MAX_ORDER_NOTIONAL' });
    expect(apiErr.status).toBe(400);
  });

  it('throws on non-2xx responses without an envelope', async () => {
    fetchMock.mockResolvedValue(new Response('nope', { status: 401, statusText: 'Unauthorized' }));
    const err = await http('/api/instruments').catch((e: unknown) => e);
    expect(err).toBeInstanceOf(ApiError);
    expect((err as ApiError).code).toBe('UNAUTHORIZED');
  });

  it('wraps network failures', async () => {
    fetchMock.mockRejectedValue(new TypeError('Failed to fetch'));
    const err = await http('/api/health').catch((e: unknown) => e);
    expect((err as ApiError).code).toBe('NETWORK');
  });
});
