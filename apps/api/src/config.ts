import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { z } from 'zod';
import { defaultEndpoints, type OkxCredentials, type OkxEndpoints } from '@pegasus/okx';
import { CAMPAIGN_INSTRUMENTS, D, DEFAULT_CAMPAIGN_PARAMS, DEFAULT_POT_PARAMS, SIGNAL_PHASE_HOURS, type CampaignStructure, type RiskConfig, type SignalPhase, type TdMode } from '@pegasus/shared';

/** The repository root, from where this module lives: the launcher, `pnpm dev:api` and tests run with different working directories. */
const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../../..');

const decimal = z.string().regex(/^\d+(\.\d+)?$/, 'must be a non-negative decimal');
const positive = decimal.refine((s) => D(s).gt(0), 'must be a positive decimal');
// A percentage typed where a fraction is meant (5 for 5%) would switch the check off.
const fraction = decimal.refine((s) => D(s).lt(1), 'must be a fraction below 1 (0.05 means 5%)');
const endpoint = z.string().refine((s) => s === '' || URL.canParse(s), 'must be a URL').default('');

/** A comma separated list of instrument ids: trimmed, upper case, without empty entries and repeats. */
const instrumentList = (value: string): string[] => [...new Set(value.split(',').map((s) => s.trim().toUpperCase()).filter((s) => s.length > 0))];

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
  /**
   * Paper trading: the local paper exchange (packages/paper) that keeps the account, e.g. http://127.0.0.1:9200.
   * Market data stays on OKX (the live hosts); every signed request and the private socket go here instead.
   */
  PAPER_EXCHANGE_URL: endpoint,
  /** Must stay '0' (REST): '1' used to send order operations over the private WebSocket, see loadConfig. */
  OKX_WS_TRADING: z.enum(['0', '1']).default('0'),

  API_HOST: z.string().default('127.0.0.1'),
  API_PORT: z.coerce.number().int().min(1).max(65535).default(8787),
  API_TOKEN: z.string().min(1).default('change-me'),
  /** Web origins (comma separated) whose pages may call the API; the Vite dev server by default. */
  WEB_ORIGINS: z.string().default('http://localhost:5174,http://127.0.0.1:5174'),
  INSTRUMENTS: z.string().default('BTC-USDT-SWAP,ETH-USDT-SWAP'),
  DEFAULT_TD_MODE: z.enum(['cross', 'isolated']).default('cross'),
  /** Daily cuts the SIGNALS tab computes, UTC hours, comma separated: 0, 12 or both. Each cut is sized at 1/n of a unit. */
  SIGNAL_PHASES: z.string().default(SIGNAL_PHASE_HOURS.join(',')),
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

  /** '1' lets the API run campaigns (the rule of packages/shared/src/campaign.ts). Paper trading only in this stage, see loadConfig. */
  CAMPAIGN_ENABLED: z.enum(['0', '1']).default('0'),
  /** USDT swaps the campaigns run on, comma separated (the ten of CAMPAIGN_INSTRUMENTS in @pegasus/shared by default); tracked like INSTRUMENTS while the campaign is enabled. */
  CAMPAIGN_INSTRUMENTS: z.string().default(CAMPAIGN_INSTRUMENTS.join(',')),
  /** What the pot starts with, USDT. */
  CAMPAIGN_POT_START: positive.default(DEFAULT_POT_PARAMS.start),
  /** Smallest stake: with less free cash than this the pot opens no campaign. */
  CAMPAIGN_MIN_STAKE: positive.default(DEFAULT_POT_PARAMS.minStake),
  /** pyramid: a campaign that works adds to itself out of its open profit; noadd: it holds its entry quantity to the end. */
  CAMPAIGN_STRUCTURE: z.enum(['pyramid', 'noadd']).default(DEFAULT_CAMPAIGN_PARAMS.structure),
  /** The campaign's ledger (the pot, its campaigns, the decision log); relative paths are under the repository root. */
  CAMPAIGN_STATE_FILE: z.string().min(1).default('data/campaign-ledger.json'),
});

