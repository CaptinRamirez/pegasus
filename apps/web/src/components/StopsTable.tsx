import { useState } from 'react';
import { useMutation } from '@tanstack/react-query';
import { D, algoOrderClosesPosition, type AlgoOrder } from '@pegasus/shared';
import { api } from '../lib/api';
import { errorText, labelOf, useLang, useT, type Messages } from '../i18n';
import { fmtContracts, fmtDateTime, fmtPct, fmtPx, fmtTime } from '../lib/format';
import { accountUnknown, stopsAsOf, type AccountUnknown } from '../store/alerts';
import { getTradingBlock, useStore } from '../store/store';

const unknownText = (t: Messages): Record<AccountUnknown, string> => ({
  waiting: t.common.waitingServer,
  disabled: t.stops.noKey,
  loading: t.stops.loading,
  failed: t.stops.failed,
  unloaded: t.common.accountNotLoaded,
});

/** Whether the new trigger gives the position more room to lose than the old one. */
export function loosensStop(stop: AlgoOrder, next: string): boolean {
  if (stop.slTriggerPx === '') return false;
  return stop.side === 'sell' ? D(next).lt(stop.slTriggerPx) : D(next).gt(stop.slTriggerPx);
}

/**
 * The stop-loss (and take-profit) algo orders resting at OKX: what the daily routine checks, moves to the
 * channel and cancels after an exit. The list is read over REST, so it carries the time it was read.
 */
