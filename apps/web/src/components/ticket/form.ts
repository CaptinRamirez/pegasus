import {
  placeOrderRequestSchema,
  type Instrument,
  type OrdType,
  type PlaceOrderRequest,
  type PosMode,
  type Side,
  type SizeUnit,
  type TdMode,
} from '@pegasus/shared';

export interface TicketForm {
  side: Side;
  ordType: OrdType;
  px: string;
  sizeValue: string;
  sizeUnit: SizeUnit;
  reduceOnly: boolean;
  tdMode: TdMode;
  posSide: 'long' | 'short';
}

export const ORD_TYPES: readonly OrdType[] = ['limit', 'market', 'post_only', 'ioc', 'fok'];
export const SIZE_UNITS: readonly SizeUnit[] = ['coin', 'contracts', 'quote'];

export function defaultForm(): TicketForm {
  return {
    side: 'buy',
    ordType: 'limit',
    px: '',
    sizeValue: '',
    sizeUnit: 'coin',
    reduceOnly: false,
    tdMode: 'cross',
    posSide: 'long',
  };
}

export function needsPrice(ordType: OrdType): boolean {
  return ordType !== 'market';
}

export function unitLabel(unit: SizeUnit, inst: Instrument | null): string {
  switch (unit) {
    case 'coin':
      return inst?.baseCcy ?? 'coin';
    case 'contracts':
      return 'contracts';
    case 'quote':
      return inst?.quoteCcy ?? 'quote';
  }
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
    // OKX only honours reduce-only in net mode; in long/short mode closing is expressed by posSide.
    reduceOnly: posMode === 'long_short_mode' ? false : form.reduceOnly,
  };
  if (needsPrice(form.ordType)) candidate['px'] = form.px.trim();
  if (posMode === 'long_short_mode') candidate['posSide'] = form.posSide;
  const parsed = placeOrderRequestSchema.safeParse(candidate);
  return parsed.success ? parsed.data : null;
}

export function describeRequest(req: PlaceOrderRequest): string {
  const px = req.px === undefined ? 'market' : `@ ${req.px}`;
  return `${req.side} ${req.size.value} ${req.size.unit} ${req.instId} ${px}`;
}
