import { useMutation } from '@tanstack/react-query';
import type { ConnState, KillSwitchRequest } from '@pegasus/shared';
import { errorText, useLang, useT } from '../i18n';
import { api } from '../lib/api';
import { isApiError } from '../lib/http';
import { fmtNum, fmtSigned, signOf } from '../lib/format';
import { killSwitchSweepNotice } from '../store/alerts';
import { signOut } from '../store/session';
import { useStore } from '../store/store';
import { LangSwitch } from './LangSwitch';

function Dot({ label, state }: { label: string; state: ConnState | 'open' | 'connecting' | 'closed' | undefined }) {
  const t = useT();
  return (
    <span className={`dot ${state ?? 'disconnected'}`} title={t.header.dotTitle(label, t.enums.conn[state ?? 'unknown'])}>
      {label}
    </span>
  );
}

export function Header() {
  const t = useT();
  const lang = useLang();
  const demo = useStore((s) => s.demo);
  const paper = useStore((s) => s.paper);
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

  /** The second question of a release that the server refused with DAILY_LOSS_ACTIVE; `details` are that refusal's. */
  const rebaseQuestion = (details: Record<string, unknown> | undefined): string => {
    const value = (key: string): string | null => {
      const v = details?.[key];
      return typeof v === 'string' ? v : null;
    };
    return t.header.rebaseQuestion({ dailyPnl: fmtSigned(value('dailyPnl')), limit: fmtNum(value('limit'), 0), equity: fmtNum(value('equity')) });
  };

  const toggle = useMutation({
    mutationFn: (body: KillSwitchRequest) => api.setKillSwitch(body),
    onSuccess: (state, body) => {
      applyRiskReply(state);
      const released = body.rebase === true ? t.header.releasedRebased : t.header.released;
      pushToast('success', state.killSwitch ? t.header.engaged : released);
    },
    onError: (e, body) => {
      // The server refuses a plain release while the daily loss limit is still breached. Releasing anyway restarts
      // the day's baseline, which is asked for separately and in plain words.
      if (isApiError(e) && e.code === 'DAILY_LOSS_ACTIVE' && body.rebase !== true) {
        if (window.confirm(rebaseQuestion(e.details))) toggle.mutate({ enabled: false, rebase: true });
        return;
      }
      pushToast('error', errorText(e, t));
    },
  });

  const onToggle = () => {
    const next = !killSwitch;
    const text = next ? t.header.confirmEngage(killSwitchSweepNotice({ connection, account }, lang)) : t.header.confirmRelease;
    // The reason is kept by the server and shown as it is: it stays in English whatever the page's language.
    if (window.confirm(text)) toggle.mutate(next ? { enabled: true, reason: 'manual (terminal)' } : { enabled: false });
  };

  return (
    <header className="header">
      <span className="brand">PEGASUS</span>
      <span className={`badge ${paper || demo ? 'badge-demo' : 'badge-live'}`} {...(paper ? { title: t.header.paperTitle } : {})}>
        {paper ? t.header.badge.paper : demo ? t.header.badge.demo : t.header.badge.live}
      </span>
      <div className="dots">
        <Dot label={t.header.dots.ws} state={wsStatus} />
        <Dot label={t.header.dots.public} state={connection?.okxPublic} />
        <Dot label={t.header.dots.private} state={connection?.okxPrivate} />
        <Dot label={t.header.dots.business} state={connection?.okxBusiness} />
      </div>
      <span className="grow" />
      <div className="stat">
        <span className="label">{t.header.equity}</span>
        <span className="value num">{equity === null ? '–' : `${fmtNum(equity)} USD`}</span>
      </div>
      <div className="stat">
        <span className="label">{t.header.dailyPnl}</span>
        <span className={`value num ${signOf(dailyPnl)}`}>{fmtSigned(dailyPnl)}</span>
      </div>
      <button
        className={`btn ${killSwitch ? 'btn-danger' : 'btn-warn'}`}
        onClick={onToggle}
        disabled={toggle.isPending || risk === null}
        title={killSwitch ? risk?.killSwitchReason : t.header.haltAll}
      >
        {killSwitch ? t.header.killSwitchOn : t.header.killSwitch}
      </button>
      <LangSwitch />
      <a href="#" onClick={(e) => { e.preventDefault(); signOut(); }}>
        {t.header.signOut}
      </a>
    </header>
  );
}