export function StopsTable() {
  const t = useT();
  const lang = useLang();
  const list = useStore((s) => s.algoOrders);
  const positions = useStore((s) => s.positions);
  const instruments = useStore((s) => s.instruments);
  const tradingBlock = useStore(getTradingBlock);
  const unknown = useStore(accountUnknown);
  // Re-sent by the server every 5 s, which also keeps the "read at" label and its stale mark current.
  useStore((s) => s.connection);
  const pushToast = useStore((s) => s.pushToast);
  const applyAlgoOrders = useStore((s) => s.applyAlgoOrders);
  const [drafts, setDrafts] = useState<Record<string, string>>({});
  const blockedTitle = tradingBlock === null ? {} : { title: tradingBlock[lang] };

  const refresh = useMutation({
    mutationFn: () => api.algoOrders(),
    onSuccess: (r) => applyAlgoOrders(r),
    onError: (e) => pushToast('error', t.stops.readFailed(errorText(e, t))),
  });
  const move = useMutation({
    mutationFn: (v: { stop: AlgoOrder; slTriggerPx: string }) => api.amendAlgoOrder({ instId: v.stop.instId, algoId: v.stop.algoId, slTriggerPx: v.slTriggerPx }),
    onSuccess: (r) => {
      setDrafts((d) => ({ ...d, [r.algoId]: '' }));
      pushToast('success', t.stops.moved(r.instId, r.previous, r.slTriggerPx));
    },
    onError: (e) => pushToast('error', t.stops.notMoved(errorText(e, t))),
  });
  const cancel = useMutation({
    mutationFn: (stop: AlgoOrder) => api.cancelAlgoOrder({ instId: stop.instId, algoId: stop.algoId }),
    onSuccess: (r) => pushToast('info', t.stops.cancelled(r.instId, r.algoId)),
    onError: (e) => pushToast('error', t.stops.notCancelled(errorText(e, t))),
  });

  const onMove = (stop: AlgoOrder) => {
    const next = (drafts[stop.algoId] ?? '').trim();
    if (!/^\d+(\.\d+)?$/.test(next) || D(next).lte(0)) {
      pushToast('error', t.stops.newPriceInvalid);
      return;
    }
    if (loosensStop(stop, next) && !window.confirm(t.stops.confirmLoosen(stop.instId, stop.slTriggerPx, next))) return;
    move.mutate({ stop, slTriggerPx: next });
  };
  const onCancel = (stop: AlgoOrder, hasPosition: boolean) => {
    if (window.confirm(t.stops.confirmCancel(stop.instId, stop.slTriggerPx === '' ? stop.tpTriggerPx : stop.slTriggerPx, hasPosition))) cancel.mutate(stop);
  };

  const refreshButton = (
    <button className="btn btn-sm" onClick={() => refresh.mutate()} disabled={refresh.isPending}>
      {refresh.isPending ? t.stops.reading : t.common.refresh}
    </button>
  );

  if (list === null) {
    return (
      <div className="empty">
        {unknown === null ? <>{t.stops.unread} {refreshButton}</> : unknownText(t)[unknown]}
      </div>
    );
  }
  const stale = stopsAsOf(list, Date.now()) !== null;
  const readAt = (
    <>
      {t.stops.readAt} <span className={stale ? 'stale-tag' : undefined}>{fmtTime(list.ts)}</span>
      {stale ? <span className="stale-tag">{t.stops.notRefreshed}</span> : null} {refreshButton}
    </>
  );
  if (list.orders.length === 0) return <div className="empty">{t.stops.none} {readAt}</div>;

  return (
    <table className="table">
      <caption className="as-of">{t.stops.caption} {readAt}</caption>
      <thead>
        <tr>
          <th>{t.common.time}</th>
          <th className="left">{t.common.instrument}</th>
          <th className="left">{t.stops.closes}</th>
          <th title={t.stops.stopTitle}>{t.common.stop}</th>
          <th title={t.stops.execTitle}>{t.stops.exec}</th>
          <th>{t.common.size}</th>
          <th title={t.stops.tpTitle}>{t.stops.tp}</th>
          <th className="left">{t.stops.newStop}</th>
          <th />
        </tr>
      </thead>
      <tbody>
        {list.orders.map((a) => {
          const inst = instruments.find((i) => i.instId === a.instId);
          const hasPosition = positions.some((p) => algoOrderClosesPosition(a, p));
          const draft = drafts[a.algoId] ?? '';
          return (
            <tr key={a.algoId} className="num">
              <td className="left muted">{fmtDateTime(a.cTime)}</td>
              <td className="left">
                {a.instId}
                {inst === undefined && (
                  <span className="untracked-tag" title={t.common.untrackedTitle}>
                    {t.common.untracked}
                  </span>
                )}
              </td>
              <td className={`left ${a.side === 'sell' ? 'pos' : 'neg'}`}>
                {a.side === 'sell' ? t.enums.posSide.long : t.enums.posSide.short} <span className="dim">{labelOf(t.enums.mgnMode, a.tdMode)}</span>
                {!hasPosition && (
                  <span className="stop-tag" title={t.stops.noPositionTitle}>
                    {t.stops.noPosition}
                  </span>
                )}
              </td>
              <td>
                {a.ordType === 'move_order_stop' ? (
                  <span className="stop-kind">{t.exits.callbackShort(fmtPct(a.callbackRatio ?? '', 2), a.moveTriggerPx === undefined || a.moveTriggerPx === '' ? '' : fmtPx(a.moveTriggerPx, inst))}</span>
                ) : a.slTriggerPx === '' ? (
                  '–'
                ) : (
                  fmtPx(a.slTriggerPx, inst)
                )}
                {a.slTriggerPx !== '' && <span className="dim"> {labelOf(t.enums.triggerPx, a.slTriggerPxType)}</span>}
              </td>
              <td>{a.slTriggerPx === '' ? '–' : a.slOrdPx === '-1' ? t.common.market : fmtPx(a.slOrdPx, inst)}</td>
              <td>{a.closeFraction !== '' ? (D(a.closeFraction).eq(1) ? t.stops.wholePosition : t.stops.pctOfPosition(D(a.closeFraction).times(100).toFixed())) : fmtContracts(a.sz, inst)}</td>
              <td>{a.tpTriggerPx === '' ? '–' : fmtPx(a.tpTriggerPx, inst)}</td>
              <td className="left">
                {a.slTriggerPx !== '' && (
                  <span className="input-group stop-move">
                    <input
                      aria-label={t.stops.newStopAria(a.instId, a.algoId)}
                      inputMode="decimal"
                      placeholder={t.stops.pricePlaceholder}
                      value={draft}
                      onChange={(e) => setDrafts((d) => ({ ...d, [a.algoId]: e.target.value }))}
                      onKeyDown={(e) => {
                        if (e.key === 'Enter') onMove(a);
                      }}
                    />
                    <button className="btn btn-sm" onClick={() => onMove(a)} disabled={draft.trim() === '' || move.isPending || tradingBlock !== null} {...blockedTitle}>
                      {t.stops.move}
                    </button>
                  </span>
                )}
              </td>
              <td>
                <button className="btn btn-sm btn-danger" onClick={() => onCancel(a, hasPosition)} disabled={cancel.isPending || tradingBlock !== null} {...blockedTitle}>
                  {t.common.cancel}
                </button>
              </td>
            </tr>
          );
        })}
      </tbody>
    </table>
  );
}
