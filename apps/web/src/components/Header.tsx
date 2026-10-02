import { useMutation } from '@tanstack/react-query';
import type { ConnState } from '@pegasus/shared';
import { api } from '../lib/api';
import { errorMessage } from '../lib/http';
import { fmtNum, fmtSigned, signOf } from '../lib/format';
import { signOut } from '../store/session';
import { useStore } from '../store/store';

function Dot({ label, state }: { label: string; state: ConnState | 'open' | 'connecting' | 'closed' | undefined }) {
  return (
    <span className={`dot ${state ?? 'disconnected'}`} title={`${label}: ${state ?? 'unknown'}`}>
      {label}
    </span>
  );
}

export function Header() {
  const demo = useStore((s) => s.demo);
  const connection = useStore((s) => s.connection);
  const wsStatus = useStore((s) => s.wsStatus);
  const balance = useStore((s) => s.balance);
  const risk = useStore((s) => s.risk);
  const applyMessage = useStore((s) => s.applyMessage);
  const pushToast = useStore((s) => s.pushToast);

  const killSwitch = risk?.killSwitch ?? false;
  const equity = balance?.totalEq ?? risk?.currentEquity ?? null;
  const dailyPnl = risk?.dailyPnl ?? null;

  const toggle = useMutation({
    mutationFn: (enabled: boolean) =>
      api.setKillSwitch(enabled ? { enabled, reason: 'manual (terminal)' } : { enabled }),
    onSuccess: (state) => {
      applyMessage({ type: 'risk', data: state });
      pushToast('success', state.killSwitch ? 'Kill switch engaged: trading halted' : 'Kill switch released');
    },
    onError: (e) => pushToast('error', errorMessage(e)),
  });

  const onToggle = () => {
    const next = !killSwitch;
    const text = next
      ? 'Engage the kill switch? New orders will be rejected until it is released.'
      : 'Release the kill switch and allow trading again?';
    if (window.confirm(text)) toggle.mutate(next);
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
