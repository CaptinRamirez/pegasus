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

/** The ports of a plain or --paper stack: the API's and the paper exchange's from .env, the page's the one vite.config.ts names. */
export const DEFAULT_PORTS = { api: 8787, paper: 9200, web: 5174 };

/**
 * The ports of the --campaign stack: its own, so that it runs beside `pnpm start` or `pnpm start --paper`. They win
 * over API_PORT and PAPER_PORT in .env; CAMPAIGN_API_PORT, CAMPAIGN_PAPER_PORT and CAMPAIGN_WEB_PORT move them.
 */
export const CAMPAIGN_PORTS = { api: 8788, paper: 9201, web: 5175 };

/** A TCP port from the environment, or the fallback when it is not one. */
function portOf(value, fallback) {
  const n = Number(value);
  return typeof value === 'string' && /^\d+$/.test(value) && n >= 1 && n <= 65535 ? n : fallback;
}

/** The ports of the stack the flags start: the API, the paper exchange (used with paper trading only) and the page. */
export function stackPorts(flags, env) {
  if (flags.campaign) {
    return { api: portOf(env.CAMPAIGN_API_PORT, CAMPAIGN_PORTS.api), paper: portOf(env.CAMPAIGN_PAPER_PORT, CAMPAIGN_PORTS.paper), web: portOf(env.CAMPAIGN_WEB_PORT, CAMPAIGN_PORTS.web) };
  }
  return { api: portOf(env.API_PORT, DEFAULT_PORTS.api), paper: portOf(env.PAPER_PORT, DEFAULT_PORTS.paper), web: DEFAULT_PORTS.web };
}

/** Where the page is built for a stack: the campaign's apart, so that building it never changes the page another stack serves. */
export function webOutDir(flags) {
  return flags.campaign ? 'dist-campaign' : 'dist';
}

/** The origins of the page served on `webPort`: what the API's WEB_ORIGINS must list. */
export function webOrigins(webPort) {
  return `http://localhost:${webPort},http://127.0.0.1:${webPort}`;
}

/**
 * The page's server settings for one stack (scripts/vite.stack.config.mjs): its port, and /api and /ws proxied to the
 * API of the same stack. The page reaches the API same-origin through this proxy; the API checks the Origin of the
 * page against WEB_ORIGINS and the token the page sends.
 */
export function webServerOptions(webPort, apiPort) {
  return {
    port: webPort,
    strictPort: true,
    // The terminal must never render inside another site's frame: a hidden frame could relay clicks to Buy/Sell.
    headers: { 'X-Frame-Options': 'DENY', 'Content-Security-Policy': "frame-ancestors 'none'" },
    proxy: {
      '/api': { target: `http://127.0.0.1:${apiPort}`, changeOrigin: true },
      '/ws': { target: `ws://127.0.0.1:${apiPort}`, ws: true },
    },
  };
}

/** What the page's server is given: the ports scripts/vite.stack.config.mjs reads. */
export function webEnv(ports) {
  return { PEGASUS_WEB_PORT: String(ports.web), PEGASUS_API_PORT: String(ports.api) };
}

/**
 * What paper trading adds to the environment of the API. Like --mock it wins over .env there, so a key in .env
 * is never used: the API signs with a placeholder and sends what it signs to the paper exchange only. The
 * market data endpoints are left alone (OKX's live hosts, or the ones .env names).
 */
export function paperEnv(port = DEFAULT_PORTS.paper) {
  return {
    PAPER_EXCHANGE_URL: `http://127.0.0.1:${port}`,
    OKX_API_KEY: 'paper',
    OKX_API_SECRET: 'paper',
    OKX_API_PASSPHRASE: 'paper',
    OKX_DEMO: '0',
    // the paper account must not inherit, or overwrite, the real account's halt and day baseline, nor its order journal
    STATE_FILE: 'data/pegasus-state.paper.json',
    // nor its trade journal
    JOURNAL_FILE: 'data/journal.paper.json',
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
 * owner's own paper account (data/paper-account.json) and its state file are never touched. Its own ports (the API's
 * and its page's; the paper exchange's is `port`), log directory and trade journal, so that it runs beside another
 * stack. It wins over .env.
 */
export function campaignEnv(port = CAMPAIGN_PORTS.paper, potStart = CAMPAIGN_POT_START, ports = CAMPAIGN_PORTS) {
  return {
    ...paperEnv(port),
    STATE_FILE: 'data/pegasus-state.campaign.json',
    JOURNAL_FILE: 'data/journal.campaign.json',
    LOG_DIR: 'logs/campaign',
    API_PORT: String(ports.api),
    WEB_ORIGINS: webOrigins(ports.web),
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
    // nor its trade journal
    JOURNAL_FILE: 'data/journal.mock.json',
    DATABASE_URL: '',
  };
}
