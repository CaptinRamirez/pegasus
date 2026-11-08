import { useMemo, useRef, useState, type ReactNode } from 'react';
import { BOOK_KEYS, type BookEvent, type BookKey, type BooksView, type BookView } from '@pegasus/shared';
import { useBooks } from '../hooks/useBooks';
import { useLineChart, type LineChartSeries } from '../hooks/useLineChart';
import { labelOf, useT } from '../i18n';
import { DASH, fmtLocalMinute, fmtNum, fmtSigned, fmtUtcMinute, signOf } from '../lib/format';
import { Countdown } from './campaign/CampaignSummary';
import { LoadFailed } from './LoadFailed';

/** One line colour per book, in this order (blue, orange, violet, yellow, magenta, teal): checked for colour-blind separation as a set; the legend names each line. */
export const BOOK_COLOR: Record<BookKey, string> = { regime: '#2a78d6', hold: '#eb6834', carryPos: '#6250d6', carryNeg: '#eda100', dipLong: '#e87ba4', ladder: '#139a8c' };

const when = (ts: number): string => `${fmtLocalMinute(ts)} · ${fmtUtcMinute(ts)}`;

function Signed({ v, dp = 2, unit = '' }: { v: string | null; dp?: number; unit?: string }) {
  if (v === null) return <>{DASH}</>;
  const s = signOf(v);
  return (
    <span className={s === 'pos' ? 'pos' : s === 'neg' ? 'neg' : ''}>
      {fmtSigned(v, dp)}
      {unit}
    </span>
  );
}

function Field({ k, children }: { k: string; children: ReactNode }) {
  return (
    <div className="campaign-field">
      <span className="k">{k}</span>
      <span className="v num">{children}</span>
    </div>
  );
}

function BookCard({ book }: { book: BookView }) {
  const t = useT();
  return (
    <section className="campaign-card books-card">
      <h4>
        <span className="campaign-swatch" style={{ borderTopColor: BOOK_COLOR[book.key] }} /> {labelOf(t.books.name, book.key)}
      </h4>
      <div className="campaign-note dim">{labelOf(t.books.rule, book.key)}</div>
      <Field k={t.books.equity}>{book.equity === null ? DASH : fmtNum(book.equity, 2)} USDT</Field>
      <Field k={t.books.ret}>
        <Signed v={book.returnPct} unit="%" />
      </Field>
      <Field k={t.books.maxDd}>{book.maxDrawdownPct === null ? DASH : `${fmtNum(book.maxDrawdownPct, 2)}%`}</Field>
      <Field k={t.books.positions}>{book.positions.length === 0 ? t.books.noPositions : book.positions.map((p) => p.coin).join(', ')}</Field>
      <Field k={t.books.started}>{when(book.startedAt)}</Field>
    </section>
  );
}

function Curves({ books }: { books: BookView[] }) {
  const t = useT();
  const series = useMemo<LineChartSeries[]>(() => books.map((b) => ({ id: b.key, color: BOOK_COLOR[b.key], dashed: false, points: b.curve.map(([ts, value]) => ({ ts, value })) })), [books]);
  const [hoverTs, setHoverTs] = useState<number | null>(null);
  const container = useRef<HTMLDivElement | null>(null);
  useLineChart(container, series, setHoverTs);
  const at = (b: BookView): string | null => {
    if (b.curve.length === 0) return null;
    if (hoverTs === null) return b.equity;
    let v: string | null = null;
    for (const [ts, x] of b.curve) if (ts <= hoverTs) v = x;
    return v;
  };
  return (
    <section className="campaign-section campaign-chart">
      <h4>{t.books.curve}</h4>
      <div className="campaign-legend">
        <span className="campaign-legend-time num dim">{hoverTs === null ? t.campaign.latest : fmtUtcMinute(hoverTs)}</span>
        {books.map((b) => {
          const v = at(b);
          return (
            <span key={b.key} className="campaign-legend-item">
              <span className="campaign-swatch" style={{ borderTopColor: BOOK_COLOR[b.key] }} />
              <span className="campaign-legend-label">{labelOf(t.books.name, b.key)}</span> <b className="num">{v === null ? DASH : fmtNum(v, 2)}</b>
            </span>
          );
        })}
      </div>
      <div className="campaign-chart-wrap">
        <div ref={container} />
      </div>
    </section>
  );
}

