import { describe, expect, it } from 'vitest';
import type { AlgoOrder, Candle, Position } from '@pegasus/shared';
import { BTC } from '../test/campaign-fixtures';
import { ADA_TENTHS, trailingOn } from '../test/signals-fixtures';
import {
  activationPending,
  addLadderLeg,
  buildExitFields,
  callbackTriggerNow,
  channelLevelOf,
  channelOf,
  checkExitForm,
  convertRow,
  defaultExitForm,
  gainOf,
  ladderRest,
  legFigures,
  offTick,
  priceAtPct,
  priceAtR,
  proposeLeg,
  proposeLevels,
  proposeTakeProfits,
  proposedRows,
  proposedShares,
  rMultipleOf,
  rowPrice,
  stopAttachedOf,
  takeProfitsOf,
  trailingStopsOf,
  type ExitContext,
  type ExitForm,
} from './exits';

const ctx: ExitContext = { direction: 'long', entry: '60000', stop: '57000', inst: BTC, whole: true };
const form = (p: Partial<ExitForm>): ExitForm => ({ ...defaultExitForm(), ...p });

/** The owner's ADA entry: 0.2723 with the stop 0.2366, 182.7 contracts of 100 ADA */
const ada: ExitContext = { direction: 'long', entry: '0.2723', stop: '0.2366', inst: ADA_TENTHS, whole: true, contracts: '182.7' };

