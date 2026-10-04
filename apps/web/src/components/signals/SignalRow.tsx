import { D, Decimal, isSignalReportError, type BookMetrics, type Instrument, type InstrumentSignalReport, type MarketStructure, type OpenInterestMetrics, type Order, type Position, type Side, type SignalPhase, type SignalReportRow, type SizingPlan } from '@pegasus/shared';
import { DASH, coinDecimals, compactUnit, fmtBp, fmtCompact, fmtContracts, fmtNum, fmtPct, fmtPx, fmtSigned, fmtTime, fmtUtcMinute, safeDecimal } from '../../lib/format';
import { RegimeBadge, SignalBadges } from './badges';

/** Number of columns in the SignalsPanel header; the expanded details row spans them all. */
const SIGNAL_COLUMNS = 20;

/** |10-day OI change| above which the figure is coloured (fraction). */
const OI_CHANGE_HIGHLIGHT = '0.05';

const DAY_MS = 86_400_000;

const IN_POSITION_TITLE = 'A position on this side is already open. Adding to an open position (pyramiding) is not part of the framework yet.';
const ENTRY_PENDING_TITLE = 'An entry order on this side is already open and not filled yet. Cancel it or let it fill before applying the signal again, or the position would be doubled.';
const OTHER_LOT_TITLE =
  "A position or an entry order on this side is already open. Each daily cut trades its own lot: apply this row only if what is open is the other cut's lot and this cut's own lot is not in yet. Pegasus does not track which lot belongs to which cut.";
const UNIT_FULL_TITLE = 'The position and the entry orders on this side already amount to the lots of all the daily cuts (one unit). Adding more (pyramiding) is not part of the framework yet.';
const OUTDATED_TITLE = 'The signals could not be refreshed, so this row may be out of date. Refresh before applying it.';
const FUNDING_UNCHECKED_TITLE = 'The funding history was unavailable, so the funding gate was skipped for this entry. Check the funding rate on OKX before acting.';
const LATEST_CUT_TITLE = 'The daily bar of this cut closed most recently: this is the row to act on now.';
const SHORTS_OFF_TITLE = 'Short entries are switched off (allowShort = false). The short exit and the stop of an open short are still shown.';

/** The daily cut as the trader names it: the UTC time its bars close at. */
export function cutLabel(phase: SignalPhase): string {
  return `${String(phase).padStart(2, '0')}:00 UTC`;
}

interface Props {
  row: SignalReportRow;
  /** This row's cut is the one that closed most recently; false when there is only one cut */
  latest: boolean;
  /** Number of daily cuts the server computes: each trades its own lot of 1/cuts of a unit */
  cuts: number;
  inst: Instrument | undefined;
  positions: Position[];
  /** Open orders of the account */
  orders: Order[];
  /** The report missed its refreshes: nothing in it may be applied */
  outdated: boolean;
  expanded: boolean;
  onToggle: () => void;
  onApply: (report: InstrumentSignalReport, side: Side) => void;
}

/** The side whose entry may be applied; a short entry does not count while shorts are switched off, whatever the report flags. */
function entrySide(r: InstrumentSignalReport): Side | null {
  if (r.signals.longEntry) return 'buy';
  if (r.signals.shortEntry && r.params.allowShort !== false) return 'sell';
  return null;
}

/** Whether the terminal's position list holds an open position on the side an entry would add to. */
function holdsSide(positions: Position[], instId: string, side: Side): boolean {
  return positions.some((p) => {
    const d = safeDecimal(p.pos);
    if (p.instId !== instId || d === null || d.isZero()) return false;
    if (p.posSide === 'net') return side === 'buy' ? d.gt(0) : d.lt(0);
    return p.posSide === (side === 'buy' ? 'long' : 'short');
  });
}

/**
 * Whether an unfilled order that would open or add to that side is resting on the instrument: the leg's own
 * orders in long/short mode, a same-side order that is not reduce-only in net mode.
 */
function entryPending(orders: Order[], instId: string, side: Side): boolean {
  return orders.some((o) => {
    if (o.instId !== instId) return false;
    if (o.posSide === 'net') return o.side === side && !o.reduceOnly;
    return o.posSide === (side === 'buy' ? 'long' : 'short');
  });
}

/** Contracts held on the side an entry would add to. */
function heldContracts(positions: Position[], instId: string, side: Side): Decimal {
  return positions.filter((p) => holdsSide([p], instId, side)).reduce((sum, p) => sum.plus(D(p.pos).abs()), D(0));
}

/** Unfilled contracts of the resting orders that would open or add to that side. */
function pendingContracts(orders: Order[], instId: string, side: Side): Decimal {
  return orders
    .filter((o) => o.side === side && entryPending([o], instId, side))
    .reduce((sum, o) => sum.plus(Decimal.max((safeDecimal(o.sz) ?? D(0)).minus(safeDecimal(o.accFillSz) ?? D(0)), 0)), D(0));
}

