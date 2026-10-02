import Decimal from 'decimal.js';

/**
 * A private Decimal constructor so the mock never touches the global
 * decimal.js configuration. Exponential notation is disabled far enough in
 * both directions that `toFixed()` never prints an exponent for exchange
 * quantities.
 */
export const D = Decimal.clone({ precision: 34, rounding: Decimal.ROUND_HALF_UP, toExpNeg: -24, toExpPos: 40 });

export type Dec = Decimal;

export function d(v: string | number | Decimal): Decimal {
  return new D(v);
}

export const ZERO: Decimal = d(0);
export const ONE: Decimal = d(1);

/** Formats a value with at most `dp` decimals, no exponent, no trailing zeros. */
export function fmt(v: Decimal, dp = 8): string {
  return v.toDecimalPlaces(dp).toFixed();
}

/** Number of decimal places implied by a step such as "0.01". */
export function decimalsOf(step: string): number {
  const i = step.indexOf('.');
  return i < 0 ? 0 : step.length - i - 1;
}

export function roundToStep(v: Decimal, step: Decimal, rounding: Decimal.Rounding = Decimal.ROUND_HALF_UP): Decimal {
  return v.div(step).toDecimalPlaces(0, rounding).mul(step);
}

export function isMultipleOf(v: Decimal, step: Decimal): boolean {
  return v.mod(step).isZero();
}

/** Formats a price/size that is already a multiple of `step`. */
export function fmtStep(v: Decimal, step: Decimal): string {
  return roundToStep(v, step).toFixed();
}

export function isDecimalString(s: unknown): s is string {
  return typeof s === 'string' && /^-?\d+(\.\d+)?$/.test(s);
}

export const ROUND_FLOOR = Decimal.ROUND_FLOOR;
export const ROUND_CEIL = Decimal.ROUND_CEIL;
export const ROUND_HALF_UP = Decimal.ROUND_HALF_UP;
