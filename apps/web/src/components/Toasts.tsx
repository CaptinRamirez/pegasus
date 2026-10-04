import { useEffect } from 'react';
import { useLang, useT } from '../i18n';
import { useStore } from '../store/store';

/** Info and success toasts leave by themselves; an error stays until it is clicked away. */
const TOAST_TTL_MS = 6_000;

export function Toasts() {
  const t = useT();
  const lang = useLang();
  const toasts = useStore((s) => s.toasts);
  const dismiss = useStore((s) => s.dismissToast);

  useEffect(() => {
    const timers = toasts
      .filter((toast) => toast.kind !== 'error')
      .map((toast) => {
        const remaining = Math.max(0, TOAST_TTL_MS - (Date.now() - toast.ts));
        return setTimeout(() => dismiss(toast.id), remaining);
      });
    return () => {
      for (const timer of timers) clearTimeout(timer);
    };
  }, [toasts, dismiss]);

  if (toasts.length === 0) return null;
  return (
    <div className="toasts">
      {toasts.map((toast) => (
        <div key={toast.id} className={`toast ${toast.kind}`} onClick={() => dismiss(toast.id)} role="status" title={t.toasts.dismiss}>
          {lang === 'zh' && toast.zh !== undefined ? toast.zh : toast.message}
        </div>
      ))}
    </div>
  );
}
