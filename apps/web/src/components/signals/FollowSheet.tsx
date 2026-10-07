import { useEffect, useMemo, useRef, useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import {
  D,
  ceilToStep,
  floorToStep,
  placeOrderRequestSchema,
  toPlainString,
  type CampaignFollowPlan,
  type CampaignPlanWarningCode,
  type CampaignSignalRow,
  type CampaignSignalsResponse,
  type Instrument,
  type PlaceOrderRequest,
  type SetLeverageRequest,
  type SignalSnapshot,
  type TdMode,
} from '@pegasus/shared';
import { explainError, inEveryLang, labelOf, riskText, useLang, useT } from '../../i18n';
import type { StopLineText } from '../../i18n/en';
import { api } from '../../lib/api';
import { exitErrorText, exitFormText, utcLocal } from '../../lib/describe';
import { activationPending, callbackTriggerNow, channelLevelOf, checkExitForm, defaultExitForm, legFigures, proposeLevels, riskDistance, rowError, stopAttachedOf, type ExitContext, type ExitForm } from '../../lib/exits';
import { DASH, fmtCoin, fmtContracts, fmtNum, fmtPct, fmtPx, fmtShare, isDecimalText, safeDecimal } from '../../lib/format';
import {
  capContracts,
  contractsForRisk,
  estimateLiqPx,
  exposureNow,
  followBlock,
  liqAfterAdd,
  liqRelationOf,
  liquidationLimitOf,
  marginAt,
  notionalOf,
  riskOf,
  safeLeverageAfterAdd,
  safeLeverageFor,
  shareOf,
  signalCloseTs,
  type CappedSize,
  type SizeLimits,
} from '../../lib/signals';
import { useTrailing } from '../../hooks/useTrailing';
import { getKillSwitch, getTradingBlock, useStore } from '../../store/store';
import { ExitPlanEditor, Segmented } from '../exits/ExitPlanEditor';
import { Modal } from '../Overlay';
import { usePlaceOrder } from '../ticket/usePlaceOrder';
import { useOrderPreview } from '../ticket/useOrderPreview';
import { PlanWarnings } from './CoinCard';

const positive = (s: string): boolean => isDecimalText(s.trim()) && D(s.trim()).gt(0);

/** The warnings of the plan the sheet does not repeat: the size note under the contracts field says the cap with the page's own figures. */
const SIZE_WARNINGS: readonly CampaignPlanWarningCode[] = ['LIMITED_BY_ORDER_NOTIONAL', 'LIMITED_BY_POSITION_NOTIONAL', 'LIMITED_BY_TOTAL_NOTIONAL'];

interface Props {
  /** The row as it was when the sheet opened: an entry or an add with a plan and a signal */
  row: CampaignSignalRow & { plan: CampaignFollowPlan; signal: SignalSnapshot };
  res: CampaignSignalsResponse;
  inst: Instrument;
  onClose: () => void;
}

/** The contracts the program fills in: from the risk, then cut to the limits. */
interface AutoSize {
  riskContracts: string;
  riskPct: string;
  belowMin: boolean;
  capped: CappedSize;
}

/**
 * The stop the order will have: the one attached to it, or, with none attached, the one the trailing stop puts after
 * the fill (the channel's level, or the callback's trigger at the price now).
 */
interface StopRef {
  px: string;
  kind: 'attached' | 'channel' | 'callback';
}

/** A note under a field: its words, its colour, and a button that acts on it. */
interface Note {
  cls: 'warn' | 'dim';
  text: string;
  action?: { label: string; run: () => void };
}

/**
 * The confirmation sheet of a followed signal: every parameter of the plan filled in and editable (order type, size or
 * risk, leverage, margin mode, stop, exit plan), checked live through POST /api/orders/preview, said in one sentence,
 * and sent with one click: the leverage first (POST /api/account/leverage), then the order with source 'signal', its
 * signal and a 'psw' client order id. Nothing is sent before the click.
 *
 * Nothing on the sheet is left blank or to the trader's guess: the size is the risk's, cut to what the risk limits
 * and the balance allow (capContracts, said under the field), and while the trader has not typed one it follows the
 * form (the stop, the limit price, the risk, the leverage), so the note under it is always true of the field; every
 * take-profit level is proposed (lib/exits.ts), measured from the stop the order will have (the attached one or,
 * with none attached, the trailing stop's after the fill: the same stop the risk and the size are counted with); the
 * figures of the check (coin, notional, margin, fee, liquidation, loss at the stop, the legs) are computed from the
 * form until the server has answered; the order is previewed with the parts of the exit plan that are complete and
 * without a stop the server refuses; the summary says every part of the form as it is, what is wrong with it
 * included; and the reason the confirm button is disabled is printed beside it. The sheet refuses on its own what
 * the server does not check: a leverage whose estimated liquidation (for an add, the position's after it) is not
 * safely below the stop (the API's rule for the plan: liqBufferPct), a size below the minimum order, a stop that is
 * not a price. A callback trailing stop nearer than the stop is priced too: it fires first, at its smaller loss.
 */
export function FollowSheet({ row, res, inst, onClose }: Props) {
  const t = useT();
  const lang = useLang();
  const { plan, signal } = row;
  const posMode = useStore((s) => s.account?.posMode ?? null);
  const riskConfig = useStore((s) => s.riskConfig);
  const positions = useStore((s) => s.positions);
  const orders = useStore((s) => s.orders);
  const instruments = useStore((s) => s.instruments);
  const balance = useStore((s) => s.balance);
  const killSwitch = useStore(getKillSwitch);
  const tradingBlock = useStore(getTradingBlock);
  const pushToast = useStore((s) => s.pushToast);
  const exits = useTrailing();
  const qc = useQueryClient();
  const longShort = posMode === 'long_short_mode';
  const riskMax = riskConfig?.maxLeverage ?? null;

  const [ordType, setOrdType] = useState<'market' | 'limit'>('market');
  const [px, setPx] = useState(() => toPlainString(floorToStep(plan.entryPx, inst.tickSz), inst.tickSz));
  const [mgnMode, setMgnMode] = useState<TdMode>(plan.tdMode);
  const [leverage, setLeverage] = useState(plan.leverage);
  const [riskPct, setRiskPct] = useState(() => D(res.riskPct).mul(100).toFixed());
  const [stop, setStop] = useState(plan.stopPx);
  const [exitForm, setExitForm] = useState<ExitForm>(() => defaultExitForm('channel', plan.trailing.kind === 'channel' ? plan.trailing.bars : res.params.exitChannel));

  const pxText = px.trim();
  const limitPxOk = ordType !== 'limit' || positive(pxText);
  /** The entry the figures are measured from: the limit price, or the mark (while a limit price is not filled in too) */
  const entryRef = ordType === 'limit' && positive(pxText) ? pxText : plan.entryPx;
  const leverageValid = /^\d+(\.\d+)?$/.test(leverage.trim()) && D(leverage.trim()).gt(0);

  // The stop typed: a price, rounded up to the tick as the server rounds a buy order's stop (towards the entry); the
  // attached stop is one the server accepts, below the entry.
  const stopText = stop.trim();
  const stopNumber = stopText !== '' && positive(stopText) ? D(stopText) : null;
  /** Something is typed that is not a price (letters, a comma, zero): the server refuses it */
  const stopInvalid = stopText !== '' && stopNumber === null;
  const stopPx = stopNumber === null ? null : toPlainString(ceilToStep(stopNumber, inst.tickSz), inst.tickSz);
  const stopOffTick = stopNumber !== null && stopPx !== null && !stopNumber.eq(stopPx);
  const stopShare = (() => {
    const e = safeDecimal(entryRef);
    return e === null || stopPx === null || !e.gt(0) ? null : e.minus(stopPx).div(e);
  })();
  const stopAttached = stopPx !== null && stopShare !== null && stopShare.gt(0);
  /** A stop is typed that the server refuses (not below the entry, or not a price): the order is checked without it, and not sent */
  const stopBad = stopText !== '' && !stopAttached;

  // Where channel trailing keeps the stop now: the server's exit line for the rule's days, else the N-day low of the daily bars.
  const channelBars = /^\d+$/.test(exitForm.channelBars.trim()) ? Number(exitForm.channelBars.trim()) : null;
  const candles = useQuery({
    queryKey: ['signal-candles', inst.instId],
    queryFn: () => api.candles({ instId: inst.instId, bar: '1D', limit: 120 }),
    enabled: row.tracked && exitForm.trailing === 'channel' && channelBars !== null && channelBars !== res.params.exitChannel,
    staleTime: 5 * 60_000,
  });
  const channelLevel =
    exitForm.trailing !== 'channel' || channelBars === null
      ? null
      : channelBars === res.params.exitChannel
        ? (row.holding?.trailingLine ?? row.levels.nextExit ?? plan.stopPx)
        : channelLevelOf(candles.data, channelBars, 'long');
  // Where a callback trailing stop would trigger now: back from the entry, or, while the activation price is not
  // reached, from that at the earliest; the stop it puts after the fill is the trigger now, once armed.
  const activePx = exitForm.activePx.trim();
  const callbackTrigger = exitForm.trailing === 'callback' ? callbackTriggerNow(exitForm.callbackPct, entryRef, { direction: 'long', inst }, activePx === '' ? null : activePx) : null;
  const callbackPending = exitForm.trailing === 'callback' && activationPending(entryRef, activePx === '' ? null : activePx, 'long');
  const callbackStop = callbackTrigger !== null && !callbackPending && (safeDecimal(entryRef)?.gt(callbackTrigger) ?? false) ? callbackTrigger : null;

  /** The stop the order will have: the attached one, or the trailing stop's after the fill; null with neither (or a stop the server refuses) */
  const stopRef: StopRef | null =
    stopAttached && stopPx !== null
      ? { px: stopPx, kind: 'attached' }
      : stopText !== ''
        ? null
        : channelLevel !== null
          ? { px: channelLevel, kind: 'channel' }
          : callbackStop !== null
            ? { px: callbackStop, kind: 'callback' }
            : null;
  /** A callback trailing stop nearer than the stop the risk is counted with: it fires first */
  const callbackFirst = stopRef !== null && stopRef.kind !== 'callback' && callbackStop !== null && D(callbackStop).gt(stopRef.px) ? callbackStop : null;

  // The risk limits as the engine applies them to this order: what is held now, the balance, the slippage it tolerates on a market fill.
  const limits = useMemo((): SizeLimits => {
    const held = exposureNow(inst.instId, positions, Object.values(orders), instruments);
    const avail = balance?.details.find((d) => d.ccy === inst.settleCcy)?.availEq ?? null;
    return {
      maxOrderNotional: riskConfig?.maxOrderNotional ?? null,
      maxPositionNotionalPerInstrument: riskConfig?.maxPositionNotionalPerInstrument ?? null,
      maxTotalPositionNotional: riskConfig?.maxTotalPositionNotional ?? null,
      slippagePct: ordType === 'market' ? (riskConfig?.maxSlippagePct ?? null) : null,
      instrumentNotional: held.instrument.toFixed(),
      totalNotional: held.total.toFixed(),
      availEq: avail === null || avail === '' ? null : avail,
      leverage: leverage.trim(),
      feeRate: res.params.feeRate,
    };
  }, [inst, positions, orders, instruments, balance, riskConfig, ordType, leverage, res.params.feeRate]);

  // The size the program fills in, for the form as it is now: the risk's contracts (whole lots, at least the minimum
  // order) at the stop the order will have, cut to the limits; null while it cannot be computed (no equity, no risk
  // percentage, no stop). The field follows it until the trader types a size (sizeIsAuto), so the note under the
  // field is always true of the figure in it.
  const autoNow = useMemo((): AutoSize | null => {
    const share = safeDecimal(riskPct.trim());
    const sized = contractsForRisk(res.equity, share === null ? null : share.div(100), entryRef, stopRef?.px ?? null, inst);
    if (sized === null) return null;
    const capped = capContracts(sized.contracts, entryRef, inst, limits) ?? { contracts: sized.contracts, perContract: '', bound: null, limit: '', max: sized.contracts, belowMin: false };
    return { riskContracts: sized.contracts, riskPct: riskPct.trim(), belowMin: sized.belowMin, capped };
  }, [riskPct, res.equity, entryRef, stopRef?.px, inst, limits]);
  const [sizeIsAuto, setSizeIsAuto] = useState(true);
  const [contracts, setContracts] = useState(() => autoNow?.capped.contracts ?? plan.contracts ?? '');
  useEffect(() => {
    if (!sizeIsAuto || autoNow === null) return;
    setContracts((c) => (c.trim() === autoNow.capped.contracts ? c : autoNow.capped.contracts));
  }, [sizeIsAuto, autoNow]);
  const contractsText = contracts.trim();
  const sizeOk = positive(contractsText);
  // The size the server sends: whole lots rounded down (as sizeToContracts does), refused below the minimum order.
  const sizeLots = sizeOk ? floorToStep(contractsText, inst.lotSz) : null;
  const sizeOffLot = sizeLots !== null && !sizeLots.eq(contractsText);
  const sizeBelowMin = sizeLots !== null && sizeLots.lt(inst.minSz);
  const sizeSent = sizeLots !== null && !sizeBelowMin ? sizeLots.toFixed() : null;
  /** The size the program would fill in, for the words that ask for one ('' when there is none) */
  const proposedSize = (() => {
    const c = autoNow?.capped.contracts ?? plan.contracts;
    return c === null || c === undefined ? '' : fmtContracts(c, inst);
  })();

  // The exit plan is measured against the stop the order will have: the attached one, or the trailing stop's (which
  // the exchange cannot move to the entry after the first take-profit: only an attached stop). A stop typed on the
  // wrong side is handed over as it is, so that the editor says it does not count.
  const exitStop = stopRef?.px ?? (stopInvalid ? null : stopPx);
  const exitStopAttached = stopRef === null || stopRef.kind === 'attached';
  const exitCtx = useMemo(
    (): ExitContext => ({ direction: 'long', entry: entryRef, stop: exitStop, stopAttached: exitStopAttached, inst, whole: true, contracts: sizeSent }),
    [entryRef, exitStop, exitStopAttached, inst, sizeSent],
  );
  // The take-profit levels the trader has left to the program follow the stop: R multiples with one, percentages
  // without; the cost-price stop only with an attached one.
  const hasStop = riskDistance(exitCtx) !== null;
  const breakevenOk = stopAttachedOf(exitCtx);
  const breakevenWas = useRef(breakevenOk);
  useEffect(() => {
    // a stop attached where the channel's stood in: the levels stay, a ladder left to the program takes the cost-price stop again
    const attachedNow = breakevenOk && !breakevenWas.current;
    breakevenWas.current = breakevenOk;
    setExitForm((f) => proposeLevels(f, hasStop, true, false, breakevenOk, attachedNow));
  }, [hasStop, breakevenOk]);
  const checked = useMemo(() => checkExitForm(exitForm, exitCtx), [exitForm, exitCtx]);
  const exitsOk = checked.errors.length === 0;

  // The order is previewed with the parts of the exit plan that are complete, and without a stop the server refuses,
  // so the figures never go blank while a leg or the stop is written; such an order is not sent (canConfirm).
  const request = useMemo((): PlaceOrderRequest | null => {
    if (sizeSent === null) return null;
    const candidate: Record<string, unknown> = {
      instId: plan.instId,
      side: 'buy',
      ordType,
      tdMode: mgnMode,
      size: { unit: 'contracts', value: sizeSent },
      ...checked.fields,
      source: 'signal',
      signal,
    };
    if (ordType === 'limit') candidate['px'] = pxText;
    if (stopAttached && stopPx !== null) candidate['slTriggerPx'] = stopPx;
    // posSide only in long/short mode; an opening order carries no reduce-only flag
    if (longShort) candidate['posSide'] = 'long';
    const parsed = placeOrderRequestSchema.safeParse(candidate);
    return parsed.success ? parsed.data : null;
  }, [checked.fields, stopAttached, stopPx, plan.instId, ordType, mgnMode, sizeSent, signal, pxText, longShort]);
  const preview = useOrderPreview(request);

  // The leverage set now for the instrument and margin mode: the one the preview checks against until it is changed.
  const levQuery = useQuery({ queryKey: ['leverage', inst.instId, mgnMode], queryFn: () => api.leverage(inst.instId, mgnMode), staleTime: 60_000 });
  const current = levQuery.data?.find((l) => l.posSide === 'long') ?? levQuery.data?.[0];
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
  const previewError = preview.error !== null && preview.error !== undefined ? explainError(preview.error, t) : null;
  // The preview checks the leverage set now; the one asked for here is set before the order is sent.
  const leverageFixes = p !== undefined && !p.risk.ok && p.risk.code === 'MAX_LEVERAGE' && leverageChanges && riskMax !== null && D(leverage.trim()).lte(riskMax);
  const verdictOk = p !== undefined && (p.risk.ok || leverageFixes);

  // Figures of the order as the form holds it, before the server has answered; the server's once it has.
  const sizeNow = p?.sz ?? sizeSent ?? contractsText;
  /** The size in words: on the lot, or exactly as typed when it is not (the note says what is sent) */
  const sizeWords = sizeSent !== null || p !== undefined ? fmtContracts(sizeNow, inst) : fmtContracts(contractsText, null);
  const priceNow = p === undefined ? entryRef : ordType === 'market' ? p.refPrice : p.px;
  const localRisk = stopRef === null ? null : riskOf(sizeSent, entryRef, stopRef.px, inst);
  const localShare = shareOf(localRisk?.toFixed() ?? null, res.equity);
  const localNotional = notionalOf(sizeSent, entryRef, inst);
  const coinText = sizeOk ? `${fmtCoin(sizeNow, inst)} ${inst.baseCcy}` : DASH;
  const notional = p?.notionalQuote ?? localNotional?.toFixed() ?? null;
  const loss = p !== undefined && p.stopLossQuote !== '' ? D(p.stopLossQuote) : localRisk;
  const lossShare = shareOf(loss, res.equity);
  /** The loss at the callback trailing stop when it fires before the stop the risk is counted with */
  const callbackLoss = callbackFirst === null ? null : riskOf(sizeSent, entryRef, callbackFirst, inst);
  const callbackLossShare = shareOf(callbackLoss, res.equity);
  const margin = leverageValid ? marginAt(notional, leverage.trim()) : null;
  const fee = notional === null ? null : D(notional).mul(res.params.feeRate);
  // The estimated liquidation at the chosen leverage, and whether it is safely below the stop (the server does not
  // check that). An entry's is the new position's (it does not depend on the size: one contract while none is typed);
  // an add's is the position's after it (as the plan's rule, LIQUIDATION_NEAR_STOP), which for a cross holding is the
  // account's and cannot be estimated.
  const holding = plan.kind === 'add' ? row.holding : null;
  const liqOfAccount = mgnMode !== 'isolated' || (plan.kind === 'add' && holding?.mgnMode !== 'isolated');
  const liq =
    liqOfAccount || !leverageValid
      ? null
      : holding !== null
        ? liqAfterAdd(holding, sizeOk ? sizeNow : null, priceNow, leverage.trim(), plan.maintenanceRate, inst)
        : estimateLiqPx(sizeOk ? sizeNow : '1', priceNow, leverage.trim(), plan.maintenanceRate, inst);
  const liqLimit = stopRef === null ? null : liquidationLimitOf(D(stopRef.px), res.thresholds.liqBufferPct);
  const liqRelation = liq === null || liqLimit === null || stopRef === null ? null : liqRelationOf(liq, D(stopRef.px), liqLimit);
  const liqBad = liqRelation !== null;
  const safeLeverage = !liqBad
    ? null
    : holding !== null
      ? safeLeverageAfterAdd(holding, sizeOk ? sizeNow : null, priceNow, liqLimit, leverage.trim(), plan.maintenanceRate, inst)
      : safeLeverageFor(priceNow, liqLimit, leverage.trim(), plan.maintenanceRate, inst);
  const liqWords =
    liqBad && liq !== null
      ? t.follow.liqAboveStop({
          liqPx: fmtPx(liq.toFixed(), inst),
          stopPx: fmtPx(stopRef?.px ?? null, inst),
          limitPx: fmtPx(liqLimit?.toFixed() ?? null, inst),
          leverage: leverage.trim(),
          safeLeverage: safeLeverage === null ? '' : String(safeLeverage),
          relation: liqRelation ?? '',
          add: holding !== null,
        })
      : null;
  const legs =
    p?.takeProfits ??
    (exitForm.tpMode === 'none'
      ? []
      : legFigures(exitForm, exitCtx).flatMap((f, i) =>
          f.px === null || f.sz === null || rowError(checked.errors, i + 1) !== null ? [] : [{ triggerPx: f.px, sz: f.sz.toFixed(), profitQuote: f.profit?.toFixed() ?? '' }],
        ));
  const firstError = checked.errors[0];
  const problem = firstError === undefined ? null : exitErrorText(firstError, exitForm, exitCtx, t).text;

  const canConfirm = block === null && verdictOk && leverageValid && exitsOk && !stopBad && !liqBad && sizeSent !== null && !flow.isPending;

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

  /** The size is the program's again: what the risk sizes at the stop the order will have, cut to the limits (and it follows the form from here). */
  const sizeFromRisk = () => {
    setSizeIsAuto(true);
    if (autoNow !== null) setContracts(autoNow.capped.contracts);
  };

  // The sentence: the size, the stop and the loss at it, the exit plan as the form holds it (what is wrong with it included).
  const stopLine = (stopAt: string): StopLineText => {
    const e = safeDecimal(entryRef);
    const s = safeDecimal(stopAt);
    const below = e === null || s === null || !e.gt(0) ? null : e.minus(s).div(e);
    return {
      stop: fmtPx(stopAt, inst),
      stopPct: below === null || !below.gt(0) ? '' : fmtPct(below, 2),
      risk: loss === null ? '' : fmtNum(loss, 2),
      riskPct: lossShare === null ? '' : fmtShare(lossShare),
    };
  };
  const callbackFirstWords = callbackFirst === null || callbackLoss === null ? null : t.follow.callbackFirst(fmtPx(callbackFirst, inst), fmtNum(callbackLoss, 2), callbackLossShare === null ? '' : fmtShare(callbackLossShare));
  const stopWords = (() => {
    const words =
      stopRef?.kind === 'attached'
        ? t.follow.stopLine(stopLine(stopRef.px))
        : stopRef?.kind === 'channel'
          ? t.follow.stopByChannel(stopLine(stopRef.px))
          : stopRef?.kind === 'callback'
            ? t.follow.stopByCallback(stopLine(stopRef.px))
            : stopInvalid
              ? t.follow.stopInvalidLine(stopText)
              : stopText !== ''
                ? t.follow.stopWrongLine(fmtPx(stopPx, inst))
                : t.follow.noStopLine;
    return callbackFirstWords === null ? words : t.exits.joinParts([words, callbackFirstWords]);
  })();
  const exitsText = exitFormText(exitForm, exitCtx, inst, t, { channelLevel, callbackTrigger, callbackPending });
  const summary = t.follow.summary({
    size: sizeOk ? t.follow.sizeText(sizeWords, coinText) : t.follow.sizeMissing(proposedSize),
    instId: inst.instId,
    ordType,
    limitPx: ordType === 'limit' && limitPxOk ? fmtPx(pxText, inst) : '',
    mgnMode: t.enums.mgnMode[mgnMode],
    leverage: leverageValid ? leverage.trim() : '',
    stop: stopWords,
    exits: exitsText,
  });

  // What the size field says under itself: the program's size when none is filled in, what the server makes of a size
  // off the lot or below the minimum, how the program sized it (and what cut it), or the limit a typed size is over.
  const sizeNote = ((): Note | null => {
    if (!sizeOk) return { cls: 'warn', text: t.follow.sizeNotFilled(proposedSize) };
    if (sizeBelowMin) return { cls: 'warn', text: t.follow.sizeBelowMin(fmtContracts(contractsText, null), fmtContracts(inst.minSz, inst)) };
    if (sizeOffLot && sizeSent !== null) return { cls: 'warn', text: t.follow.sizeOffLot(fmtContracts(contractsText, null), fmtContracts(sizeSent, inst), fmtContracts(inst.lotSz, inst)) };
    if (sizeIsAuto && autoNow !== null && contractsText === autoNow.capped.contracts) {
      const c = autoNow.capped;
      const counted = { perContract: c.bound === null ? '' : fmtNum(c.perContract, 2), slippagePct: limits.slippagePct === null ? '' : fmtPct(limits.slippagePct, 2) };
      if (c.bound !== null && c.belowMin) return { cls: 'warn', text: t.follow.capBelowMin(t.follow.bound[c.bound], fmtNum(c.limit, 2), fmtContracts(inst.minSz, inst)) };
      if (c.bound !== null) {
        const riskAmount = stopRef === null ? null : riskOf(c.contracts, entryRef, stopRef.px, inst);
        return {
          cls: 'warn',
          text: t.follow.cappedBy({
            riskPct: fmtPct(D(autoNow.riskPct).div(100), 2),
            riskContracts: fmtContracts(autoNow.riskContracts, inst),
            bound: t.follow.bound[c.bound],
            limit: fmtNum(c.limit, 2),
            contracts: fmtContracts(c.contracts, inst),
            riskAmount: riskAmount === null ? '' : fmtNum(riskAmount, 2),
            riskShare: riskAmount === null ? '' : fmtShare(shareOf(riskAmount, res.equity)),
            ...counted,
          }),
        };
      }
      if (autoNow.belowMin) return { cls: 'warn', text: t.follow.belowMin(fmtContracts(inst.minSz, inst)) };
      return null;
    }
    if (sizeIsAuto && autoNow === null && !positive(riskPct)) return { cls: 'warn', text: t.follow.riskPctInvalid };
    const typed = capContracts(contractsText, entryRef, inst, limits);
    if (typed !== null && typed.bound !== null) {
      const max = typed.belowMin ? inst.minSz : typed.max;
      return {
        cls: 'warn',
        text: t.follow.overCap({
          riskPct: '',
          riskContracts: '',
          bound: t.follow.bound[typed.bound],
          limit: fmtNum(typed.limit, 2),
          contracts: fmtContracts(typed.max, inst),
          riskAmount: '',
          riskShare: '',
          perContract: fmtNum(typed.perContract, 2),
          slippagePct: limits.slippagePct === null ? '' : fmtPct(limits.slippagePct, 2),
        }),
        action: {
          label: t.follow.useCap(fmtContracts(max, inst)),
          run: () => {
            setSizeIsAuto(false);
            setContracts(max);
          },
        },
      };
    }
    return null;
  })();

  // What the stop field says under itself: how far below the entry it is (and the tick it is rounded to), that the
  // server refuses it, or the program's stop and the trailing stop's level after the fill when none is attached.
  const afterFill = stopRef?.kind === 'channel' ? t.follow.afterFillChannel(fmtPx(stopRef.px, inst)) : stopRef?.kind === 'callback' ? t.follow.afterFillCallback(fmtPx(stopRef.px, inst)) : '';
  const stopNote =
    stopText === ''
      ? t.follow.stopNotFilled(plan.stopPx === '' ? '' : fmtPx(plan.stopPx, inst), afterFill)
      : stopInvalid
        ? t.follow.stopInvalid
        : stopShare !== null && stopShare.gt(0)
          ? `${t.follow.stopBelow(fmtPct(stopShare, 2))}${stopOffTick && stopPx !== null ? ` · ${t.follow.stopOnTick(fmtPx(stopPx, inst), inst.tickSz)}` : ''}`
          : t.follow.stopNotBelow;

  const trigger = row.holding?.addTrigger ?? signal.entryLevel;
  const signalLine = t.follow.signalLine(utcLocal(signalCloseTs(signal), t), fmtPx(signal.close, inst), fmtPx(signal.kind === 'entry' ? signal.entryLevel : trigger, inst), signal.kind, res.params.entryChannel);

  /** The stop typed is refused by the sheet itself (the server would refuse the order): not below the entry, or not a price. */
  const stopRefusal = stopBad ? (stopInvalid ? t.follow.whyStopInvalid : t.follow.whyStopWrong) : null;
  /** The size typed is refused by the sheet itself: below the minimum order once rounded to the lot. */
  const sizeRefusal = sizeOk && sizeBelowMin ? t.follow.whySizeBelowMin(fmtContracts(inst.minSz, inst), proposedSize) : null;

  /** The verdict of the check: the server's error or refusal, what the order still lacks, the stop or the liquidation against it, or the pass (partial while the exit plan has a part to fix). */
  const verdict = (() => {
    if (sizeRefusal !== null) return <div className="risk-msg bad">{sizeRefusal}</div>;
    if (previewError !== null) return <div className="risk-msg bad">{previewError}</div>;
    if (stopRefusal !== null) return <div className="risk-msg bad">{stopRefusal}</div>;
    if (!leverageValid) return <div className="risk-msg bad">{t.follow.whyLeverage}</div>;
    if (p === undefined) {
      if (request !== null) return <div className="risk-msg dim">{`${t.follow.checking} · ${t.follow.estimated}`}</div>;
      return <div className="risk-msg dim">{!limitPxOk ? t.follow.enterLimitPx : !sizeOk ? t.follow.enterSize(proposedSize) : t.follow.incomplete}</div>;
    }
    if (liqWords !== null) return <div className="risk-msg bad">{liqWords}</div>;
    if (p.risk.ok) return exitsOk ? <div className="risk-msg good">{t.follow.riskOk}</div> : <div className="risk-msg warn">{t.follow.riskOkPartial}</div>;
    if (leverageFixes) return <div className="risk-msg good">{t.follow.leverageWillPass(leverage.trim())}</div>;
    return <div className="risk-msg bad">{`${p.risk.code}: ${riskText(p.risk, t)}`}</div>;
  })();

  /** Why the confirm button is disabled, beside it; null when it is not. */
  const why = (() => {
    if (block !== null || flow.isPending) return null;
    if (!leverageValid) return t.follow.whyLeverage;
    if (!limitPxOk) return t.follow.whyNoPx;
    if (!sizeOk) return t.follow.whyNoSize(proposedSize);
    if (sizeRefusal !== null) return sizeRefusal;
    if (stopRefusal !== null) return stopRefusal;
    if (!exitsOk && problem !== null) return t.follow.whyExits(problem);
    if (request === null) return t.follow.incomplete;
    if (liqBad) return t.follow.whyLiquidation(safeLeverage === null ? '' : String(safeLeverage));
    if (previewError !== null) return t.follow.whyError(previewError);
    if (p === undefined) return t.follow.checking;
    if (!verdictOk) return t.follow.whyRefused(p.risk.code, riskText(p.risk, t));
    return null;
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
        {why !== null && <span className="follow-why warn">{why}</span>}
        <button className="btn" onClick={onClose} disabled={flow.isPending}>
          {t.follow.cancel}
        </button>
        <button className="btn btn-buy follow-confirm" onClick={confirm} disabled={!canConfirm} title={why ?? summary}>
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
      <PlanWarnings plan={plan} inst={inst} liqBufferPct={res.thresholds.liqBufferPct} omit={SIZE_WARNINGS} note={t.follow.planFigures} />
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
                  {!limitPxOk && <span className="follow-hint warn">{t.follow.whyNoPx}</span>}
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
                {!leverageValid && <span className="follow-hint warn">{t.follow.whyLeverage}</span>}
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
                    setSizeIsAuto(false);
                    setContracts(e.target.value);
                  }}
                />
                <span className="follow-hint num">{sizeOk ? `${coinText}${localShare === null ? '' : ` · ${t.follow.atRiskShare(fmtShare(localShare))}`}` : ''}</span>
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
            {sizeNote !== null && (
              <div className={`follow-note follow-size-note ${sizeNote.cls}`}>
                {sizeNote.text}
                {sizeNote.action !== undefined && (
                  <button type="button" className="btn btn-sm follow-use-cap" onClick={sizeNote.action.run}>
                    {sizeNote.action.label}
                  </button>
                )}
              </div>
            )}
          </section>

          <section className="follow-section">
            <h5>{t.follow.stop}</h5>
            <label className="follow-field">
              <span className="input-group">
                <input className="num" inputMode="decimal" aria-label={t.follow.stop} value={stop} onChange={(e) => setStop(e.target.value)} />
                {plan.stopPx !== '' && stopText !== plan.stopPx && (
                  <button type="button" className="btn btn-sm btn-ghost exit-suggest follow-stop-suggest" title={t.follow.suggestStopTitle} onClick={() => setStop(plan.stopPx)}>
                    {t.follow.suggest}
                  </button>
                )}
              </span>
              <span className={`follow-hint num${stopText === '' || stopBad ? ' warn' : ''}`}>{stopNote}</span>
            </label>
          </section>

          <section className="follow-section">
            <h5>{t.follow.exitPlan}</h5>
            <ExitPlanEditor form={exitForm} update={setExitForm} ctx={exitCtx} channelLevel={channelLevel} />
          </section>
        </div>

        <div className="follow-side">
          <section className="follow-section preview follow-check">
            <h5>{t.follow.check}</h5>
            <div className="kv num">
              <span>{t.preview.contracts}</span>
              <span>{sizeOk ? t.common.ct(sizeWords) : DASH}</span>
            </div>
            <div className="kv num">
              <span>{t.preview.coin}</span>
              <span>{coinText}</span>
            </div>
            <div className="kv num">
              <span>{ordType === 'market' ? t.follow.refPrice : t.follow.limitPx}</span>
              <span>{limitPxOk ? fmtPx(priceNow, inst) : <span className="dim">{t.follow.limitPxMissing(fmtPx(plan.entryPx, inst))}</span>}</span>
            </div>
            <div className="kv num">
              <span>{t.follow.notional}</span>
              <span>{notional === null ? DASH : `${fmtNum(notional, 2)} USDT`}</span>
            </div>
            {ordType === 'market' && (
              <div className="kv num">
                <span>{t.follow.estSlippage}</span>
                <span>{p === undefined || p.estSlippagePct === '' ? DASH : fmtPct(p.estSlippagePct, 3)}</span>
              </div>
            )}
            <div className="kv num">
              <span>{leverageValid ? t.follow.marginAt(leverage.trim()) : t.follow.margin}</span>
              <span>{margin !== null ? `${fmtNum(margin, 2)} USDT` : leverageValid ? DASH : <span className="dim">{t.follow.leverageMissing}</span>}</span>
            </div>
            <div className="kv num">
              <span>{t.follow.fee(fmtPct(res.params.feeRate, 3))}</span>
              <span>{fee === null ? DASH : `${fmtNum(fee, 4)} USDT`}</span>
            </div>
            <div className="kv num">
              <span>{t.follow.liqPx}</span>
              <span className={liqBad ? 'neg' : ''}>
                {liqOfAccount ? (
                  <span className="dim">{t.follow.liqCross}</span>
                ) : !leverageValid ? (
                  <span className="dim">{t.follow.leverageMissing}</span>
                ) : liq === null ? (
                  DASH
                ) : !liq.gt(0) ? (
                  <span className="dim">{t.follow.liqNone}</span>
                ) : (
                  fmtPx(liq.toFixed(), inst)
                )}
              </span>
            </div>
            <div className="kv num">
              <span>{t.follow.lossAtStop}</span>
              <span className="neg">
                {loss === null ? (
                  stopRef === null ? <span className="dim">{stopText === '' ? t.follow.lossNotBounded : stopInvalid ? t.follow.stopInvalid : t.follow.stopNotBelow}</span> : DASH
                ) : (
                  `${fmtNum(loss, 2)} USDT`
                )}
                {lossShare !== null && <span className="dim"> · {t.follow.ofEquity(fmtShare(lossShare))}</span>}
                {loss !== null && stopRef?.kind === 'channel' && <span className="dim"> · {t.follow.lossAtChannel(fmtPx(stopRef.px, inst))}</span>}
                {loss !== null && stopRef?.kind === 'callback' && <span className="dim"> · {t.follow.lossAtCallback(fmtPx(stopRef.px, inst))}</span>}
                {callbackFirstWords !== null && <span className="dim follow-callback-first"> · {callbackFirstWords}</span>}
              </span>
            </div>
            {legs.length > 0 && (
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
                  {legs.map((leg, i) => (
                    <tr key={i} className="num">
                      <td>{t.follow.tpLeg(i + 1)}</td>
                      <td>{fmtPx(leg.triggerPx, inst)}</td>
                      <td>{fmtContracts(leg.sz, inst)}</td>
                      <td className="pos">{leg.profitQuote === '' ? DASH : `+${fmtNum(leg.profitQuote, 2)} USDT`}</td>
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
