import { Panel } from './Panel';
import { fmtCoin, fmtPx, fmtTime } from '../lib/format';
import { getSelectedInstrument, getSelectedMarket, useStore } from '../store/store';

export function Trades() {
  const inst = useStore(getSelectedInstrument);
  const trades = useStore((s) => getSelectedMarket(s).trades);

  return (
    <Panel title="Trades" className="panel-trades">
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
