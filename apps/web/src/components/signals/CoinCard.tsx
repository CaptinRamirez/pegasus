import type { ReactNode } from 'react';
import type { CampaignFollowPlan, CampaignSignalRow, CampaignSignalsResponse, Instrument } from '@pegasus/shared';
import { useT, type Messages } from '../../i18n';
import type { SignalContext } from '../../i18n/en';
import { utcLocal } from '../../lib/describe';
import { DASH, fmtContracts, fmtNum, fmtPct, fmtPx, safeDecimal } from '../../lib/format';
import { addTriggerAfter, changeFrom, coinOf, nextDailyClose, reasonText, shareOf, signalCloseTs, warningText, type FollowBlock } from '../../lib/signals';
import { StateBadge } from './CoinList';
import { SignalChart } from './SignalChart';

/** Warnings that stop a follow, shown in the danger colour. */
const BLOCKING = new Set(['CAMPAIGN_ACCOUNT', 'KILL_SWITCH', 'NOT_TRACKED', 'STOP_NOT_BELOW_ENTRY', 'EQUITY_UNKNOWN', 'LINEAR_ONLY', 'OVER_ORDER_NOTIONAL', 'OVER_POSITION_NOTIONAL', 'OVER_TOTAL_NOTIONAL']);

export const signalContext = (row: CampaignSignalRow, res: CampaignSignalsResponse): SignalContext => ({
  coin: coinOf(row.instId),
  entryChannel: res.params.entryChannel,
  exitChannel: res.params.exitChannel,
  addStep: fmtPct(res.params.addStep, 0),
});

/** The coin's state in plain words: one sentence per reason, then the rule (or what to do on an exit). */
export function stateSentence(row: CampaignSignalRow, res: CampaignSignalsResponse, inst: Instrument | undefined, t: Messages): string {
  const ctx = signalContext(row, res);
  const parts = row.reasons.map((r) => t.signals.reason[r.code](reasonText(r.code, r.params, inst), ctx));
  const exitLine = row.holding?.trailingLine ?? row.levels.nextExit;
  if ((row.state === 'entry' || row.state === 'add' || row.state === 'holding' || row.state === 'near') && exitLine !== null) {
    parts.push(t.signals.ruleLine(ctx, fmtPx(exitLine, inst)));
  }
  if (row.state === 'exit') parts.push(t.signals.exitAdvice);
  return t.signals.joinSentences(parts);
}


function Fact({ label, children, title }: { label: string; children: ReactNode; title?: string }) {
  return (
    <div className="sig-fact" {...(title === undefined ? {} : { title })}>
      <span className="k">{label}</span>
      <span className="v">{children}</span>
    </div>
  );
}

function Kv({ k, v, cls }: { k: string; v: ReactNode; cls?: string }) {
  return (
    <div className="sig-kv">
      <span className="k">{k}</span>
      <span className={`v num${cls === undefined ? '' : ` ${cls}`}`}>{v}</span>
    </div>
  );
}

