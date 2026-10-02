import { useEffect, useMemo, useState } from 'react';
import { useMutation } from '@tanstack/react-query';
import type { PlaceOrderRequest } from '@pegasus/shared';
import { api } from '../lib/api';
import { errorMessage, isApiError } from '../lib/http';
import { getSelectedInstrument, getKillSwitch, useStore } from '../store/store';
import { Panel } from './Panel';
import { LeverageControl } from './ticket/LeverageControl';
import { PreviewPanel } from './ticket/PreviewPanel';
import { ORD_TYPES, SIZE_UNITS, buildRequest, defaultForm, describeRequest, needsPrice, unitLabel, type TicketForm } from './ticket/form';
import { useOrderPreview } from './ticket/useOrderPreview';

export function OrderTicket() {
  const inst = useStore(getSelectedInstrument);
  const posMode = useStore((s) => s.account?.posMode ?? null);
  const killSwitch = useStore(getKillSwitch);
  const ticketPrice = useStore((s) => s.ticketPrice);
  const pushToast = useStore((s) => s.pushToast);
  const [form, setForm] = useState<TicketForm>(defaultForm);
  const patch = (p: Partial<TicketForm>) => setForm((f) => ({ ...f, ...p }));

  const instId = inst?.instId ?? null;
  useEffect(() => {
    setForm((f) => ({ ...f, px: '', sizeValue: '' }));
  }, [instId]);

  useEffect(() => {
    if (ticketPrice !== null) setForm((f) => ({ ...f, px: ticketPrice.px }));
  }, [ticketPrice]);

  const longShort = posMode === 'long_short_mode';
  const request = useMemo(() => buildRequest(form, instId, posMode), [form, instId, posMode]);
  const preview = useOrderPreview(request);

  const place = useMutation({
    mutationFn: (req: PlaceOrderRequest) => api.placeOrder(req),
    onSuccess: ({ order }) => {
      pushToast('success', `Order ${order.state}: ${order.side} ${order.sz} contracts ${order.instId}${order.px !== '' ? ` @ ${order.px}` : ''} (${order.ordId})`);
    },
    onError: (e) => {
      const risk = isApiError(e) && e.code === 'RISK_REJECTED' && typeof e.details?.['message'] === 'string' ? ` — ${e.details['message']}` : '';
      pushToast('error', `Order rejected: ${errorMessage(e)}${risk}`);
    },
  });

  const submit = () => {
    if (preview.request === null || !preview.canSubmit) return;
    place.mutate(preview.request);
  };

  if (inst === null) {
    return (
      <Panel title="Order ticket" pad>
        <div className="empty">Select an instrument</div>
      </Panel>
    );
  }

  const disabled = killSwitch || !preview.canSubmit || place.isPending;
  return (
    <Panel title="Order ticket" extra={<span className="num">{inst.instId}</span>} pad>
      <div className="form">
        {killSwitch && <div className="notice notice-danger">Kill switch is on: orders are blocked</div>}
        <div className="btn-group">
          <button className={`btn grow${form.side === 'buy' ? ' active buy' : ''}`} onClick={() => patch({ side: 'buy' })}>
            Buy / Long
          </button>
          <button className={`btn grow${form.side === 'sell' ? ' active sell' : ''}`} onClick={() => patch({ side: 'sell' })}>
            Sell / Short
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
          <div className="field">
            <label>Position side</label>
            <select value={form.posSide} onChange={(e) => patch({ posSide: e.target.value as TicketForm['posSide'] })}>
              <option value="long">long</option>
              <option value="short">short</option>
            </select>
          </div>
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
            <select value={form.sizeUnit} onChange={(e) => patch({ sizeUnit: e.target.value as TicketForm['sizeUnit'] })}>
              {SIZE_UNITS.map((u) => (
                <option key={u} value={u}>
                  {unitLabel(u, inst)}
                </option>
              ))}
            </select>
          </div>
        </div>

        {!longShort && (
          <label className="check">
            <input type="checkbox" checked={form.reduceOnly} onChange={(e) => patch({ reduceOnly: e.target.checked })} />
            Reduce only
          </label>
        )}

        <LeverageControl inst={inst} tdMode={form.tdMode} posSide={form.posSide} longShort={longShort} />

        <PreviewPanel preview={preview.preview} error={preview.error} isFetching={preview.isFetching} inst={inst} />

        <button
          className={`btn ${form.side === 'buy' ? 'btn-buy' : 'btn-sell'}`}
          disabled={disabled}
          onClick={submit}
          title={preview.request === null ? 'Complete the form' : describeRequest(preview.request)}
        >
          {place.isPending ? 'Submitting…' : `${form.side === 'buy' ? 'Buy' : 'Sell'} ${inst.baseCcy} ${form.ordType}`}
        </button>
      </div>
    </Panel>
  );
}
