import { useMemo } from 'react';
import { useMutation, useQuery } from '@tanstack/react-query';
import { stopAwaitsFullFill, type Order } from '@pegasus/shared';
import { api } from '../lib/api';
import { errorMessage } from '../lib/http';
import { ORDER_HISTORY_QUERY } from '../hooks/useSession';
import { UNTRACKED_TITLE, fmtContracts, fmtDateTime, fmtPx, fmtSigned, signOf } from '../lib/format';
import { accountUnknown, type AccountUnknown } from '../store/alerts';
import { blockTitle, getTradingBlock, useStore } from '../store/store';
import { LoadFailed } from './LoadFailed';

const UNKNOWN_TEXT: Record<AccountUnknown, string> = {
  waiting: 'Waiting for server…',
  disabled: 'No API key configured: orders are not shown',
  loading: 'Loading orders…',
  failed: 'Orders not loaded (see the warning above)',
  unloaded: 'Account not loaded',
};

const STOP_NOT_ACTIVE_TITLE =
  'OKX creates the attached stop only when the order is completely filled. The part that has filled is a position WITHOUT a stop: let the order fill, or cancel the remainder and check on OKX that the stop of the filled part exists.';

interface Props {
  mode: 'open' | 'history';
}

export function OrdersTable({ mode }: Props) {
  const orders = useStore((s) => s.orders);
  const history = useStore((s) => s.orderHistory);
  const instruments = useStore((s) => s.instruments);
  const tradingBlock = useStore(getTradingBlock);
  const unknown = useStore(accountUnknown);
  const pushToast = useStore((s) => s.pushToast);
  const blockedTitle = tradingBlock === null ? {} : { title: blockTitle(tradingBlock) };
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
    onSuccess: (r) => pushToast('info', `Cancel requested for ${r.ordId}`),
    onError: (e) => pushToast('error', `Cancel failed: ${errorMessage(e)}`),
  });
  const cancelAll = useMutation({
    mutationFn: () => api.cancelAll({}),
    onSuccess: (r) => pushToast('info', `Canceled ${r.canceled} order(s)`),
    onError: (e) => pushToast('error', `Cancel all failed: ${errorMessage(e)}`),
  });

  const onCancelAll = () => {
    if (window.confirm(`Cancel all ${rows.length} open orders?`)) cancelAll.mutate();
  };

  if (rows.length === 0) {
    if (mode === 'open') return <div className="empty">{unknown === null ? 'No open orders' : UNKNOWN_TEXT[unknown]}</div>;
    return <div className="empty">{seedFailed ? <LoadFailed what="order history" busy={seed.isFetching} onRetry={retry} /> : 'No order history'}</div>;
  }

  return (
    <table className="table">
      {seedFailed && (
        <caption className="as-of">
          <LoadFailed what="earlier orders" busy={seed.isFetching} onRetry={retry} />
        </caption>
      )}
      <thead>
        <tr>
          <th>Time</th>
          <th className="left">Instrument</th>
          <th className="left">Side</th>
          <th className="left">Type</th>
          <th>Price</th>
          {mode === 'open' && <th title="Stop-loss attached to the order: OKX creates it only when the order is completely filled (mark trigger, market execution)">Stop</th>}
          <th>Size</th>
          <th>Filled</th>
          {mode === 'history' && <th>Avg px</th>}
          <th className="left">State</th>
          {mode === 'history' && <th>Fee</th>}
          {mode === 'history' && <th>PnL</th>}
          {mode === 'open' && (
            <th>
              <button className="btn btn-sm btn-danger" onClick={onCancelAll} disabled={cancelAll.isPending || tradingBlock !== null} {...blockedTitle}>
                Cancel all
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
                  <span className="untracked-tag" title={UNTRACKED_TITLE}>
                    untracked
                  </span>
                )}
              </td>
              <td className={`left ${o.side === 'buy' ? 'pos' : 'neg'}`}>
                {o.side}
                {o.posSide !== 'net' ? ` ${o.posSide}` : ''}
                {o.reduceOnly ? ' RO' : ''}
              </td>
              <td className="left">{o.ordType}</td>
              <td>{o.px === '' ? 'market' : fmtPx(o.px, inst)}</td>
              {mode === 'open' && (
                <td>
                  {o.slTriggerPx === undefined ? '–' : fmtPx(o.slTriggerPx, inst)}
                  {stopAwaitsFullFill(o) && (
                    <span className="untracked-tag" title={STOP_NOT_ACTIVE_TITLE}>
                      not active
                    </span>
                  )}
                </td>
              )}
              <td>{fmtContracts(o.sz, inst)}</td>
              <td>{fmtContracts(o.accFillSz, inst)}</td>
              {mode === 'history' && <td>{o.avgPx === '' ? '–' : fmtPx(o.avgPx, inst)}</td>}
              <td className="left">{o.state}</td>
              {mode === 'history' && (
                <td>
                  {fmtSigned(o.fee, 4)} {o.feeCcy}
                </td>
              )}
              {mode === 'history' && <td className={signOf(o.pnl)}>{fmtSigned(o.pnl, 4)}</td>}
              {mode === 'open' && (
                <td>
                  <button className="btn btn-sm" onClick={() => cancel.mutate(o)} disabled={cancel.isPending || tradingBlock !== null} {...blockedTitle}>
                    Cancel
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
