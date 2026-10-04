import { useMutation } from '@tanstack/react-query';
import { D, type ClosePositionRequest, type Position } from '@pegasus/shared';
import { api } from '../lib/api';
import { errorMessage } from '../lib/http';
import { UNTRACKED_TITLE, fmtCoin, fmtContracts, fmtNum, fmtPct, fmtPx, fmtSigned, fmtTime, signOf } from '../lib/format';
import { accountAsOf, accountUnknown, trimAdvice, trimShares, type AccountUnknown } from '../store/alerts';
import { blockTitle, getTradingBlock, useStore } from '../store/store';

const UNKNOWN_TEXT: Record<AccountUnknown, string> = {
  waiting: 'Waiting for server…',
  disabled: 'No API key configured: positions are not shown',
  loading: 'Loading positions…',
  failed: 'Positions not loaded (see the warning above)',
  unloaded: 'Account not loaded',
};

function sideOf(p: Position): 'long' | 'short' | 'flat' {
  if (p.posSide === 'long' || p.posSide === 'short') return p.posSide;
  const d = D(p.pos);
  return d.gt(0) ? 'long' : d.lt(0) ? 'short' : 'flat';
}

export function PositionsTable() {
  const positions = useStore((s) => s.positions);
  const instruments = useStore((s) => s.instruments);
  const posMode = useStore((s) => s.account?.posMode ?? null);
  // Instruments whose position has outgrown the per-instrument limit: shown on the row, nothing is blocked.
  const overLimit = useStore((s) => s.risk?.overLimit);
  const tradingBlock = useStore(getTradingBlock);
  // Re-sent by the server every 5 s, which also keeps the "as of" label current.
  const connection = useStore((s) => s.connection);
  const pushToast = useStore((s) => s.pushToast);
  const unknown = useStore(accountUnknown);
  const asOf = accountAsOf(connection, Date.now());

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
  const asOfTag = asOf === null ? null : <span className="stale-tag">as of {fmtTime(asOf)}</span>;
  // An empty list only means a flat account once the positions were actually loaded.
  if (open.length === 0) return <div className="empty">{unknown === null ? <>No open positions {asOfTag}</> : UNKNOWN_TEXT[unknown]}</div>;

  return (
    <table className="table">
      {asOfTag !== null && <caption className="as-of">Positions {asOfTag}</caption>}
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
          const over = overLimit?.find((o) => o.instId === p.instId);
          // Both legs of long/short mode are marked, but the trim is shown once: on the larger leg (and on the
          // other only for what the larger cannot cover), so that following every row closes the excess once.
          const share = over === undefined ? undefined : trimShares(open, over).get(p);
          const trim = over === undefined || share === undefined ? null : trimAdvice(p, { ...over, excess: share.toFixed() }, inst);
          return (
            <tr key={`${p.instId}:${p.posSide}:${p.mgnMode}`} className={over === undefined ? 'num' : 'num over-limit'}>
              <td className="left">
                {p.instId}
                {inst === undefined && (
                  <span className="untracked-tag" title={UNTRACKED_TITLE}>
                    untracked
                  </span>
                )}
              </td>
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
              <td>
                {fmtNum(p.notionalUsd, 0)}
                {over !== undefined && trim !== null && (
                  <span
                    className="over-limit-tag"
                    title={`${p.instId} position notional ${fmtNum(over.notional, 0)} USD is over the per-instrument limit ${fmtNum(over.limit, 0)} USD: trim it back to the limit`}
                  >
                    over limit: trim {fmtNum(trim.quote, 0)} USD{trim.contracts !== null ? ` (${fmtContracts(trim.contracts, inst)} ct)` : ''}
                  </span>
                )}
              </td>
              <td>
                <button
                  className="btn btn-sm btn-danger"
                  onClick={() => onClose(p)}
                  disabled={close.isPending || tradingBlock !== null}
                  {...(tradingBlock === null ? {} : { title: blockTitle(tradingBlock) })}
                >
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
