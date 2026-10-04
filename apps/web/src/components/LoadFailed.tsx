interface Props {
  /** What could not be loaded, e.g. "fills" */
  what: string;
  busy: boolean;
  onRetry: () => void;
}

/** Shown where a table's REST seed failed: an empty or short table must not read as "nothing happened". */
export function LoadFailed({ what, busy, onRetry }: Props) {
  return (
    <span className="load-failed">
      Could not load {what}:
      <button className="btn btn-sm" onClick={onRetry} disabled={busy}>
        {busy ? 'Retrying…' : 'Retry'}
      </button>
    </span>
  );
}
