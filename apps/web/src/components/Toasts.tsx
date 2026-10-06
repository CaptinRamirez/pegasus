import { useEffect } from 'react';
import { useLang, useT } from '../i18n';
import { tradeForLink } from '../lib/journal';
import { useStore } from '../store/store';
import type { ToastLink } from '../store/types';
import { useUi } from '../store/ui';

/** Follows a toast's link: the journal's record of the order's trade, or the coin's trades while the journal has not heard of it yet. */
export function openToastLink(link: ToastLink): void {
  const trade = tradeForLink(Object.values(useStore.getState().journal?.trades ?? {}), link);
  useUi.getState().showJournal(trade === null ? { tradeId: null, instId: link.instId } : { tradeId: trade.id, instId: null });
}

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
          {toast.link !== undefined && (
            <button
              type="button"
              className="toast-link"
              onClick={(e) => {
                e.stopPropagation();
                if (toast.link !== undefined) openToastLink(toast.link);
                dismiss(toast.id);
              }}
            >
              {t.toasts.openJournal} →
            </button>
          )}
        </div>
      ))}
    </div>
  );
}
