import type { TradeSource, TradeStatus } from '@pegasus/shared';
import { useT } from '../../i18n';

/** Who opened the trade: 滚仓 / 按信号 / 手动 / 外部. */
export function SourceBadge({ source }: { source: TradeSource }) {
  const t = useT();
  return (
    <span className={`jr-badge jr-source-${source}`} title={t.journal.sourceTitle[source]}>
      {t.journal.source[source]}
    </span>
  );
}

export function StatusBadge({ status }: { status: TradeStatus }) {
  const t = useT();
  return <span className={`jr-badge jr-status-${status}`}>{t.journal.tradeStatus[status]}</span>;
}
