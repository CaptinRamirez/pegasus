import { useEffect } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { api } from '../lib/api';
import { isApiError } from '../lib/http';
import { signOut, startSession } from '../store/session';
import { useStore } from '../store/store';
import { LIMITS } from '../store/types';

/** Opens the WebSocket session for the token and tears it down on sign-out. */
export function useSession(token: string | null): void {
  useEffect(() => {
    if (token === null) return;
    return startSession(token);
  }, [token]);
}

/** Shared by the seeding hook and the History / Fills tables, which show a failed load and offer a retry. */
export const ORDER_HISTORY_QUERY = {
  queryKey: ['orders', 'history'],
  queryFn: () => api.orderHistory({ limit: LIMITS.orderHistory }),
  staleTime: Infinity,
} as const;
export const FILLS_QUERY = {
  queryKey: ['fills'],
  queryFn: () => api.fills({ limit: LIMITS.fills }),
  staleTime: Infinity,
} as const;

/**
 * Seeds order history and fills from REST; live pushes keep them fresh afterwards and
 * every new hello (a reconnect) re-fetches so orders completed during an outage appear.
 */
export function useHistorySeed(): void {
  const seedOrderHistory = useStore((s) => s.seedOrderHistory);
  const seedFills = useStore((s) => s.seedFills);
  const pushToast = useStore((s) => s.pushToast);
  const helloSeq = useStore((s) => s.helloSeq);
  const qc = useQueryClient();

  useEffect(() => {
    if (helloSeq === 0) return;
    // The first hello is covered by the initial fetch, unless that failed (the page was opened before the API was up).
    const failed = [ORDER_HISTORY_QUERY, FILLS_QUERY].some((q) => qc.getQueryState(q.queryKey)?.status === 'error');
    if (helloSeq < 2 && !failed) return;
    void qc.invalidateQueries({ queryKey: ORDER_HISTORY_QUERY.queryKey });
    void qc.invalidateQueries({ queryKey: FILLS_QUERY.queryKey });
  }, [helloSeq, qc]);

  const history = useQuery(ORDER_HISTORY_QUERY);
  const fills = useQuery(FILLS_QUERY);

  useEffect(() => {
    if (history.data !== undefined) seedOrderHistory(history.data);
  }, [history.data, seedOrderHistory]);
  useEffect(() => {
    if (fills.data !== undefined) seedFills(fills.data);
  }, [fills.data, seedFills]);

  const error = history.error ?? fills.error;
  useEffect(() => {
    if (error === null) return;
    if (isApiError(error) && error.code === 'UNAUTHORIZED') {
      pushToast('error', 'Token rejected by the server');
      signOut();
    }
  }, [error, pushToast]);
}
