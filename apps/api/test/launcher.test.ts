/**
 * The launcher (scripts/start.mjs). Its command line and the --mock environment are tested directly; the
 * script itself only ever runs here inside a throw-away copy of the tree whose "vite" is a stub, so no
 * service, port or exchange is involved.
 */
import { spawnSync } from 'node:child_process';
import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { paperInstruments } from '@pegasus/paper';
import { CAMPAIGN_INSTRUMENTS } from '@pegasus/shared';
import { loadConfig } from '../src/config.js';

const repo = resolve(dirname(fileURLToPath(import.meta.url)), '../../..');
const scripts = join(repo, 'scripts');

interface StackPorts {
  api: number;
  paper: number;
  web: number;
}
interface LaunchOptions {
  parseFlags(argv: string[]): { mock: boolean; paper: boolean; campaign: boolean; dev: boolean; open: boolean };
  mockEnv(port?: number): Record<string, string>;
  paperEnv(port?: number): Record<string, string>;
  campaignEnv(port?: number, potStart?: string, ports?: StackPorts): Record<string, string>;
  paperExchangeEnv(flags: { campaign: boolean }, overrides: Record<string, string>, port?: number): Record<string, string>;
  potStartOf(env: Record<string, string | undefined>): string;
  DEFAULT_PORTS: StackPorts;
  CAMPAIGN_PORTS: StackPorts;
  stackPorts(flags: { campaign: boolean }, env: Record<string, string | undefined>): StackPorts;
  webOutDir(flags: { campaign: boolean }): string;
  webOrigins(webPort: number): string;
  webServerOptions(webPort: number, apiPort: number): { port: number; strictPort: boolean; proxy: Record<string, { target: string; ws?: boolean; changeOrigin?: boolean }> };
  webEnv(ports: StackPorts): Record<string, string>;
}
const options = (await import(pathToFileURL(join(scripts, 'launch-options.mjs')).href)) as LaunchOptions;

