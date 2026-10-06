import { useId } from 'react';
import { useT } from '../../i18n';
import {
  MAX_TP_LEGS,
  breakevenAllowed,
  ladderRest,
  rMultipleOf,
  rowPrice,
  type ExitContext,
  type ExitForm,
  type ExitFormError,
  type TpBasis,
  type TpMode,
  type TpRow,
  type TrailingMode,
} from '../../lib/exits';
import { fmtNum, fmtPct, fmtPx } from '../../lib/format';

interface Props {
  form: ExitForm;
  /** Applies a change to the form as it is then (two quick edits must not undo each other) */
  update: (change: (form: ExitForm) => ExitForm) => void;
  ctx: ExitContext;
  error: ExitFormError | null;
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
 * The exit plan of an order or of a position: take-profits (none, single or a ladder of up to five legs given as a
 * price or an R multiple and a share of the size; on an opening order the last leg takes the rest) with the cost-price
 * stop, and a trailing stop (channel or callback).
 */
export function ExitPlanEditor({ form, update, ctx, error, takeProfit = true, trailing = true, channel = true, breakeven = true, noneOption = true }: Props) {
  const t = useT();
  const id = useId();
  const set = (p: Partial<ExitForm>) => update((f) => ({ ...f, ...p }));
  const setRow = (i: number, p: Partial<TpRow>) => update((f) => ({ ...f, ladder: f.ladder.map((r, n) => (n === i ? { ...r, ...p } : r)) }));
  const rest = ladderRest(form.ladder);
  const canBreakeven = breakeven && breakevenAllowed(form, ctx.stop !== null);

  /** What a row stands for besides what was typed: the price of an R multiple, the R of a price. */
  const echo = (row: TpRow): string => {
    const px = rowPrice(row, ctx);
    if (px === null) return '';
    if (row.basis === 'r') return t.exits.atPrice(fmtPx(px, ctx.inst));
    const r = rMultipleOf(px, ctx);
    return r === null ? '' : t.exits.asR(fmtNum(r, 2));
  };

  const basisSelect = (row: TpRow, onBasis: (b: TpBasis) => void, aria: string) => (
    <select className="exit-basis" value={row.basis} onChange={(e) => onBasis(e.target.value as TpBasis)} title={t.exits.basisTitle} aria-label={aria}>
      <option value="price">{t.exits.basis.price}</option>
      <option value="r">{t.exits.basis.r}</option>
    </select>
  );

  const tpModes: ReadonlyArray<{ id: TpMode; label: string }> = (['none', 'single', 'ladder'] as const)
    .filter((m) => noneOption || m !== 'none')
    .map((m) => ({ id: m, label: t.exits.tpMode[m] }));
  const trailingModes: ReadonlyArray<{ id: TrailingMode; label: string }> = (['none', 'channel', 'callback'] as const)
    .filter((m) => (noneOption || m !== 'none') && (channel || m !== 'channel'))
    .map((m) => ({ id: m, label: t.exits.trailingMode[m] }));
  // A field not filled in yet is not an error to show: the form is only incomplete.
  const rows = form.tpMode === 'single' ? [form.single] : form.ladder;
  const shown =
    error !== null && (error.code === 'TP_VALUE' || error.code === 'TP_R_NEEDS_STOP' || error.code === 'TP_PCT') && (() => {
      const row = rows[error.leg - 1];
      return row === undefined || (error.code === 'TP_PCT' ? row.pct.trim() === '' : row.value.trim() === '');
    })()
      ? null
      : error;

  return (
    <div className="exit-editor">
      {takeProfit && (
        <div className="exit-block">
          <div className="exit-head">
            <span className="exit-label">{t.exits.tp}</span>
            <Segmented value={form.tpMode} options={tpModes} onChange={(tpMode) => set({ tpMode })} label={t.exits.tp} />
          </div>
          {form.tpMode === 'single' && (
            <div className="exit-row">
              {basisSelect(form.single, (basis) => set({ single: { ...form.single, basis } }), `${t.exits.tp} 1`)}
              <input className="num" inputMode="decimal" aria-label={`${t.exits.tp} 1 ${t.exits.value}`} value={form.single.value} onChange={(e) => set({ single: { ...form.single, value: e.target.value } })} />
              {!ctx.whole && (
                <span className="exit-pct">
                  <input className="num" inputMode="decimal" aria-label={`${t.exits.tp} 1 ${t.exits.pctOfPosition}`} value={form.single.pct} onChange={(e) => set({ single: { ...form.single, pct: e.target.value } })} />
                  <span className="dim">{t.exits.pctOfPosition}</span>
                </span>
              )}
              <span className="exit-echo num">{echo(form.single)}</span>
            </div>
          )}
          {form.tpMode === 'ladder' && (
            <>
              {form.ladder.map((row, i) => {
                const last = i === form.ladder.length - 1;
                const restRow = ctx.whole && last;
                return (
                  <div className="exit-row" key={i}>
                    <span className="exit-leg">{t.follow.tpLeg(i + 1)}</span>
                    {basisSelect(row, (basis) => setRow(i, { basis }), `${t.exits.tp} ${i + 1}`)}
                    <input className="num" inputMode="decimal" aria-label={`${t.exits.tp} ${i + 1} ${t.exits.value}`} value={row.value} onChange={(e) => setRow(i, { value: e.target.value })} />
                    <span className="exit-pct">
                      {restRow ? (
                        <span className="exit-rest num" title={t.exits.wholeOrderHint}>
                          {rest === null ? t.exits.rest : `${t.exits.rest} ${fmtPct(rest, 0)}`}
                        </span>
                      ) : (
                        <>
                          <input className="num" inputMode="decimal" aria-label={`${t.exits.tp} ${i + 1} ${ctx.whole ? t.exits.pctOfSize : t.exits.pctOfPosition}`} value={row.pct} onChange={(e) => setRow(i, { pct: e.target.value })} />
                          <span className="dim">%</span>
                        </>
                      )}
                    </span>
                    <span className="exit-echo num">{echo(row)}</span>
                    {form.ladder.length > 2 && (
                      <button type="button" className="btn btn-sm btn-ghost" title={t.exits.removeLeg} aria-label={t.exits.removeLeg} onClick={() => update((f) => ({ ...f, ladder: f.ladder.filter((_, n) => n !== i) }))}>
                        ×
                      </button>
                    )}
                  </div>
                );
              })}
              {form.ladder.length < MAX_TP_LEGS && (
                <button type="button" className="btn btn-sm exit-add" onClick={() => update((f) => ({ ...f, ladder: [...f.ladder.slice(0, -1), { basis: 'price', value: '', pct: '' }, ...f.ladder.slice(-1)] }))}>
                  {t.exits.addLeg}
                </button>
              )}
              {breakeven && (
                <label className={`check exit-breakeven${canBreakeven ? '' : ' disabled'}`} htmlFor={`${id}-be`}>
                  <input id={`${id}-be`} type="checkbox" checked={form.breakeven && canBreakeven} disabled={!canBreakeven} onChange={(e) => set({ breakeven: e.target.checked })} />
                  {t.exits.breakeven}
                  {!canBreakeven && <span className="dim"> ({t.exits.breakevenNeeds})</span>}
                </label>
              )}
            </>
          )}
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
              <div className="exit-hint dim">{t.exits.channelHint(form.channelBars.trim() === '' ? '…' : form.channelBars.trim())}</div>
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
              <div className="exit-hint dim">{t.exits.callbackHint}</div>
            </>
          )}
        </div>
      )}
      {shown !== null && (
        <div className="exit-error neg" role="alert">
          {t.exits.error[shown.code]('leg' in shown ? shown.leg : 0)}
        </div>
      )}
    </div>
  );
}
