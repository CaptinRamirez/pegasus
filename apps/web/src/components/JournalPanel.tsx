import { useEffect, useMemo, useState } from 'react';
import { keepPreviousData, useInfiniteQuery } from '@tanstack/react-query';
import { TRADE_SOURCES, type Instrument, type JournalPage, type JournalTradeSummary, type TradeSource, type TradeStatus } from '@pegasus/shared';
import { labelOf, useT } from '../i18n';
import { api } from '../lib/api';
import { fmtR, trailingText } from '../lib/describe';
import { DASH, fmtContracts, fmtLocalMinute, fmtNum, fmtPx, fmtSigned, fmtUtcMinute, signOf } from '../lib/format';
import { NO_FILTER, journalQuery, mergeJournal, type JournalFilter } from '../lib/journal';
import { coinOf } from '../lib/signals';
import { useStore } from '../store/store';
import { useUi } from '../store/ui';
import { SourceBadge, StatusBadge } from './journal/badges';
import { TradeDrawer } from './journal/TradeDrawer';
import { LoadFailed } from './LoadFailed';

const STATUSES: readonly TradeStatus[] = ['open', 'closed'];

function TpPlanCell({ trade, inst }: { trade: JournalTradeSummary; inst: Instrument | undefined }) {
  const t = useT();
  const legs = trade.plan?.takeProfits ?? [];
  if (legs.length === 0) return <span className="dim">{DASH}</span>;
  const prices = legs.map((l) => fmtPx(l.triggerPx, inst));
  return <span title={prices.join(' / ')}>{legs.length <= 2 ? prices.join(' / ') : t.journal.tpCount(legs.length)}</span>;
}

/**
 * The JOURNAL tab: every trade of the account, newest first (GET /api/journal, page by page), kept current by the
 * `journal` messages; filters by coin, source and status; a row opens the trade's drawer.
 */
