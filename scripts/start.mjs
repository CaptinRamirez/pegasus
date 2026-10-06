// One-command launcher behind `pnpm start` and start.bat: builds the web terminal, then starts the mock exchange
// (with --mock, or when .env points the API at it) or the paper exchange (with --paper or --campaign, or
// PAPER_TRADING=1 in .env), the API and the built terminal in order and opens the browser.
// The page is built once and served as it was built, so a `git pull` while the stack runs changes neither half.
// Flags: --paper (paper trading: OKX's live prices, a simulated account), --campaign (paper trading on the campaign
// pot's own paper account, data/paper-campaign.json, with the campaign enabled; start-campaign.bat), --mock (local
// mock exchange instead of OKX), --dev (Vite dev server with hot reload), --no-open.
// --campaign has its own ports (API 8788, paper exchange 9201, page 5175), log directory, trade journal and built
// page (apps/web/dist-campaign), so it runs beside `pnpm start` or `pnpm start --paper`. The page reaches its API
// through the proxy of scripts/vite.stack.config.mjs, which points it at the API of its own stack.
import { exec, execFileSync, spawn } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { connect } from 'node:net';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseEnv } from 'node:util';
import { campaignEnv, mockEnv, paperEnv, paperExchangeEnv, parseFlags, potStartOf, stackPorts, webEnv, webOutDir } from './launch-options.mjs';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const envFile = join(root, '.env');
// The page's server settings with the ports of the stack (its proxy to the API of the same stack), relative to apps/web.
const STACK_CONFIG = '../../scripts/vite.stack.config.mjs';

const children = new Map();
let stopping = false;
let exitCode = 0;
let webUrl = null;

const say = (msg) => console.log(`[pegasus] ${msg}`);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** The commit the stack is started from; null when git or the repository is not there. */
function gitVersion() {
  try {
    return execFileSync('git', ['rev-parse', '--short', 'HEAD'], { cwd: root, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'], timeout: 5_000 }).trim() || null;
  } catch {
    return null;
  }
}

/** Port of the mock exchange when OKX_REST_URL points at this machine; null when the API talks to the real OKX. */
function localPort(url) {
  if (!url || !URL.canParse(url)) return null;
  const { hostname, port } = new URL(url);
  return ['127.0.0.1', 'localhost', '[::1]'].includes(hostname) ? Number(port || 80) : null;
}

/** Runs one service with this Node binary; the commands mirror the packages' own start/dev scripts. */
function start(name, dir, args, opts = {}) {
  const child = spawn(process.execPath, args, { cwd: join(root, dir), env: { ...process.env, ...opts.env }, stdio: opts.stdio ?? ['ignore', 'inherit', 'inherit'] });
  children.set(name, child);
  child.on('error', (err) => {
    children.delete(name);
    say(`${name}无法启动：${err.message}`);
    stop(1);
  });
  child.on('exit', (code, signal) => {
    children.delete(name);
    if (stopping) {
      if (children.size === 0) process.exit(exitCode);
      return;
    }
    say(`${name}意外退出（${signal ?? `退出码 ${code}`}），正在停止其余服务`);
    stop(1);
  });
  return child;
}

/** Runs a command to its end (the web build) and resolves with its exit code. */
function runToEnd(name, dir, args) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, args, { cwd: join(root, dir), stdio: ['ignore', 'inherit', 'inherit'] });
    children.set(name, child);
    child.on('error', (err) => {
      children.delete(name);
      reject(new Error(`${name}无法启动：${err.message}`));
    });
    child.on('exit', (code) => {
      children.delete(name);
      if (!stopping) resolve(code ?? 1);
      else if (children.size === 0) process.exit(exitCode);
    });
  });
}

function stop(code, viaTerminal = false) {
  if (stopping) return;
  stopping = true;
  exitCode = code;
  if (children.size === 0) process.exit(code);
  // Ctrl+C reaches every process attached to the terminal, so the children are already shutting down by themselves.
  if (!viaTerminal) for (const child of children.values()) child.kill();
  setTimeout(() => {
    for (const child of children.values()) child.kill('SIGKILL');
    process.exit(code);
  }, 5_000).unref();
}

