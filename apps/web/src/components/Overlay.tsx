import { useEffect, useRef, type ReactNode } from 'react';
import { createPortal } from 'react-dom';
import { useT } from '../i18n';

interface OverlayProps {
  title: ReactNode;
  onClose: () => void;
  children: ReactNode;
  /** Shown under the body, outside its scroll */
  footer?: ReactNode;
  className?: string;
  /** The close button's tooltip */
  closeTitle?: string;
  /** Escape and a click outside close it; false while something is being sent */
  dismissable?: boolean;
}

function useEscape(onClose: () => void, enabled: boolean): void {
  const close = useRef(onClose);
  close.current = onClose;
  useEffect(() => {
    if (!enabled) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') close.current();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [enabled]);
}

function Frame({ title, onClose, children, footer, closeTitle, dismissable }: OverlayProps) {
  const t = useT();
  return (
    <>
      <div className="overlay-head">
        <span className="overlay-title">{title}</span>
        <button type="button" className="btn btn-sm btn-ghost overlay-close" onClick={onClose} disabled={dismissable === false} title={closeTitle ?? t.common.close} aria-label={t.common.close}>
          ×
        </button>
      </div>
      <div className="overlay-body">{children}</div>
      {footer !== undefined && <div className="overlay-foot">{footer}</div>}
    </>
  );
}

/** A dialog over the whole page (a portal into the body): the confirmation sheet, the exits of a position. */
export function Modal(props: OverlayProps) {
  const dismissable = props.dismissable ?? true;
  useEscape(props.onClose, dismissable);
  const box = useRef<HTMLDivElement | null>(null);
  useEffect(() => {
    box.current?.focus();
  }, []);
  return createPortal(
    <div className="modal-backdrop" onMouseDown={(e) => dismissable && e.target === e.currentTarget && props.onClose()}>
      <div ref={box} className={`modal ${props.className ?? ''}`} role="dialog" aria-modal="true" tabIndex={-1}>
        <Frame {...props} />
      </div>
    </div>,
    document.body,
  );
}

/** A panel along the right edge of the page: the details of a journal trade. */
export function Drawer(props: OverlayProps) {
  useEscape(props.onClose, props.dismissable ?? true);
  return createPortal(
    <div className="drawer-backdrop" onMouseDown={(e) => e.target === e.currentTarget && props.onClose()}>
      <aside className={`drawer ${props.className ?? ''}`} role="dialog" aria-modal="true">
        <Frame {...props} />
      </aside>
    </div>,
    document.body,
  );
}
