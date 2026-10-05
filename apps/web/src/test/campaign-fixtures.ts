import type {
  CampaignFillRecord,
  CampaignLogPage,
  CampaignParamsView,
  CampaignRecordView,
  CampaignReplayRun,
  CampaignReplayView,
  CampaignStepLog,
  CampaignStructure,
  CampaignView,
  Instrument,
} from '@pegasus/shared';

/**
 * Test data of the campaign page: views of GET /api/campaign (disabled, blocked, a running pot with open and ended
 * campaigns), replays of GET /api/campaign/replay (ready, failed with and without an earlier result) and pages of
 * GET /api/campaign/log. Only tests import this file.
 */

export const DAY = 86_400_000;
export const HALF_DAY = 43_200_000;
/** The clock of the tests: 09:30 UTC, two and a half hours before the 12:00 close */
export const NOW = Date.UTC(2026, 9, 5, 9, 30);
/** The 00:00 UTC close of the last step */
export const LAST_CLOSE = Date.UTC(2026, 9, 5);
export const NEXT_CLOSE = LAST_CLOSE + HALF_DAY;
export const POT_START = Date.UTC(2026, 8, 20, 0, 1);

export const inst = (instId: string, tickSz: string, ctVal: string): Instrument => {
  const baseCcy = instId.split('-')[0] ?? '';
  return {
    instId,
    instType: 'SWAP',
    uly: `${baseCcy}-USDT`,
    baseCcy,
    quoteCcy: 'USDT',
    settleCcy: 'USDT',
    ctVal,
    ctValCcy: baseCcy,
    ctMult: '1',
    ctType: 'linear',
    lotSz: '1',
    minSz: '1',
    tickSz,
    maxLmtSz: '100000',
    maxMktSz: '10000',
    maxLever: '100',
    state: 'live',
  };
};

export const ETH = inst('ETH-USDT-SWAP', '0.01', '0.1');
export const BTC = inst('BTC-USDT-SWAP', '0.1', '0.01');

export const params: CampaignParamsView = {
  instruments: ['BTC-USDT-SWAP', 'ETH-USDT-SWAP', 'LTC-USDT-SWAP', 'XRP-USDT-SWAP', 'BCH-USDT-SWAP', 'ETC-USDT-SWAP', 'LINK-USDT-SWAP', 'ADA-USDT-SWAP', 'DOT-USDT-SWAP', 'TRX-USDT-SWAP'],
  potStart: '56',
  minStake: '5.6',
  structure: 'pyramid',
  leverage: '10',
  feeRate: '0.0005',
  addStep: '0.05',
  entryChannel: 20,
  exitChannel: 10,
  stakeFraction: '0.5',
  rungFactor: '10',
  bankFraction: '0.5',
};

const empty = {
  params,
  pot: null,
  campaigns: [],
  bankings: [],
  samples: [],
  errorCount: 0,
  errors: [],
  missedCloses: 0,
  foreign: [],
  lastStep: null,
  nextStep: null,
  serverTime: NOW,
} satisfies Partial<CampaignView>;

export const disabledView: CampaignView = {
  ...empty,
  status: 'disabled',
  reason: { code: 'CAMPAIGN_DISABLED', message: 'the campaign is not enabled (CAMPAIGN_ENABLED=1, paper trading only)' },
  replay: null,
};

export const NOT_DEDICATED =
  'the pot needs a paper account of its own and this one is not: total equity 10000 is not within 1% of 56. Run the campaign on its own paper account: start the paper exchange with a new PAPER_STATE_FILE and PAPER_BALANCE=56 (and give the campaign its own CAMPAIGN_STATE_FILE)';

export const blockedView: CampaignView = {
  ...empty,
  status: 'blocked',
  reason: { code: 'ACCOUNT_NOT_DEDICATED', message: NOT_DEDICATED },
  replay: { status: 'unavailable', computedAt: null, mismatches: null },
};

const fill = (ts: number, contracts: string, avgPx: string): CampaignFillRecord => ({ ts, ordId: `o${ts}`, clOrdId: `pc${ts}`, contracts, qty: contracts, avgPx, fee: '0.01' });

