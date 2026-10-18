import { parseArgs } from 'node:util';
import {
  CAMPAIGN_INSTRUMENTS,
  CAMPAIGN_MAINTENANCE,
  D,
  DEFAULT_CAMPAIGN_PARAMS,
  DEFAULT_POT_PARAMS,
  DEFAULT_REGIME_PARAMS,
  isDecimalString,
  type CampaignParams,
  type CampaignStructure,
  type RegimeEntryModes,
  type RegimeParams,
} from '@pegasus/shared';
import { oneOf, positiveInt, UsageError, utcDate } from '../options.js';
import type { CampaignConfig, CampaignCosts } from './types.js';

/**
 * Fills as the evidence for the rule assumed them: slippage 0.05% in and 0.15% out on BTC and ETH,
 * 0.10% in and 0.25% out on the other coins. Liquidation where the exchange puts it: at the
 * maintenance rate of its first tier plus the taker fee (0.45% / 0.70% / 1.05%).
 */
export const DEFAULT_CAMPAIGN_COSTS: CampaignCosts = {
  slippage: { major: '0.0005', other: '0.001' },
  exitSlippage: { major: '0.0015', other: '0.0025' },
  maintenance: { ...CAMPAIGN_MAINTENANCE, plusFee: true },
};

/** The same fills with the liquidation of the reference run: 0.5% on BTC and ETH, 1% on the other coins, no fee on top. */
export const REFERENCE_CAMPAIGN_COSTS: CampaignCosts = {
  ...DEFAULT_CAMPAIGN_COSTS,
  maintenance: { rates: { BTC: '0.005', ETH: '0.005' }, other: '0.01', plusFee: false },
};

/** The approved rule: one pot of 56 on pyramided 10x campaigns, within the exchange's limits. */
export const DEFAULT_CAMPAIGN_CONFIG: CampaignConfig = {
  mode: 'pot',
  params: DEFAULT_CAMPAIGN_PARAMS,
  pot: DEFAULT_POT_PARAMS,
  from: null,
  to: null,
  funding: true,
  exchangeCap: true,
  costs: DEFAULT_CAMPAIGN_COSTS,
};

