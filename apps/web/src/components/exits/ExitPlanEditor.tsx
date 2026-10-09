import { useId } from 'react';
import { useT } from '../../i18n';
import {
  MAX_TP_LEGS,
  activationPending,
  addLadderLeg,
  breakevenAllowed,
  callbackTriggerNow,
  checkExitForm,
  convertRow,
  ladderRest,
  legFigures,
  offTick,
  proposeLeg,
  proposeTakeProfits,
  proposedRows,
  riskDistance,
  rowError,
  stopAttachedOf,
  type ExitContext,
  type ExitForm,
  type ExitFormError,
  type LegFigures,
  type TpBasis,
  type TpMode,
  type TpRow,
  type TrailingMode,
} from '../../lib/exits';
import { exitErrorText } from '../../lib/describe';
import { fmtContracts, fmtNum, fmtPct, fmtPx, safeDecimal } from '../../lib/format';

interface Props {
  form: ExitForm;
  /** Applies a change to the form as it is then (two quick edits must not undo each other) */
  update: (change: (form: ExitForm) => ExitForm) => void;
  ctx: ExitContext;
  /** Offer "none" among the take-profit and trailing choices (an order may have neither; a form that places one may not) */
  noneOption?: boolean;
  /** Offer take-profits */
  takeProfit?: boolean;
  /** Offer the trailing stop */
  trailing?: boolean;
  /** Offer channel trailing (an exit of an order, or of a position) */
  channel?: boolean;
  /** Offer the cost-price stop (an opening order with a stop) */
  breakeven?: boolean;
  /** Where channel trailing keeps the stop now, for the days of the form; null when not known (it is computed when the order is placed) */
  channelLevel?: string | null;
  /** The price a callback trailing stop is measured from now (the mark of a position); the entry of `ctx` when not given */
  priceNow?: string | null;
  /** A note on the entry the levels are measured from (a market order's last price, frozen); none when not given */
  entryNote?: string | null;
}

/** A row of buttons of which one is chosen. */
export function Segmented<T extends string>({ value, options, onChange, label }: { value: T; options: ReadonlyArray<{ id: T; label: string }>; onChange: (v: T) => void; label: string }) {
  return (
    <div className="seg" role="radiogroup" aria-label={label}>
      {options.map((o) => (
        <button key={o.id} type="button" role="radio" aria-checked={value === o.id} className={`seg-btn${value === o.id ? ' active' : ''}`} onClick={() => onChange(o.id)}>
          {o.label}
        </button>
      ))}
    </div>
  );
}

/**
 * The exit plan of an order or of a position: take-profits (none, single or a ladder of up to five legs, each given
 * as a price, an R multiple or a percentage from the entry, with a share of the size; on an opening order the last leg
 * takes the rest) with the cost-price stop, and a trailing stop (channel or callback). Every level is proposed by the
 * program when a mode is chosen (lib/exits.ts, proposeTakeProfits) and every row says what it comes to: the price on
 * the tick, the gain and the R multiple, the leg's contracts and its profit. What is wrong or missing is said under
 * its own row; the trailing stop says where it stands now.
 */
