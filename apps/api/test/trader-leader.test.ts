import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DEFAULT_TRADER_GUARDRAILS, type Candle, type Instrument, type LeaderDecision, type Position, type TraderDossier } from '@pegasus/shared';
import { describe, expect, it } from 'vitest';
import type { TraderConfig } from '../src/config.js';
import type { TraderDossierSources } from '../src/services/trader-dossier.js';
import { LeaderTraderService, loadLeaderState } from '../src/services/trader-leader.js';
import type { LeaderModel } from '../src/services/trader-model.js';
import { loadTraderState } from '../src/services/trader-state.js';
import type { TraderServiceDeps } from '../src/services/trader.js';

const DAY = 24 * 3_600_000;
const inst = (instId: string, ctVal: string): Instrument => ({ instId, instType: 'SWAP', uly: instId.slice(0, -5), baseCcy: instId.split('-')[0] ?? '', quoteCcy: 'USDT', settleCcy: 'USDT', ctVal, ctValCcy: instId.split('-')[0] ?? '', ctMult: '1', ctType: 'linear', lotSz: '0.01', minSz: '0.01', tickSz: '0.1', maxLmtSz: '0', maxMktSz: '0', maxLever: '100', state: 'live' });
const INSTRUMENTS: Record<string, Instrument> = { 'BTC-USDT-SWAP': inst('BTC-USDT-SWAP', '0.01'), 'ETH-USDT-SWAP': inst('ETH-USDT-SWAP', '0.1') };
const MARKS: Record<string, string> = { 'BTC-USDT-SWAP': '76000', 'ETH-USDT-SWAP': '2240' };

/** Flat candles around the mark, the last one closing at `end`; every bar confirmed. */
function candles(instId: string, step: number, end: number, n = 30): Candle[] {
  const px = MARKS[instId] ?? '1';
  return Array.from({ length: n }, (_, i) => {
    const ts = end - (n - i) * step;
    return { ts, open: px, high: String(Number(px) * 1.01), low: String(Number(px) * 0.99), close: px, vol: '10', volCcy: '0', confirm: true };
  });
}

const usage = { inputTokens: 1, outputTokens: 1, cacheReadTokens: 0, ms: 1, model: 'fake' };
const answer = (action: LeaderDecision['action'], lotShare = 0.1): LeaderDecision => ({ action, lotShare, confidence: 0.6, reasons: ['r'], invalidation: 'i', oneLiner: 'o', recheckMinutes: 240, wakeAbove: null, wakeBelow: null });

interface World {
  positions: Position[];
  equity: string;
  now: number;
  placed: Array<Record<string, unknown>>;
  closed: string[];
  asked: TraderDossier[];
  script: Array<LeaderDecision['action'] | LeaderDecision>;
}

function build(dir: string): { service: LeaderTraderService; world: World; config: TraderConfig } {
  const world: World = { positions: [], equity: '1124', now: Date.UTC(2026, 10, 9, 0, 0, 10), placed: [], closed: [], asked: [], script: [] };
  const config: TraderConfig = { enabled: true, style: 'leader', instId: 'BTC-USDT-SWAP', guardrails: DEFAULT_TRADER_GUARDRAILS, model: 'fake', effort: 'high', cadence: 'model', news: false, control: false, calendar: [], stateFile: join(dir, 'trader-state.json'), logFile: join(dir, 'trader-log.jsonl') };
  const position = (instId: string, pos: string, avgPx: string): Position => ({ instId, posSide: 'net', mgnMode: 'cross', pos, avgPx, markPx: MARKS[instId] ?? '0', upl: '0', uplRatio: '0', lever: '10', liqPx: '', margin: '' }) as unknown as Position;
  const log = { info() {}, warn() {}, error() {}, child() { return log; } };
  const deps = {
    clients: {},
    market: { liveMarkPrice: (id: string) => MARKS[id], refPrice: (id: string) => MARKS[id], requireInstrument: (id: string) => INSTRUMENTS[id] },
    account: { get ready() { return true; }, get balance() { return { totalEq: world.equity }; }, positionList: () => world.positions, config: { posMode: 'net_mode' } },
    risk: { state: { killSwitch: false } },
    orders: {
      async place(req: Record<string, unknown> & { instId: string; side: string; size: { value: string } }) {
        world.placed.push(req);
        const held = world.positions.find((p) => p.instId === req.instId);
        const px = MARKS[req.instId] ?? '0';
        // net mode: a short is a negative position
        const sign = req.side === 'sell' ? -1 : 1;
        if (held) {
          const qty = Math.abs(Number(held.pos)) + Number(req.size.value);
          held.avgPx = String((Number(held.avgPx) * Math.abs(Number(held.pos)) + Number(px) * Number(req.size.value)) / qty);
          held.pos = String(sign * qty);
        } else world.positions.push(position(req.instId, String(sign * Number(req.size.value)), px));
        return { order: { avgPx: px } };
      },
      async closePosition(req: { instId: string }) {
        world.closed.push(req.instId);
        world.positions = world.positions.filter((p) => p.instId !== req.instId);
        return { instId: req.instId, posSide: 'net' };
      },
    },
    log,
  } as unknown as TraderServiceDeps;
  const sources: TraderDossierSources = {
    candles: async (instId, bar) => candles(instId, bar === '1W' ? 7 * DAY : bar === '1D' ? DAY : bar === '4H' ? 4 * 3_600_000 : bar === '1H' ? 3_600_000 : 900_000, Math.floor(world.now / 900_000) * 900_000),
    mark: (instId) => MARKS[instId] ?? null,
    funding: async () => ({ rate: '0.0001', mean72h: '0.0001' }),
    openInterest: async () => ({ oi: '1', change24hPct: '0' }),
  };
  const model: LeaderModel = {
    name: 'fake',
    async decide(dossier) {
      world.asked.push(dossier);
      const next = world.script.shift() ?? 'hold';
      return { decision: typeof next === 'string' ? answer(next) : next, usage, problem: null };
    },
  };
  const service = new LeaderTraderService(config, deps, { now: () => world.now, sleep: async () => {}, model, sources, checkEveryMs: 0, pollMs: 0, pollAttempts: 1 });
  return { service, world, config };
}