describe('launcher options', () => {
  it('understands --mock, --paper, --campaign, --dev and --no-open and refuses anything else', () => {
    expect(options.parseFlags([])).toEqual({ mock: false, paper: false, campaign: false, dev: false, open: true });
    expect(options.parseFlags(['--mock', '--no-open'])).toEqual({ mock: true, paper: false, campaign: false, dev: false, open: false });
    expect(options.parseFlags(['--paper'])).toEqual({ mock: false, paper: true, campaign: false, dev: false, open: true });
    expect(options.parseFlags(['--dev'])).toEqual({ mock: false, paper: false, campaign: false, dev: true, open: true });
    // the campaign is paper trading
    expect(options.parseFlags(['--campaign'])).toEqual({ mock: false, paper: true, campaign: true, dev: false, open: true });
    expect(options.parseFlags(['--campaign', '--paper', '--dev'])).toEqual({ mock: false, paper: true, campaign: true, dev: true, open: true });
    expect(() => options.parseFlags(['--mcok'])).toThrow('--mcok');
    // made-up prices and real prices are two different things
    expect(() => options.parseFlags(['--mock', '--paper'])).toThrow('不能同时使用');
    expect(() => options.parseFlags(['--campaign', '--mock'])).toThrow('--mock 和 --campaign 不能同时使用');
  });

  it('--paper keeps the market data on OKX live, sends the account side to the paper exchange and never uses the key in .env', () => {
    const env = options.paperEnv();
    expect(env).toMatchObject({ PAPER_EXCHANGE_URL: 'http://127.0.0.1:9200', OKX_API_KEY: 'paper', OKX_DEMO: '0' });
    expect(env).not.toHaveProperty('INSTRUMENTS');
    const config = loadConfig({ OKX_API_KEY: 'live-key', OKX_API_SECRET: 'live-secret', OKX_API_PASSPHRASE: 'live-pass', OKX_DEMO: '1', INSTRUMENTS: 'SOL-USDT-SWAP', DATABASE_URL: 'postgres://live', ...env });
    expect(config.okx).toMatchObject({
      credentials: { apiKey: 'paper', apiSecret: 'paper', passphrase: 'paper' },
      demo: false,
      paper: true,
      endpoints: { rest: 'https://www.okx.com', wsPublic: 'wss://ws.okx.com/ws/v5/public', wsBusiness: 'wss://ws.okx.com/ws/v5/business', restPrivate: 'http://127.0.0.1:9200', wsPrivate: 'ws://127.0.0.1:9200/ws/v5/private' },
    });
    // the instruments are the owner's own; the halt, the day baseline and the journals are the paper account's
    expect(config.instruments).toEqual(['SOL-USDT-SWAP', ...CAMPAIGN_INSTRUMENTS]);
    expect(config.stateFile).toMatch(/pegasus-state\.paper\.json$/);
    expect(config.journalFile).toBe(join(repo, 'data', 'journal.paper.json'));
    expect(config.databaseUrl).toBeFalsy();
    expect(options.paperEnv(9300).PAPER_EXCHANGE_URL).toBe('http://127.0.0.1:9300');
  });

  it('--mock points all four endpoints at the mock, with mock credentials, its two instruments and its own state file', () => {
    const env = options.mockEnv();
    expect(env).toMatchObject({ OKX_REST_URL: 'http://127.0.0.1:9100', OKX_API_SECRET: 'mock', INSTRUMENTS: 'BTC-USDT-SWAP,ETH-USDT-SWAP' });
    // it replaces what .env would say, and the result is a configuration the API accepts
    const config = loadConfig({ OKX_API_KEY: 'live-key', OKX_API_SECRET: 'live-secret', OKX_API_PASSPHRASE: 'live-pass', OKX_DEMO: '0', INSTRUMENTS: 'SOL-USDT-SWAP', DATABASE_URL: 'postgres://live', ...env });
    expect(config.okx).toMatchObject({
      credentials: { apiKey: 'mock', apiSecret: 'mock', passphrase: 'mock' },
      demo: true,
      endpoints: { rest: 'http://127.0.0.1:9100', wsPublic: 'ws://127.0.0.1:9100/ws/v5/public', wsPrivate: 'ws://127.0.0.1:9100/ws/v5/private', wsBusiness: 'ws://127.0.0.1:9100/ws/v5/business' },
    });
    expect(config.instruments).toEqual(['BTC-USDT-SWAP', 'ETH-USDT-SWAP']);
    expect(config.stateFile).toMatch(/pegasus-state\.mock\.json$/);
    expect(config.journalFile).toBe(join(repo, 'data', 'journal.mock.json'));
    expect(config.databaseUrl).toBeFalsy();
    expect(options.mockEnv(9200).OKX_WS_PRIVATE_URL).toBe('ws://127.0.0.1:9200/ws/v5/private');
  });

  it('CAMPAIGN_ENABLED=1 in .env starts with --paper only: --mock and a plain start are refused', () => {
    const env = { OKX_API_KEY: 'live-key', OKX_API_SECRET: 'live-secret', OKX_API_PASSPHRASE: 'live-pass', OKX_DEMO: '0', CAMPAIGN_ENABLED: '1' };
    expect(loadConfig({ ...env, ...options.paperEnv() }).campaign.enabled).toBe(true);
    expect(() => loadConfig({ ...env, ...options.mockEnv() })).toThrow(/paper only/);
    expect(() => loadConfig(env)).toThrow(/paper only/);
  });

  it("--campaign is paper trading on the pot's own account, with the campaign enabled, whatever .env says", () => {
    const dotenv = { OKX_API_KEY: 'live-key', OKX_API_SECRET: 'live-secret', OKX_API_PASSPHRASE: 'live-pass', OKX_DEMO: '1', DATABASE_URL: 'postgres://live', CAMPAIGN_ENABLED: '0', CAMPAIGN_STATE_FILE: 'data/other-ledger.json', STATE_FILE: 'data/pegasus-state.json', INSTRUMENTS: 'SOL-USDT-SWAP' };
    const env = options.campaignEnv();
    expect(env).toMatchObject({ ...options.paperEnv(9201), STATE_FILE: 'data/pegasus-state.campaign.json', JOURNAL_FILE: 'data/journal.campaign.json', CAMPAIGN_ENABLED: '1', CAMPAIGN_STATE_FILE: 'data/campaign-ledger.json', PAPER_STATE_FILE: 'data/paper-campaign.json', PAPER_BALANCE: '56' });
    const config = loadConfig({ ...dotenv, ...env });
    expect(config.okx).toMatchObject({ paper: true, demo: false, credentials: { apiKey: 'paper', apiSecret: 'paper', passphrase: 'paper' }, endpoints: { restPrivate: 'http://127.0.0.1:9201' } });
    expect(config.campaign).toMatchObject({ enabled: true, potStart: '56', instruments: [...CAMPAIGN_INSTRUMENTS] });
    expect(config.campaign.stateFile).toBe(join(repo, 'data', 'campaign-ledger.json'));
    // the kill switch and the day baseline of its own: neither the live account's nor the owner's paper account's
    expect(config.stateFile).toBe(join(repo, 'data', 'pegasus-state.campaign.json'));
    expect(options.paperEnv().STATE_FILE).toBe('data/pegasus-state.paper.json');
    expect(config.databaseUrl).toBeFalsy();
    // the signals stay the terminal's own instruments
    expect(config.signalInstruments).toEqual(['SOL-USDT-SWAP']);

    // the paper exchange: the pot's own account, never the owner's data/paper-account.json, trading the campaign's instruments
    const exchange = options.paperExchangeEnv(options.parseFlags(['--campaign']), env, 9300);
    expect(exchange).toMatchObject({ PAPER_PORT: '9300', PAPER_STATE_FILE: 'data/paper-campaign.json', PAPER_BALANCE: '56', CAMPAIGN_ENABLED: '1' });
    expect(paperInstruments({ ...dotenv, ...exchange, PAPER_INSTRUMENTS: 'DOGE-USDT-SWAP' })).toEqual(['DOGE-USDT-SWAP', 'SOL-USDT-SWAP', ...CAMPAIGN_INSTRUMENTS]);
    // plain --paper leaves the paper exchange its own settings: the owner's account
    expect(options.paperExchangeEnv(options.parseFlags(['--paper']), options.paperEnv(), 9200)).toEqual({ PAPER_PORT: '9200' });

    // a new account opens with the pot's start: the one .env gives, when it is one the API accepts
    expect(options.potStartOf({})).toBe('56');
    expect(options.potStartOf({ CAMPAIGN_POT_START: '100' })).toBe('100');
    expect(options.potStartOf({ CAMPAIGN_POT_START: 'lots' })).toBe('56');
    expect(options.potStartOf({ CAMPAIGN_POT_START: '0' })).toBe('56');
    expect(options.campaignEnv(9200, '100').PAPER_BALANCE).toBe('100');
  });
});

