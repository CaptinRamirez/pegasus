import { D, type CancelSweepState, type DecimalInput } from '@pegasus/shared';
import { Panel } from './Panel';
import { fmtNum, fmtPct, fmtSigned, fmtUtcMinute, safeDecimal, signOf } from '../lib/format';
import { useStore } from '../store/store';

/** Ratio used/limit as a 0..100 number (chart coordinate only). */
function usagePct(used: DecimalInput | null | undefined, limit: DecimalInput | null | undefined): number {
  const u = safeDecimal(used);
  const l = safeDecimal(limit);
  if (u === null || l === null || l.lte(0)) return 0;
  return Math.max(0, Math.min(100, Number(u.abs().div(l).mul(100).toFixed(1))));
}

function Meter({ pct, tone }: { pct: number; tone: 'pos' | 'neg' | 'warn' | '' }) {
  return (
    <div className={`bar ${tone}`}>
      <div style={{ width: `${pct}%` }} />
    </div>
  );
}

/** The first balance of a UTC day arrives up to a reconcile (60 s) after 00:00; a baseline within this of the day start is the day start. */
const DAY_START_TOLERANCE_MS = 5 * 60_000;

const SWEEP_TONE: Record<CancelSweepState, string> = {
  idle: '',
  pending: 'notice-warn',
  done: 'notice-ok',
  failed: 'notice-danger',
  skipped: 'notice-warn',
};

export function RiskPanel() {
  const config = useStore((s) => s.riskConfig);
  const state = useStore((s) => s.risk);
  const openOrdersLocal = useStore((s) => Object.keys(s.orders).length);

  if (config === null) {
    return (
      <Panel title="Risk" pad>
        <div className="empty">No risk config yet</div>
      </Panel>
    );
  }

  const dailyPnl = state?.dailyPnl ?? null;
  // "Daily" is only the whole UTC day when the baseline was taken at its start: after a later start of the
  // terminal, or a rebase, the PnL counts from that moment and the label says so ("09:12 UTC").
  const since = state !== null && state.baselineTs - state.dayStartTs > DAY_START_TOLERANCE_MS ? fmtUtcMinute(state.baselineTs).slice(-9) : null;
  const lossUsed = dailyPnl !== null && D(dailyPnl).lt(0) ? D(dailyPnl).abs() : D(0);
  const lossPct = usagePct(lossUsed, config.dailyLossLimit);
  const notionalPct = usagePct(state?.totalPositionNotional, config.maxTotalPositionNotional);
  const openOrders = state?.openOrders ?? openOrdersLocal;
  const ordersPct = config.maxOpenOrders > 0 ? Math.min(100, (openOrders / config.maxOpenOrders) * 100) : 0;

  return (
    <Panel title="Risk" pad>
      {state?.killSwitch === true && (
        <div className="notice notice-danger" style={{ marginBottom: 8 }}>
          KILL SWITCH ON{state.killSwitchReason !== '' ? ` — ${state.killSwitchReason}` : ''}
          {state.killSwitchReason.startsWith('STATE_FILE_UNREADABLE') && <div>状态文件无法读取，为安全起见已暂停开仓；确认账户无误后可手动解除。</div>}
        </div>
      )}
      {state?.killSwitch === true && state.cancelSweep.state !== 'idle' && (
        <div className={`notice ${SWEEP_TONE[state.cancelSweep.state]}`} style={{ marginBottom: 8 }}>
          Cancel all open orders: {state.cancelSweep.message}
          {state.cancelSweep.state === 'failed' || state.cancelSweep.state === 'skipped' ? '. Open orders are NOT cancelled; cancel them on OKX.' : ''}
        </div>
      )}
      <div className="kv-list">
        <span className="k">Daily PnL{since !== null ? ` since ${since}` : ''}</span>
        <span className={`v num ${signOf(dailyPnl)}`}>
          {fmtSigned(dailyPnl)} / -{fmtNum(config.dailyLossLimit, 0)} USD
        </span>
      </div>
      <Meter pct={lossPct} tone={lossPct >= 80 ? 'neg' : lossPct >= 50 ? 'warn' : 'pos'} />

      <div className="kv-list">
        <span className="k">Position notional</span>
        <span className="v num">
          {fmtNum(state?.totalPositionNotional ?? null, 0)} / {fmtNum(config.maxTotalPositionNotional, 0)} USD
        </span>
      </div>
      <Meter pct={notionalPct} tone={notionalPct >= 90 ? 'neg' : notionalPct >= 70 ? 'warn' : ''} />

      <div className="kv-list">
        <span className="k">Open orders</span>
        <span className="v num">
          {openOrders} / {config.maxOpenOrders}
        </span>
      </div>
      <Meter pct={ordersPct} tone={ordersPct >= 90 ? 'neg' : ''} />

      <div className="kv-list">
        <span className="k">Max order notional</span>
        <span className="v num">{fmtNum(config.maxOrderNotional, 0)} USD</span>
        <span className="k">Max per instrument</span>
        <span className="v num">{fmtNum(config.maxPositionNotionalPerInstrument, 0)} USD</span>
        <span className="k">Max leverage</span>
        <span className="v num">{config.maxLeverage}x</span>
        <span className="k">Price band</span>
        <span className="v num">{fmtPct(config.priceBandPct, 2)}</span>
        <span className="k">Max slippage</span>
        <span className="v num">{fmtPct(config.maxSlippagePct, 2)}</span>
        <span className="k">{since !== null ? 'Baseline equity' : 'Day start equity'}</span>
        <span className="v num">{fmtNum(state?.dayStartEquity ?? null)}</span>
        <span className="k">Current equity</span>
        <span className="v num">{fmtNum(state?.currentEquity ?? null)}</span>
      </div>
    </Panel>
  );
}
