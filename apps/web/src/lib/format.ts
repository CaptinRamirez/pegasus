import {
  D,
  DECIMAL_STRING_RE,
  Decimal,
  ZERO,
  contractsToCoin,
  decimalsOfStep,
  toPlainString,
  type DecimalInput,
  type Instrument,
} from '@pegasus/shared';

export const DASH = '–';

/** Inserts thousands separators into a plain decimal string ("1234567.5" -> "1,234,567.5"). */
export function groupThousands(plain: string): string {
  const neg = plain.startsWith('-');
  const body = neg ? plain.slice(1) : plain;
  const dot = body.indexOf('.');
  const int = dot === -1 ? body : body.slice(0, dot);
  const frac = dot === -1 ? '' : body.slice(dot);
  const grouped = int.replace(/\B(?=(\d{3})+(?!\d))/g, ',');
  return `${neg ? '-' : ''}${grouped}${frac}`;
}

/** Parses user/exchange input into a finite Decimal, or null. */
export function safeDecimal(v: DecimalInput | null | undefined): Decimal | null {
  if (v === null || v === undefined || v === '') return null;
  try {
    const d = D(v);
    return d.isFinite() ? d : null;
  } catch {
    return null;
  }
}

export function isDecimalText(s: string): boolean {
  return DECIMAL_STRING_RE.test(s);
}

/** Significant digits of a price whose instrument (and so its tick size) is unknown. */
const UNTRACKED_PX_DIGITS = 8;
const UNTRACKED_PX_INTEGER = D(10).pow(UNTRACKED_PX_DIGITS);

/**
 * Price formatted to the instrument tick size, with thousands separators. Without the instrument (a position
 * or order outside the tracked list) no tick is assumed: a default step would print 0.1289 as 0.13.
 */
export function fmtPx(px: DecimalInput | null | undefined, inst?: Instrument | null): string {
  const d = safeDecimal(px);
  if (d === null) return DASH;
  if (inst !== null && inst !== undefined) return groupThousands(toPlainString(d, inst.tickSz));
  // Integer digits are never rounded away, whatever their number.
  const bounded = d.abs().gte(UNTRACKED_PX_INTEGER) ? d.toDecimalPlaces(0) : d.toSignificantDigits(UNTRACKED_PX_DIGITS);
  return groupThousands(bounded.toFixed());
}

/** Contract size formatted to the instrument lot size; the exact value when the instrument is unknown. */
export function fmtContracts(sz: DecimalInput | null | undefined, inst?: Instrument | null): string {
  const d = safeDecimal(sz);
  if (d === null) return DASH;
  return groupThousands(inst === null || inst === undefined ? d.toFixed() : toPlainString(d, inst.lotSz));
}

export function coinDecimals(inst: Instrument): number {
  return Math.min(8, decimalsOfStep(inst.ctVal) + decimalsOfStep(inst.lotSz));
}

/** Contracts converted to base coin for display. Inverse contracts need a price. */
export function fmtCoin(
  contracts: DecimalInput | null | undefined,
  inst: Instrument | null | undefined,
  price?: DecimalInput | null,
): string {
  const d = safeDecimal(contracts);
  if (d === null || inst === null || inst === undefined) return DASH;
  try {
    const px = price === null || price === undefined || price === '' ? undefined : price;
    const coin = px === undefined ? contractsToCoin(d, inst) : contractsToCoin(d, inst, px);
    return groupThousands(coin.toFixed(coinDecimals(inst)));
  } catch {
    return DASH;
  }
}

/** Generic fixed-decimals formatting with thousands separators. */
export function fmtNum(v: DecimalInput | null | undefined, dp = 2): string {
  const d = safeDecimal(v);
  if (d === null) return DASH;
  return groupThousands(d.toFixed(dp));
}

/** Like fmtNum but with an explicit '+' sign for positive values. */
export function fmtSigned(v: DecimalInput | null | undefined, dp = 2): string {
  const d = safeDecimal(v);
  if (d === null) return DASH;
  const s = groupThousands(d.toFixed(dp));
  return d.gt(0) ? `+${s}` : s;
}

/** Formats a fraction (0.0123) as a percentage ("1.23%"). */
export function fmtPct(fraction: DecimalInput | null | undefined, dp = 2, signed = false): string {
  const d = safeDecimal(fraction);
  if (d === null) return DASH;
  const pct = d.mul(100).toFixed(dp);
  return `${signed && d.gt(0) ? '+' : ''}${pct}%`;
}

/** Formats a fraction (0.00003) as basis points ("0.3 bp"). */
export function fmtBp(fraction: DecimalInput | null | undefined, dp = 1): string {
  const d = safeDecimal(fraction);
  if (d === null) return DASH;
  return `${d.mul(10_000).toFixed(dp)} bp`;
}

