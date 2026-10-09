import type {
  CampaignFollowPlan,
  CampaignSignalBar,
  CampaignSignalRow,
  CampaignSignalsResponse,
  Instrument,
  SignalSnapshot,
  TrailingView,
} from '@pegasus/shared';
import { BTC, ETH, NOW, inst } from './campaign-fixtures';

/**
 * Test data of the SIGNALS tab: GET /api/campaign/signals with a coin in every state (an entry with a clean plan, an
 * entry whose plan warns, an add, an exit, a holding, two near, a none, an untracked none, an unavailable), the same
 * read on the campaign stack (ownAccount) and GET /api/trailing with exits offered and not. Only tests and the
 * screenshot harness import this file.
 */

const DAY = 86_400_000;
const HALF = 43_200_000;
/** The daily bar that closed at 00:00 UTC today */
export const DAILY_TS = Date.UTC(2026, 9, 4);
const daily = (close: string): CampaignSignalBar => ({ barTs: DAILY_TS, closeTs: DAILY_TS + DAY, close });
const halfDay = (close: string): CampaignSignalBar => ({ barTs: DAILY_TS + HALF, closeTs: DAILY_TS + DAY, close });

export const LTC = inst('LTC-USDT-SWAP', '0.01', '1');
export const XRP = inst('XRP-USDT-SWAP', '0.0001', '100');
export const BCH = inst('BCH-USDT-SWAP', '0.01', '0.1');
export const ETC = inst('ETC-USDT-SWAP', '0.001', '10');
export const LINK = inst('LINK-USDT-SWAP', '0.001', '1');
export const ADA = inst('ADA-USDT-SWAP', '0.0001', '100');
export const TRX = inst('TRX-USDT-SWAP', '0.00001', '1000');
/** DOT is not tracked by the server in these tests */
export const SIGNAL_INSTRUMENTS: Instrument[] = [BTC, ETH, LTC, XRP, BCH, ETC, LINK, ADA, TRX];

export const btcSignal: SignalSnapshot = { rule: 'campaign', kind: 'entry', barTs: DAILY_TS, close: '64120', entryLevel: '63250', exitLevel: '58600' };

export const btcPlan: CampaignFollowPlan = {
  kind: 'entry',
  instId: 'BTC-USDT-SWAP',
  side: 'buy',
  tdMode: 'isolated',
  spec: BTC,
  entryPx: '64180.5',
  stopPx: '58900',
  stopDistance: '5280.5',
  stopDistancePct: '0.08227',
  riskTarget: '250',
  riskAmount: '211.22',
  riskContracts: '4',
  contracts: '4',
  coin: '0.04',
  notional: '2567.22',
  leverage: '10',
  margin: '256.72',
  liqPx: '58021.9',
  maintenanceRate: '0.0045',
  trailing: { kind: 'channel', bars: 10 },
  takeProfits: [],
  after: null,
  signal: btcSignal,
  warnings: [],
};

const btcRow: CampaignSignalRow = {
  instId: 'BTC-USDT-SWAP',
  state: 'entry',
  reasons: [{ code: 'CLOSE_ABOVE_ENTRY', params: { close: '64120', level: '63250' } }],
  tracked: true,
  daily: daily('64120'),
  halfDay: halfDay('64120'),
  levels: { entry: '63250', exit: '58600', nextEntry: '64480', nextExit: '58900' },
  markPx: '64180.5',
  entryDistancePct: '0.0047',
  holding: null,
  signal: btcSignal,
  plan: btcPlan,
};

