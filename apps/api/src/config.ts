import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { z } from 'zod';
import { defaultEndpoints, type OkxCredentials, type OkxEndpoints } from '@pegasus/okx';
import { D, type RiskConfig, type TdMode } from '@pegasus/shared';

/** The repository root, from where this module lives: the launcher, `pnpm dev:api` and tests run with different working directories. */
const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../../..');

const decimal = z.string().regex(/^\d+(\.\d+)?$/, 'must be a non-negative decimal');
// A percentage typed where a fraction is meant (5 for 5%) would switch the check off.
const fraction = decimal.refine((s) => D(s).lt(1), 'must be a fraction below 1 (0.05 means 5%)');
const endpoint = z.string().refine((s) => s === '' || URL.canParse(s), 'must be a URL').default('');

const ENDPOINT_OVERRIDES = ['OKX_REST_URL', 'OKX_WS_PUBLIC_URL', 'OKX_WS_PRIVATE_URL', 'OKX_WS_BUSINESS_URL'] as const;

const envSchema = z.object({
  OKX_API_KEY: z.string().default(''),
  OKX_API_SECRET: z.string().default(''),
  OKX_API_PASSPHRASE: z.string().default(''),
  OKX_DEMO: z.enum(['0', '1']).default('1'),
  OKX_REST_URL: endpoint,
  OKX_WS_PUBLIC_URL: endpoint,
  OKX_WS_PRIVATE_URL: endpoint,
  OKX_WS_BUSINESS_URL: endpoint,
  /** Must stay '0' (REST): '1' used to send order operations over the private WebSocket, see loadConfig. */
  OKX_WS_TRADING: z.enum(['0', '1']).default('0'),

  API_HOST: z.string().default('127.0.0.1'),
  API_PORT: z.coerce.number().int().min(1).max(65535).default(8787),
  API_TOKEN: z.string().min(1).default('change-me'),
  /** Web origins (comma separated) whose pages may call the API; the Vite dev server by default. */
  WEB_ORIGINS: z.string().default('http://localhost:5174,http://127.0.0.1:5174'),
  INSTRUMENTS: z.string().default('BTC-USDT-SWAP,ETH-USDT-SWAP'),
  DEFAULT_TD_MODE: z.enum(['cross', 'isolated']).default('cross'),
  LOG_LEVEL: z.enum(['trace', 'debug', 'info', 'warn', 'error', 'fatal']).default('info'),
  DATABASE_URL: z.string().optional(),
  /** Where the kill switch and the day baseline are kept without a database; relative paths are under the repository root. */
  STATE_FILE: z.string().min(1).default('data/pegasus-state.json'),
  /** Directory of the dated log files; relative paths are under the repository root. */
  LOG_DIR: z.string().min(1).default('logs'),
  /** The commit the stack was started from; set by the launcher. */
  PEGASUS_VERSION: z.string().min(1).default('unknown'),

  RISK_MAX_ORDER_NOTIONAL: decimal.default('5000'),
  RISK_MAX_POSITION_NOTIONAL_PER_INSTRUMENT: decimal.default('20000'),
  RISK_MAX_TOTAL_POSITION_NOTIONAL: decimal.default('50000'),
  RISK_MAX_LEVERAGE: decimal.default('10'),
  RISK_DAILY_LOSS_LIMIT: decimal.default('1000'),
  RISK_MAX_OPEN_ORDERS: z.coerce.number().int().min(1).default(20),
  RISK_PRICE_BAND_PCT: fraction.default('0.05'),
  RISK_MAX_SLIPPAGE_PCT: fraction.default('0.005'),
});