type PlanPair = NonNullable<InstrumentSignalReport['sizing']>;

/** Class of one side's figure: emphasised when that side has the entry signal, dimmed when the other side has it. */
function sideTone(signalled: Side | null, side: Side, zero: boolean): string {
  const tone = signalled === null ? '' : signalled === side ? 'signal-side-on' : 'dim';
  return zero ? `${tone} neg`.trim() : tone;
}

/**
 * Long plan on the main line, short plan on the sub line (the idiom of the stop column). While shorts are
 * switched off the sub line shows `shortOff` instead of a size nobody may trade.
 */
function PlanCell({ sizing, side, capped, shortOff, children }: { sizing: PlanPair; side: Side | null; capped?: boolean; shortOff: string | null; children: (plan: SizingPlan) => string }) {
  return (
    <td>
      <span className={sideTone(side, 'buy', sizing.long.contracts === '0')}>{children(sizing.long)}</span>
      {capped === true && <span className="signal-badge signal-capped">capped</span>}
      {shortOff !== null ? (
        <span className="sub dim signal-short-off" title={SHORTS_OFF_TITLE}>
          {shortOff}
        </span>
      ) : (
        <span className={`sub ${sideTone(side, 'sell', sizing.short.contracts === '0')}`.trim()}>{children(sizing.short)}</span>
      )}
    </td>
  );
}

