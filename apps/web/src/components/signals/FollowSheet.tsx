import { useMemo, useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import {
  D,
  floorToStep,
  placeOrderRequestSchema,
  toPlainString,
  type CampaignFollowPlan,
  type CampaignSignalRow,
  type CampaignSignalsResponse,
  type Instrument,
  type PlaceOrderRequest,
  type SetLeverageRequest,
  type SignalSnapshot,
  type TdMode,
} from '@pegasus/shared';
import { explainError, inEveryLang, labelOf, riskText, useLang, useT } from '../../i18n';
import { api } from '../../lib/api';
import { exitPlanText, utcLocal } from '../../lib/describe';
import { buildExitFields, defaultExitForm, type ExitContext, type ExitForm } from '../../lib/exits';
import { DASH, fmtContracts, fmtNum, fmtPct, fmtPx, isDecimalText, safeDecimal } from '../../lib/format';
import { contractsForRisk, estimateLiqPx, followBlock, marginAt, riskOf, shareOf, signalCloseTs } from '../../lib/signals';
import { useTrailing } from '../../hooks/useTrailing';
import { getKillSwitch, getTradingBlock, useStore } from '../../store/store';
import { ExitPlanEditor, Segmented } from '../exits/ExitPlanEditor';
import { Modal } from '../Overlay';
import { usePlaceOrder } from '../ticket/usePlaceOrder';
import { useOrderPreview } from '../ticket/useOrderPreview';
import { PlanWarnings } from './CoinCard';

const positive = (s: string): boolean => isDecimalText(s.trim()) && D(s.trim()).gt(0);

interface Props {
  /** The row as it was when the sheet opened: an entry or an add with a plan and a signal */
  row: CampaignSignalRow & { plan: CampaignFollowPlan; signal: SignalSnapshot };
  res: CampaignSignalsResponse;
  inst: Instrument;
  onClose: () => void;
}

/**
 * The confirmation sheet of a followed signal: every parameter of the plan filled in and editable (order type, size or
 * risk, leverage, margin mode, stop, exit plan), checked live through POST /api/orders/preview, said in one sentence,
 * and sent with one click: the leverage first (POST /api/account/leverage), then the order with source 'signal', its
 * signal and a 'psw' client order id. Nothing is sent before the click.
 */
export function FollowSheet({ row, res, inst, onClose }: Props) {
  const t = useT();
  const lang = useLang();
  const { plan, signal } = row;
  const posMode = useStore((s) => s.account?.posMode ?? null);
  const riskMax = useStore((s) => s.riskConfig?.maxLeverage ?? null);
  const killSwitch = useStore(getKillSwitch);
  const tradingBlock = useStore(getTradingBlock);
  const pushToast = useStore((s) => s.pushToast);
  const exits = useTrailing();
  const qc = useQueryClient();
  const longShort = posMode === 'long_short_mode';

  const [ordType, setOrdType] = useState<'market' | 'limit'>('market');
  const [px, setPx] = useState(() => toPlainString(floorToStep(plan.entryPx, inst.tickSz), inst.tickSz));
  const [mgnMode, setMgnMode] = useState<TdMode>(plan.tdMode);
  const [leverage, setLeverage] = useState(plan.leverage);
  const [contracts, setContracts] = useState(plan.contracts ?? '');
  const [riskPct, setRiskPct] = useState(() => D(res.riskPct).mul(100).toFixed());
  const [stop, setStop] = useState(plan.stopPx);
  const [exitForm, setExitForm] = useState<ExitForm>(() => defaultExitForm('channel', plan.trailing.kind === 'channel' ? plan.trailing.bars : res.params.exitChannel));
  const [belowMin, setBelowMin] = useState(false);

  const entryRef = ordType === 'limit' && positive(px) ? px.trim() : plan.entryPx;
  const stopText = stop.trim();
  const exitCtx: ExitContext = { direction: 'long', entry: entryRef, stop: stopText === '' ? null : stopText, inst, whole: true };
  const built = buildExitFields(exitForm, exitCtx);

  const request = useMemo((): PlaceOrderRequest | null => {
    const fields = buildExitFields(exitForm, { direction: 'long', entry: entryRef, stop: stopText === '' ? null : stopText, inst, whole: true });
    if (!fields.ok) return null;
    const candidate: Record<string, unknown> = {
      instId: plan.instId,
      side: 'buy',
      ordType,
      tdMode: mgnMode,
      size: { unit: 'contracts', value: contracts.trim() },
      ...fields.fields,
      source: 'signal',
      signal,
    };
    if (ordType === 'limit') candidate['px'] = px.trim();
    if (stopText !== '') candidate['slTriggerPx'] = stopText;
    // posSide only in long/short mode; an opening order carries no reduce-only flag
    if (longShort) candidate['posSide'] = 'long';
    const parsed = placeOrderRequestSchema.safeParse(candidate);
    return parsed.success ? parsed.data : null;
  }, [exitForm, entryRef, stopText, inst, plan.instId, ordType, mgnMode, contracts, signal, px, longShort]);
  const preview = useOrderPreview(request);

  // The leverage set now for the instrument and margin mode: the one the preview checks against until it is changed.
  const levQuery = useQuery({ queryKey: ['leverage', inst.instId, mgnMode], queryFn: () => api.leverage(inst.instId, mgnMode), staleTime: 60_000 });
  const current = levQuery.data?.find((l) => l.posSide === 'long') ?? levQuery.data?.[0];
  const leverageValid = /^\d+(\.\d+)?$/.test(leverage.trim()) && D(leverage.trim()).gt(0);
  const leverageChanges = leverageValid && (current === undefined || !D(current.lever).eq(leverage.trim()));

  const flow = usePlaceOrder('psw', ({ order }) => {
    pushToast(
      'success',
      inEveryLang((tt) => tt.follow.placed(order.sz, order.instId, labelOf(tt.enums.orderState, order.state))),
      { kind: 'journal', instId: order.instId, mgnMode: order.tdMode, posSide: order.posSide, ordId: order.ordId },
    );
    onClose();
  });

  const block = followBlock(row, { ownAccount: res.campaign.ownAccount, killSwitch, exits: exits.available, tradingBlocked: tradingBlock !== null });
  const p = preview.isCurrent ? preview.preview : undefined;
  // The preview checks the leverage set now; the one asked for here is set before the order is sent.
  const leverageFixes = p !== undefined && !p.risk.ok && p.risk.code === 'MAX_LEVERAGE' && leverageChanges && riskMax !== null && D(leverage.trim()).lte(riskMax);
  const verdictOk = p !== undefined && (p.risk.ok || leverageFixes);
  const canConfirm = block === null && verdictOk && leverageValid && !flow.isPending;

  const confirm = () => {
    if (!canConfirm || preview.request === null) return;
    const body: SetLeverageRequest = longShort
      ? { instId: inst.instId, lever: leverage.trim(), mgnMode, posSide: 'long' }
      : { instId: inst.instId, lever: leverage.trim(), mgnMode };
    flow.submit(preview.request, async () => {
      const data = await api.setLeverage(body);
      qc.setQueryData(['leverage', inst.instId, mgnMode], data);
    });
  };

  const sizeFromRisk = () => {
    const pct = safeDecimal(riskPct.trim());
    const sized = contractsForRisk(res.equity, pct === null ? null : pct.div(100), entryRef, stopText, inst);
    if (sized === null) return;
    setContracts(sized.contracts);
    setBelowMin(sized.belowMin);
  };

  // Figures of the order as the form holds it, before the server has answered.
  const localRisk = riskOf(contracts.trim(), entryRef, stopText, inst);
  const localShare = shareOf(localRisk?.toFixed() ?? null, res.equity);
  const stopShare = (() => {
    const e = safeDecimal(entryRef);
    const s = safeDecimal(stopText);
    return e === null || s === null || !e.gt(0) ? null : e.minus(s).div(e);
  })();
  const lossShare = p === undefined ? null : shareOf(p.stopLossQuote === '' ? null : p.stopLossQuote, res.equity);
  const margin = p === undefined ? null : marginAt(p.notionalQuote, leverage.trim());
  const fee = p === undefined ? null : D(p.notionalQuote).mul(res.params.feeRate);
  const liq = p === undefined || mgnMode !== 'isolated' ? null : estimateLiqPx(p.sz, p.refPrice, leverage.trim(), plan.maintenanceRate, inst);
  const exitsText = exitPlanText(built.ok ? built.fields : {}, inst, t);

  const summary = t.follow.summary({
    contracts: fmtContracts(p?.sz ?? (contracts.trim() === '' ? null : contracts.trim()), inst),
    coin: p === undefined ? DASH : `${fmtNum(p.coin, 4)} ${inst.baseCcy}`,
    instId: inst.instId,
    limitPx: ordType === 'limit' ? fmtPx(px.trim(), inst) : '',
    mgnMode: t.enums.mgnMode[mgnMode],
    leverage: leverage.trim(),
    stop: stopText === '' ? t.common.na : fmtPx(stopText, inst),
    stopPct: stopShare === null || !stopShare.gt(0) ? '' : fmtPct(stopShare, 2),
    risk: p !== undefined && p.stopLossQuote !== '' ? fmtNum(p.stopLossQuote, 2) : localRisk === null ? DASH : fmtNum(localRisk, 2),
    riskPct: lossShare !== null ? fmtPct(lossShare, 2) : localShare === null ? '' : fmtPct(localShare, 2),
    exits: exitsText,
  });

  const trigger = row.holding?.addTrigger ?? signal.entryLevel;
  const signalLine = t.follow.signalLine(utcLocal(signalCloseTs(signal), t), fmtPx(signal.close, inst), fmtPx(signal.kind === 'entry' ? signal.entryLevel : trigger, inst), signal.kind, res.params.entryChannel);

  const verdict = (() => {
    if (preview.error !== null && preview.error !== undefined) return <div className="risk-msg bad">{explainError(preview.error, t)}</div>;
    if (p === undefined) return <div className="risk-msg dim">{request === null ? t.follow.enterValues : t.follow.checking}</div>;
    if (p.risk.ok) return <div className="risk-msg good">{t.follow.riskOk}</div>;
    if (leverageFixes) return <div className="risk-msg good">{t.follow.leverageWillPass(leverage.trim())}</div>;
    return <div className="risk-msg bad">{`${p.risk.code}: ${riskText(p.risk, t)}`}</div>;
  })();

  const footer = (
    <div className="follow-foot">
      {flow.error !== null && (
        <div className="notice notice-danger follow-error" role="alert">
          {flow.error[lang]}
        </div>
      )}
      {block !== null && <div className="notice notice-warn">{t.signals.block[block]}</div>}
      <div className="follow-buttons">
        <button className="btn" onClick={onClose} disabled={flow.isPending}>
          {t.follow.cancel}
        </button>
        <button className="btn btn-buy follow-confirm" onClick={confirm} disabled={!canConfirm} title={request === null ? t.follow.incomplete : summary}>
          {flow.phase === 'preparing' ? t.follow.settingLeverage : flow.isPending ? t.follow.sending : t.follow.confirm}
        </button>
      </div>
    </div>
  );

  return (
    <Modal
      title={
        <>
          {t.follow.title[plan.kind]} · <span className="num">{inst.instId}</span>
        </>
      }
      onClose={onClose}
      footer={footer}
      className="follow-sheet"
      closeTitle={t.follow.closeTitle}
      dismissable={!flow.isPending}
    >
      <div className="follow-signal">{signalLine}</div>
      <PlanWarnings plan={plan} inst={inst} />
      <div className="follow-grid">
        <div className="follow-form">
          <section className="follow-section">
            <h5>{t.follow.order}</h5>
            <div className="follow-row">
              <label className="follow-field">
                <span>{t.follow.ordType}</span>
                <Segmented
                  value={ordType}
                  options={[
                    { id: 'market', label: t.enums.ordType.market },
                    { id: 'limit', label: t.enums.ordType.limit },
                  ]}
                  onChange={setOrdType}
                  label={t.follow.ordType}
                />
              </label>
              {ordType === 'limit' && (
                <label className="follow-field">
                  <span>{t.follow.limitPx}</span>
                  <input className="num" inputMode="decimal" value={px} onChange={(e) => setPx(e.target.value)} />
                </label>
              )}
            </div>
            <div className="follow-row">
              <label className="follow-field">
                <span>{t.follow.mgnMode}</span>
                <select value={mgnMode} onChange={(e) => setMgnMode(e.target.value as TdMode)}>
                  <option value="isolated">{t.enums.mgnMode.isolated}</option>
                  <option value="cross">{t.enums.mgnMode.cross}</option>
                </select>
              </label>
              <label className="follow-field">
                <span>
                  {t.follow.leverage} <span className="dim">({t.follow.leverageHint(plan.leverage, riskMax)})</span>
                </span>
                <input className="num" inputMode="decimal" value={leverage} onChange={(e) => setLeverage(e.target.value)} />
              </label>
            </div>
            {leverageChanges && current !== undefined && <div className="follow-note dim">{t.follow.leverageFrom(current.lever, leverage.trim())}</div>}
          </section>

          <section className="follow-section">
            <h5>{t.follow.size}</h5>
            <div className="follow-row">
              <label className="follow-field">
                <span>
                  {t.follow.contracts} <span className="dim">{t.ticket.sizeHint(inst.minSz, inst.lotSz)}</span>
                </span>
                <input
                  className="num"
                  inputMode="decimal"
                  value={contracts}
                  onChange={(e) => {
                    setContracts(e.target.value);
                    setBelowMin(false);
                  }}
                />
                <span className="follow-hint num">{localShare === null ? '' : t.follow.ofEquity(fmtPct(localShare, 2))}</span>
              </label>
              <label className="follow-field">
                <span>{t.follow.riskPct}</span>
                <span className="input-group">
                  <input className="num" inputMode="decimal" value={riskPct} onChange={(e) => setRiskPct(e.target.value)} />
                  <button type="button" className="btn" onClick={sizeFromRisk} disabled={res.equity === null} title={t.follow.recomputeTitle}>
                    {t.follow.recompute}
                  </button>
                </span>
              </label>
            </div>
            {belowMin && <div className="follow-note warn">{t.follow.belowMin(inst.minSz)}</div>}
          </section>

          <section className="follow-section">
            <h5>{t.follow.stop}</h5>
            <label className="follow-field">
              <input className="num" inputMode="decimal" aria-label={t.follow.stop} value={stop} onChange={(e) => setStop(e.target.value)} />
              <span className="follow-hint num">{stopShare === null ? '' : stopShare.gt(0) ? t.follow.stopBelow(fmtPct(stopShare, 2)) : t.follow.stopNotBelow}</span>
            </label>
          </section>

          <section className="follow-section">
            <h5>{t.follow.exitPlan}</h5>
            <ExitPlanEditor form={exitForm} update={setExitForm} ctx={exitCtx} error={built.ok ? null : built.error} />
          </section>
        </div>

        <div className="follow-side">
          <section className="follow-section preview follow-check">
            <h5>{t.follow.check}</h5>
            <div className="kv num">
              <span>{t.preview.contracts}</span>
              <span>{p === undefined ? DASH : t.common.ct(fmtContracts(p.sz, inst))}</span>
            </div>
            <div className="kv num">
              <span>{t.preview.coin}</span>
              <span>{p === undefined ? DASH : `${fmtNum(p.coin, 4)} ${inst.baseCcy}`}</span>
            </div>
            <div className="kv num">
              <span>{ordType === 'market' ? t.follow.refPrice : t.follow.limitPx}</span>
              <span>{p === undefined ? DASH : fmtPx(ordType === 'market' ? p.refPrice : p.px, inst)}</span>
            </div>
            <div className="kv num">
              <span>{t.follow.notional}</span>
              <span>{p === undefined ? DASH : `${fmtNum(p.notionalQuote, 2)} USDT`}</span>
            </div>
            {ordType === 'market' && (
              <div className="kv num">
                <span>{t.follow.estSlippage}</span>
                <span>{p === undefined || p.estSlippagePct === '' ? DASH : fmtPct(p.estSlippagePct, 3)}</span>
              </div>
            )}
            <div className="kv num">
              <span>{t.follow.marginAt(leverage.trim())}</span>
              <span>{margin === null ? DASH : `${fmtNum(margin, 2)} USDT`}</span>
            </div>
            <div className="kv num">
              <span>{t.follow.fee(fmtPct(res.params.feeRate, 3))}</span>
              <span>{fee === null ? DASH : `${fmtNum(fee, 4)} USDT`}</span>
            </div>
            <div className="kv num">
              <span>{t.follow.liqPx}</span>
              <span>{liq === null ? DASH : fmtPx(liq.toFixed(), inst)}</span>
            </div>
            <div className="kv num">
              <span>{t.follow.lossAtStop}</span>
              <span className="neg">
                {p === undefined || p.stopLossQuote === '' ? DASH : `${fmtNum(p.stopLossQuote, 2)} USDT`}
                {lossShare !== null && <span className="dim"> · {t.follow.ofEquity(fmtPct(lossShare, 2))}</span>}
              </span>
            </div>
            {p?.takeProfits !== undefined && p.takeProfits.length > 0 && (
              <table className="table follow-tps">
                <thead>
                  <tr>
                    <th>{t.follow.tpLegs}</th>
                    <th>{t.common.price}</th>
                    <th>{t.follow.tpContracts}</th>
                    <th>{t.follow.tpProfit}</th>
                  </tr>
                </thead>
                <tbody>
                  {p.takeProfits.map((leg, i) => (
                    <tr key={i} className="num">
                      <td>{t.follow.tpLeg(i + 1)}</td>
                      <td>{fmtPx(leg.triggerPx, inst)}</td>
                      <td>{fmtContracts(leg.sz, inst)}</td>
                      <td className="pos">{`+${fmtNum(leg.profitQuote, 2)} USDT`}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            )}
            {verdict}
          </section>
          <section className="follow-section follow-summary">
            <h5>{t.follow.summaryTitle}</h5>
            <p>{summary}</p>
          </section>
        </div>
      </div>
    </Modal>
  );
}
