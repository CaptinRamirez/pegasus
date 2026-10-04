import { EventEmitter } from 'node:events';
import { describe, expect, it } from 'vitest';
import { OkxApiError, OkxTransportError } from '@pegasus/okx';
import type { AccountConfig, RiskConfig } from '@pegasus/shared';
import { pino } from 'pino';
import { MemoryStore } from '../src/db/store.js';
import { AppError } from '../src/errors.js';
import { KillSwitchSweeper, type SetTimer, type SweepAccount, type SweepOrders } from '../src/services/kill-switch-sweeper.js';
import { RiskEngine } from '../src/services/risk-engine.js';

const log = pino({ level: 'silent' });

const config: RiskConfig = {
  maxOrderNotional: '5000',
  maxPositionNotionalPerInstrument: '20000',
  maxTotalPositionNotional: '30000',
  maxLeverage: '10',
  dailyLossLimit: '1000',
  maxOpenOrders: 3,
  priceBandPct: '0.05',
  maxSlippagePct: '0.005',
};

/** The account mirror: it only learns about the exchange's open orders through refresh(). */
class FakeAccount extends EventEmitter<{ config: [AccountConfig] }> implements SweepAccount {
  enabled = true;
  config: AccountConfig | null = { posMode: 'long_short_mode', acctLv: '2', canTrade: true };
  readonly openOrders = new Map<string, unknown>();
  refreshes = 0;
  refreshError: Error | null = null;
  /** When set, refresh() waits for it: a REST round trip still in flight. */
  gate: Promise<void> | null = null;

  constructor(private readonly exchange: Set<string>) {
    super();
  }

  async refresh(): Promise<void> {
    this.refreshes++;
    if (this.gate) await this.gate;
    if (this.refreshError) throw this.refreshError;
    this.openOrders.clear();
    for (const ordId of this.exchange) this.openOrders.set(ordId, { ordId });
  }
}

function setup(opts: { open?: string[]; killSwitchOn?: boolean; store?: MemoryStore } = {}) {
  const exchange = new Set(opts.open ?? []);
  const account = new FakeAccount(exchange);
  let now = Date.UTC(2026, 0, 1, 12);
  const risk = new RiskEngine(config, opts.store ?? new MemoryStore(), log, () => now);
  if (opts.killSwitchOn) risk.state.killSwitch = true;
  const cancel = {
    calls: 0,
    /** Orders the exchange refuses to cancel (reported per item, the request itself succeeds). */
    stuck: new Set<string>(),
    error: null as Error | null,
  };
  const orders: SweepOrders = {
    cancelAll: async () => {
      cancel.calls++;
      if (cancel.error) throw cancel.error;
      let n = 0;
      for (const ordId of account.openOrders.keys()) {
        if (cancel.stuck.has(ordId)) continue;
        if (exchange.delete(ordId)) n++;
      }
      return n;
    },
  };
  const timers: Array<{ fn: () => void; ms: number; cancelled: boolean }> = [];
  const setTimer: SetTimer = (fn, ms) => {
    const timer = { fn, ms, cancelled: false };
    timers.push(timer);
    return () => {
      timer.cancelled = true;
    };
  };
  const settle = () => new Promise<void>((resolve) => setImmediate(resolve));
  /** Run the next retry timer unless it was cancelled; returns its delay. */
  const fire = async (): Promise<number> => {
    const timer = timers.shift();
    if (!timer) throw new Error('no timer scheduled');
    if (!timer.cancelled) timer.fn();
    await settle();
    return timer.ms;
  };
  const sweeper = new KillSwitchSweeper(risk, account, orders, log, setTimer);
  return { exchange, account, risk, cancel, timers, settle, fire, sweeper, setNow: (t: number) => (now = t), sweep: () => risk.state.cancelSweep };
}

