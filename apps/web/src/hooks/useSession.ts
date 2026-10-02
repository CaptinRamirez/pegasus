import { useEffect } from 'react';
import { useQuery } from '@tanstack/react-query';
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

/** Seeds order history and fills from REST once; live pushes keep them fresh afterwards. */
export function useHistorySeed(): void {
  const seedOrderHistory = useStore((s) => s.seedOrderHistory);
  const seedFills = useStore((s) => s.seedFills);
  const pushToast = useStore((s) => s.pushToast);

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
