import type { BookMetrics, Instrument, InstrumentSignalReport, MarketStructure, OpenInterestMetrics, Side, SizingPlan } from '@pegasus/shared';
import { isSignalReportError, type SignalReportRow } from '../../lib/api';
import { DASH, coinDecimals, compactUnit, fmtBp, fmtCompact, fmtContracts, fmtNum, fmtPct, fmtPx, fmtSigned, safeDecimal } from '../../lib/format';
import { RegimeBadge, SignalBadges } from './badges';

/** Number of columns in the SignalsPanel header; the expanded details row spans them all. */
const SIGNAL_COLUMNS = 20;

/** |10-day OI change| above which the figure is coloured (fraction). */
const OI_CHANGE_HIGHLIGHT = '0.05';

interface Props {
  row: SignalReportRow;
  inst: Instrument | undefined;
  expanded: boolean;
  onToggle: () => void;
  onApply: (report: InstrumentSignalReport, side: Side) => void;
}

function entrySide(r: InstrumentSignalReport): Side | null {
  if (r.signals.longEntry) return 'buy';
  if (r.signals.shortEntry) return 'sell';
  return null;
}

function SizingCells({ sizing, inst }: { sizing: SizingPlan | null; inst: Instrument | undefined }) {
  if (sizing === null) {
    return (
      <>
        <td className="dim">{DASH}</td>
        <td className="dim">{DASH}</td>
        <td className="dim">{DASH}</td>
        <td className="dim" colSpan={3}>
          no equity
        </td>
      </>
    );
  }
  const quote = inst?.quoteCcy ?? '';
  const zero = sizing.contracts === '0';
  return (
    <>
      <td>
        <span className="pos">{fmtPx(sizing.stopLong, inst)}</span>
        <span className="sub">{fmtPx(sizing.stopShort, inst)}</span>
      </td>
      <td>{fmtPct(sizing.stopDistancePct, 2)}</td>
      <td className={zero ? 'neg' : ''}>
        {fmtContracts(sizing.contracts, inst)}
        {sizing.capped && <span className="signal-badge signal-capped">capped</span>}
      </td>
      {zero ? (
        <td className="signal-note-cell neg" colSpan={3}>
          {sizing.note}
        </td>
      ) : (
        <>
          <td>
            {fmtNum(sizing.coin, inst === undefined ? 4 : coinDecimals(inst))} {inst?.baseCcy ?? ''}
          </td>
          <td>
            {fmtNum(sizing.notional, 2)} {quote}
          </td>
          <td>
            {fmtNum(sizing.riskQuote, 2)} {quote}
          </td>
        </>
      )}
    </>
  );
}

/** Bid/ask depth in one shared K/M/B unit so the two sides read on the same scale ("1.2M / 0.9M"). */
function depthParts(book: BookMetrics): [string, string] {
  const bid = safeDecimal(book.bidNotional);
  const ask = safeDecimal(book.askNotional);
  const larger = bid !== null && ask !== null ? (bid.abs().gte(ask.abs()) ? bid : ask) : (bid ?? ask);
  const unit = compactUnit(larger);
  return [fmtCompact(book.bidNotional, unit), fmtCompact(book.askNotional, unit)];
}

const bookTitle = (book: BookMetrics): string => `Visible depth over ${book.levels} levels; execution context only, not a direction signal.`;

const fmtOiLevel = (oi: OpenInterestMetrics): string => (oi.unit === 'usd' ? fmtCompact(oi.current) : fmtNum(oi.current, 0));

/** Signed percent with one decimal; the dash for '' (unavailable). */
const fmtChange = (fraction: string): string => fmtPct(fraction, 1, true);

/** 'pos' / 'neg' when the 10-day OI change is beyond ±5%, '' otherwise (or when unavailable). */
function oiChangeTone(change10d: string): string {
  const d = safeDecimal(change10d);
  if (d === null) return '';
  if (d.gt(OI_CHANGE_HIGHLIGHT)) return 'pos';
  if (d.lt(`-${OI_CHANGE_HIGHLIGHT}`)) return 'neg';
  return '';
}

function StructureCells({ structure }: { structure: MarketStructure | null }) {
  const book = structure?.book ?? null;
  const oi = structure?.openInterest ?? null;
  return (
    <>
      {book === null ? (
        <td className="dim">n/a</td>
      ) : (
        <td title={bookTitle(book)}>
          {fmtPct(book.imbalance, 0, true)}
          <span className="sub">
            {fmtBp(book.spreadPct)} · {depthParts(book).join(' / ')}
          </span>
        </td>
      )}
      {oi === null ? (
        <td className="dim">n/a</td>
      ) : (
        <td title={`Open interest in ${oi.unit === 'usd' ? 'USD' : 'contracts'} over ${oi.points} daily points; 10-day change (1-day change)`}>
          {fmtOiLevel(oi)}
          <span className="sub">
            <span className={oiChangeTone(oi.change10d)}>{fmtChange(oi.change10d)}</span> ({fmtChange(oi.change1d)})
          </span>
        </td>
      )}
    </>
  );
}