const ethSignal: SignalSnapshot = { rule: 'campaign', kind: 'add', barTs: DAILY_TS + HALF, close: '3192.4', entryLevel: '3240.1', exitLevel: '2905.4' };
const ethRow: CampaignSignalRow = {
  instId: 'ETH-USDT-SWAP',
  state: 'add',
  reasons: [
    { code: 'HOLDING', params: { contracts: '20', trailingLine: '2905.4', addTrigger: '3171.53' } },
    { code: 'ADD_TRIGGER_REACHED', params: { close: '3192.4', trigger: '3171.53', addRef: '3020.5', barTs: DAILY_TS + HALF } },
  ],
  tracked: true,
  daily: daily('3150.2'),
  halfDay: halfDay('3192.4'),
  levels: { entry: '3240.1', exit: '2880', nextEntry: '3240.1', nextExit: '2905.4' },
  markPx: '3188.75',
  entryDistancePct: '0.0161',
  holding: {
    contracts: '20',
    avgPx: '3020.5',
    mgnMode: 'isolated',
    lever: '10',
    margin: '604.1',
    liqPx: '2731.2',
    trailingLine: '2905.4',
    addRef: '3020.5',
    addRefTs: DAILY_TS - 3 * DAY,
    addRefSource: 'journal',
    addTrigger: '3171.53',
    tradeId: '7-ETH-USDT-SWAP',
  },
  signal: ethSignal,
  plan: {
    ...btcPlan,
    kind: 'add',
    instId: 'ETH-USDT-SWAP',
    spec: ETH,
    entryPx: '3188.75',
    stopPx: '2905.4',
    stopDistance: '283.35',
    stopDistancePct: '0.08886',
    riskTarget: '250',
    riskAmount: '226.68',
    riskContracts: '8',
    contracts: '8',
    coin: '0.8',
    notional: '2551',
    leverage: '10',
    margin: '255.1',
    liqPx: '2786.4',
    after: { contracts: '28', avgPx: '3068.5', margin: '859.2', liqPx: '2786.4' },
    signal: ethSignal,
    warnings: [],
  },
};

const ltcRow: CampaignSignalRow = {
  instId: 'LTC-USDT-SWAP',
  state: 'exit',
  reasons: [
    { code: 'HOLDING', params: { contracts: '12', trailingLine: '79.4', addTrigger: '90.3' } },
    { code: 'CLOSE_BELOW_EXIT', params: { close: '79.88', level: '80.15' } },
  ],
  tracked: true,
  daily: daily('79.88'),
  halfDay: halfDay('79.88'),
  levels: { entry: '91.2', exit: '80.15', nextEntry: '91.2', nextExit: '79.4' },
  markPx: '80.02',
  entryDistancePct: '0.1397',
  holding: { contracts: '12', avgPx: '86', mgnMode: 'isolated', lever: '10', margin: '103.2', liqPx: '77.8', trailingLine: '79.4', addRef: '86', addRefTs: null, addRefSource: 'position', addTrigger: '90.3', tradeId: null },
  signal: null,
  plan: null,
};

const xrpRow: CampaignSignalRow = {
  instId: 'XRP-USDT-SWAP',
  state: 'holding',
  reasons: [{ code: 'HOLDING', params: { contracts: '30', trailingLine: '0.5712', addTrigger: '0.6531' } }],
  tracked: true,
  daily: daily('0.6204'),
  halfDay: halfDay('0.6204'),
  levels: { entry: '0.6388', exit: '0.5712', nextEntry: '0.6388', nextExit: '0.5712' },
  markPx: '0.6219',
  entryDistancePct: '0.0272',
  holding: { contracts: '30', avgPx: '0.622', mgnMode: 'isolated', lever: '10', margin: '186.6', liqPx: '0.5627', trailingLine: '0.5712', addRef: '0.622', addRefTs: DAILY_TS - DAY, addRefSource: 'journal', addTrigger: '0.6531', tradeId: '9-XRP-USDT-SWAP' },
  signal: null,
  plan: null,
};

const near = (instId: string, markPx: string, level: string, distancePct: string, close: string, exit: string): CampaignSignalRow => ({
  instId,
  state: 'near',
  reasons: [{ code: 'NEAR_ENTRY', params: { markPx, level, distancePct, nearPct: '0.03' } }],
  tracked: true,
  daily: daily(close),
  halfDay: halfDay(close),
  levels: { entry: level, exit, nextEntry: level, nextExit: exit },
  markPx,
  entryDistancePct: distancePct,
  holding: null,
  signal: null,
  plan: null,
});

const none = (instId: string, markPx: string, level: string, distancePct: string, close: string, exit: string, tracked = true): CampaignSignalRow => ({
  instId,
  state: 'none',
  reasons: [{ code: 'BELOW_ENTRY', params: { markPx, level, distancePct } }],
  tracked,
  daily: daily(close),
  halfDay: halfDay(close),
  levels: { entry: level, exit, nextEntry: level, nextExit: exit },
  markPx,
  entryDistancePct: distancePct,
  holding: null,
  signal: null,
  plan: null,
});

