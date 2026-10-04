import { Panel } from './Panel';
import { labelOf, useT } from '../i18n';
import { fmtPct, fmtPx, pctChange, signOf } from '../lib/format';
import { isStreamStale } from '../store/alerts';
import { useStore } from '../store/store';

export function InstrumentList() {
  const t = useT();
  const instruments = useStore((s) => s.instruments);
  const market = useStore((s) => s.market);
  const connection = useStore((s) => s.connection);
  const selected = useStore((s) => s.selectedInstId);
  const select = useStore((s) => s.selectInstrument);

  return (
    <Panel title={t.instruments.title} className="panel-instruments">
      {instruments.length === 0 && <div className="empty">{t.common.waitingServer}</div>}
      {instruments.map((inst) => {
        const ticker = market[inst.instId]?.ticker ?? null;
        const change = ticker === null ? null : pctChange(ticker.last, ticker.open24h);
        const stale = ticker !== null && isStreamStale({ connection }, inst.instId, 'ticker');
        return (
          <div
            key={inst.instId}
            className={`inst-row${inst.instId === selected ? ' active' : ''}${stale ? ' stale' : ''}`}
            {...(stale ? { title: t.common.priceStopped } : {})}
            onClick={() => select(inst.instId)}
            role="button"
          >
            <span className="name">
              {inst.instId}
              {inst.state !== 'live' && <span className="warn"> {labelOf(t.enums.instState, inst.state)}</span>}
            </span>
            <span className="num">{fmtPx(ticker?.last, inst)}</span>
            <span className={`num ${signOf(change)}`}>{fmtPct(change, 2, true)}</span>
          </div>
        );
      })}
    </Panel>
  );
}
