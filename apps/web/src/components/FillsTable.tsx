import { useQuery } from '@tanstack/react-query';
import { FILLS_QUERY } from '../hooks/useSession';
import { useT } from '../i18n';
import { fmtContracts, fmtDateTime, fmtPx, fmtSigned } from '../lib/format';
import { useStore } from '../store/store';
import { LoadFailed } from './LoadFailed';

export function FillsTable() {
  const t = useT();
  const fills = useStore((s) => s.fills);
  const instruments = useStore((s) => s.instruments);
  // The seed of this table; live pushes alone would leave it empty or partial without saying so.
  const seed = useQuery(FILLS_QUERY);
  const retry = () => void seed.refetch();
  if (fills.length === 0) return <div className="empty">{seed.isError ? <LoadFailed what={t.fills.what} busy={seed.isFetching} onRetry={retry} /> : t.fills.empty}</div>;
  return (
    <table className="table">
      {seed.isError && (
        <caption className="as-of">
          <LoadFailed what={t.fills.whatEarlier} busy={seed.isFetching} onRetry={retry} />
        </caption>
      )}
      <thead>
        <tr>
          <th>{t.common.time}</th>
          <th className="left">{t.common.instrument}</th>
          <th className="left">{t.common.side}</th>
          <th>{t.common.price}</th>
          <th>{t.common.size}</th>
          <th>{t.common.fee}</th>
          <th className="left">{t.fills.exec}</th>
          <th className="left">{t.fills.order}</th>
        </tr>
      </thead>
      <tbody>
        {fills.map((f) => {
          const inst = instruments.find((i) => i.instId === f.instId);
          return (
            <tr key={`${f.ordId}:${f.tradeId}`} className="num">
              <td className="left muted">{fmtDateTime(f.ts)}</td>
              <td className="left">
                {f.instId}
                {inst === undefined && (
                  <span className="untracked-tag" title={t.common.untrackedTitle}>
                    {t.common.untracked}
                  </span>
                )}
              </td>
              <td className={`left ${f.side === 'buy' ? 'pos' : 'neg'}`}>
                {t.enums.side[f.side]}
                {f.posSide !== 'net' ? ` ${t.enums.posSide[f.posSide]}` : ''}
              </td>
              <td>{fmtPx(f.fillPx, inst)}</td>
              <td>{fmtContracts(f.fillSz, inst)}</td>
              <td>
                {fmtSigned(f.fee, 4)} {f.feeCcy}
              </td>
              <td className="left">{f.execType === '' ? '–' : t.enums.exec[f.execType]}</td>
              <td className="left dim">{f.ordId}</td>
            </tr>
          );
        })}
      </tbody>
    </table>
  );
}