const adaSignal: SignalSnapshot = { rule: 'campaign', kind: 'entry', barTs: DAILY_TS - DAY, close: '0.4312', entryLevel: '0.4251', exitLevel: '0.3402' };
/** An entry whose plan warns: a wide stop, below the minimum order, a late price, a signal more than a bar old */
const adaRow: CampaignSignalRow = {
  instId: 'ADA-USDT-SWAP',
  state: 'entry',
  reasons: [{ code: 'CLOSE_ABOVE_ENTRY', params: { close: '0.4312', level: '0.4251' } }],
  tracked: true,
  daily: { barTs: DAILY_TS - DAY, closeTs: DAILY_TS, close: '0.4312' },
  halfDay: halfDay('0.4566'),
  levels: { entry: '0.4251', exit: '0.3402', nextEntry: '0.4580', nextExit: '0.3420' },
  markPx: '0.4571',
  entryDistancePct: '0.002',
  holding: null,
  signal: adaSignal,
  plan: {
    ...btcPlan,
    instId: 'ADA-USDT-SWAP',
    spec: ADA,
    entryPx: '0.4571',
    stopPx: '0.342',
    stopDistance: '0.1151',
    stopDistancePct: '0.25180',
    riskTarget: '2.5',
    riskAmount: '11.51',
    riskContracts: '1',
    contracts: '1',
    coin: '100',
    notional: '45.71',
    leverage: '3',
    margin: '15.24',
    liqPx: '0.3065',
    signal: adaSignal,
    warnings: [
      { code: 'SIGNAL_STALE', params: { barTs: DAILY_TS - DAY, closedAt: DAILY_TS, ageMs: DAY + 9.5 * 3_600_000 } },
      { code: 'PRICE_FAR_ABOVE_SIGNAL', params: { markPx: '0.4571', close: '0.4312', risePct: '0.06006', limit: '0.05' } },
      { code: 'STOP_TOO_WIDE', params: { stopDistancePct: '0.2518', limit: '0.2' } },
      { code: 'LEVERAGE_REDUCED', params: { leverage: 3, maxLeverage: 10 } },
      { code: 'BELOW_MIN_ORDER', params: { sized: '0', minSz: '1', riskAmount: '11.51' } },
    ],
  },
};

const linkRow: CampaignSignalRow = {
  instId: 'LINK-USDT-SWAP',
  state: 'unavailable',
  reasons: [{ code: 'BARS_UNAVAILABLE', params: { message: 'OKX answered 50011 Too Many Requests' } }],
  tracked: true,
  daily: null,
  halfDay: null,
  levels: { entry: null, exit: null, nextEntry: null, nextExit: null },
  markPx: '14.208',
  entryDistancePct: null,
  holding: null,
  signal: null,
  plan: null,
};

/** In the configured order: the page sorts them. */
export const signalRows: CampaignSignalRow[] = [
  btcRow,
  ethRow,
  ltcRow,
  xrpRow,
  near('BCH-USDT-SWAP', '409.12', '418.5', '0.0229', '405.3', '371.2'),
  none('ETC-USDT-SWAP', '23.114', '26.41', '0.1426', '23.02', '21.85'),
  linkRow,
  adaRow,
  none('DOT-USDT-SWAP', '5.612', '6.48', '0.1547', '5.58', '5.12', false),
  near('TRX-USDT-SWAP', '0.15992', '0.16241', '0.0156', '0.15901', '0.14872'),
];

export const signalsResponse: CampaignSignalsResponse = {
  generatedAt: NOW,
  params: { entryChannel: 20, exitChannel: 10, addStep: '0.05', structure: 'pyramid', leverage: '10', feeRate: '0.0005' },
  thresholds: { nearPct: '0.03', stopWidePct: '0.2', stopNarrowPct: '0.02', farAbovePct: '0.05', liqBufferPct: '0.01' },
  riskPct: '0.01',
  equity: '25000',
  equitySource: 'account',
  campaign: { enabled: false, status: 'disabled', ownAccount: false },
  rows: signalRows,
};

/** The same read on the campaign stack: the pot runs on this account and every plan says so. */
export const campaignAccountResponse: CampaignSignalsResponse = {
  ...signalsResponse,
  equity: '56',
  campaign: { enabled: true, status: 'running', ownAccount: true },
  rows: signalRows.map((r) => (r.plan === null ? r : { ...r, plan: { ...r.plan, warnings: [{ code: 'CAMPAIGN_ACCOUNT', params: {} }, ...r.plan.warnings] } })),
};

