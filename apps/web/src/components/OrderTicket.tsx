import { useEffect, useMemo, useRef, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { sizeToContracts } from '@pegasus/shared';
import { labelOf, useLang, useT } from '../i18n';
import { api } from '../lib/api';
import { exitErrorText } from '../lib/describe';
import { channelLevelOf, checkExitForm, defaultExitForm, proposeLevels, riskDistance, stopAttachedOf, type ExitContext, type ExitFormCheck } from '../lib/exits';
import { fmtPx, safeDecimal } from '../lib/format';
import { useCampaignSignals } from '../hooks/useCampaignSignals';
import { useTrailing } from '../hooks/useTrailing';
import { getSelectedInstrument, getSelectedMarket, getKillSwitch, getTradingBlock, useStore } from '../store/store';
import { ExitPlanEditor } from './exits/ExitPlanEditor';
import { Panel } from './Panel';
import { readStoredRiskPct } from './signals/riskPref';
import { LeverageControl } from './ticket/LeverageControl';
import { PreviewPanel } from './ticket/PreviewPanel';
import { ORD_TYPES, SIZE_UNITS, buildRequest, defaultForm, derivePosSide, describeRequest, intentOf, needsPrice, unitLabel, type TicketForm } from './ticket/form';
import { useOrderPreview } from './ticket/useOrderPreview';
import { usePlaceOrder } from './ticket/usePlaceOrder';

/** How long the ticket is highlighted after another tab put a coin into it. */
const FLASH_MS = 1_500;

export function OrderTicket() {
  const t = useT();
  const lang = useLang();
  const inst = useStore(getSelectedInstrument);
  const posMode = useStore((s) => s.account?.posMode ?? null);
  const killSwitch = useStore(getKillSwitch);
  const tradingBlock = useStore(getTradingBlock);
  const ticketPrice = useStore((s) => s.ticketPrice);
  const ticketPrefill = useStore((s) => s.ticketPrefill);
  const ticketFocus = useStore((s) => s.ticketFocus);
  const lastPx = useStore((s) => {
    const m = getSelectedMarket(s);
    return m.ticker?.last ?? m.markPrice?.markPx ?? null;
  });
  const pushToast = useStore((s) => s.pushToast);
  const exitsOffered = useTrailing().available;
  const [form, setForm] = useState<TicketForm>(defaultForm);
  const patch = (p: Partial<TicketForm>) => setForm((f) => ({ ...f, ...p }));
  const priceInput = useRef<HTMLInputElement | null>(null);
  const sizeInput = useRef<HTMLInputElement | null>(null);
  const [flash, setFlash] = useState(false);

  const instId = inst?.instId ?? null;
  useEffect(() => {
    // The close checkbox and a unit that a pre-fill brought belong to the instrument they were set for.
    setForm((f) => ({ ...f, px: '', slTriggerPx: '', sizeValue: '', reduceOnly: false, sizeUnit: f.restoreUnit ?? f.sizeUnit, restoreUnit: null, exits: defaultExitForm(), exitsOn: false, exitEntryPx: null }));
  }, [instId]);

  useEffect(() => {
    if (ticketPrice !== null) setForm((f) => ({ ...f, px: ticketPrice.px }));
  }, [ticketPrice]);

  // Runs after the instId reset above (same commit when the prefill switched instrument), so the prefill wins.
  useEffect(() => {
    if (ticketPrefill === null || ticketPrefill.instId !== instId) return;
    const { side, ordType, px, sizeValue, sizeUnit } = ticketPrefill;
    // A prefill without a stop clears the one the form held: it belonged to another order.
    setForm((f) => ({ ...f, side, ordType, px, slTriggerPx: ticketPrefill.slTriggerPx ?? '', sizeValue, sizeUnit, reduceOnly: false, restoreUnit: f.restoreUnit ?? f.sizeUnit }));
  }, [ticketPrefill, instId]);

  // A coin and a side put here from another tab: nothing else is filled, and the first empty field takes the focus.
  useEffect(() => {
    if (ticketFocus === null || ticketFocus.instId !== instId) return;
    setForm((f) => ({ ...f, side: ticketFocus.side, px: '', slTriggerPx: '', sizeValue: '', reduceOnly: false, exits: defaultExitForm(), exitsOn: false, exitEntryPx: null }));
    setFlash(true);
    const timer = setTimeout(() => setFlash(false), FLASH_MS);
    const focus = setTimeout(() => (priceInput.current ?? sizeInput.current)?.focus(), 0);
    return () => {
      clearTimeout(timer);
      clearTimeout(focus);
    };
  }, [ticketFocus, instId]);

  const longShort = posMode === 'long_short_mode';
  const opening = !form.reduceOnly;
  const exitsActive = opening && form.exitsOn && exitsOffered === true;
  // The entry the exits are measured from: the limit price, or, for a market order, the last price when the exits
  // section was opened (form.exitEntryPx), frozen so that R and % levels (and the request they make) do not move
  // with every tick; the server measures the legs from the fill price in any case.
  const marketExits = form.exitsOn && !needsPrice(form.ordType);
  useEffect(() => {
    setForm((f) => {
      const wants = f.exitsOn && !needsPrice(f.ordType);
      if (!wants) return f.exitEntryPx === null ? f : { ...f, exitEntryPx: null };
      return f.exitEntryPx !== null || lastPx === null ? f : { ...f, exitEntryPx: lastPx };
    });
  }, [form.exitsOn, form.ordType, lastPx]);
  const exitEntry = needsPrice(form.ordType) ? (form.px.trim() === '' ? null : form.px.trim()) : marketExits ? (form.exitEntryPx ?? lastPx) : lastPx;

  // What the exit plan is measured against: the direction, the entry, the stop and the contracts of the order.
  const direction: ExitContext['direction'] = form.side === 'buy' ? 'long' : 'short';
  const stopOrNull = form.slTriggerPx.trim() === '' ? null : form.slTriggerPx.trim();
  // (a coin or quote size is converted at the limit price, or at the last price now for a market order, as the server converts it)
  const sizePx = needsPrice(form.ordType) ? exitEntry : lastPx;
  const exitContracts = useMemo((): string | null => {
    if (inst === null || form.sizeValue.trim() === '') return null;
    try {
      return sizeToContracts({ unit: form.sizeUnit, value: form.sizeValue.trim() }, inst, form.ordType, sizePx ?? undefined).sz;
    } catch {
      return null;
    }
  }, [inst, form.sizeValue, form.sizeUnit, form.ordType, sizePx]);
  // Where channel trailing would keep the stop now: the campaign's exit line (or entry line, for a short) when the days
  // are the rule's, else the N-day low (high) of the daily bars, as the confirmation sheet reads it.
  const wantsLevel = exitsActive && form.exits.trailing === 'channel';
  const channelBars = /^\d+$/.test(form.exits.channelBars.trim()) ? Number(form.exits.channelBars.trim()) : null;
  const signals = useCampaignSignals(readStoredRiskPct(), wantsLevel);
  const rowLevel = (() => {
    const res = signals.data;
    if (!wantsLevel || res === undefined || instId === null || channelBars === null) return null;
    const row = res.rows.find((r) => r.instId === instId);
    if (row === undefined) return null;
    if (direction === 'long') return channelBars === res.params.exitChannel ? (row.holding?.trailingLine ?? row.levels.nextExit) : null;
    return channelBars === res.params.entryChannel ? row.levels.nextEntry : null;
  })();
  const candles = useQuery({
    queryKey: ['signal-candles', instId],
    queryFn: () => api.candles({ instId: instId ?? '', bar: '1D', limit: 120 }),
    enabled: wantsLevel && instId !== null && channelBars !== null && rowLevel === null,
    staleTime: 5 * 60_000,
  });
  const channelLevel = rowLevel ?? (wantsLevel && channelBars !== null ? channelLevelOf(candles.data, channelBars, direction) : null);
  // The stop the order will have: the one typed, or, with none, the one channel trailing puts after the fill (which
  // the exchange cannot move to the entry after the first take-profit: stopAttached).
  const exitStop = stopOrNull ?? channelLevel;
  const exitStopAttached = stopOrNull !== null;
  const exitCtx = useMemo(
    (): ExitContext => ({ direction, entry: exitEntry, stop: exitStop, stopAttached: exitStopAttached, inst, whole: true, contracts: exitContracts }),
    [direction, exitEntry, exitStop, exitStopAttached, inst, exitContracts],
  );
  // The take-profit levels left to the program follow the stop (R multiples with one on the losing side, percentages
  // without); the cost-price stop only with a stop attached to the order.
  const hasStop = riskDistance(exitCtx) !== null;
  const breakevenOk = stopAttachedOf(exitCtx);
  const breakevenWas = useRef(breakevenOk);
  useEffect(() => {
    // a stop attached where the channel's stood in: the levels stay, a ladder left to the program takes the cost-price stop again
    const attachedNow = breakevenOk && !breakevenWas.current;
    breakevenWas.current = breakevenOk;
    setForm((f) => {
      if (!f.exitsOn) return f;
      const exits = proposeLevels(f.exits, hasStop, true, false, breakevenOk, attachedNow);
      return exits === f.exits ? f : { ...f, exits };
    });
  }, [hasStop, breakevenOk]);
  // A stop typed on the wrong side of the entry (at or above it for a buy, at or below it for a sell): the server refuses it.
  const stopTyped = safeDecimal(stopOrNull);
  const stopWrong = opening && stopTyped !== null && stopTyped.gt(0) && safeDecimal(exitEntry) !== null && riskDistance({ direction, entry: exitEntry, stop: stopOrNull }) === null;

  // The order is previewed with the parts of the exit plan that are complete, so its figures stay while a leg is
  // being written; it is submitted only once every part is. While the position mode is unknown nothing is previewed:
  // the request would be built for net mode.
  const checked = useMemo((): ExitFormCheck | null => (exitsActive ? checkExitForm(form.exits, exitCtx) : null), [exitsActive, form.exits, exitCtx]);
  // ... and without a stop on the wrong side, which the server refuses: the figures stay, the stop field says why, and nothing is submitted.
  const request = useMemo(
    () => (posMode === null ? null : buildRequest({ ...form, exitsOn: exitsActive, slTriggerPx: stopWrong ? '' : form.slTriggerPx }, instId, posMode, checked?.fields)),
    [form, instId, posMode, exitsActive, checked, stopWrong],
  );
  const preview = useOrderPreview(request);
  const exitError = checked?.errors[0];
  const exitProblem = exitError === undefined ? null : exitErrorText(exitError, form.exits, exitCtx, t).text;
  const exitsOk = exitProblem === null;

  const flow = usePlaceOrder('pgw', ({ order }) => {
    pushToast('success', t.ticket.placed(order, intentOf(order.side, order.posSide)), { kind: 'journal', instId: order.instId, mgnMode: order.tdMode, posSide: order.posSide, ordId: order.ordId });
  });
  // The message is about the order as it was submitted: any edit makes it a different one.
  const { clearError } = flow;
  useEffect(() => clearError(), [form, clearError]);

  const submit = () => {
    if (preview.request === null || !preview.canSubmit || tradingBlock !== null) return;
    flow.submit(preview.request);
  };

  if (inst === null) {
    return (
      <Panel title={t.ticket.title} pad>
        <div className="empty">{t.ticket.selectInstrument}</div>
      </Panel>
    );
  }

  // The kill switch is not a gate here: the server still accepts closing orders, and its verdict is in the preview.
  const disabled = tradingBlock !== null || !preview.canSubmit || !exitsOk || stopWrong || flow.isPending;
  const closing = longShort && form.reduceOnly;
  const posSide = derivePosSide(form.side, form.reduceOnly);
  // Once the server has answered for this exact form the button says what the server understood.
  const intent = !longShort ? null : preview.isCurrent && preview.preview !== undefined ? intentOf(preview.preview.side, preview.preview.posSide) : intentOf(form.side, posSide);
  // What the form still lacks for a preview; and why the button is disabled (said under it) while the order was previewed without a part the form holds.
  const missing = form.sizeValue.trim() === '' ? t.preview.enterSize : needsPrice(form.ordType) && form.px.trim() === '' ? t.preview.enterPrice : t.preview.incomplete;
  const why = tradingBlock !== null || flow.isPending ? null : exitProblem !== null ? t.follow.whyExits(exitProblem) : stopWrong ? `${t.ticket.stopMark}: ${t.ticket.stopWrongSide(direction === 'short')}` : null;
  const entryNote = marketExits && exitsActive && form.exitEntryPx !== null ? t.exits.entryFrozen(fmtPx(form.exitEntryPx, inst)) : null;
  return (
    <Panel title={t.ticket.title} className={flash ? 'panel-flash' : ''} extra={<span className="num">{inst.instId}</span>} pad>
      <div className="form">
        {killSwitch && <div className="notice notice-danger">{t.ticket.killSwitchNotice}</div>}
        {tradingBlock !== null && <div className="notice notice-warn">{tradingBlock[lang]}</div>}
        <div className="btn-group">
          <button className={`btn grow${form.side === 'buy' ? ' active buy' : ''}`} onClick={() => patch({ side: 'buy' })}>
            {closing ? t.ticket.buyCloseShort : t.ticket.buyLong}
          </button>
          <button className={`btn grow${form.side === 'sell' ? ' active sell' : ''}`} onClick={() => patch({ side: 'sell' })}>
            {closing ? t.ticket.sellCloseLong : t.ticket.sellShort}
          </button>
        </div>

        <div className="field-row">
          <div className="field">
            <label>{t.ticket.type}</label>
            <select value={form.ordType} onChange={(e) => patch({ ordType: e.target.value as TicketForm['ordType'] })}>
              {ORD_TYPES.map((o) => (
                <option key={o} value={o}>
                  {t.enums.ordType[o]}
                </option>
              ))}
            </select>
          </div>
          <div className="field">
            <label>{t.ticket.margin}</label>
            <select value={form.tdMode} onChange={(e) => patch({ tdMode: e.target.value as TicketForm['tdMode'] })}>
              <option value="cross">{t.enums.mgnMode.cross}</option>
              <option value="isolated">{t.enums.mgnMode.isolated}</option>
            </select>
          </div>
        </div>

        {longShort && (
          <label className="check">
            <input type="checkbox" checked={form.reduceOnly} onChange={(e) => patch({ reduceOnly: e.target.checked })} />
            {t.ticket.closeExisting}
          </label>
        )}

        {needsPrice(form.ordType) && (
          <div className="field">
            <label>
              {t.common.price} <span className="dim">{t.ticket.tick(inst.tickSz)}</span>
            </label>
            <input ref={priceInput} className="num" inputMode="decimal" value={form.px} placeholder="0.0" onChange={(e) => patch({ px: e.target.value })} />
          </div>
        )}

        <div className="field">
          <label>
            {t.common.size} <span className="dim">{t.ticket.sizeHint(inst.minSz, inst.lotSz)}</span>
          </label>
          <div className="input-group">
            <input ref={sizeInput} className="num" inputMode="decimal" value={form.sizeValue} placeholder="0" onChange={(e) => patch({ sizeValue: e.target.value })} />
            <select value={form.sizeUnit} onChange={(e) => patch({ sizeUnit: e.target.value as TicketForm['sizeUnit'], restoreUnit: null })}>
              {SIZE_UNITS.map((u) => (
                <option key={u} value={u}>
                  {unitLabel(u, inst, t)}
                </option>
              ))}
            </select>
          </div>
        </div>

        {opening && (
          <div className="field">
            <label title={t.ticket.stopTitle}>
              {t.ticket.stopMark} <span className="dim">{t.ticket.stopHint(inst.tickSz)}</span>
            </label>
            <input className="num" inputMode="decimal" value={form.slTriggerPx} placeholder={t.ticket.none} onChange={(e) => patch({ slTriggerPx: e.target.value })} />
            {stopWrong && <div className="ticket-hint warn">{t.ticket.stopWrongSide(direction === 'short')}</div>}
          </div>
        )}

        {opening && exitsOffered === false && <div className="ticket-exits-off dim">{t.exits.unavailable}</div>}
        {opening && exitsOffered === true && (
          <div className={`ticket-exits${form.exitsOn ? ' open' : ''}`}>
            <button
              type="button"
              className="ticket-exits-toggle"
              aria-expanded={form.exitsOn}
              title={t.exits.sectionTitle}
              onClick={() => setForm((f) => ({ ...f, exitsOn: !f.exitsOn, exits: f.exitsOn ? f.exits : proposeLevels(f.exits, hasStop, true) }))}
            >
              <span className="chev">{form.exitsOn ? '▾' : '▸'}</span> {t.exits.section}
            </button>
            {form.exitsOn && <ExitPlanEditor form={form.exits} update={(change) => setForm((f) => ({ ...f, exits: change(f.exits) }))} ctx={exitCtx} channelLevel={channelLevel} entryNote={entryNote} />}
          </div>
        )}

        {posMode === 'net_mode' && (
          <label className="check">
            <input type="checkbox" checked={form.reduceOnly} onChange={(e) => patch({ reduceOnly: e.target.checked })} />
            {t.ticket.reduceOnly}
          </label>
        )}

        <LeverageControl inst={inst} tdMode={form.tdMode} posSide={posSide} longShort={longShort} />

        <PreviewPanel preview={preview.preview} error={preview.error} isFetching={preview.isFetching} inst={inst} hint={missing} problem={exitProblem} />

        <button
          className={`btn ${form.side === 'buy' ? 'btn-buy' : 'btn-sell'}`}
          disabled={disabled}
          onClick={submit}
          title={tradingBlock !== null ? tradingBlock[lang] : why ?? (preview.request === null ? t.ticket.completeForm : describeRequest(preview.request, t))}
        >
          {flow.isPending ? t.ticket.submitting : t.ticket.submitLabel(intent, form.side, inst.baseCcy, labelOf(t.enums.ordType, form.ordType))}
        </button>
        {why !== null && <div className="ticket-hint warn ticket-why">{why}</div>}
        {flow.error !== null && (
          <div className="notice notice-danger" role="alert">
            {flow.error[lang]}
          </div>
        )}
      </div>
    </Panel>
  );
}
