import { CAMPAIGN_INSTRUMENTS, CAMPAIGN_MAINTENANCE, DEFAULT_CAMPAIGN_PARAMS, DEFAULT_POT_PARAMS } from '@pegasus/shared';
import { describe, expect, it } from 'vitest';
import { CAMPAIGN_HELP, DEFAULT_CAMPAIGN_CONFIG, DEFAULT_CAMPAIGN_COSTS, parseCampaignCli, REFERENCE_CAMPAIGN_COSTS } from '../src/campaign/options.js';
import { UsageError } from '../src/options.js';

describe('campaign command line', () => {
  it('defaults to the approved rule on the pot', () => {
    const opts = parseCampaignCli([]);
    expect(opts.config).toEqual(DEFAULT_CAMPAIGN_CONFIG);
    expect(opts.config).toMatchObject({ mode: 'pot', from: null, to: null, funding: true, exchangeCap: true });
    expect(opts.config.params).toEqual(DEFAULT_CAMPAIGN_PARAMS);
    expect(opts.config.pot).toEqual(DEFAULT_POT_PARAMS);
    // Fills as the evidence assumed them; liquidation at the exchange's first maintenance tier plus the fee.
    expect(opts.config.costs).toEqual({
      slippage: { major: '0.0005', other: '0.001' },
      exitSlippage: { major: '0.0015', other: '0.0025' },
      maintenance: { rates: CAMPAIGN_MAINTENANCE.rates, other: '0.01', plusFee: true },
    });
    expect(opts.config.costs.maintenance.rates).toMatchObject({ BTC: '0.004', LTC: '0.0065', DOT: '0.01' });
    expect(opts).toMatchObject({ help: false, instIds: null, exchangeLimits: false, offline: false, refresh: false, json: false, out: null, cache: null, check: null });
    expect(CAMPAIGN_INSTRUMENTS).toHaveLength(10);
    expect(CAMPAIGN_INSTRUMENTS.slice(0, 2)).toEqual(['BTC-USDT-SWAP', 'ETH-USDT-SWAP']);
  });

  it('reads every flag', () => {
    const opts = parseCampaignCli(
      (
        '--inst sol-usdt-swap,btc-usdt-swap --from 2021-01-01 --to 2024-06-30 --structure noadd --pot 100 --min-stake 10 --catalogue --entry-channel 55 ' +
        '--exit-channel 20 --leverage 5 --add-step 0.1 --no-funding --offline --cache data/frozen --out runs/a --json'
      ).split(' '),
    );
    expect(opts.instIds).toEqual(['SOL-USDT-SWAP', 'BTC-USDT-SWAP']);
    expect(opts.config).toMatchObject({ mode: 'catalogue', from: Date.UTC(2021, 0, 1), to: Date.UTC(2024, 5, 30), funding: false });
    // The catalogue is the reference run: its liquidation, no exchange cap on adds.
    expect(opts.config.exchangeCap).toBe(false);
    expect(opts.config.costs).toEqual(REFERENCE_CAMPAIGN_COSTS);
    expect(REFERENCE_CAMPAIGN_COSTS.maintenance).toEqual({ rates: { BTC: '0.005', ETH: '0.005' }, other: '0.01', plusFee: false });
    expect(opts.config.params).toEqual({ entryChannel: 55, exitChannel: 20, leverage: '5', structure: 'noadd', addStep: '0.1', feeRate: '0.0005' });
    expect(opts.config.pot).toEqual({ ...DEFAULT_POT_PARAMS, start: '100', minStake: '10' });
    expect(opts).toMatchObject({ offline: true, refresh: false, json: true, out: 'runs/a', cache: 'data/frozen', check: null });
    expect(parseCampaignCli(['--refresh'])).toMatchObject({ refresh: true, offline: false });
  });

  it('gives the catalogue the limits of the exchange when asked', () => {
    const opts = parseCampaignCli(['--catalogue', '--exchange-limits']);
    expect(opts.exchangeLimits).toBe(true);
    expect(opts.config).toMatchObject({ mode: 'catalogue', exchangeCap: true });
    expect(opts.config.costs).toEqual(DEFAULT_CAMPAIGN_COSTS);
    // The pot always has them.
    expect(parseCampaignCli(['--exchange-limits']).config).toEqual(DEFAULT_CAMPAIGN_CONFIG);
  });

  it('takes what is replayed from the reference file with --check, and never downloads', () => {
    const opts = parseCampaignCli(['--check', 'reference/run.json', '--structure', 'noadd', '--inst', 'BTC-USDT-SWAP', '--cache', 'frozen', '--out', 'o', '--json']);
    expect(opts).toMatchObject({ check: 'reference/run.json', offline: true, instIds: ['BTC-USDT-SWAP'], exchangeLimits: false });
    expect(parseCampaignCli(['--check', 'run.json', '--exchange-limits'])).toMatchObject({ check: 'run.json', exchangeLimits: true, offline: true });
    expect(opts.config.params.structure).toBe('noadd');
    const own = ['--pot 100', '--min-stake 1', '--from 2021-01-01', '--to 2021-01-01', '--leverage 5', '--add-step 0.1', '--entry-channel 55', '--exit-channel 20', '--catalogue', '--no-funding', '--refresh'];
    for (const flag of own) expect(() => parseCampaignCli(['--check', 'run.json', ...flag.split(' ')])).toThrow(UsageError);
  });

  it('takes the pot from the ledger with --reconcile, with the instruments, the cache and the output it is given', () => {
    expect(parseCampaignCli([])).toMatchObject({ reconcile: null });
    const opts = parseCampaignCli(['--reconcile', 'data/campaign-ledger.json', '--inst', 'btc-usdt-swap,ETH-USDT-SWAP', '--cache', 'data/c', '--offline', '--json']);
    expect(opts).toMatchObject({ reconcile: 'data/campaign-ledger.json', instIds: ['BTC-USDT-SWAP', 'ETH-USDT-SWAP'], cache: 'data/c', offline: true, json: true, check: null });
    expect(parseCampaignCli(['--reconcile', 'l.json', '--refresh'])).toMatchObject({ reconcile: 'l.json', refresh: true, offline: false });
    const own = ['--structure noadd', '--pot 100', '--min-stake 1', '--from 2021-01-01', '--to 2021-01-01', '--leverage 5', '--add-step 0.1', '--entry-channel 55', '--exit-channel 20', '--catalogue', '--exchange-limits', '--no-funding', '--check run.json', '--out o'];
    for (const flag of own) expect(() => parseCampaignCli(['--reconcile', 'l.json', ...flag.split(' ')])).toThrow(/--reconcile takes what is replayed from the ledger's pot/);
    expect(CAMPAIGN_HELP).toContain('--reconcile ledger.json');
  });

  it('rejects what it does not understand', () => {
    expect(() => parseCampaignCli(['--structure', 'full'])).toThrow(UsageError);
    expect(() => parseCampaignCli(['--pot', '0'])).toThrow(UsageError);
    expect(() => parseCampaignCli(['--min-stake', '-1'])).toThrow(UsageError);
    expect(() => parseCampaignCli(['--leverage', '0.5'])).toThrow(UsageError);
    expect(() => parseCampaignCli(['--add-step', 'five'])).toThrow(UsageError);
    expect(() => parseCampaignCli(['--entry-channel', '0'])).toThrow(UsageError);
    expect(() => parseCampaignCli(['--from', 'yesterday'])).toThrow(UsageError);
    expect(() => parseCampaignCli(['--inst', 'BTC-USDT-SWAP,btc-usdt-swap'])).toThrow(UsageError);
    expect(() => parseCampaignCli(['--offline', '--refresh'])).toThrow(UsageError);
    expect(() => parseCampaignCli(['--unknown'])).toThrow(UsageError);
  });

  it('reads the experiments, which the approved rule does not have', () => {
    expect(parseCampaignCli([]).config.params).not.toHaveProperty('stop');
    expect(parseCampaignCli([]).config.params).not.toHaveProperty('atrLeverage');
    expect(parseCampaignCli(['--stop', '0.06', '--atr-leverage', '3']).config.params).toMatchObject({ stop: '0.06', atrLeverage: '3', leverage: '10' });
    expect(() => parseCampaignCli(['--stop', '1'])).toThrow(/below 1/);
    expect(() => parseCampaignCli(['--atr-leverage', '0'])).toThrow(UsageError);
    expect(() => parseCampaignCli(['--check', 'ref.json', '--stop', '0.06'])).toThrow(UsageError);
    expect(() => parseCampaignCli(['--reconcile', 'ledger.json', '--atr-leverage', '3'])).toThrow(UsageError);
  });
});
