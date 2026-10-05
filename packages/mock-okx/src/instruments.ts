import type { OkxInstrument } from './wire.js';

const LIST_TIME = '1611916800000';

function swap(partial: Partial<OkxInstrument> & { instId: string }): OkxInstrument {
  const [base = '', quote = ''] = partial.instId.split('-');
  const uly = `${base}-${quote}`;
  return {
    instType: 'SWAP',
    uly,
    instFamily: uly,
    // OKX reports empty base/quote currencies for swaps.
    baseCcy: '',
    quoteCcy: '',
    settleCcy: quote,
    ctVal: '0.01',
    ctMult: '1',
    ctValCcy: base,
    ctType: 'linear',
    lotSz: '0.1',
    minSz: '0.1',
    tickSz: '0.1',
    maxLmtSz: '100000',
    maxMktSz: '12000',
    lever: '100',
    state: 'live',
    listTime: LIST_TIME,
    expTime: '',
    category: '1',
    optType: '',
    stk: '',
    alias: '',
    maxIcebergSz: '100000',
    maxTriggerSz: '100000',
    maxStopSz: '12000',
    maxTwapSz: '100000',
    ...partial,
  };
}

export const DEFAULT_INSTRUMENTS: readonly OkxInstrument[] = [
  swap({ instId: 'BTC-USDT-SWAP', ctVal: '0.01', ctValCcy: 'BTC', lotSz: '0.1', minSz: '0.1', tickSz: '0.1', maxLmtSz: '100000', maxMktSz: '12000', lever: '100' }),
  swap({ instId: 'ETH-USDT-SWAP', ctVal: '0.1', ctValCcy: 'ETH', lotSz: '0.1', minSz: '0.1', tickSz: '0.01', maxLmtSz: '100000', maxMktSz: '20000', lever: '75' }),
];

export const DEFAULT_PRICES: Readonly<Record<string, string>> = {
  'BTC-USDT-SWAP': '60000',
  'ETH-USDT-SWAP': '3000',
};

/**
 * Tier-1 maintenance margin rates, as OKX's position tiers gave them on 2026-10-05
 * (GET /api/v5/public/position-tiers?instType=SWAP&tdMode=isolated&tier=1): what an isolated position of the
 * instrument is liquidated by. An instrument that is not listed here gets the engine's fallback.
 */
export const DEFAULT_MMR: Readonly<Record<string, string>> = {
  'BTC-USDT-SWAP': '0.004',
  'ETH-USDT-SWAP': '0.004',
};

/** Merges user overrides onto the defaults; unknown instIds become new linear swaps. */
export function resolveInstruments(overrides: Record<string, Partial<OkxInstrument>> | undefined): OkxInstrument[] {
  const out = new Map<string, OkxInstrument>();
  for (const inst of DEFAULT_INSTRUMENTS) out.set(inst.instId, { ...inst });
  if (overrides) {
    for (const [instId, partial] of Object.entries(overrides)) {
      const base = out.get(instId) ?? swap({ instId });
      out.set(instId, { ...base, ...partial, instId });
    }
  }
  return [...out.values()];
}
