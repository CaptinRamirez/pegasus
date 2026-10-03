import { D, Decimal, floorToStep, isMultipleOf, roundToStep, toPlainString, type DecimalInput } from './decimal.js';
import type { Instrument, OrdType, Side } from './types.js';

/**
 * Contract arithmetic for OKX perpetual swaps.
 *
 * OKX order sizes (`sz`) are ALWAYS in contracts. One contract is worth
 * `ctVal` units of `ctValCcy`:
 *  - linear  (BTC-USDT-SWAP): ctVal = 0.01, ctValCcy = BTC  -> 1 contract = 0.01 BTC
 *  - inverse (BTC-USD-SWAP):  ctVal = 100,  ctValCcy = USD  -> 1 contract = 100 USD
 */

export class SizingError extends Error {
  constructor(
    public readonly code: string,
    message: string,
  ) {
    super(message);
    this.name = 'SizingError';
  }
}

/** Multiplier applied to ctVal; OKX reports ctMult = 1 for all current swaps. */
function contractUnit(inst: Instrument): Decimal {
  return D(inst.ctVal).mul(D(inst.ctMult || '1'));
}

/** Convert an amount of base coin into (unrounded) contracts. */
export function coinToContracts(coin: DecimalInput, inst: Instrument, price?: DecimalInput): Decimal {
  if (inst.ctType === 'linear') return D(coin).div(contractUnit(inst));
  // inverse: contract is denominated in quote (USD); coin * price = USD notional
  if (price === undefined) throw new SizingError('PRICE_REQUIRED', 'price is required to size an inverse contract from coin');
  return D(coin).mul(D(price)).div(contractUnit(inst));
}

/** Convert contracts into base coin. */
export function contractsToCoin(contracts: DecimalInput, inst: Instrument, price?: DecimalInput): Decimal {
  if (inst.ctType === 'linear') return D(contracts).mul(contractUnit(inst));
  if (price === undefined) throw new SizingError('PRICE_REQUIRED', 'price is required to convert inverse contracts to coin');
  return D(contracts).mul(contractUnit(inst)).div(D(price));
}

/** Convert a quote-currency notional (e.g. USDT) into (unrounded) contracts at `price`. */
export function quoteToContracts(quote: DecimalInput, price: DecimalInput, inst: Instrument): Decimal {
  const p = D(price);
  if (p.lte(0)) throw new SizingError('PRICE_REQUIRED', 'a positive price is required to size from quote notional');
  if (inst.ctType === 'linear') return D(quote).div(p).div(contractUnit(inst));
  return D(quote).div(contractUnit(inst));
}

/**
 * Notional value of `contracts` in the quote/settlement currency at `price`.
 * For USDT/USDC-margined swaps this is in USDT/USDC (treated as USD by the risk engine).
 * For inverse swaps the notional is simply contracts * ctVal (USD).
 */
export function notionalQuote(contracts: DecimalInput, price: DecimalInput, inst: Instrument): Decimal {
  const c = D(contracts).abs();
  if (inst.ctType === 'linear') return c.mul(contractUnit(inst)).mul(D(price));
  return c.mul(contractUnit(inst));
}

export interface NormalizedSize {
  /** Contracts as the exchange expects them (string, multiple of lotSz) */
  sz: string;
  contracts: Decimal;
  coin: Decimal;
}

/**
 * Round a raw contract amount DOWN to the lot size and validate against the
 * instrument limits. Throws SizingError with a stable code on violation.
 */
export function normalizeContracts(
  rawContracts: DecimalInput,
  inst: Instrument,
  ordType: OrdType,
  price?: DecimalInput,
): NormalizedSize {
  const raw = D(rawContracts);
  if (!raw.isFinite() || raw.lte(0)) throw new SizingError('SIZE_NOT_POSITIVE', 'size must be positive');
  const contracts = floorToStep(raw, inst.lotSz);
  if (contracts.lt(inst.minSz)) {
    throw new SizingError(
      'SIZE_BELOW_MIN',
      `size ${toPlainString(contracts, inst.lotSz)} contracts is below the minimum ${inst.minSz} for ${inst.instId}`,
    );
  }
  const max = ordType === 'market' ? inst.maxMktSz : inst.maxLmtSz;
  if (D(max).gt(0) && contracts.gt(max)) {
    throw new SizingError('SIZE_ABOVE_MAX', `size ${contracts.toFixed()} contracts exceeds the exchange maximum ${max} for ${inst.instId}`);
  }
  const coin = inst.ctType === 'linear' ? contractsToCoin(contracts, inst) : price !== undefined ? contractsToCoin(contracts, inst, price) : D(0);
  return { sz: toPlainString(contracts, inst.lotSz), contracts, coin };
}

/**
 * Normalise a limit price to the tick size. Buys are rounded down and sells
 * rounded up so the rounded price is never more aggressive than requested.
 */
export function normalizePrice(px: DecimalInput, inst: Instrument, side: Side): string {
  const p = D(px);
  if (!p.isFinite() || p.lte(0)) throw new SizingError('PRICE_NOT_POSITIVE', 'price must be positive');
  if (isMultipleOf(p, inst.tickSz)) return toPlainString(p, inst.tickSz);
  const rounded = side === 'buy' ? floorToStep(p, inst.tickSz) : roundToStep(p, inst.tickSz).gte(p) ? roundToStep(p, inst.tickSz) : floorToStep(p, inst.tickSz).plus(inst.tickSz);
  if (rounded.lte(0)) throw new SizingError('PRICE_NOT_POSITIVE', 'price rounds to zero at this tick size');
  return toPlainString(rounded, inst.tickSz);
}

export interface SizeFromUnitInput {
  unit: 'contracts' | 'coin' | 'quote';
  value: DecimalInput;
}

/**
 * Convert a user-facing size (contracts, coin or quote notional) into exchange
 * contracts. `price` is the reference price used for coin/quote conversions
 * (the limit price for limit orders, the mark or best price for market orders).
 */
export function sizeToContracts(
  size: SizeFromUnitInput,
  inst: Instrument,
  ordType: OrdType,
  price?: DecimalInput,
): NormalizedSize {
  let raw: Decimal;
  switch (size.unit) {
    case 'contracts':
      raw = D(size.value);
      break;
    case 'coin':
      raw = coinToContracts(size.value, inst, price);
      break;
    case 'quote':
      if (price === undefined) throw new SizingError('PRICE_REQUIRED', 'price is required to size from quote notional');
      raw = quoteToContracts(size.value, price, inst);
      break;
  }
  return normalizeContracts(raw, inst, ordType, price);
}
