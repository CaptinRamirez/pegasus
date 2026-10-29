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
// --paper --campaign starts both stacks from this one window (start-all.bat): the paper stack first, then the
// campaign's, with every line of a service's output tagged [纸面] or [滚仓].
// Every minute each stack is checked (watchStack): its API must answer /api/health and the trader's state file must be
// fresh; a failing check, like a service that exits, is reported in the console and, on Windows, in a dialog.
import { exec, execFileSync, spawn } from 'node:child_process';
import { existsSync, readFileSync, statSync } from 'node:fs';
import { connect } from 'node:net';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseEnv } from 'node:util';
import { campaignEnv, mockEnv, paperEnv, paperExchangeEnv, parseFlags, potStartOf, stackPorts, traderBalanceOf, traderEnv, webEnv, webOutDir } from './launch-options.mjs';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const envFile = join(root, '.env');
// The page's server settings with the ports of the stack (its proxy to the API of the same stack), relative to apps/web.
const STACK_CONFIG = '../../scripts/vite.stack.config.mjs';

const children = new Map();
let stopping = false;
let exitCode = 0;

const say = (msg) => console.log(`[pegasus] ${msg}`);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
/** A service's name with its stack's tag in front when both stacks run in this window. */
const labelled = (tag, name) => (tag ? `${tag}·${name}` : name);

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

/**
 * Runs one service with this Node binary; the commands mirror the packages' own start/dev scripts. With `opts.tag`
 * (both stacks in one window) its output passes through here with the tag in front of every line; `opts.onStdout`
 * also sees what it prints.
 */