export interface CampaignConfig {
  enabled: boolean;
  /** USDT swaps the campaigns run on */
  instruments: string[];
  /** What the pot starts with, USDT */
  potStart: string;
  /** Smallest stake */
  minStake: string;
  structure: CampaignStructure;
  /** Leverage of a campaign: the most its isolated position's notional may be of its equity (DEFAULT_CAMPAIGN_PARAMS, not a setting) */
  leverage: string;
  /** Taker fee rate the campaign's sizing and margin moves leave room for (DEFAULT_CAMPAIGN_PARAMS, not a setting) */
  feeRate: string;
  /** Absolute path of the campaign's ledger file (CAMPAIGN_STATE_FILE), kept whichever store the API uses */
  stateFile: string;
  /** Where the replay beside the pot keeps the bars and the funding it reads from OKX: data/campaign-replay under the repository root (git-ignored) */
  replayCacheDir: string;
}

export interface AppConfig {
  okx: {
    credentials: OkxCredentials | undefined;
    demo: boolean;
    /** Orders, positions and balance are simulated by the paper exchange; nothing private is sent to OKX. */
    paper: boolean;
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
  /**
   * What the server tracks (market data, `hello.instruments`, /api/instruments): INSTRUMENTS, and the campaign's
   * instruments after them while the campaign is enabled, so that their markets are subscribed.
   */
  instruments: string[];
  /**
   * INSTRUMENTS alone, as configured: what /api/signals reports on when no instrument is asked for, and with it the
   * SIGNALS tab. The campaign's instruments are tracked, not signalled.
   */
  signalInstruments: string[];
  /** Daily cuts the signals are computed at, ascending. */
  signalPhases: SignalPhase[];
  defaultTdMode: TdMode;
  databaseUrl: string | undefined;
  /** Absolute path of the file the memory store keeps its settings in. */
  stateFile: string;
  /** Absolute path of the directory the dated log files go to. */
  logDir: string;
  /** Short commit hash the stack was started from, or 'unknown'. */
  version: string;
  risk: RiskConfig;
  /** The campaign rule; `enabled` only ever in paper trading. */
  campaign: CampaignConfig;
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): AppConfig {
  const parsed = envSchema.safeParse(env);
  if (!parsed.success) {
    const issues = parsed.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('; ');
    throw new Error(`invalid configuration: ${issues}`);
  }
  const e = parsed.data;
  const paper = e.PAPER_EXCHANGE_URL !== '';
  // Paper trades on the real market: its prices are OKX's live ones, never the demo environment's.
  const demo = !paper && e.OKX_DEMO === '1';
  const defaults = defaultEndpoints(demo);
  // All three or none: a partial set would otherwise start silently without the account.
  const missing = (['OKX_API_KEY', 'OKX_API_SECRET', 'OKX_API_PASSPHRASE'] as const).filter((name) => e[name] === '');
  if (!paper && (missing.length === 1 || missing.length === 2)) {
    throw new Error(`invalid configuration: OKX credentials are incomplete: ${missing.join(', ')} ${missing.length === 1 ? 'is' : 'are'} not set (set all three, or leave all three empty for market data only)`);
  }
  const hasCreds = missing.length === 0;
  // The paper exchange checks no signature. A key configured for OKX is not used at all in paper mode: what is
  // signed goes to the paper exchange only, and it is signed with this placeholder.
  const credentials: OkxCredentials | undefined = paper
    ? { apiKey: 'paper', apiSecret: 'paper', passphrase: 'paper' }
    : hasCreds
      ? { apiKey: e.OKX_API_KEY, apiSecret: e.OKX_API_SECRET, passphrase: e.OKX_API_PASSPHRASE }
      : undefined;
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
  const ownInstruments = instrumentList(e.INSTRUMENTS);
  if (ownInstruments.length === 0) throw new Error('INSTRUMENTS must list at least one instrument');
  const campaignEnabled = e.CAMPAIGN_ENABLED === '1';
  const campaignInstruments = instrumentList(e.CAMPAIGN_INSTRUMENTS);
  if (campaignEnabled) {
    // The rule is proven on paper first. In paper mode no OKX key is used at all: whatever is signed carries the
    // placeholder key above and goes to the paper exchange only, so no order of a campaign can reach an OKX account.
    if (!paper) {
      throw new Error('invalid configuration: CAMPAIGN_ENABLED=1 is refused: this stage of the campaign is paper only, it runs on the paper exchange and never on an OKX account. Start Pegasus with pnpm start --paper (or PAPER_TRADING=1 in .env), or set CAMPAIGN_ENABLED=0');
    }
    if (campaignInstruments.length === 0) throw new Error('invalid configuration: CAMPAIGN_INSTRUMENTS must list at least one instrument while CAMPAIGN_ENABLED=1');
    const notUsdt = campaignInstruments.filter((id) => !/^[A-Z0-9]+-USDT-SWAP$/.test(id));
    if (notUsdt.length > 0) throw new Error(`invalid configuration: CAMPAIGN_INSTRUMENTS must list USDT swaps (<coin>-USDT-SWAP), the campaign trades linear contracts only; got ${notUsdt.join(', ')}`);
    if (D(e.CAMPAIGN_MIN_STAKE).gt(e.CAMPAIGN_POT_START)) {
      throw new Error(`invalid configuration: CAMPAIGN_MIN_STAKE ${e.CAMPAIGN_MIN_STAKE} is more than CAMPAIGN_POT_START ${e.CAMPAIGN_POT_START}: the pot could never open a campaign`);
    }
  }
  // The campaign's instruments are tracked like the terminal's own: market data, the instrument list, positions.
  const instruments = campaignEnabled ? [...new Set([...ownInstruments, ...campaignInstruments])] : ownInstruments;
  const phaseNames = e.SIGNAL_PHASES.split(',').map((s) => s.trim()).filter((s) => s.length > 0);
  const unknownPhases = phaseNames.filter((s) => !SIGNAL_PHASE_HOURS.some((h) => String(h) === s));
  if (phaseNames.length === 0 || unknownPhases.length > 0) {
    throw new Error(`invalid configuration: SIGNAL_PHASES must list one or more of ${SIGNAL_PHASE_HOURS.join(', ')} (UTC hours of the daily cuts), got '${e.SIGNAL_PHASES}'`);
  }
  const signalPhases = SIGNAL_PHASE_HOURS.filter((h) => phaseNames.includes(String(h)));
  // An Origin header never ends in a slash; one typed into .env is dropped rather than left to never match.
  const webOrigins = e.WEB_ORIGINS.split(',').map((s) => s.trim().replace(/\/$/, '')).filter((s) => s.length > 0);
  const endpoints: OkxEndpoints = overridden ? { rest: e.OKX_REST_URL, wsPublic: e.OKX_WS_PUBLIC_URL, wsPrivate: e.OKX_WS_PRIVATE_URL, wsBusiness: e.OKX_WS_BUSINESS_URL } : defaults;
  if (paper) {
    const base = new URL(e.PAPER_EXCHANGE_URL);
    endpoints.restPrivate = base.origin;
    endpoints.wsPrivate = `${base.protocol === 'https:' ? 'wss' : 'ws'}://${base.host}/ws/v5/private`;
  }
  return {
    okx: {
      credentials,
      demo,
      paper,
      wsTrading: false,
      endpoints,
    },
    server: { host: e.API_HOST, port: e.API_PORT, token: e.API_TOKEN, webOrigins, logLevel: e.LOG_LEVEL },
    instruments,
    signalInstruments: ownInstruments,
    signalPhases,
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
    campaign: {
      enabled: campaignEnabled,
      instruments: campaignInstruments,
      potStart: e.CAMPAIGN_POT_START,
      minStake: e.CAMPAIGN_MIN_STAKE,
      structure: e.CAMPAIGN_STRUCTURE,
      leverage: DEFAULT_CAMPAIGN_PARAMS.leverage,
      feeRate: DEFAULT_CAMPAIGN_PARAMS.feeRate,
      stateFile: resolve(REPO_ROOT, e.CAMPAIGN_STATE_FILE),
      replayCacheDir: resolve(REPO_ROOT, 'data', 'campaign-replay'),
    },
  };
}
