import { useMemo } from 'react';
import { D, ZERO, type BookLevel, type Decimal, type Instrument } from '@pegasus/shared';
import { Panel } from './Panel';
import { fmtCoin, fmtPct, fmtPx } from '../lib/format';
import { isStreamStale } from '../store/alerts';
import { getSelectedInstrument, getSelectedMarket, useStore } from '../store/store';

const DEPTH = 20;

interface Row {
  px: string;
  sz: string;
  cum: Decimal;
}

function cumulate(levels: BookLevel[]): Row[] {
  let acc = ZERO;
  return levels.slice(0, DEPTH).map(([px, sz]) => {
    acc = acc.plus(D(sz));
    return { px, sz, cum: acc };
  });
}

/** Depth bar width as a percentage of the largest cumulative size (chart coordinate only). */
function widthPct(cum: Decimal, max: Decimal): number {
  if (max.lte(0)) return 0;
  return Math.min(100, Number(cum.div(max).mul(100).toFixed(2)));
}

function BookRow({ row, side, max, inst, onPick }: { row: Row; side: 'bid' | 'ask'; max: Decimal; inst: Instrument | null; onPick: (px: string) => void }) {
  return (
    <div className={`book-row num ${side}`} onClick={() => onPick(row.px)} title="Use this price in the ticket">
      <span className="depth" style={{ width: `${widthPct(row.cum, max)}%` }} />
      <span className="px">{fmtPx(row.px, inst)}</span>
      <span>{fmtCoin(row.sz, inst, row.px)}</span>
      <span className="muted">{fmtCoin(row.cum, inst, row.px)}</span>
    </div>
  );
}

export function OrderBook() {
  const inst = useStore(getSelectedInstrument);
  const book = useStore((s) => getSelectedMarket(s).book);
  const stale = useStore((s) => isStreamStale(s, s.selectedInstId, 'book')) && book !== null;
  const setTicketPrice = useStore((s) => s.setTicketPrice);

  const { bids, asks, max, spread, spreadPct } = useMemo(() => {
    const bidRows = cumulate(book?.bids ?? []);
    const askRows = cumulate(book?.asks ?? []);
    const lastBid = bidRows[bidRows.length - 1]?.cum ?? ZERO;
    const lastAsk = askRows[askRows.length - 1]?.cum ?? ZERO;
    const maxCum = lastBid.gt(lastAsk) ? lastBid : lastAsk;
    const bestBid = bidRows[0]?.px;
    const bestAsk = askRows[0]?.px;
    let sp: Decimal | null = null;
    let spPct: Decimal | null = null;
    if (bestBid !== undefined && bestAsk !== undefined) {
      sp = D(bestAsk).minus(D(bestBid));
      const mid = D(bestAsk).plus(D(bestBid)).div(2);
      spPct = mid.isZero() ? null : sp.div(mid);
    }
    return { bids: bidRows, asks: askRows, max: maxCum, spread: sp, spreadPct: spPct };
  }, [book]);

  return (
    <Panel title="Order book" className={`panel-book${stale ? ' panel-stale' : ''}`} extra={stale ? <span className="stale-tag" title="The order book stopped updating; these levels are not current">STALE</span> : null}>
      {book === null ? (
        <div className="empty">No book data</div>
      ) : (
      <div className="book">
        <div className="book-head">
          <span>Price</span>
          <span>Size ({inst?.baseCcy ?? 'coin'})</span>
          <span>Total</span>
        </div>
        <div className="book-side asks">
          {[...asks].reverse().map((r) => (
            <BookRow key={r.px} row={r} side="ask" max={max} inst={inst} onPick={setTicketPrice} />
          ))}
        </div>
        <div className="spread num">
          <span>Spread</span>
          <span>{fmtPx(spread, inst)}</span>
          <span>{fmtPct(spreadPct, 3)}</span>
        </div>
        <div className="book-side bids">
          {bids.map((r) => (
            <BookRow key={r.px} row={r} side="bid" max={max} inst={inst} onPick={setTicketPrice} />
          ))}
        </div>
      </div>
      )}
    </Panel>
  );
}
