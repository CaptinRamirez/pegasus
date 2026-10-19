import type { TraderDecision, TraderGuardrails, TraderLogRecord, TraderView } from '@pegasus/shared';
import { NOW } from './campaign-fixtures';

/** Test data of the TRADER tab: views of GET /api/trader and records of GET /api/trader/log. Only tests import this file. */

export const guardrails: TraderGuardrails = {
  riskPct: '0.02',
  maxTradesPerDay: 3,
  dailyLossPct: '0.06',
  maxConsecutiveLosses: 3,
  cooldownMs: 86_400_000,
  sessionStartHour: 13,
  sessionEndHour: 21,
  minStopPct: '0.0015',
  maxStopPct: '0.015',
  maxLeverage: '10',
  maxLimitDistancePct: '0.02',
};

export const decision: TraderDecision = {
  action: 'long',
  entryType: 'market',
  limitPrice: null,
  stopPx: '81500',
  targetPx: '83500',
  confidence: 0.65,
  reasons: ['EMA 5 > 10 > 21 on 1H', 'Price holds above the VWAP'],
  invalidation: 'A 1H close below 81,500',
  oneLiner: 'Long the retest of the VWAP',
  recheckMinutes: 60,
  wakeAbove: '83000',
  wakeBelow: '81200',
};

export const flatDecision: TraderDecision = {
  ...decision,
  action: 'flat',
  stopPx: null,
  targetPx: null,
  reasons: ['Volume is thin before the release'],
  invalidation: 'A break of 83,000 on volume',
  oneLiner: 'Waiting for the CPI print',
  recheckMinutes: 45,
};

export const enabledView: TraderView = {
  enabled: true,
  cadence: 'model',
  wake: { at: NOW + 30 * 60_000, above: '83000', below: '81200', setAt: NOW - 30 * 60_000 },
  upcoming: [
    { time: NOW + 90 * 60_000, title: 'CPI m/m', country: 'USD', impact: 'High', forecast: '0.3%', previous: '0.2%', minutesFromNow: 90 },
    { time: NOW + 300 * 60_000, title: 'Crude Oil Inventories', country: 'USD', impact: 'Medium', forecast: '', previous: '1.2M', minutesFromNow: 300 },
  ],
  status: 'holding',
  reason: null,
  instId: 'BTC-USDT-SWAP',
  session: { startHour: 13, endHour: 21, inSession: true },
  guardrails,
  model: 'claude-sonnet-5-5',
  nextCallAt: NOW + 30 * 60_000,
  last: {
    ts: NOW - 30 * 60_000,
    decision,
    verdict: 'ok',
    executed: true,
    usage: { inputTokens: 9100, outputTokens: 420, cacheReadTokens: 0, ms: 5300, model: 'claude-sonnet-5-5' },
    triggers: ['hourly close', 'VWAP retest'],
    error: null,
  },
  position: { side: 'long', contracts: '12', entryPx: '82000', stopPx: '81500', targetPx: '83500', openedAt: NOW - 25 * 60_000, clOrdId: 'pt1', equityAtEntry: '1000', unrealizedPnl: '4.5' },
  today: { date: '2026-10-05', trades: 1, pnl: '0', consecutiveLosses: 0, cooldownUntil: null, equityAtStart: '1000' },
  usageToday: { calls: 3, inputTokens: 27000, outputTokens: 1200, estimatedUsd: '0.0660' },
  control: { position: null, trades: 4, pnlTotal: '-12.5', wins: 1, losses: 3 },
  recent: [{ side: 'short', openedAt: NOW - 86_400_000, closedAt: NOW - 80_000_000, entryPx: '82500', exitPx: '82900', contracts: '10', pnl: '-20', end: 'stop' }],
  serverTime: NOW,
};

export const disabledTraderView: TraderView = {
  ...enabledView,
  enabled: false,
  status: 'disabled',
  nextCallAt: null,
  last: null,
  position: null,
  control: null,
  recent: [],
};

export const traderLog: TraderLogRecord[] = [
  { ts: NOW - 30 * 60_000, kind: 'decision', instId: 'BTC-USDT-SWAP', decision: flatDecision, verdict: 'flat', triggers: ['hourly close'] },
  { ts: NOW - 90 * 60_000, kind: 'error', instId: 'BTC-USDT-SWAP', error: 'model timed out' },
];