function start(name, dir, args, opts = {}) {
  const tag = opts.tag ?? '';
  const piped = tag !== '' || opts.onStdout !== undefined;
  const child = spawn(process.execPath, args, { cwd: join(root, dir), env: { ...process.env, ...opts.env }, stdio: ['ignore', piped ? 'pipe' : 'inherit', tag ? 'pipe' : 'inherit'] });
  // shortcut: a chunk is tagged line by line, so a line split across two chunks continues untagged; pino and vite write whole lines
  const tagged = (text) => (tag ? text.replace(/^(?=.)/gm, `[${tag}] `) : text);
  child.stdout?.setEncoding('utf8');
  child.stdout?.on('data', (text) => {
    process.stdout.write(tagged(text));
    opts.onStdout?.(text);
  });
  child.stderr?.setEncoding('utf8');
  child.stderr?.on('data', (text) => process.stderr.write(tagged(text)));
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
    alert(`${name}意外退出（${signal ?? `退出码 ${code}`}），其余服务随之停止：请看窗口里的日志，然后重新启动`);
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
 * settles on can be read (`onUrl`); that also keeps it from clearing the other services' logs.
 */
function startWeb(tag, dev, ports, outDir, onUrl) {
  const args = dev ? ['--config', STACK_CONFIG, '--port', String(ports.web), '--strictPort'] : ['preview', '--config', STACK_CONFIG, '--port', String(ports.web), '--strictPort', '--outDir', outDir];
  let seen = '';
  let found = false;
  const onStdout = (text) => {
    if (found) return;
    seen += text;
    const url = /Local:\s+(\S+)/.exec(seen.replace(/\x1b\[[0-9;]*m/g, ''))?.[1];
    if (url !== undefined) {
      found = true;
      onUrl(url);
    }
  };
  start(labelled(tag, '前端'), 'apps/web', ['node_modules/vite/bin/vite.js', ...args], { tag, env: webEnv(ports), onStdout });
}

function openBrowser(url) {
  const cmd = process.platform === 'win32' ? `start "" "${url}"` : process.platform === 'darwin' ? `open "${url}"` : `xdg-open "${url}"`;
  exec(cmd, () => {}); // best effort: a missing opener must not take the stack down
}

/** Tells the user something is wrong: the console with the bell and, on Windows, a dialog on top of every window that stays until it is closed. */
function alert(text) {
  say(`\x07${text}`);
  if (process.platform !== 'win32') return;
  const script = `Add-Type -AssemblyName System.Windows.Forms; [System.Windows.Forms.MessageBox]::Show('${text.replace(/'/g, "''")}', 'Pegasus', 'OK', 'Warning', 'Button1', 'ServiceNotification') | Out-Null`;
  spawn('powershell', ['-NoProfile', '-NonInteractive', '-WindowStyle', 'Hidden', '-Command', script], { detached: true, stdio: 'ignore' }).on('error', () => {}).unref();
}

/**
 * The dead-man check of a stack, asked for after the 2026-10-28 audit: every minute its API must answer /api/health
 * and, with the trader, its state file (rewritten at every 15-minute close) must be newer than 25 minutes, a close
 * plus the model's two 3-minute attempts, counted from the stack's start when the file is older (a restart after an
 * outage). The user is told at the third failure in a row and once more at the recovery.
 */
function watchStack(tag, apiPort, traderStateFile) {
  const name = tag ? `${tag}栈` : 'Pegasus';
  const startedAt = Date.now();
  const misses = new Map();
  const check = (what, ok, text) => {
    const before = misses.get(what) ?? 0;
    misses.set(what, ok ? 0 : before + 1);
    if (ok && before >= 3) say(`${name}：${what}恢复了`);
    else if (!ok && before === 2) alert(text());
  };
  setInterval(async () => {
    if (stopping) return;
    check('后端', await apiHealthy(apiPort), () => `${name}的后端连续 3 分钟没有回应 /api/health（端口 ${apiPort}）：请看窗口里的日志，必要时重新启动`);
    if (traderStateFile === null) return;
    let stat;
    try {
      stat = statSync(traderStateFile, { throwIfNoEntry: false });
    } catch {
      stat = undefined; // a file being replaced or held: one miss
    }
    const age = Date.now() - Math.max(stat?.mtimeMs ?? 0, startedAt);
    check('交易员', age < 25 * 60_000, () => `交易员的状态文件${stat ? `已经 ${Math.round(age / 60_000)} 分钟没有更新` : '不存在'}（它每 15 分钟写一次）：交易员可能卡住了，请看窗口里的日志，必要时重新启动`);
  }, 60_000).unref();
}

async function main() {
  const flags = parseFlags(process.argv.slice(2));
  for (const dir of ['apps/api', 'apps/web', 'packages/mock-okx', 'packages/paper']) {
    if (!existsSync(join(root, dir, 'node_modules'))) throw new Error('依赖还没有安装，请先在项目目录运行：pnpm install');
  }
  if (!existsSync(envFile)) say('没有找到 .env，后端将使用默认配置（可以把 .env.example 复制为 .env 再修改）');

  // Same precedence as node --env-file: a variable already set in the environment wins over the file.
  const base = { ...(existsSync(envFile) ? parseEnv(readFileSync(envFile, 'utf8')) : {}), ...process.env };
  const version = gitVersion();
  if (!flags.both) return runStack(flags, base, version, '');
  const names = [flags.explicitPaper ? '纸面' : null, flags.campaign ? '滚仓' : null, flags.trader ? '交易员' : null].filter((n) => n !== null);
  say(names.length === 2 ? `两套栈在这一个窗口里依次启动：先${names[0]}栈，再${names[1]}栈；每行前面的 [${names[0]}] 或 [${names[1]}] 说明那一行属于哪套` : `三套栈在这一个窗口里依次启动：${names.join('、')}；每行前面的 [${names.join('] / [')}] 说明那一行属于哪套`);
  if (flags.explicitPaper) await runStack({ ...flags, campaign: false, trader: false }, base, version, '纸面');
  if (!stopping && flags.campaign) await runStack({ ...flags, trader: false }, base, version, '滚仓');
  if (!stopping && flags.trader) await runStack({ ...flags, campaign: false }, base, version, '交易员');
}

/** Builds and starts one stack (the exchange it trades on, the API, the page) and opens its page; `tag` names it when both run. */
async function runStack(flags, base, version, tag) {
  const log = tag ? (msg) => say(`${tag}：${msg}`) : say;
  let webUrl = null;
  // Paper trading is chosen on the command line or, for double-clicking start.bat, by PAPER_TRADING=1 in .env.
  const paper = flags.paper || (!flags.mock && base.PAPER_TRADING === '1');
  // --campaign has ports of its own (CAMPAIGN_*_PORT move them); the others take API_PORT and PAPER_PORT from .env.
  const ports = stackPorts(flags, base);
  const paperPort = paper ? ports.paper : null;
  // --mock, --paper and --campaign only change what the children see; .env is read here, never written.
  const overrides = flags.mock ? mockEnv(Number(process.env.MOCK_OKX_PORT ?? 9100)) : flags.campaign ? campaignEnv(ports.paper, potStartOf(base), ports) : flags.trader ? traderEnv(ports.paper, traderBalanceOf(base), ports) : paper ? paperEnv(paperPort) : {};
  const env = { ...base, ...overrides };
  const apiPort = ports.api;
  const mockPort = localPort(env.OKX_REST_URL);
  if (paper && mockPort !== null) throw new Error('纸面交易需要 OKX 的真实行情，但 .env 里的 OKX_REST_URL 指向了本机的模拟交易所；请删掉 .env 里的四个 OKX_*_URL 再启动');
  const mode = flags.campaign
    ? '，滚仓模式（纸面交易：OKX 实盘行情，资金池专用的虚拟账户 data/paper-campaign.json，账本 data/campaign-ledger.json，不会向 OKX 下单）'
    : flags.trader
      ? '，交易员模式（纸面交易：OKX 实盘行情，交易员专用的虚拟账户 data/paper-trader.json，决定日志 data/trader-log.jsonl，不会向 OKX 下单；模型密钥 ANTHROPIC_API_KEY 来自 .env）'
      : paper
        ? '，纸面交易模式（OKX 实盘行情，虚拟账户，不会向 OKX 下单）'
        : '';
  log(`版本：${version ?? '未知（不是 git 仓库或没有安装 git）'}${flags.mock ? '，模拟交易所模式（--mock）' : ''}${mode}${flags.dev ? '，开发模式（--dev）' : ''}`);
  if (flags.campaign) log(`滚仓使用自己的端口（后端 ${ports.api}，纸面交易所 ${ports.paper}，页面 ${ports.web}）、日志目录 logs/campaign 和交易日志 data/journal.campaign.json，可以和 pnpm start --paper 同时运行`);
  if (flags.trader) log(`交易员使用自己的端口（后端 ${ports.api}，纸面交易所 ${ports.paper}，页面 ${ports.web}）、日志目录 logs/trader 和交易日志 data/journal.trader.json，可以和另外两套栈同时运行`);

  const busy = [];
  if (mockPort !== null && (await portOpen(mockPort))) busy.push(mockPort);
  if (paperPort !== null && (await portOpen(paperPort))) busy.push(paperPort);
  if (await portOpen(apiPort)) busy.push(apiPort);
  if (busy.length > 0) throw new Error(`端口 ${busy.join('、')} 已被占用，Pegasus 可能已经在运行；请先关掉之前的窗口再启动`);

  // Built before anything is started: a failed build leaves nothing running, and the page and the API come from the same files.
  if (!flags.dev) {
    log('正在构建前端页面');
    const code = await runToEnd(labelled(tag, '前端构建'), 'apps/web', ['node_modules/vite/bin/vite.js', 'build', '--outDir', webOutDir(flags)]);
    if (code !== 0) throw new Error(`前端页面构建失败（退出码 ${code}），Pegasus 没有启动。具体错误见上面的输出`);
    if (stopping) return;
  }

  if (mockPort !== null) {
    log(`正在启动模拟交易所（端口 ${mockPort}）`);
    start(labelled(tag, '模拟交易所'), 'packages/mock-okx', ['--import', 'tsx', 'src/cli.ts'], { tag, env: { MOCK_OKX_PORT: String(mockPort) } });
    await waitFor(labelled(tag, '模拟交易所'), () => portOpen(mockPort), 30_000);
    if (stopping) return;
  }

  if (paperPort !== null) {
    log(`正在启动纸面交易所（端口 ${paperPort}）；它先补算上次关闭以来的行情，隔得久会多等一会儿`);
    // The same .env as the API: INSTRUMENTS, the campaign's settings and the PAPER_* settings come from it; --campaign
    // gives it the pot's own account (paperExchangeEnv).
    start(labelled(tag, '纸面交易所'), 'packages/paper', ['--env-file-if-exists=../../.env', '--import', 'tsx', 'src/cli.ts'], { tag, env: paperExchangeEnv(flags, overrides, paperPort) });
    await waitFor(labelled(tag, '纸面交易所'), () => portOpen(paperPort), 300_000);
    if (stopping) return;
  }

  log(`正在启动后端（端口 ${apiPort}）`);
  start(labelled(tag, '后端'), 'apps/api', ['--env-file-if-exists=../../.env', '--import', 'tsx', 'src/index.ts'], { tag, env: version === null ? overrides : { ...overrides, PEGASUS_VERSION: version } });
  await waitFor(labelled(tag, '后端'), () => apiHealthy(apiPort), 60_000);
  if (stopping) return;

  log('正在启动前端');
  startWeb(tag, flags.dev, ports, webOutDir(flags), (url) => {
    webUrl = url;
  });
  await waitFor(labelled(tag, '前端'), () => webUrl !== null, 60_000);
  if (stopping) return;

  log(`Pegasus 已启动：${webUrl}`);
  say('关闭这个窗口（或按 Ctrl+C）会停止全部服务');
  if (flags.open) openBrowser(webUrl);
  watchStack(tag, apiPort, flags.trader ? join(root, env.TRADER_STATE_FILE) : null);
}

process.on('SIGINT', () => stop(0, true));
process.on('SIGTERM', () => stop(0));

main().catch((err) => {
  say(err.message);
  stop(1);
});
