import { Panel } from './Panel';
import { fmtCoin, fmtPx, fmtTime } from '../lib/format';
import { isStreamStale } from '../store/alerts';
import { getSelectedInstrument, getSelectedMarket, useStore } from '../store/store';

export function Trades() {
  const inst = useStore(getSelectedInstrument);
  const trades = useStore((s) => getSelectedMarket(s).trades);
  // Trades have no heartbeat of their own; the ticker of the same instrument moves with every trade.
  const stale = useStore((s) => isStreamStale(s, s.selectedInstId, 'ticker')) && trades.length > 0;

  return (
    <Panel title="Trades" className={`panel-trades${stale ? ' panel-stale' : ''}`} extra={stale ? <span className="stale-tag" title="Trades stopped updating; this list is not current">STALE</span> : null}>
      <div className="tape-row muted">
        <span>Time</span>
        <span>Price</span>
        <span>Size ({inst?.baseCcy ?? 'coin'})</span>
      </div>
      {trades.length === 0 && <div className="empty">No trades yet</div>}
      {trades.map((t) => (
        <div key={`${t.tradeId}`} className={`tape-row num ${t.side}`}>
          <span className="muted">{fmtTime(t.ts)}</span>
          <span className="px">{fmtPx(t.px, inst)}</span>
          <span>{fmtCoin(t.sz, inst, t.px)}</span>
        </div>
      ))}
    </Panel>
  );
}
