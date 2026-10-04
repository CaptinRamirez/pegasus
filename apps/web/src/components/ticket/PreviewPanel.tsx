import type { Instrument } from '@pegasus/shared';
import type { OrderPreview } from '../../lib/api';
import { errorMessage, isApiError } from '../../lib/http';
import { fmtNum, fmtPct, fmtPx } from '../../lib/format';
import { intentOf } from './form';

interface Props {
  preview: OrderPreview | undefined;
  error: unknown;
  isFetching: boolean;
  inst: Instrument | null;
}

function details(e: unknown): string | null {
  if (!isApiError(e) || e.details === undefined) return null;
  const d = e.details;
  if (e.code === 'RISK_REJECTED' && typeof d['message'] === 'string') return d['message'];
  if (e.code === 'EXCHANGE' && typeof d['okxMsg'] === 'string') return d['okxMsg'];
  return null;
}

export function PreviewPanel({ preview, error, isFetching, inst }: Props) {
  if (error !== null && error !== undefined) {
    const extra = details(error);
    return (
      <div className="preview rejected">
        <div className="risk-msg bad" style={{ borderTop: 0, marginTop: 0, paddingTop: 0 }}>
          {errorMessage(error)}
          {extra !== null && <div className="muted">{extra}</div>}
        </div>
      </div>
    );
  }
  if (preview === undefined) {
    return <div className="preview dim">{isFetching ? 'Previewing…' : 'Enter a size to preview the order'}</div>;
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
          <span>Action</span>
          <b className={preview.side === 'buy' ? 'pos' : 'neg'}>
            {intent} ({preview.side})
          </b>
        </div>
      )}
      <div className="kv num">
        <span>Contracts</span>
        <span>{preview.sz}</span>
      </div>
      <div className="kv num">
        <span>Coin</span>
        <span>
          {preview.coin} {inst?.baseCcy ?? ''}
        </span>
      </div>
      <div className="kv num">
        <span>{isMarket ? 'Ref price' : 'Price'}</span>
        <span>{fmtPx(isMarket ? preview.refPrice : preview.px, inst)}</span>
      </div>
      <div className="kv num">
        <span>Notional</span>
        <span>
          {fmtNum(preview.notionalQuote)} {quote}
        </span>
      </div>
      {isMarket && (
        <div className="kv num">
          <span>Est. slippage</span>
          <span>{preview.estSlippagePct === '' ? '–' : fmtPct(preview.estSlippagePct, 3)}</span>
        </div>
      )}
      <div className="kv num">
        <span>Leverage</span>
        <span>{preview.lever}x</span>
      </div>
      <div className={`risk-msg ${preview.risk.ok ? 'good' : 'bad'}`}>
        {preview.risk.ok ? (closing ? 'Closing order: limits not applied' : 'Risk check passed') : `${preview.risk.code}: ${preview.risk.message}`}
      </div>
    </div>
  );
}