export type CompactUnit = 'K' | 'M' | 'B';

const COMPACT_SCALES: ReadonlyArray<readonly [CompactUnit, Decimal]> = [
  ['B', D('1000000000')],
  ['M', D('1000000')],
  ['K', D('1000')],
];

/** The K/M/B unit the absolute value reaches, or null below 1,000 (or when unparseable). */
export function compactUnit(v: DecimalInput | null | undefined): CompactUnit | null {
  const d = safeDecimal(v);
  if (d === null) return null;
  const abs = d.abs();
  for (const [unit, scale] of COMPACT_SCALES) if (abs.gte(scale)) return unit;
  return null;
}

/**
 * Compact K/M/B formatting: "4.2B", "812M", "1.2K", "950". One decimal below 10 units,
 * none above. Pass `unit` to force a scale so comparable values line up ("1.2M / 0.9M").
 */
export function fmtCompact(v: DecimalInput | null | undefined, unit?: CompactUnit | null): string {
  const d = safeDecimal(v);
  if (d === null) return DASH;
  const u = unit === undefined ? compactUnit(d) : unit;
  if (u === null) return groupThousands(d.toFixed(0));
  const scale = COMPACT_SCALES.find(([name]) => name === u)?.[1] ?? D(1);
  const scaled = d.div(scale);
  return `${scaled.toFixed(scaled.abs().lt(10) ? 1 : 0)}${u}`;
}

/** (last - open) / open, or null when open is zero/unparseable. */
export function pctChange(last: DecimalInput | null | undefined, open: DecimalInput | null | undefined): Decimal | null {
  const l = safeDecimal(last);
  const o = safeDecimal(open);
  if (l === null || o === null || o.isZero()) return null;
  return l.minus(o).div(o);
}

export type Sign = 'pos' | 'neg' | 'flat';

export function signOf(v: DecimalInput | null | undefined): Sign {
  const d = safeDecimal(v);
  if (d === null || d.isZero()) return 'flat';
  return d.gt(ZERO) ? 'pos' : 'neg';
}

const pad2 = (n: number): string => String(n).padStart(2, '0');

export function fmtTime(ts: number): string {
  const d = new Date(ts);
  return `${pad2(d.getHours())}:${pad2(d.getMinutes())}:${pad2(d.getSeconds())}`;
}

export function fmtDateTime(ts: number): string {
  const d = new Date(ts);
  return `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())} ${fmtTime(ts)}`;
}

/** The browser's local wall-clock time to the minute: "2026-10-03 08:00". */
export function fmtLocalMinute(ts: number): string {
  const d = new Date(ts);
  return `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())} ${pad2(d.getHours())}:${pad2(d.getMinutes())}`;
}

/**
 * The browser's local time of a moment shown in UTC beside it: "08:00", or "10-02 19:00" when it is another day
 * there than in UTC.
 */
export function fmtLocalTime(ts: number): string {
  const d = new Date(ts);
  const time = `${pad2(d.getHours())}:${pad2(d.getMinutes())}`;
  const sameDay = d.getFullYear() === d.getUTCFullYear() && d.getMonth() === d.getUTCMonth() && d.getDate() === d.getUTCDate();
  return sameDay ? time : `${pad2(d.getMonth() + 1)}-${pad2(d.getDate())} ${time}`;
}

/** UTC wall-clock time to the minute: "2026-10-03 00:00 UTC". */
export function fmtUtcMinute(ts: number): string {
  const d = new Date(ts);
  return `${d.getUTCFullYear()}-${pad2(d.getUTCMonth() + 1)}-${pad2(d.getUTCDate())} ${pad2(d.getUTCHours())}:${pad2(d.getUTCMinutes())} UTC`;
}

/** UTC wall-clock time to the second: "2026-10-03 00:02:15 UTC". */
export function fmtUtcSecond(ts: number): string {
  const d = new Date(ts);
  return `${d.getUTCFullYear()}-${pad2(d.getUTCMonth() + 1)}-${pad2(d.getUTCDate())} ${pad2(d.getUTCHours())}:${pad2(d.getUTCMinutes())}:${pad2(d.getUTCSeconds())} UTC`;
}

/** Coarse age for things that are hours or days old: "12 min", "5 h", "3 d". */
export function fmtAgeCoarse(ms: number): string {
  if (ms < 3_600_000) return `${Math.max(0, Math.floor(ms / 60_000))} min`;
  if (ms < 48 * 3_600_000) return `${Math.floor(ms / 3_600_000)} h`;
  return `${Math.floor(ms / 86_400_000)} d`;
}

export function fmtAge(ms: number): string {
  if (ms < 1_000) return `${ms}ms`;
  if (ms < 60_000) return `${Math.floor(ms / 1_000)}s`;
  return `${Math.floor(ms / 60_000)}m`;
}
