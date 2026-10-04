import { useEffect, useMemo, useRef, useState } from 'react';
import { useMutation } from '@tanstack/react-query';
import type { Localized, PlaceOrderRequest } from '@pegasus/shared';
import { errorText, inEveryLang, labelOf, rejectionText, useLang, useT, type Messages } from '../i18n';
import { api } from '../lib/api';
import { isApiError } from '../lib/http';
import { getSelectedInstrument, getKillSwitch, getTradingBlock, useStore } from '../store/store';
import { Panel } from './Panel';
import { LeverageControl } from './ticket/LeverageControl';
import { PreviewPanel } from './ticket/PreviewPanel';
import { ORD_TYPES, SIZE_UNITS, buildRequest, defaultForm, derivePosSide, describeRequest, intentOf, needsPrice, newClOrdId, unitLabel, type TicketForm } from './ticket/form';
import { useOrderPreview } from './ticket/useOrderPreview';

/** Failures after which the order may or may not be on the exchange. */
const UNKNOWN_OUTCOME_CODES: readonly string[] = ['NETWORK', 'INTERNAL', 'EXCHANGE_UNREACHABLE', 'ORDER_STATUS_UNKNOWN'];
/** 5xx answers that are nevertheless definite: the exchange refused the order, or the server refused before sending anything. */
const NOT_SENT_CODES: readonly string[] = ['EXCHANGE', 'NO_PRICE', 'NO_BOOK', 'NO_DATA', 'LEVERAGE_UNAVAILABLE', 'NOT_CONNECTED'];
/** OKX's code for a client order id that is already in use. */
const OKX_DUPLICATE_CL_ORD_ID = '51016';

function outcomeUnknown(e: unknown): boolean {
  if (!isApiError(e)) return true;
  if (UNKNOWN_OUTCOME_CODES.includes(e.code) || e.status === 0) return true;
  return e.status >= 500 && !NOT_SENT_CODES.includes(e.code);
}

interface Attempt {
  /** The request without its client order id */
  key: string;
  clOrdId: string;
  /** Whether the id was already used by an earlier attempt whose outcome is unknown */
  retry: boolean;
  unknown: boolean;
}

