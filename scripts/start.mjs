// One-command launcher behind `pnpm start` and start.bat: builds the web terminal, then starts the mock exchange
// (with --mock, or when .env points the API at it), the API and the built terminal in order and opens the browser.
// The page is built once and served as it was built, so a `git pull` while the stack runs changes neither half.
// Flags: --mock (local mock exchange instead of OKX), --dev (Vite dev server with hot reload), --no-open.
import { exec, execFileSync, spawn } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { connect } from 'node:net';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseEnv } from 'node:util';
import { mockEnv, parseFlags } from './launch-options.mjs';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const envFile = join(root, '.env');
// The dev server's port in apps/web/vite.config.ts; the API's WEB_ORIGINS default names it.
const WEB_PORT = 5174;

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
 * Serves the built page with `vite preview`, or runs the dev server with --dev. Preview takes its proxy (/api, /ws)
 * and strictPort from the dev server's settings in vite.config.ts, but not its port. Either way Vite's output is
 * piped so the URL it settles on can be read; that also keeps it from clearing the other services' logs.
 */
function startWeb(dev) {
  const args = dev ? [] : ['preview', '--port', String(WEB_PORT), '--strictPort'];
  const child = start('前端', 'apps/web', ['node_modules/vite/bin/vite.js', ...args], { stdio: ['ignore', 'pipe', 'inherit'] });
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
  for (const dir of ['apps/api', 'apps/web', 'packages/mock-okx']) {
    if (!existsSync(join(root, dir, 'node_modules'))) throw new Error('依赖还没有安装，请先在项目目录运行：pnpm install');
  }
  if (!existsSync(envFile)) say('没有找到 .env，后端将使用默认配置（可以把 .env.example 复制为 .env 再修改）');

  // --mock only changes what the children see; .env is read here, never written.
  const overrides = flags.mock ? mockEnv(Number(process.env.MOCK_OKX_PORT ?? 9100)) : {};
  // Same precedence as node --env-file: a variable already set in the environment wins over the file.
  const env = { ...(existsSync(envFile) ? parseEnv(readFileSync(envFile, 'utf8')) : {}), ...process.env, ...overrides };
  const apiPort = Number(env.API_PORT ?? 8787);
  const mockPort = localPort(env.OKX_REST_URL);
  const version = gitVersion();
  say(`版本：${version ?? '未知（不是 git 仓库或没有安装 git）'}${flags.mock ? '，模拟交易所模式（--mock）' : ''}${flags.dev ? '，开发模式（--dev）' : ''}`);

  const busy = [];
  if (mockPort !== null && (await portOpen(mockPort))) busy.push(mockPort);
  if (await portOpen(apiPort)) busy.push(apiPort);
  if (busy.length > 0) throw new Error(`端口 ${busy.join('、')} 已被占用，Pegasus 可能已经在运行；请先关掉之前的窗口再启动`);

  // Built before anything is started: a failed build leaves nothing running, and the page and the API come from the same files.
  if (!flags.dev) {
    say('正在构建前端页面');
    const code = await runToEnd('前端构建', 'apps/web', ['node_modules/vite/bin/vite.js', 'build']);
    if (code !== 0) throw new Error(`前端页面构建失败（退出码 ${code}），Pegasus 没有启动。具体错误见上面的输出`);
    if (stopping) return;
  }

  if (mockPort !== null) {
    say(`正在启动模拟交易所（端口 ${mockPort}）`);
    start('模拟交易所', 'packages/mock-okx', ['--import', 'tsx', 'src/cli.ts'], { env: { MOCK_OKX_PORT: String(mockPort) } });
    await waitFor('模拟交易所', () => portOpen(mockPort), 30_000);
    if (stopping) return;
  }

  say(`正在启动后端（端口 ${apiPort}）`);
  start('后端', 'apps/api', ['--env-file-if-exists=../../.env', '--import', 'tsx', 'src/index.ts'], { env: version === null ? overrides : { ...overrides, PEGASUS_VERSION: version } });
  await waitFor('后端', () => apiHealthy(apiPort), 60_000);
  if (stopping) return;

  say('正在启动前端');
  startWeb(flags.dev);
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