/** One-line summary of the structure block for the expanded details row. */
function structureLine(structure: MarketStructure | null): string {
  const book = structure?.book ?? null;
  const oi = structure?.openInterest ?? null;
  const bookPart = book === null ? 'book n/a' : `book imbalance ${fmtPct(book.imbalance, 0, true)}, spread ${fmtBp(book.spreadPct)}, depth ${depthParts(book).join('/')}`;
  const oiPart =
    oi === null ? 'OI n/a' : `OI ${fmtOiLevel(oi)}, 1d ${fmtChange(oi.change1d)}, 10d ${fmtChange(oi.change10d)}, pct ${fmtNum(oi.percentile30d, 2)}`;
  return `${bookPart} · ${oiPart}`;
}

export function SignalRow({ row, inst, expanded, onToggle, onApply }: Props) {
  if (isSignalReportError(row)) {
    return (
      <tr className="num">
        <td className="left">
          <span className="chev" /> {row.instId}
        </td>
        <td className="signal-error" colSpan={SIGNAL_COLUMNS - 1}>
          {row.error.code}: {row.error.message}
        </td>
      </tr>
    );
  }
  const ind = row.indicators;
  const f = row.funding;
  const side = entrySide(row);
  const sizing = row.sizing;
  const canApply = side !== null && sizing !== null && sizing.contracts !== '0';
  const applyTitle =
    side === null ? '' : sizing === null ? 'No equity: sizing unavailable' : sizing.contracts === '0' ? sizing.note : `Fill the ticket: ${side} ${sizing.contracts} contracts @ ${ind.close}`;
  return (
    <>
      <tr className="num signal-row" onClick={onToggle} aria-expanded={expanded}>
        <td className="left">
          <span className="chev">{expanded ? '▾' : '▸'}</span> {row.instId}
        </td>
        <td className="left">
          <RegimeBadge regime={row.regime} />
        </td>
        <td>{fmtPx(ind.close, inst)}</td>
        <td>
          {fmtPx(ind.ma, inst)}
          <span className="sub">{fmtSigned(ind.maDistanceAtr, 1)} ATR</span>
        </td>
        <td>
          {fmtPx(ind.atr, inst)}
          <span className="sub">{fmtPct(ind.atrPct, 2)}</span>
        </td>
        <td>
          {fmtPx(ind.entryHigh, inst)}
          <span className="sub">{fmtPx(ind.entryLow, inst)}</span>
        </td>
        <td>
          {fmtPx(ind.exitHigh, inst)}
          <span className="sub">{fmtPx(ind.exitLow, inst)}</span>
        </td>
        <td>{fmtNum(ind.efficiencyRatio, 2)}</td>
        <td title={`${row.params.volShortPeriod}d vol ${fmtPct(ind.volShort, 1)} / ${row.params.volLongPeriod}d vol ${fmtPct(ind.volLong, 1)} (annualised)`}>
          {fmtNum(ind.volRatio, 2)}
        </td>
        <td>
          {f === null ? (
            <span className="dim">n/a</span>
          ) : (
            <>
              {fmtPct(f.avg8h, 4)}/8h
              <span className="sub">{fmtPct(f.annualized, 1)} p.a.</span>
            </>
          )}
        </td>
        <StructureCells structure={row.structure} />
        <td className="left">
          <SignalBadges signals={row.signals} />
        </td>
        <SizingCells sizing={sizing} inst={inst} />
        <td>
          {side !== null && (
            <button
              className={`btn btn-sm ${side === 'buy' ? 'btn-buy' : 'btn-sell'}`}
              disabled={!canApply}
              title={applyTitle}
              onClick={(e) => {
                e.stopPropagation();
                onApply(row, side);
              }}
            >
              Apply
            </button>
          )}
        </td>
      </tr>
      {expanded && (
        <tr className="signal-details">
          <td colSpan={SIGNAL_COLUMNS}>
            <pre className="signal-reasons">{row.signals.reasons.join('\n')}</pre>
            <div className="signal-note signal-structure">structure: {structureLine(row.structure)}</div>
            {sizing === null ? (
              <div className="signal-note dim">sizing: no equity available (sign in with a funded account or pass ?equity)</div>
            ) : (
              <div className={`signal-note${sizing.contracts === '0' ? ' neg' : ''}`}>sizing: {sizing.note}</div>
            )}
          </td>
        </tr>
      )}
    </>
  );
}
