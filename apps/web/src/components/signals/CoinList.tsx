import type { CampaignSignalRow, CampaignSignalState, Instrument } from '@pegasus/shared';
import { useT } from '../../i18n';
import { DASH, fmtPct, fmtPx, safeDecimal } from '../../lib/format';
import { coinOf } from '../../lib/signals';

export function StateBadge({ state }: { state: CampaignSignalState }) {
  const t = useT();
  return <span className={`sig-badge sig-state-${state}`}>{t.signals.state[state]}</span>;
}

interface Props {
  rows: readonly CampaignSignalRow[];
  selected: string | null;
  instruments: readonly Instrument[];
  onSelect: (instId: string) => void;
}

/** The coins of the rule, actionable first: coin, state, mark and how far the price is from the entry level. */
export function CoinList({ rows, selected, instruments, onSelect }: Props) {
  const t = useT();
  return (
    <div className="sig-list" role="listbox" aria-label={t.signals.coins}>
      <div className="sig-list-head">
        <span>{t.signals.colCoin}</span>
        <span>{t.signals.colState}</span>
        <span className="right">{t.signals.colMark}</span>
        <span className="right" title={t.signals.toEntryTitle}>
          {t.signals.colToEntry}
        </span>
      </div>
      {rows.map((row) => {
        const inst = instruments.find((i) => i.instId === row.instId);
        const distance = safeDecimal(row.entryDistancePct);
        // Distance to the entry line only means something before a signal: a signal has broken it, a held coin is past it.
        const toEntry = row.state === 'entry' ? t.signals.broken : row.state === 'holding' || row.state === 'add' || row.state === 'exit' ? DASH : distance === null ? DASH : distance.lte(0) ? t.signals.above : fmtPct(distance, 1);
        return (
          <button
            key={row.instId}
            type="button"
            role="option"
            aria-selected={row.instId === selected}
            className={`sig-coin sig-row-${row.state}${row.instId === selected ? ' active' : ''}`}
            onClick={() => onSelect(row.instId)}
          >
            <span className="sig-coin-name">{coinOf(row.instId)}</span>
            <span>
              <StateBadge state={row.state} />
            </span>
            <span className="num right">{fmtPx(row.markPx, inst)}</span>
            <span className={`num right${distance !== null && distance.lte(0) ? ' pos' : ''}`}>{toEntry}</span>
          </button>
        );
      })}
    </div>
  );
}