export const CAMPAIGN_HELP = `pnpm backtest:campaign [flags]

Replays the campaign rule (packages/shared/src/campaign.ts) over history: OKX daily and 12-hour
candles, Binance funding as the proxy. One pot stakes on leveraged long campaigns as their signals
come, one campaign per instrument. Fractions are fractions: 0.05 = 5%.

  --inst a,b              instruments (default ${CAMPAIGN_INSTRUMENTS.map((id) => id.split('-')[0]).join(', ')}, the USDT swaps)
  --from YYYY-MM-DD       first entry decision (default: as soon as the channels have their bars)
  --to YYYY-MM-DD         last close (default: the newest confirmed bar)
  --structure pyramid|noadd
                          pyramid: add to a campaign that works; noadd: hold the entry quantity (default ${DEFAULT_CAMPAIGN_PARAMS.structure})
  --pot n                 what the pot starts with (default ${DEFAULT_POT_PARAMS.start})
  --min-stake n           smallest stake; with less free cash no campaign is opened (default ${DEFAULT_POT_PARAMS.minStake})
  --catalogue             every signal as a campaign of its own with a stake of 1: no pot, no lot rounding,
                          and as the reference run had it: adds not capped by the exchange, liquidation at
                          0.5% (BTC, ETH) / 1% maintenance
  --exchange-limits       with --catalogue or --check: the exchange's limits, as the pot always has them:
                          adds cut to maxLever x margin, liquidation at the first maintenance tier plus the fee
  --entry-channel n       daily bars of the entry channel (default ${DEFAULT_CAMPAIGN_PARAMS.entryChannel})
  --exit-channel n        daily bars of the exit channel (default ${DEFAULT_CAMPAIGN_PARAMS.exitChannel})
  --leverage n            leverage of the entry and cap of an add (default ${DEFAULT_CAMPAIGN_PARAMS.leverage})
  --add-step f            rise of a 12-hour close over the last add price that triggers an add (default ${DEFAULT_CAMPAIGN_PARAMS.addStep})
  --stop f                experiment: a stop at (1 - f) x the last add price (the entry at first), filled at
                          that price less the exit slippage, before the liquidation (default: none)
  --atr-leverage k        experiment: the leverage of each entry set so that its liquidation sits k ATRs
                          (over the entry channel's daily bars) below the entry, --leverage at most
                          (default: none, --leverage for every entry)
  --cut-hour h            experiment: the UTC hour the daily bars close at (0, 4, 8, 12, 16 or 20; default 0, the
                          exchange's own daily and 12-hour bars). Another hour builds both from 4-hour candles: the
                          daily bar closes at h, the 12-hour bars at h and 12 hours later, the pot is sampled at h
  --regime                shadow (docs/proposals/regime-snowball-v2.1.md, C17 to C19): the light on BTC, the
                          vetoes and the waiting over the entry, with the defaults below; BTC must be replayed
  --veto-funding f        with --regime: 3-day funding mean per 8 hours at or above which BTC is red and an
                          instrument is vetoed (default ${DEFAULT_REGIME_PARAMS.vetoFunding})
  --veto-wild f           with --regime: ATR20 over the close at or above which BTC is red and an instrument is
                          vetoed (default ${DEFAULT_REGIME_PARAMS.vetoWild})
  --cooldown-days n       with --regime: days after a liquidation during which the instrument does not enter
                          (default ${DEFAULT_REGIME_PARAMS.cooldownDays})
  --thin-margin f         with --regime: a close over the entry channel by less than f waits instead of entering
                          (default ${DEFAULT_REGIME_PARAMS.thinMargin})
  --pending-bars n        with --regime: daily closes a pending level is kept for after the close that set it
                          (default ${DEFAULT_REGIME_PARAMS.pendingBars})
  --entry breakout|accept|either
                          with --regime: thin breakouts enter at once, wait for the next close, or for the next
                          close or a retest (default ${DEFAULT_REGIME_PARAMS.entry})
  --funding-source binance|okx
                          where the funding settlements come from: Binance, the proxy with the whole history
                          (default), or OKX's own, of which the exchange keeps about three months
  --no-funding            do not charge funding
  --offline               read the cache only and never download: for a frozen data set
  --refresh               download the history again instead of extending the cache
  --cache dir             cache directory (default packages/backtest/.cache)
  --out dir               where campaigns.csv, pot.csv, bankings.csv and campaign-summary.json go (default packages/backtest/out)
  --json                  print the summary object instead of the text
  --check file.json       replay a reference run and compare with it: the catalogue, with the rule, the
                          costs and the warm-up bars of the file, from the cache alone (--offline). Only
                          --structure, --inst, --cache, --out and --json go with it; with --structure
                          noadd the totals are compared. Exit code 1 when the replay differs. With
                          --exchange-limits the totals are shown next to the reference's, no pass or fail
  --reconcile ledger.json the replay beside a live pot: the pot of a campaign ledger (the API's
                          CAMPAIGN_STATE_FILE, data/campaign-ledger.json) replayed from its start to the
                          last 12-hour close with its own rule, the other structure beside it, its start
                          value held in BTC, and the ledger reconciled with the replay campaign by
                          campaign. Funding is OKX's own history, what the paper exchange charged. Only
                          --inst (the pot's instruments, CAMPAIGN_INSTRUMENTS; default the ten),
                          --cache, --offline, --refresh and --json go with it; --json prints the view of
                          GET /api/campaign/replay
  --help
`;

export interface CampaignCliOptions {
  help: boolean;
  /** null: the ten instruments of the evidence, or those of the reference file with --check */
  instIds: string[] | null;
  config: CampaignConfig;
  /** --exchange-limits was given */
  exchangeLimits: boolean;
  offline: boolean;
  refresh: boolean;
  json: boolean;
  /** As typed; resolved by the caller */
  out: string | null;
  cache: string | null;
  check: string | null;
  /** --reconcile: the ledger file, as typed */
  reconcile: string | null;
  /** --funding-source */
  fundingSource: 'binance' | 'okx';
}

