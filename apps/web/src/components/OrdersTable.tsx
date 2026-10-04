import { useMemo } from 'react';
import { useMutation, useQuery } from '@tanstack/react-query';
import { stopAwaitsFullFill, type Order } from '@pegasus/shared';
import { api } from '../lib/api';
import { ORDER_HISTORY_QUERY } from '../hooks/useSession';
import { errorText, labelOf, useLang, useT, type Messages } from '../i18n';
import { fmtContracts, fmtDateTime, fmtPx, fmtSigned, signOf } from '../lib/format';
import { accountUnknown, type AccountUnknown } from '../store/alerts';
import { getTradingBlock, useStore } from '../store/store';
import { LoadFailed } from './LoadFailed';

const unknownText = (t: Messages): Record<AccountUnknown, string> => ({
  waiting: t.common.waitingServer,
  disabled: t.orders.noKey,
  loading: t.orders.loading,
  failed: t.orders.failed,
  unloaded: t.common.accountNotLoaded,
});

interface Props {
  mode: 'open' | 'history';
}

export function OrdersTable({ mode }: Props) {
  const t = useT();
  const lang = useLang();
  const orders = useStore((s) => s.orders);
  const history = useStore((s) => s.orderHistory);
  const instruments = useStore((s) => s.instruments);
  const tradingBlock = useStore(getTradingBlock);
  const unknown = useStore(accountUnknown);
  const pushToast = useStore((s) => s.pushToast);
  const blockedTitle = tradingBlock === null ? {} : { title: tradingBlock[lang] };
  // The seed of the history; live pushes alone would leave it empty or partial without saying so.
  const seed = useQuery({ ...ORDER_HISTORY_QUERY, enabled: mode === 'history' });
  const seedFailed = mode === 'history' && seed.isError;
  const retry = () => void seed.refetch();

  const rows = useMemo<Order[]>(
    () => (mode === 'open' ? Object.values(orders).sort((a, b) => b.cTime - a.cTime) : history),
    [mode, orders, history],
  );

  const cancel = useMutation({
    mutationFn: (o: Order) => api.cancelOrder({ instId: o.instId, ordId: o.ordId }),
    onSuccess: (r) => pushToast('info', t.orders.cancelRequested(r.ordId)),
    onError: (e) => pushToast('error', t.orders.cancelFailed(errorText(e, t))),
  });
  const cancelAll = useMutation({
    mutationFn: () => api.cancelAll({}),
    onSuccess: (r) => pushToast('info', t.orders.canceledN(r.canceled)),
    onError: (e) => pushToast('error', t.orders.cancelAllFailed(errorText(e, t))),
  });

  const onCancelAll = () => {
    if (window.confirm(t.orders.confirmCancelAll(rows.length))) cancelAll.mutate();
  };

  if (rows.length === 0) {
    if (mode === 'open') return <div className="empty">{unknown === null ? t.orders.empty : unknownText(t)[unknown]}</div>;
    return <div className="empty">{seedFailed ? <LoadFailed what={t.orders.whatHistory} busy={seed.isFetching} onRetry={retry} /> : t.orders.emptyHistory}</div>;
  }

  return (
    <table className="table">
      {seedFailed && (
        <caption className="as-of">
          <LoadFailed what={t.orders.whatEarlier} busy={seed.isFetching} onRetry={retry} />
        </caption>
      )}
      <thead>
        <tr>
          <th>{t.common.time}</th>
          <th className="left">{t.common.instrument}</th>
          <th className="left">{t.common.side}</th>
          <th className="left">{t.orders.type}</th>
          <th>{t.common.price}</th>
          {mode === 'open' && <th title={t.orders.stopTitle}>{t.common.stop}</th>}
          <th>{t.common.size}</th>
          <th>{t.orders.filled}</th>
          {mode === 'history' && <th>{t.orders.avgPx}</th>}
          <th className="left">{t.orders.state}</th>
          {mode === 'history' && <th>{t.common.fee}</th>}
          {mode === 'history' && <th>{t.orders.pnl}</th>}
          {mode === 'open' && (
            <th>
              <button className="btn btn-sm btn-danger" onClick={onCancelAll} disabled={cancelAll.isPending || tradingBlock !== null} {...blockedTitle}>
                {t.orders.cancelAll}
              </button>
            </th>
          )}
        </tr>
      </thead>
      <tbody>
        {rows.map((o) => {
          const inst = instruments.find((i) => i.instId === o.instId);
          return (
            <tr key={o.ordId} className="num">
              <td className="left muted">{fmtDateTime(mode === 'open' ? o.cTime : o.uTime)}</td>
              <td className="left">
                {o.instId}
                {inst === undefined && (
                  <span className="untracked-tag" title={t.common.untrackedTitle}>
                    {t.common.untracked}
                  </span>
                )}
              </td>
              <td className={`left ${o.side === 'buy' ? 'pos' : 'neg'}`}>
                {t.enums.side[o.side]}
                {o.posSide !== 'net' ? ` ${t.enums.posSide[o.posSide]}` : ''}
                {o.reduceOnly ? ` ${t.orders.reduceOnlyTag}` : ''}
              </td>
              <td className="left">{labelOf(t.enums.ordType, o.ordType)}</td>
              <td>{o.px === '' ? t.common.market : fmtPx(o.px, inst)}</td>
              {mode === 'open' && (
                <td>
                  {o.slTriggerPx === undefined ? '–' : fmtPx(o.slTriggerPx, inst)}
                  {stopAwaitsFullFill(o) && (
                    <span className="untracked-tag" title={t.orders.stopNotActiveTitle}>
                      {t.orders.notActive}
                    </span>
                  )}
                </td>
              )}
              <td>{fmtContracts(o.sz, inst)}</td>
              <td>{fmtContracts(o.accFillSz, inst)}</td>
              {mode === 'history' && <td>{o.avgPx === '' ? '–' : fmtPx(o.avgPx, inst)}</td>}
              <td className="left">{labelOf(t.enums.orderState, o.state)}</td>
              {mode === 'history' && (
                <td>
                  {fmtSigned(o.fee, 4)} {o.feeCcy}
                </td>
              )}
              {mode === 'history' && <td className={signOf(o.pnl)}>{fmtSigned(o.pnl, 4)}</td>}
              {mode === 'open' && (
                <td>
                  <button className="btn btn-sm" onClick={() => cancel.mutate(o)} disabled={cancel.isPending || tradingBlock !== null} {...blockedTitle}>
                    {t.common.cancel}
                  </button>
                </td>
              )}
            </tr>
          );
        })}
      </tbody>
    </table>
  );
}
