import { describe, expect, it } from 'vitest';
import type { ApiResponse, RiskConfig, RiskState } from '@pegasus/shared';
import { pino } from 'pino';
import { MemoryStore } from '../src/db/store.js';
import type { Deps } from '../src/deps.js';
import { buildServer } from '../src/server.js';
import { RiskEngine } from '../src/services/risk-engine.js';

const log = pino({ level: 'silent' });
const TOKEN = 'test-token';
const config: RiskConfig = {
  maxOrderNotional: '5000', maxPositionNotionalPerInstrument: '20000', maxTotalPositionNotional: '30000', maxLeverage: '10',
  dailyLossLimit: '1000', maxOpenOrders: 3, priceBandPct: '0.05', maxSlippagePct: '0.005',
};

describe('POST /api/risk/kill-switch while the daily loss limit is breached', () => {
  it('refuses a plain release with 409 DAILY_LOSS_ACTIVE and releases with rebase', async () => {
    const risk = new RiskEngine(config, new MemoryStore(), log, () => Date.UTC(2026, 0, 1, 12));
    const app = await buildServer({ config: { server: { token: TOKEN, host: '127.0.0.1', webOrigins: [] } }, log, risk } as unknown as Deps);
    const post = async (body: unknown) => {
      const res = await app.inject({ method: 'POST', url: '/api/risk/kill-switch', headers: { authorization: `Bearer ${TOKEN}`, 'content-type': 'application/json' }, payload: JSON.stringify(body) });
      return { status: res.statusCode, body: res.json() as ApiResponse<RiskState> };
    };
    risk.updateEquity('100000');
    risk.updateEquity('98900');
    expect(risk.state.killSwitch).toBe(true);

    const refused = await post({ enabled: false });
    expect(refused).toMatchObject({ status: 409, body: { ok: false, error: { code: 'DAILY_LOSS_ACTIVE', details: { dailyPnl: '-1100', limit: '1000', equity: '98900' } } } });
    expect(risk.state.killSwitch).toBe(true);
    expect((await post({ enabled: false, rebase: 'yes' })).status).toBe(400);

    const released = await post({ enabled: false, rebase: true });
    expect(released).toMatchObject({ status: 200, body: { ok: true, data: { killSwitch: false, dayStartEquity: '98900', dailyPnl: '0', baselineTs: Date.UTC(2026, 0, 1, 12) } } });
    await app.close();
  });
});