describe('the exit plan of an order', () => {
  it('none at all sends no exit field', () => {
    expect(buildExitFields(defaultExitForm(), ctx)).toEqual({ ok: true, fields: {} });
  });

  it('a single take-profit closes the whole order; channel trailing and the callback are sent as asked', () => {
    expect(buildExitFields(form({ tpMode: 'single', single: { basis: 'price', value: '66000', pct: '100' }, trailing: 'channel', channelBars: '10' }), ctx)).toEqual({
      ok: true,
      fields: { takeProfits: [{ triggerPx: '66000', fraction: '1' }], trailing: { kind: 'channel', bars: 10 } },
    });
    expect(buildExitFields(form({ trailing: 'callback', callbackPct: '2.5', activePx: '61000' }), ctx)).toEqual({
      ok: true,
      fields: { trailing: { kind: 'callback', ratio: '0.025', activePx: '61000' } },
    });
  });

  it('a ladder in R multiples and percentages: prices from the entry on the tick, the last leg takes the rest, the cost-price stop', () => {
    const ladder = form({
      tpMode: 'ladder',
      ladder: [
        { basis: 'r', value: '1.5', pct: '30' },
        { basis: 'price', value: '66000', pct: '30' },
        { basis: 'pct', value: '15', pct: '' },
      ],
      breakeven: true,
    });
    expect(buildExitFields(ladder, ctx)).toEqual({
      ok: true,
      fields: {
        takeProfits: [
          { triggerPx: '64500', fraction: '0.3' },
          { triggerPx: '66000', fraction: '0.3' },
          { triggerPx: '69000', fraction: '0.4' },
        ],
        breakevenAfterTp1: true,
      },
    });
    expect(ladderRest(ladder.ladder)?.toFixed()).toBe('0.4');
    // a short measures R upwards to its stop and rounds up, towards the entry; a percentage goes down from the entry
    expect(priceAtR('1', { direction: 'short', entry: '60000.05', stop: '61000', inst: BTC })).toBe('59000.1');
    expect(priceAtPct('10', { direction: 'short', entry: '60000.05', inst: BTC })).toBe('54000.1');
    expect(rMultipleOf('66000', ctx)?.toFixed()).toBe('2');
    expect(gainOf('66000', ctx)?.toFixed()).toBe('0.1');
    expect(gainOf('2700', { direction: 'short', entry: '3000' })?.toFixed()).toBe('0.1');
  });

  it('says what is missing or wrong, each row its own, and keeps the parts that are complete', () => {
    const tp = (rows: ExitForm['ladder']) => buildExitFields(form({ tpMode: 'ladder', ladder: rows }), ctx);
    expect(tp([{ basis: 'price', value: '', pct: '50' }, { basis: 'price', value: '66000', pct: '' }])).toEqual({ ok: false, error: { code: 'TP_VALUE', leg: 1 } });
    expect(tp([{ basis: 'price', value: '65000', pct: '0' }, { basis: 'price', value: '66000', pct: '' }])).toEqual({ ok: false, error: { code: 'TP_PCT', leg: 1 } });
    expect(tp([{ basis: 'price', value: '65000', pct: '100' }, { basis: 'price', value: '66000', pct: '' }])).toEqual({ ok: false, error: { code: 'TP_REST' } });
    // a level that is not on the profit side
    expect(tp([{ basis: 'price', value: '59000', pct: '50' }, { basis: 'price', value: '66000', pct: '' }])).toEqual({ ok: false, error: { code: 'TP_WRONG_SIDE', leg: 1 } });
    expect(buildExitFields(form({ tpMode: 'single', single: { basis: 'price', value: '3100', pct: '100' } }), { ...ctx, direction: 'short', entry: '3000', stop: '3200' })).toEqual({ ok: false, error: { code: 'TP_WRONG_SIDE', leg: 1 } });
    expect(buildExitFields(form({ tpMode: 'single', single: { basis: 'r', value: '2', pct: '100' } }), { ...ctx, stop: null })).toEqual({ ok: false, error: { code: 'TP_R_NEEDS_STOP', leg: 1 } });
    // a percentage or an R multiple without an entry to measure it from (a limit order without its price) is not blamed on the value
    expect(buildExitFields(form({ tpMode: 'single', single: { basis: 'pct', value: '10', pct: '100' } }), { ...ctx, entry: null })).toEqual({ ok: false, error: { code: 'TP_NEEDS_ENTRY', leg: 1 } });
    // a leg not beyond the leg before it: the legs fill in their order, so a ladder out of order is said
    expect(tp([{ basis: 'r', value: '1.5', pct: '50' }, { basis: 'r', value: '1', pct: '' }])).toEqual({ ok: false, error: { code: 'TP_ORDER', leg: 2 } });
    expect(tp([{ basis: 'price', value: '66000', pct: '50' }, { basis: 'price', value: '66000', pct: '' }])).toEqual({ ok: false, error: { code: 'TP_ORDER', leg: 2 } });
    expect(buildExitFields(form({ tpMode: 'ladder', ladder: [{ basis: 'price', value: '2800', pct: '50' }, { basis: 'price', value: '2900', pct: '' }] }), { ...ctx, direction: 'short', entry: '3000', stop: '3100' })).toEqual({
      ok: false,
      error: { code: 'TP_ORDER', leg: 2 },
    });
    expect(buildExitFields(form({ tpMode: 'ladder', breakeven: true, ladder: [{ basis: 'price', value: '65000', pct: '50' }, { basis: 'price', value: '66000', pct: '' }] }), { ...ctx, stop: null })).toEqual({
      ok: false,
      error: { code: 'BREAKEVEN' },
    });
    // the stop channel trailing puts after the fill measures the R multiples, but the cost-price stop needs one attached to the order
    const channelStop: ExitContext = { ...ctx, stopAttached: false };
    expect(buildExitFields(form({ tpMode: 'single', single: { basis: 'r', value: '2', pct: '100' } }), channelStop)).toEqual({ ok: true, fields: { takeProfits: [{ triggerPx: '66000', fraction: '1' }] } });
    expect(buildExitFields(form({ tpMode: 'ladder', breakeven: true, ladder: [{ basis: 'r', value: '1', pct: '50' }, { basis: 'r', value: '2', pct: '' }] }), channelStop)).toEqual({ ok: false, error: { code: 'BREAKEVEN' } });
    expect(stopAttachedOf(ctx)).toBe(true);
    expect(stopAttachedOf(channelStop)).toBe(false);
    expect(stopAttachedOf({ ...ctx, stop: '61000' })).toBe(false);
    // a typed price off the tick stands for the price the API rounds it to: towards the entry
    expect(rowPrice({ basis: 'price', value: '66000.07', pct: '' }, ctx)).toBe('66000');
    expect(rowPrice({ basis: 'price', value: '2800.001', pct: '' }, { ...ctx, direction: 'short', entry: '3000', stop: '3100' })).toBe('2800.1');
    expect(offTick({ basis: 'price', value: '66000.07', pct: '' }, ctx)).toBe(true);
    expect(offTick({ basis: 'price', value: '66000.0', pct: '' }, ctx)).toBe(false);
    expect(offTick({ basis: 'r', value: '2', pct: '' }, ctx)).toBe(false);
    expect(buildExitFields(form({ tpMode: 'single', single: { basis: 'price', value: '66000.07', pct: '100' } }), ctx)).toEqual({ ok: true, fields: { takeProfits: [{ triggerPx: '66000', fraction: '1' }] } });
    expect(buildExitFields(form({ trailing: 'channel', channelBars: '1' }), ctx)).toEqual({ ok: false, error: { code: 'CHANNEL_BARS' } });
    expect(buildExitFields(form({ trailing: 'callback', callbackPct: '25' }), ctx)).toEqual({ ok: false, error: { code: 'CALLBACK_RATIO' } });
    expect(buildExitFields(form({ trailing: 'callback', callbackPct: '0.05' }), ctx)).toEqual({ ok: false, error: { code: 'CALLBACK_RATIO' } });
    expect(buildExitFields(form({ trailing: 'callback', callbackPct: '5', activePx: 'x' }), ctx)).toEqual({ ok: false, error: { code: 'ACTIVE_PX' } });
    // every error at once, and the trailing stop kept while a leg is still being written
    const partial = checkExitForm(form({ tpMode: 'ladder', ladder: [{ basis: 'price', value: '', pct: '' }, { basis: 'r', value: '3', pct: '' }], trailing: 'channel', channelBars: '10' }), ctx);
    expect(partial).toEqual({ fields: { trailing: { kind: 'channel', bars: 10 } }, errors: [{ code: 'TP_VALUE', leg: 1 }, { code: 'TP_PCT', leg: 1 }] });
    const broken = checkExitForm(form({ tpMode: 'single', single: { basis: 'r', value: '2', pct: '100' }, trailing: 'channel', channelBars: '0' }), ctx);
    expect(broken).toEqual({ fields: { takeProfits: [{ triggerPx: '66000', fraction: '1' }] }, errors: [{ code: 'CHANNEL_BARS' }] });
  });

  it('take-profits for an open position close their own shares, which may add up to less than all of it', () => {
    const position = { ...ctx, whole: false };
    expect(buildExitFields(form({ tpMode: 'single', single: { basis: 'price', value: '66000', pct: '40' } }), position)).toEqual({ ok: true, fields: { takeProfits: [{ triggerPx: '66000', fraction: '0.4' }] } });
    const over = form({ tpMode: 'ladder', ladder: [{ basis: 'price', value: '65000', pct: '60' }, { basis: 'price', value: '66000', pct: '50' }] });
    expect(buildExitFields(over, position)).toEqual({ ok: false, error: { code: 'TP_OVER_100' } });
  });
});

