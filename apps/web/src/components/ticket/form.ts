import {
  placeOrderRequestSchema,
  type Instrument,
  type OrdType,
  type PlaceOrderRequest,
  type PosMode,
  type PosSide,
  type Side,
  type SizeUnit,
  type TdMode,
} from '@pegasus/shared';
import type { Messages } from '../../i18n';

export interface TicketForm {
  side: Side;
  ordType: OrdType;
  px: string;
  /** Trigger price of the stop-loss attached to an opening order; '' for none */
  slTriggerPx: string;
  sizeValue: string;
  sizeUnit: SizeUnit;
  /** Net mode: OKX's reduce-only flag. Long/short mode: the order closes (reduces) a position instead of opening one. */
  reduceOnly: boolean;
  tdMode: TdMode;
  /** The unit the form had before a pre-fill replaced it, restored when the instrument next changes; null when there is nothing to restore */
  restoreUnit: SizeUnit | null;
}

export type Intent = 'Open long' | 'Open short' | 'Close long' | 'Close short';

export const ORD_TYPES: readonly OrdType[] = ['limit', 'market', 'post_only', 'ioc', 'fok'];
export const SIZE_UNITS: readonly SizeUnit[] = ['coin', 'contracts', 'quote'];

export function defaultForm(): TicketForm {
  return {
    side: 'buy',
    ordType: 'limit',
    px: '',
    slTriggerPx: '',
    sizeValue: '',
    sizeUnit: 'coin',
    reduceOnly: false,
    tdMode: 'cross',
    restoreUnit: null,
  };
}

export function needsPrice(ordType: OrdType): boolean {
  return ordType !== 'market';
}

export function unitLabel(unit: SizeUnit, inst: Instrument | null, t: Messages): string {
  switch (unit) {
    case 'coin':
      return inst?.baseCcy ?? t.common.coin;
    case 'contracts':
      return t.common.contracts;
    case 'quote':
      return inst?.quoteCcy ?? t.common.quote;
  }
}

/**
 * The position side of an order in long/short mode. It follows from the direction and from whether the order
 * opens or closes, so the form cannot hold a pair that means something else than its buttons say.
 */
export function derivePosSide(side: Side, closing: boolean): 'long' | 'short' {
  return (side === 'buy') !== closing ? 'long' : 'short';
}

/**
 * What an order does to which position; null in net mode, where the side alone says it. The English words
 * are the value the code compares: the page shows them through the dictionary (enums.intent).
 */
export function intentOf(side: Side, posSide: PosSide | undefined): Intent | null {
  if (posSide !== 'long' && posSide !== 'short') return null;
  const opening = derivePosSide(side, false) === posSide;
  return `${opening ? 'Open' : 'Close'} ${posSide}`;
}

/**
 * Builds a PlaceOrderRequest from the form, or null when the form is not yet
 * complete/valid. Validation uses the shared zod schema so only requests the
 * server would accept are previewed or submitted.
 */
export function buildRequest(form: TicketForm, instId: string | null, posMode: PosMode | null): PlaceOrderRequest | null {
  if (instId === null) return null;
  const candidate: Record<string, unknown> = {
    instId,
    side: form.side,
    ordType: form.ordType,
    tdMode: form.tdMode,
    size: { unit: form.sizeUnit, value: form.sizeValue.trim() },
    // OKX only honours reduce-only in net mode; in long/short mode closing is expressed by posSide (below).
    reduceOnly: posMode === 'long_short_mode' ? false : form.reduceOnly,
  };
  if (needsPrice(form.ordType)) candidate['px'] = form.px.trim();
  if (posMode === 'long_short_mode') candidate['posSide'] = derivePosSide(form.side, form.reduceOnly);
  // Only an opening order carries a stop; the server refuses one on a closing order.
  if (!form.reduceOnly && form.slTriggerPx.trim() !== '') candidate['slTriggerPx'] = form.slTriggerPx.trim();
  const parsed = placeOrderRequestSchema.safeParse(candidate);
  return parsed.success ? parsed.data : null;
}

/** Client order id (alphanumeric, at most 32 chars); 'pgw' tells a web-generated id from the server's own 'pg' ones. */
export function newClOrdId(now = Date.now()): string {
  const random = crypto.getRandomValues(new Uint8Array(4));
  return `pgw${now.toString(36)}${[...random].map((b) => b.toString(16).padStart(2, '0')).join('')}`;
}

export function describeRequest(req: PlaceOrderRequest, t: Messages): string {
  return t.ticket.describe(req, intentOf(req.side, req.posSide));
}