describe('the lead-trader style service', () => {
  it('asks each coin at the daily close, buys a lot where the model says buy, books a position gone as a result, and the liquidation stops it', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'pegasus-leader-'));
    const { service, world, config } = build(dir);
    world.script = ['hold', 'buy'];
    await service.start();
    expect(world.asked.map((d) => d.instId)).toEqual(['BTC-USDT-SWAP', 'ETH-USDT-SWAP']);
    const eth = world.asked[1] as TraderDossier;
    expect(eth.leader).toMatchObject({ coin: { instId: 'ETH-USDT-SWAP', side: null, lots: [] }, room: '3372', openRefused: null, startEquity: '1124', liquidationEquity: '0', exposure: '0' });
    expect(eth.triggers).toEqual(['daily close']);
    expect(world.placed).toHaveLength(1);
    expect(world.placed[0]).toMatchObject({ instId: 'ETH-USDT-SWAP', side: 'buy', ordType: 'market', tdMode: 'cross', size: { unit: 'contracts', value: '0.5' } });
    let state = service.stateCopy();
    expect(state.coins.find((c) => c.instId === 'ETH-USDT-SWAP')).toMatchObject({ side: 'long', lots: [{ contracts: '0.5', entryPx: '2240' }], lastCallAt: Date.UTC(2026, 10, 9) });
    expect(state.lotsToday).toBe(1);
    const view = service.view();
    expect(view).toMatchObject({ style: 'leader', status: 'holding', leader: { exposure: '112', coins: [{ instId: 'BTC-USDT-SWAP', lots: [] }, { instId: 'ETH-USDT-SWAP', side: 'long', contracts: '0.5', avgPx: '2240' }] } });
    expect(view.last?.verdict).toMatch(/^lot 1: 0.5 contracts bought at 2240/);
    // the wake is four hours away: the next close asks nothing
    world.now = Date.UTC(2026, 10, 9, 0, 15, 5);
    await service.tick();
    expect(world.asked).toHaveLength(2);
    // the position is closed by hand: the lots become a result at the next look, ended by an outside event
    world.positions = [];
    MARKS['ETH-USDT-SWAP'] = '2300';
    world.now = Date.UTC(2026, 10, 9, 0, 30, 5);
    await service.tick();
    state = service.stateCopy();
    expect(state.coins.find((c) => c.instId === 'ETH-USDT-SWAP')?.lots).toEqual([]);
    // 0.5 contracts of 0.1 ETH, 60 up: 3, less the taker fee on 112 + 115
    expect(state.recent[0]).toMatchObject({ instId: 'ETH-USDT-SWAP', side: 'long', entryPx: '2240', exitPx: '2300', contracts: '0.5', pnl: '2.8865', end: 'external' });
    // the liquidation: the equity at 0.5% of the 106.4 held closes everything and stops the trader; a 40% loss does not
    world.script = ['buy'];
    world.now = Date.UTC(2026, 10, 10, 0, 0, 5);
    await service.tick();
    expect(world.positions).toHaveLength(1);
    world.equity = '600';
    world.now = Date.UTC(2026, 10, 10, 0, 15, 5);
    await service.tick();
    expect(world.closed).toEqual([]);
    expect(service.view()).toMatchObject({ status: 'holding', leader: { liquidationEquity: '0.53', halted: null } });
    // between two closes too: the liquidation is looked at at every look
    world.equity = '0.5';
    world.now = Date.UTC(2026, 10, 10, 0, 16, 5);
    await service.tick();
    expect(world.closed).toEqual(['BTC-USDT-SWAP']);
    expect(service.view()).toMatchObject({ status: 'blocked', reason: { code: 'LIQUIDATED' } });
    world.now = Date.UTC(2026, 10, 10, 0, 30, 5);
    await service.tick();
    expect(service.stateCopy().recent[0]).toMatchObject({ instId: 'BTC-USDT-SWAP', end: 'liquidation' });
    const log = readFileSync(config.logFile, 'utf8').trim().split('\n').map((l) => JSON.parse(l) as { kind: string; lot?: { side: string; lots: number } });
    expect(log.filter((r) => r.kind === 'decision')).toHaveLength(4);
    expect(log.filter((r) => r.kind === 'execution').map((r) => r.lot)).toEqual([{ clOrdId: expect.any(String), side: 'buy', contracts: '0.5', px: '2240', lots: 1, notional: '112' }, { clOrdId: expect.any(String), side: 'buy', contracts: '0.14', px: '76000', lots: 1, notional: '106.4' }]);
    expect(log.filter((r) => r.kind === 'result')).toHaveLength(2);
    MARKS['ETH-USDT-SWAP'] = '2240';
  });

  it('asks a coin not yet asked today at the first close after a restart, drops a wake level the mark has passed, and leaves a coin with a foreign position alone without blocking the rest', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'pegasus-leader-'));
    const { service, world } = build(dir);
    // restarted at 00:20 UTC: the daily close was missed, both coins are asked at the first close
    world.now = Date.UTC(2026, 10, 9, 0, 20, 5);
    world.script = ['hold', { ...answer('hold'), wakeAbove: '2250', wakeBelow: '2300' }];
    await service.start();
    expect(world.asked.map((d) => [d.instId, d.triggers])).toEqual([['BTC-USDT-SWAP', ['first look of the day']], ['ETH-USDT-SWAP', ['first look of the day']]]);
    // the mark 2,240 is already under 2,300: that level is dropped, the one above stays
    expect(service.stateCopy().coins.find((c) => c.instId === 'ETH-USDT-SWAP')?.wake).toMatchObject({ above: '2250', below: null });
    world.now = Date.UTC(2026, 10, 9, 0, 35, 5);
    await service.tick();
    expect(world.asked).toHaveLength(2);
    MARKS['ETH-USDT-SWAP'] = '2260';
    world.now = Date.UTC(2026, 10, 9, 0, 50, 5);
    await service.tick();
    expect(world.asked.at(-1)).toMatchObject({ instId: 'ETH-USDT-SWAP', triggers: ['price reached 2250'] });
    MARKS['ETH-USDT-SWAP'] = '2240';
    // a BTC position opened by hand: that coin is skipped and said in the reason; the trader is not blocked
    world.positions.push({ instId: 'BTC-USDT-SWAP', posSide: 'net', mgnMode: 'cross', pos: '1', avgPx: '76000', markPx: '76000', upl: '0' } as unknown as Position);
    world.script = ['buy'];
    world.now = Date.UTC(2026, 10, 10, 0, 0, 5);
    await service.tick();
    expect(world.asked.slice(3).map((d) => d.instId)).toEqual(['ETH-USDT-SWAP']);
    const view = service.view();
    expect(view).toMatchObject({ status: 'holding', reason: { code: 'FOREIGN_POSITION' } });
    expect(view.nextCallAt).not.toBeNull();
    expect(view.today.equityAtStart).toBe('1124');
    // the liquidation (0.5% of the 760 + 112 at the marks) leaves the foreign position alone
    world.equity = '4';
    world.now = Date.UTC(2026, 10, 10, 0, 15, 5);
    await service.tick();
    expect(world.closed).toEqual(['ETH-USDT-SWAP']);
  });

  it('opens a short of the size the model names, refuses the other side while it is held, and closes it at a loss when the model says close', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'pegasus-leader-'));
    const { service, world } = build(dir);
    // 1.5 times the equity short on BTC: 1,686 USDT at 76,000 = 2.21 contracts of 0.01 BTC
    world.script = [answer('short', 1.5), 'hold'];
    await service.start();
    expect(world.placed).toEqual([expect.objectContaining({ instId: 'BTC-USDT-SWAP', side: 'sell', ordType: 'market', tdMode: 'cross', size: { unit: 'contracts', value: '2.21' } })]);
    expect(service.stateCopy().coins[0]).toMatchObject({ side: 'short', lots: [{ contracts: '2.21', entryPx: '76000' }] });
    expect(service.view().last?.verdict).toBe('hold');
    // the recheck four hours later: a buy against the short lots is refused, and the dossier shows the side and the room left
    world.script = ['buy', 'hold'];
    world.now = Date.UTC(2026, 10, 9, 4, 0, 5);
    await service.tick();
    expect(world.asked[2]?.leader).toMatchObject({ coin: { side: 'short', contracts: '2.21' }, exposure: '1679.6', room: '1692.4', liquidationEquity: '8.4' });
    expect(service.stateCopy().coins[0]?.recentDecisions[0]).toMatchObject({ action: 'buy', verdict: expect.stringContaining('close them before opening a long lot') });
    expect(world.placed).toHaveLength(1);
    // the mark goes 1,000 against the short; the model closes at a loss
    MARKS['BTC-USDT-SWAP'] = '77000';
    world.script = ['close', 'hold'];
    world.now = Date.UTC(2026, 10, 9, 8, 0, 5);
    await service.tick();
    expect(world.closed).toEqual(['BTC-USDT-SWAP']);
    expect(service.stateCopy().coins[0]?.recentDecisions[0]).toMatchObject({ action: 'close', verdict: '1 lots, 2.21 contracts short, closed at the market (mark 77000)' });
    world.now = Date.UTC(2026, 10, 9, 8, 15, 5);
    await service.tick();
    // 2.21 contracts of 0.01 BTC, 1,000 against: -22.1, less the taker fee on 1,679.6 + 1,701.7
    expect(service.stateCopy().recent[0]).toMatchObject({ instId: 'BTC-USDT-SWAP', side: 'short', entryPx: '76000', exitPx: '77000', contracts: '2.21', pnl: '-23.79065', end: 'close' });
    expect(service.stateCopy().coins[0]).toMatchObject({ lots: [] });
    expect(service.stateCopy().coins[0]?.side).toBeUndefined();
    MARKS['BTC-USDT-SWAP'] = '76000';
  });

  it('moves a flat state of the stops style aside, blocks on one holding a position, and reads its own', () => {
    const dir = mkdtempSync(join(tmpdir(), 'pegasus-leader-'));
    const file = join(dir, 'trader-state.json');
    expect(loadLeaderState(file, 0)).toMatchObject({ ok: true, state: { version: 2, style: 'leader', coins: [{ instId: 'BTC-USDT-SWAP' }, { instId: 'ETH-USDT-SWAP' }] } });
    writeFileSync(file, JSON.stringify({ version: 1, position: null, pendingLimit: null, date: '2026-11-08' }));
    const moved = loadLeaderState(file, 0);
    expect(moved).toMatchObject({ ok: true, note: expect.stringContaining('.stops-v1') });
    expect(JSON.parse(readFileSync(`${file}.stops-v1`, 'utf8'))).toMatchObject({ version: 1 });
    writeFileSync(file, JSON.stringify({ version: 1, position: { side: 'short' }, pendingLimit: null }));
    expect(loadLeaderState(file, 0)).toMatchObject({ ok: false, error: expect.stringContaining('holds a position') });
    writeFileSync(file, JSON.stringify({ version: 2, style: 'leader', startedAt: 0, startEquity: '1124', halted: null, lastBarTs: null, date: '2026-11-09', lotsToday: 0, pnlToday: '0', coins: [{ instId: 'BTC-USDT-SWAP', lots: [], wake: null, lastCallAt: null, recentDecisions: [], closing: null }], recent: [], usage: { date: '2026-11-09', calls: 0, inputTokens: 0, outputTokens: 0, cacheReadTokens: 0 } }));
    const own = loadLeaderState(file, 0);
    expect(own.ok && own.state.coins.map((c) => c.instId)).toEqual(['BTC-USDT-SWAP', 'ETH-USDT-SWAP']);
    writeFileSync(file, '{"version": 3}');
    expect(loadLeaderState(file, 0)).toMatchObject({ ok: false, error: expect.stringContaining('.corrupt') });
    // and the other way: the stops style moves a flat leader file aside, and refuses one holding lots
    const flat = { version: 2, style: 'leader', coins: [{ instId: 'BTC-USDT-SWAP', lots: [] }] };
    writeFileSync(file, JSON.stringify(flat));
    expect(loadTraderState(file, 0)).toMatchObject({ ok: true, note: expect.stringContaining('.leader-v2') });
    expect(JSON.parse(readFileSync(`${file}.leader-v2`, 'utf8'))).toEqual(flat);
    writeFileSync(file, JSON.stringify({ ...flat, coins: [{ instId: 'BTC-USDT-SWAP', lots: [{ contracts: '1' }] }] }));
    expect(loadTraderState(file, 0)).toMatchObject({ ok: false, error: expect.stringContaining('holds lots') });
  });
});
