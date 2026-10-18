import Anthropic from '@anthropic-ai/sdk';
import { zodOutputFormat } from '@anthropic-ai/sdk/helpers/zod';
import { traderDecisionSchema, type TraderDecision, type TraderDossier, type TraderUsage } from '@pegasus/shared';

/**
 * The model behind the Claude auto trader: one request per call with the dossier as the user message and a fixed,
 * cached system prompt; the answer is parsed into TraderDecision by the SDK's structured output. A refusal, a parse
 * failure or a transport error reach the service as `decision: null` with the reason: it then does nothing at that
 * close. Tests inject a model of their own (TraderModel).
 */

export type TraderEffort = 'low' | 'medium' | 'high' | 'xhigh' | 'max';

export interface TraderModelAnswer {
  decision: TraderDecision | null;
  usage: TraderUsage;
  /** Why there is no decision: the model declined, or its answer did not parse */
  problem: string | null;
}

export interface TraderModel {
  readonly name: string;
  decide(dossier: TraderDossier): Promise<TraderModelAnswer>;
}

/** The credentials the SDK resolves on its own (ANTHROPIC_API_KEY, or an auth token); the value is never read here. */
export function hasAnthropicCredentials(env: NodeJS.ProcessEnv = process.env): boolean {
  return (env['ANTHROPIC_API_KEY'] ?? '') !== '' || (env['ANTHROPIC_AUTH_TOKEN'] ?? '') !== '';
}

export const TRADER_SYSTEM_PROMPT = `You are the decision engine of a small, rule-bound intraday trader on one USDT perpetual swap. You are called at 15-minute closes during the US session with a JSON dossier: the 15m, 1H and 4H frames with their indicators, the price levels of the day, the session clock, daily derivatives figures, and the account's discipline counters and guardrails. Answer with one JSON decision.

Rules you cannot change (the code enforces them; a decision outside them is discarded and logged):
- Actions: long, short, flat, close, tighten_stop. "flat" means do nothing; it is a normal and frequent answer. An entry without a stopPx is discarded.
- An entry (long/short) is possible only without a position, inside the session, under the day's trade cap, before the daily loss limit and outside a cooldown; the dossier's account block tells you where you stand. If an entry is not possible, answer flat or manage the position.
- The stop must be on the losing side of the entry, between guardrails.minStopPct and guardrails.maxStopPct of the price. A target, if you give one, must be at least as far as the stop (one to one or better).
- A limit entry must be within guardrails.maxLimitDistancePct of the mark; it is cancelled if not filled by the next 15-minute close.
- tighten_stop may only move the stop closer to the price, never further away.
- Position size, leverage and the stop order are the code's. You decide direction, entry style, stop and target only.

How to decide:
- Use only the numbers in the dossier. Do not invent levels, news or indicators that are not there. Every reason must cite a figure from the dossier (a level, an EMA, the MACD histogram, the RSI, the volume ratio, the funding mean, the clock).
- Prefer no trade when the frames disagree, when the stop you would need is wider than maxStopPct, when the session is about to end, or when the price sits between levels with no edge.
- Keep reasons short (one sentence each, at most three). Write reasons, invalidation and oneLiner in Chinese; keep numbers as digits.
- confidence is your probability, from 0 to 1, that the trade reaches its target before its stop; be calibrated, not enthusiastic.
- Prices are decimal strings with the instrument's precision; limitPrice, stopPx and targetPx are strings or null.`;

export class ClaudeTraderModel implements TraderModel {
  readonly name: string;
  private readonly client: Anthropic;
  private readonly effort: TraderEffort;

  constructor(opts: { model: string; effort: TraderEffort; timeoutMs?: number; client?: Anthropic }) {
    this.name = opts.model;
    this.effort = opts.effort;
    this.client = opts.client ?? new Anthropic({ timeout: opts.timeoutMs ?? 60_000, maxRetries: 1 });
  }

  async decide(dossier: TraderDossier): Promise<TraderModelAnswer> {
    const started = Date.now();
    const res = await this.client.messages.parse({
      model: this.name,
      max_tokens: 4000,
      thinking: { type: 'adaptive' },
      output_config: { effort: this.effort, format: zodOutputFormat(traderDecisionSchema) },
      system: [{ type: 'text', text: TRADER_SYSTEM_PROMPT, cache_control: { type: 'ephemeral' } }],
      messages: [{ role: 'user', content: JSON.stringify(dossier) }],
    });
    const usage: TraderUsage = {
      inputTokens: res.usage.input_tokens,
      outputTokens: res.usage.output_tokens,
      cacheReadTokens: res.usage.cache_read_input_tokens ?? 0,
      ms: Date.now() - started,
      model: res.model,
    };
    if (res.stop_reason === 'refusal') return { decision: null, usage, problem: `the model declined (${res.stop_details?.category ?? 'refusal'}): ${res.stop_details?.explanation ?? ''}`.trim() };
    if (res.stop_reason === 'max_tokens') return { decision: null, usage, problem: 'the answer was cut by max_tokens' };
    const parsed = res.parsed_output;
    if (!parsed) return { decision: null, usage, problem: 'the answer did not parse as a decision' };
    return { decision: parsed, usage, problem: null };
  }
}
