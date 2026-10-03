import { useEffect } from 'react';
import { useStore } from '../store/store';

const TOAST_TTL_MS = 6_000;

export function Toasts() {
  const toasts = useStore((s) => s.toasts);
  const dismiss = useStore((s) => s.dismissToast);

  useEffect(() => {
    const timers = toasts.map((t) => {
      const remaining = Math.max(0, TOAST_TTL_MS - (Date.now() - t.ts));
      return setTimeout(() => dismiss(t.id), remaining);
    });
    return () => {
      for (const timer of timers) clearTimeout(timer);
    };
  }, [toasts, dismiss]);

  if (toasts.length === 0) return null;
  return (
    <div className="toasts">
      {toasts.map((t) => (
        <div key={t.id} className={`toast ${t.kind}`} onClick={() => dismiss(t.id)} role="status">
          {t.message}
        </div>
      ))}
    </div>
  );
}
