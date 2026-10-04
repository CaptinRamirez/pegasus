import type { OkxBalance, OkxFill, OkxInstrument, OkxOrder, OkxPosMode, OkxPosition } from './wire.js';

export interface MockCredentials {
  apiKey: string;
  apiSecret: string;
  passphrase: string;
}

export interface MockOkxOptions {
  /** 0 (default) picks a free port. */
  port?: number;
  host?: string;
  /** When set, private REST and WS calls must carry a valid OKX signature. */
  credentials?: MockCredentials;
  posMode?: OkxPosMode;
  /** Permissions of the API key as OKX lists them; default 'read_only,trade'. Without `trade` every write is refused. */
  perm?: string;
  /** Per-instId overrides; unknown instIds are added using BTC-USDT-SWAP as a template. */
  instruments?: Record<string, Partial<OkxInstrument>>;
  initialPrices?: Record<string, string>;
  /** Milliseconds between simulated ticks; 0 disables the timer (use handle.tick()). */
  tickIntervalMs?: number;
  /** Per-tick fractional standard deviation of the mid price random walk. */
  volatility?: number;
  seed?: number;
  initialBalanceUsdt?: string;
  takerFeeRate?: string;
  makerFeeRate?: string;
  log?: (msg: string) => void;
}

export interface MockState {
  orders: OkxOrder[];
  positions: OkxPosition[];
  balance: OkxBalance;
  fills: OkxFill[];
}

export interface MockOkxHandle {
  port: number;
  restUrl: string;
  wsPublicUrl: string;
  wsPrivateUrl: string;
  wsBusinessUrl: string;
  close(): Promise<void>;
  /** Jumps the simulated mid price (and runs matching for resting orders). */
  setPrice(instId: string, px: string): void;
  getState(): MockState;
  /** Advances one simulated tick manually. */
  tick(): void;
}
