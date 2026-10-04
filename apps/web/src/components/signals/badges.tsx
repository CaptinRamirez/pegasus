import type { Regime, TrendSignals } from '@pegasus/shared';
import { labelOf, useT } from '../../i18n';

export function RegimeBadge({ regime }: { regime: Regime }) {
  const t = useT();
  return <span className={`signal-badge regime-${regime}`}>{labelOf(t.enums.regime, regime)}</span>;
}

/** Entry/exit badges for the conditions that are true; a dim dash when nothing fires. No short entry badge while shorts are switched off. */
export function SignalBadges({ signals, allowShort = true }: { signals: TrendSignals; allowShort?: boolean }) {
  const t = useT();
  const items: { key: string; label: string; tone: string }[] = [];
  if (signals.longEntry) items.push({ key: 'le', label: t.row.longEntry, tone: 'signal-long' });
  if (signals.shortEntry && allowShort) items.push({ key: 'se', label: t.row.shortEntry, tone: 'signal-short' });
  if (signals.longExit) items.push({ key: 'lx', label: t.row.longExit, tone: 'signal-exit' });
  if (signals.shortExit) items.push({ key: 'sx', label: t.row.shortExit, tone: 'signal-exit' });
  if (items.length === 0) return <span className="dim">—</span>;
  return (
    <>
      {items.map((i) => (
        <span key={i.key} className={`signal-badge ${i.tone}`}>
          {i.label}
        </span>
      ))}
    </>
  );
}
