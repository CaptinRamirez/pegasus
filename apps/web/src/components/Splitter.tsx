import { useRef } from 'react';
import type { KeyboardEvent, PointerEvent } from 'react';
import { clampBottomHeight } from '../lib/bottomHeight';

interface SplitterProps {
  title: string;
  /** The height the panel below was dragged to, in pixels */
  onResize: (px: number) => void;
  /** Double-click: back to the stylesheet's height */
  onReset: () => void;
}

const KEY_STEP_PX = 20;

/**
 * Horizontal divider above the panel that follows it in the column; dragging it up makes that panel taller.
 * While dragging it sets the panel's height on the element directly and reports the final height once, on release,
 * so the tables below do not re-render on every pointer move.
 */
export function Splitter({ title, onResize, onReset }: SplitterProps) {
  const drag = useRef<{ startY: number; startPx: number; columnPx: number; px: number } | null>(null);

  const elements = (el: HTMLElement) => {
    const panel = el.nextElementSibling;
    const column = el.parentElement;
    return panel instanceof HTMLElement && column !== null ? { panel, column } : null;
  };

  const onPointerDown = (e: PointerEvent<HTMLDivElement>) => {
    if (e.button !== 0) return;
    const els = elements(e.currentTarget);
    if (els === null) return;
    e.preventDefault();
    e.currentTarget.setPointerCapture(e.pointerId);
    const startPx = els.panel.getBoundingClientRect().height;
    drag.current = { startY: e.clientY, startPx, columnPx: els.column.getBoundingClientRect().height, px: startPx };
  };

  const onPointerMove = (e: PointerEvent<HTMLDivElement>) => {
    const d = drag.current;
    const els = elements(e.currentTarget);
    if (d === null || els === null) return;
    d.px = clampBottomHeight(d.startPx + d.startY - e.clientY, d.columnPx);
    els.panel.style.flex = `0 0 ${d.px}px`;
  };

  const onPointerUp = (e: PointerEvent<HTMLDivElement>) => {
    const d = drag.current;
    if (d === null) return;
    drag.current = null;
    if (e.currentTarget.hasPointerCapture(e.pointerId)) e.currentTarget.releasePointerCapture(e.pointerId);
    if (d.px !== d.startPx) onResize(d.px);
  };

  const onKeyDown = (e: KeyboardEvent<HTMLDivElement>) => {
    const step = e.key === 'ArrowUp' ? KEY_STEP_PX : e.key === 'ArrowDown' ? -KEY_STEP_PX : 0;
    const els = elements(e.currentTarget);
    if (step === 0 || els === null) return;
    e.preventDefault();
    const px = els.panel.getBoundingClientRect().height;
    onResize(clampBottomHeight(px + step, els.column.getBoundingClientRect().height));
  };

  return (
    <div
      className="splitter"
      role="separator"
      aria-orientation="horizontal"
      tabIndex={0}
      title={title}
      onPointerDown={onPointerDown}
      onPointerMove={onPointerMove}
      onPointerUp={onPointerUp}
      onPointerCancel={onPointerUp}
      onDoubleClick={onReset}
      onKeyDown={onKeyDown}
    />
  );
}