describe('the campaign stack beside another one', () => {
  it('has its own ports, page origins, log directory, trade journal and built page; .env cannot point it at the other stack', () => {
    expect(options.CAMPAIGN_PORTS).toEqual({ api: 8788, paper: 9201, web: 5175 });
    const dotenv = { API_PORT: '8787', PAPER_PORT: '9200', WEB_ORIGINS: 'http://localhost:5174', LOG_DIR: 'logs', JOURNAL_FILE: 'data/journal.json', PAPER_TRADING: '1' };
    const campaign = options.parseFlags(['--campaign']);
    const paper = options.parseFlags(['--paper']);
    // .env's API_PORT and PAPER_PORT are the other stack's
    expect(options.stackPorts(campaign, dotenv)).toEqual({ api: 8788, paper: 9201, web: 5175 });
    expect(options.stackPorts(paper, dotenv)).toEqual({ api: 8787, paper: 9200, web: 5174 });
    expect(options.stackPorts(paper, { API_PORT: '9000', PAPER_PORT: '9300' })).toEqual({ api: 9000, paper: 9300, web: 5174 });
    // its own ports can be moved, never to something that is not a port
    expect(options.stackPorts(campaign, { CAMPAIGN_API_PORT: '18788', CAMPAIGN_PAPER_PORT: '19201', CAMPAIGN_WEB_PORT: '15175' })).toEqual({ api: 18788, paper: 19201, web: 15175 });
    expect(options.stackPorts(campaign, { CAMPAIGN_API_PORT: 'eighty', CAMPAIGN_WEB_PORT: '70000' })).toEqual({ api: 8788, paper: 9201, web: 5175 });

    const ports = options.stackPorts(campaign, dotenv);
    const env = options.campaignEnv(ports.paper, '56', ports);
    expect(env).toMatchObject({ API_PORT: '8788', PAPER_EXCHANGE_URL: 'http://127.0.0.1:9201', WEB_ORIGINS: 'http://localhost:5175,http://127.0.0.1:5175', LOG_DIR: 'logs/campaign', JOURNAL_FILE: 'data/journal.campaign.json' });
    const c = loadConfig({ ...dotenv, ...env });
    const p = loadConfig({ ...dotenv, ...options.paperEnv(9200) });
    expect(c.server).toMatchObject({ port: 8788, webOrigins: ['http://localhost:5175', 'http://127.0.0.1:5175'] });
    expect(p.server).toMatchObject({ port: 8787, webOrigins: ['http://localhost:5174'] });
    expect(c.logDir).toBe(join(repo, 'logs', 'campaign'));
    expect(c.journalFile).toBe(join(repo, 'data', 'journal.campaign.json'));
    // no file and no port in common with the paper stack
    const files = (x: typeof c): string[] => [x.stateFile, x.journalFile, x.logDir, x.okx.endpoints.restPrivate ?? ''];
    for (const f of files(c)) expect(files(p)).not.toContain(f);
    expect(options.paperExchangeEnv(campaign, env, ports.paper)).toMatchObject({ PAPER_PORT: '9201', PAPER_STATE_FILE: 'data/paper-campaign.json' });

    // the page: built apart, served on its port, its API calls proxied to its own API
    expect(options.webOutDir(campaign)).toBe('dist-campaign');
    expect(options.webOutDir(paper)).toBe('dist');
    expect(options.webEnv(ports)).toEqual({ PEGASUS_WEB_PORT: '5175', PEGASUS_API_PORT: '8788' });
    expect(options.webServerOptions(5175, 8788)).toEqual({
      port: 5175,
      strictPort: true,
      proxy: { '/api': { target: 'http://127.0.0.1:8788', changeOrigin: true }, '/ws': { target: 'ws://127.0.0.1:8788', ws: true } },
    });
    // the origins the page is served under are the ones its API accepts
    expect(options.webOrigins(5175).split(',')).toEqual(c.server.webOrigins);
  });

  it("the page's server settings are the web app's own with the stack's ports", async () => {
    process.env['PEGASUS_WEB_PORT'] = '5175';
    process.env['PEGASUS_API_PORT'] = '8788';
    try {
      const config = ((await import(pathToFileURL(join(scripts, 'vite.stack.config.mjs')).href)) as { default: { plugins?: unknown[]; server: Record<string, unknown>; preview: Record<string, unknown> } }).default;
      // the web app's plugins are kept
      expect(config.plugins?.length).toBeGreaterThan(0);
      for (const server of [config.server, config.preview]) {
        expect(server).toMatchObject({ port: 5175, strictPort: true, proxy: { '/api': { target: 'http://127.0.0.1:8788' }, '/ws': { target: 'ws://127.0.0.1:8788', ws: true } } });
      }
    } finally {
      delete process.env['PEGASUS_WEB_PORT'];
      delete process.env['PEGASUS_API_PORT'];
    }
  });
});

