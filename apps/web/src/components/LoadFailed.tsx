import { useT } from '../i18n';

interface Props {
  /** What could not be loaded, in the page's language, e.g. "fills" */
  what: string;
  busy: boolean;
  onRetry: () => void;
}

/** Shown where a table's REST seed failed: an empty or short table must not read as "nothing happened". */
export function LoadFailed({ what, busy, onRetry }: Props) {
  const t = useT();
  return (
    <span className="load-failed">
      {t.common.couldNotLoad(what)}
      <button className="btn btn-sm" onClick={onRetry} disabled={busy}>
        {busy ? t.common.retrying : t.common.retry}
      </button>
    </span>
  );
}