function positive(name: string, value: string): string {
  if (!isDecimalString(value) || D(value).lte(0)) throw new UsageError(`--${name} takes a positive decimal, got "${value}"`);
  return value;
}

function fraction(name: string, value: string): string {
  if (!isDecimalString(value) || D(value).lt(0) || D(value).gte(1)) throw new UsageError(`--${name} takes a fraction from 0 below 1, got "${value}"`);
  return value;
}

/** The flags of the regime layers: only with --regime. */
const REGIME_FLAGS = ['veto-funding', 'veto-wild', 'cooldown-days', 'thin-margin', 'pending-bars', 'entry'] as const;
/** Flags that say what is replayed: with --check the reference file says it. */
const RULE_FLAGS = ['from', 'to', 'pot', 'min-stake', 'catalogue', 'entry-channel', 'exit-channel', 'leverage', 'add-step', 'stop', 'atr-leverage', 'cut-hour', 'regime', ...REGIME_FLAGS, 'funding-source', 'no-funding', 'refresh'] as const;
/** Daily closes the bars can be built at: the exchange's own (0) or a boundary of its 4-hour candles */
const CUT_HOURS: readonly number[] = [0, 4, 8, 12, 16, 20];
/** Flags that do not go with --reconcile: the ledger's pot says what is replayed, and nothing is written. */
const NOT_WITH_RECONCILE = ['from', 'to', 'structure', 'pot', 'min-stake', 'catalogue', 'exchange-limits', 'entry-channel', 'exit-channel', 'leverage', 'add-step', 'stop', 'atr-leverage', 'cut-hour', 'regime', ...REGIME_FLAGS, 'funding-source', 'no-funding', 'check', 'out'] as const;

