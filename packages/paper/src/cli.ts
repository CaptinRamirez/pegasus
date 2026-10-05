import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { paperInstruments, startPaperExchange, type PaperOptions } from './server.js';

/** The repository root: the account file is kept under it whatever directory the process was started from. */
const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../../..');

const decimal = (name: string, value: string | undefined): string | undefined => {
  if (value === undefined || value === '') return undefined;
  if (!/^\d+(\.\d+)?$/.test(value)) throw new Error(`${name} must be a non-negative decimal, got '${value}'`);
  return value;
};

/** A URL of this machine: the mock exchange, whose prices are not OKX's. */
const isLocal = (url: string): boolean => URL.canParse(url) && ['127.0.0.1', 'localhost', '[::1]'].includes(new URL(url).hostname);

async function main(): Promise<void> {
  const env = process.env;
  const instruments = paperInstruments(env);
  if (instruments.length === 0) throw new Error('PAPER_INSTRUMENTS and INSTRUMENTS must list at least one instrument between them');
  const port = Number(env['PAPER_PORT'] ?? 9200);
  if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error(`PAPER_PORT must be a port number, got '${env['PAPER_PORT']}'`);
  const posMode = env['PAPER_POS_MODE'] ?? 'net_mode';
  if (posMode !== 'net_mode' && posMode !== 'long_short_mode') throw new Error(`PAPER_POS_MODE must be net_mode or long_short_mode, got '${posMode}'`);

  const opts: PaperOptions = {
    port,
    host: env['PAPER_HOST'] ?? '127.0.0.1',
    instruments,
    stateFile: resolve(REPO_ROOT, env['PAPER_STATE_FILE'] ?? 'data/paper-account.json'),
    posMode,
    log: (msg) => console.log(`[paper] ${msg}`),
  };
  const balance = decimal('PAPER_BALANCE', env['PAPER_BALANCE']);
  if (balance !== undefined) opts.initialBalance = balance;
  const lever = decimal('PAPER_LEVERAGE', env['PAPER_LEVERAGE']);
  if (lever !== undefined) opts.defaultLever = lever;
  const taker = decimal('PAPER_TAKER_FEE', env['PAPER_TAKER_FEE']);
  if (taker !== undefined) opts.takerFeeRate = taker;
  const maker = decimal('PAPER_MAKER_FEE', env['PAPER_MAKER_FEE']);
  if (maker !== undefined) opts.makerFeeRate = maker;
  // An OKX host other than the default (a regional domain) is taken over; a local one is the mock and is not market data.
  const restUrl = env['OKX_REST_URL'];
  const wsUrl = env['OKX_WS_PUBLIC_URL'];
  if (restUrl && !isLocal(restUrl)) opts.okxRestUrl = restUrl;
  if (wsUrl && !isLocal(wsUrl)) opts.okxWsPublicUrl = wsUrl;

  const handle = await startPaperExchange(opts);
  console.log(`[paper] paper exchange listening on ${handle.restUrl} (orders and positions are simulated; prices are OKX's)`);

  const shutdown = (): void => {
    void handle.close().then(() => process.exit(0));
  };
  process.once('SIGINT', shutdown);
  process.once('SIGTERM', shutdown);
}

main().catch((err: unknown) => {
  console.error(`[paper] ${(err as Error).message}`);
  process.exit(1);
});
