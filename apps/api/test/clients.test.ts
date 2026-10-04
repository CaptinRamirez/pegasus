import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { OkxApiError, OkxTransportError } from '@pegasus/okx';
import { pino } from 'pino';
import { OkxUnreachableAtStartError, reachOkxAtStart, scheduleClockSync, type OkxClients } from '../src/okx/clients.js';
import { exchangeError } from '../src/services/order-service.js';

const log = pino({ level: 'silent' });

describe('scheduleClockSync', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('re-measures the clock offset every 30 minutes and survives a failed attempt', async () => {
    let skewMs = 4_000;
    let fail = false;
    let calls = 0;
    const rest = {
      getTime: async () => {
        calls++;
        if (fail) throw new OkxTransportError('/api/v5/public/time', 'could not reach OKX (ENOTFOUND)', false);
        return Date.now() + skewMs;
      },
    };
    const clients = { rest, clock: { offsetMs: 0 } } as unknown as OkxClients;
    const timer = scheduleClockSync(clients, log);
    expect(calls).toBe(0); // the boot-time sync is done by the caller

    await vi.advanceTimersByTimeAsync(30 * 60_000);
    expect(calls).toBe(1);
    expect(clients.clock.offsetMs).toBe(4_000);

    // the local clock was corrected in the meantime
    skewMs = 0;
    await vi.advanceTimersByTimeAsync(30 * 60_000);
    expect(clients.clock.offsetMs).toBe(0);

    // a failed attempt keeps the last measured offset and the schedule
    skewMs = 9_000;
    fail = true;
    await vi.advanceTimersByTimeAsync(30 * 60_000);
    expect(calls).toBe(3);
    expect(clients.clock.offsetMs).toBe(0);
    fail = false;
    await vi.advanceTimersByTimeAsync(30 * 60_000);
    expect(clients.clock.offsetMs).toBe(9_000);
    clearInterval(timer);
  });
});

describe('reachOkxAtStart', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  const unreachable = () => new OkxTransportError('/api/v5/public/instruments', 'could not reach OKX (ENOTFOUND)', false);

  it('retries a transport failure twice with a short backoff and returns the first answer', async () => {
    let calls = 0;
    const loading = reachOkxAtStart('instruments', async () => {
      if (++calls < 3) throw unreachable();
      return 'loaded';
    }, log);
    await vi.advanceTimersByTimeAsync(1_999);
    expect(calls).toBe(1);
    await vi.advanceTimersByTimeAsync(1);
    expect(calls).toBe(2);
    await vi.advanceTimersByTimeAsync(5_000);
    expect(await loading).toBe('loaded');
    expect(calls).toBe(3);
  });

  it('after the third failure it gives up with one plain sentence in English and one in Chinese', async () => {
    let calls = 0;
    const loading = reachOkxAtStart('instruments', async () => {
      calls++;
      throw unreachable();
    }, log).catch((e: unknown) => e);
    await vi.advanceTimersByTimeAsync(7_000);
    const err = await loading;
    expect(calls).toBe(3);
    expect(err).toBeInstanceOf(OkxUnreachableAtStartError);
    const [en, zh, ...rest] = (err as Error).message.split('\n');
    expect(en).toBe('Pegasus could not reach OKX (could not reach OKX (ENOTFOUND)). Check the network connection or the proxy / VPN, then start it again.');
    expect(zh).toBe('无法连接 OKX，请检查网络或代理（VPN）后重新启动。');
    expect(rest).toEqual([]);
    expect((err as Error).message).not.toMatch(/fetch failed|TypeError/);
  });

  it('does not retry anything else: an answer from OKX or a wrong setting is final', async () => {
    let calls = 0;
    const refused = reachOkxAtStart('instruments', async () => {
      calls++;
      throw new Error('unknown OKX SWAP instruments: FOO-USDT-SWAP');
    }, log);
    await expect(refused).rejects.toThrow('unknown OKX SWAP instruments: FOO-USDT-SWAP');
    expect(calls).toBe(1);
  });
});

describe('exchangeError', () => {
  it('maps a transport failure to EXCHANGE_UNREACHABLE: 504 on a timeout, 502 otherwise', () => {
    const timeout = exchangeError(new OkxTransportError('/api/v5/trade/cancel-order', 'OKX did not answer within 10000 ms', true));
    expect(timeout).toMatchObject({ code: 'EXCHANGE_UNREACHABLE', status: 504 });
    expect(timeout.message).not.toMatch(/fetch failed|aborted/);
    const down = exchangeError(new OkxTransportError('/api/v5/trade/cancel-order', 'could not reach OKX (ECONNRESET)', false));
    expect(down).toMatchObject({ code: 'EXCHANGE_UNREACHABLE', status: 502 });
  });

  it('still maps exchange rejections to EXCHANGE', () => {
    expect(exchangeError(new OkxApiError('51000', 'Parameter error', '/api/v5/trade/order'))).toMatchObject({ code: 'EXCHANGE', status: 502 });
  });
});