export function parseCampaignCli(argv: readonly string[]): CampaignCliOptions {
  const string = { type: 'string' } as const;
  const boolean = { type: 'boolean' } as const;
  let values;
  try {
    ({ values } = parseArgs({
      args: [...argv],
      strict: true,
      allowPositionals: false,
      options: {
        inst: string,
        from: string,
        to: string,
        structure: string,
        pot: string,
        'min-stake': string,
        catalogue: boolean,
        'exchange-limits': boolean,
        'entry-channel': string,
        'exit-channel': string,
        leverage: string,
        'add-step': string,
        stop: string,
        'atr-leverage': string,
        'cut-hour': string,
        regime: boolean,
        'veto-funding': string,
        'veto-wild': string,
        'cooldown-days': string,
        'thin-margin': string,
        'pending-bars': string,
        entry: string,
        'funding-source': string,
        'no-funding': boolean,
        offline: boolean,
        refresh: boolean,
        cache: string,
        out: string,
        json: boolean,
        check: string,
        reconcile: string,
        help: boolean,
      },
    }));
  } catch (err) {
    throw new UsageError((err as Error).message);
  }
  if (values.reconcile !== undefined) {
    const extra = NOT_WITH_RECONCILE.filter((flag) => values[flag] !== undefined);
    if (extra.length > 0) throw new UsageError(`--reconcile takes what is replayed from the ledger's pot; it does not go with ${extra.map((flag) => `--${flag}`).join(', ')}`);
  }
  if (values.check !== undefined) {
    const extra = RULE_FLAGS.filter((flag) => values[flag] !== undefined);
    if (extra.length > 0) throw new UsageError(`--check takes what is replayed from the reference file; it does not go with ${extra.map((flag) => `--${flag}`).join(', ')}`);
  }
  if (values.offline === true && values.refresh === true) throw new UsageError('--offline and --refresh do not go together');
  const d = DEFAULT_CAMPAIGN_CONFIG;
  const leverage = values.leverage !== undefined ? positive('leverage', values.leverage) : d.params.leverage;
  if (D(leverage).lt(1)) throw new UsageError('--leverage must be at least 1');
  const pot = {
    ...d.pot,
    start: values.pot !== undefined ? positive('pot', values.pot) : d.pot.start,
    minStake: values['min-stake'] !== undefined ? positive('min-stake', values['min-stake']) : d.pot.minStake,
  };
  const mode = values.catalogue === true ? 'catalogue' : d.mode;
  // The exchange's limits belong to the pot; the catalogue is the reference run unless they are asked for.
  const limits = mode === 'pot' || values['exchange-limits'] === true;
  const params: CampaignParams = {
    ...d.params,
    entryChannel: values['entry-channel'] !== undefined ? positiveInt('entry-channel', values['entry-channel']) : d.params.entryChannel,
    exitChannel: values['exit-channel'] !== undefined ? positiveInt('exit-channel', values['exit-channel']) : d.params.exitChannel,
    leverage,
    structure: values.structure !== undefined ? oneOf<CampaignStructure>('structure', values.structure, ['pyramid', 'noadd']) : d.params.structure,
    addStep: values['add-step'] !== undefined ? positive('add-step', values['add-step']) : d.params.addStep,
  };
  if (values.stop !== undefined) {
    params.stop = positive('stop', values.stop);
    if (D(params.stop).gte(1)) throw new UsageError('--stop must be below 1');
  }
  if (values['atr-leverage'] !== undefined) params.atrLeverage = positive('atr-leverage', values['atr-leverage']);
  const cutHour = values['cut-hour'] !== undefined ? Number(values['cut-hour']) : 0;
  if (!CUT_HOURS.includes(cutHour)) throw new UsageError(`--cut-hour takes 0, 4, 8, 12, 16 or 20 (a UTC hour on a 4-hour boundary), got "${values['cut-hour']}"`);
  const regimeFlags = REGIME_FLAGS.filter((flag) => values[flag] !== undefined);
  if (values.regime !== true && regimeFlags.length > 0) throw new UsageError(`${regimeFlags.map((flag) => `--${flag}`).join(', ')} go with --regime only`);
  if (values.regime === true) {
    const r = DEFAULT_REGIME_PARAMS;
    const regime: RegimeParams = {
      vetoFunding: values['veto-funding'] !== undefined ? positive('veto-funding', values['veto-funding']) : r.vetoFunding,
      vetoWild: values['veto-wild'] !== undefined ? positive('veto-wild', values['veto-wild']) : r.vetoWild,
      cooldownDays: values['cooldown-days'] !== undefined ? positiveInt('cooldown-days', values['cooldown-days']) : r.cooldownDays,
      thinMargin: values['thin-margin'] !== undefined ? fraction('thin-margin', values['thin-margin']) : r.thinMargin,
      pendingBars: values['pending-bars'] !== undefined ? positiveInt('pending-bars', values['pending-bars']) : r.pendingBars,
      entry: values.entry !== undefined ? oneOf<RegimeEntryModes>('entry', values.entry, ['breakout', 'accept', 'either']) : r.entry,
    };
    params.regime = regime;
  }
  const config: CampaignConfig = {
    mode,
    params,
    pot,
    from: values.from !== undefined ? utcDate('from', values.from) : null,
    to: values.to !== undefined ? utcDate('to', values.to) : null,
    funding: values['no-funding'] !== true,
    exchangeCap: limits,
    costs: limits ? DEFAULT_CAMPAIGN_COSTS : REFERENCE_CAMPAIGN_COSTS,
  };
  if (cutHour !== 0) config.cutHour = cutHour;
  let instIds: string[] | null = null;
  if (values.inst !== undefined) {
    instIds = values.inst
      .split(',')
      .map((s) => s.trim().toUpperCase())
      .filter((s) => s !== '');
    if (instIds.length === 0 || new Set(instIds).size !== instIds.length) throw new UsageError('--inst takes each instrument once');
  }
  return {
    help: values.help === true,
    instIds,
    config,
    exchangeLimits: values['exchange-limits'] === true,
    offline: values.offline === true || values.check !== undefined,
    refresh: values.refresh === true,
    json: values.json === true,
    out: values.out ?? null,
    cache: values.cache ?? null,
    check: values.check ?? null,
    reconcile: values.reconcile ?? null,
    fundingSource: values['funding-source'] !== undefined ? oneOf<'binance' | 'okx'>('funding-source', values['funding-source'], ['binance', 'okx']) : 'binance',
  };
}
