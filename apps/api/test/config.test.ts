import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { CAMPAIGN_INSTRUMENTS } from '@pegasus/shared';
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

describe('loadConfig campaign', () => {
  const PAPER = { PAPER_EXCHANGE_URL: 'http://127.0.0.1:9200' };
  const root = resolve(dirname(fileURLToPath(import.meta.url)), '../../..');

  it('keeps its ledger in its own file, under the repository root unless the path is absolute', () => {
    expect(loadConfig({ ...PAPER, CAMPAIGN_ENABLED: '1', CAMPAIGN_STATE_FILE: 'data/campaign-paper2.json' }).campaign.stateFile).toBe(join(root, 'data', 'campaign-paper2.json'));
    const abs = resolve(root, '..', 'ledger.json');
    expect(loadConfig({ CAMPAIGN_STATE_FILE: abs }).campaign.stateFile).toBe(abs);
  });

  it('is off by default, with the ten USDT swaps, the pot of the rule and the pyramid structure', () => {
    const config = loadConfig({});
    expect(config.campaign).toEqual({
      enabled: false,
      instruments: ['BTC-USDT-SWAP', 'ETH-USDT-SWAP', 'LTC-USDT-SWAP', 'XRP-USDT-SWAP', 'BCH-USDT-SWAP', 'ETC-USDT-SWAP', 'LINK-USDT-SWAP', 'ADA-USDT-SWAP', 'DOT-USDT-SWAP', 'TRX-USDT-SWAP'],
      potStart: '56',
      minStake: '5.6',
      structure: 'pyramid',
      leverage: '10',
      feeRate: '0.0005',
      stateFile: join(root, 'data', 'campaign-ledger.json'),
      // the replay beside the pot keeps what it reads from OKX under data/, which git ignores
      replayCacheDir: join(root, 'data', 'campaign-replay'),
    });
    // its instruments are tracked whether it is on or not: the signals page shows the campaign rule on them
    expect(config.instruments).toEqual([...new Set(['BTC-USDT-SWAP', 'ETH-USDT-SWAP', ...CAMPAIGN_INSTRUMENTS])]);
  });

  it('refuses to start enabled anywhere but on the paper exchange: this stage is paper only', () => {
    const live = { OKX_API_KEY: 'k', OKX_API_SECRET: 's', OKX_API_PASSPHRASE: 'p', OKX_DEMO: '0' };
    const mock = { OKX_REST_URL: 'http://127.0.0.1:9100', OKX_WS_PUBLIC_URL: 'ws://127.0.0.1:9100/ws/v5/public', OKX_WS_PRIVATE_URL: 'ws://127.0.0.1:9100/ws/v5/private', OKX_WS_BUSINESS_URL: 'ws://127.0.0.1:9100/ws/v5/business' };
    for (const env of [{}, live, { ...live, OKX_DEMO: '1' }, { ...live, ...mock }]) {
      expect(() => loadConfig({ ...env, CAMPAIGN_ENABLED: '1' })).toThrow(/^invalid configuration: CAMPAIGN_ENABLED=1 is refused: this stage of the campaign is paper only.*pnpm start --paper.*CAMPAIGN_ENABLED=0/);
    }
    expect(loadConfig({ ...live, CAMPAIGN_ENABLED: '0' }).campaign.enabled).toBe(false);
  });

  it('on the paper exchange it is enabled, signs with the placeholder key only, and its instruments are tracked after the terminal own', () => {
    const config = loadConfig({ ...PAPER, OKX_API_KEY: 'live-key', OKX_API_SECRET: 'live-secret', OKX_API_PASSPHRASE: 'live-pass', CAMPAIGN_ENABLED: '1', INSTRUMENTS: 'SOL-USDT-SWAP,BTC-USDT-SWAP', CAMPAIGN_INSTRUMENTS: 'btc-usdt-swap, eth-usdt-swap,,ETH-USDT-SWAP', CAMPAIGN_POT_START: '100', CAMPAIGN_MIN_STAKE: '10', CAMPAIGN_STRUCTURE: 'noadd' });
    expect(config.okx).toMatchObject({ paper: true, credentials: { apiKey: 'paper', apiSecret: 'paper', passphrase: 'paper' } });
    expect(config.campaign).toMatchObject({ enabled: true, instruments: ['BTC-USDT-SWAP', 'ETH-USDT-SWAP'], potStart: '100', minStake: '10', structure: 'noadd' });
    expect(config.instruments).toEqual(['SOL-USDT-SWAP', 'BTC-USDT-SWAP', 'ETH-USDT-SWAP']);
    // the signals stay the terminal's own: INSTRUMENTS as configured, without the campaign's
    expect(config.signalInstruments).toEqual(['SOL-USDT-SWAP', 'BTC-USDT-SWAP']);
  });

  it('runs on the ten swaps of the campaign list by default, and signals INSTRUMENTS alone whether it is enabled or not', () => {
    const on = loadConfig({ ...PAPER, CAMPAIGN_ENABLED: '1', INSTRUMENTS: 'BTC-USDT-SWAP' });
    expect(on.campaign.instruments).toEqual([...CAMPAIGN_INSTRUMENTS]);
    expect(on.instruments).toEqual([...CAMPAIGN_INSTRUMENTS]);
    expect(on.signalInstruments).toEqual(['BTC-USDT-SWAP']);
    const off = loadConfig({ ...PAPER, INSTRUMENTS: 'ETH-USDT-SWAP,SOL-USDT-SWAP' });
    expect(off.instruments).toEqual([...new Set(['ETH-USDT-SWAP', 'SOL-USDT-SWAP', ...CAMPAIGN_INSTRUMENTS])]);
    expect(off.signalInstruments).toEqual(['ETH-USDT-SWAP', 'SOL-USDT-SWAP']);
  });

  it('refuses settings that would break it silently', () => {
    expect(() => loadConfig({ ...PAPER, CAMPAIGN_ENABLED: '1', CAMPAIGN_STRUCTURE: 'martingale' })).toThrow(/CAMPAIGN_STRUCTURE/);
    expect(() => loadConfig({ CAMPAIGN_ENABLED: 'yes' })).toThrow(/CAMPAIGN_ENABLED/);
    expect(() => loadConfig({ ...PAPER, CAMPAIGN_ENABLED: '1', CAMPAIGN_POT_START: '0' })).toThrow(/CAMPAIGN_POT_START: must be a positive decimal/);
    expect(() => loadConfig({ ...PAPER, CAMPAIGN_ENABLED: '1', CAMPAIGN_MIN_STAKE: '60' })).toThrow(/CAMPAIGN_MIN_STAKE 60 is more than CAMPAIGN_POT_START 56: the pot could never open a campaign/);
    expect(() => loadConfig({ ...PAPER, CAMPAIGN_ENABLED: '1', CAMPAIGN_INSTRUMENTS: 'BTC-USDT-SWAP,BTC-USD-SWAP' })).toThrow(/CAMPAIGN_INSTRUMENTS must list USDT swaps.*BTC-USD-SWAP/);
    expect(() => loadConfig({ ...PAPER, CAMPAIGN_ENABLED: '1', CAMPAIGN_INSTRUMENTS: ' , ' })).toThrow(/CAMPAIGN_INSTRUMENTS must list at least one instrument/);
    // while it is off its own settings are only parsed
    expect(loadConfig({ CAMPAIGN_MIN_STAKE: '60', CAMPAIGN_INSTRUMENTS: 'BTC-USD-SWAP' }).campaign.enabled).toBe(false);
  });
});
