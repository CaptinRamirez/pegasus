import { Panel } from './Panel';
import { fmtPct, fmtPx, pctChange, signOf } from '../lib/format';
import { isStreamStale } from '../store/alerts';
import { useStore } from '../store/store';

export function InstrumentList() {
  const instruments = useStore((s) => s.instruments);
  const market = useStore((s) => s.market);
  const connection = useStore((s) => s.connection);
  const selected = useStore((s) => s.selectedInstId);
  const select = useStore((s) => s.selectInstrument);

  return (
    <Panel title="Instruments" className="panel-instruments">
      {instruments.length === 0 && <div className="empty">Waiting for server…</div>}
      {instruments.map((inst) => {
        const t = market[inst.instId]?.ticker ?? null;
        const change = t === null ? null : pctChange(t.last, t.open24h);
        const stale = t !== null && isStreamStale({ connection }, inst.instId, 'ticker');
        return (
          <div
            key={inst.instId}
            className={`inst-row${inst.instId === selected ? ' active' : ''}${stale ? ' stale' : ''}`}
            {...(stale ? { title: 'Price stopped updating' } : {})}
            onClick={() => select(inst.instId)}
            role="button"
          >
            <span className="name">
              {inst.instId}
              {inst.state !== 'live' && <span className="warn"> {inst.state}</span>}
            </span>
            <span className="num">{fmtPx(t?.last, inst)}</span>
            <span className={`num ${signOf(change)}`}>{fmtPct(change, 2, true)}</span>
          </div>
        );
      })}
    </Panel>
  );
}
