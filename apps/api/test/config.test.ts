import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { loadConfig } from '../src/config.js';

describe('loadConfig OKX credentials', () => {
  it('uses the credentials when all three are set and none when all three are empty', () => {
    expect(loadConfig({ OKX_API_KEY: 'k', OKX_API_SECRET: 's', OKX_API_PASSPHRASE: 'p' }).okx.credentials).toEqual({ apiKey: 'k', apiSecret: 's', passphrase: 'p' });
    expect(loadConfig({}).okx.credentials).toBeUndefined();
    expect(loadConfig({ OKX_API_KEY: '', OKX_API_SECRET: '', OKX_API_PASSPHRASE: '' }).okx.credentials).toBeUndefined();
  });

  it('refuses one or two of the three and names what is missing', () => {
    expect(() => loadConfig({ OKX_API_KEY: 'k', OKX_API_SECRET: 's' })).toThrow(/^invalid configuration: .*: OKX_API_PASSPHRASE is not set/);
    expect(() => loadConfig({ OKX_API_KEY: 'k', OKX_API_SECRET: 's', OKX_API_PASSPHRASE: '' })).toThrow(/: OKX_API_PASSPHRASE is not set/);
    expect(() => loadConfig({ OKX_API_PASSPHRASE: 'p' })).toThrow(/: OKX_API_KEY, OKX_API_SECRET are not set/);
  });
});

