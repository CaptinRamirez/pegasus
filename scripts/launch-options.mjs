// The launcher's command line and the environment it gives its children; kept apart from start.mjs so it can be tested.

const FLAGS = ['--mock', '--paper', '--campaign', '--dev', '--no-open'];

/**
 * --mock: local mock exchange instead of OKX (made-up prices); --paper: paper trading (OKX's live prices, a
 * simulated account); --campaign: paper trading on the campaign pot's own paper account, with the campaign enabled
 * (it is paper trading, so `paper` is true with it); --dev: Vite dev server instead of the built page; --no-open: no
 * browser.
 */
export function parseFlags(argv) {
  const unknown = argv.filter((arg) => !FLAGS.includes(arg));
  if (unknown.length > 0) {
    throw new Error(`不认识的参数：${unknown.join(' ')}（可用：--paper 纸面交易（OKX 实盘行情，虚拟账户），--campaign 滚仓（纸面交易，资金池专用的虚拟账户），--mock 使用本地模拟交易所，--dev 开发模式，--no-open 不自动打开浏览器）`);
  }
  if (argv.includes('--mock') && argv.includes('--paper')) throw new Error('--mock 和 --paper 不能同时使用：--mock 的行情是随机生成的，--paper 用的是 OKX 实盘行情');
  if (argv.includes('--mock') && argv.includes('--campaign')) throw new Error('--mock 和 --campaign 不能同时使用：滚仓只在纸面交易上运行（OKX 实盘行情，虚拟账户），--mock 的行情是随机生成的');
  const campaign = argv.includes('--campaign');
  return { mock: argv.includes('--mock'), paper: campaign || argv.includes('--paper'), campaign, dev: argv.includes('--dev'), open: !argv.includes('--no-open') };
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

/** What the pot starts with unless .env says otherwise (CAMPAIGN_POT_START, DEFAULT_POT_PARAMS.start in @pegasus/shared). */
export const CAMPAIGN_POT_START = '56';

/**
 * What --campaign adds to the environment of the API and of the paper exchange: paper trading (paperEnv) on the
 * pot's own paper account, data/paper-campaign.json, which a new account opens with `potStart` USDT (the pot starts
 * only on an account whose equity is its start; an existing account keeps its balance), the campaign enabled with
 * its ledger in data/campaign-ledger.json, and the API's kill switch and day baseline in a file of their own. The
 * owner's own paper account (data/paper-account.json) and its state file are never touched. It wins over .env.
 */
export function campaignEnv(port = 9200, potStart = CAMPAIGN_POT_START) {
  return {
    ...paperEnv(port),
    STATE_FILE: 'data/pegasus-state.campaign.json',
    CAMPAIGN_ENABLED: '1',
    CAMPAIGN_STATE_FILE: 'data/campaign-ledger.json',
    PAPER_STATE_FILE: 'data/paper-campaign.json',
    PAPER_BALANCE: potStart,
  };
}

/**
 * What the paper exchange is given on top of the environment and of .env (which it reads itself, and which this wins
 * over): its port and, with --campaign, the pot's own account and the campaign enabled, so that it trades the
 * campaign's instruments. Plain --paper leaves its account to .env (data/paper-account.json by default).
 */
export function paperExchangeEnv(flags, overrides, port = 9200) {
  return { ...(flags.campaign ? overrides : {}), PAPER_PORT: String(port) };
}

/** The pot's start from .env when it is a positive decimal (the API refuses anything else), CAMPAIGN_POT_START otherwise. */
export function potStartOf(env) {
  const value = env.CAMPAIGN_POT_START;
  return typeof value === 'string' && /^\d+(\.\d+)?$/.test(value) && Number(value) > 0 ? value : CAMPAIGN_POT_START;
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
