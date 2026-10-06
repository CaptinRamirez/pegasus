import { useCallback, useRef, useState } from 'react';
import { useMutation } from '@tanstack/react-query';
import type { Localized, PlaceOrderRequest } from '@pegasus/shared';
import { errorText, inEveryLang, rejectionText, type Messages } from '../../i18n';
import { api, type PlaceOrderResponse } from '../../lib/api';
import { isApiError } from '../../lib/http';
import { useStore } from '../../store/store';
import { newClOrdId, type ClOrdIdPrefix } from './form';

/** Failures after which the order may or may not be on the exchange. */
const UNKNOWN_OUTCOME_CODES: readonly string[] = ['NETWORK', 'INTERNAL', 'EXCHANGE_UNREACHABLE', 'ORDER_STATUS_UNKNOWN'];
/** 5xx answers that are nevertheless definite: the exchange refused the order, or the server refused before sending anything. */
const NOT_SENT_CODES: readonly string[] = ['EXCHANGE', 'NO_PRICE', 'NO_BOOK', 'NO_DATA', 'LEVERAGE_UNAVAILABLE', 'NOT_CONNECTED'];
/** OKX's code for a client order id that is already in use. */
const OKX_DUPLICATE_CL_ORD_ID = '51016';

function outcomeUnknown(e: unknown): boolean {
  if (!isApiError(e)) return true;
  if (UNKNOWN_OUTCOME_CODES.includes(e.code) || e.status === 0) return true;
  return e.status >= 500 && !NOT_SENT_CODES.includes(e.code);
}

/** A step before the order (setting the leverage) failed: nothing was sent. */
export class PrepareError extends Error {
  constructor(public readonly failure: unknown) {
    super('the step before the order failed');
    this.name = 'PrepareError';
  }
}

/** Why a submit failed, as a text for either dictionary, and whether the order may nevertheless be on the exchange. */
export function submitFailure(e: unknown, retry: boolean): { text: (t: Messages) => string; unknown: boolean } {
  if (e instanceof PrepareError) return { text: (t) => t.follow.leverageFailed(errorText(e.failure, t)), unknown: false };
  if (retry && isApiError(e) && e.code === 'EXCHANGE' && e.details?.['okxCode'] === OKX_DUPLICATE_CL_ORD_ID) {
    return { text: (t) => t.ticket.errDuplicate, unknown: false };
  }
  if (outcomeUnknown(e)) return { text: (t) => t.ticket.errUnknown(errorText(e, t)), unknown: true };
  return { text: (t) => t.ticket.errRejected(refusalText(e, t), rejectionText(e, t)), unknown: false };
}

/** A definite refusal: the codes of the exits in words from their details, anything else as errorText. */
function refusalText(e: unknown, t: Messages): string {
  if (isApiError(e)) {
    const words = t.errorWords[e.code];
    if (words !== undefined) return `${e.code}: ${words(e.details ?? {})}`;
  }
  return errorText(e, t);
}

interface Attempt {
  /** The request without its client order id */
  key: string;
  clOrdId: string;
  /** Whether the id was already used by an earlier attempt whose outcome is unknown */
  retry: boolean;
  unknown: boolean;
}

interface Submission {
  request: PlaceOrderRequest;
  prepare: (() => Promise<void>) | undefined;
}

export interface PlaceOrderFlow {
  /** Sends the order; `prepare` runs first (a failure there sends nothing). */
  submit: (request: PlaceOrderRequest, prepare?: () => Promise<void>) => void;
  isPending: boolean;
  /** preparing: the step before the order runs; sending: the order is on its way */
  phase: 'idle' | 'preparing' | 'sending';
  /** Why the last submit failed, in both languages; null after a success */
  error: Localized | null;
  clearError: () => void;
}

/**
 * POST /api/orders with a client order id of `prefix` (pgw the ticket, psw a followed signal). The same order again
 * after an unknown outcome carries the same id and `retry: true`, so the server looks the first attempt up before
 * sending anything (OKX itself refuses the id as a duplicate only while the first order still rests, and the server's
 * memory of the id is lost when it restarts). Any other order gets a new id. A failure is pushed as an error toast and
 * kept in `error`.
 */
export function usePlaceOrder(prefix: ClOrdIdPrefix, onPlaced: (res: PlaceOrderResponse) => void): PlaceOrderFlow {
  const pushToast = useStore((s) => s.pushToast);
  const attempt = useRef<Attempt | null>(null);
  const [error, setError] = useState<Localized | null>(null);
  const [phase, setPhase] = useState<PlaceOrderFlow['phase']>('idle');

  const mutation = useMutation({
    mutationFn: async ({ request, prepare }: Submission) => {
      if (prepare !== undefined) {
        setPhase('preparing');
        try {
          await prepare();
        } catch (e) {
          throw new PrepareError(e);
        }
      }
      setPhase('sending');
      return api.placeOrder(request);
    },
    onSuccess: (res) => {
      attempt.current = null;
      setError(null);
      setPhase('idle');
      onPlaced(res);
    },
    onError: (e) => {
      const retry = attempt.current?.retry ?? false;
      const failed = submitFailure(e, retry);
      if (attempt.current !== null) attempt.current = { ...attempt.current, unknown: failed.unknown };
      const text = inEveryLang(failed.text);
      setError(text);
      setPhase('idle');
      pushToast('error', text);
    },
  });

  const submit = (request: PlaceOrderRequest, prepare?: () => Promise<void>) => {
    const key = JSON.stringify(request);
    const last = attempt.current;
    const retry = last !== null && last.unknown && last.key === key;
    const clOrdId = retry ? last.clOrdId : newClOrdId(prefix);
    attempt.current = { key, clOrdId, retry, unknown: false };
    mutation.mutate({ request: retry ? { ...request, clOrdId, retry: true } : { ...request, clOrdId }, prepare });
  };

  const clearError = useCallback(() => setError(null), []);
  return { submit, isPending: mutation.isPending, phase, error, clearError };
}