describe("the program's take-profit levels", () => {
  it('proposes 2R alone and 1.5R / 3R for a ladder with a stop, percentages from the entry without one', () => {
    expect(proposedRows('single', 1, true)).toEqual([{ basis: 'r', value: '2', pct: '100' }]);
    expect(proposedRows('single', 1, false)).toEqual([{ basis: 'pct', value: '10', pct: '100' }]);
    expect(proposedRows('ladder', 2, true)).toEqual([
      { basis: 'r', value: '1.5', pct: '50' },
      { basis: 'r', value: '3', pct: '' },
    ]);
    expect(proposedRows('ladder', 2, false)).toEqual([
      { basis: 'pct', value: '5', pct: '50' },
      { basis: 'pct', value: '10', pct: '' },
    ]);
    // more legs are spread evenly between the two ends, the shares split evenly in whole percents
    expect(proposedRows('ladder', 3, true).map((r) => r.value)).toEqual(['1.5', '2.25', '3']);
    expect(proposedRows('ladder', 5, false).map((r) => r.value)).toEqual(['5', '6.25', '7.5', '8.75', '10']);
    expect(proposedShares(3, true)).toEqual(['33', '33', '']);
    expect(proposedShares(3, false)).toEqual(['33', '33', '34']);
    // the ADA entry: 2R is 0.3437, the ladder 0.3258 and 0.3794, on the tick
    const single = proposeTakeProfits(form({ tpMode: 'single' }), ada);
    expect(single.single).toEqual({ basis: 'r', value: '2', pct: '100' });
    expect(rowPrice(single.single, ada)).toBe('0.3437');
    const ladder = proposeTakeProfits(form({ tpMode: 'ladder' }), ada);
    expect(ladder.ladder.map((r) => rowPrice(r, ada))).toEqual(['0.3258', '0.3794']);
    expect(ladder.breakeven).toBe(true);
    // the same levels from the stop channel trailing puts after the fill, without the cost-price stop (the exchange moves an attached stop only)
    const channel = proposeTakeProfits(form({ tpMode: 'ladder' }), { ...ada, stopAttached: false });
    expect(channel.ladder).toEqual(ladder.ladder);
    expect(channel.breakeven).toBe(false);
    // a short: mirrored below the entry, on the tick up
    const short = proposeTakeProfits(form({ tpMode: 'single' }), { direction: 'short', entry: '0.2723', stop: '0.3080', whole: true });
    expect(rowPrice(short.single, { direction: 'short', entry: '0.2723', stop: '0.3080', inst: ADA_TENTHS })).toBe('0.2009');
    // nothing to propose while no mode is chosen
    const none = defaultExitForm();
    expect(proposeTakeProfits(none, ada)).toBe(none);
  });

  it("writes only into rows left to the program, follows the stop as it comes and goes, and comes back the same when nothing changes", () => {
    const proposed = proposeTakeProfits(form({ tpMode: 'ladder' }), ada);
    expect(proposeTakeProfits(proposed, ada)).toBe(proposed);
    // the stop taken away: the R levels become percentages, the cost-price stop goes; back again with the stop
    const noStop = proposeTakeProfits(proposed, { ...ada, stop: null });
    expect(noStop.ladder).toEqual([
      { basis: 'pct', value: '5', pct: '50' },
      { basis: 'pct', value: '10', pct: '' },
    ]);
    expect(noStop.breakeven).toBe(false);
    expect(proposeTakeProfits(noStop, ada).ladder).toEqual(proposed.ladder);
    // a level the trader wrote stays, whatever the stop does; the other row still follows
    const mine: ExitForm = { ...proposed, ladder: [{ basis: 'price', value: '0.3', pct: '50' }, proposed.ladder[1] as ExitForm['ladder'][number]] };
    expect(proposeTakeProfits(mine, ada)).toBe(mine);
    expect(proposeTakeProfits(mine, { ...ada, stop: null }).ladder).toEqual([
      { basis: 'price', value: '0.3', pct: '50' },
      { basis: 'pct', value: '10', pct: '' },
    ]);
    // shares the trader wrote stay too
    const shares: ExitForm = { ...proposed, ladder: [{ ...(proposed.ladder[0] as ExitForm['ladder'][number]), pct: '70' }, proposed.ladder[1] as ExitForm['ladder'][number]] };
    expect(proposeTakeProfits(shares, { ...ada, stop: null }).ladder.map((r) => r.pct)).toEqual(['70', '']);
    // the cost-price stop unticked stays unticked
    const unticked = { ...proposed, breakeven: false };
    expect(proposeTakeProfits(unticked, ada)).toBe(unticked);
    // the stop gone after a level was edited: the program's tick goes with it (it can never be honoured without a stop), so no dead end
    const edited: ExitForm = { ...proposed, ladder: [{ basis: 'price', value: '0.29', pct: '50' }, proposed.ladder[1] as ExitForm['ladder'][number]] };
    const stopGone = proposeLevels(edited, false, true);
    expect(stopGone.breakeven).toBe(false);
    expect(checkExitForm(stopGone, { ...ada, stop: null }).errors).toEqual([]);
    // one row brought back to the program's level, whatever it held
    expect(proposeLeg(mine, 0, ada).ladder[0]).toEqual({ basis: 'r', value: '1.5', pct: '50' });
    expect(proposeLeg(form({ tpMode: 'single', single: { basis: 'price', value: '0.29', pct: '100' } }), 0, ada).single).toEqual({ basis: 'r', value: '2', pct: '100' });
  });

  it('converts a value between its bases from the price it stands for, with the decimals that keep that price', () => {
    const r2 = { basis: 'r' as const, value: '2', pct: '100' };
    const price = convertRow(r2, 'price', ada);
    expect(price).toEqual({ basis: 'price', value: '0.3437', pct: '100' });
    // 26.22% would come back as 0.3436 on the tick: the percentage carries the decimals that give 0.3437 again
    const pct = convertRow(price, 'pct', ada);
    expect(pct).toEqual({ basis: 'pct', value: '26.2211', pct: '100' });
    expect(convertRow(pct, 'price', ada).value).toBe('0.3437');
    expect(convertRow(pct, 'r', ada).value).toBe('2');
    expect(convertRow(r2, 'r', ada)).toBe(r2);
    // every pass through a basis keeps the level: 3R on ADA, 2R on BTC (26 ticks lower at two decimals)
    const r3 = convertRow({ basis: 'r', value: '3', pct: '' }, 'price', ada);
    expect(r3.value).toBe('0.3794');
    expect(convertRow(convertRow(r3, 'pct', ada), 'price', ada).value).toBe('0.3794');
    const btc = { direction: 'long' as const, entry: '65432.1', stop: '63000', inst: BTC };
    const btc2r = convertRow({ basis: 'r', value: '2', pct: '' }, 'price', btc);
    expect(btc2r.value).toBe('70296.3');
    expect(convertRow(convertRow(btc2r, 'pct', btc), 'price', btc).value).toBe('70296.3');
    expect(convertRow(convertRow(btc2r, 'pct', btc), 'r', btc).value).toBe('2');
    // without a stop an R value has no price: the basis changes and the value is cleared ('2' R is not a price of 2)
    expect(convertRow(r2, 'pct', { ...ada, stop: null })).toEqual({ basis: 'pct', value: '', pct: '100' });
    expect(convertRow(r2, 'price', { ...ada, stop: null })).toEqual({ basis: 'price', value: '', pct: '100' });
    // a short converts below the entry
    const short = { direction: 'short' as const, entry: '3000', stop: '3100', inst: BTC };
    expect(convertRow({ basis: 'pct', value: '10', pct: '' }, 'r', short).value).toBe('3');
  });

  it('adds a leg: the program spreads its own ladder again; a ladder of the trader gets the level halfway between its neighbours', () => {
    const proposed = proposeTakeProfits(form({ tpMode: 'ladder' }), ada);
    const three = addLadderLeg(proposed, ada);
    expect(three.ladder).toEqual([
      { basis: 'r', value: '1.5', pct: '33' },
      { basis: 'r', value: '2.25', pct: '33' },
      { basis: 'r', value: '3', pct: '' },
    ]);
    // the trader's prices: the new leg between them, the shares split evenly again as they were the program's
    const mine = form({ tpMode: 'ladder', ladder: [{ basis: 'price', value: '0.3', pct: '50' }, { basis: 'price', value: '0.35', pct: '' }] });
    expect(addLadderLeg(mine, ada).ladder).toEqual([
      { basis: 'price', value: '0.3', pct: '33' },
      { basis: 'price', value: '0.325', pct: '33' },
      { basis: 'price', value: '0.35', pct: '' },
    ]);
    // shares of the trader's own are kept; the new leg's is left for them
    const shares = form({ tpMode: 'ladder', ladder: [{ basis: 'r', value: '1', pct: '70' }, { basis: 'r', value: '3', pct: '' }] });
    expect(addLadderLeg(shares, ada).ladder).toEqual([
      { basis: 'r', value: '1', pct: '70' },
      { basis: 'r', value: '2', pct: '' },
      { basis: 'r', value: '3', pct: '' },
    ]);
    // never more than the API's five legs
    let five = proposed;
    for (let i = 0; i < 6; i++) five = addLadderLeg(five, ada);
    expect(five.ladder).toHaveLength(5);
  });

  it('says what each leg comes to: price, gain, R, contracts in whole lots (the last takes the rest) and profit', () => {
    const ladder = proposeTakeProfits(form({ tpMode: 'ladder' }), ada);
    const figs = legFigures(ladder, ada);
    expect(figs.map((f) => [f.px, f.gain?.toFixed(4), f.r?.toFixed(2), f.sz?.toFixed(), f.profit?.toFixed()])).toEqual([
      ['0.3258', '0.1965', '1.50', '91.3', '488.455'],
      ['0.3794', '0.3933', '3.00', '91.4', '978.894'],
    ]);
    // a single leg takes the whole order; a short's profit is measured down from the entry
    const single = proposeTakeProfits(form({ tpMode: 'single' }), ada);
    expect(legFigures(single, ada)[0]).toMatchObject({ px: '0.3437', sz: expect.anything(), profit: expect.anything() });
    expect(legFigures(single, ada)[0]?.profit?.toFixed()).toBe('1304.478');
    const short: ExitContext = { direction: 'short', entry: '3000', stop: '3100', inst: BTC, whole: true, contracts: '4' };
    expect(legFigures(proposeTakeProfits(form({ tpMode: 'single' }), short), short)[0]).toMatchObject({ px: '2800' });
    expect(legFigures(proposeTakeProfits(form({ tpMode: 'single' }), short), short)[0]?.profit?.toFixed()).toBe('8');
    // without the size there are no contracts and no profit; without a price nothing but the share
    expect(legFigures(single, { ...ada, contracts: null })[0]).toMatchObject({ px: '0.3437', sz: null, profit: null });
    expect(legFigures(form({ tpMode: 'single', single: { basis: 'price', value: '', pct: '100' } }), ada)[0]).toMatchObject({ px: null, sz: expect.anything() });
    // the legs of a position are sized as the API sizes them: the last takes what the others leave of the shares' sum
    const position: ExitContext = { ...ada, whole: false, contracts: '0.5' };
    const thirds = form({ tpMode: 'ladder', ladder: [{ basis: 'r', value: '1', pct: '33' }, { basis: 'r', value: '2', pct: '33' }, { basis: 'r', value: '3', pct: '34' }] });
    expect(legFigures(thirds, position).map((f) => f.sz?.toFixed())).toEqual(['0.1', '0.1', '0.3']);
  });

  it("for a position with take-profits resting, lifts the levels beyond the farthest of them by whole steps and shares out what they leave", () => {
    // ETH long 20 at 3,020.5 over the stop 2,905.4 (R = 115.1), legs resting at 3,400 and 3,550 for 10 each: 2R (3,250.7) sits under
    // both, so the first whole R step past 3,550 is proposed, 5R = 3,596; the legs cover the whole position, so no share is proposed
    const covered: ExitContext = { direction: 'long', entry: '3020.5', stop: '2905.4', inst: null, whole: false, contracts: '20', beyond: '3550', uncovered: '0' };
    expect(proposedRows('single', 1, true, false, covered)).toEqual([{ basis: 'r', value: '5', pct: '' }]);
    expect(proposeTakeProfits(form({ tpMode: 'single' }), covered).single).toEqual({ basis: 'r', value: '5', pct: '' });
    // half the position free: 2R lifted the same, half shared out; a ladder keeps its spread (1.5R and 3R lifted by the same
    // four steps, since 4.5R = 3,538.45 is still under 3,550: 5.5R and 7R) and splits the half evenly
    const half: ExitContext = { ...covered, uncovered: '0.5' };
    expect(proposedRows('single', 1, true, false, half)).toEqual([{ basis: 'r', value: '5', pct: '50' }]);
    expect(proposedRows('ladder', 2, true, false, half)).toEqual([
      { basis: 'r', value: '5.5', pct: '25' },
      { basis: 'r', value: '7', pct: '25' },
    ]);
    // without a stop the steps are 5%: 10% (3,322.55) under 3,550, 15% too, 20% = 3,624.6 beyond it
    expect(proposedRows('single', 1, false, false, { ...half, stop: null })).toEqual([{ basis: 'pct', value: '20', pct: '50' }]);
    // a short is lifted downwards; nothing to lift beyond: the plain proposal; the whole position free: the usual shares
    expect(proposedRows('single', 1, true, false, { direction: 'short', entry: '3000', stop: '3100', inst: null, beyond: '2700', uncovered: '1' })).toEqual([{ basis: 'r', value: '4', pct: '100' }]);
    expect(proposedRows('single', 1, true, false, { ...half, beyond: null, uncovered: null })).toEqual([{ basis: 'r', value: '2', pct: '100' }]);
    // Suggest and "+ leg" know the resting legs too
    expect(proposeLeg(form({ tpMode: 'single', single: { basis: 'price', value: '3300', pct: '50' } }), 0, half).single).toEqual({ basis: 'r', value: '5', pct: '50' });
    expect(addLadderLeg(form({ tpMode: 'ladder', ladder: proposedRows('ladder', 2, true, false, half) }), { ...half, inst: null }).ladder.map((r) => r.value)).toEqual(['5.5', '6.25', '7']);
  });

  it('flags a leg the contracts size below the minimum order, as the server refuses it', () => {
    // 0.01% of 182.7 contracts is 0.018, which rounds down to no lot at all
    const tiny = form({ tpMode: 'ladder', ladder: [{ basis: 'r', value: '1.5', pct: '0.01' }, { basis: 'r', value: '3', pct: '' }] });
    expect(checkExitForm(tiny, ada).errors).toEqual([{ code: 'TP_LEG_TOO_SMALL', leg: 1 }]);
    expect(checkExitForm(tiny, ada).fields).toEqual({});
    // without the contracts nothing can be said of the legs' size
    expect(checkExitForm(tiny, { ...ada, contracts: null }).errors).toEqual([]);
    // a position's leg too: 1% of 4 contracts of a lot of 1
    const position: ExitContext = { direction: 'long', entry: '60000', stop: '57000', inst: BTC, whole: false, contracts: '4' };
    expect(checkExitForm(form({ tpMode: 'single', single: { basis: 'r', value: '2', pct: '1' } }), position).errors).toEqual([{ code: 'TP_LEG_TOO_SMALL', leg: 1 }]);
  });

  it('knows where the trailing stop stands now: the channel level from the daily bars, the callback from the price', () => {
    const bar = (ts: number, low: string, high: string, confirm = true): Candle => ({ ts, open: '1', high, low, close: '1', vol: '1', volCcy: '1', confirm });
    const candles = [bar(1, '0.25', '0.3'), bar(2, '0.24', '0.31'), bar(3, '0.26', '0.29'), bar(4, '0.2', '0.4', false)];
    expect(channelLevelOf(candles, 2, 'long')).toBe('0.24');
    expect(channelLevelOf(candles, 3, 'long')).toBe('0.24');
    expect(channelLevelOf(candles, 2, 'short')).toBe('0.31');
    expect(channelLevelOf(candles, 4, 'long')).toBeNull();
    expect(channelLevelOf(undefined, 2, 'long')).toBeNull();
    expect(callbackTriggerNow('5', '0.2723', ada)).toBe('0.2586');
    expect(callbackTriggerNow('5', '3000', { direction: 'short', inst: BTC })).toBe('3150');
    expect(callbackTriggerNow('5', null, ada)).toBeNull();
    // with an activation price the price has not reached, the earliest trigger is measured from the activation, not from the price
    expect(activationPending('0.2723', '0.28', 'long')).toBe(true);
    expect(activationPending('0.29', '0.28', 'long')).toBe(false);
    expect(activationPending('3000', '2900', 'short')).toBe(true);
    expect(callbackTriggerNow('3', '0.2723', ada, '0.28')).toBe('0.2716');
    expect(callbackTriggerNow('3', '0.29', ada, '0.28')).toBe('0.2813');
    expect(callbackTriggerNow('5', '3000', { direction: 'short', inst: BTC }, '2900')).toBe('3045');
  });
});

