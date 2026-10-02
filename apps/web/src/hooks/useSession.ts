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
    if (helloSeq < 2) return; // the first hello is covered by the initial fetch
    void qc.invalidateQueries({ queryKey: ['orders', 'history'] });
    void qc.invalidateQueries({ queryKey: ['fills'] });
  }, [helloSeq, qc]);

  const history = useQuery({
    queryKey: ['orders', 'history'],
    queryFn: () => api.orderHistory({ limit: LIMITS.orderHistory }),
    staleTime: Infinity,
  });
  const fills = useQuery({
    queryKey: ['fills'],
    queryFn: () => api.fills({ limit: LIMITS.fills }),
    staleTime: Infinity,
  });

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