describe('KillSwitchSweeper', () => {
  it('cancels the open orders when the switch goes on and reports done', async () => {
    const t = setup({ open: ['a', 'b'] });
    t.sweeper.start();
    expect(t.sweep().state).toBe('idle');
    expect(t.account.refreshes).toBe(0);

    const returned = t.risk.setKillSwitch(true, 'test');
    expect(returned.cancelSweep).toMatchObject({ state: 'pending', message: 'cancelling open orders' });
    await t.settle();
    expect([...t.exchange]).toEqual([]);
    expect(t.cancel.calls).toBe(1);
    expect(t.sweep()).toMatchObject({ state: 'done', message: 'open orders cancelled' });
    expect(t.timers).toHaveLength(0);

    t.risk.setKillSwitch(false, '');
    expect(t.sweep()).toMatchObject({ state: 'idle', message: '' });
  });

  it('says so when there was nothing to cancel, without a cancel request', async () => {
    const t = setup();
    t.sweeper.start();
    t.risk.setKillSwitch(true, 'test');
    await t.settle();
    expect(t.sweep()).toMatchObject({ state: 'done', message: 'no open orders to cancel' });
    expect(t.cancel.calls).toBe(0);
  });

  it('sweeps at start-up when the restored switch is on', async () => {
    const t = setup({ open: ['a'], killSwitchOn: true });
    t.sweeper.start();
    await t.settle();
    expect([...t.exchange]).toEqual([]);
    expect(t.sweep().state).toBe('done');
  });

  it('cancels an order created during an outage: the list is refreshed before cancelling', async () => {
    const t = setup({ open: ['placed-on-okx'] });
    t.sweeper.start();
    expect(t.account.openOrders.size).toBe(0); // the mirror never heard of it
    t.risk.setKillSwitch(true, 'test');
    await t.settle();
    expect([...t.exchange]).toEqual([]);
    expect(t.sweep().state).toBe('done');
  });

  it('cancels nothing when the switch is released before the exchange can be reached again', async () => {
    const t = setup({ open: ['a'] });
    t.sweeper.start();
    t.account.refreshError = new OkxTransportError('/api/v5/account/config', 'could not reach OKX (ENOTFOUND)', false);
    t.risk.setKillSwitch(true, 'test');
    await t.settle();
    expect(t.sweep()).toMatchObject({ state: 'pending', message: 'cancel failed: could not reach OKX (ENOTFOUND), retrying in 5 s' });

    t.risk.setKillSwitch(false, '');
    expect(t.sweep().state).toBe('idle');
    t.account.refreshError = null;
    const refreshes = t.account.refreshes;
    await t.fire(); // the retry that was scheduled while the switch was on
    expect(t.account.refreshes).toBe(refreshes);
    expect(t.cancel.calls).toBe(0);
    expect([...t.exchange]).toEqual(['a']);
    expect(t.timers).toHaveLength(0);
  });

  it('cancels nothing when the daily-loss halt is lifted at 00:00 UTC while a retry is pending', async () => {
    const t = setup({ open: ['a'] });
    t.sweeper.start();
    t.account.refreshError = new Error('boom');
    t.risk.updateEquity('10000');
    t.risk.updateEquity('8000');
    expect(t.risk.state.killSwitchReason).toMatch(/DAILY_LOSS_LIMIT/);
    await t.settle();
    expect(t.sweep().state).toBe('pending');

    t.setNow(Date.UTC(2026, 0, 2, 0, 0, 1));
    t.risk.updateEquity('8000');
    expect(t.risk.state.killSwitch).toBe(false);
    expect(t.sweep().state).toBe('idle');
    t.account.refreshError = null;
    await t.fire();
    expect(t.cancel.calls).toBe(0);
    expect([...t.exchange]).toEqual(['a']);
  });

  it('stops a sweep in flight when the switch is released: no cancel is sent afterwards', async () => {
    const t = setup({ open: ['a'] });
    t.sweeper.start();
    let open = (): void => undefined;
    t.account.gate = new Promise<void>((resolve) => (open = resolve));
    t.risk.setKillSwitch(true, 'test');
    await t.settle();
    expect(t.account.refreshes).toBe(1);

    t.risk.setKillSwitch(false, '');
    open();
    await t.settle();
    expect(t.cancel.calls).toBe(0);
    expect([...t.exchange]).toEqual(['a']);
    expect(t.sweep().state).toBe('idle');
  });

  it('released and engaged again during a sweep: the new engagement gets its own sweep', async () => {
    const t = setup({ open: ['a'] });
    t.sweeper.start();
    let open = (): void => undefined;
    t.account.gate = new Promise<void>((resolve) => (open = resolve));
    t.risk.setKillSwitch(true, 'first');
    await t.settle();
    t.risk.setKillSwitch(false, '');
    t.risk.setKillSwitch(true, 'second');
    t.account.gate = null;
    open();
    await t.settle();
    expect([...t.exchange]).toEqual([]);
    expect(t.cancel.calls).toBe(1);
    expect(t.sweep().state).toBe('done');
  });

  it('stays armed while an order is still open and retries with a backoff from 5 s to 60 s', async () => {
    const t = setup({ open: ['a', 'b', 'c'] });
    t.sweeper.start();
    t.cancel.stuck.add('b');
    t.risk.setKillSwitch(true, 'test');
    await t.settle();
    // the request succeeded and two orders went, but one is still open: not done
    expect([...t.exchange]).toEqual(['b']);
    expect(t.sweep()).toMatchObject({ state: 'pending', message: 'cancel failed: 1 of 3 orders still open, retrying in 5 s' });

    const delays: number[] = [];
    for (let i = 0; i < 6; i++) delays.push(await t.fire());
    expect(delays).toEqual([5_000, 10_000, 20_000, 40_000, 60_000, 60_000]);
    expect(t.cancel.calls).toBe(7);
    expect(t.sweep()).toMatchObject({ state: 'pending', message: 'cancel failed: 1 of 1 orders still open, retrying in 60 s' });
    expect(t.timers).toHaveLength(1);

    t.cancel.stuck.clear();
    await t.fire();
    expect([...t.exchange]).toEqual([]);
    expect(t.sweep()).toMatchObject({ state: 'done', message: 'open orders cancelled' });
    expect(t.timers).toHaveLength(0);
  });

  it('retries a failing request and starts the backoff again for the next engagement', async () => {
    const t = setup({ open: ['a'] });
    t.sweeper.start();
    t.cancel.error = new AppError('EXCHANGE', 'Requests too frequent.', 429, { okxCode: '50011', okxMsg: 'Requests too frequent.' });
    t.risk.setKillSwitch(true, 'test');
    await t.settle();
    expect(t.sweep()).toMatchObject({ state: 'pending', message: 'cancel failed: [50011] Requests too frequent., retrying in 5 s' });
    expect(await t.fire()).toBe(5_000);
    expect(t.timers.map((x) => x.ms)).toEqual([10_000]);

    t.risk.setKillSwitch(false, '');
    t.risk.setKillSwitch(true, 'again');
    await t.settle();
    expect(t.timers.filter((x) => !x.cancelled).map((x) => x.ms)).toEqual([5_000]);
  });

  it('gives up and reports failed on a permission or authentication error', async () => {
    const denied = setup({ open: ['a'] });
    denied.sweeper.start();
    denied.cancel.error = new AppError('EXCHANGE', "This API key doesn't have permission to use this function", 502, { okxCode: '50120' });
    denied.risk.setKillSwitch(true, 'test');
    await denied.settle();
    expect(denied.sweep()).toMatchObject({ state: 'failed', message: "cancel failed: [50120] This API key doesn't have permission to use this function" });
    expect(denied.cancel.calls).toBe(1);
    expect(denied.timers).toHaveLength(0);
    expect([...denied.exchange]).toEqual(['a']);

    const rejected = setup({ open: ['a'] });
    rejected.sweeper.start();
    rejected.account.refreshError = new OkxApiError('50111', 'Invalid OK-ACCESS-KEY', '/api/v5/account/config');
    rejected.risk.setKillSwitch(true, 'test');
    await rejected.settle();
    expect(rejected.sweep()).toMatchObject({ state: 'failed', message: 'cancel failed: [50111] Invalid OK-ACCESS-KEY' });
    expect(rejected.cancel.calls).toBe(0);
    expect(rejected.timers).toHaveLength(0);

    // a new engagement tries again
    rejected.account.refreshError = null;
    rejected.risk.setKillSwitch(false, '');
    rejected.risk.setKillSwitch(true, 'again');
    await rejected.settle();
    expect(rejected.sweep().state).toBe('done');
  });

  it('is skipped with a read-only key without a single request, and runs once the key can trade', async () => {
    const t = setup({ open: ['a'] });
    t.account.config = { posMode: 'long_short_mode', acctLv: '2', canTrade: false };
    t.sweeper.start();
    t.risk.setKillSwitch(true, 'test');
    await t.settle();
    expect(t.sweep()).toMatchObject({ state: 'skipped', message: 'skipped: read-only key' });
    expect(t.account.refreshes).toBe(0);
    expect(t.cancel.calls).toBe(0);
    expect(t.timers).toHaveLength(0);

    t.account.config = { posMode: 'long_short_mode', acctLv: '2', canTrade: true };
    t.account.emit('config', t.account.config);
    await t.settle();
    expect([...t.exchange]).toEqual([]);
    expect(t.sweep().state).toBe('done');
  });

  it('is skipped without an API key', async () => {
    const t = setup();
    t.account.enabled = false;
    t.account.config = null;
    t.sweeper.start();
    t.risk.setKillSwitch(true, 'test');
    await t.settle();
    expect(t.sweep()).toMatchObject({ state: 'skipped', message: 'skipped: no API key configured' });
    expect(t.account.refreshes).toBe(0);
  });
});