function Positions({ books }: { books: BookView[] }) {
  const t = useT();
  const rows = books.flatMap((b) => b.positions.map((p) => ({ b, p })));
  return (
    <section className="campaign-section">
      <h4>{t.books.positions}</h4>
      {rows.length === 0 ? (
        <div className="campaign-note dim">{t.books.noPositions}</div>
      ) : (
        <table className="table campaign-table">
          <thead>
            <tr>
              <th>{t.books.book}</th>
              <th>{t.books.coin}</th>
              <th>{t.books.legs}</th>
              <th className="num">{t.books.value}</th>
              <th className="num">{t.books.funding}</th>
              <th className="num">{t.books.interest}</th>
              <th className="num">{t.books.fees}</th>
              <th>{t.books.opened}</th>
            </tr>
          </thead>
          <tbody>
            {rows.map(({ b, p }) => (
              <tr key={`${b.key}-${p.coin}-${p.openedAt}`}>
                <td>{labelOf(t.books.name, b.key)}</td>
                <td>{p.coin}</td>
                <td className="num">
                  {p.legs.map((l) => (
                    <div key={l.instId}>
                      {l.instId} {fmtSigned(l.qty, 4)} @ {l.entryPx}
                    </div>
                  ))}
                </td>
                <td className="num">
                  <Signed v={p.value} />
                </td>
                <td className="num">
                  <Signed v={p.funding} />
                </td>
                <td className="num">{fmtNum(p.interest, 2)}</td>
                <td className="num">{fmtNum(p.fees, 2)}</td>
                <td className="num">{when(p.openedAt)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </section>
  );
}

function Ledger({ books }: { books: BookView[] }) {
  const t = useT();
  const events = books.flatMap((b) => b.events.map((e) => ({ key: b.key, e }))).sort((x, y) => y.e.ts - x.e.ts).slice(0, 60);
  const amount = (e: BookEvent) => (e.amount === null ? DASH : <Signed v={e.amount} />);
  return (
    <section className="campaign-section">
      <h4>{t.books.events}</h4>
      <table className="table campaign-table">
        <tbody>
          {events.map(({ key, e }, i) => (
            <tr key={`${key}-${e.ts}-${i}`}>
              <td className="num">{when(e.ts)}</td>
              <td>{labelOf(t.books.name, key)}</td>
              <td>{labelOf(t.books.eventKind, e.kind)}</td>
              <td className="num">{amount(e)}</td>
              <td className="dim">{e.text}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </section>
  );
}

export function BooksBody({ view }: { view: BooksView }) {
  const t = useT();
  if (!view.enabled) {
    return (
      <div className="campaign campaign-disabled">
        <div className="campaign-card">
          <h4>{t.books.disabledTitle}</h4>
          <div className="campaign-note">{t.books.disabledNote}</div>
        </div>
      </div>
    );
  }
  const books = BOOK_KEYS.map((k) => view.books.find((b) => b.key === k)).filter((b): b is BookView => b !== undefined);
  return (
    <div className="campaign books">
      <div className="campaign-note">{t.books.intro}</div>
      {view.error !== null && <div className="campaign-note neg">{t.books.error(view.error)}</div>}
      {view.status === 'starting' && <div className="campaign-note dim">{t.books.starting}</div>}
      {view.regime !== null && (
        <div className="campaign-note num">
          {t.books.regimeLine(view.regime.bull, fmtNum(view.regime.close, 1), fmtNum(view.regime.sma200, 1), fmtNum(view.regime.sma50w, 1))}
          {view.nextDecisionAt !== null && (
            <span className="dim">
              {' '}
              · {t.books.nextDecision} {when(view.nextDecisionAt)} · <Countdown to={view.nextDecisionAt} />
            </span>
          )}
        </div>
      )}
      <div className="campaign-cards">
        {books.map((b) => (
          <BookCard key={b.key} book={b} />
        ))}
      </div>
      {books.length > 0 && <Curves books={books} />}
      <Positions books={books} />
      <Ledger books={books} />
    </div>
  );
}

export function BooksPanel() {
  const t = useT();
  const q = useBooks();
  if (q.data === undefined) {
    return <div className="empty">{q.isError ? <LoadFailed what={t.books.what} busy={q.isFetching} onRetry={() => void q.refetch()} /> : t.books.loading}</div>;
  }
  return <BooksBody view={q.data} />;
}
