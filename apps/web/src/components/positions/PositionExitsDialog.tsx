import { useState } from 'react';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { stopsOfPosition, type AlgoOrder, type Instrument, type Position, type PosSide, type TdMode } from '@pegasus/shared';
import { explainError, labelOf, useT, type Messages } from '../../i18n';
import { api } from '../../lib/api';
import { buildExitFields, channelOf, defaultExitForm, takeProfitsOf, trailingStopsOf, type ExitForm } from '../../lib/exits';
import { utcLocal } from '../../lib/describe';
import { DASH, fmtContracts, fmtPct, fmtPx } from '../../lib/format';
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
 * the forms to add take-profit legs or a trailing stop (callback or channel). Errors are worded from their codes.
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
  const [tpForm, setTpForm] = useState<ExitForm>(() => ({ ...defaultExitForm(), tpMode: 'single' }));
  const [trailForm, setTrailForm] = useState<ExitForm>(() => defaultExitForm('channel'));
  const [error, setError] = useState<string | null>(null);

  const ctx = { direction, entry: p.avgPx, stop: stops[0]?.slTriggerPx ?? null, inst: inst ?? null, whole: false };
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
        <ExitPlanEditor form={tpForm} update={setTpForm} ctx={ctx} error={tpBuilt.ok ? null : tpBuilt.error} trailing={false} breakeven={false} noneOption={false} />
        <button className="btn btn-primary" disabled={locked || !tpBuilt.ok || tpForm.tpMode === 'none'} onClick={() => placeTps.mutate()}>
          {t.exits.placeTps}
        </button>
      </section>
      <section className="exits-section exits-form">
        <h5>{t.exits.setTrailing}</h5>
        <ExitPlanEditor form={trailForm} update={setTrailForm} ctx={ctx} error={trailBuilt.ok ? null : trailBuilt.error} takeProfit={false} breakeven={false} noneOption={false} />
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
