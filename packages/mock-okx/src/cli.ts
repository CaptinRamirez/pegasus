import { startMockOkx } from './server.js';
import type { MockOkxOptions } from './types.js';

function envNumber(name: string, def: number): number {
  const v = process.env[name];
  const n = v === undefined ? NaN : Number(v);
  return Number.isFinite(n) ? n : def;
}

async function main(): Promise<void> {
  const apiKey = process.env['MOCK_OKX_API_KEY'];
  const apiSecret = process.env['MOCK_OKX_API_SECRET'];
  const passphrase = process.env['MOCK_OKX_PASSPHRASE'];
  const posModeEnv = process.env['MOCK_OKX_POS_MODE'];
  const opts: MockOkxOptions = {
    port: envNumber('MOCK_OKX_PORT', 9100),
    host: process.env['MOCK_OKX_HOST'] ?? '127.0.0.1',
    tickIntervalMs: envNumber('MOCK_OKX_TICK_MS', 250),
    seed: envNumber('MOCK_OKX_SEED', Date.now() % 2147483647),
    log: (msg) => console.log(`[mock-okx] ${msg}`),
  };
  if (apiKey && apiSecret && passphrase) opts.credentials = { apiKey, apiSecret, passphrase };
  if (posModeEnv === 'net_mode' || posModeEnv === 'long_short_mode') opts.posMode = posModeEnv;
  const balance = process.env['MOCK_OKX_INITIAL_BALANCE'];
  if (balance) opts.initialBalanceUsdt = balance;

  const handle = await startMockOkx(opts);
  console.log(`mock-okx REST      ${handle.restUrl}`);
  console.log(`mock-okx WS public ${handle.wsPublicUrl}`);
  console.log(`mock-okx WS private ${handle.wsPrivateUrl}`);
  console.log(`mock-okx WS business ${handle.wsBusinessUrl}`);
  console.log(`mock-okx auth: ${opts.credentials ? 'signature required' : 'open (no credentials configured)'}; posMode: ${opts.posMode ?? 'net_mode'}`);

  const shutdown = (): void => {
    void handle.close().then(() => process.exit(0));
  };
  process.once('SIGINT', shutdown);
  process.once('SIGTERM', shutdown);
}

main().catch((err: unknown) => {
  console.error(err);
  process.exit(1);
});