function record(instId: string, closeTs: number, over: Partial<CampaignRecordView>): CampaignRecordView {
  return {
    id: `${instId}@${closeTs}`,
    instId,
    signalTs: closeTs - DAY,
    entry: { ...fill(closeTs + 60_000, '5', '2400.5'), closeTs, price: '2400', stake: '28', margin: '27.9' },
    adds: [],
    sales: [],
    addRef: '2400',
    addUnit: '0.5',
    stake: '28',
    basis: '28',
    harvested: '0',
    peak: '1',
    pendingExit: null,
    end: null,
    multiple: null,
    position: null,
    valueMultiple: null,
    ...over,
  };
}

const ETH_CLOSE = Date.UTC(2026, 9, 3);

/** Newest first, as the API sends them: one open, then an external, a harvest, a liquidation and an exit. */
export const campaigns: CampaignRecordView[] = [
  record('ETH-USDT-SWAP', ETH_CLOSE, {
    adds: [
      { ...fill(ETH_CLOSE + HALF_DAY + 30_000, '5', '2520.25'), closeTs: ETH_CLOSE + HALF_DAY, price: '2520', margin: '27.8' },
      { ...fill(ETH_CLOSE + DAY + 30_000, '5', '2646.1'), closeTs: ETH_CLOSE + DAY, price: '2646', margin: '27.7' },
    ],
    addRef: '2646',
    position: { contracts: '15', avgPx: '2522.28', markPx: '2600', margin: '27.7', equity: '75.5', liqPx: '2210.4' },
    valueMultiple: '2.696428571428571428571428571',
  }),
  record('ADA-USDT-SWAP', Date.UTC(2026, 9, 1), {
    end: { kind: 'external', ts: Date.UTC(2026, 9, 2, 7), proceeds: '', fill: null },
  }),
  record('LTC-USDT-SWAP', Date.UTC(2026, 8, 26), {
    harvested: '150',
    end: { kind: 'harvest', ts: Date.UTC(2026, 8, 28, 12, 1), proceeds: '0', fill: { ...fill(Date.UTC(2026, 8, 28, 12, 1), '8', '130'), pnl: '120' } },
    multiple: '5.357142857142857142857142857',
  }),
  record('XRP-USDT-SWAP', Date.UTC(2026, 8, 24), {
    end: { kind: 'liquidated', ts: Date.UTC(2026, 8, 25, 3), proceeds: '0', fill: { ...fill(Date.UTC(2026, 8, 25, 3), '40', '2.61'), pnl: '-27.9' } },
    multiple: '0',
  }),
  record('BTC-USDT-SWAP', Date.UTC(2026, 8, 21), {
    end: { kind: 'exit', ts: Date.UTC(2026, 8, 23, 0, 0, 40), proceeds: '42.5', closeTs: Date.UTC(2026, 8, 23), delayMs: 40_000, fill: { ...fill(Date.UTC(2026, 8, 23, 0, 0, 40), '2', '118000'), pnl: '14.6' } },
    multiple: '1.517857142857142857142857143',
  }),
];

/** One sample per close processed, oldest first. */
export const samples: CampaignView['samples'] = [0, 1, 2, 3, 4, 5].map((k) => ({
  ts: LAST_CLOSE - (5 - k) * HALF_DAY,
  freeCash: '100.25',
  openEquity: ['40', '52.5', '61', '58', '70.25', '75.5'][k] ?? '0',
  banked: '300',
  value: ['140.25', '152.75', '161.25', '158.25', '170.5', '175.75'][k] ?? '0',
  open: 1,
}));

