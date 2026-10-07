import { useEffect, useMemo, useState } from 'react';
import type { CampaignFollowPlan, CampaignSignalRow, SignalSnapshot } from '@pegasus/shared';
import { useCampaignSignals } from '../hooks/useCampaignSignals';
import { useTrailing } from '../hooks/useTrailing';
import { errorText, useLang, useT } from '../i18n';
import { fmtDateTime, fmtNum, fmtPct } from '../lib/format';
import { followBlock, sortRows } from '../lib/signals';
import { PAPER_WEB_PORT, stackUrl } from '../lib/stacks';
import { getKillSwitch, getTradingBlock, useStore } from '../store/store';
import { useUi } from '../store/ui';
import { LoadFailed } from './LoadFailed';
import { CoinCard } from './signals/CoinCard';
import { CoinList } from './signals/CoinList';
import { FollowSheet } from './signals/FollowSheet';
import { RISK_CHOICES, readStoredRiskPct, writeStoredRiskPct, type RiskChoice } from './signals/riskPref';

/** A refresh that failed twice in a row: the figures on screen are no longer current. */
const OUTDATED_MS = 2 * 30_000 + 15_000;

type Followable = CampaignSignalRow & { plan: CampaignFollowPlan; signal: SignalSnapshot };
const followable = (row: CampaignSignalRow): row is Followable => row.plan !== null && row.signal !== null;

/**
 * The SIGNALS tab: the campaign rule read coin by coin (GET /api/campaign/signals). The coins on the left, actionable
 * first; the chosen coin's state in words, its levels, a chart and the plan on the right, with the two ways in: follow
 * the signal through the confirmation sheet, or open by hand from the order ticket.
 */
export function SignalsPanel() {
  const t = useT();
  const lang = useLang();
  const [riskPct, setRiskPct] = useState<RiskChoice>(readStoredRiskPct);
  const q = useCampaignSignals(riskPct);
  const exits = useTrailing();
  const killSwitch = useStore(getKillSwitch);
  const tradingBlock = useStore(getTradingBlock);
  const instruments = useStore((s) => s.instruments);
  const focusTicket = useStore((s) => s.focusTicket);
  const coin = useUi((s) => s.signalsCoin);
  const setCoin = useUi((s) => s.setSignalsCoin);
  const [sheet, setSheet] = useState<Followable | null>(null);
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), 30_000);
    return () => clearInterval(timer);
  }, []);

  const res = q.data;
  const rows = useMemo(() => sortRows(res?.rows ?? []), [res]);
  const selected = rows.find((r) => r.instId === coin) ?? rows[0] ?? null;
  const outdated = res !== undefined && (q.isError || now - q.dataUpdatedAt > OUTDATED_MS);

  const chooseRisk = (value: string) => {
    const choice = RISK_CHOICES.find((c) => c === value);
    if (choice === undefined) return;
    writeStoredRiskPct(choice);
    setRiskPct(choice);
  };

  const toolbar = (
    <div className="sig-toolbar">
      <button className="btn btn-sm" onClick={() => void q.refetch()} disabled={q.isFetching}>
        {q.isFetching ? t.signals.refreshing : t.common.refresh}
      </button>
      <label title={t.signals.riskTitle}>
        {t.signals.risk}{' '}
        <select value={riskPct} onChange={(e) => chooseRisk(e.target.value)}>
          {RISK_CHOICES.map((c) => (
            <option key={c} value={c}>
              {fmtPct(c, 2)}
            </option>
          ))}
        </select>
      </label>
      {res !== undefined && (
        <>
          <span>
            {t.signals.equity} <span className="num">{res.equity === null ? t.common.na : `${fmtNum(res.equity, 2)} USDT`}</span>
          </span>
          <span>
            {t.signals.updated} <span className="num">{fmtDateTime(res.generatedAt)}</span>
          </span>
          <span className="dim sig-rule">
            {t.signals.rule({
              entryChannel: res.params.entryChannel,
              exitChannel: res.params.exitChannel,
              addStep: fmtPct(res.params.addStep, 0),
              adds: res.params.structure === 'pyramid',
              leverage: res.params.leverage,
            })}
          </span>
        </>
      )}
      {q.isError && <span className="neg">{errorText(q.error, t)}</span>}
    </div>
  );

  if (res === undefined) {
    return (
      <div className="sig">
        {toolbar}
        <div className="empty">{q.isError ? <LoadFailed what={t.signals.what} busy={q.isFetching} onRetry={() => void q.refetch()} /> : t.signals.loading}</div>
      </div>
    );
  }

  const ownAccount = res.campaign.ownAccount;
  const banners: Array<{ key: string; cls: string; text: string }> = [];
  if (ownAccount) banners.push({ key: 'campaign', cls: 'notice-danger', text: t.signals.banner.campaignAccount(stackUrl(PAPER_WEB_PORT)) });
  if (killSwitch) banners.push({ key: 'kill', cls: 'notice-danger', text: t.signals.banner.killSwitch });
  if (exits.available === false && !ownAccount) banners.push({ key: 'exits', cls: 'notice-warn', text: t.signals.banner.exitsUnavailable });

  // The contract's spec: the terminal's own for a tracked coin, else the one the plan carries (for the figures of the card)
  const tracked = selected === null ? undefined : instruments.find((i) => i.instId === selected.instId);
  const inst = tracked ?? selected?.plan?.spec;
  const block = selected === null ? null : followBlock(selected, { ownAccount, killSwitch, exits: exits.available, tradingBlocked: tradingBlock !== null });
  const manualBlock = tradingBlock !== null ? tradingBlock[lang] : tracked === undefined ? t.signals.manualUntracked : null;

  return (
    <div className={`sig${outdated ? ' sig-outdated' : ''}`}>
      {toolbar}
      {banners.map((b) => (
        <div key={b.key} className={`notice ${b.cls} sig-banner`}>
          {b.text}
        </div>
      ))}
      {outdated && <div className="notice notice-warn sig-banner">{t.signals.outdated(fmtDateTime(q.dataUpdatedAt))}</div>}
      {rows.length === 0 || selected === null ? (
        <div className="empty">{t.signals.empty}</div>
      ) : (
        <div className="sig-body">
          <CoinList rows={rows} selected={selected.instId} instruments={instruments} onSelect={setCoin} />
          <CoinCard
            row={selected}
            res={res}
            inst={inst}
            block={block}
            manualBlock={manualBlock}
            now={now}
            onFollow={() => {
              if (block === null && followable(selected)) setSheet(selected);
            }}
            onManual={() => {
              if (manualBlock === null) focusTicket(selected.instId, 'buy');
            }}
          />
        </div>
      )}
      {sheet !== null && (() => {
        const sheetInst = instruments.find((i) => i.instId === sheet.instId);
        return sheetInst === undefined ? null : <FollowSheet row={sheet} res={res} inst={sheetInst} onClose={() => setSheet(null)} />;
      })()}
    </div>
  );
}