/** ADA as OKX lists it: lots of a tenth of a contract */
export const ADA_TENTHS: Instrument = { ...ADA, lotSz: '0.1', minSz: '0.1', maxLever: '50' };
const adaEntryTs = Date.UTC(2026, 9, 5);
export const adaEntrySignal: SignalSnapshot = { rule: 'campaign', kind: 'entry', barTs: adaEntryTs, close: '0.2703', entryLevel: '0.2687', exitLevel: '0.2366' };

/**
 * The owner's ADA entry of 2026-10-06, as the API plans it: risk 0.75% of 99,960 USDT sizes 210 contracts, the
 * per-order limit of 5,000 USDT (each contract valued at the mark plus 0.5% slippage) allows 182.7; leverage 6 instead
 * of 10 so that the liquidation (0.2293) stays below the stop 0.2366 (at 10x it would be 0.2477).
 */
export const adaScenarioPlan: CampaignFollowPlan = {
  kind: 'entry',
  instId: 'ADA-USDT-SWAP',
  side: 'buy',
  tdMode: 'isolated',
  spec: ADA_TENTHS,
  entryPx: '0.2723',
  stopPx: '0.2366',
  stopDistance: '0.0357',
  stopDistancePct: '0.131105',
  riskTarget: '749.7',
  riskAmount: '652.239',
  riskContracts: '210',
  contracts: '182.7',
  coin: '18270',
  notional: '4974.921',
  leverage: '6',
  margin: '829.1535',
  liqPx: '0.229325',
  maintenanceRate: '0.0105',
  trailing: { kind: 'channel', bars: 10 },
  takeProfits: [],
  after: null,
  signal: adaEntrySignal,
  warnings: [
    { code: 'LEVERAGE_REDUCED', params: { leverage: 6, maxLeverage: 10, liqPx: '0.229325', liqPxAtMax: '0.247671', stopPx: '0.2366', limitPx: '0.234234' } },
    { code: 'LIMITED_BY_ORDER_NOTIONAL', params: { riskContracts: '210', contracts: '182.7', notional: '4974.921', limit: '5000', riskAmount: '652.239' } },
  ],
};

export const adaScenarioRow: CampaignSignalRow = {
  instId: 'ADA-USDT-SWAP',
  state: 'entry',
  reasons: [{ code: 'CLOSE_ABOVE_ENTRY', params: { close: '0.2703', level: '0.2687' } }],
  tracked: true,
  daily: { barTs: adaEntryTs, closeTs: adaEntryTs + DAY, close: '0.2703' },
  halfDay: { barTs: adaEntryTs + HALF, closeTs: adaEntryTs + DAY, close: '0.2703' },
  levels: { entry: '0.2687', exit: '0.2366', nextEntry: '0.2703', nextExit: '0.2366' },
  markPx: '0.2723',
  entryDistancePct: '-0.0073',
  holding: null,
  signal: adaEntrySignal,
  plan: adaScenarioPlan,
};

/** The read behind the owner's screenshot: one coin, risk 0.75%, the account's 99,960 USDT */
export const adaScenarioResponse: CampaignSignalsResponse = { ...signalsResponse, riskPct: '0.0075', equity: '99960', rows: [adaScenarioRow] };

export const trailingOn: TrailingView = {
  enabled: true,
  entries: [
    {
      instId: 'XRP-USDT-SWAP',
      mgnMode: 'isolated',
      posSide: 'net',
      direction: 'long',
      bars: 10,
      source: 'order',
      clOrdId: 'psw1abc',
      since: DAILY_TS - DAY,
      level: '0.5712',
      levelClose: DAILY_TS + DAY,
      algoIds: ['ch1'],
      lastMove: { at: DAILY_TS + DAY + 60_000, close: DAILY_TS + DAY, algoId: 'ch1', action: 'amended', from: '0.5650', to: '0.5712' },
      lastError: null,
    },
  ],
  pending: [],
  nextCloseAt: DAILY_TS + 2 * DAY,
  ts: NOW,
};

export const trailingOff: TrailingView = { ...trailingOn, enabled: false, entries: [] };

export { BTC, ETH };
