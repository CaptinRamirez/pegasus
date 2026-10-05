import { mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { Fill, Order } from '@pegasus/shared';
import { MemoryStore } from '../src/db/store.js';

const fill: Fill = { tradeId: '1', ordId: 'o1', clOrdId: '', instId: 'BTC-USDT-SWAP', side: 'buy', posSide: 'net', fillPx: '50000', fillSz: '1', fee: '0', feeCcy: 'USDT', execType: 'T', ts: 1 };
const order: Order = {
  ordId: 'o1', clOrdId: '', instId: 'BTC-USDT-SWAP', side: 'buy', posSide: 'net', tdMode: 'cross', ordType: 'limit', px: '50000', sz: '1', accFillSz: '0', avgPx: '',
  state: 'live', reduceOnly: false, lever: '5', fee: '0', feeCcy: '', pnl: '0', cTime: 1, uTime: 10,
};

describe('MemoryStore', () => {
  it('keys fills by instrument and trade id', async () => {
    const s = new MemoryStore();
    await s.upsertFill(fill);
    await s.upsertFill({ ...fill, instId: 'ETH-USDT-SWAP', fillSz: '7' });
    expect((await s.listFills({ limit: 10 })).map((f) => f.instId).sort()).toEqual(['BTC-USDT-SWAP', 'ETH-USDT-SWAP']);
    expect((await s.listFills({ instId: 'ETH-USDT-SWAP', limit: 10 }))[0]?.fillSz).toBe('7');
  });
  it('keeps the fills of two liquidations of one instrument apart: both carry trade id 0', async () => {
    const s = new MemoryStore();
    const liquidation: Fill = { ...fill, tradeId: '0', ordId: 'liq1', execType: '' };
    await s.upsertFill(liquidation);
    await s.upsertFill({ ...liquidation, ordId: 'liq2', fillSz: '3' });
    await s.upsertFill(liquidation);
    expect((await s.listFills({ limit: 10 })).map((f) => `${f.ordId}:${f.fillSz}`).sort()).toEqual(['liq1:1', 'liq2:3']);
  });
  it('never regresses an order to an older snapshot', async () => {
    const s = new MemoryStore();
    await s.upsertOrder({ ...order, state: 'filled', accFillSz: '1', uTime: 20 });
    await s.upsertOrder(order); // older uTime
    expect((await s.listOrders({ limit: 10 }))[0]?.state).toBe('filled');
  });
});

describe('MemoryStore state file', () => {
  let dir: string;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'pegasus-store-'));
  });
  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it('saves the settings, and only the settings, and reads them back at the next start', async () => {
    const file = join(dir, 'nested', 'state.json');
    const s = new MemoryStore(file);
    expect(await s.getSetting('risk.state')).toBeNull();
    await s.upsertOrder(order);
    await s.setSetting('risk.state', { killSwitch: true });
    await s.setSetting('risk.state', { killSwitch: true, killSwitchReason: 'MANUAL' });
    // written through a temporary file that is renamed into place
    expect(readdirSync(join(dir, 'nested'))).toEqual(['state.json']);
    const restarted = new MemoryStore(file);
    expect(await restarted.getSetting('risk.state')).toEqual({ killSwitch: true, killSwitchReason: 'MANUAL' });
    expect(await restarted.listOrders({ limit: 10 })).toEqual([]);
  });

  it('without a file path nothing is written', async () => {
    const s = new MemoryStore();
    await s.setSetting('k', 1);
    expect(await s.getSetting('k')).toBe(1);
    expect(readdirSync(dir)).toEqual([]);
  });

  it('a file that cannot be parsed makes reads fail, naming the file, until the settings are written again', async () => {
    const file = join(dir, 'state.json');
    for (const text of ['{"settings": {"risk.state": {"killSw', '[1, 2]', '{"settings": 5}', '']) {
      writeFileSync(file, text);
      const s = new MemoryStore(file);
      await expect(s.getSetting('risk.state')).rejects.toThrow(file);
      // the unreadable file is kept aside for inspection
      expect(readFileSync(`${file}.corrupt`, 'utf8')).toBe(text);
      await s.setSetting('risk.state', { killSwitch: true });
      expect(await s.getSetting('risk.state')).toEqual({ killSwitch: true });
      expect(await new MemoryStore(file).getSetting('risk.state')).toEqual({ killSwitch: true });
    }
  });

  it('a damaged file stays unreadable at every start until the settings are written again', async () => {
    const file = join(dir, 'state.json');
    // truncated, and valid JSON saved with a byte order mark (Notepad)
    for (const text of ['{"settings": {"risk.state": {"killSw', '﻿{"settings": {"risk.state": {"killSwitch": true}}}']) {
      writeFileSync(file, text);
      // a start that ends before anything is written (OKX unreachable, the window closed)
      new MemoryStore(file);
      const second = new MemoryStore(file);
      await expect(second.getSetting('risk.state')).rejects.toThrow(file);
      expect(readFileSync(`${file}.corrupt`, 'utf8')).toBe(text);
      await second.setSetting('risk.state', { killSwitch: true });
      expect(await new MemoryStore(file).getSetting('risk.state')).toEqual({ killSwitch: true });
    }
  });
});
