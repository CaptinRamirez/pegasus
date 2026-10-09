import { useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { D, Decimal, ZERO, stopsOfPosition, type AlgoOrder, type Instrument, type Position, type PosSide, type TdMode } from '@pegasus/shared';
import { explainError, labelOf, useT, type Messages } from '../../i18n';
import { api } from '../../lib/api';
import { buildExitFields, channelLevelOf, channelOf, defaultExitForm, proposeTakeProfits, takeProfitsOf, trailingStopsOf, type ExitContext, type ExitForm } from '../../lib/exits';
import { utcLocal } from '../../lib/describe';
import { DASH, fmtContracts, fmtPct, fmtPx, safeDecimal } from '../../lib/format';
import { TRAILING_QUERY_KEY, useTrailing } from '../../hooks/useTrailing';
import { useStore } from '../../store/store';
import { ExitPlanEditor } from '../exits/ExitPlanEditor';
import { Modal } from '../Overlay';

/** What the position routes name a position by: posSide only in long/short mode. */
export interface PositionRef {
  instId: string;
  mgnMode: TdMode;
  posSide?: PosSide;
}

export function positionRef(p: Position, longShort: boolean): PositionRef {
  return longShort && (p.posSide === 'long' || p.posSide === 'short') ? { instId: p.instId, mgnMode: p.mgnMode, posSide: p.posSide } : { instId: p.instId, mgnMode: p.mgnMode };
}

export const directionOf = (p: Position): 'long' | 'short' => (p.posSide === 'short' || (p.posSide === 'net' && p.pos.startsWith('-')) ? 'short' : 'long');

/** The size an algo order closes, in words. */
export const algoSize = (a: AlgoOrder, inst: Instrument | undefined, t: Messages): string =>
  a.closeFraction !== '' ? t.exits.wholePosition : t.common.ct(fmtContracts(a.sz, inst));

interface Props {
  position: Position;
  inst: Instrument | undefined;
  /** An isolated position on a coin with an open campaign: its exits are the rule's */
  campaignOwned: boolean;
  onClose: () => void;
}

/**
 * The exits of an open position (paper trading and the local mock): what rests for it (stops, take-profit legs, the
 * exchange's trailing stop, channel trailing with its level), each take-profit and trailing stop with a cancel, and
 * the forms to add take-profit legs or a trailing stop (callback or channel). The take-profit proposed is beyond the
 * legs already resting and for the share of the position they leave (the server refuses more: TP_EXCEEDS_POSITION);
 * channel trailing says its level now, from the daily bars when none is kept for the position. Errors are worded
 * from their codes.
 */
export function PositionExitsDialog({ position: p, inst, campaignOwned, onClose }: Props) {
  const t = useT();
  const qc = useQueryClient();
  const posMode = useStore((s) => s.account?.posMode ?? null);
  const algoOrders = useStore((s) => s.algoOrders);
  const applyAlgoOrders = useStore((s) => s.applyAlgoOrders);
  const pushToast = useStore((s) => s.pushToast);
  const trailing = useTrailing();
  const ref = positionRef(p, posMode === 'long_short_mode');
  const direction = directionOf(p);
  const orders = algoOrders?.orders ?? [];
  const stops = stopsOfPosition(p, orders);
  const tps = takeProfitsOf(p, orders);
  const trailingStops = trailingStopsOf(p, orders);
  const channel = channelOf(p, trailing.view?.entries);
  const size = D(p.pos).abs();
  // What the resting take-profits cover of the position (a leg closing a fraction of it: that fraction, as the server
  // counts it) and the farthest of them: a new leg is proposed beyond it, and beyond the mark price (the server
  // refuses a take-profit the price has already passed), for the share they leave.
  const covered = tps.reduce((sum, a) => sum.plus(a.closeFraction !== '' ? size.mul(a.closeFraction) : (safeDecimal(a.sz) ?? ZERO)), ZERO);
  const uncovered = size.gt(0) ? Decimal.max(ZERO, size.minus(covered)).div(size) : D(1);
  const farthest = (direction === 'long' ? tps.at(-1) : tps[0])?.tpTriggerPx ?? null;
  const beyond = (() => {
    const levels = [safeDecimal(farthest), safeDecimal(p.markPx)].flatMap((d) => (d === null || !d.gt(0) ? [] : [d]));
    if (levels.length === 0) return null;
    return (direction === 'long' ? Decimal.max(...levels) : Decimal.min(...levels)).toFixed();
  })();
  const ctx: ExitContext = {
    direction,
    entry: p.avgPx,
    stop: stops[0]?.slTriggerPx ?? null,
    inst: inst ?? null,
    whole: false,
    contracts: size.toFixed(),
    beyond,
    uncovered: uncovered.toFixed(),
  };
  // the first take-profit level is the program's: 2R from the average price with a stop, 10% without, lifted beyond the resting legs
  const [tpForm, setTpForm] = useState<ExitForm>(() => proposeTakeProfits({ ...defaultExitForm(), tpMode: 'single' }, ctx));
  const [trailForm, setTrailForm] = useState<ExitForm>(() => defaultExitForm('channel'));
  const [error, setError] = useState<string | null>(null);

  // Where channel trailing keeps the stop now for the days of the form: the level kept for the position when the days
  // are its own, else the N-day low (high) of the daily bars.
  const bars = /^\d+$/.test(trailForm.channelBars.trim()) ? Number(trailForm.channelBars.trim()) : null;
  const keptLevel = channel !== null && bars === channel.bars ? channel.level : null;
  const candles = useQuery({
    queryKey: ['signal-candles', p.instId],
    queryFn: () => api.candles({ instId: p.instId, bar: '1D', limit: 120 }),
    enabled: trailForm.trailing === 'channel' && bars !== null && keptLevel === null,
    staleTime: 5 * 60_000,
  });
  const channelLevel = keptLevel ?? (bars === null ? null : channelLevelOf(candles.data, bars, direction));

  const tpBuilt = buildExitFields({ ...tpForm, trailing: 'none' }, ctx);
  const trailBuilt = buildExitFields({ ...trailForm, tpMode: 'none' }, ctx);

  /** After a change: the algo orders read again (the server pushes them too) and channel trailing. */
  const refresh = () => {
    void api.algoOrders().then(applyAlgoOrders, () => undefined);
    void qc.invalidateQueries({ queryKey: TRAILING_QUERY_KEY });
  };
  const done = (text: string) => {
    setError(null);
    pushToast('success', text);
    refresh();
  };
  const failed = (e: unknown) => {
    const text = explainError(e, t);
    setError(text);
    pushToast('error', t.exits.failed(text));
  };

  const placeTps = useMutation({
    mutationFn: () => {
      if (!tpBuilt.ok || tpBuilt.fields.takeProfits === undefined) throw new Error('incomplete');
      return api.placeTakeProfits({ ...ref, takeProfits: tpBuilt.fields.takeProfits });
    },
    onSuccess: (r) => done(t.exits.done.tps(r.legs.length, r.instId)),
    onError: failed,
  });
  const placeTrailing = useMutation({
    mutationFn: async (): Promise<string> => {
      if (!trailBuilt.ok || trailBuilt.fields.trailing === undefined) throw new Error('incomplete');
      const exit = trailBuilt.fields.trailing;
      if (exit.kind === 'channel') {
        await api.setChannelTrailing({ ...ref, bars: exit.bars });
        return t.exits.done.channel(p.instId, exit.bars);
      }
      const r = await api.placeTrailingStop(exit.activePx === undefined ? { ...ref, ratio: exit.ratio } : { ...ref, ratio: exit.ratio, activePx: exit.activePx });
      return t.exits.done.trailing(r.instId, fmtPct(r.callbackRatio, 2));
    },
    onSuccess: done,
    onError: failed,
  });
  const clearChannel = useMutation({
    mutationFn: () => api.clearChannelTrailing(ref),
    onSuccess: () => done(t.exits.done.cleared(p.instId)),
    onError: failed,
  });
  const cancel = useMutation({
    mutationFn: (a: AlgoOrder) => api.cancelAlgoOrder({ instId: a.instId, algoId: a.algoId }),
    onSuccess: () => done(t.exits.done.cancelled(p.instId)),
    onError: failed,
  });
  const busy = placeTps.isPending || placeTrailing.isPending || clearChannel.isPending || cancel.isPending;
  const locked = campaignOwned || busy;

  const onCancel = (a: AlgoOrder, what: string) => {
    if (window.confirm(t.exits.confirmCancel(what, p.instId))) cancel.mutate(a);
  };

  return (
    <Modal title={t.exits.dialogTitle(p.instId, labelOf(t.enums.posSide, direction))} onClose={onClose} className="exits-dialog" dismissable={!busy}>
      {campaignOwned && <div className="notice notice-warn">{t.exits.campaignPosition}</div>}
      <section className="exits-section">
        <h5>{t.exits.stops}</h5>
        {stops.length === 0 ? (
          <div className="dim">{t.exits.none}</div>
        ) : (
          stops.map((s) => (
            <div key={s.algoId} className="exits-item">
              <span className="num">
                {fmtPx(s.slTriggerPx, inst)} <span className="dim">({labelOf(t.enums.triggerPx, s.slTriggerPxType)})</span> · {algoSize(s, inst, t)}
              </span>
            </div>
          ))
        )}
      </section>
      <section className="exits-section">
        <h5>{t.exits.tps}</h5>
        {tps.length === 0 ? (
          <div className="dim">{t.exits.none}</div>
        ) : (
          tps.map((a) => (
            <div key={a.algoId} className="exits-item">
              <span className="num">{t.exits.tpLine(fmtPx(a.tpTriggerPx, inst), algoSize(a, inst, t))}</span>
              <button className="btn btn-sm btn-danger" disabled={locked} onClick={() => onCancel(a, t.exits.whatTp(fmtPx(a.tpTriggerPx, inst)))}>
                {t.exits.cancel}
              </button>
            </div>
          ))
        )}
      </section>
      <section className="exits-section">
        <h5>{t.exits.trailingStops}</h5>
        {trailingStops.length === 0 ? (
          <div className="dim">{t.exits.none}</div>
        ) : (
          trailingStops.map((a) => (
            <div key={a.algoId} className="exits-item">
              <span className="num">
                {t.exits.callbackLine(fmtPct(a.callbackRatio ?? '', 2), a.moveTriggerPx === undefined || a.moveTriggerPx === '' ? '' : fmtPx(a.moveTriggerPx, inst), a.activePx === undefined ? '' : fmtPx(a.activePx, inst))} ·{' '}
                {algoSize(a, inst, t)}
              </span>
              <button className="btn btn-sm btn-danger" disabled={locked} onClick={() => onCancel(a, t.exits.whatTrailing)}>
                {t.exits.cancel}
              </button>
            </div>
          ))
        )}
      </section>
      <section className="exits-section">
        <h5>{t.exits.channel}</h5>
        {channel === null ? (
          <div className="dim">{t.exits.none}</div>
        ) : (
          <div className="exits-item">
            <span>
              <span className="num">{channel.level === null ? t.exits.channelWaiting(channel.bars) : t.exits.channelLine(channel.bars, fmtPx(channel.level, inst))}</span>
              {channel.lastMove !== null && (
                <span className="sub dim num">
                  {t.exits.lastMove(channel.lastMove.from === null ? DASH : fmtPx(channel.lastMove.from, inst), fmtPx(channel.lastMove.to, inst), utcLocal(channel.lastMove.at, t))}
                </span>
              )}
              {channel.lastError !== null && <span className="sub warn">{t.exits.lastError(channel.lastError.message)}</span>}
            </span>
            <button
              className="btn btn-sm"
              disabled={locked}
              title={t.exits.clearChannelTitle}
              onClick={() => {
                if (window.confirm(t.exits.confirmClear(p.instId))) clearChannel.mutate();
              }}
            >
              {t.exits.clearChannel}
            </button>
          </div>
        )}
      </section>
      <section className="exits-section exits-form">
        <h5>{t.exits.addTps}</h5>
        <div className="dim exits-hint">{t.exits.addTpsHint}</div>
        {tps.length > 0 && (
          <div className="dim exits-hint exits-resting">
            {uncovered.gt(0) ? t.exits.restingCover(fmtContracts(covered, inst), fmtContracts(size, inst), fmtPx(farthest, inst)) : t.exits.restingCoverAll(fmtContracts(size, inst))}
          </div>
        )}
        <ExitPlanEditor form={tpForm} update={setTpForm} ctx={ctx} trailing={false} breakeven={false} noneOption={false} />
        <button className="btn btn-primary" disabled={locked || !tpBuilt.ok || tpForm.tpMode === 'none'} onClick={() => placeTps.mutate()}>
          {t.exits.placeTps}
        </button>
      </section>
      <section className="exits-section exits-form">
        <h5>{t.exits.setTrailing}</h5>
        <ExitPlanEditor
          form={trailForm}
          update={setTrailForm}
          ctx={ctx}
          takeProfit={false}
          breakeven={false}
          noneOption={false}
          channelLevel={channelLevel}
          priceNow={p.markPx === '' ? null : p.markPx}
        />
        <button className="btn btn-primary" disabled={locked || !trailBuilt.ok || trailForm.trailing === 'none'} onClick={() => placeTrailing.mutate()}>
          {t.exits.place}
        </button>
      </section>
      {error !== null && (
        <div className="notice notice-danger" role="alert">
          {error}
        </div>
      )}
    </Modal>
  );
}
