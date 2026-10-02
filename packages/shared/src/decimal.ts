import { Decimal } from 'decimal.js';

/**
 * All money-like values cross process boundaries as decimal strings and are
 * computed with decimal.js. Never use the JS `number` type for prices, sizes
 * or PnL anywhere in the system.
 */
Decimal.set({ precision: 40, rounding: Decimal.ROUND_HALF_UP, toExpNeg: -40, toExpPos: 40 });

export { Decimal };

export type DecimalInput = Decimal | string | number;

export const D = (v: DecimalInput): Decimal => (v instanceof Decimal ? v : new Decimal(v));

export const ZERO = new Decimal(0);

/** Matches a plain decimal string such as "0", "-1.5", "12345.000". No exponents. */
export const DECIMAL_STRING_RE = /^-?\d+(\.\d+)?$/;

export function isDecimalString(s: unknown): s is string {
  return typeof s === 'string' && DECIMAL_STRING_RE.test(s);
}

/** Round `value` down to a multiple of `step` (e.g. lot size). Step must be > 0. */
export function floorToStep(value: DecimalInput, step: DecimalInput): Decimal {
  const s = D(step);
  if (s.lte(0)) throw new Error(`floorToStep: step must be > 0, got ${s.toString()}`);
  return D(value).div(s).floor().mul(s);
}

/** Round `value` up to a multiple of `step`. */
export function ceilToStep(value: DecimalInput, step: DecimalInput): Decimal {
  const s = D(step);
  if (s.lte(0)) throw new Error(`ceilToStep: step must be > 0, got ${s.toString()}`);
  return D(value).div(s).ceil().mul(s);
}

/** Round `value` to the nearest multiple of `step` (half up). */
export function roundToStep(value: DecimalInput, step: DecimalInput): Decimal {
  const s = D(step);
  if (s.lte(0)) throw new Error(`roundToStep: step must be > 0, got ${s.toString()}`);
  return D(value).div(s).toDecimalPlaces(0, Decimal.ROUND_HALF_UP).mul(s);
}

export function isMultipleOf(value: DecimalInput, step: DecimalInput): boolean {
  const s = D(step);
  if (s.lte(0)) return false;
  return D(value).mod(s).isZero();
}

/** Number of decimal places implied by a step such as "0.01" -> 2, "1" -> 0, "0.0001" -> 4. */
export function decimalsOfStep(step: DecimalInput): number {
  return Math.max(0, D(step).decimalPlaces());
}

/** Canonical string form: no exponent, no trailing zeros beyond what the step requires. */
export function toPlainString(value: DecimalInput, step?: DecimalInput): string {
  const d = D(value);
  if (step === undefined) return d.toFixed();
  // Round to the step's precision, then print the shortest exact form ("12000", "0.1").
  return d.toDecimalPlaces(decimalsOfStep(step)).toFixed();
}

export function maxDecimal(a: DecimalInput, b: DecimalInput): Decimal {
  return D(a).gte(b) ? D(a) : D(b);
}

export function minDecimal(a: DecimalInput, b: DecimalInput): Decimal {
  return D(a).lte(b) ? D(a) : D(b);
}

export function sumDecimals(values: Iterable<DecimalInput>): Decimal {
  let acc = ZERO;
  for (const v of values) acc = acc.plus(D(v));
  return acc;
}