function portOpen(port) {
  return new Promise((resolve) => {
    const socket = connect({ host: '127.0.0.1', port, timeout: 1_000 });
    const done = (open) => {
      socket.destroy();
      resolve(open);
    };
    socket.once('connect', () => done(true));
    socket.once('error', () => done(false));
    socket.once('timeout', () => done(false));
  });
}

async function apiHealthy(apiPort) {
  try {
    return (await fetch(`http://127.0.0.1:${apiPort}/api/health`, { signal: AbortSignal.timeout(2_000) })).ok;
  } catch {
    return false;
  }
}

async function waitFor(what, ready, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  while (!(await ready())) {
    if (Date.now() > deadline) throw new Error(`${what}在 ${timeoutMs / 1_000} 秒内没有就绪`);
    await sleep(250);
  }
}

/**
 * Serves the built page with `vite preview`, or runs the dev server with --dev, on the stack's page port with /api and
 * /ws proxied to the stack's API (scripts/vite.stack.config.mjs). Either way Vite's output is piped so the URL it
 * settles on can be read; that also keeps it from clearing the other services' logs.
 */
function startWeb(dev, ports, outDir) {
  const args = dev ? ['--config', STACK_CONFIG, '--port', String(ports.web), '--strictPort'] : ['preview', '--config', STACK_CONFIG, '--port', String(ports.web), '--strictPort', '--outDir', outDir];
  const child = start('前端', 'apps/web', ['node_modules/vite/bin/vite.js', ...args], { stdio: ['ignore', 'pipe', 'inherit'], env: webEnv(ports) });
  let seen = '';
  child.stdout.setEncoding('utf8');
  child.stdout.on('data', (text) => {
    process.stdout.write(text);
    if (webUrl !== null) return;
    seen += text;
    webUrl = /Local:\s+(\S+)/.exec(seen.replace(/\x1b\[[0-9;]*m/g, ''))?.[1] ?? null;
  });
}

function openBrowser(url) {
  const cmd = process.platform === 'win32' ? `start "" "${url}"` : process.platform === 'darwin' ? `open "${url}"` : `xdg-open "${url}"`;
  exec(cmd, () => {}); // best effort: a missing opener must not take the stack down
}

async function main() {
  const flags = parseFlags(process.argv.slice(2));
  for (const dir of ['apps/api', 'apps/web', 'packages/mock-okx', 'packages/paper']) {
    if (!existsSync(join(root, dir, 'node_modules'))) throw new Error('依赖还没有安装，请先在项目目录运行：pnpm install');
  }
  if (!existsSync(envFile)) say('没有找到 .env，后端将使用默认配置（可以把 .env.example 复制为 .env 再修改）');

  // Same precedence as node --env-file: a variable already set in the environment wins over the file.
  const base = { ...(existsSync(envFile) ? parseEnv(readFileSync(envFile, 'utf8')) : {}), ...process.env };
  // Paper trading is chosen on the command line or, for double-clicking start.bat, by PAPER_TRADING=1 in .env.
  const paper = flags.paper || (!flags.mock && base.PAPER_TRADING === '1');
  // --campaign has ports of its own (CAMPAIGN_*_PORT move them); the others take API_PORT and PAPER_PORT from .env.
  const ports = stackPorts(flags, base);
  const paperPort = paper ? ports.paper : null;
  // --mock, --paper and --campaign only change what the children see; .env is read here, never written.
  const overrides = flags.mock ? mockEnv(Number(process.env.MOCK_OKX_PORT ?? 9100)) : flags.campaign ? campaignEnv(ports.paper, potStartOf(base), ports) : paper ? paperEnv(paperPort) : {};
  const env = { ...base, ...overrides };
  const apiPort = ports.api;
  const mockPort = localPort(env.OKX_REST_URL);
  if (paper && mockPort !== null) throw new Error('纸面交易需要 OKX 的真实行情，但 .env 里的 OKX_REST_URL 指向了本机的模拟交易所；请删掉 .env 里的四个 OKX_*_URL 再启动');
  const version = gitVersion();
  const mode = flags.campaign
    ? '，滚仓模式（纸面交易：OKX 实盘行情，资金池专用的虚拟账户 data/paper-campaign.json，账本 data/campaign-ledger.json，不会向 OKX 下单）'
    : paper
      ? '，纸面交易模式（OKX 实盘行情，虚拟账户，不会向 OKX 下单）'
      : '';
  say(`版本：${version ?? '未知（不是 git 仓库或没有安装 git）'}${flags.mock ? '，模拟交易所模式（--mock）' : ''}${mode}${flags.dev ? '，开发模式（--dev）' : ''}`);
  if (flags.campaign) say(`滚仓使用自己的端口（后端 ${ports.api}，纸面交易所 ${ports.paper}，页面 ${ports.web}）、日志目录 logs/campaign 和交易日志 data/journal.campaign.json，可以和 pnpm start --paper 同时运行`);

  const busy = [];
  if (mockPort !== null && (await portOpen(mockPort))) busy.push(mockPort);
  if (paperPort !== null && (await portOpen(paperPort))) busy.push(paperPort);
  if (await portOpen(apiPort)) busy.push(apiPort);
  if (busy.length > 0) throw new Error(`端口 ${busy.join('、')} 已被占用，Pegasus 可能已经在运行；请先关掉之前的窗口再启动`);

  // Built before anything is started: a failed build leaves nothing running, and the page and the API come from the same files.
  if (!flags.dev) {
    say('正在构建前端页面');
    const code = await runToEnd('前端构建', 'apps/web', ['node_modules/vite/bin/vite.js', 'build', '--outDir', webOutDir(flags)]);
    if (code !== 0) throw new Error(`前端页面构建失败（退出码 ${code}），Pegasus 没有启动。具体错误见上面的输出`);
    if (stopping) return;
  }

  if (mockPort !== null) {
    say(`正在启动模拟交易所（端口 ${mockPort}）`);
    start('模拟交易所', 'packages/mock-okx', ['--import', 'tsx', 'src/cli.ts'], { env: { MOCK_OKX_PORT: String(mockPort) } });
    await waitFor('模拟交易所', () => portOpen(mockPort), 30_000);
    if (stopping) return;
  }

  if (paperPort !== null) {
    say(`正在启动纸面交易所（端口 ${paperPort}）；它先补算上次关闭以来的行情，隔得久会多等一会儿`);
    // The same .env as the API: INSTRUMENTS, the campaign's settings and the PAPER_* settings come from it; --campaign
    // gives it the pot's own account (paperExchangeEnv).
    start('纸面交易所', 'packages/paper', ['--env-file-if-exists=../../.env', '--import', 'tsx', 'src/cli.ts'], { env: paperExchangeEnv(flags, overrides, paperPort) });
    await waitFor('纸面交易所', () => portOpen(paperPort), 300_000);
    if (stopping) return;
  }

  say(`正在启动后端（端口 ${apiPort}）`);
  start('后端', 'apps/api', ['--env-file-if-exists=../../.env', '--import', 'tsx', 'src/index.ts'], { env: version === null ? overrides : { ...overrides, PEGASUS_VERSION: version } });
  await waitFor('后端', () => apiHealthy(apiPort), 60_000);
  if (stopping) return;

  say('正在启动前端');
  startWeb(flags.dev, ports, webOutDir(flags));
  await waitFor('前端', () => webUrl !== null, 60_000);
  if (stopping) return;

  say(`Pegasus 已启动：${webUrl}`);
  say('关闭这个窗口（或按 Ctrl+C）会停止全部服务');
  if (flags.open) openBrowser(webUrl);
}

process.on('SIGINT', () => stop(0, true));
process.on('SIGTERM', () => stop(0));

main().catch((err) => {
  say(err.message);
  stop(1);
});