export function OrderTicket() {
  const t = useT();
  const lang = useLang();
  const inst = useStore(getSelectedInstrument);
  const posMode = useStore((s) => s.account?.posMode ?? null);
  const killSwitch = useStore(getKillSwitch);
  const tradingBlock = useStore(getTradingBlock);
  const ticketPrice = useStore((s) => s.ticketPrice);
  const ticketPrefill = useStore((s) => s.ticketPrefill);
  const pushToast = useStore((s) => s.pushToast);
  const [form, setForm] = useState<TicketForm>(defaultForm);
  const patch = (p: Partial<TicketForm>) => setForm((f) => ({ ...f, ...p }));

  const instId = inst?.instId ?? null;
  useEffect(() => {
    // The close checkbox and a unit that a pre-fill brought belong to the instrument they were set for.
    setForm((f) => ({ ...f, px: '', slTriggerPx: '', sizeValue: '', reduceOnly: false, sizeUnit: f.restoreUnit ?? f.sizeUnit, restoreUnit: null }));
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

  const longShort = posMode === 'long_short_mode';
  // While the position mode is unknown nothing is previewed: the request would be built for net mode.
  const request = useMemo(() => (posMode === null ? null : buildRequest(form, instId, posMode)), [form, instId, posMode]);
  const preview = useOrderPreview(request);

  // What is shown under the submit button after a failed submit, in both languages: it follows a switch of the language.
  const [submitError, setSubmitError] = useState<Localized | null>(null);
  // The message is about the order as it was submitted: any edit makes it a different one.
  useEffect(() => setSubmitError(null), [form]);
  const attempt = useRef<Attempt | null>(null);

  const place = useMutation({
    mutationFn: (req: PlaceOrderRequest) => api.placeOrder(req),
    onSuccess: ({ order }) => {
      attempt.current = null;
      setSubmitError(null);
      pushToast('success', t.ticket.placed(order, intentOf(order.side, order.posSide)));
    },
    onError: (e) => {
      const retry = attempt.current?.retry ?? false;
      const failed = submitFailure(e, retry);
      if (attempt.current !== null) attempt.current = { ...attempt.current, unknown: failed.unknown };
      const text = inEveryLang(failed.text);
      setSubmitError(text);
      pushToast('error', text);
    },
  });

  const submit = () => {
    if (preview.request === null || !preview.canSubmit || tradingBlock !== null) return;
    const key = JSON.stringify(preview.request);
    // The same order again after an unknown outcome carries the same id, so the server can look the first attempt up before sending anything.
    // OKX itself refuses the id as a duplicate only while the first order still rests: a filled order frees its id.
    // The retry is marked as one because the server's own memory of the id is lost when it restarts.
    const last = attempt.current;
    const retry = last !== null && last.unknown && last.key === key;
    const clOrdId = retry ? last.clOrdId : newClOrdId();
    attempt.current = { key, clOrdId, retry, unknown: false };
    place.mutate(retry ? { ...preview.request, clOrdId, retry: true } : { ...preview.request, clOrdId });
  };

  if (inst === null) {
    return (
      <Panel title={t.ticket.title} pad>
        <div className="empty">{t.ticket.selectInstrument}</div>
      </Panel>
    );
  }

  // The kill switch is not a gate here: the server still accepts closing orders, and its verdict is in the preview.
  const disabled = tradingBlock !== null || !preview.canSubmit || place.isPending;
  const closing = longShort && form.reduceOnly;
  const posSide = derivePosSide(form.side, form.reduceOnly);
  // Once the server has answered for this exact form the button says what the server understood.
  const intent = !longShort ? null : preview.isCurrent && preview.preview !== undefined ? intentOf(preview.preview.side, preview.preview.posSide) : intentOf(form.side, posSide);
  return (
    <Panel title={t.ticket.title} extra={<span className="num">{inst.instId}</span>} pad>
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
            <input className="num" inputMode="decimal" value={form.px} placeholder="0.0" onChange={(e) => patch({ px: e.target.value })} />
          </div>
        )}

        <div className="field">
          <label>
            {t.common.size} <span className="dim">{t.ticket.sizeHint(inst.minSz, inst.lotSz)}</span>
          </label>
          <div className="input-group">
            <input className="num" inputMode="decimal" value={form.sizeValue} placeholder="0" onChange={(e) => patch({ sizeValue: e.target.value })} />
            <select value={form.sizeUnit} onChange={(e) => patch({ sizeUnit: e.target.value as TicketForm['sizeUnit'], restoreUnit: null })}>
              {SIZE_UNITS.map((u) => (
                <option key={u} value={u}>
                  {unitLabel(u, inst, t)}
                </option>
              ))}
            </select>
          </div>
        </div>

        {!form.reduceOnly && (
          <div className="field">
            <label title={t.ticket.stopTitle}>
              {t.ticket.stopMark} <span className="dim">{t.ticket.stopHint(inst.tickSz)}</span>
            </label>
            <input className="num" inputMode="decimal" value={form.slTriggerPx} placeholder={t.ticket.none} onChange={(e) => patch({ slTriggerPx: e.target.value })} />
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
          {place.isPending ? t.ticket.submitting : t.ticket.submitLabel(intent, form.side, inst.baseCcy, labelOf(t.enums.ordType, form.ordType))}
        </button>
        {submitError !== null && (
          <div className="notice notice-danger" role="alert">
            {submitError[lang]}
          </div>
        )}
      </div>
    </Panel>
  );
}

/** Why a submit failed, as a text for either dictionary, and whether the order may nevertheless be on the exchange. */
function submitFailure(e: unknown, retry: boolean): { text: (t: Messages) => string; unknown: boolean } {
  if (retry && isApiError(e) && e.code === 'EXCHANGE' && e.details?.['okxCode'] === OKX_DUPLICATE_CL_ORD_ID) {
    return { text: (t) => t.ticket.errDuplicate, unknown: false };
  }
  if (outcomeUnknown(e)) return { text: (t) => t.ticket.errUnknown(errorText(e, t)), unknown: true };
  return { text: (t) => t.ticket.errRejected(errorText(e, t), rejectionText(e, t)), unknown: false };
}
