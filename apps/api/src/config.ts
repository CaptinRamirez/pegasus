import { z } from 'zod';
import { defaultEndpoints, type OkxCredentials, type OkxEndpoints } from '@pegasus/okx';
import type { RiskConfig, TdMode } from '@pegasus/shared';

const decimal = z.string().regex(/^\d+(\.\d+)?$/, 'must be a non-negative decimal');

const envSchema = z.object({
  OKX_API_KEY: z.string().default(''),
  OKX_API_SECRET: z.string().default(''),
  OKX_API_PASSPHRASE: z.string().default(''),
  OKX_DEMO: z.enum(['0', '1']).default('1'),
  OKX_REST_URL: z.string().url().optional(),
  OKX_WS_PUBLIC_URL: z.string().optional(),
  OKX_WS_PRIVATE_URL: z.string().optional(),
  OKX_WS_BUSINESS_URL: z.string().optional(),

  API_HOST: z.string().default('127.0.0.1'),
  API_PORT: z.coerce.number().int().min(1).max(65535).default(8787),
  API_TOKEN: z.string().min(1).default('change-me'),
  INSTRUMENTS: z.string().default('BTC-USDT-SWAP,ETH-USDT-SWAP'),
  DEFAULT_TD_MODE: z.enum(['cross', 'isolated']).default('cross'),
  LOG_LEVEL: z.enum(['trace', 'debug', 'info', 'warn', 'error', 'fatal']).default('info'),
  DATABASE_URL: z.string().optional(),

  RISK_MAX_ORDER_NOTIONAL: decimal.default('5000'),
  RISK_MAX_POSITION_NOTIONAL_PER_INSTRUMENT: decimal.default('20000'),
  RISK_MAX_TOTAL_POSITION_NOTIONAL: decimal.default('50000'),
  RISK_MAX_LEVERAGE: decimal.default('10'),
  RISK_DAILY_LOSS_LIMIT: decimal.default('1000'),
  RISK_MAX_OPEN_ORDERS: z.coerce.number().int().min(1).default(20),
  RISK_PRICE_BAND_PCT: decimal.default('0.05'),
  RISK_MAX_SLIPPAGE_PCT: decimal.default('0.005'),
});

export interface AppConfig {
  okx: {
    credentials: OkxCredentials | undefined;
    demo: boolean;
    endpoints: OkxEndpoints;
  };
  server: {
    host: string;
    port: number;
    token: string;
    logLevel: z.infer<typeof envSchema>['LOG_LEVEL'];
  };
  instruments: string[];
  defaultTdMode: TdMode;
  databaseUrl: string | undefined;
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
  const hasCreds = e.OKX_API_KEY !== '' && e.OKX_API_SECRET !== '' && e.OKX_API_PASSPHRASE !== '';
  const instruments = [...new Set(e.INSTRUMENTS.split(',').map((s) => s.trim().toUpperCase()).filter((s) => s.length > 0))];
  if (instruments.length === 0) throw new Error('INSTRUMENTS must list at least one instrument');
  return {
    okx: {
      credentials: hasCreds ? { apiKey: e.OKX_API_KEY, apiSecret: e.OKX_API_SECRET, passphrase: e.OKX_API_PASSPHRASE } : undefined,
      demo,
      endpoints: {
        rest: e.OKX_REST_URL ?? defaults.rest,
        wsPublic: e.OKX_WS_PUBLIC_URL ?? defaults.wsPublic,
        wsPrivate: e.OKX_WS_PRIVATE_URL ?? defaults.wsPrivate,
        wsBusiness: e.OKX_WS_BUSINESS_URL ?? defaults.wsBusiness,
      },
    },
    server: { host: e.API_HOST, port: e.API_PORT, token: e.API_TOKEN, logLevel: e.LOG_LEVEL },
    instruments,
    defaultTdMode: e.DEFAULT_TD_MODE,
    databaseUrl: e.DATABASE_URL,
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
