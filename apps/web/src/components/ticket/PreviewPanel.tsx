import type { Instrument } from '@pegasus/shared';
import { errorText, rejectionText, riskText, useT, type Messages } from '../../i18n';
import type { OrderPreview } from '../../lib/api';
import { isApiError } from '../../lib/http';
import { fmtNum, fmtPct, fmtPx } from '../../lib/format';
import { intentOf } from './form';

interface Props {
  preview: OrderPreview | undefined;
  error: unknown;
  isFetching: boolean;
  inst: Instrument | null;
}

function details(e: unknown, t: Messages): string | null {
  if (!isApiError(e) || e.details === undefined) return null;
  const d = e.details;
  if (e.code === 'RISK_REJECTED') return rejectionText(e, t);
  if (e.code === 'EXCHANGE' && typeof d['okxMsg'] === 'string') return d['okxMsg'];
  return null;
}

export function PreviewPanel({ preview, error, isFetching, inst }: Props) {
  const t = useT();
  if (error !== null && error !== undefined) {
    const extra = details(error, t);
    return (
      <div className="preview rejected">
        <div className="risk-msg bad" style={{ borderTop: 0, marginTop: 0, paddingTop: 0 }}>
          {errorText(error, t)}
          {extra !== null && <div className="muted">{extra}</div>}
        </div>
      </div>
    );
  }
  if (preview === undefined) {
    return <div className="preview dim">{isFetching ? t.preview.previewing : t.preview.enterSize}</div>;
  }
  const quote = inst?.quoteCcy ?? 'USD';
  const isMarket = preview.ordType === 'market';
  // Taken from the server's own reading of the order, not from the form.
  const intent = intentOf(preview.side, preview.posSide);
  const closing = intent === 'Close long' || intent === 'Close short';
  return (
    <div className={`preview${preview.risk.ok ? '' : ' rejected'}`} style={{ opacity: isFetching ? 0.7 : 1 }}>
      {intent !== null && (
        <div className="kv">
          <span>{t.preview.action}</span>
          <b className={preview.side === 'buy' ? 'pos' : 'neg'}>
            {t.enums.intent[intent]} ({t.enums.side[preview.side]})
          </b>
        </div>
      )}
      <div className="kv num">
        <span>{t.preview.contracts}</span>
        <span>{preview.sz}</span>
      </div>
      <div className="kv num">
        <span>{t.preview.coin}</span>
        <span>
          {preview.coin} {inst?.baseCcy ?? ''}
        </span>
      </div>
      <div className="kv num">
        <span>{isMarket ? t.preview.refPrice : t.common.price}</span>
        <span>{fmtPx(isMarket ? preview.refPrice : preview.px, inst)}</span>
      </div>
      <div className="kv num">
        <span>{t.preview.notional}</span>
        <span>
          {fmtNum(preview.notionalQuote)} {quote}
        </span>
      </div>
      {isMarket && (
        <div className="kv num">
          <span>{t.preview.estSlippage}</span>
          <span>{preview.estSlippagePct === '' ? '–' : fmtPct(preview.estSlippagePct, 3)}</span>
        </div>
      )}
      <div className="kv num">
        <span>{t.leverage.label}</span>
        <span>{preview.lever}x</span>
      </div>
      {preview.slTriggerPx !== '' && (
        <>
          <div className="kv num">
            <span>{t.ticket.stopMark}</span>
            <span>{fmtPx(preview.slTriggerPx, inst)}</span>
          </div>
          <div className="kv num">
            <span>{t.preview.lossAtStop}</span>
            <span className="neg">{preview.stopLossQuote === '' ? '–' : `${fmtNum(preview.stopLossQuote)} ${quote}`}</span>
          </div>
        </>
      )}
      <div className={`risk-msg ${preview.risk.ok ? 'good' : 'bad'}`}>
        {preview.risk.ok ? (closing ? t.preview.closingOk : t.preview.riskOk) : `${preview.risk.code}: ${riskText(preview.risk, t)}`}
      </div>
    </div>
  );
}
