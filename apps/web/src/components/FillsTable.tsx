import { fmtContracts, fmtDateTime, fmtPx, fmtSigned } from '../lib/format';
import { useStore } from '../store/store';

export function FillsTable() {
  const fills = useStore((s) => s.fills);
  const instruments = useStore((s) => s.instruments);
  if (fills.length === 0) return <div className="empty">No fills</div>;
  return (
    <table className="table">
      <thead>
        <tr>
          <th>Time</th>
          <th className="left">Instrument</th>
          <th className="left">Side</th>
          <th>Price</th>
          <th>Size</th>
          <th>Fee</th>
          <th className="left">Exec</th>
          <th className="left">Order</th>
        </tr>
      </thead>
      <tbody>
        {fills.map((f) => {
          const inst = instruments.find((i) => i.instId === f.instId);
          return (
            <tr key={`${f.ordId}:${f.tradeId}`} className="num">
              <td className="left muted">{fmtDateTime(f.ts)}</td>
              <td className="left">{f.instId}</td>
              <td className={`left ${f.side === 'buy' ? 'pos' : 'neg'}`}>
                {f.side}
                {f.posSide !== 'net' ? ` ${f.posSide}` : ''}
              </td>
              <td>{fmtPx(f.fillPx, inst)}</td>
              <td>{fmtContracts(f.fillSz, inst)}</td>
              <td>
                {fmtSigned(f.fee, 4)} {f.feeCcy}
              </td>
              <td className="left">{f.execType === 'T' ? 'taker' : f.execType === 'M' ? 'maker' : '–'}</td>
              <td className="left dim">{f.ordId}</td>
            </tr>
          );
        })}
      </tbody>
    </table>
  );
}
