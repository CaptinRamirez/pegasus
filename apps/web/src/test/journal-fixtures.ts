import type { JournalPage, JournalTrade, JournalTradeSummary } from '@pegasus/shared';
import { NOW } from './campaign-fixtures';
import { btcSignal } from './signals-fixtures';

/**
 * Test data of the JOURNAL tab: GET /api/journal with open and closed trades of every source, and GET /api/journal/:id
 * of a closed trade with its fills and a timeline. Only tests and the screenshot harness import this file.
 */

const H = 3_600_000;
const T0 = Date.UTC(2026, 9, 1, 8, 15);

const base = {
  mgnMode: 'isolated',
  posSide: 'net',
  direction: 'long',
  ccy: 'USDT',
  funding: null,
  adopted: false,
} satisfies Partial<JournalTradeSummary>;

/** Opened from the SIGNALS tab this morning: stop at the exit line, channel trailing, no take-profit. */
export const openSignalTrade: JournalTradeSummary = {
  ...base,
  id: '12-BTC-USDT-SWAP',
  seq: 12,
  instId: 'BTC-USDT-SWAP',
  source: 'signal',
  status: 'open',
  openedAt: Date.UTC(2026, 9, 5, 0, 1, 12),
  closedAt: null,
  durationMs: null,
  updatedAt: NOW - 60_000,
  entry: { avgPx: '64185.2', contracts: '4', coin: '0.04', notional: '2567.41', maxContracts: '4', leverage: '10', mgnMode: 'isolated', margin: '256.74' },
  size: '4',
  exitPx: null,
  plan: { slTriggerPx: '58900', takeProfits: [], breakevenAfterTp1: false, trailing: { kind: 'channel', bars: 10 }, signal: btcSignal },
  initialStop: '58900',
  initialRisk: '211.41',
  fees: '1.2837',
  funding: '-0.42',
  realisedPnl: '0',
  netPnl: '-1.7037',
  rMultiple: null,
  exits: [],
  closeReason: null,
};

/** Opened from the ticket with a ladder of take-profits and the cost-price stop; closed by the second take-profit. */
export const closedManualTrade: JournalTradeSummary = {
  ...base,
  id: '11-ETH-USDT-SWAP',
  seq: 11,
  instId: 'ETH-USDT-SWAP',
  source: 'manual',
  status: 'closed',
  openedAt: T0,
  closedAt: T0 + 31 * H,
  durationMs: 31 * H,
  updatedAt: T0 + 31 * H,
  entry: { avgPx: '3012.4', contracts: '10', coin: '1', notional: '3012.4', maxContracts: '10', leverage: '5', mgnMode: 'isolated', margin: '602.48' },
  size: '0',
  exitPx: '3196.2',
  plan: {
    slTriggerPx: '2950',
    takeProfits: [
      { triggerPx: '3150', fraction: '0.5' },
      { triggerPx: '3240', fraction: '0.5' },
    ],
    breakevenAfterTp1: true,
    trailing: null,
    signal: null,
  },
  initialStop: '2950',
  initialRisk: '62.4',
  fees: '3.1046',
  realisedPnl: '183.8',
  netPnl: '180.6954',
  rMultiple: '2.8957',
  exits: [
    { ts: T0 + 9 * H, reason: 'take_profit', leg: 1, ordId: 'o-tp1', clOrdId: '', algoId: 'tp1a', px: '3151.2', contracts: '5', coin: '0.5', pnl: '69.4', fee: '0.7878' },
    { ts: T0 + 31 * H, reason: 'take_profit', leg: 2, ordId: 'o-tp2', clOrdId: '', algoId: 'tp2a', px: '3241.2', contracts: '5', coin: '0.5', pnl: '114.4', fee: '0.8103' },
  ],
  closeReason: 'take_profit',
};

/** The campaign pot's own trade, stopped out. */
export const closedCampaignTrade: JournalTradeSummary = {
  ...base,
  id: '10-LINK-USDT-SWAP',
  seq: 10,
  instId: 'LINK-USDT-SWAP',
  source: 'campaign',
  status: 'closed',
  openedAt: T0 - 50 * H,
  closedAt: T0 - 2 * H,
  durationMs: 48 * H,
  updatedAt: T0 - 2 * H,
  entry: { avgPx: '15.212', contracts: '18', coin: '18', notional: '273.82', maxContracts: '18', leverage: '10', mgnMode: 'isolated', margin: '27.38' },
  size: '0',
  exitPx: '14.38',
  plan: null,
  initialStop: null,
  initialRisk: null,
  fees: '0.2799',
  realisedPnl: '-14.976',
  netPnl: '-15.2559',
  rMultiple: null,
  exits: [{ ts: T0 - 2 * H, reason: 'campaign', leg: null, ordId: 'o-c', clOrdId: 'pc1', algoId: null, px: '14.38', contracts: '18', coin: '18', pnl: '-14.976', fee: '0.1294' }],
  closeReason: 'campaign',
};