function PlanView({ plan, res, inst }: { plan: CampaignFollowPlan; res: CampaignSignalsResponse; inst: Instrument | undefined }) {
  const t = useT();
  const usdt = (v: string | null) => (v === null ? DASH : `${fmtNum(v, 2)} USDT`);
  const riskShare = shareOf(plan.riskAmount, res.equity);
  const targetShare = shareOf(plan.riskTarget, res.equity);
  return (
    <div className="sig-plan">
      <h5>{t.signals.plan[plan.kind]}</h5>
      <div className="sig-groups">
        <div className="sig-group">
          <div className="sig-group-title">{t.signals.groupPrice}</div>
          <Kv k={t.signals.entryPx} v={fmtPx(plan.entryPx, inst)} />
          <Kv k={t.signals.stopPx} v={fmtPx(plan.stopPx, inst)} cls="neg" />
          <Kv k={t.signals.stopDistance} v={`${fmtPct(plan.stopDistancePct, 2)} · ${fmtPx(plan.stopDistance, inst)}`} />
        </div>
        <div className="sig-group">
          <div className="sig-group-title">{t.signals.groupSize}</div>
          <Kv k={t.signals.contracts} v={plan.contracts === null ? t.signals.noSize : t.common.ct(fmtContracts(plan.contracts, inst))} />
          <Kv k={t.signals.coin} v={plan.coin === null ? DASH : `${fmtNum(plan.coin, 4)} ${coinOf(plan.instId)}`} />
          <Kv k={t.signals.notional} v={usdt(plan.notional)} />
          <Kv k={t.signals.leverage} v={`${plan.leverage}×`} />
          <Kv k={t.signals.margin} v={usdt(plan.margin)} />
          <Kv k={t.signals.liqPx} v={fmtPx(plan.liqPx, inst)} />
        </div>
        <div className="sig-group">
          <div className="sig-group-title">{t.signals.groupRisk}</div>
          <Kv k={t.signals.atRisk} v={usdt(plan.riskAmount)} cls="neg" />
          <Kv k={t.signals.ofEquity} v={riskShare === null ? DASH : fmtPct(riskShare, 2)} />
          <Kv k={t.signals.riskTarget} v={plan.riskTarget === null ? DASH : `${fmtNum(plan.riskTarget, 2)} USDT · ${targetShare === null ? DASH : fmtPct(targetShare, 2)}`} />
        </div>
        <div className="sig-group">
          <div className="sig-group-title">{t.signals.groupExit}</div>
          <div className="sig-exit-line">{plan.trailing.kind === 'channel' ? t.signals.trailingChannel(plan.trailing.bars) : DASH}</div>
          <div className="sig-exit-line dim">{t.signals.noTakeProfit}</div>
          {plan.after !== null && (
            <div className="sig-exit-line">
              {t.signals.afterAdd}: {t.signals.afterAddLine(fmtContracts(plan.after.contracts, inst), fmtPx(plan.after.avgPx, inst), fmtPx(plan.after.liqPx, inst))}
            </div>
          )}
        </div>
      </div>
    </div>
  );
}

/** What the plan warns about, in words; the ones that stop a follow in the danger colour. Nothing without a warning. */
export function PlanWarnings({ plan, inst }: { plan: CampaignFollowPlan; inst: Instrument | undefined }) {
  const t = useT();
  if (plan.warnings.length === 0) return null;
  return (
    <div className="sig-warnings">
      <div className="sig-group-title">{t.signals.warnings}</div>
      <ul>
        {plan.warnings.map((w) => (
          <li key={w.code} className={BLOCKING.has(w.code) ? 'neg' : 'warn'} data-code={w.code}>
            {t.signals.warning[w.code](warningText(w.code, w.params, inst))}
          </li>
        ))}
      </ul>
    </div>
  );
}

interface Props {
  row: CampaignSignalRow;
  res: CampaignSignalsResponse;
  inst: Instrument | undefined;
  block: FollowBlock | null;
  /** Why the manual button is disabled; null when it is not */
  manualBlock: string | null;
  onFollow: () => void;
  onManual: () => void;
  now: number;
}

