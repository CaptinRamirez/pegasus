import type Anthropic from '@anthropic-ai/sdk';
import type { TraderDecision, TraderDossier } from '@pegasus/shared';
import { describe, expect, it } from 'vitest';
import { ClaudeTraderModel, TRADER_MAX_TOKENS } from '../src/services/trader-model.js';

const decision: TraderDecision = { action: 'flat', entryType: 'market', limitPrice: null, stopPx: null, targetPx: null, confidence: 0.4, reasons: ['15m 均线混乱'], invalidation: '收回日内高点', oneLiner: '不做' };
const dossier = { instId: 'BTC-USDT-SWAP' } as unknown as TraderDossier;

/** A client whose stream returns `message`; the request it was given is kept. */
function fakeClient(message: Record<string, unknown>): { client: Anthropic; seen: Array<Record<string, unknown>> } {
  const seen: Array<Record<string, unknown>> = [];
  const client = {
    messages: {
      stream(params: Record<string, unknown>) {
        seen.push(params);
        return { finalMessage: async () => message };
      },
    },
  } as unknown as Anthropic;
  return { client, seen };
}

const usage = { input_tokens: 3000, output_tokens: 1500, cache_read_input_tokens: 0 };

describe('the Claude model of the trader', () => {
  it('streams one request with the largest ceiling the model accepts, adaptive thinking, the effort and the decision schema', async () => {
    const { client, seen } = fakeClient({ model: 'claude-opus-5-5', stop_reason: 'end_turn', usage, parsed_output: decision, content: [] });
    const answer = await new ClaudeTraderModel({ model: 'claude-opus-5-5', effort: 'high', client }).decide(dossier);
    expect(answer).toMatchObject({ decision, problem: null, usage: { inputTokens: 3000, outputTokens: 1500, cacheReadTokens: 0, model: 'claude-opus-5-5' } });
    const req = seen[0] as Record<string, unknown> & { output_config: { effort: string; format: { type: string } } };
    expect(TRADER_MAX_TOKENS).toBe(128_000);
    expect(req).toMatchObject({ model: 'claude-opus-5-5', max_tokens: 128_000, thinking: { type: 'adaptive' } });
    expect(req.output_config.effort).toBe('high');
    expect(req.output_config.format.type).toBe('json_schema');
    expect(JSON.parse((req['messages'] as Array<{ content: string }>)[0]?.content ?? '')).toEqual({ instId: 'BTC-USDT-SWAP' });
  });

  it('gives no decision, with the reason, for an answer cut by the ceiling, a refusal or one that did not parse', async () => {
    const cut = fakeClient({ model: 'm', stop_reason: 'max_tokens', usage, parsed_output: null, content: [] });
    expect((await new ClaudeTraderModel({ model: 'm', effort: 'high', client: cut.client }).decide(dossier)).problem).toMatch(/max_tokens/);
    const refused = fakeClient({ model: 'm', stop_reason: 'refusal', stop_details: { category: 'cyber', explanation: 'no' }, usage, parsed_output: null, content: [] });
    expect((await new ClaudeTraderModel({ model: 'm', effort: 'high', client: refused.client }).decide(dossier)).problem).toMatch(/declined \(cyber\)/);
    const garbled = fakeClient({ model: 'm', stop_reason: 'end_turn', usage, parsed_output: null, content: [] });
    const answer = await new ClaudeTraderModel({ model: 'm', effort: 'high', client: garbled.client }).decide(dossier);
    expect(answer).toMatchObject({ decision: null, problem: expect.stringMatching(/did not parse/) });
  });
});
