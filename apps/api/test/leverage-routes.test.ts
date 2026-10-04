import { EventEmitter } from 'node:events';
import { describe, expect, it } from 'vitest';
import type { ApiResponse } from '@pegasus/shared';
import type { InjectOptions } from 'fastify';
import { pino } from 'pino';
import { MemoryStore } from '../src/db/store.js';
import type { Deps } from '../src/deps.js';
import { UnknownInstrumentError } from '../src/errors.js';
import type { OkxClients } from '../src/okx/clients.js';
import { buildServer } from '../src/server.js';
import { AccountService } from '../src/services/account.js';
import type { MarketDataService } from '../src/services/market-data.js';

const log = pino({ level: 'silent' });
const TOKEN = 'test-token';
const BTC = 'BTC-USDT-SWAP';

class DownSocket extends EventEmitter {
  isReady = false;
  currentStatus = 'disconnected';
  async subscribe(): Promise<void> {}
  connect(): void {}
  async close(): Promise<void> {}
}

/** The API with a private socket that never becomes ready; `load` false leaves the account config unloaded. */
async function setup(opts: { perm?: string; load?: boolean; credentials?: boolean } = {}) {
  const sent: unknown[] = [];
  const info = [{ instId: BTC, mgnMode: 'cross', posSide: 'long', lever: '5' }];
  const rest = {
    getAccountConfig: async () => ({ uid: '1', acctLv: '2', posMode: 'long_short_mode', autoLoan: false, level: 'Lv1', perm: opts.perm ?? 'read_only,trade' }),
    getBalance: async () => ({ totalEq: '1000', uTime: '1', details: [] }),
    getPositions: async () => [],
    getOrdersPending: async () => [],
    getLeverageInfo: async () => info,
    setLeverage: async (params: unknown) => {
      sent.push(params);
      return info;
    },
  };
  const clients = { rest, wsPrivate: opts.credentials === false ? null : new DownSocket(), clock: { offsetMs: 0 }, demo: false } as unknown as OkxClients;
  const account = new AccountService(clients, new MemoryStore(), log);
  if (opts.load !== false) await account.start();
  const market = {
    requireInstrument: (instId: string) => {
      if (instId !== BTC) throw new UnknownInstrumentError(instId);
      return { instId };
    },
  } as unknown as MarketDataService;
  const app = await buildServer({ config: { server: { token: TOKEN, host: '127.0.0.1', webOrigins: [] } }, log, clients, market, account, risk: { config: { maxLeverage: '10' } } } as unknown as Deps);
  const call = async (method: 'GET' | 'POST', url: string, body?: unknown) => {
    const opts: InjectOptions = { method, url, headers: { authorization: `Bearer ${TOKEN}`, 'content-type': 'application/json' } };
    if (body !== undefined) opts.payload = JSON.stringify(body);
    const res = await app.inject(opts);
    return { status: res.statusCode, body: res.json() as ApiResponse<unknown> };
  };
  const close = async () => {
    await app.close();
    await account.stop();
  };
  return { call, sent, account, close };
}

const GET_URL = `/api/account/leverage?instId=${BTC}&mgnMode=cross`;
const SET_BODY = { instId: BTC, lever: '3', mgnMode: 'cross', posSide: 'long' };

describe('leverage routes while the private stream is down', () => {
  it('reads and sets the leverage over REST without the private socket', async () => {
    const api = await setup();
    expect(api.account.ready).toBe(false);
    const read = await api.call('GET', GET_URL);
    expect(read).toMatchObject({ status: 200, body: { ok: true, data: [{ instId: BTC, lever: '5' }] } });
    const set = await api.call('POST', '/api/account/leverage', SET_BODY);
    expect(set.status).toBe(200);
    // posSide goes out because the account is in long/short mode
    expect(api.sent).toEqual([{ instId: BTC, lever: '3', mgnMode: 'cross', posSide: 'long' }]);
    await api.close();
  });

  it('refuses a leverage above RISK_MAX_LEVERAGE before anything is sent to the exchange', async () => {
    const api = await setup();
    const over = await api.call('POST', '/api/account/leverage', { ...SET_BODY, lever: '10.5' });
    expect(over).toMatchObject({ status: 422, body: { ok: false, error: { code: 'RISK_REJECTED', details: { ok: false, code: 'MAX_LEVERAGE', details: { lever: '10.5', limit: '10' } } } } });
    expect(api.sent).toEqual([]);
    expect((await api.call('POST', '/api/account/leverage', { ...SET_BODY, lever: '10' })).status).toBe(200);
    expect(api.sent).toHaveLength(1);
    await api.close();
  });

  it('a read-only key can read the leverage but not set it', async () => {
    const api = await setup({ perm: 'read_only' });
    expect((await api.call('GET', GET_URL)).status).toBe(200);
    expect(await api.call('POST', '/api/account/leverage', SET_BODY)).toMatchObject({ status: 403, body: { ok: false, error: { code: 'READ_ONLY_KEY' } } });
    expect(api.sent).toEqual([]);
    await api.close();
  });

  it('answers NOT_CONNECTED without credentials or before the account config is loaded', async () => {
    for (const opts of [{ credentials: false }, { load: false }]) {
      const api = await setup(opts);
      expect(await api.call('GET', GET_URL)).toMatchObject({ status: 503, body: { ok: false, error: { code: 'NOT_CONNECTED' } } });
      expect(await api.call('POST', '/api/account/leverage', SET_BODY)).toMatchObject({ status: 503, body: { ok: false, error: { code: 'NOT_CONNECTED' } } });
      expect(api.sent).toEqual([]);
      await api.close();
    }
  });
});
