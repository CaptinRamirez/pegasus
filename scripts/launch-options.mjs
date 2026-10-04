// The launcher's command line and the environment it gives its children; kept apart from start.mjs so it can be tested.

const FLAGS = ['--mock', '--dev', '--no-open'];

/** --mock: local mock exchange instead of OKX; --dev: Vite dev server instead of the built page; --no-open: no browser. */
export function parseFlags(argv) {
  const unknown = argv.filter((arg) => !FLAGS.includes(arg));
  if (unknown.length > 0) throw new Error(`不认识的参数：${unknown.join(' ')}（可用：--mock 使用本地模拟交易所，--dev 开发模式，--no-open 不自动打开浏览器）`);
  return { mock: argv.includes('--mock'), dev: argv.includes('--dev'), open: !argv.includes('--no-open') };
}

/**
 * What --mock adds to the environment of the child processes. It wins over .env there (a variable that is
 * already set is not replaced by the env file), so .env itself, with the live key, is never touched and the
 * live key is never sent to the mock.
 */
export function mockEnv(port = 9100) {
  return {
    OKX_REST_URL: `http://127.0.0.1:${port}`,
    OKX_WS_PUBLIC_URL: `ws://127.0.0.1:${port}/ws/v5/public`,
    OKX_WS_PRIVATE_URL: `ws://127.0.0.1:${port}/ws/v5/private`,
    OKX_WS_BUSINESS_URL: `ws://127.0.0.1:${port}/ws/v5/business`,
    OKX_API_KEY: 'mock',
    OKX_API_SECRET: 'mock',
    OKX_API_PASSPHRASE: 'mock',
    OKX_DEMO: '1',
    // the mock only lists these two
    INSTRUMENTS: 'BTC-USDT-SWAP,ETH-USDT-SWAP',
    // the mock account must not inherit, or overwrite, the real account's halt and day baseline, nor its order journal
    STATE_FILE: 'data/pegasus-state.mock.json',
    DATABASE_URL: '',
  };
}
