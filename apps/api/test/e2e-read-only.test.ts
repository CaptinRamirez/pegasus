/**
 * End-to-end with a read-only API key: the API server wired to a mock OKX whose
 * key lacks the trade permission. Reads work; every write is refused by the API
 * itself and never reaches the exchange.
 */
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { pino } from 'pino';
import { startMockOkx, type MockOkxHandle } from '@pegasus/mock-okx';
import type { AccountConfig, ApiResponse } from '@pegasus/shared';
import type { FastifyInstance, InjectOptions } from 'fastify';
import { loadConfig } from '../src/config.js';
import { MemoryStore } from '../src/db/store.js';
import type { Deps } from '../src/deps.js';
import { createOkxClients, syncClock } from '../src/okx/clients.js';
import { buildServer } from '../src/server.js';
import { AccountService } from '../src/services/account.js';
import { KillSwitchSweeper } from '../src/services/kill-switch-sweeper.js';
import { MarketDataService } from '../src/services/market-data.js';
import { OrderService } from '../src/services/order-service.js';
import { RiskEngine } from '../src/services/risk-engine.js';
import { SignalsService } from '../src/services/signals.js';
import { Hub } from '../src/ws/hub.js';

const TOKEN = 'test-token';
const CREDS = { apiKey: 'k', apiSecret: 's', passphrase: 'p' };
const log = pino({ level: process.env['E2E_LOG'] ?? 'silent' });

let mock: MockOkxHandle;
let app: FastifyInstance;
let deps: Deps;

async function api<T>(method: 'GET' | 'POST', path: string, body?: unknown): Promise<{ status: number; body: ApiResponse<T> }> {
  const opts: InjectOptions = { method, url: path, headers: { authorization: `Bearer ${TOKEN}`, 'content-type': 'application/json' } };
  if (body !== undefined) opts.payload = JSON.stringify(body);
  const res = await app.inject(opts);
  return { status: res.statusCode, body: res.json() as ApiResponse<T> };
}

async function waitFor(fn: () => unknown, timeoutMs: number, label: string): Promise<void> {
  const start = Date.now();
  while (!fn()) {
    if (Date.now() - start > timeoutMs) throw new Error(`timeout waiting for ${label}`);
    await new Promise((r) => setTimeout(r, 25));
  }
}

beforeAll(async () => {
  mock = await startMockOkx({ port: 0, credentials: CREDS, perm: 'read_only', posMode: 'long_short_mode', seed: 42, tickIntervalMs: 50, initialPrices: { 'BTC-USDT-SWAP': '50000' } });
  const config = loadConfig({
    OKX_API_KEY: CREDS.apiKey,
    OKX_API_SECRET: CREDS.apiSecret,
    OKX_API_PASSPHRASE: CREDS.passphrase,
    OKX_DEMO: '1',
    OKX_REST_URL: mock.restUrl,
    OKX_WS_PUBLIC_URL: mock.wsPublicUrl,
    OKX_WS_PRIVATE_URL: mock.wsPrivateUrl,
    OKX_WS_BUSINESS_URL: mock.wsBusinessUrl,
    API_TOKEN: TOKEN,
    INSTRUMENTS: 'BTC-USDT-SWAP',
  });
  const store = new MemoryStore();
  const clients = createOkxClients(config, log);
  await syncClock(clients, log);
  const market = new MarketDataService(clients, log, { bookDepth: 50, bookThrottleMs: 20 });
  await market.loadInstruments(config.instruments);
  const account = new AccountService(clients, store, log);
  const risk = new RiskEngine(config.risk, store, log);
  await risk.init();
  const orders = new OrderService(clients, market, account, risk, store, log, { defaultTdMode: config.defaultTdMode, wsTrading: config.okx.wsTrading });
  const signals = new SignalsService(clients, market, account, log);
  const hub = new Hub(config, market, account, risk, log);
  deps = { config, log, clients, store, market, account, risk, orders, signals, hub };
  new KillSwitchSweeper(risk, account, orders, log).start();
  hub.wire();
  app = await buildServer(deps);
  await market.start();
  await account.start();
  await waitFor(() => market.book('BTC-USDT-SWAP') && market.ticker('BTC-USDT-SWAP') && account.ready && account.balance, 10_000, 'market data + private stream');
}, 30_000);

