import { keepPreviousData, skipToken, useQuery } from '@tanstack/react-query';
import type { PlaceOrderRequest } from '@pegasus/shared';
import { api, type OrderPreview } from '../../lib/api';
import { useDebouncedValue } from '../../hooks/useDebouncedValue';

export interface PreviewResult {
  /** The request the preview is for (debounced) */
  request: PlaceOrderRequest | null;
  preview: OrderPreview | undefined;
  error: unknown;
  isFetching: boolean;
  /** true when the request is stable and the preview matches it with risk.ok */
  canSubmit: boolean;
}

/** Debounced (300 ms) preview of the current order request via POST /api/orders/preview. */
export function useOrderPreview(request: PlaceOrderRequest | null): PreviewResult {
  const serialized = request === null ? null : JSON.stringify(request);
  const debounced = useDebouncedValue(serialized, 300);
  const debouncedRequest: PlaceOrderRequest | null =
    debounced === null ? null : (JSON.parse(debounced) as PlaceOrderRequest);

  const q = useQuery({
    queryKey: ['preview', debounced],
    queryFn: debouncedRequest === null ? skipToken : ({ signal }) => api.previewOrder(debouncedRequest, signal),
    retry: false,
    staleTime: 0,
    refetchInterval: 5_000,
    placeholderData: keepPreviousData,
  });

  const stable = debounced === serialized && debounced !== null;
  const preview = debouncedRequest === null ? undefined : q.data;
  const canSubmit = stable && !q.isError && !q.isPlaceholderData && preview !== undefined && preview.risk.ok;

  return {
    request: debouncedRequest,
    preview,
    error: debouncedRequest === null ? null : q.error,
    isFetching: q.isFetching,
    canSubmit,
  };
}