export const runningView: CampaignView = {
  status: 'running',
  reason: null,
  params,
  pot: {
    startedAt: POT_START,
    startValue: '56',
    btcMarkAtStart: '115000',
    structure: 'pyramid',
    start: '56',
    minStake: '5.6',
    banked: '300',
    rungs: 1,
    peak: { ts: Date.UTC(2026, 8, 28, 12), value: '612.5' },
    finishedAt: null,
    freeCash: '100.25',
    openEquity: '75.5',
    value: '175.75',
    nextRung: '5600',
  },
  campaigns,
  bankings: [{ closeTs: Date.UTC(2026, 8, 28, 12), rungs: 1, value: '612.5', target: '306.25', fromCash: '156.25', fraction: '0.6', fromSales: '143.75', amount: '300' }],
  samples,
  errorCount: 2,
  errors: [
    {
      ts: LAST_CLOSE - DAY + 70_000,
      closeTs: LAST_CLOSE - DAY,
      campaignId: campaigns[0]?.id ?? null,
      instId: 'ETH-USDT-SWAP',
      action: 'add',
      code: 'CAMPAIGN_PARTIAL_FILL',
      message: 'the add filled 5 of 6 contracts',
      details: { planned: '6', filled: '5' },
    },
    {
      ts: Date.UTC(2026, 9, 2, 12, 0, 50),
      closeTs: null,
      campaignId: campaigns[1]?.id ?? null,
      instId: 'ADA-USDT-SWAP',
      action: 'reconcile',
      code: 'CAMPAIGN_POSITION_UNEXPLAINED',
      message: 'the position is gone and the order history does not say why',
      details: {},
    },
  ],
  missedCloses: 1,
  foreign: ['DOT-USDT-SWAP isolated net 3'],
  lastStep: { seq: 42, kind: 'close', closeTs: LAST_CLOSE, startedAt: LAST_CLOSE + 5_000, endedAt: LAST_CLOSE + 65_000, errors: 0 },
  nextStep: { closeTs: NEXT_CLOSE, daily: false },
  replay: { status: 'ready', computedAt: LAST_CLOSE + 120_000, mismatches: 2 },
  serverTime: NOW,
};

// ---- the replay ----

const run = (structure: CampaignStructure, values: string[]): CampaignReplayRun => ({
  structure,
  samples: values.map((value, k) => ({ ts: LAST_CLOSE - (values.length - 1 - k) * HALF_DAY, value, banked: '300' })),
  campaigns: [],
  bankings: [{ closeTs: Date.UTC(2026, 8, 28, 12), amount: '300' }],
  value: values[values.length - 1] ?? '0',
  banked: '300',
  finished: false,
});

export const replayReady: CampaignReplayView = {
  status: 'ready',
  reason: null,
  computedAt: LAST_CLOSE + 120_000,
  through: LAST_CLOSE,
  same: run('pyramid', ['140', '152', '161', '158', '171', '176']),
  other: run('noadd', ['90', '92', '95', '94', '97', '99']),
  heldBtc: [0, 1, 2, 3, 4, 5].map((k) => ({ ts: LAST_CLOSE - (5 - k) * HALF_DAY, value: ['58', '59', '57.5', '60', '61', '62.25'][k] ?? '0' })),
  reconciliation: {
    tolerances: { entryPx: '0.005', stake: '0.01' },
    matched: 3,
    differing: 1,
    liveOnly: 1,
    replayOnly: 0,
    rows: [
      { instId: 'BTC-USDT-SWAP', signalTs: Date.UTC(2026, 8, 20), campaignId: campaigns[4]?.id ?? null, verdict: 'match', differences: [] },
      { instId: 'XRP-USDT-SWAP', signalTs: Date.UTC(2026, 8, 23), campaignId: campaigns[3]?.id ?? null, verdict: 'match', differences: [] },
      { instId: 'LTC-USDT-SWAP', signalTs: Date.UTC(2026, 8, 25), campaignId: campaigns[2]?.id ?? null, verdict: 'match', differences: [] },
      {
        instId: 'ADA-USDT-SWAP',
        signalTs: Date.UTC(2026, 8, 30),
        campaignId: campaigns[1]?.id ?? null,
        verdict: 'live-only',
        differences: [{ field: 'campaign', live: 'external', replay: null }],
      },
      {
        instId: 'ETH-USDT-SWAP',
        signalTs: Date.UTC(2026, 9, 2),
        campaignId: campaigns[0]?.id ?? null,
        verdict: 'differs',
        differences: [
          { field: 'entryPx', live: '2400.5', replay: '2390' },
          { field: 'adds', live: '2', replay: '1' },
        ],
      },
    ],
  },
};

export const REPLAY_FAILURE = 'candles unavailable: OKX answered 50011 Too Many Requests';

/** The first attempt failed: nothing to draw. */
export const replayFailed: CampaignReplayView = {
  status: 'failed',
  reason: { code: 'REPLAY_FAILED', message: REPLAY_FAILURE },
  computedAt: null,
  through: null,
  same: null,
  other: null,
  heldBtc: [],
  reconciliation: null,
};

