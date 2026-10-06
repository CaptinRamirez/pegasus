import { useEffect, useMemo, useRef, useState } from 'react';
import { labelOf, useLang, useT } from '../i18n';
import { defaultExitForm } from '../lib/exits';
import { useTrailing } from '../hooks/useTrailing';
import { getSelectedInstrument, getSelectedMarket, getKillSwitch, getTradingBlock, useStore } from '../store/store';
import { ExitPlanEditor } from './exits/ExitPlanEditor';
import { Panel } from './Panel';
import { LeverageControl } from './ticket/LeverageControl';
import { PreviewPanel } from './ticket/PreviewPanel';
import { ORD_TYPES, SIZE_UNITS, buildRequest, defaultForm, derivePosSide, describeRequest, exitFieldsOf, intentOf, needsPrice, unitLabel, type TicketForm } from './ticket/form';
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
    setForm((f) => ({ ...f, px: '', slTriggerPx: '', sizeValue: '', reduceOnly: false, sizeUnit: f.restoreUnit ?? f.sizeUnit, restoreUnit: null, exits: defaultExitForm(), exitsOn: false }));
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
    setForm((f) => ({ ...f, side: ticketFocus.side, px: '', slTriggerPx: '', sizeValue: '', reduceOnly: false, exits: defaultExitForm(), exitsOn: false }));
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
  const exitEntry = needsPrice(form.ordType) ? (form.px.trim() === '' ? null : form.px.trim()) : lastPx;
  const exitsActive = opening && form.exitsOn && exitsOffered === true;
  // While the position mode is unknown nothing is previewed: the request would be built for net mode.
  const request = useMemo(
    () => (posMode === null ? null : buildRequest({ ...form, exitsOn: exitsActive }, instId, posMode, { entry: exitEntry, inst })),
    [form, instId, posMode, exitEntry, inst, exitsActive],
  );
  const preview = useOrderPreview(request);
  const exitBuilt = exitsActive ? exitFieldsOf(form, { entry: exitEntry, inst }) : null;

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
  const disabled = tradingBlock !== null || !preview.canSubmit || flow.isPending;
  const closing = longShort && form.reduceOnly;
  const posSide = derivePosSide(form.side, form.reduceOnly);
  // Once the server has answered for this exact form the button says what the server understood.
  const intent = !longShort ? null : preview.isCurrent && preview.preview !== undefined ? intentOf(preview.preview.side, preview.preview.posSide) : intentOf(form.side, posSide);
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
          </div>
        )}

        {opening && exitsOffered === false && <div className="ticket-exits-off dim">{t.exits.unavailable}</div>}
        {opening && exitsOffered === true && (
          <div className={`ticket-exits${form.exitsOn ? ' open' : ''}`}>
            <button type="button" className="ticket-exits-toggle" aria-expanded={form.exitsOn} title={t.exits.sectionTitle} onClick={() => patch({ exitsOn: !form.exitsOn })}>
              <span className="chev">{form.exitsOn ? '▾' : '▸'}</span> {t.exits.section}
            </button>
            {form.exitsOn && (
              <ExitPlanEditor
                form={form.exits}
                update={(change) => setForm((f) => ({ ...f, exits: change(f.exits) }))}
                ctx={{ direction: form.side === 'buy' ? 'long' : 'short', entry: exitEntry, stop: form.slTriggerPx.trim() === '' ? null : form.slTriggerPx.trim(), inst, whole: true }}
                error={exitBuilt !== null && !exitBuilt.ok ? exitBuilt.error : null}
              />
            )}
          </div>
        )}

        {posMode === 'net_mode' && (
          <label className="check">
            <input type="checkbox" checked={form.reduceOnly} onChange={(e) => patch({ reduceOnly: e.target.checked })} />
            {t.ticket.reduceOnly}
          </label>
        )}

        <LeverageControl inst={inst} tdMode={form.tdMode} posSide={posSide} longShort={longShort} />

        <PreviewPanel preview={preview.preview} error={preview.error} isFetching={preview.isFetching} inst={inst} />

        <button
          className={`btn ${form.side === 'buy' ? 'btn-buy' : 'btn-sell'}`}
          disabled={disabled}
          onClick={submit}
          title={tradingBlock !== null ? tradingBlock[lang] : preview.request === null ? t.ticket.completeForm : describeRequest(preview.request, t)}
        >
          {flow.isPending ? t.ticket.submitting : t.ticket.submitLabel(intent, form.side, inst.baseCcy, labelOf(t.enums.ordType, form.ordType))}
        </button>
        {flow.error !== null && (
          <div className="notice notice-danger" role="alert">
            {flow.error[lang]}
          </div>
        )}
      </div>
    </Panel>
  );
}