/** Found open, placed outside Pegasus. */
export const adoptedTrade: JournalTradeSummary = {
  ...base,
  id: '9-XRP-USDT-SWAP',
  seq: 9,
  instId: 'XRP-USDT-SWAP',
  source: 'external',
  status: 'open',
  openedAt: T0 - 80 * H,
  closedAt: null,
  durationMs: null,
  updatedAt: T0 - 3 * H,
  entry: { avgPx: '0.622', contracts: '30', coin: '3000', notional: '1866', maxContracts: '30', leverage: null, mgnMode: 'isolated', margin: null },
  size: '30',
  exitPx: null,
  plan: null,
  initialStop: null,
  initialRisk: null,
  fees: '0',
  realisedPnl: '0',
  netPnl: '0',
  rMultiple: null,
  exits: [],
  closeReason: null,
  adopted: true,
};

export const journalPage: JournalPage = {
  status: 'ready',
  reason: null,
  trades: [openSignalTrade, closedManualTrade, closedCampaignTrade, adoptedTrade],
  total: 4,
  next: null,
  serverTime: NOW,
};

export const closedManualDetail: JournalTrade = {
  ...closedManualTrade,
  fills: [
    { ts: T0, ordId: 'o-open', clOrdId: 'pgwabc', tradeId: 't1', side: 'buy', role: 'open', px: '3012.4', contracts: '10', coin: '1', fee: '-1.5062', pnl: '0', posAfter: '10' },
    { ts: T0 + 9 * H, ordId: 'o-tp1', clOrdId: '', tradeId: 't2', side: 'sell', role: 'reduce', px: '3151.2', contracts: '5', coin: '0.5', fee: '-0.7878', pnl: '69.4', posAfter: '5' },
    { ts: T0 + 31 * H, ordId: 'o-tp2', clOrdId: '', tradeId: 't3', side: 'sell', role: 'close', px: '3241.2', contracts: '5', coin: '0.5', fee: '-0.8103', pnl: '114.4', posAfter: '0' },
  ],
  timeline: [
    { ts: T0 - 2_000, kind: 'order_placed', ordId: 'o-open', clOrdId: 'pgwabc', side: 'buy', ordType: 'market', contracts: '10', source: 'manual', ...(closedManualTrade.plan === null ? {} : { plan: closedManualTrade.plan }) },
    { ts: T0, kind: 'fill', ordId: 'o-open', side: 'buy', role: 'open', px: '3012.4', contracts: '10', fee: '-1.5062' },
    { ts: T0 + 20_000, kind: 'stop_placed', algoId: 'sl1', px: '2950', contracts: '10' },
    { ts: T0 + 20_000, kind: 'tp_placed', algoId: 'tp1a', px: '3150', leg: 1, contracts: '5' },
    { ts: T0 + 20_000, kind: 'tp_placed', algoId: 'tp2a', px: '3240', leg: 2, contracts: '5' },
    { ts: T0 + 9 * H, kind: 'tp_triggered', algoId: 'tp1a', px: '3150', leg: 1 },
    { ts: T0 + 9 * H, kind: 'fill', ordId: 'o-tp1', side: 'sell', role: 'reduce', px: '3151.2', contracts: '5', fee: '-0.7878', pnl: '69.4', reason: 'take_profit', leg: 1 },
    { ts: T0 + 9 * H + 30_000, kind: 'stop_moved', algoId: 'sl1', fromPx: '2950', px: '3012.4' },
    { ts: T0 + 31 * H, kind: 'tp_triggered', algoId: 'tp2a', px: '3240', leg: 2 },
    { ts: T0 + 31 * H, kind: 'fill', ordId: 'o-tp2', side: 'sell', role: 'close', px: '3241.2', contracts: '5', fee: '-0.8103', pnl: '114.4', reason: 'take_profit', leg: 2 },
    { ts: T0 + 31 * H + 5_000, kind: 'stop_cancelled', algoId: 'sl1', px: '3012.4', code: 'POSITION_CLOSED' },
  ],
};

export const openSignalDetail: JournalTrade = {
  ...openSignalTrade,
  fills: [{ ts: openSignalTrade.openedAt, ordId: 'o-sig', clOrdId: 'pswxyz', tradeId: 't9', side: 'buy', role: 'open', px: '64185.2', contracts: '4', coin: '0.04', fee: '-1.2837', pnl: '0', posAfter: '4' }],
  timeline: [
    { ts: openSignalTrade.openedAt - 1_000, kind: 'order_placed', ordId: 'o-sig', clOrdId: 'pswxyz', side: 'buy', ordType: 'market', contracts: '4', source: 'signal', ...(openSignalTrade.plan === null ? {} : { plan: openSignalTrade.plan }) },
    { ts: openSignalTrade.openedAt, kind: 'fill', ordId: 'o-sig', side: 'buy', role: 'open', px: '64185.2', contracts: '4', fee: '-1.2837' },
    { ts: openSignalTrade.openedAt + 15_000, kind: 'stop_placed', algoId: 'sl9', px: '58900', contracts: '4' },
    { ts: openSignalTrade.openedAt + 16_000, kind: 'trailing_placed', algoId: 'ch9', px: '58900', contracts: '4' },
  ],
};