export function JournalPanel() {
  const t = useT();
  const [filter, setFilter] = useState<JournalFilter>(NO_FILTER);
  const [openId, setOpenId] = useState<string | null>(null);
  const live = useStore((s) => s.journal);
  const instruments = useStore((s) => s.instruments);
  const helloSeq = useStore((s) => s.helloSeq);
  const focus = useUi((s) => s.journalFocus);
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), 60_000);
    return () => clearInterval(timer);
  }, []);

  // A link from elsewhere (the toast of an order): the trade's drawer, or the coin's trades.
  useEffect(() => {
    if (focus === null) return;
    if (focus.tradeId !== null) setOpenId(focus.tradeId);
    if (focus.instId !== null) setFilter({ ...NO_FILTER, instId: focus.instId });
  }, [focus]);

  const q = useInfiniteQuery({
    queryKey: ['journal', 'list', filter],
    queryFn: ({ pageParam }): Promise<JournalPage> => api.journal(journalQuery(filter, pageParam)),
    initialPageParam: null as number | null,
    getNextPageParam: (page: JournalPage) => page.next,
    staleTime: 60_000,
    placeholderData: keepPreviousData,
  });
  // A reconnect may have missed `journal` messages: read the list again.
  const { refetch } = q;
  useEffect(() => {
    if (helloSeq >= 2) void refetch();
  }, [helloSeq, refetch]);

  const pages = q.data?.pages ?? [];
  const rows = useMemo(() => mergeJournal(pages, live?.trades ?? null, filter), [pages, live, filter]);
  const first = pages[0];
  // The newer of the page's word and the socket's on the journal's status.
  const status = live !== null && (first === undefined || live.serverTime >= first.serverTime) ? { status: live.status, reason: live.reason } : first === undefined ? null : { status: first.status, reason: first.reason };
  const total = first === undefined ? rows.length : Math.max(first.total, rows.length);
  const coins = useMemo(() => {
    const ids = new Set<string>(instruments.map((i) => i.instId));
    for (const r of rows) ids.add(r.instId);
    if (filter.instId !== null) ids.add(filter.instId);
    return [...ids].sort();
  }, [instruments, rows, filter.instId]);
  const instOf = (instId: string): Instrument | undefined => instruments.find((i) => i.instId === instId);
  const opened = openId === null ? undefined : (rows.find((r) => r.id === openId) ?? Object.values(live?.trades ?? {}).find((r) => r.id === openId));

  const filters = (
    <div className="jr-toolbar">
      <label>
        {t.journal.filterCoin}{' '}
        <select value={filter.instId ?? ''} onChange={(e) => setFilter((f) => ({ ...f, instId: e.target.value === '' ? null : e.target.value }))}>
          <option value="">{t.journal.all}</option>
          {coins.map((id) => (
            <option key={id} value={id}>
              {coinOf(id)}
            </option>
          ))}
        </select>
      </label>
      <label>
        {t.journal.filterSource}{' '}
        <select value={filter.source ?? ''} onChange={(e) => setFilter((f) => ({ ...f, source: e.target.value === '' ? null : (e.target.value as TradeSource) }))}>
          <option value="">{t.journal.all}</option>
          {TRADE_SOURCES.map((s) => (
            <option key={s} value={s}>
              {t.journal.source[s]}
            </option>
          ))}
        </select>
      </label>
      <label>
        {t.journal.filterStatus}{' '}
        <select value={filter.status ?? ''} onChange={(e) => setFilter((f) => ({ ...f, status: e.target.value === '' ? null : (e.target.value as TradeStatus) }))}>
          <option value="">{t.journal.all}</option>
          {STATUSES.map((s) => (
            <option key={s} value={s}>
              {t.journal.tradeStatus[s]}
            </option>
          ))}
        </select>
      </label>
      <button className="btn btn-sm" onClick={() => void q.refetch()} disabled={q.isFetching}>
        {t.common.refresh}
      </button>
      {first !== undefined && <span className="dim">{t.journal.shown(rows.length, total)}</span>}
      {status !== null && status.status !== 'ready' && (
        <span className={`jr-status-note ${status.status === 'blocked' ? 'neg' : 'warn'}`}>
          {t.journal.status[status.status]}
          {status.reason !== null && `: ${t.journal.statusReason[status.reason.code] ?? status.reason.message}`}
        </span>
      )}
    </div>
  );

  if (q.data === undefined) {
    return (
      <div className="jr">
        {filters}
        <div className="empty">{q.isError ? <LoadFailed what={t.journal.what} busy={q.isFetching} onRetry={() => void q.refetch()} /> : t.journal.loading}</div>
      </div>
    );
  }

  return (
    <div className="jr">
      {filters}
      {q.isError && (
        <div className="jr-note">
          <LoadFailed what={t.journal.what} busy={q.isFetching} onRetry={() => void q.refetch()} />
        </div>
      )}
      {rows.length === 0 ? (
        <div className="empty">{filter.instId === null && filter.source === null && filter.status === null ? t.journal.empty : t.journal.emptyFiltered}</div>
      ) : (
        <div className="jr-scroll">
          <table className="table jr-table jr-list">
            <thead>
              <tr>
                <th className="left jr-sticky">
                  {t.journal.col.opened}
                  <span className="sub">{t.journal.col.localUtc}</span>
                </th>
                <th className="left">
                  {t.journal.col.coin}
                  <span className="sub">{t.journal.col.side}</span>
                </th>
                <th className="left">{t.journal.col.source}</th>
                <th title={t.journal.sizeTitle}>
                  {t.journal.col.entry}
                  <span className="sub">{t.journal.col.size}</span>
                </th>
                <th>
                  {t.journal.col.notional}
                  <span className="sub">{t.journal.col.leverage}</span>
                </th>
                <th>{t.journal.col.stop}</th>
                <th>
                  {t.journal.col.tps}
                  <span className="sub">{t.journal.col.trailing}</span>
                </th>
                <th className="left">
                  {t.journal.col.status}
                  <span className="sub">{t.journal.col.exitAndReason}</span>
                </th>
                <th title={t.journal.pnlTitle}>
                  {t.journal.col.realised}
                  <span className="sub">{t.journal.col.net}</span>
                </th>
                <th title={t.journal.rTitle}>{t.journal.col.r}</th>
                <th>{t.journal.col.duration}</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((r) => {
                const inst = instOf(r.instId);
                const base = inst?.baseCcy ?? coinOf(r.instId);
                const lastLeg = r.exits[r.exits.length - 1]?.leg ?? null;
                const reason = r.closeReason === null ? null : r.closeReason === 'take_profit' && lastLeg !== null ? t.journal.exitReasonLeg(lastLeg) : labelOf(t.journal.exitReason, r.closeReason);
                const trailing = r.plan === null || r.plan.trailing === null ? DASH : trailingText(r.plan.trailing, inst, t);
                return (
                  <tr key={r.id} className={`num jr-row${openId === r.id ? ' active' : ''}`} onClick={() => setOpenId(r.id)} tabIndex={0} onKeyDown={(e) => e.key === 'Enter' && setOpenId(r.id)}>
                    <td className="left jr-sticky" data-label={t.journal.col.opened}>
                      {fmtLocalMinute(r.openedAt)}
                      <span className="sub">{fmtUtcMinute(r.openedAt)}</span>
                    </td>
                    <td className="left" data-label={`${t.journal.col.coin} / ${t.journal.col.side}`}>
                      <b>{coinOf(r.instId)}</b>
                      {r.adopted && (
                        <span className="stop-tag" title={t.journal.adoptedTitle}>
                          {t.journal.adoptedTag}
                        </span>
                      )}
                      <span className={`sub ${r.direction === 'long' ? 'pos' : 'neg'}`}>{t.enums.posSide[r.direction]}</span>
                    </td>
                    <td className="left" data-label={t.journal.col.source}>
                      <SourceBadge source={r.source} />
                    </td>
                    <td data-label={`${t.journal.col.entry} / ${t.journal.col.size}`}>
                      {fmtPx(r.entry.avgPx, inst)}
                      <span className="sub">{`${t.common.ct(fmtContracts(r.entry.contracts, inst))} · ${fmtNum(r.entry.coin, 4)} ${base}`}</span>
                    </td>
                    <td data-label={`${t.journal.col.notional} / ${t.journal.col.leverage}`}>
                      {`${fmtNum(r.entry.notional, 2)} ${r.ccy}`}
                      <span className="sub">{`${r.entry.leverage === null ? DASH : `${fmtNum(r.entry.leverage, 1)}×`} ${labelOf(t.enums.mgnMode, r.entry.mgnMode)}`}</span>
                    </td>
                    <td data-label={t.journal.col.stop}>{fmtPx(r.initialStop, inst)}</td>
                    <td data-label={`${t.journal.col.tps} / ${t.journal.col.trailing}`}>
                      <TpPlanCell trade={r} inst={inst} />
                      <span className="sub">{trailing}</span>
                    </td>
                    <td className="left" data-label={t.journal.col.status}>
                      <StatusBadge status={r.status} />
                      {r.exitPx !== null && <span className="sub">{reason === null ? fmtPx(r.exitPx, inst) : `${fmtPx(r.exitPx, inst)} · ${reason}`}</span>}
                    </td>
                    <td className={signOf(r.realisedPnl)} data-label={`${t.journal.col.realised} / ${t.journal.col.net}`}>
                      {fmtSigned(r.realisedPnl, 2)}
                      <span className={`sub ${signOf(r.netPnl)}`}>{`${fmtSigned(r.netPnl, 2)} ${r.ccy}`}</span>
                    </td>
                    <td className={signOf(r.rMultiple)} data-label={t.journal.col.r}>
                      {fmtR(r.rMultiple) === '' ? DASH : fmtR(r.rMultiple)}
                    </td>
                    <td data-label={t.journal.col.duration}>{r.durationMs === null ? t.journal.openFor(t.common.duration(now - r.openedAt)) : t.common.duration(r.durationMs)}</td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}
      {q.hasNextPage && (
        <div className="jr-more">
          <button className="btn btn-sm" onClick={() => void q.fetchNextPage()} disabled={q.isFetchingNextPage}>
            {q.isFetchingNextPage ? t.journal.loadingOlder : t.journal.loadOlder}
          </button>
        </div>
      )}
      {opened !== undefined && <TradeDrawer summary={opened} inst={instOf(opened.instId)} onClose={() => setOpenId(null)} />}
    </div>
  );
}
