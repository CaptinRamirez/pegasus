import { keepPreviousData, useQuery } from '@tanstack/react-query';
import { api } from '../lib/api';

/** How often the signals are read again: the plans follow the mark price; the states change at the closes. */
export const SIGNALS_REFETCH_MS = 30_000;

/**
 * GET /api/campaign/signals with the trader's risk per trade; the server sizes with the account's equity. The table on
 * screen stays while the next answer loads.
 */
export function useCampaignSignals(riskPct: string) {
  return useQuery({
    queryKey: ['campaign-signals', riskPct],
    queryFn: () => api.campaignSignals({ riskPct }),
    refetchInterval: SIGNALS_REFETCH_MS,
    staleTime: 15_000,
    // The page stays open for hours in a background tab; coming back to it must show the current bar.
    refetchOnWindowFocus: 'always',
    placeholderData: keepPreviousData,
  });
}
