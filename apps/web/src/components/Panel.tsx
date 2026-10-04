import type { ReactNode } from 'react';

interface PanelProps {
  title: ReactNode;
  className?: string;
  /** Rendered at the right side of the header; null renders nothing */
  extra?: ReactNode;
  pad?: boolean;
  children: ReactNode;
}

export function Panel({ title, className, extra, pad = false, children }: PanelProps) {
  return (
    <section className={`panel ${className ?? ''}`}>
      <div className="panel-head">
        <span>{title}</span>
        {extra !== undefined && extra !== null && <span className="grow right">{extra}</span>}
      </div>
      <div className={`panel-body${pad ? ' pad' : ''}`}>{children}</div>
    </section>
  );
}
