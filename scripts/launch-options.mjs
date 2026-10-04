// The launcher's command line and the environment it gives its children; kept apart from start.mjs so it can be tested.

const FLAGS = ['--mock', '--paper', '--dev', '--no-open'];

/**
 * --mock: local mock exchange instead of OKX (made-up prices); --paper: paper trading (OKX's live prices, a
 * simulated account); --dev: Vite dev server instead of the built page; --no-open: no browser.
 */
export function parseFlags(argv) {
  const unknown = argv.filter((arg) => !FLAGS.includes(arg));
  if (unknown.length > 0) throw new Error(`不认识的参数：${unknown.join(' ')}（可用：--paper 纸面交易（OKX 实盘行情，虚拟账户），--mock 使用本地模拟交易所，--dev 开发模式，--no-open 不自动打开浏览器）`);
  if (argv.includes('--mock') && argv.includes('--paper')) throw new Error('--mock 和 --paper 不能同时使用：--mock 的行情是随机生成的，--paper 用的是 OKX 实盘行情');
  return { mock: argv.includes('--mock'), paper: argv.includes('--paper'), dev: argv.includes('--dev'), open: !argv.includes('--no-open') };
}

/**
 * What paper trading adds to the environment of the API. Like --mock it wins over .env there, so a key in .env
 * is never used: the API signs with a placeholder and sends what it signs to the paper exchange only. The
 * market data endpoints are left alone (OKX's live hosts, or the ones .env names).
 */
export function paperEnv(port = 9200) {
  return {
    PAPER_EXCHANGE_URL: `http://127.0.0.1:${port}`,
    OKX_API_KEY: 'paper',
    OKX_API_SECRET: 'paper',
    OKX_API_PASSPHRASE: 'paper',
    OKX_DEMO: '0',
    // the paper account must not inherit, or overwrite, the real account's halt and day baseline, nor its order journal
    STATE_FILE: 'data/pegasus-state.paper.json',
    DATABASE_URL: '',
  };
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