afterAll(async () => {
  await deps.hub.close();
  await app.close();
  await deps.market.stop();
  await deps.account.stop();
  await mock.close();
});

describe('api e2e with a read-only key', () => {
  it('knows the key cannot trade and says so in the account config and the connection status', async () => {
    const res = await api<{ config: AccountConfig | null }>('GET', '/api/account');
    expect(res.body.ok && res.body.data.config).toEqual({ posMode: 'long_short_mode', acctLv: '2', canTrade: false });
    expect(deps.hub.hello().account).toMatchObject({ canTrade: false });
    expect(deps.hub.connectionStatus().account).toMatchObject({ state: 'ok', error: null, readOnly: true });
    expect(deps.hub.connectionStatus().okxPrivate).toBe('connected');
  });

  it('still previews an order', async () => {
    const res = await api<{ sz: string; posSide: string }>('POST', '/api/orders/preview', { instId: 'BTC-USDT-SWAP', side: 'buy', posSide: 'long', ordType: 'limit', px: '49000', size: { unit: 'contracts', value: '1' } });
    expect(res.status).toBe(200);
    expect(res.body.ok && res.body.data).toMatchObject({ sz: '1', posSide: 'long' });
  });

  it('answers every write with 403 READ_ONLY_KEY without contacting the exchange', async () => {
    const spies = [vi.spyOn(deps.clients.rest, 'request'), vi.spyOn(deps.clients.wsPrivate!, 'request')];
    try {
      const writes: Array<[string, unknown]> = [
        ['/api/orders', { instId: 'BTC-USDT-SWAP', side: 'buy', posSide: 'long', ordType: 'limit', px: '49000', size: { unit: 'contracts', value: '1' } }],
        ['/api/orders/cancel', { instId: 'BTC-USDT-SWAP', ordId: '123' }],
        ['/api/orders/cancel-all', {}],
        ['/api/positions/close', { instId: 'BTC-USDT-SWAP', mgnMode: 'cross', posSide: 'long' }],
        ['/api/account/leverage', { instId: 'BTC-USDT-SWAP', lever: '3', mgnMode: 'cross' }],
        ['/api/algo-orders', { instId: 'BTC-USDT-SWAP', mgnMode: 'cross', posSide: 'long', slTriggerPx: '48000' }],
        ['/api/algo-orders/amend', { instId: 'BTC-USDT-SWAP', algoId: '123', slTriggerPx: '48000' }],
        ['/api/algo-orders/cancel', { instId: 'BTC-USDT-SWAP', algoId: '123' }],
      ];
      for (const [path, body] of writes) {
        const res = await api<unknown>('POST', path, body);
        expect(res.status, path).toBe(403);
        expect(!res.body.ok && res.body.error.code, path).toBe('READ_ONLY_KEY');
      }
      for (const spy of spies) expect(spy).not.toHaveBeenCalled();
      expect(mock.getState().orders).toEqual([]);
    } finally {
      for (const spy of spies) spy.mockRestore();
    }
  });

  it('the kill switch engages, and its cancel sweep is skipped without contacting the exchange', async () => {
    const spies = [vi.spyOn(deps.clients.rest, 'request'), vi.spyOn(deps.clients.wsPrivate!, 'request')];
    try {
      const res = await api<{ killSwitch: boolean; cancelSweep: { state: string; message: string } }>('POST', '/api/risk/kill-switch', { enabled: true, reason: 'test' });
      expect(res.body.ok && res.body.data).toMatchObject({ killSwitch: true, cancelSweep: { state: 'skipped', message: 'skipped: read-only key' } });
      for (const spy of spies) expect(spy).not.toHaveBeenCalled();
      expect(deps.hub.hello().risk.cancelSweep.state).toBe('skipped');
    } finally {
      for (const spy of spies) spy.mockRestore();
      await api<unknown>('POST', '/api/risk/kill-switch', { enabled: false });
    }
  });
});