export interface AppConfig {
  okx: {
    credentials: OkxCredentials | undefined;
    demo: boolean;
    endpoints: OkxEndpoints;
    /** Submit and cancel orders over the private WebSocket instead of REST. Always false for now: OKX_WS_TRADING=1 is refused at start-up. */
    wsTrading: boolean;
  };
  server: {
    host: string;
    port: number;
    token: string;
    /** A request that carries an Origin header must carry one of these, exactly. */
    webOrigins: string[];
    logLevel: z.infer<typeof envSchema>['LOG_LEVEL'];
  };
  instruments: string[];
  defaultTdMode: TdMode;
  databaseUrl: string | undefined;
  /** Absolute path of the file the memory store keeps its settings in. */
  stateFile: string;
  /** Absolute path of the directory the dated log files go to. */
  logDir: string;
  /** Short commit hash the stack was started from, or 'unknown'. */
  version: string;
  risk: RiskConfig;
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): AppConfig {
  const parsed = envSchema.safeParse(env);
  if (!parsed.success) {
    const issues = parsed.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('; ');
    throw new Error(`invalid configuration: ${issues}`);
  }
  const e = parsed.data;
  const demo = e.OKX_DEMO === '1';
  const defaults = defaultEndpoints(demo);
  // All three or none: a partial set would otherwise start silently without the account.
  const missing = (['OKX_API_KEY', 'OKX_API_SECRET', 'OKX_API_PASSPHRASE'] as const).filter((name) => e[name] === '');
  if (missing.length === 1 || missing.length === 2) {
    throw new Error(`invalid configuration: OKX credentials are incomplete: ${missing.join(', ')} ${missing.length === 1 ? 'is' : 'are'} not set (set all three, or leave all three empty for market data only)`);
  }
  const hasCreds = missing.length === 0;
  // All four or none: with a subset the API would talk to the mock on some sockets and to the real OKX on the others.
  const unset = ENDPOINT_OVERRIDES.filter((name) => e[name] === '');
  if (unset.length > 0 && unset.length < ENDPOINT_OVERRIDES.length) {
    throw new Error(`invalid configuration: the OKX endpoint overrides are incomplete: ${unset.join(', ')} ${unset.length === 1 ? 'is' : 'are'} not set (set all four, or none to use the OKX hosts)`);
  }
  const overridden = unset.length === 0;
  // OKX deprecated the instId parameter of the WebSocket order operations (changelog 2026-04-07, "Deprecate instId
  // Request Parameter in WS Order Operation Channels"). That path still sends instId and cannot be verified without
  // a trading key, so it is refused rather than left to fail on the first order.
  if (e.OKX_WS_TRADING === '1') {
    throw new Error('invalid configuration: OKX_WS_TRADING=1 is not supported: OKX deprecated the instId parameter of its WebSocket order operations and Pegasus has not been migrated to instIdCode; leave OKX_WS_TRADING at 0 (orders go over REST)');
  }
  const instruments = [...new Set(e.INSTRUMENTS.split(',').map((s) => s.trim().toUpperCase()).filter((s) => s.length > 0))];
  if (instruments.length === 0) throw new Error('INSTRUMENTS must list at least one instrument');
  // An Origin header never ends in a slash; one typed into .env is dropped rather than left to never match.
  const webOrigins = e.WEB_ORIGINS.split(',').map((s) => s.trim().replace(/\/$/, '')).filter((s) => s.length > 0);
  return {
    okx: {
      credentials: hasCreds ? { apiKey: e.OKX_API_KEY, apiSecret: e.OKX_API_SECRET, passphrase: e.OKX_API_PASSPHRASE } : undefined,
      demo,
      wsTrading: false,
      endpoints: overridden ? { rest: e.OKX_REST_URL, wsPublic: e.OKX_WS_PUBLIC_URL, wsPrivate: e.OKX_WS_PRIVATE_URL, wsBusiness: e.OKX_WS_BUSINESS_URL } : defaults,
    },
    server: { host: e.API_HOST, port: e.API_PORT, token: e.API_TOKEN, webOrigins, logLevel: e.LOG_LEVEL },
    instruments,
    defaultTdMode: e.DEFAULT_TD_MODE,
    databaseUrl: e.DATABASE_URL,
    stateFile: resolve(REPO_ROOT, e.STATE_FILE),
    logDir: resolve(REPO_ROOT, e.LOG_DIR),
    version: e.PEGASUS_VERSION,
    risk: {
      maxOrderNotional: e.RISK_MAX_ORDER_NOTIONAL,
      maxPositionNotionalPerInstrument: e.RISK_MAX_POSITION_NOTIONAL_PER_INSTRUMENT,
      maxTotalPositionNotional: e.RISK_MAX_TOTAL_POSITION_NOTIONAL,
      maxLeverage: e.RISK_MAX_LEVERAGE,
      dailyLossLimit: e.RISK_DAILY_LOSS_LIMIT,
      maxOpenOrders: e.RISK_MAX_OPEN_ORDERS,
      priceBandPct: e.RISK_PRICE_BAND_PCT,
      maxSlippagePct: e.RISK_MAX_SLIPPAGE_PCT,
    },
  };
}
