import { useQuery } from '@tanstack/react-query';
import { api } from '../lib/api';

/** GET /api/trader: the Claude trader's state; answers on every stack (`enabled` false where it does not run). */
export function useTrader() {
  return useQuery({ queryKey: ['trader', 'view'], queryFn: () => api.trader(), staleTime: 10_000, refetchInterval: 15_000 });
}

/** GET /api/trader/log: the latest records of the decision log, newest first. */
export function useTraderLog() {
  return useQuery({ queryKey: ['trader', 'log'], queryFn: () => api.traderLog(30), staleTime: 30_000, refetchInterval: 60_000 });
}