/** One coin of the rule: its state in words, the signal's time, the key levels, a chart, the plan and the two ways in. */
export function CoinCard({ row, res, inst, block, manualBlock, onFollow, onManual, now }: Props) {
  const t = useT();
  const signal = row.signal;
  const signalTs = signal === null ? null : signalCloseTs(signal);
  const vsSignal = signal === null ? null : changeFrom(row.markPx, signal.close);
  const adds = res.params.structure === 'pyramid';
  const addLevel: { value: string; note: string | null } = !adds
    ? { value: t.signals.addsOff, note: null }
    : row.holding !== null
      ? { value: fmtPx(row.holding.addTrigger, inst), note: null }
      : row.plan !== null
        ? { value: fmtPx(addTriggerAfter(row.plan.entryPx, res.params.addStep)?.toFixed() ?? null, inst), note: t.signals.addAfterEntry }
        : { value: DASH, note: null };
  const exitLine = row.holding?.trailingLine ?? row.levels.nextExit;
  const followable = row.state === 'entry' || row.state === 'add';
  const distance = safeDecimal(row.entryDistancePct);

  return (
    <div className="sig-card">
      <div className="sig-card-head">
        <span className="sig-card-coin">{coinOf(row.instId)}</span>
        <span className="dim">{row.instId}</span>
        <StateBadge state={row.state} />
        <span className="grow" />
        <span className="num">{fmtPx(row.markPx, inst)}</span>
      </div>
      <div className={`sig-headline sig-headline-${row.state}`}>{t.signals.headline[row.state]}</div>
      <p className="sig-sentence">{stateSentence(row, res, inst, t)}</p>

      <div className="sig-actions">
        <button className="btn btn-buy sig-follow" disabled={block !== null} onClick={onFollow} title={block === null ? t.signals.followTitle : t.signals.block[block]}>
          {t.signals.follow}
        </button>
        <button className="btn sig-manual" disabled={manualBlock !== null} onClick={onManual} title={manualBlock ?? t.signals.manualTitle}>
          {t.signals.manual}
        </button>
        {block !== null && followable && <span className="sig-block warn">{t.signals.block[block]}</span>}
        {manualBlock !== null && <span className="sig-block dim">{manualBlock}</span>}
      </div>
      {row.plan !== null && <PlanWarnings plan={row.plan} inst={inst} />}

      <div className="sig-facts">
        <Fact label={t.signals.signalTime}>
          {signal === null || signalTs === null ? (
            <span className="dim">{t.signals.noSignalTime}</span>
          ) : (
            <>
              {t.signals.signalAt[signal.kind]} {fmtPx(signal.close, inst)}
              <span className="sub">{utcLocal(signalTs, t)}</span>
            </>
          )}
        </Fact>
        {vsSignal !== null && (
          <Fact label={t.signals.nowVsSignal}>
            <span className={`num ${vsSignal.gt(0) ? 'pos' : vsSignal.lt(0) ? 'neg' : ''}`}>{fmtPct(vsSignal, 2, true)}</span>
          </Fact>
        )}
        <Fact label={t.signals.lastClose}>
          {row.daily === null ? (
            DASH
          ) : (
            <>
              <span className="num">{fmtPx(row.daily.close, inst)}</span>
              <span className="sub">{utcLocal(row.daily.closeTs, t)}</span>
            </>
          )}
        </Fact>
        <Fact label={t.signals.nextClose}>
          <span className="sub">{utcLocal(nextDailyClose(now), t)}</span>
        </Fact>
      </div>

      <div className="sig-levels">
        {row.state === 'entry' ? (
          // The signal has fired: the line that matters is the one the last close broke, not the next close's.
          <div className="sig-level" title={t.signals.entryLevelBrokenTitle}>
            <span className="k">{t.signals.entryLevelBroken(res.params.entryChannel)}</span>
            <span className="v num pos">{fmtPx(row.levels.entry, inst)}</span>
            {row.daily !== null && <span className="sub num">{t.signals.entryBrokenBy(fmtPx(row.daily.close, inst))}</span>}
          </div>
        ) : (
          <div className="sig-level" title={t.signals.entryLevelTitle}>
            <span className="k">{t.signals.entryLevel(res.params.entryChannel)}</span>
            <span className="v num pos">{fmtPx(row.levels.nextEntry, inst)}</span>
            {distance !== null && <span className="sub num">{distance.lte(0) ? t.signals.above : `+${fmtPct(distance, 2)}`}</span>}
          </div>
        )}
        <div className="sig-level" title={t.signals.exitLevelTitle}>
          <span className="k">{t.signals.exitLevel(res.params.exitChannel)}</span>
          <span className="v num neg">{fmtPx(exitLine, inst)}</span>
        </div>
        <div className="sig-level" title={t.signals.addLevelTitle}>
          <span className="k">{t.signals.addLevel}</span>
          <span className="v num">{addLevel.value}</span>
          {addLevel.note !== null && <span className="sub">{addLevel.note}</span>}
        </div>
      </div>

      <div className="sig-card-grid">
        <SignalChart key={row.instId} instId={row.instId} tickSz={inst?.tickSz} tracked={row.tracked} entryChannel={res.params.entryChannel} exitChannel={res.params.exitChannel} />
        {row.plan !== null ? <PlanView plan={row.plan} res={res} inst={inst} /> : <div className="sig-plan dim">{followable ? t.signals.noSize : t.signals.noPlan}</div>}
      </div>
    </div>
  );
}