describe('loadConfig settings that would silently break something', () => {
  it('RISK_PRICE_BAND_PCT and RISK_MAX_SLIPPAGE_PCT are fractions: 1 or more is refused', () => {
    expect(loadConfig({ RISK_PRICE_BAND_PCT: '0.05', RISK_MAX_SLIPPAGE_PCT: '0.999' }).risk).toMatchObject({ priceBandPct: '0.05', maxSlippagePct: '0.999' });
    expect(() => loadConfig({ RISK_PRICE_BAND_PCT: '5' })).toThrow(/RISK_PRICE_BAND_PCT: must be a fraction below 1 \(0\.05 means 5%\)/);
    expect(() => loadConfig({ RISK_MAX_SLIPPAGE_PCT: '1' })).toThrow(/RISK_MAX_SLIPPAGE_PCT: must be a fraction below 1/);
    expect(() => loadConfig({ RISK_MAX_SLIPPAGE_PCT: '1.0' })).toThrow(/RISK_MAX_SLIPPAGE_PCT/);
  });

  it('the OKX endpoint overrides come as all four or none, and the missing ones are named', () => {
    const all = { OKX_REST_URL: 'http://127.0.0.1:9100', OKX_WS_PUBLIC_URL: 'ws://127.0.0.1:9100/ws/v5/public', OKX_WS_PRIVATE_URL: 'ws://127.0.0.1:9100/ws/v5/private', OKX_WS_BUSINESS_URL: 'ws://127.0.0.1:9100/ws/v5/business' };
    expect(loadConfig(all).okx.endpoints).toEqual({ rest: all.OKX_REST_URL, wsPublic: all.OKX_WS_PUBLIC_URL, wsPrivate: all.OKX_WS_PRIVATE_URL, wsBusiness: all.OKX_WS_BUSINESS_URL });
    expect(loadConfig({}).okx.endpoints.rest).toBe('https://www.okx.com');
    expect(() => loadConfig({ OKX_REST_URL: all.OKX_REST_URL })).toThrow(/^invalid configuration: .*OKX_WS_PUBLIC_URL, OKX_WS_PRIVATE_URL, OKX_WS_BUSINESS_URL are not set \(set all four/);
    expect(() => loadConfig({ ...all, OKX_WS_BUSINESS_URL: '' })).toThrow(/OKX_WS_BUSINESS_URL is not set/);
  });

  it('OKX_WS_TRADING=1 is refused: the WebSocket order path is not migrated to instIdCode', () => {
    expect(loadConfig({ OKX_WS_TRADING: '0' }).okx.wsTrading).toBe(false);
    expect(loadConfig({}).okx.wsTrading).toBe(false);
    expect(() => loadConfig({ OKX_WS_TRADING: '1' })).toThrow(/^invalid configuration: OKX_WS_TRADING=1 is not supported.*instIdCode.*leave OKX_WS_TRADING at 0/);
  });
});

describe('loadConfig files and version', () => {
  const root = resolve(dirname(fileURLToPath(import.meta.url)), '../../..');

  it('keeps the state file and the logs under the repository root, whatever the working directory', () => {
    const c = loadConfig({});
    expect(c.stateFile).toBe(join(root, 'data', 'pegasus-state.json'));
    expect(c.logDir).toBe(join(root, 'logs'));
  });

  it('resolves a relative STATE_FILE / LOG_DIR against the repository root and keeps an absolute one', () => {
    const abs = resolve(root, '..', 'elsewhere');
    expect(loadConfig({ STATE_FILE: 'data/mock.json', LOG_DIR: abs })).toMatchObject({ stateFile: join(root, 'data', 'mock.json'), logDir: abs });
  });

  it('takes the version from PEGASUS_VERSION (set by the launcher)', () => {
    expect(loadConfig({ PEGASUS_VERSION: 'abc1234' }).version).toBe('abc1234');
    expect(loadConfig({}).version).toBe('unknown');
  });
});

describe('loadConfig SIGNAL_PHASES', () => {
  it('defaults to both daily cuts, and takes one cut or both in any order', () => {
    expect(loadConfig({}).signalPhases).toEqual([0, 12]);
    expect(loadConfig({ SIGNAL_PHASES: '0' }).signalPhases).toEqual([0]);
    expect(loadConfig({ SIGNAL_PHASES: '12' }).signalPhases).toEqual([12]);
    expect(loadConfig({ SIGNAL_PHASES: ' 12 , 0, 12' }).signalPhases).toEqual([0, 12]);
  });

  it('refuses an empty list and an hour that is not a cut', () => {
    expect(() => loadConfig({ SIGNAL_PHASES: '' })).toThrow(/SIGNAL_PHASES must list one or more of 0, 12/);
    expect(() => loadConfig({ SIGNAL_PHASES: '0,6' })).toThrow(/SIGNAL_PHASES/);
  });
});

describe('loadConfig WEB_ORIGINS', () => {
  it('defaults to the terminal page on the Vite port, under both local names', () => {
    expect(loadConfig({}).server.webOrigins).toEqual(['http://localhost:5174', 'http://127.0.0.1:5174']);
  });

  it('is a comma separated list; spaces, empty entries and a trailing slash are dropped', () => {
    expect(loadConfig({ WEB_ORIGINS: ' http://localhost:3000/ ,, http://box.lan:5174' }).server.webOrigins).toEqual(['http://localhost:3000', 'http://box.lan:5174']);
    expect(loadConfig({ WEB_ORIGINS: '' }).server.webOrigins).toEqual([]);
  });
});

describe('loadConfig paper trading', () => {
  it('is off without PAPER_EXCHANGE_URL', () => {
    const config = loadConfig({});
    expect(config.okx.paper).toBe(false);
    expect(config.okx.endpoints.restPrivate).toBeUndefined();
  });

  it('needs no OKX key, takes the live market data whatever OKX_DEMO says, and sends the private side to the paper exchange', () => {
    const config = loadConfig({ PAPER_EXCHANGE_URL: 'http://127.0.0.1:9200/', OKX_DEMO: '1' });
    expect(config.okx).toMatchObject({
      paper: true,
      demo: false,
      credentials: { apiKey: 'paper', apiSecret: 'paper', passphrase: 'paper' },
      endpoints: { rest: 'https://www.okx.com', wsPublic: 'wss://ws.okx.com/ws/v5/public', wsBusiness: 'wss://ws.okx.com/ws/v5/business', restPrivate: 'http://127.0.0.1:9200', wsPrivate: 'ws://127.0.0.1:9200/ws/v5/private' },
    });
  });

  it('never uses a key that is configured, complete or not', () => {
    expect(loadConfig({ PAPER_EXCHANGE_URL: 'http://127.0.0.1:9200', OKX_API_KEY: 'live-key', OKX_API_SECRET: 'live-secret', OKX_API_PASSPHRASE: 'live-pass' }).okx.credentials).toEqual({ apiKey: 'paper', apiSecret: 'paper', passphrase: 'paper' });
    expect(loadConfig({ PAPER_EXCHANGE_URL: 'http://127.0.0.1:9200', OKX_API_KEY: 'only-this' }).okx.credentials?.apiKey).toBe('paper');
  });

  it('keeps market data endpoints that are overridden (a regional OKX host) and refuses a value that is not a URL', () => {
    const config = loadConfig({
      PAPER_EXCHANGE_URL: 'http://localhost:9300',
      OKX_REST_URL: 'https://eea.okx.com',
      OKX_WS_PUBLIC_URL: 'wss://wseea.okx.com/ws/v5/public',
      OKX_WS_PRIVATE_URL: 'wss://wseea.okx.com/ws/v5/private',
      OKX_WS_BUSINESS_URL: 'wss://wseea.okx.com/ws/v5/business',
    });
    expect(config.okx.endpoints).toEqual({ rest: 'https://eea.okx.com', wsPublic: 'wss://wseea.okx.com/ws/v5/public', wsBusiness: 'wss://wseea.okx.com/ws/v5/business', restPrivate: 'http://localhost:9300', wsPrivate: 'ws://localhost:9300/ws/v5/private' });
    expect(() => loadConfig({ PAPER_EXCHANGE_URL: 'paper' })).toThrow(/PAPER_EXCHANGE_URL: must be a URL/);
  });
});
