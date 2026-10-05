import type { MockStop, OkxBalance, OkxFill, OkxInstrument, OkxOrder, OkxPosMode, OkxPosition } from './wire.js';

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
  /** Tier-1 maintenance margin rate per instId, over the defaults (BTC and ETH 0.004; another instrument half the initial margin rate of its highest leverage). */
  mmr?: Record<string, string>;
  log?: (msg: string) => void;
}

export interface MockState {
  orders: OkxOrder[];
  positions: OkxPosition[];
  balance: OkxBalance;
  fills: OkxFill[];
  /** Active attached stop-losses (algo orders: they are not in `orders`). */
  stops: MockStop[];
}

export interface MockOkxHandle {
  port: number;
  restUrl: string;
  wsPublicUrl: string;
  wsPrivateUrl: string;
  wsBusinessUrl: string;
  close(): Promise<void>;
  /** Jumps the simulated mid price (and runs matching for resting orders). The book and the last price follow; so does the mark unless it is pinned. */
  setPrice(instId: string, px: string): void;
  /**
   * Pins the mark price at `px`, apart from the book and the last price, and checks the attached stops against
   * it; it stays there through later ticks and setPrice calls until `null` lets it follow the mid price again.
   */
  setMarkPrice(instId: string, px: string | null): void;
  getState(): MockState;
  /** Advances one simulated tick manually. */
  tick(): void;
}