describe('launcher in a stub tree', () => {
  let root: string;
  let freePort: number;

  beforeEach(async () => {
    root = mkdtempSync(join(tmpdir(), 'pegasus-launcher-'));
    mkdirSync(join(root, 'scripts'));
    for (const name of ['start.mjs', 'launch-options.mjs']) copyFileSync(join(scripts, name), join(root, 'scripts', name));
    for (const dir of ['apps/api/node_modules', 'packages/mock-okx/node_modules', 'packages/paper/node_modules', 'apps/web/node_modules/vite/bin']) mkdirSync(join(root, dir), { recursive: true });
    // a "vite" whose build fails the way a real one does: an error on stderr and a non-zero exit code
    writeFileSync(join(root, 'apps/web/node_modules/vite/bin/vite.js'), "console.error('error during build: Could not resolve \"./missing\"');\nprocess.exit(3);\n");
    writeFileSync(join(root, '.env'), 'OKX_API_SECRET=live-secret\n');
    freePort = await new Promise<number>((done) => {
      const probe = createServer().listen(0, '127.0.0.1', () => {
        const address = probe.address();
        probe.close(() => done(typeof address === 'object' && address !== null ? address.port : 0));
      });
    });
  });
  afterEach(() => {
    rmSync(root, { recursive: true, force: true });
  });

  const extraEnv: Record<string, string> = {};
  const launch = (...flags: string[]) =>
    spawnSync(process.execPath, [join(root, 'scripts', 'start.mjs'), '--no-open', ...flags], {
      encoding: 'utf8',
      timeout: 30_000,
      env: { PATH: process.env['PATH'], SystemRoot: process.env['SystemRoot'], API_PORT: String(freePort), MOCK_OKX_PORT: String(freePort), ...extraEnv },
    });

  it('a failed build is said plainly, nothing is started and the exit code is not zero', () => {
    const run = launch();
    expect(run.status).toBe(1);
    expect(run.stdout).toContain('正在构建前端页面');
    expect(run.stdout).toContain('前端页面构建失败（退出码 3），Pegasus 没有启动');
    expect(run.stderr).toContain('Could not resolve');
    expect(run.stdout).not.toContain('正在启动');
    // best effort: the copy is not a git repository
    expect(run.stdout).toContain('版本：');
  });

  it('--mock never writes to .env', () => {
    const run = launch('--mock');
    expect(run.status).toBe(1);
    expect(run.stdout).toContain('--mock');
    expect(readFileSync(join(root, '.env'), 'utf8')).toBe('OKX_API_SECRET=live-secret\n');
  });

  it('--paper, or PAPER_TRADING=1 in .env, says that it is paper trading and never writes to .env', () => {
    const flagged = launch('--paper');
    expect(flagged.status).toBe(1); // the stub build fails; the mode is announced before it
    expect(flagged.stdout).toContain('纸面交易模式（OKX 实盘行情，虚拟账户，不会向 OKX 下单）');
    expect(readFileSync(join(root, '.env'), 'utf8')).toBe('OKX_API_SECRET=live-secret\n');

    writeFileSync(join(root, '.env'), 'PAPER_TRADING=1\n');
    expect(launch().stdout).toContain('纸面交易模式');
    // --mock wins over the setting in .env: the mock has no real prices to trade on
    expect(launch('--mock').stdout).not.toContain('纸面交易模式');
    writeFileSync(join(root, '.env'), 'PAPER_TRADING=0\n');
    expect(launch().stdout).not.toContain('纸面交易模式');
  });

  it("--campaign says that it runs the campaign on the pot's own paper account, never writes to .env, and is refused with --mock", () => {
    writeFileSync(join(root, '.env'), 'PAPER_TRADING=0\nCAMPAIGN_ENABLED=0\n');
    const run = launch('--campaign');
    expect(run.status).toBe(1); // the stub build fails; the mode is announced before it
    expect(run.stdout).toContain('滚仓模式（纸面交易：OKX 实盘行情，资金池专用的虚拟账户 data/paper-campaign.json，账本 data/campaign-ledger.json，不会向 OKX 下单）');
    expect(run.stdout).not.toContain('纸面交易模式');
    expect(readFileSync(join(root, '.env'), 'utf8')).toBe('PAPER_TRADING=0\nCAMPAIGN_ENABLED=0\n');
    const both = launch('--mock', '--campaign');
    expect(both.status).toBe(1);
    expect(both.stdout).toContain('--mock 和 --campaign 不能同时使用');
    expect(both.stdout).not.toContain('正在构建');
  });

  it('--campaign builds its page apart and says its own ports; the others build the usual page', () => {
    // a "vite" that says how it was called, then fails like a build that went wrong
    writeFileSync(join(root, 'apps/web/node_modules/vite/bin/vite.js'), "console.log('vite ' + process.argv.slice(2).join(' '));\nprocess.exit(3);\n");
    writeFileSync(join(root, '.env'), 'PAPER_TRADING=0\n');
    Object.assign(extraEnv, { CAMPAIGN_API_PORT: String(freePort), CAMPAIGN_PAPER_PORT: String(freePort), CAMPAIGN_WEB_PORT: String(freePort) });
    try {
      const campaign = launch('--campaign');
      expect(campaign.status).toBe(1);
      expect(campaign.stdout).toContain(`滚仓使用自己的端口（后端 ${freePort}，纸面交易所 ${freePort}，页面 ${freePort}）、日志目录 logs/campaign 和交易日志 data/journal.campaign.json，可以和 pnpm start --paper 同时运行`);
      expect(campaign.stdout).toContain('vite build --outDir dist-campaign');
      const plain = launch();
      expect(plain.stdout).toContain('vite build --outDir dist');
      expect(plain.stdout).not.toContain('滚仓使用自己的端口');
    } finally {
      for (const key of ['CAMPAIGN_API_PORT', 'CAMPAIGN_PAPER_PORT', 'CAMPAIGN_WEB_PORT']) delete extraEnv[key];
    }
  });

  it('paper trading is refused while .env points the market data at the mock exchange', () => {
    writeFileSync(join(root, '.env'), `OKX_REST_URL=http://127.0.0.1:${freePort}\n`);
    const run = launch('--paper');
    expect(run.status).toBe(1);
    expect(run.stdout).toContain('纸面交易需要 OKX 的真实行情');
    expect(run.stdout).not.toContain('正在构建');
  });

  it('an unknown flag is refused before anything runs', () => {
    const run = launch('--mcok');
    expect(run.status).toBe(1);
    expect(run.stdout).toContain('不认识的参数：--mcok');
    expect(run.stdout).not.toContain('正在构建');
  });
});
