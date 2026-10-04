import { DEFAULT_SIZING, DEFAULT_TREND_PARAMS, SIGNAL_PHASE_HOURS } from '@pegasus/shared';
import { describe, expect, it } from 'vitest';
import { DEFAULT_CONFIG, parseCli, parseSweep, UsageError } from '../src/options.js';

describe('command line', () => {
  it('defaults to the documented framework', () => {
    const opts = parseCli([]);
    expect(opts.instIds).toEqual(['BTC-USDT-SWAP', 'ETH-USDT-SWAP']);
    expect(opts.config).toEqual(DEFAULT_CONFIG);
    expect(opts.config.phases).toEqual(SIGNAL_PHASE_HOURS);
    expect(opts.config.params).toEqual(DEFAULT_TREND_PARAMS);
    expect(opts.config.params.allowShort).toBe(false);
    expect(opts.config.sizing).toEqual(DEFAULT_SIZING);
    expect(opts.config).toMatchObject({ equity: '100000', exitMode: 'trail', trimPct: '0.30', oiMode: 'history', longVenue: 'perp', funding: true, maxInstruments: 3, maxGrossPct: '0.5', heatCap: null });
    expect(opts.config.costs).toEqual({ fee: '0.0005', slippage: '0.0005', stopFee: '0.0005', stopSlippage: '0.0015', spotFee: '0.001' });
    expect(opts).toMatchObject({ help: false, refresh: false, json: false, out: null, sweep: null, liveR: null });
  });

  it('reads every flag', () => {
    const opts = parseCli(
      (
        '--inst sol-usdt-swap --from 2021-01-01 --to 2024-06-30 --phases 12 --equity 50000 --risk-pct 0.005 --max-notional-pct 0.2 --exit close --allow-short ' +
        '--entry-channel 40 --exit-channel 10 --atr-mult 3 --oi calm --trim-pct 0 --long-venue spot --no-funding --fee 0.0002 --slippage 0.0001 --stop-fee 0.0003 ' +
        '--stop-slippage 0.002 --spot-fee 0.0008 --max-instruments 2 --max-gross-pct 1 --heat-cap 0.03 --refresh --out runs/a --json --live-r live.json'
      ).split(' '),
    );
    expect(opts.instIds).toEqual(['SOL-USDT-SWAP']);
    expect(opts.config).toMatchObject({
      phases: [12],
      equity: '50000',
      from: Date.UTC(2021, 0, 1),
      to: Date.UTC(2024, 5, 30),
      exitMode: 'close',
      oiMode: 'calm',
      trimPct: '0',
      longVenue: 'spot',
      funding: false,
      maxInstruments: 2,
      maxGrossPct: '1',
      heatCap: '0.03',
      sizing: { riskPct: '0.005', maxNotionalPct: '0.2', atrStopMultiple: '3' },
      costs: { fee: '0.0002', slippage: '0.0001', stopFee: '0.0003', stopSlippage: '0.002', spotFee: '0.0008' },
    });
    expect(opts.config.params).toMatchObject({ allowShort: true, entryChannel: 40, exitChannel: 10, atrStopMultiple: '3' });
    expect(opts).toMatchObject({ refresh: true, json: true, out: 'runs/a', liveR: 'live.json' });
  });

  it('takes the framework heat cap when --heat-cap stands alone', () => {
    expect(parseCli(['--heat-cap']).config.heatCap).toBe('0.025');
    expect(parseCli(['--heat-cap', '--json']).config.heatCap).toBe('0.025');
  });

  it('expands a sweep grid, keeping the configured value of what is not swept', () => {
    expect(parseCli(['--sweep', 'entry=40:80:10,exit=10:30:5,atr=2:4:0.5']).sweep).toEqual({
      entry: [40, 50, 60, 70, 80],
      exit: [10, 15, 20, 25, 30],
      atr: ['2', '2.5', '3', '3.5', '4'],
    });
    expect(parseSweep('entry=55', DEFAULT_CONFIG)).toEqual({ entry: [55], exit: [20], atr: ['2.5'] });
    expect(() => parseSweep('bars=1:2:1', DEFAULT_CONFIG)).toThrow(UsageError);
  });

  it('rejects what it does not understand', () => {
    expect(() => parseCli(['--exit', 'never'])).toThrow(UsageError);
    expect(() => parseCli(['--phases', '6'])).toThrow(UsageError);
    expect(() => parseCli(['--from', 'yesterday'])).toThrow(UsageError);
    expect(() => parseCli(['--risk-pct', '-1'])).toThrow(UsageError);
    expect(() => parseCli(['--unknown'])).toThrow(UsageError);
  });
});
