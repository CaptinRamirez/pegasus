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
import { loadConfig } from '../src/config.js';

const scripts = resolve(dirname(fileURLToPath(import.meta.url)), '../../../scripts');

interface LaunchOptions {
  parseFlags(argv: string[]): { mock: boolean; dev: boolean; open: boolean };
  mockEnv(port?: number): Record<string, string>;
}
const options = (await import(pathToFileURL(join(scripts, 'launch-options.mjs')).href)) as LaunchOptions;

describe('launcher options', () => {
  it('understands --mock, --dev and --no-open and refuses anything else', () => {
    expect(options.parseFlags([])).toEqual({ mock: false, dev: false, open: true });
    expect(options.parseFlags(['--mock', '--no-open'])).toEqual({ mock: true, dev: false, open: false });
    expect(options.parseFlags(['--dev'])).toEqual({ mock: false, dev: true, open: true });
    expect(() => options.parseFlags(['--mcok'])).toThrow('--mcok');
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
    expect(config.databaseUrl).toBeFalsy();
    expect(options.mockEnv(9200).OKX_WS_PRIVATE_URL).toBe('ws://127.0.0.1:9200/ws/v5/private');
  });
});

describe('launcher in a stub tree', () => {
  let root: string;
  let freePort: number;

  beforeEach(async () => {
    root = mkdtempSync(join(tmpdir(), 'pegasus-launcher-'));
    mkdirSync(join(root, 'scripts'));
    for (const name of ['start.mjs', 'launch-options.mjs']) copyFileSync(join(scripts, name), join(root, 'scripts', name));
    for (const dir of ['apps/api/node_modules', 'packages/mock-okx/node_modules', 'apps/web/node_modules/vite/bin']) mkdirSync(join(root, dir), { recursive: true });
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

  const launch = (...flags: string[]) =>
    spawnSync(process.execPath, [join(root, 'scripts', 'start.mjs'), '--no-open', ...flags], {
      encoding: 'utf8',
      timeout: 30_000,
      env: { PATH: process.env['PATH'], SystemRoot: process.env['SystemRoot'], API_PORT: String(freePort), MOCK_OKX_PORT: String(freePort) },
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

  it('an unknown flag is refused before anything runs', () => {
    const run = launch('--mcok');
    expect(run.status).toBe(1);
    expect(run.stdout).toContain('不认识的参数：--mcok');
    expect(run.stdout).not.toContain('正在构建');
  });
});
