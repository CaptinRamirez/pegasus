import { useMemo } from 'react';
import { useMutation } from '@tanstack/react-query';
import type { Order } from '@pegasus/shared';
import { api } from '../lib/api';
import { errorMessage } from '../lib/http';
import { fmtContracts, fmtDateTime, fmtPx, fmtSigned, signOf } from '../lib/format';
import { useStore } from '../store/store';

interface Props {
  mode: 'open' | 'history';
}

export function OrdersTable({ mode }: Props) {
  const orders = useStore((s) => s.orders);
  const history = useStore((s) => s.orderHistory);
  const instruments = useStore((s) => s.instruments);
  const pushToast = useStore((s) => s.pushToast);

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

  if (rows.length === 0) return <div className="empty">{mode === 'open' ? 'No open orders' : 'No order history'}</div>;

  return (
    <table className="table">
      <thead>
        <tr>
          <th>Time</th>
          <th className="left">Instrument</th>
          <th className="left">Side</th>
          <th className="left">Type</th>
          <th>Price</th>
          <th>Size</th>
          <th>Filled</th>
          {mode === 'history' && <th>Avg px</th>}
          <th className="left">State</th>
          {mode === 'history' && <th>Fee</th>}
          {mode === 'history' && <th>PnL</th>}
          {mode === 'open' && (
            <th>
              <button className="btn btn-sm btn-danger" onClick={onCancelAll} disabled={cancelAll.isPending}>
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
              <td className="left">{o.instId}</td>
              <td className={`left ${o.side === 'buy' ? 'pos' : 'neg'}`}>
                {o.side}
                {o.posSide !== 'net' ? ` ${o.posSide}` : ''}
                {o.reduceOnly ? ' RO' : ''}
              </td>
              <td className="left">{o.ordType}</td>
              <td>{o.px === '' ? 'market' : fmtPx(o.px, inst)}</td>
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
                  <button className="btn btn-sm" onClick={() => cancel.mutate(o)} disabled={cancel.isPending}>
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
