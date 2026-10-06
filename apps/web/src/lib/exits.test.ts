import { describe, expect, it } from 'vitest';
import type { AlgoOrder, Position } from '@pegasus/shared';
import { BTC } from '../test/campaign-fixtures';
import { trailingOn } from '../test/signals-fixtures';
import { buildExitFields, channelOf, defaultExitForm, ladderRest, priceAtR, rMultipleOf, takeProfitsOf, trailingStopsOf, type ExitContext, type ExitForm } from './exits';

const ctx: ExitContext = { direction: 'long', entry: '60000', stop: '57000', inst: BTC, whole: true };
const form = (p: Partial<ExitForm>): ExitForm => ({ ...defaultExitForm(), ...p });

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

  it('a ladder in R multiples: prices from the risk distance on the tick, the last leg takes the rest, the cost-price stop', () => {
    const ladder = form({
      tpMode: 'ladder',
      ladder: [
        { basis: 'r', value: '1.5', pct: '30' },
        { basis: 'price', value: '66000', pct: '30' },
        { basis: 'r', value: '3', pct: '' },
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
    // a short measures R upwards to its stop and rounds up, towards the entry
    expect(priceAtR('1', { direction: 'short', entry: '60000.05', stop: '61000', inst: BTC })).toBe('59000.1');
    expect(rMultipleOf('66000', ctx)?.toFixed()).toBe('2');
  });

  it('says what is missing or wrong', () => {
    const tp = (rows: ExitForm['ladder']) => buildExitFields(form({ tpMode: 'ladder', ladder: rows }), ctx);
    expect(tp([{ basis: 'price', value: '', pct: '50' }, { basis: 'price', value: '66000', pct: '' }])).toEqual({ ok: false, error: { code: 'TP_VALUE', leg: 1 } });
    expect(tp([{ basis: 'price', value: '65000', pct: '0' }, { basis: 'price', value: '66000', pct: '' }])).toEqual({ ok: false, error: { code: 'TP_PCT', leg: 1 } });
    expect(tp([{ basis: 'price', value: '65000', pct: '100' }, { basis: 'price', value: '66000', pct: '' }])).toEqual({ ok: false, error: { code: 'TP_REST' } });
    expect(buildExitFields(form({ tpMode: 'single', single: { basis: 'r', value: '2', pct: '100' } }), { ...ctx, stop: null })).toEqual({ ok: false, error: { code: 'TP_R_NEEDS_STOP', leg: 1 } });
    expect(buildExitFields(form({ tpMode: 'ladder', breakeven: true, ladder: [{ basis: 'price', value: '65000', pct: '50' }, { basis: 'price', value: '66000', pct: '' }] }), { ...ctx, stop: null })).toEqual({
      ok: false,
      error: { code: 'BREAKEVEN' },
    });
    expect(buildExitFields(form({ trailing: 'channel', channelBars: '1' }), ctx)).toEqual({ ok: false, error: { code: 'CHANNEL_BARS' } });
    expect(buildExitFields(form({ trailing: 'callback', callbackPct: '25' }), ctx)).toEqual({ ok: false, error: { code: 'CALLBACK_RATIO' } });
    expect(buildExitFields(form({ trailing: 'callback', callbackPct: '0.05' }), ctx)).toEqual({ ok: false, error: { code: 'CALLBACK_RATIO' } });
    expect(buildExitFields(form({ trailing: 'callback', callbackPct: '5', activePx: 'x' }), ctx)).toEqual({ ok: false, error: { code: 'ACTIVE_PX' } });
  });

  it('take-profits for an open position close their own shares, which may add up to less than all of it', () => {
    const position = { ...ctx, whole: false };
    expect(buildExitFields(form({ tpMode: 'single', single: { basis: 'price', value: '66000', pct: '40' } }), position)).toEqual({ ok: true, fields: { takeProfits: [{ triggerPx: '66000', fraction: '0.4' }] } });
    const over = form({ tpMode: 'ladder', ladder: [{ basis: 'price', value: '65000', pct: '60' }, { basis: 'price', value: '66000', pct: '50' }] });
    expect(buildExitFields(over, position)).toEqual({ ok: false, error: { code: 'TP_OVER_100' } });
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
