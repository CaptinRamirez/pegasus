import { useQuery } from '@tanstack/react-query';
import type { TrailingView } from '@pegasus/shared';
import { api } from '../lib/api';
import { isApiError } from '../lib/http';

export const TRAILING_QUERY_KEY = ['trailing'] as const;

/** Whether take-profits and trailing exits are offered on this API: false where it refuses them (live trading), null while unknown. */
export function exitsAvailable(data: TrailingView | undefined, error: unknown): boolean | null {
  if (data !== undefined) return data.enabled;
  if (isApiError(error) && error.code === 'EXITS_UNAVAILABLE') return false;
  return null;
}

/**
 * GET /api/trailing: whether exits are offered here and the channel trailing the API keeps (its levels move after
 * every daily close, so it is read again every 30 s). A refusal with EXITS_UNAVAILABLE is an answer, not a failure.
 */
export function useTrailing(): { available: boolean | null; view: TrailingView | null; refetch: () => void } {
  const q = useQuery({
    queryKey: TRAILING_QUERY_KEY,
    queryFn: () => api.trailing(),
    staleTime: 15_000,
    refetchInterval: 30_000,
    retry: (failures, error) => !(isApiError(error) && error.code === 'EXITS_UNAVAILABLE') && failures < 1,
  });
  return { available: exitsAvailable(q.data, q.error), view: q.data ?? null, refetch: () => void q.refetch() };
}
