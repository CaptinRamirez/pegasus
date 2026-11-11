import { D, PLAN_KEYS, PLAN_TARGET_VOL, type BooksView, type BookView } from '@pegasus/shared';
import { useBooks } from '../hooks/useBooks';
import { useT } from '../i18n';
import { DASH, fmtNum } from '../lib/format';
import { BookCard, Curves, Field, Ledger, Positions, when } from './BooksPanel';
import { Countdown } from './campaign/CampaignSummary';
import { LoadFailed } from './LoadFailed';

/**
 * The replay behind the plan (docs/proposals/complete-strategy-2026-11.md, tables 2 and 3): 2017-09-01 to 2026-11-09 on
 * Binance spot 1H, BTC and ETH half each, fees and slippage in. Percentages; a study's record, not live data.
 */
const REPLAY = [
  { row: 'dial30', cagr: '+24.2', maxDd: '-35.0', worstYear: '-12', since2022: '+10.4', median12: '+16.5', p10: '-12.8', worst12: '-21.3' },
  { row: 'dial45', cagr: '+35.9', maxDd: '-44.8', worstYear: '-18', since2022: '+16.3', median12: '+25.0', p10: '-16.1', worst12: '-32.6' },
  { row: 'dial60', cagr: '+36.3', maxDd: '-54.3', worstYear: '-25', since2022: '+15.1', median12: '+24.0', p10: '-21.8', worst12: '-42.3' },
  { row: 'regime', cagr: '+32.8', maxDd: '-64.5', worstYear: '-48', since2022: '+15.2', median12: '+18.6', p10: '-24.3', worst12: '-51.1' },
  { row: 'hold', cagr: '+29.5', maxDd: '-86.9', worstYear: '-77', since2022: '+2.2', median12: '+21.3', p10: '-53.1', worst12: '-78.6' },
  { row: 'ladder', cagr: '+7.9', maxDd: '-57.0', worstYear: '-52', since2022: '+5.4', median12: '+7.2', p10: '-37.0', worst12: '-50.5' },
] as const;

/** A share of the book ("0.4321") as a percentage ("43%"). */
const pct = (x: string | null | undefined, dp = 0): string => (x === null || x === undefined ? DASH : `${fmtNum(D(x).mul(100), dp)}%`);

function Replay() {
  const t = useT();
  const cell = (v: string) => <td className={`num ${v.startsWith('-') ? 'neg' : 'pos'}`}>{v}%</td>;
  return (
    <section className="campaign-section">
      <h4>{t.plan.replay}</h4>
      <div className="campaign-note dim">{t.plan.replayNote}</div>
      <div className="campaign-scroll">
        <table className="table campaign-table">
          <thead>
            <tr>
              <th>{t.plan.way}</th>
              <th className="num">{t.plan.cagr}</th>
              <th className="num">{t.plan.maxDd}</th>
              <th className="num">{t.plan.worstYear}</th>
              <th className="num">{t.plan.since2022}</th>
              <th className="num">{t.plan.median12}</th>
              <th className="num">{t.plan.p10}</th>
              <th className="num">{t.plan.worst12}</th>
            </tr>
          </thead>
          <tbody>
            {REPLAY.map((r) => (
              <tr key={r.row}>
                <td>{t.plan.row[r.row]}</td>
                {cell(r.cagr)}
                {cell(r.maxDd)}
                {cell(r.worstYear)}
                {cell(r.since2022)}
                {cell(r.median12)}
                {cell(r.p10)}
                {cell(r.worst12)}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <div className="campaign-note dim">{t.plan.notInside}</div>
    </section>
  );
}

export function PlanBody({ view }: { view: BooksView }) {
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
  const books = PLAN_KEYS.map((k) => view.books.find((b) => b.key === k)).filter((b): b is BookView => b !== undefined);
  const plan = books.find((b) => b.key === 'plan');
  const r = view.regime;
  const reading = view.plan;
  // what is held now, at the market: the reading's own figure is from before the day's trades
  const value = plan?.positions.reduce((s, p) => (p.value === null ? s : s.plus(p.value)), D(0));
  const held = plan && plan.equity !== null && value && D(plan.equity).gt(0) ? value.div(plan.equity).toFixed(4) : null;
  // the close must clear the higher of the two lines
  const line = r === null ? null : D(r.sma200).gt(r.sma50w) ? r.sma200 : r.sma50w;
  const gap = r === null || line === null ? null : D(line).div(r.close).minus(1).toFixed(4);
  const today =
    r === null || line === null
      ? t.plan.todayUnknown
      : r.bull
        ? t.plan.todayBull(pct(reading?.target), pct(reading?.vol), pct(held), fmtNum(line, 1))
        : t.plan.todayNotBull(fmtNum(line, 1), pct(gap, 1), pct(reading?.targetIfBull));
  return (
    <div className="campaign books">
      <div className="campaign-note">{t.plan.intro}</div>
      {view.error !== null && <div className="campaign-note neg">{t.books.error(view.error)}</div>}
      {view.status === 'starting' && <div className="campaign-note dim">{t.books.starting}</div>}
      <div className="campaign-status-line">
        {r !== null && <span className={`campaign-badge ${r.bull ? 'campaign-status-running' : 'campaign-status-finished'}`}>{r.bull ? t.plan.bull : t.plan.notBull}</span>}
        <span className="trader-oneliner">{today}</span>
      </div>
      {view.nextDecisionAt !== null && (
        <div className="campaign-note num dim">
          {t.books.nextDecision} {when(view.nextDecisionAt)} · <Countdown to={view.nextDecisionAt} />
        </div>
      )}
      <div className="campaign-cards">
        <section className="campaign-card books-card">
          <h4>{t.plan.switchCard}</h4>
          <Field k={t.plan.close}>{r === null ? DASH : fmtNum(r.close, 1)}</Field>
          <Field k={t.plan.sma200}>{r === null ? DASH : fmtNum(r.sma200, 1)}</Field>
          <Field k={t.plan.sma50w}>{r === null ? DASH : fmtNum(r.sma50w, 1)}</Field>
          <Field k={t.plan.gap}>{pct(gap, 1)}</Field>
        </section>
        <section className="campaign-card books-card">
          <h4>{t.plan.sizeCard}</h4>
          <Field k={t.plan.dial}>{pct(PLAN_TARGET_VOL)}</Field>
          <Field k={t.plan.vol}>{pct(reading?.vol)}</Field>
          <Field k={t.plan.ifBull}>{pct(reading?.targetIfBull)}</Field>
          <Field k={t.plan.held}>{pct(held)}</Field>
        </section>
        {books.map((b) => (
          <BookCard key={b.key} book={b} />
        ))}
      </div>
      {books.length > 0 && <Curves books={books} />}
      <Positions books={books} />
      <Replay />
      <section className="campaign-section">
        <h4>{t.plan.rules}</h4>
        <ol className="campaign-notes">
          {t.plan.rule.map((text) => (
            <li key={text}>{text}</li>
          ))}
        </ol>
      </section>
      <Ledger books={books} />
    </div>
  );
}

export function PlanPanel() {
  const t = useT();
  const q = useBooks();
  if (q.data === undefined) {
    return <div className="empty">{q.isError ? <LoadFailed what={t.books.what} busy={q.isFetching} onRetry={() => void q.refetch()} /> : t.books.loading}</div>;
  }
  return <PlanBody view={q.data} />;
}
