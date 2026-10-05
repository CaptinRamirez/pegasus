import { useEffect } from 'react';
import { keepPreviousData, useInfiniteQuery, useQuery, useQueryClient } from '@tanstack/react-query';
import type { CampaignLogPage, CampaignView } from '@pegasus/shared';
import { api } from '../lib/api';
import { isNotFound } from '../lib/campaign';
import { useStore } from '../store/store';

/**
 * GET /api/campaign. The socket pushes the view while the campaign is enabled; only this request says that it is
 * disabled. Shared by the seeding hook and the campaign tab, which shows a failed load and offers a retry.
 */
export const CAMPAIGN_QUERY = {
  queryKey: ['campaign', 'view'],
  queryFn: () => api.campaign(),
  staleTime: Infinity,
} as const;

/** Steps per page of the decision log. */
export const CAMPAIGN_LOG_PAGE = 20;

/** A reply that is a view at all: an API that does not know the route (or a stub) must not put something else in the store. */
function isCampaignView(v: unknown): v is CampaignView {
  if (typeof v !== 'object' || v === null) return false;
  const o = v as { status?: unknown; serverTime?: unknown; campaigns?: unknown };
  return typeof o.status === 'string' && typeof o.serverTime === 'number' && Array.isArray(o.campaigns);
}

/**
 * Seeds the campaign view from REST, and reads it again after every reconnect (a later hello): a restarted server
 * whose campaign is now disabled sends no `campaign` message to replace the one on screen.
 */
export function useCampaignSeed(): void {
  const applyCampaignView = useStore((s) => s.applyCampaignView);
  const helloSeq = useStore((s) => s.helloSeq);
  const qc = useQueryClient();

  useEffect(() => {
    if (helloSeq === 0) return;
    // The first hello is covered by the initial fetch, unless that failed (the page was opened before the API was up).
    const failed = qc.getQueryState(CAMPAIGN_QUERY.queryKey)?.status === 'error';
    if (helloSeq < 2 && !failed) return;
    void qc.invalidateQueries({ queryKey: CAMPAIGN_QUERY.queryKey, exact: true });
  }, [helloSeq, qc]);

  const q = useQuery(CAMPAIGN_QUERY);
  useEffect(() => {
    if (isCampaignView(q.data)) applyCampaignView(q.data);
  }, [q.data, applyCampaignView]);
}

/** Whether the pot exists, so that there is something to replay and a log to read. */
const potStarted = (view: CampaignView | null): boolean => view !== null && view.status !== 'disabled' && view.pot !== null;

/**
 * GET /api/campaign/replay, read again whenever the view's replay summary changes its computedAt (a new result) or
 * its status (a failed attempt keeps the earlier result and says why). The replay on screen stays while the next
 * one loads. A 404 is not retried: that API has no replay.
 */
export function useCampaignReplay(view: CampaignView | null) {
  const summary = view?.replay ?? null;
  return useQuery({
    queryKey: ['campaign', 'replay', summary?.status ?? null, summary?.computedAt ?? null],
    queryFn: () => api.campaignReplay(),
    enabled: potStarted(view),
    staleTime: Infinity,
    placeholderData: keepPreviousData,
    retry: (failures, error) => !isNotFound(error) && failures < 1,
  });
}

/**
 * GET /api/campaign/log, newest first, a page at a time. Read again from its newest step when a step starts or ends
 * (the view's lastStep); the steps on screen stay while it loads.
 */
export function useCampaignLog(view: CampaignView | null) {
  const last = view?.lastStep ?? null;
  return useInfiniteQuery({
    queryKey: ['campaign', 'log', last?.seq ?? null, last?.endedAt ?? null],
    queryFn: ({ pageParam }): Promise<CampaignLogPage> =>
      api.campaignLog(pageParam === null ? { limit: CAMPAIGN_LOG_PAGE } : { before: pageParam, limit: CAMPAIGN_LOG_PAGE }),
    initialPageParam: null as number | null,
    getNextPageParam: (page: CampaignLogPage) => page.next,
    enabled: potStarted(view),
    staleTime: Infinity,
    placeholderData: keepPreviousData,
  });
}
