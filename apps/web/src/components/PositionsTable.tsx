import { useMutation } from '@tanstack/react-query';
import { D, stopCoverage, type ClosePositionRequest, type Instrument, type PlaceStopRequest, type Position, type StopCoverage } from '@pegasus/shared';
import { api } from '../lib/api';
import { errorText, labelOf, useLang, useT, type Messages } from '../i18n';
import { fmtCoin, fmtContracts, fmtNum, fmtPct, fmtPx, fmtSigned, fmtTime, signOf } from '../lib/format';
import { accountAsOf, accountUnknown, trimAdvice, trimShares, type AccountUnknown } from '../store/alerts';
import { getTradingBlock, useStore } from '../store/store';

const unknownText = (t: Messages): Record<AccountUnknown, string> => ({
  waiting: t.common.waitingServer,
  disabled: t.positions.noKey,
  loading: t.positions.loading,
  failed: t.positions.failed,
  unloaded: t.common.accountNotLoaded,
});

/**
 * The position's stops as last read from the exchange: their trigger prices, and a tag unless they cover exactly
 * the position. `onAdd` (when the uncovered part can get a stop from here) puts the "add stop" button next to the tag.
 */
function StopCell({ coverage, inst, onAdd }: { coverage: StopCoverage | null; inst: Instrument | undefined; onAdd: (() => void) | null }) {
  const t = useT();
  if (coverage === null) return <span className="dim" title={t.positions.stopsUnread}>?</span>;
  const prices = coverage.stops.map((s) => fmtPx(s.slTriggerPx, inst));
  const shown = prices.length <= 2 ? prices.join(' / ') : t.positions.nStops(prices.length);
  const tag =
    coverage.state === 'none'
      ? t.positions.noStop
      : coverage.state === 'partial'
        ? t.positions.covers(fmtContracts(coverage.covered, inst), fmtContracts(coverage.size, inst))
        : coverage.state === 'over'
          ? t.positions.stopsOver(fmtContracts(coverage.covered, inst), fmtContracts(coverage.size, inst))
          : null;
  return (
    <span title={t.positions.stopTitle[coverage.state]}>
      {shown}
      {tag !== null && <span className="stop-tag">{tag}</span>}
      {onAdd !== null && (coverage.state === 'none' || coverage.state === 'partial') && (
        <button className="btn btn-sm stop-add" onClick={onAdd} title={t.positions.addStopTitle}>
          {t.positions.addStop}
        </button>
      )}
    </span>
  );
}

function sideOf(p: Position): 'long' | 'short' | 'flat' {
  if (p.posSide === 'long' || p.posSide === 'short') return p.posSide;
  const d = D(p.pos);
  return d.gt(0) ? 'long' : d.lt(0) ? 'short' : 'flat';
}

