import { useMutation } from '@tanstack/react-query';
import type { ConnState, KillSwitchRequest } from '@pegasus/shared';
import { api } from '../lib/api';
import { errorMessage, isApiError } from '../lib/http';
import { fmtNum, fmtSigned, signOf } from '../lib/format';
import { killSwitchSweepNotice } from '../store/alerts';
import { signOut } from '../store/session';
import { useStore } from '../store/store';

function Dot({ label, state }: { label: string; state: ConnState | 'open' | 'connecting' | 'closed' | undefined }) {
  return (
    <span className={`dot ${state ?? 'disconnected'}`} title={`${label}: ${state ?? 'unknown'}`}>
      {label}
    </span>
  );
}

/** The second question of a release that the server refused with DAILY_LOSS_ACTIVE; `details` are that refusal's. */
function rebaseQuestion(details: Record<string, unknown> | undefined): string {
  const value = (key: string): string | null => {
    const v = details?.[key];
    return typeof v === 'string' ? v : null;
  };
  return [
    `The daily loss limit is still in force: today's PnL is ${fmtSigned(value('dailyPnl'))} USD and the limit is -${fmtNum(value('limit'), 0)} USD.`,
    `Release anyway? Today's loss so far is then no longer counted: daily PnL restarts at 0 from the current equity (${fmtNum(value('equity'))} USD) and the limit applies again from there.`,
    'Do this only when the drop is not a trading loss, for example after moving money out of the account.',
    '当日亏损仍超过限额。确认解除后，日内盈亏将从当前权益重新计算；仅在资金划出等非交易亏损时使用。',
  ].join('\n\n');
}

export function Header() {
  const demo = useStore((s) => s.demo);
  const connection = useStore((s) => s.connection);
  const wsStatus = useStore((s) => s.wsStatus);
  const balance = useStore((s) => s.balance);
  const risk = useStore((s) => s.risk);
  const account = useStore((s) => s.account);
  const applyRiskReply = useStore((s) => s.applyRiskReply);
  const pushToast = useStore((s) => s.pushToast);

  const killSwitch = risk?.killSwitch ?? false;
  const equity = balance?.totalEq ?? risk?.currentEquity ?? null;
  const dailyPnl = risk?.dailyPnl ?? null;

  const toggle = useMutation({
    mutationFn: (body: KillSwitchRequest) => api.setKillSwitch(body),
    onSuccess: (state, body) => {
      applyRiskReply(state);
      const released = body.rebase === true ? 'Kill switch released: daily PnL now counts from the current equity' : 'Kill switch released';
      pushToast('success', state.killSwitch ? 'Kill switch engaged: trading halted' : released);
    },
    onError: (e, body) => {
      // The server refuses a plain release while the daily loss limit is still breached. Releasing anyway restarts
      // the day's baseline, which is asked for separately and in plain words.
      if (isApiError(e) && e.code === 'DAILY_LOSS_ACTIVE' && body.rebase !== true) {
        if (window.confirm(rebaseQuestion(e.details))) toggle.mutate({ enabled: false, rebase: true });
        return;
      }
      pushToast('error', errorMessage(e));
    },
  });

  const onToggle = () => {
    const next = !killSwitch;
    const text = next
      ? `Engage the kill switch?\n\n${killSwitchSweepNotice({ connection, account })}\n\nNew opening orders through Pegasus will be rejected until it is released.`
      : 'Release the kill switch and allow trading again?';
    if (window.confirm(text)) toggle.mutate(next ? { enabled: true, reason: 'manual (terminal)' } : { enabled: false });
  };

  return (
    <header className="header">
      <span className="brand">PEGASUS</span>
      <span className={`badge ${demo ? 'badge-demo' : 'badge-live'}`}>{demo ? 'DEMO' : 'LIVE'}</span>
      <div className="dots">
        <Dot label="ws" state={wsStatus} />
        <Dot label="public" state={connection?.okxPublic} />
        <Dot label="private" state={connection?.okxPrivate} />
        <Dot label="business" state={connection?.okxBusiness} />
      </div>
      <span className="grow" />
      <div className="stat">
        <span className="label">Equity</span>
        <span className="value num">{equity === null ? '–' : `${fmtNum(equity)} USD`}</span>
      </div>
      <div className="stat">
        <span className="label">Daily PnL</span>
        <span className={`value num ${signOf(dailyPnl)}`}>{fmtSigned(dailyPnl)}</span>
      </div>
      <button
        className={`btn ${killSwitch ? 'btn-danger' : 'btn-warn'}`}
        onClick={onToggle}
        disabled={toggle.isPending || risk === null}
        title={killSwitch ? risk?.killSwitchReason : 'Halt all trading'}
      >
        {killSwitch ? 'KILL SWITCH ON' : 'Kill switch'}
      </button>
      <a href="#" onClick={(e) => { e.preventDefault(); signOut(); }}>
        Sign out
      </a>
    </header>
  );
}
