import { Panel } from './Panel';
import { useT } from '../i18n';
import { fmtCoin, fmtPx, fmtTime } from '../lib/format';
import { isStreamStale } from '../store/alerts';
import { getSelectedInstrument, getSelectedMarket, useStore } from '../store/store';

export function Trades() {
  const t = useT();
  const inst = useStore(getSelectedInstrument);
  const trades = useStore((s) => getSelectedMarket(s).trades);
  // Trades have no heartbeat of their own; the ticker of the same instrument moves with every trade.
  const stale = useStore((s) => isStreamStale(s, s.selectedInstId, 'ticker')) && trades.length > 0;

  return (
    <Panel title={t.trades.title} className={`panel-trades${stale ? ' panel-stale' : ''}`} extra={stale ? <span className="stale-tag" title={t.trades.staleTitle}>{t.common.stale}</span> : null}>
      <div className="tape-row muted">
        <span>{t.common.time}</span>
        <span>{t.common.price}</span>
        <span>{t.book.sizeIn(inst?.baseCcy ?? t.common.coin)}</span>
      </div>
      {trades.length === 0 && <div className="empty">{t.trades.empty}</div>}
      {trades.map((tr) => (
        <div key={`${tr.tradeId}`} className={`tape-row num ${tr.side}`}>
          <span className="muted">{fmtTime(tr.ts)}</span>
          <span className="px">{fmtPx(tr.px, inst)}</span>
          <span>{fmtCoin(tr.sz, inst, tr.px)}</span>
        </div>
      ))}
    </Panel>
  );
}
