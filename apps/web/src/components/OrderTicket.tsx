import { useEffect, useMemo, useRef, useState } from 'react';
import { useMutation } from '@tanstack/react-query';
import type { PlaceOrderRequest } from '@pegasus/shared';
import { api } from '../lib/api';
import { errorMessage, isApiError } from '../lib/http';
import { blockTitle, getSelectedInstrument, getKillSwitch, getTradingBlock, useStore } from '../store/store';
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

/** What is shown under the submit button after a failed submit: English first, then a short Chinese line. */
interface SubmitError {
  en: string;
  zh: string | null;
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
    setForm((f) => ({ ...f, px: '', sizeValue: '', reduceOnly: false, sizeUnit: f.restoreUnit ?? f.sizeUnit, restoreUnit: null }));
  }, [instId]);

  useEffect(() => {
    if (ticketPrice !== null) setForm((f) => ({ ...f, px: ticketPrice.px }));
  }, [ticketPrice]);

  // Runs after the instId reset above (same commit when the prefill switched instrument), so the prefill wins.
  useEffect(() => {
    if (ticketPrefill === null || ticketPrefill.instId !== instId) return;
    const { side, ordType, px, sizeValue, sizeUnit } = ticketPrefill;
    setForm((f) => ({ ...f, side, ordType, px, sizeValue, sizeUnit, reduceOnly: false, restoreUnit: f.restoreUnit ?? f.sizeUnit }));
  }, [ticketPrefill, instId]);

  const longShort = posMode === 'long_short_mode';
  // While the position mode is unknown nothing is previewed: the request would be built for net mode.
  const request = useMemo(() => (posMode === null ? null : buildRequest(form, instId, posMode)), [form, instId, posMode]);
  const preview = useOrderPreview(request);

  const [submitError, setSubmitError] = useState<SubmitError | null>(null);
  // The message is about the order as it was submitted: any edit makes it a different one.
  useEffect(() => setSubmitError(null), [form]);
  const attempt = useRef<Attempt | null>(null);

  const place = useMutation({
    mutationFn: (req: PlaceOrderRequest) => api.placeOrder(req),
    onSuccess: ({ order }) => {
      attempt.current = null;
      setSubmitError(null);
      const intent = intentOf(order.side, order.posSide);
      pushToast('success', `Order ${order.state}: ${intent === null ? '' : `${intent}, `}${order.side} ${order.sz} contracts ${order.instId}${order.px !== '' ? ` @ ${order.px}` : ''} (${order.ordId})`);
    },
    onError: (e) => {
      const failed = submitFailure(e, attempt.current?.retry ?? false);
      if (attempt.current !== null) attempt.current = { ...attempt.current, unknown: failed.unknown };
      setSubmitError(failed.text);
      pushToast('error', failed.text.zh === null ? failed.text.en : `${failed.text.en}\n${failed.text.zh}`);
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
      <Panel title="Order ticket" pad>
        <div className="empty">Select an instrument</div>
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
    <Panel title="Order ticket" extra={<span className="num">{inst.instId}</span>} pad>
      <div className="form">
        {killSwitch && <div className="notice notice-danger">Kill switch is on: only orders that close or reduce a position are accepted</div>}
        {tradingBlock !== null && (
          <div className="notice notice-warn">
            {tradingBlock.en}
            <br />
            {tradingBlock.zh}
          </div>
        )}
        <div className="btn-group">
          <button className={`btn grow${form.side === 'buy' ? ' active buy' : ''}`} onClick={() => patch({ side: 'buy' })}>
            {closing ? 'Buy / Close short' : 'Buy / Long'}
          </button>
          <button className={`btn grow${form.side === 'sell' ? ' active sell' : ''}`} onClick={() => patch({ side: 'sell' })}>
            {closing ? 'Sell / Close long' : 'Sell / Short'}
          </button>
        </div>

        <div className="field-row">
          <div className="field">
            <label>Type</label>
            <select value={form.ordType} onChange={(e) => patch({ ordType: e.target.value as TicketForm['ordType'] })}>
              {ORD_TYPES.map((t) => (
                <option key={t} value={t}>
                  {t}
                </option>
              ))}
            </select>
          </div>
          <div className="field">
            <label>Margin</label>
            <select value={form.tdMode} onChange={(e) => patch({ tdMode: e.target.value as TicketForm['tdMode'] })}>
              <option value="cross">cross</option>
              <option value="isolated">isolated</option>
            </select>
          </div>
        </div>

        {longShort && (
          <label className="check">
            <input type="checkbox" checked={form.reduceOnly} onChange={(e) => patch({ reduceOnly: e.target.checked })} />
            Close / reduce existing position
          </label>
        )}

        {needsPrice(form.ordType) && (
          <div className="field">
            <label>
              Price <span className="dim">(tick {inst.tickSz})</span>
            </label>
            <input className="num" inputMode="decimal" value={form.px} placeholder="0.0" onChange={(e) => patch({ px: e.target.value })} />
          </div>
        )}

        <div className="field">
          <label>
            Size <span className="dim">(min {inst.minSz} / lot {inst.lotSz} contracts)</span>
          </label>
          <div className="input-group">
            <input className="num" inputMode="decimal" value={form.sizeValue} placeholder="0" onChange={(e) => patch({ sizeValue: e.target.value })} />
            <select value={form.sizeUnit} onChange={(e) => patch({ sizeUnit: e.target.value as TicketForm['sizeUnit'], restoreUnit: null })}>
              {SIZE_UNITS.map((u) => (
                <option key={u} value={u}>
                  {unitLabel(u, inst)}
                </option>
              ))}
            </select>
          </div>
        </div>

        {posMode === 'net_mode' && (
          <label className="check">
            <input type="checkbox" checked={form.reduceOnly} onChange={(e) => patch({ reduceOnly: e.target.checked })} />
            Reduce only
          </label>
        )}

        <LeverageControl inst={inst} tdMode={form.tdMode} posSide={posSide} longShort={longShort} />

        <PreviewPanel preview={preview.preview} error={preview.error} isFetching={preview.isFetching} inst={inst} />

        <button
          className={`btn ${form.side === 'buy' ? 'btn-buy' : 'btn-sell'}`}
          disabled={disabled}
          onClick={submit}
          title={tradingBlock !== null ? blockTitle(tradingBlock) : preview.request === null ? 'Complete the form' : describeRequest(preview.request)}
        >
          {place.isPending ? 'Submitting…' : `${intent === null ? '' : `${intent}: `}${form.side === 'buy' ? 'Buy' : 'Sell'} ${inst.baseCcy} ${form.ordType}`}
        </button>
        {submitError !== null && (
          <div className="notice notice-danger" role="alert">
            {submitError.en}
            {submitError.zh !== null && (
              <>
                <br />
                {submitError.zh}
              </>
            )}
          </div>
        )}
      </div>
    </Panel>
  );
}

function submitFailure(e: unknown, retry: boolean): { text: SubmitError; unknown: boolean } {
  if (retry && isApiError(e) && e.code === 'EXCHANGE' && e.details?.['okxCode'] === OKX_DUPLICATE_CL_ORD_ID) {
    return {
      text: { en: 'The earlier attempt did reach OKX; this retry was refused as a duplicate. Check Open orders.', zh: '上一次下单已到达 OKX，本次重试被拒绝，请查看当前委托' },
      unknown: false,
    };
  }
  if (outcomeUnknown(e)) {
    return {
      text: { en: `Order status unknown: check Positions, Fills and Open orders before retrying (${errorMessage(e)})`, zh: '订单状态未知：重试前请先查看持仓、成交和当前委托' },
      unknown: true,
    };
  }
  const risk = isApiError(e) && e.code === 'RISK_REJECTED' && typeof e.details?.['message'] === 'string' ? ` — ${e.details['message']}` : '';
  return { text: { en: `Order rejected: ${errorMessage(e)}${risk}`, zh: null }, unknown: false };
}