describe('KillSwitchSweeper after a restart with the halt restored', () => {
  /** A fresh process over the same saved settings: a new engine, account mirror and sweeper. */
  async function restart(store: MemoryStore, open: string[]) {
    const t = setup({ open, store });
    await t.risk.init();
    t.sweeper.start();
    await t.settle();
    return t;
  }

  it('does not sweep again once the sweep completed: an exit placed since the halt is left alone', async () => {
    const store = new MemoryStore();
    const first = await restart(store, ['a']);
    first.risk.setKillSwitch(true, 'manual (terminal)');
    await first.settle();
    expect(first.sweep().state).toBe('done');

    const second = await restart(store, ['take-profit']);
    expect(second.risk.state.killSwitch).toBe(true);
    expect(second.account.refreshes).toBe(0);
    expect(second.cancel.calls).toBe(0);
    expect([...second.exchange]).toEqual(['take-profit']);
    expect(second.sweep()).toMatchObject({ state: 'done', message: 'open orders cancelled before the restart' });
    expect(second.timers).toHaveLength(0);

    // released and engaged again: a new engagement, so it sweeps
    second.risk.setKillSwitch(false, '');
    expect(second.sweep().state).toBe('idle');
    second.risk.setKillSwitch(true, 'again');
    await second.settle();
    expect([...second.exchange]).toEqual([]);
    expect(second.cancel.calls).toBe(1);
    expect(second.sweep()).toMatchObject({ state: 'done', message: 'open orders cancelled' });
  });

  it('sweeps when the sweep before the restart was still pending', async () => {
    const store = new MemoryStore();
    const first = await restart(store, ['a']);
    first.account.refreshError = new OkxTransportError('/api/v5/account/config', 'could not reach OKX (ENOTFOUND)', false);
    first.risk.setKillSwitch(true, 'test');
    await first.settle();
    expect(first.sweep().state).toBe('pending');

    const second = await restart(store, ['a']);
    expect([...second.exchange]).toEqual([]);
    expect(second.sweep().state).toBe('done');
  });

  it('sweeps when the sweep before the restart had failed', async () => {
    const store = new MemoryStore();
    const first = await restart(store, ['a']);
    first.cancel.error = new AppError('EXCHANGE', 'no permission', 502, { okxCode: '50120' });
    first.risk.setKillSwitch(true, 'test');
    await first.settle();
    expect(first.sweep().state).toBe('failed');

    const second = await restart(store, ['a']);
    expect([...second.exchange]).toEqual([]);
    expect(second.sweep().state).toBe('done');
  });

  it('sweeps when the sweep before the restart was skipped under a read-only key', async () => {
    const store = new MemoryStore();
    const first = setup({ open: ['a'], store });
    first.account.config = { posMode: 'long_short_mode', acctLv: '2', canTrade: false };
    first.sweeper.start();
    first.risk.setKillSwitch(true, 'test');
    await first.settle();
    expect(first.sweep().state).toBe('skipped');

    const second = await restart(store, ['a']);
    expect([...second.exchange]).toEqual([]);
    expect(second.sweep().state).toBe('done');
  });

  it('sweeps for a halt saved before the completed sweep was recorded', async () => {
    const store = new MemoryStore();
    await store.setSetting('risk.state', { killSwitch: true, killSwitchReason: 'manual (terminal)', dayStartTs: Date.UTC(2026, 0, 1), dayStartEquity: '' });
    const t = await restart(store, ['a']);
    expect(t.risk.state.killSwitch).toBe(true);
    expect([...t.exchange]).toEqual([]);
    expect(t.sweep()).toMatchObject({ state: 'done', message: 'open orders cancelled' });
  });
});