export function PositionsTable() {
  const t = useT();
  const lang = useLang();
  const positions = useStore((s) => s.positions);
  const instruments = useStore((s) => s.instruments);
  const posMode = useStore((s) => s.account?.posMode ?? null);
  // Instruments whose position has outgrown the per-instrument limit: shown on the row, nothing is blocked.
  const overLimit = useStore((s) => s.risk?.overLimit);
  const algoOrders = useStore((s) => s.algoOrders);
  const tradingBlock = useStore(getTradingBlock);
  // Re-sent by the server every 5 s, which also keeps the "as of" label current.
  const connection = useStore((s) => s.connection);
  const pushToast = useStore((s) => s.pushToast);
  const unknown = useStore(accountUnknown);
  const asOf = accountAsOf(connection, Date.now());

  const close = useMutation({
    mutationFn: (body: ClosePositionRequest) => api.closePosition(body),
    onSuccess: (r) => pushToast('info', t.positions.closeRequested(r.instId, r.posSide)),
    onError: (e) => pushToast('error', t.positions.closeFailed(errorText(e, t))),
  });

  const addStop = useMutation({
    mutationFn: (body: PlaceStopRequest) => api.placeStop(body),
    onSuccess: (r) => pushToast('success', t.positions.stopPlaced(r.instId, r.sz, r.slTriggerPx)),
    onError: (e) => pushToast('error', t.positions.stopNotPlaced(errorText(e, t))),
  });

  const onAddStop = (p: Position, coverage: StopCoverage) => {
    const uncovered = D(coverage.size).minus(coverage.covered).toFixed();
    const input = window.prompt(t.positions.stopPrompt(uncovered, sideOf(p), p.instId));
    if (input === null) return;
    const px = input.trim();
    if (!/^\d+(\.\d+)?$/.test(px) || D(px).lte(0)) {
      pushToast('error', t.positions.stopPriceInvalid);
      return;
    }
    const body: PlaceStopRequest = { instId: p.instId, mgnMode: p.mgnMode, slTriggerPx: px };
    if (posMode === 'long_short_mode' && (p.posSide === 'long' || p.posSide === 'short')) body.posSide = p.posSide;
    addStop.mutate(body);
  };

  const onClose = (p: Position) => {
    if (!window.confirm(t.positions.confirmClose(sideOf(p), p.instId))) return;
    const body: ClosePositionRequest =
      posMode === 'long_short_mode' && (p.posSide === 'long' || p.posSide === 'short')
        ? { instId: p.instId, mgnMode: p.mgnMode, posSide: p.posSide }
        : { instId: p.instId, mgnMode: p.mgnMode };
    close.mutate(body);
  };

  const open = positions.filter((p) => !D(p.pos).isZero());
  const asOfTag = asOf === null ? null : <span className="stale-tag">{t.common.asOf(fmtTime(asOf))}</span>;
  // An empty list only means a flat account once the positions were actually loaded.
  if (open.length === 0) return <div className="empty">{unknown === null ? <>{t.positions.empty} {asOfTag}</> : unknownText(t)[unknown]}</div>;

  return (
    <table className="table">
      {asOfTag !== null && <caption className="as-of">{t.positions.caption} {asOfTag}</caption>}
      <thead>
        <tr>
          <th>{t.common.instrument}</th>
          <th className="left">{t.common.side}</th>
          <th>{t.positions.contracts}</th>
          <th>{t.positions.coin}</th>
          <th>{t.positions.avgPx}</th>
          <th>{t.positions.mark}</th>
          <th title={t.positions.stopHeaderTitle}>{t.common.stop}</th>
          <th>{t.positions.upl}</th>
          <th>{t.positions.uplPct}</th>
          <th>{t.positions.lever}</th>
          <th>{t.positions.liqPx}</th>
          <th>{t.positions.margin}</th>
          <th>{t.positions.notional}</th>
          <th />
        </tr>
      </thead>
      <tbody>
        {open.map((p) => {
          const inst = instruments.find((i) => i.instId === p.instId);
          const side = sideOf(p);
          const absPos = D(p.pos).abs();
          const over = overLimit?.find((o) => o.instId === p.instId);
          // Both legs of long/short mode are marked, but the trim is shown once: on the larger leg (and on the
          // other only for what the larger cannot cover), so that following every row closes the excess once.
          const share = over === undefined ? undefined : trimShares(open, over).get(p);
          const trim = over === undefined || share === undefined ? null : trimAdvice(p, { ...over, excess: share.toFixed() }, inst);
          const coverage = algoOrders === null ? null : stopCoverage(p, algoOrders.orders);
          return (
            <tr key={`${p.instId}:${p.posSide}:${p.mgnMode}`} className={over === undefined ? 'num' : 'num over-limit'}>
              <td className="left">
                {p.instId}
                {inst === undefined && (
                  <span className="untracked-tag" title={t.common.untrackedTitle}>
                    {t.common.untracked}
                  </span>
                )}
              </td>
              <td className={`left ${side === 'long' ? 'pos' : 'neg'}`}>
                {t.enums.posSide[side]} <span className="dim">{labelOf(t.enums.mgnMode, p.mgnMode)}</span>
              </td>
              <td>{fmtContracts(absPos, inst)}</td>
              <td>
                {fmtCoin(absPos, inst, p.markPx)} {inst?.baseCcy ?? ''}
              </td>
              <td>{fmtPx(p.avgPx, inst)}</td>
              <td>{fmtPx(p.markPx, inst)}</td>
              <td>
                <StopCell coverage={coverage} inst={inst} onAdd={coverage === null || tradingBlock !== null || addStop.isPending ? null : () => onAddStop(p, coverage)} />
              </td>
              <td className={signOf(p.upl)}>{fmtSigned(p.upl, 2)}</td>
              <td className={signOf(p.uplRatio)}>{fmtPct(p.uplRatio, 2, true)}</td>
              <td>{p.lever}x</td>
              <td>{fmtPx(p.liqPx, inst)}</td>
              <td>{fmtNum(p.margin, 2)}</td>
              <td>
                {fmtNum(p.notionalUsd, 0)}
                {over !== undefined && trim !== null && (
                  <span className="over-limit-tag" title={t.positions.overLimitTitle(p.instId, fmtNum(over.notional, 0), fmtNum(over.limit, 0))}>
                    {t.positions.overLimitTag(fmtNum(trim.quote, 0), trim.contracts !== null ? fmtContracts(trim.contracts, inst) : null)}
                  </span>
                )}
              </td>
              <td>
                <button
                  className="btn btn-sm btn-danger"
                  onClick={() => onClose(p)}
                  disabled={close.isPending || tradingBlock !== null}
                  {...(tradingBlock === null ? {} : { title: tradingBlock[lang] })}
                >
                  {t.positions.close}
                </button>
              </td>
            </tr>
          );
        })}
      </tbody>
    </table>
  );
}