export function ExitPlanEditor({ form, update, ctx, takeProfit = true, trailing = true, channel = true, breakeven = true, noneOption = true, channelLevel = null, priceNow, entryNote = null }: Props) {
  const t = useT();
  const id = useId();
  const set = (p: Partial<ExitForm>) => update((f) => ({ ...f, ...p }));
  const setRow = (i: number, p: Partial<TpRow>) => update((f) => ({ ...f, ladder: f.ladder.map((r, n) => (n === i ? { ...r, ...p } : r)) }));
  const rest = ladderRest(form.ladder);
  const short = ctx.direction === 'short';
  const hasStop = riskDistance(ctx) !== null;
  const entryKnown = safeDecimal(ctx.entry) !== null;
  const canBreakeven = breakeven && breakevenAllowed(form, stopAttachedOf(ctx));
  // Only the parts offered here are checked: a form that places one exit is not blamed for the other.
  const checked = checkExitForm({ ...form, ...(takeProfit ? {} : { tpMode: 'none' as const }), ...(trailing ? {} : { trailing: 'none' as const }) }, ctx);
  const figures = legFigures(form, ctx);
  const general = checked.errors.filter((e) => !('leg' in e));

  /**
   * What a row stands for besides what was typed: the price, the gain, the R, the leg's contracts and profit. A row
   * with an error says the price it comes to at most (its contracts and profit would mean nothing).
   */
  const echo = (row: TpRow, fig: LegFigures | undefined, wrong: boolean): string => {
    if (fig === undefined || fig.px === null) return '';
    const parts: string[] = [];
    if (row.basis !== 'price') parts.push(t.exits.atPrice(fmtPx(fig.px, ctx.inst)));
    // a typed price off the tick: the price it is rounded to, as the API rounds it
    else if (offTick(row, ctx)) parts.push(t.exits.onTick(fmtPx(fig.px, ctx.inst), ctx.inst?.tickSz ?? ''));
    // the gain: not for a row given as one, unless the tick makes it another (10% comes to +9.99%)
    if (fig.gain !== null && fig.gain.gt(0) && (row.basis !== 'pct' || fmtPct(fig.gain, 2) !== fmtPct(safeDecimal(row.value.trim())?.div(100) ?? null, 2))) parts.push(t.exits.gain(fmtPct(fig.gain, 2)));
    if (row.basis !== 'r' && fig.r !== null && fig.r.gt(0)) parts.push(t.exits.asR(fmtNum(fig.r, 2)));
    if (!wrong && fig.sz !== null) parts.push(t.exits.legSize(fmtContracts(fig.sz, ctx.inst)));
    if (!wrong && fig.profit !== null && fig.profit.gt(0)) parts.push(t.exits.legProfit(fmtNum(fig.profit, 2)));
    return parts.join(' · ');
  };

  /** What a row says under itself: its error, or what is still missing with the program's proposal. */
  const rowMessage = (i: number): { text: string; cls: string } | null => {
    const error = rowError(checked.errors, i + 1);
    if (error === null) return null;
    const words = exitErrorText(error, form, ctx, t);
    return { text: words.text, cls: words.missing ? 'exit-hint warn' : 'exit-error neg' };
  };
  const rowWrong = (i: number): boolean => rowError(checked.errors, i + 1) !== null;

  const basisSelect = (row: TpRow, onBasis: (b: TpBasis) => void, aria: string) => (
    <select className="exit-basis" value={row.basis} onChange={(e) => onBasis(e.target.value as TpBasis)} title={t.exits.basisTitle} aria-label={aria}>
      <option value="price">{t.exits.basis.price}</option>
      <option value="r">{t.exits.basis.r}</option>
      <option value="pct">{t.exits.basis.pct}</option>
    </select>
  );
  /** The Suggest button of a row, shown while the row does not hold the program's level. */
  const suggestButton = (row: TpRow, i: number) => {
    const mode = form.tpMode === 'single' ? 'single' : 'ladder';
    const p = proposedRows(mode, mode === 'single' ? 1 : form.ladder.length, hasStop, ctx.whole, ctx)[i];
    if (p !== undefined && p.basis === row.basis && p.value === row.value.trim()) return null;
    return (
      <button type="button" className="btn btn-sm btn-ghost exit-suggest" title={t.exits.suggestTitle} onClick={() => update((f) => proposeLeg(f, i, ctx))}>
        {t.exits.suggest}
      </button>
    );
  };

  const tpModes: ReadonlyArray<{ id: TpMode; label: string }> = (['none', 'single', 'ladder'] as const)
    .filter((m) => noneOption || m !== 'none')
    .map((m) => ({ id: m, label: t.exits.tpMode[m] }));
  const trailingModes: ReadonlyArray<{ id: TrailingMode; label: string }> = (['none', 'channel', 'callback'] as const)
    .filter((m) => (noneOption || m !== 'none') && (channel || m !== 'channel'))
    .map((m) => ({ id: m, label: t.exits.trailingMode[m] }));

  const renderMessage = (m: { text: string; cls: string } | null) => (m === null ? null : <div className={m.cls} role={m.cls.startsWith('exit-error') ? 'alert' : undefined}>{m.text}</div>);
  const generalError = (code: ExitFormError['code']) => general.find((e) => e.code === code);
  const errorWords: Record<ExitFormError['code'], (leg: number) => string> = t.exits.error;
  const bars = form.channelBars.trim() === '' ? '…' : form.channelBars.trim();
  // the callback stop measured from the price now: back from it, or, while the activation price is not reached, from that
  const priceRef = priceNow === undefined ? ctx.entry : priceNow;
  const activePx = form.activePx.trim();
  const callbackPx = callbackTriggerNow(form.callbackPct, priceRef, ctx, activePx === '' ? null : activePx);
  const callbackPending = activationPending(priceRef, activePx === '' ? null : activePx, ctx.direction);
  // a stop typed but not on the losing side of the entry does not count for the levels: said, not silently dropped
  const stopTyped = safeDecimal(ctx.stop);
  const stopIgnored = stopTyped !== null && stopTyped.gt(0) && !hasStop && entryKnown;
  // the channel level now on the profit side of the entry (or at it): a stop there fires at once
  const channelWrong = (() => {
    const level = safeDecimal(channelLevel);
    const entry = safeDecimal(ctx.entry);
    return level !== null && entry !== null && (short ? level.lte(entry) : level.gte(entry));
  })();

  return (
    <div className="exit-editor">
      {takeProfit && (
        <div className="exit-block">
          <div className="exit-head">
            <span className="exit-label">{t.exits.tp}</span>
            <Segmented value={form.tpMode} options={tpModes} onChange={(tpMode) => update((f) => proposeTakeProfits({ ...f, tpMode }, ctx))} label={t.exits.tp} />
          </div>
          {form.tpMode === 'single' && (
            <>
              <div className="exit-row">
                {basisSelect(form.single, (basis) => update((f) => ({ ...f, single: convertRow(f.single, basis, ctx) })), `${t.exits.tp} 1`)}
                <input
                  className="num"
                  inputMode="decimal"
                  aria-label={`${t.exits.tp} 1 ${t.exits.value}`}
                  value={form.single.value}
                  onChange={(e) => set({ single: { ...form.single, value: e.target.value } })}
                />
                {!ctx.whole && (
                  <span className="exit-pct">
                    <input className="num" inputMode="decimal" aria-label={`${t.exits.tp} 1 ${t.exits.pctOfPosition}`} value={form.single.pct} onChange={(e) => set({ single: { ...form.single, pct: e.target.value } })} />
                    <span className="dim">{t.exits.pctOfPosition}</span>
                  </span>
                )}
                {suggestButton(form.single, 0)}
                <span className="exit-echo num">{echo(form.single, figures[0], rowWrong(0))}</span>
              </div>
              {renderMessage(rowMessage(0))}
            </>
          )}
          {form.tpMode === 'ladder' && (
            <>
              {form.ladder.map((row, i) => {
                const last = i === form.ladder.length - 1;
                const restRow = ctx.whole && last;
                return (
                  <div className="exit-leg-block" key={i}>
                    <div className="exit-row">
                      <span className="exit-leg">{t.follow.tpLeg(i + 1)}</span>
                      {basisSelect(row, (basis) => update((f) => ({ ...f, ladder: f.ladder.map((r, n) => (n === i ? convertRow(r, basis, ctx) : r)) })), `${t.exits.tp} ${i + 1}`)}
                      <input className="num" inputMode="decimal" aria-label={`${t.exits.tp} ${i + 1} ${t.exits.value}`} value={row.value} onChange={(e) => setRow(i, { value: e.target.value })} />
                      <span className="exit-pct">
                        {restRow ? (
                          <span className="exit-rest num" title={t.exits.wholeOrderHint}>
                            {/* no figure while the shares before it are not right (none, or 100% or more: the error says so) */}
                            {rest === null || !rest.gt(0) ? t.exits.rest : `${t.exits.rest} ${fmtPct(rest, 0)}`}
                          </span>
                        ) : (
                          <>
                            <input className="num" inputMode="decimal" aria-label={`${t.exits.tp} ${i + 1} ${ctx.whole ? t.exits.pctOfSize : t.exits.pctOfPosition}`} value={row.pct} onChange={(e) => setRow(i, { pct: e.target.value })} />
                            <span className="dim">%</span>
                          </>
                        )}
                      </span>
                      {suggestButton(row, i)}
                      {form.ladder.length > 2 && (
                        <button type="button" className="btn btn-sm btn-ghost" title={t.exits.removeLeg} aria-label={t.exits.removeLeg} onClick={() => update((f) => ({ ...f, ladder: f.ladder.filter((_, n) => n !== i) }))}>
                          ×
                        </button>
                      )}
                      <span className="exit-echo num">{echo(row, figures[i], rowWrong(i))}</span>
                    </div>
                    {renderMessage(rowMessage(i))}
                  </div>
                );
              })}
              {form.ladder.length < MAX_TP_LEGS && (
                <button type="button" className="btn btn-sm exit-add" onClick={() => update((f) => addLadderLeg(f, ctx))}>
                  {t.exits.addLeg}
                </button>
              )}
              {breakeven && (
                <label className={`check exit-breakeven${canBreakeven ? '' : ' disabled'}`} htmlFor={`${id}-be`}>
                  {/* a tick that can no longer be honoured stays shown, so that it can always be taken off */}
                  <input id={`${id}-be`} type="checkbox" checked={form.breakeven} disabled={!canBreakeven && !form.breakeven} onChange={(e) => set({ breakeven: e.target.checked })} />
                  {t.exits.breakeven}
                  {!canBreakeven && <span className="dim"> ({t.exits.breakevenNeeds})</span>}
                </label>
              )}
              {(['TP_REST', 'TP_OVER_100', 'BREAKEVEN'] as const).map((code) =>
                generalError(code) === undefined ? null : (
                  <div key={code} className="exit-error neg" role="alert">
                    {errorWords[code](0)}
                  </div>
                ),
              )}
            </>
          )}
          {form.tpMode !== 'none' && stopIgnored && ctx.stop !== null && <div className="exit-hint warn exit-stop-ignored">{t.exits.stopWrongSide(fmtPx(ctx.stop, ctx.inst), short)}</div>}
          {/* how the levels are proposed: said while the entry is known (without it the rows say the entry is what is missing) */}
          {form.tpMode !== 'none' && !stopIgnored && entryKnown && (!ctx.whole || !hasStop) && <div className="exit-hint dim">{t.exits.howProposed}</div>}
          {form.tpMode !== 'none' && entryNote !== null && <div className="exit-hint dim exit-entry-note">{entryNote}</div>}
          {form.tpMode !== 'none' && ctx.whole && <div className="exit-hint dim">{t.exits.wholeOrderHint}</div>}
        </div>
      )}
      {trailing && (
        <div className="exit-block">
          <div className="exit-head">
            <span className="exit-label">{t.exits.trailing}</span>
            <Segmented value={form.trailing} options={trailingModes} onChange={(mode) => set({ trailing: mode })} label={t.exits.trailing} />
          </div>
          {form.trailing === 'channel' && (
            <>
              <div className="exit-row">
                <label className="exit-field">
                  <span className="dim">{t.exits.channelBars}</span>
                  <input className="num" inputMode="numeric" value={form.channelBars} onChange={(e) => set({ channelBars: e.target.value })} />
                </label>
              </div>
              {generalError('CHANNEL_BARS') === undefined ? (
                <>
                  <div className="exit-hint exit-now">{channelLevel === null ? t.exits.channelLater(bars, short) : t.exits.channelNow(fmtPx(channelLevel, ctx.inst), bars, short)}</div>
                  {channelWrong && channelLevel !== null && <div className="exit-hint warn exit-channel-wrong">{t.exits.channelWrongSide(fmtPx(channelLevel, ctx.inst), short)}</div>}
                </>
              ) : (
                <div className="exit-error neg" role="alert">
                  {errorWords.CHANNEL_BARS(0)}
                </div>
              )}
            </>
          )}
          {form.trailing === 'callback' && (
            <>
              <div className="exit-row">
                <label className="exit-field">
                  <span className="dim">{t.exits.callbackPct}</span>
                  <input className="num" inputMode="decimal" value={form.callbackPct} onChange={(e) => set({ callbackPct: e.target.value })} />
                </label>
                <label className="exit-field">
                  <span className="dim">
                    {t.exits.activePx} ({t.exits.optional})
                  </span>
                  <input className="num" inputMode="decimal" value={form.activePx} onChange={(e) => set({ activePx: e.target.value })} />
                </label>
              </div>
              {generalError('CALLBACK_RATIO') !== undefined || generalError('ACTIVE_PX') !== undefined ? (
                <div className="exit-error neg" role="alert">
                  {generalError('CALLBACK_RATIO') !== undefined ? errorWords.CALLBACK_RATIO(0) : errorWords.ACTIVE_PX(0)}
                </div>
              ) : (
                <div className="exit-hint exit-now">
                  {t.exits.callbackNow(
                    form.callbackPct.trim() === '' ? '…' : `${form.callbackPct.trim()}%`,
                    callbackPx === null ? '' : fmtPx(callbackPx, ctx.inst),
                    activePx === '' ? '' : fmtPx(activePx, ctx.inst),
                    short,
                    callbackPending,
                  )}
                </div>
              )}
            </>
          )}
        </div>
      )}
    </div>
  );
}