describe('the exits resting for a position', () => {
  const position: Position = { instId: 'BTC-USDT-SWAP', posSide: 'net', mgnMode: 'isolated', pos: '4', avgPx: '60000', markPx: '61000', upl: '40', uplRatio: '0.01', lever: '10', liqPx: '54000', margin: '240', notionalUsd: '2440', cTime: 1, uTime: 1 };
  const algo = (o: Partial<AlgoOrder>): AlgoOrder => ({ algoId: 'a', algoClOrdId: '', instId: 'BTC-USDT-SWAP', side: 'sell', posSide: 'net', tdMode: 'isolated', sz: '2', closeFraction: '', slTriggerPx: '', slTriggerPxType: '', slOrdPx: '-1', tpTriggerPx: '', cTime: 1, uTime: 1, ...o });

  it('tells take-profits (lowest first), the exchange trailing stop and channel trailing apart from the stops', () => {
    const orders = [
      algo({ algoId: 's', slTriggerPx: '57000', slTriggerPxType: 'mark' }),
      algo({ algoId: 't2', tpTriggerPx: '68000' }),
      algo({ algoId: 't1', tpTriggerPx: '66000' }),
      algo({ algoId: 'm', ordType: 'move_order_stop', callbackRatio: '0.05' }),
      algo({ algoId: 'x', tpTriggerPx: '66000', side: 'buy' }),
    ];
    expect(takeProfitsOf(position, orders).map((a) => a.algoId)).toEqual(['t1', 't2']);
    expect(trailingStopsOf(position, orders).map((a) => a.algoId)).toEqual(['m']);
    expect(channelOf(position, trailingOn.entries)).toBeNull();
    expect(channelOf({ ...position, instId: 'XRP-USDT-SWAP' }, trailingOn.entries)?.level).toBe('0.5712');
  });
});