function SizingCells({ sizing, inst, side, allowShort }: { sizing: InstrumentSignalReport['sizing']; inst: Instrument | undefined; side: Side | null; allowShort: boolean }) {
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
  const { long, short } = sizing;
  const quote = inst?.quoteCcy ?? '';
  const coin = (p: SizingPlan): string => (p.contracts === '0' ? DASH : `${fmtNum(p.coin, inst === undefined ? 4 : coinDecimals(inst))} ${inst?.baseCcy ?? ''}`);
  const money = (p: SizingPlan, v: string): string => (p.contracts === '0' ? DASH : `${fmtNum(v, 2)} ${quote}`);
  return (
    <>
      <td>
        <span className="pos">{fmtPx(long.stopLong, inst)}</span>
        <span className="sub">{fmtPx(long.stopShort, inst)}</span>
      </td>
      <td>{fmtPct(long.stopDistancePct, 2)}</td>
      <PlanCell sizing={sizing} side={side} capped={long.capped} shortOff={allowShort ? null : 'short off'}>
        {(p) => fmtContracts(p.contracts, inst)}
      </PlanCell>
      {long.contracts === '0' && (short.contracts === '0' || !allowShort) ? (
        <td className="signal-note-cell neg" colSpan={3}>
          {long.note}
        </td>
      ) : (
        <>
          <PlanCell sizing={sizing} side={side} shortOff={allowShort ? null : DASH}>
            {coin}
          </PlanCell>
          <PlanCell sizing={sizing} side={side} shortOff={allowShort ? null : DASH}>
            {(p) => money(p, p.notional)}
          </PlanCell>
          <PlanCell sizing={sizing} side={side} shortOff={allowShort ? null : DASH}>
            {(p) => money(p, p.riskQuote)}
          </PlanCell>
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

function oiTitle(oi: OpenInterestMetrics): string {
  const unit = oi.unit === 'usd' ? 'USD' : 'contracts';
  if (oi.source === 'live') return `Live open interest of this instrument in ${unit}. Its daily history is unavailable right now, so the 1-day and 10-day changes cannot be shown.`;
  return `Open interest of this instrument in ${unit}: the level is today's value so far. The changes compare completed UTC days (OKX daily history, ${oi.points} days): the last completed day against 10 days before it (against the day before it), measured in coin, so a price move alone does not count.`;
}

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
        <td title={oiTitle(oi)}>
          {fmtOiLevel(oi)}
          {oi.source === 'live' ? (
            <span className="sub warn">live · no history</span>
          ) : (
            <span className="sub">
              <span className={oiChangeTone(oi.change10d)}>{fmtChange(oi.change10d)}</span> ({fmtChange(oi.change1d)})
            </span>
          )}
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
    oi === null
      ? 'OI n/a'
      : oi.source === 'live'
        ? `OI ${fmtOiLevel(oi)} (live level; history and changes unavailable)`
        : `OI ${fmtOiLevel(oi)}, 1d ${fmtChange(oi.change1d)}, 10d ${fmtChange(oi.change10d)}, pct ${fmtNum(oi.percentile30d, 2)}`;
  return `${bookPart} · ${oiPart}`;
}

/** The cut under the instrument name, marked when it is the one that closed last. */
function CutLabel({ phase, latest }: { phase: SignalPhase; latest: boolean }) {
  return (
    <span className={`sub signal-cut${latest ? ' signal-cut-latest' : ''}`} title={latest ? LATEST_CUT_TITLE : undefined}>
      {cutLabel(phase)}
      {latest && ' · latest close'}
    </span>
  );
}

export function SignalRow({ row, latest, cuts, inst, positions, orders, outdated, expanded, onToggle, onApply }: Props) {
  if (isSignalReportError(row)) {
    return (
      <tr className="num">
        <td className="left">
          <span className="chev" /> {row.instId}
          <CutLabel phase={row.phase} latest={latest} />
        </td>
        <td className="signal-error" colSpan={SIGNAL_COLUMNS - 1}>
          {row.error.code}: {row.error.message}
        </td>
      </tr>
    );
  }
  const ind = row.indicators;
  const f = row.funding;
  // A report from before the parameter existed has no allowShort: only an explicit false switches the short side off.
  const allowShort = row.params.allowShort !== false;
  const side = entrySide(row);
  const sizing = row.sizing;
  const plan = side === null || sizing === null ? null : side === 'buy' ? sizing.long : sizing.short;
  const inPosition = side !== null && holdsSide(positions, row.instId, side);
  const pending = side !== null && !inPosition && entryPending(orders, row.instId, side);
  const lotOpen = inPosition || pending;
  // With one cut any position or entry order on the side blocks the entry. With several, every cut has its own lot:
  // one lot open leaves room for this row's, and only what amounts to the lots of all the cuts blocks it. The lots
  // differ in size (each cut has its own stop), so "all" is taken as at least half a lot more than the others' share.
  const unitFull =
    side !== null && plan !== null && lotOpen && cuts > 1
      ? heldContracts(positions, row.instId, side).plus(pendingContracts(orders, row.instId, side)).gte(D(plan.contracts).mul(D(cuts).minus('0.5')))
      : lotOpen;
  const heldTitle = cuts > 1 ? (unitFull ? UNIT_FULL_TITLE : OTHER_LOT_TITLE) : inPosition ? IN_POSITION_TITLE : ENTRY_PENDING_TITLE;
  const canApply = plan !== null && plan.contracts !== '0' && !unitFull && !outdated;
  const applyTitle =
    side === null
      ? ''
      : outdated
        ? OUTDATED_TITLE
        : unitFull
          ? heldTitle
          : plan === null
            ? 'No equity: sizing unavailable'
            : plan.contracts === '0'
              ? plan.note
              : `Fill the ticket: ${side} ${plan.contracts} contracts @ ${ind.close}${lotOpen ? `. ${OTHER_LOT_TITLE}` : ''}`;
  const reduced = plan !== null && !D(plan.multiplier).eq(1);
  return (
    <>
      <tr className="num signal-row" onClick={onToggle} aria-expanded={expanded}>
        <td className="left">
          <span className="chev">{expanded ? '▾' : '▸'}</span> {row.instId}
          <CutLabel phase={row.phase} latest={latest} />
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
          <SignalBadges signals={row.signals} allowShort={allowShort} />
          {side !== null && f === null && (
            <span className="signal-badge signal-unchecked" title={FUNDING_UNCHECKED_TITLE}>
              funding unchecked
            </span>
          )}
          {inPosition && (
            <span className="signal-badge signal-held" title={heldTitle}>
              in position
            </span>
          )}
          {pending && (
            <span className="signal-badge signal-held" title={heldTitle}>
              entry pending
            </span>
          )}
          {plan !== null && reduced && (
            <span className="sub signal-adjust">
              size ×{plan.multiplier}: {plan.adjustments.join(', ')}
            </span>
          )}
        </td>
        <SizingCells sizing={sizing} inst={inst} side={side} allowShort={allowShort} />
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
              <>
                <div className={`signal-note${sizing.long.contracts === '0' ? ' neg' : ''}`}>sizing long: {sizing.long.note}</div>
                {allowShort ? (
                  <div className={`signal-note${sizing.short.contracts === '0' ? ' neg' : ''}`}>sizing short: {sizing.short.note}</div>
                ) : (
                  <div className="signal-note dim">sizing short: off (short entries are switched off, allowShort = false)</div>
                )}
              </>
            )}
            <div className="signal-note">
              next session (the {row.params.exitChannel}-day channel including the last bar): trail a long&apos;s exchange stop to {fmtPx(ind.nextExitLow, inst)}, a short&apos;s to{' '}
              {fmtPx(ind.nextExitHigh, inst)}; only ever move a stop in the position&apos;s favour
            </div>
            <div className="signal-note dim">
              bar closed {fmtUtcMinute(ind.asOf + DAY_MS)}
              {row.dataFetchedAt !== null && ` · exchange data fetched ${fmtTime(row.dataFetchedAt)}`}
            </div>
          </td>
        </tr>
      )}
    </>
  );
}