/** A later attempt failed: the earlier result is still given. */
export const replayFailedEarlier: CampaignReplayView = { ...replayReady, status: 'failed', reason: { code: 'REPLAY_FAILED', message: REPLAY_FAILURE } };

// ---- the decision log ----

const step42: CampaignStepLog = {
  seq: 42,
  kind: 'close',
  closeTs: LAST_CLOSE,
  closes: [LAST_CLOSE],
  startedAt: LAST_CLOSE + 5_000,
  endedAt: LAST_CLOSE + 65_000,
  before: { freeCash: '100.25', openEquity: '70.25', value: '170.5', banked: '300', rungs: 1 },
  inputs: [
    {
      instId: 'ETH-USDT-SWAP',
      closeTs: LAST_CLOSE,
      halfDay: { ts: LAST_CLOSE - HALF_DAY, open: '2580', high: '2640', low: '2561.5', close: '2610' },
      price: '2611.2',
      daily: { asOf: LAST_CLOSE - DAY, close: '2610', entryHigh: '2700', exitLow: '2380', entry: false, exit: false },
    },
    {
      instId: 'TRX-USDT-SWAP',
      closeTs: LAST_CLOSE,
      halfDay: null,
      price: null,
      daily: null,
      note: 'the 12-hour bar was not confirmed within 10 minutes',
    },
  ],
  actions: [
    {
      kind: 'add',
      closeTs: LAST_CLOSE,
      instId: 'ETH-USDT-SWAP',
      campaignId: campaigns[0]?.id ?? null,
      plan: { contracts: 5, price: '2611.2' },
      outcome: 'skipped',
      reason: 'add-cap',
      result: null,
      attempts: 1,
      error: false,
      ts: LAST_CLOSE + 30_000,
    },
  ],
  errors: 0,
  notes: [],
};

const step41: CampaignStepLog = {
  seq: 41,
  kind: 'catch-up',
  closeTs: LAST_CLOSE - HALF_DAY,
  closes: [LAST_CLOSE - DAY, LAST_CLOSE - HALF_DAY],
  startedAt: LAST_CLOSE - HALF_DAY + 3 * 3_600_000,
  endedAt: LAST_CLOSE - HALF_DAY + 3 * 3_600_000 + 90_000,
  before: null,
  inputs: [
    {
      instId: 'BCH-USDT-SWAP',
      closeTs: LAST_CLOSE - DAY,
      halfDay: { ts: LAST_CLOSE - DAY - HALF_DAY, open: '590', high: '612', low: '588', close: '611' },
      price: '611.5',
      daily: { asOf: LAST_CLOSE - 2 * DAY, close: '611', entryHigh: '600', exitLow: '540', entry: true, exit: false },
    },
  ],
  actions: [
    {
      kind: 'enter',
      closeTs: LAST_CLOSE - DAY,
      instId: 'BCH-USDT-SWAP',
      campaignId: null,
      plan: { signalTs: LAST_CLOSE - 2 * DAY, close: '611', entryHigh: '600' },
      outcome: 'missed',
      reason: '',
      result: null,
      attempts: 0,
      error: false,
      ts: LAST_CLOSE - HALF_DAY + 3 * 3_600_000 + 1_000,
    },
    {
      kind: 'exit',
      closeTs: LAST_CLOSE - DAY,
      instId: 'BTC-USDT-SWAP',
      campaignId: campaigns[4]?.id ?? null,
      plan: { late: true },
      outcome: 'failed',
      reason: 'EXCHANGE',
      result: { proceeds: '12.5' },
      attempts: 3,
      error: true,
      ts: LAST_CLOSE - HALF_DAY + 3 * 3_600_000 + 50_000,
    },
  ],
  errors: 1,
  notes: ['the service was not running at the 00:00 close'],
};

const step40: CampaignStepLog = {
  ...step42,
  seq: 40,
  closeTs: LAST_CLOSE - DAY - HALF_DAY,
  closes: [LAST_CLOSE - DAY - HALF_DAY],
  startedAt: LAST_CLOSE - DAY - HALF_DAY + 4_000,
  endedAt: LAST_CLOSE - DAY - HALF_DAY + 40_000,
  inputs: [],
  actions: [],
};

export const logPage1: CampaignLogPage = { steps: [step42, step41], total: 3, next: 41 };
export const logPage2: CampaignLogPage = { steps: [step40], total: 3, next: null };
