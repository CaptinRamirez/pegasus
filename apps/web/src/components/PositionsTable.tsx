import { useMutation } from '@tanstack/react-query';
import { D, type ClosePositionRequest, type Position } from '@pegasus/shared';
import { api } from '../lib/api';
import { errorMessage } from '../lib/http';
import { fmtCoin, fmtContracts, fmtNum, fmtPct, fmtPx, fmtSigned, signOf } from '../lib/format';
import { useStore } from '../store/store';

function sideOf(p: Position): 'long' | 'short' | 'flat' {
  if (p.posSide === 'long' || p.posSide === 'short') return p.posSide;
  const d = D(p.pos);
  return d.gt(0) ? 'long' : d.lt(0) ? 'short' : 'flat';
}

export function PositionsTable() {
  const positions = useStore((s) => s.positions);
  const instruments = useStore((s) => s.instruments);
  const posMode = useStore((s) => s.account?.posMode ?? null);
  const pushToast = useStore((s) => s.pushToast);

  const close = useMutation({
    mutationFn: (body: ClosePositionRequest) => api.closePosition(body),
    onSuccess: (r) => pushToast('info', `Close requested for ${r.instId} ${r.posSide}`),
    onError: (e) => pushToast('error', `Close failed: ${errorMessage(e)}`),
  });

  const onClose = (p: Position) => {
    if (!window.confirm(`Close the ${sideOf(p)} position in ${p.instId} at market?`)) return;
    const body: ClosePositionRequest =
      posMode === 'long_short_mode' && (p.posSide === 'long' || p.posSide === 'short')
        ? { instId: p.instId, mgnMode: p.mgnMode, posSide: p.posSide }
        : { instId: p.instId, mgnMode: p.mgnMode };
    close.mutate(body);
  };

  const open = positions.filter((p) => !D(p.pos).isZero());
  if (open.length === 0) return <div className="empty">No open positions</div>;

  return (
    <table className="table">
      <thead>
        <tr>
          <th>Instrument</th>
          <th className="left">Side</th>
          <th>Contracts</th>
          <th>Coin</th>
          <th>Avg px</th>
          <th>Mark</th>
          <th>UPL</th>
          <th>UPL %</th>
          <th>Lever</th>
          <th>Liq px</th>
          <th>Margin</th>
          <th>Notional</th>
          <th />
        </tr>
      </thead>
      <tbody>
        {open.map((p) => {
          const inst = instruments.find((i) => i.instId === p.instId);
          const side = sideOf(p);
          const absPos = D(p.pos).abs();
          return (
            <tr key={`${p.instId}:${p.posSide}:${p.mgnMode}`} className="num">
              <td className="left">{p.instId}</td>
              <td className={`left ${side === 'long' ? 'pos' : 'neg'}`}>
                {side} <span className="dim">{p.mgnMode}</span>
              </td>
              <td>{fmtContracts(absPos, inst)}</td>
              <td>
                {fmtCoin(absPos, inst, p.markPx)} {inst?.baseCcy ?? ''}
              </td>
              <td>{fmtPx(p.avgPx, inst)}</td>
              <td>{fmtPx(p.markPx, inst)}</td>
              <td className={signOf(p.upl)}>{fmtSigned(p.upl, 2)}</td>
              <td className={signOf(p.uplRatio)}>{fmtPct(p.uplRatio, 2, true)}</td>
              <td>{p.lever}x</td>
              <td>{fmtPx(p.liqPx, inst)}</td>
              <td>{fmtNum(p.margin, 2)}</td>
              <td>{fmtNum(p.notionalUsd, 0)}</td>
              <td>
                <button className="btn btn-sm btn-danger" onClick={() => onClose(p)} disabled={close.isPending}>
                  Close
                </button>
              </td>
            </tr>
          );
        })}
      </tbody>
    </table>
  );
}
