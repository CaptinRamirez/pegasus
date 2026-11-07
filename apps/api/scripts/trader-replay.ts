/**
 * The trader's replay exam (docs/proposals/trader-replay-2026-11.md): the live prompt, model and dossier code asked at
 * the weekday 4-hour closes of 2026-07-01 to 2026-10-30, after the model's knowledge cutoff, each close on its own
 * (flat account, no earlier decisions). Run from apps/api: `pnpm exec tsx scripts/trader-replay.ts <command>`.
 *   build        fetch the history and write the batch requests                 no key
 *   check        rebuild the dossier of the last logged live call, list what differs  no key
 *   pilot [n]    ask n requests (default 3) on the streaming API                ANTHROPIC_API_KEY
 *   submit       create the batch (once: refuses while batch.json exists)       ANTHROPIC_API_KEY
 *   collect      save the batch's answers once it has ended                     ANTHROPIC_API_KEY
 *   score        the pre-registered tests                                       no key
 *   rules [live] the holds and the stop floor of 2026-11-07 on the replay's entries (live: on the entries of data/trader-log.jsonl since 2026-10-21)  no key
 * Files in data/trader-replay/. Prices in the scoring are plain numbers: statistics, not money that is booked.
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import Anthropic from '@anthropic-ai/sdk';
import { zodOutputFormat } from '@anthropic-ai/sdk/helpers/zod';
import {
  checkDecision,
  D,
  Decimal,
  ladderFirstTarget,
  traderBreakEven,
  traderDecisionSchema,
  traderHolds,
  traderTrend,
  TRADER_MAKER_FEE,
  TRADER_TAKER_FEE,
  type Candle,
  type TraderAccountInfo,
  type TraderBar,
  type TraderDecision,
  type TraderDossier,
  type TraderGuardrails,
  type TraderVerdict,
} from '@pegasus/shared';
import type { OkxCandleRow } from '@pegasus/okx';
import { mapCandle, toOkxBar } from '../src/okx/mappers.js';
import { buildTraderDossier, type TraderDossierSources } from '../src/services/trader-dossier.js';
import { TRADER_MAX_TOKENS, TRADER_SYSTEM_PROMPT } from '../src/services/trader-model.js';

const ROOT = fileURLToPath(new URL('../../../', import.meta.url));
const DIR = `${ROOT}data/trader-replay/`;
const INST = 'BTC-USDT-SWAP';
const MODEL = 'claude-opus-5-5';
const EFFORT = 'high';
const MIN = 60_000;
const H = 60 * MIN;
const DAY = 24 * H;
const FROM = Date.UTC(2026, 6, 1);
const TO = Date.UTC(2026, 9, 30, 20);
const BARS: TraderBar[] = ['15m', '1H', '4H', '1D', '1W'];
const BAR_MS: Record<TraderBar, number> = { '15m': 15 * MIN, '1H': H, '4H': 4 * H, '1D': DAY, '1W': 7 * DAY };
const TAKER = Number(TRADER_TAKER_FEE);
const MAKER = Number(TRADER_MAKER_FEE);
// Opus 5.5 list prices per token; the batch pays half
const PRICE_IN = 4e-6;
const PRICE_OUT = 20e-6;

const ADDENDUM = "Also answer pUp4h and pUp24h: your probability, 0 to 1, that the mark is above the dossier's mark 4 hours and 24 hours after asOf. They are recorded, not acted on.";
const replaySchema = traderDecisionSchema.extend({ pUp4h: traderDecisionSchema.shape.confidence, pUp24h: traderDecisionSchema.shape.confidence });
type ReplayDecision = ReturnType<typeof replaySchema.parse>;
const ACCOUNT: TraderAccountInfo = { equity: '1000', position: null, tradesToday: 0, pnlToday: '0', consecutiveLosses: 0, cooldownUntil: null, killSwitch: false };

interface History {
  candles: Record<TraderBar, Candle[]>;
  /** Binance BTCUSDT settlements: [fundingTime, rate] */
  funding: Array<[number, string]>;
  /** OKX daily open interest in coin: [day open, oiCcy] */
  oi: Array<[number, string]>;
}
interface Point {
  id: string;
  t: number;
  mark: string;
}

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));
const readJson = <T>(name: string): T => JSON.parse(readFileSync(DIR + name, 'utf8')) as T;
const writeJson = (name: string, v: unknown): void => writeFileSync(DIR + name, JSON.stringify(v));
const readLines = <T>(path: string): T[] => readFileSync(path, 'utf8').split('\n').filter((l) => l.trim() !== '').map((l) => JSON.parse(l) as T);

async function getJson(url: string): Promise<any> {
  for (let i = 0; i < 6; i++) {
    try {
      const r = await fetch(url, { headers: { 'User-Agent': 'Mozilla/5.0' } });
      if (r.ok) return await r.json();
    } catch {
      // retried below
    }
    await sleep(1000 * (i + 1));
  }
  throw new Error(`gave up on ${url}`);
}

/** OKX history candles from now back to `from`, oldest first. */
async function okxCandles(bar: string, from: number): Promise<Candle[]> {
  const out = new Map<number, Candle>();
  let after = Date.now();
  for (;;) {
    const j = await getJson(`https://www.okx.com/api/v5/market/history-candles?instId=${INST}&bar=${bar}&after=${after}&limit=100`);
    if (j.code !== '0') {
      await sleep(2000);
      continue;
    }
    const rows = j.data as OkxCandleRow[];
    const last = rows.at(-1);
    if (!last) break;
    for (const r of rows) out.set(Number(r[0]), mapCandle(r));
    after = Number(last[0]);
    if (after < from) break;
    await sleep(110);
  }
  return [...out.values()].sort((a, b) => a.ts - b.ts);
}

async function fetchHistory(): Promise<History> {
  const candles = {} as Record<TraderBar, Candle[]>;
  for (const bar of BARS) {
    candles[bar] = await okxCandles(toOkxBar(bar), FROM - 300 * BAR_MS[bar]);
    console.log(`${bar}: ${candles[bar].length} bars from ${new Date(candles[bar][0]?.ts ?? 0).toISOString()}`);
  }
  const funding: Array<[number, string]> = [];
  for (let start = FROM - 10 * DAY; ; ) {
    const rows = (await getJson(`https://fapi.binance.com/fapi/v1/fundingRate?symbol=BTCUSDT&startTime=${start}&limit=1000`)) as Array<{ fundingTime: number; fundingRate: string }>;
    for (const r of rows) funding.push([r.fundingTime, r.fundingRate]);
    const last = rows.at(-1);
    if (!last || rows.length < 1000) break;
    start = last.fundingTime + 1;
  }
  const oi = new Map<number, string>();
  for (let end = Date.now(); end > FROM - 10 * DAY; ) {
    const j = await getJson(`https://www.okx.com/api/v5/rubik/stat/contracts/open-interest-history?instId=${INST}&period=1Dutc&end=${end}&limit=100`);
    const rows = (j.data ?? []) as string[][];
    const last = rows.at(-1);
    if (!last) break;
    for (const r of rows) oi.set(Number(r[0]), r[2] ?? '0');
    end = Number(last[0]) - 1;
    await sleep(500);
  }
  console.log(`funding: ${funding.length} settlements, open interest: ${oi.size} days`);
  return { candles, funding, oi: [...oi.entries()].sort((a, b) => a[0] - b[0]) };
}

/** What the dossier's sources would have answered at the close `t`: only bars closed by then, the day's bar forming. */
function sourcesAt(h: History, t: number): TraderDossierSources {
  const closedBy = (bar: TraderBar): Candle[] => h.candles[bar].filter((c) => c.ts + BAR_MS[bar] <= t).map((c) => ({ ...c, confirm: true }));
  const last = closedBy('15m').at(-1);
  if (!last) throw new Error(`no 15m bar before ${new Date(t).toISOString()}`);
  return {
    async candles(_instId, bar, limit) {
      const closed = closedBy(bar);
      if (bar !== '1D') return closed.slice(-limit);
      // levelsOf reads today's open, high and low from the forming daily bar; built here from the day's 15m bars
      const dayStart = t - (t % DAY);
      const today = h.candles['15m'].filter((c) => c.ts >= dayStart && c.ts + BAR_MS['15m'] <= t);
      const open = today[0]?.open ?? last.close;
      const forming: Candle = {
        ts: dayStart,
        open,
        high: Decimal.max(open, ...today.map((c) => c.high)).toFixed(),
        low: Decimal.min(open, ...today.map((c) => c.low)).toFixed(),
        close: today.at(-1)?.close ?? open,
        vol: '0',
        volCcy: '0',
        confirm: false,
      };
      return [...closed.slice(-(limit - 1)), forming];
    },
    mark: () => last.close,
    async funding() {
      const past = h.funding.filter(([ft]) => ft <= t);
      const nine = past.slice(-9);
      const mean = nine.length > 0 ? nine.reduce((s, [, r]) => s.plus(r), D(0)).div(nine.length) : null;
      return { rate: past.at(-1)?.[1] ?? null, mean72h: mean === null ? null : mean.toDecimalPlaces(8).toFixed() };
    },
    // a past day's row holds its last snapshot: the open interest at the latest UTC midnight; its 24-hour change is left
    // null (as live when the hourly history is short): a day-old change can carry the wrong sign
    async openInterest() {
      return { oi: h.oi.filter(([d]) => d + DAY <= t).at(-1)?.[1] ?? null, change24hPct: null };
    },
  };
}

function lastLiveDossier(): TraderDossier {
  const lines = readFileSync(`${ROOT}data/trader-log.jsonl`, 'utf8').split('\n').filter((l) => l.includes('"dossier"'));
  const last = lines.at(-1);
  if (!last) throw new Error('no dossier in data/trader-log.jsonl');
  return (JSON.parse(last) as { dossier: TraderDossier }).dossier;
}

const dossierAt = (h: History, t: number, g: TraderGuardrails): Promise<TraderDossier> =>
  buildTraderDossier({
    instId: INST,
    now: t,
    sources: sourcesAt(h, t),
    account: ACCOUNT,
    guardrails: g,
    calendar: [],
    triggers: [t % DAY === 0 ? 'session open' : 'scheduled recheck'],
    macro: { calendar: [], headlines: [], notes: ['economic calendar not available', 'headlines not available'] },
    recentDecisions: [],
    recentTrades: [],
  });

const paramsOf = (d: TraderDossier) => ({
  model: MODEL,
  max_tokens: TRADER_MAX_TOKENS,
  thinking: { type: 'adaptive' as const },
  output_config: { effort: EFFORT as 'high', format: zodOutputFormat(replaySchema) },
  system: [
    { type: 'text' as const, text: TRADER_SYSTEM_PROMPT, cache_control: { type: 'ephemeral' as const } },
    { type: 'text' as const, text: ADDENDUM },
  ],
  messages: [{ role: 'user' as const, content: JSON.stringify(d) }],
});

function points(): number[] {
  const out: number[] = [];
  for (let t = FROM; t <= TO; t += 4 * H) if (![0, 6].includes(new Date(t).getUTCDay())) out.push(t);
  return out;
}

async function build(): Promise<void> {
  mkdirSync(DIR, { recursive: true });
  if (!existsSync(DIR + 'history.json') || process.argv.includes('--refresh')) writeJson('history.json', await fetchHistory());
  const h = readJson<History>('history.json');
  const g = lastLiveDossier().guardrails;
  const lines: string[] = [];
  const pts: Point[] = [];
  let chars = 0;
  for (const t of points()) {
    const d = await dossierAt(h, t, g);
    const params = paramsOf(d);
    chars += params.messages[0]!.content.length;
    lines.push(JSON.stringify({ custom_id: `t${t}`, params }));
    pts.push({ id: `t${t}`, t, mark: d.mark });
  }
  writeFileSync(DIR + 'requests.jsonl', lines.join('\n') + '\n');
  writeJson('points.json', pts);
  // the live dossiers run at about 2.35 characters a token
  const inTokens = chars / 2.35 + pts.length * 2_300;
  console.log(`${pts.length} requests, about ${Math.round(inTokens / 1e6 * 10) / 10}M input tokens: about $${((inTokens * PRICE_IN + pts.length * 1_100 * PRICE_OUT) / 2).toFixed(0)} on the batch`);
}

/** Every field of the frames, levels and session that differs between the live dossier and its rebuild. */
async function check(): Promise<void> {
  const live = lastLiveDossier();
  const h = readJson<History>('history.json');
  const mine = await dossierAt(h, live.asOf, live.guardrails);
  const diffs: string[] = [];
  const walk = (path: string, a: unknown, b: unknown): void => {
    if (typeof a === 'object' && a !== null && typeof b === 'object' && b !== null) {
      for (const k of new Set([...Object.keys(a), ...Object.keys(b)])) walk(`${path}.${k}`, (a as Record<string, unknown>)[k], (b as Record<string, unknown>)[k]);
    } else if (JSON.stringify(a) !== JSON.stringify(b)) diffs.push(`${path}: live ${JSON.stringify(a)} replay ${JSON.stringify(b)}`);
  };
  walk('frames', live.frames, mine.frames);
  walk('levels', live.levels, mine.levels);
  walk('session', { ...live.session, calendar: [] }, mine.session);
  console.log(`dossier of ${live.asOfIso}: ${diffs.length} differences in frames, levels and session`);
  for (const d of diffs.slice(0, 40)) console.log('  ' + d);
  console.log(`mark: live ${live.mark} replay ${mine.mark}`);
  console.log(`derivatives: live ${JSON.stringify(live.derivatives)}\n             replay ${JSON.stringify(mine.derivatives)}`);
}

async function pilot(n: number): Promise<void> {
  const client = new Anthropic({ maxRetries: 1, timeout: 600_000 });
  const reqs = readLines<{ custom_id: string; params: any }>(DIR + 'requests.jsonl');
  const picked = Array.from({ length: n }, (_, i) => reqs[Math.floor((i * reqs.length) / n)]!);
  let cost = 0;
  for (const r of picked) {
    const res = await client.messages.stream({ ...r.params, output_config: { effort: EFFORT, format: zodOutputFormat(replaySchema) } }).finalMessage();
    const c = res.usage.input_tokens * PRICE_IN + res.usage.output_tokens * PRICE_OUT;
    cost += c;
    const d = res.parsed_output as ReplayDecision | null;
    console.log(`${new Date(Number(r.custom_id.slice(1))).toISOString()} ${res.stop_reason} in ${res.usage.input_tokens} out ${res.usage.output_tokens} $${c.toFixed(3)}`);
    console.log(d ? `  ${d.action} stop ${d.stopPx} target ${d.targetPx} conf ${d.confidence} pUp4h ${d.pUp4h} pUp24h ${d.pUp24h}\n  ${d.oneLiner}` : '  no parsed decision');
  }
  console.log(`pilot: $${cost.toFixed(2)} for ${n}, $${(cost / n).toFixed(3)} a call at list price`);
}

async function submit(): Promise<void> {
  if (existsSync(DIR + 'batch.json')) throw new Error('batch.json exists: the batch was already submitted');
  const client = new Anthropic();
  const requests = readLines<{ custom_id: string; params: any }>(DIR + 'requests.jsonl');
  const batch = await client.messages.batches.create({ requests });
  writeJson('batch.json', { id: batch.id, createdAt: batch.created_at, requests: requests.length });
  console.log(`batch ${batch.id}: ${requests.length} requests, ${batch.processing_status}`);
}

async function collect(): Promise<void> {
  const client = new Anthropic();
  const { id } = readJson<{ id: string }>('batch.json');
  const b = await client.messages.batches.retrieve(id);
  console.log(`batch ${id}: ${b.processing_status} ${JSON.stringify(b.request_counts)}`);
  if (b.processing_status !== 'ended') return;
  const out: string[] = [];
  for await (const r of await client.messages.batches.results(id)) {
    if (r.result.type !== 'succeeded') {
      out.push(JSON.stringify({ id: r.custom_id, type: r.result.type, text: null }));
      continue;
    }
    const m = r.result.message;
    const text = m.content.filter((c) => c.type === 'text').at(-1);
    out.push(JSON.stringify({ id: r.custom_id, type: 'succeeded', stop: m.stop_reason, text: text?.type === 'text' ? text.text : null, usage: m.usage }));
  }
  writeFileSync(DIR + 'results.jsonl', out.join('\n') + '\n');
  console.log(`${out.length} answers in results.jsonl`);
}

// ---- scoring ----

type Bar1m = [ts: number, open: number, high: number, low: number, close: number];

async function minuteBars(): Promise<Bar1m[]> {
  if (existsSync(DIR + 'm1.json')) return readJson<Bar1m[]>('m1.json');
  const bars = (await okxCandles('1m', FROM)).filter((c) => c.confirm).map((c): Bar1m => [c.ts, Number(c.open), Number(c.high), Number(c.low), Number(c.close)]);
  writeJson('m1.json', bars);
  return bars;
}

/** The minute bars since `from` for the live entries, kept in m1-live.json and fetched again once two hours old. */
async function liveMinuteBars(from: number): Promise<Bar1m[]> {
  const cached = existsSync(DIR + 'm1-live.json') ? readJson<Bar1m[]>('m1-live.json') : [];
  if (cached.length > 0 && cached.at(-1)![0] > Date.now() - 2 * H) return cached;
  const bars = (await okxCandles('1m', from)).filter((c) => c.confirm && c.ts >= from).map((c): Bar1m => [c.ts, Number(c.open), Number(c.high), Number(c.low), Number(c.close)]);
  writeJson('m1-live.json', bars);
  return bars;
}

/** Index of the first bar opening at or after `t`. */
function at(m1: Bar1m[], t: number): number {
  let lo = 0;
  let hi = m1.length;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (m1[mid]![0] < t) lo = mid + 1;
    else hi = mid;
  }
  return lo;
}

/** The close of the minute that ends at `t`; null past the data. */
function priceAt(m1: Bar1m[], t: number): number | null {
  const i = at(m1, t) - 1;
  return i >= 0 && i + 1 < m1.length ? m1[i]![4] : null;
}

/**
 * One entry on the minute bars from index `i`: A = the live structure (stop, half at TP1, the rest at the target with its
 * stop at the break-even, out at market after 7 days); B = the stop twice as far at half the size, out after 24 hours.
 * The stop wins a minute that touches both. R = net PnL over the risk at the original stop.
 */
function simulateRun(m1: Bar1m[], i: number, side: 'long' | 'short', entry: number, stop: number, target: number, entryFee: number, mode: 'A' | 'B', cut = Infinity): { r: number; exit: number } {
  const s = side === 'long' ? 1 : -1;
  const dist = Math.abs(entry - stop);
  // `cut`: a stand-aside flag (owner-methods-2026-11.md, idea 3) closes the position at the market at that minute
  const end = Math.min(m1[i]![0] + (mode === 'A' ? 7 * DAY : DAY), cut);
  const tp1 = Number(ladderFirstTarget(side, entry, stop));
  const even = traderBreakEven(side, entry).toNumber();
  let stopNow = mode === 'A' ? stop : entry - s * 2 * dist;
  const size = mode === 'A' ? 1 : 0.5;
  let left = 1;
  let banked = 0;
  let px = entry;
  let exit = end;
  for (let j = i; j < m1.length && m1[j]![0] < end; j++) {
    const [ts, , high, low, close] = m1[j]!;
    const adverse = s > 0 ? low : high;
    const favour = s > 0 ? high : low;
    px = close;
    if (s * (adverse - stopNow) <= 0) {
      px = stopNow;
      exit = ts;
      break;
    }
    if (mode === 'B') continue;
    if (left === 1 && s * (favour - tp1) >= 0) {
      banked = 0.5 * (s * (tp1 - entry) - tp1 * TAKER);
      left = 0.5;
      stopNow = even;
    }
    if (s * (favour - target) >= 0) {
      px = target;
      exit = ts;
      break;
    }
  }
  return { r: (size * (banked + left * (s * (px - entry) - px * TAKER) - entry * entryFee)) / dist, exit };
}

const simulate = (m1: Bar1m[], i: number, side: 'long' | 'short', entry: number, stop: number, target: number, entryFee: number, mode: 'A' | 'B', cut = Infinity): number => simulateRun(m1, i, side, entry, stop, target, entryFee, mode, cut).r;

/** Mean, and its standard error with the rows grouped by `key` (sums of the deviations within a group). */
function clustered(rows: Array<{ v: number; key: string }>): { n: number; mean: number; se: number; t: number } {
  const n = rows.length;
  const mean = rows.reduce((s, r) => s + r.v, 0) / n;
  const groups = new Map<string, number>();
  for (const r of rows) groups.set(r.key, (groups.get(r.key) ?? 0) + r.v - mean);
  const se = Math.sqrt([...groups.values()].reduce((s, x) => s + x * x, 0)) / n;
  return { n, mean, se, t: se > 0 ? mean / se : 0 };
}

const isoWeek = (t: number): string => {
  const d = new Date(t - (t % DAY));
  const day = (d.getUTCDay() + 6) % 7;
  d.setUTCDate(d.getUTCDate() - day + 3);
  return `${d.getUTCFullYear()}-${Math.ceil(((d.getTime() - Date.UTC(d.getUTCFullYear(), 0, 1)) / DAY + 1) / 7)}`;
};

type EntryVerdict = Extract<TraderVerdict, { ok: true; action: 'long' | 'short' }>;

/** The history, the guardrails, the minute bars and the batch's usable answers in time order. */
async function load(): Promise<{ h: History; g: TraderGuardrails; m1: Bar1m[]; rows: Array<{ p: Point; d: ReplayDecision }> }> {
  const h = readJson<History>('history.json');
  const pts = new Map(readJson<Point[]>('points.json').map((p) => [p.id, p]));
  const g = lastLiveDossier().guardrails;
  const m1 = await minuteBars();
  const answers = readLines<{ id: string; type: string; text: string | null }>(DIR + 'results.jsonl');
  const problems: string[] = [];
  const rows: Array<{ p: Point; d: ReplayDecision }> = [];
  for (const a of answers) {
    const p = pts.get(a.id);
    const parsed = a.text === null ? null : replaySchema.safeParse(JSON.parse(a.text));
    if (!p || !parsed?.success) problems.push(`${a.id}: ${a.type}${parsed && !parsed.success ? ' (did not parse)' : ''}`);
    else rows.push({ p, d: parsed.data });
  }
  rows.sort((a, b) => a.p.t - b.p.t);
  console.log(`${answers.length} answers, ${rows.length} usable${problems.length ? `; not usable: ${problems.join(', ')}` : ''}`);
  return { h, g, m1, rows };
}

/** Where an entry fills on the minute bars: a market order at the close `t`, a limit order where it is touched within 15 minutes; null when it is not. */
function fillOf(v: EntryVerdict, t: number, m1: Bar1m[]): { i: number; entry: number; fee: number } | null {
  const entry = Number(v.entryPx);
  const i = at(m1, t);
  if (v.entryType !== 'limit') return { i, entry, fee: TAKER };
  const fill = m1.slice(i, at(m1, t + 15 * MIN)).findIndex(([, , hi, lo]) => (v.action === 'long' ? lo <= entry : hi >= entry));
  return fill < 0 ? null : { i: i + fill + 1, entry, fee: MAKER };
}

async function score(): Promise<void> {
  const { h, g, m1, rows } = await load();
  const daily = h.candles['1D'];

  // ---- direction ----
  const trendUp = (t: number): boolean => {
    const closes = daily.filter((c) => c.ts + DAY <= t).slice(-20).map((c) => Number(c.close));
    return closes.at(-1)! > closes.reduce((s, c) => s + c, 0) / closes.length;
  };
  const report: Record<string, unknown> = {};
  for (const [hours, field, key] of [[4, 'pUp4h', (t: number) => new Date(t).toISOString().slice(0, 10)], [24, 'pUp24h', isoWeek]] as const) {
    const scored = rows.flatMap(({ p, d }) => {
      const later = priceAt(m1, p.t + hours * H);
      const now = Number(p.mark);
      if (later === null || later === now) return [];
      const pUp = d[field];
      return [{ t: p.t, up: later > now, pUp, call: pUp > 0.5 ? true : pUp < 0.5 ? false : null, trend: trendUp(p.t) }];
    });
    const called = scored.filter((r) => r.call !== null);
    const hit = (f: (r: (typeof called)[number]) => boolean): number[] => called.map((r) => (f(r) === r.up ? 1 : 0));
    const rules = { long: hit(() => true), short: hit(() => false), trend: hit((r) => r.trend) };
    const model = hit((r) => r.call!);
    const rate = (v: number[]): number => v.reduce((s, x) => s + x, 0) / v.length;
    const [bestName, best] = Object.entries(rules).sort((a, b) => rate(b[1]) - rate(a[1]))[0]!;
    const diff = clustered(model.map((v, i) => ({ v: v - best[i]!, key: key(called[i]!.t) })));
    const brier = scored.reduce((s, r) => s + (r.pUp - (r.up ? 1 : 0)) ** 2, 0) / scored.length;
    const base = scored.filter((r) => r.up).length / scored.length;
    const out = {
      points: scored.length,
      abstained: scored.length - called.length,
      model: rate(model),
      long: rate(rules.long),
      short: rate(rules.short),
      trend: rate(rules.trend),
      best: bestName,
      edge: diff.mean,
      se: diff.se,
      t: diff.t,
      brier,
      brierHalf: 0.25,
      brierBase: base * (1 - base),
      pass: hours === 4 ? diff.mean >= 0.05 && diff.t >= 2 : null,
    };
    report[`direction${hours}h`] = out;
    const pct = (x: number): string => `${(x * 100).toFixed(1)}%`;
    console.log(`\n== direction at ${hours}h (${hours === 4 ? 'primary, SE by day' : 'reported only, SE by ISO week'}): ${out.points} points, ${out.abstained} at 0.5`);
    console.log(`  model ${pct(out.model)} | always long ${pct(out.long)} | always short ${pct(out.short)} | daily trend ${pct(out.trend)}`);
    console.log(`  model minus ${bestName}: ${(diff.mean * 100).toFixed(1)} points, SE ${(diff.se * 100).toFixed(1)}, t ${diff.t.toFixed(2)}${hours === 4 ? ` -> ${out.pass ? 'PASS' : 'FAIL'} (needs >= 5 points and t >= 2)` : ''}`);
    console.log(`  Brier ${brier.toFixed(4)} | constant 0.5: 0.2500 | the period's base rate: ${out.brierBase.toFixed(4)}`);
  }

  // ---- trades ----
  const trades: Array<{ t: number; side: 'long' | 'short'; A: number; B: number; trendB: number; conf: number; oA: number | null; oB: number | null }> = [];
  const simInputs: Array<{ i: number; side: 'long' | 'short'; entry: number; stop: number; target: number; fee: number }> = [];
  // idea 3 of owner-methods-2026-11.md: the windows in which the trader stands aside (flags.json, from the funding and open interest)
  const windows = existsSync(DIR + 'flags.json') ? readJson<Array<{ flag: number; clear: number }>>('flags.json') : [];
  const aside = (t: number): boolean => windows.some((w) => t >= w.flag && t < w.clear);
  const nextFlag = (t: number): number => Math.min(Infinity, ...windows.filter((w) => w.flag > t).map((w) => w.flag));
  let rejected = 0;
  let unfilled = 0;
  for (const { p, d } of rows) {
    if (d.action !== 'long' && d.action !== 'short') continue;
    const v = checkDecision(d, p.mark, g, null);
    if (!v.ok || (v.action !== 'long' && v.action !== 'short')) {
      rejected++;
      continue;
    }
    const f = fillOf(v, p.t, m1);
    if (!f) {
      unfilled++;
      continue;
    }
    const { i, entry, fee } = f;
    if (i >= m1.length) continue;
    const stop = Number(v.stopPx);
    const target = Number(v.targetPx);
    const dist = Math.abs(entry - stop);
    const trendSide = trendUp(p.t) ? 'long' : 'short';
    const mark = Number(p.mark);
    simInputs.push({ i, side: v.action, entry, stop, target, fee });
    trades.push({
      t: p.t,
      side: v.action,
      A: simulate(m1, i, v.action, entry, stop, target, fee, 'A'),
      B: simulate(m1, i, v.action, entry, stop, target, fee, 'B'),
      trendB: simulate(m1, at(m1, p.t), trendSide, mark, trendSide === 'long' ? mark - dist : mark + dist, trendSide === 'long' ? mark + dist : mark - dist, TAKER, 'B'),
      conf: d.confidence,
      oA: aside(m1[i]![0]) ? null : simulate(m1, i, v.action, entry, stop, target, fee, 'A', nextFlag(m1[i]![0])),
      oB: aside(m1[i]![0]) ? null : simulate(m1, i, v.action, entry, stop, target, fee, 'B', nextFlag(m1[i]![0])),
    });
  }
  const day = (t: number): string => new Date(t).toISOString().slice(0, 10);
  const sum = (k: 'A' | 'B' | 'trendB') => clustered(trades.map((x) => ({ v: x[k], key: day(x.t) })));
  const A = sum('A');
  const B = sum('B');
  const T = sum('trendB');
  const win = (k: 'A' | 'B'): string => `${trades.filter((x) => x[k] > 0).length}/${trades.length}`;
  console.log(`\n== trades: ${trades.length} entries (${trades.filter((x) => x.side === 'long').length} long), ${rejected} refused by checkDecision, ${unfilled} limit orders not filled`);
  console.log(`  A live structure   mean ${A.mean.toFixed(3)}R  t ${A.t.toFixed(2)}  won ${win('A')}  total ${(A.mean * A.n).toFixed(1)}R`);
  console.log(`  B stop x2, 24h     mean ${B.mean.toFixed(3)}R  t ${B.t.toFixed(2)}  won ${win('B')}  total ${(B.mean * B.n).toFixed(1)}R -> ${B.mean > 0 ? 'PASS' : 'FAIL'} (needs > 0)`);
  console.log(`  daily trend, same times and stops, B   mean ${T.mean.toFixed(3)}R  t ${T.t.toFixed(2)}`);
  const conf = trades.reduce((s, x) => s + x.conf, 0) / (trades.length || 1);
  console.log(`  confidence: mean ${conf.toFixed(2)}, share above +0.5R in A (about: the target reached): ${(trades.filter((x) => x.A > 0.5).length / (trades.length || 1)).toFixed(2)}`);
  report.trades = { n: trades.length, rejected, unfilled, A, B, trendB: T, passB: B.mean > 0 };
  if (windows.length > 0) {
    const kept = trades.filter((x) => x.oA !== null);
    const changedA = kept.filter((x) => x.oA !== x.A).length;
    const oA = clustered(kept.map((x) => ({ v: x.oA as number, key: day(x.t) })));
    const oB = clustered(kept.map((x) => ({ v: x.oB as number, key: day(x.t) })));
    const total = (k: 'A' | 'B') => trades.reduce((s, x) => s + x[k], 0);
    const totalO = (k: 'oA' | 'oB') => kept.reduce((s, x) => s + (x[k] as number), 0);
    console.log(`
== stand aside on extreme funding / open interest (${windows.length} windows): ${trades.length - kept.length} entries skipped, ${changedA} of the rest closed early in A`);
    console.log(`  A without ${A.mean.toFixed(3)}R x ${A.n} = ${total('A').toFixed(1)}R | with ${oA.mean.toFixed(3)}R (t ${oA.t.toFixed(2)}) x ${oA.n} = ${totalO('oA').toFixed(1)}R`);
    console.log(`  B without ${B.mean.toFixed(3)}R x ${B.n} = ${total('B').toFixed(1)}R | with ${oB.mean.toFixed(3)}R (t ${oB.t.toFixed(2)}) x ${oB.n} = ${totalO('oB').toFixed(1)}R`);
    const skipped = trades.filter((x) => x.oA === null);
    if (skipped.length > 0) console.log(`  the skipped entries would have made: A ${(skipped.reduce((s, x) => s + x.A, 0) / skipped.length).toFixed(3)}R, B ${(skipped.reduce((s, x) => s + x.B, 0) / skipped.length).toFixed(3)}R each`);
    report.standAside = { windows: windows.length, skipped: trades.length - kept.length, closedEarlyA: changedA, A: oA, B: oB, totalA: totalO('oA'), totalB: totalO('oB'), totalWithoutA: total('A'), totalWithoutB: total('B') };
    // reported only: the same windows moved as a block to other times (wrapped within the period), 40 times; does the
    // real timing beat standing aside as often at random moments?
    const sims: Array<{ i: number; side: 'long' | 'short'; entry: number; stop: number; target: number; fee: number }> = simInputs;
    const lo = Math.min(...windows.map((w) => w.flag)), hi = Math.max(...windows.map((w) => w.clear)), span = hi - lo;
    const placebo: Array<{ A: number; B: number }> = [];
    for (let k = 1; k <= 40; k++) {
      const shift = ((k * 7919) % 97) / 97 * (span - 6 * DAY) + 3 * DAY;
      const moved = windows.map((w) => ({ flag: lo + ((w.flag - lo + shift) % span), clear: lo + ((w.flag - lo + shift) % span) + (w.clear - w.flag) }));
      let tA = 0, tB = 0;
      for (const x of sims) {
        const te = m1[x.i]![0];
        if (moved.some((w) => te >= w.flag && te < w.clear)) continue;
        const cut = Math.min(Infinity, ...moved.filter((w) => w.flag > te).map((w) => w.flag));
        tA += simulate(m1, x.i, x.side, x.entry, x.stop, x.target, x.fee, 'A', cut);
        tB += simulate(m1, x.i, x.side, x.entry, x.stop, x.target, x.fee, 'B', cut);
      }
      placebo.push({ A: tA, B: tB });
    }
    const beat = (k: 'A' | 'B', real: number) => placebo.filter((p) => p[k] < real).length;
    const med = (k: 'A' | 'B') => [...placebo.map((p) => p[k])].sort((a, b) => a - b)[20]!;
    console.log(`  the same windows at 40 other times: A total median ${med('A').toFixed(1)}R, the real one beats ${beat('A', totalO('oA'))}/40; B median ${med('B').toFixed(1)}R, beats ${beat('B', totalO('oB'))}/40`);
    report.standAsidePlacebo = { medianA: med('A'), medianB: med('B'), beatA: beat('A', totalO('oA')), beatB: beat('B', totalO('oB')) };
  }
  const primary = (report.direction4h as { pass: boolean }).pass;
  console.log(`\nVERDICT: ${primary && B.mean > 0 ? 'PASS: the direction calls carry an edge' : 'FAIL: no large edge in the direction calls'}`);
  writeJson('score.json', report);
}

// ---- the holds and the stop floor of 2026-11-07 (traderHolds, checkDecision's `atr`) ----

/** The big US releases of the replay's months and after, as the calendar shows them: FOMC statements, CPI, payrolls (UTC). */
const BIG_RELEASES = [
  ...['2026-07-29T18:00Z', '2026-09-16T18:00Z', '2026-10-28T18:00Z'].map((d) => ({ time: Date.parse(d), title: 'FOMC Statement' })),
  ...['2026-07-14T12:30Z', '2026-08-12T12:30Z', '2026-09-11T12:30Z', '2026-10-14T12:30Z', '2026-11-10T13:30Z'].map((d) => ({ time: Date.parse(d), title: 'CPI m/m' })),
  ...['2026-07-02T12:30Z', '2026-08-07T12:30Z', '2026-09-04T12:30Z', '2026-10-02T12:30Z', '2026-11-06T13:30Z'].map((d) => ({ time: Date.parse(d), title: 'Non-Farm Employment Change' })),
].map((e) => ({ ...e, country: 'USD', impact: 'High' }));

interface RuleRow {
  t: number;
  holds: string[];
  /** A, the live structure, as decided */
  base: number;
  /** A with the stop at the floor; null when the entry is refused (the target within the floor) */
  floor: number | null;
  /** A with the stop at the floor and the target kept as it was */
  floorKept: number;
  widened: boolean;
}

const dayOf = (t: number): string => new Date(t).toISOString().slice(0, 10);
const holdKind = (h: string): 'trend' | 'event' | 'range' => (h.startsWith('no weekly') ? 'trend' : h.startsWith('big event') ? 'event' : 'range');

/** One entry under the rules: the holds at its dossier, and the simulation with the stop as decided and at the floor. */
function ruleRow(d: TraderDecision, dossier: TraderDossier, g: TraderGuardrails, f: { i: number; entry: number; fee: number }, m1: Bar1m[], v: EntryVerdict): RuleRow {
  // the dossiers logged before 2026-11-05 carry no trend
  const trend = (dossier as Partial<TraderDossier>).trend ?? traderTrend(dossier.frames);
  const holds = traderHolds({ now: dossier.asOf, trend, frames: dossier.frames, calendar: [...dossier.macro.calendar, ...BIG_RELEASES] });
  const atr = dossier.frames.find((x) => x.bar === '1D')?.atr14 ?? null;
  const stop = Number(v.stopPx);
  const target = Number(v.targetPx);
  const v2 = checkDecision(d, dossier.mark, g, null, { atr, tickSz: '0.1' });
  const floored = v2.ok && (v2.action === 'long' || v2.action === 'short') ? v2 : null;
  const dist = Math.max(Math.abs(f.entry - stop), Number(atr ?? 0));
  return {
    t: dossier.asOf,
    holds,
    base: simulate(m1, f.i, v.action, f.entry, stop, target, f.fee, 'A'),
    floor: floored ? simulate(m1, f.i, v.action, f.entry, Number(floored.stopPx), target, f.fee, 'A') : null,
    floorKept: simulate(m1, f.i, v.action, f.entry, v.action === 'long' ? f.entry - dist : f.entry + dist, target, f.fee, 'A'),
    widened: floored?.note !== undefined,
  };
}

/** A decision point of the replay with what the rules read at it. */
interface Pt {
  t: number;
  mark: string;
  d: ReplayDecision;
  holds: string[];
  atr: number | null;
}

interface Trade {
  t: number;
  exit: number;
  r: number;
  holds: string[];
  widened: boolean;
}

/**
 * The entries taken the way the live trader takes them: in time order, none while a position is open (the replay's
 * decisions were made flat, so a point inside a position is skipped, not asked), at most maxTradesPerDay a day, none
 * the hold refuses, each run to its exit in A, the live structure. floorAtr: the stop floor in daily ATRs (null: none);
 * an entry whose target is within the floor is refused, as live.
 */
function sequential(pts: Pt[], g: TraderGuardrails, m1: Bar1m[], hold: (holds: string[]) => boolean, floorAtr: number | null): { trades: Trade[]; refused: number } {
  const trades: Trade[] = [];
  let busyUntil = 0;
  let day = '';
  let today = 0;
  let refused = 0;
  for (const p of pts) {
    if (p.t < busyUntil || (p.d.action !== 'long' && p.d.action !== 'short') || hold(p.holds)) continue;
    if (dayOf(p.t) !== day) {
      day = dayOf(p.t);
      today = 0;
    }
    if (today >= g.maxTradesPerDay) continue;
    const v = checkDecision(p.d, p.mark, g, null, { tickSz: '0.1', atr: floorAtr !== null && p.atr !== null ? String(p.atr * floorAtr) : null });
    if (!v.ok || (v.action !== 'long' && v.action !== 'short')) {
      refused++;
      continue;
    }
    const f = fillOf(v, p.t, m1);
    if (!f || f.i >= m1.length) continue;
    const run = simulateRun(m1, f.i, v.action, f.entry, Number(v.stopPx), Number(v.targetPx), f.fee, 'A');
    trades.push({ t: p.t, exit: run.exit, r: run.r, holds: p.holds, widened: v.note !== undefined });
    busyUntil = run.exit;
    today++;
  }
  return { trades, refused };
}

/** Mean R and its t with the trades clustered by ISO week, the win share, and the equity compounded at riskPct a trade with its deepest drawdown. */
function stats(trades: Trade[], riskPct: number): { n: number; mean: number; se: number; t: number; total: number; win: number; eq: number; dd: number } {
  if (trades.length === 0) return { n: 0, mean: 0, se: 0, t: 0, total: 0, win: 0, eq: 1, dd: 0 };
  const s = clustered(trades.map((x) => ({ v: x.r, key: isoWeek(x.t) })));
  let eq = 1;
  let peak = 1;
  let dd = 0;
  for (const x of trades) {
    eq *= 1 + riskPct * x.r;
    peak = Math.max(peak, eq);
    dd = Math.min(dd, eq / peak - 1);
  }
  return { ...s, total: s.mean * s.n, win: trades.filter((x) => x.r > 0).length / trades.length, eq, dd };
}

function show(name: string, trades: Trade[], riskPct: number, extra = ''): void {
  const s = stats(trades, riskPct);
  console.log(`  ${name.padEnd(40)} n ${String(s.n).padStart(3)}  mean ${s.mean.toFixed(3).padStart(7)}R  t ${s.t.toFixed(2).padStart(6)}  won ${(s.win * 100).toFixed(0).padStart(3)}%  total ${s.total.toFixed(1).padStart(6)}R  equity x${s.eq.toFixed(2)}, deepest drawdown ${(s.dd * 100).toFixed(0)}%${extra}`);
}

const HOLD_NAMES = [['trend', 'no weekly trend'], ['event', 'the day of and after a big event'], ['range', '24h range beyond 1.5 daily ATR']] as const;

async function rules(): Promise<void> {
  const { h, g, m1, rows } = await load();
  const pts: Pt[] = [];
  for (const { p, d } of rows) {
    const dossier = await dossierAt(h, p.t, g);
    const holds = traderHolds({ now: p.t, trend: dossier.trend, frames: dossier.frames, calendar: BIG_RELEASES });
    const atr = dossier.frames.find((x) => x.bar === '1D')?.atr14 ?? null;
    pts.push({ t: p.t, mark: p.mark, d, holds, atr: atr === null ? null : Number(atr) });
  }
  const risk = Number(g.riskPct);
  const pct = (x: number): string => `${(x * 100).toFixed(0)}%`;
  const share = (f: (holds: string[]) => boolean): string => pct(pts.filter((p) => f(p.holds)).length / pts.length);
  console.log(`\n== the rules of 2026-11-07 run like the live trader on the replay's ${pts.length} decision points, 2026-07-01 to 2026-10-30: one position at a time, at most ${g.maxTradesPerDay} entries a day, A = the live structure, SE by ISO week, equity at ${pct(risk)} a trade`);
  console.log(`  points held: ${HOLD_NAMES.map(([kind, name]) => `${name} ${share((hs) => hs.some((x) => holdKind(x) === kind))}`).join(', ')}, any ${share((hs) => hs.length > 0)}`);
  const none = (): boolean => false;
  const base = sequential(pts, g, m1, none, null);
  show('baseline: as decided', base.trades, risk);
  for (const [kind, name] of HOLD_NAMES) {
    // the baseline's own trades split by what the hold would have said, the two groups as independent clusters
    const flagged = stats(base.trades.filter((x) => x.holds.some((hh) => holdKind(hh) === kind)), risk);
    const free = stats(base.trades.filter((x) => !x.holds.some((hh) => holdKind(hh) === kind)), risk);
    const se = Math.sqrt(flagged.se ** 2 + free.se ** 2);
    console.log(`      the baseline's ${flagged.n} entries this hold would refuse made ${flagged.mean.toFixed(3)}R each, the other ${free.n} ${free.mean.toFixed(3)}R: difference ${(flagged.mean - free.mean).toFixed(3)}R, t ${(se > 0 ? (flagged.mean - free.mean) / se : 0).toFixed(2)}`);
    show(`hold: ${name}`, sequential(pts, g, m1, (hs) => hs.some((hh) => holdKind(hh) === kind), null).trades, risk);
  }
  for (const k of [0.5, 1, 1.5, 2]) {
    const run = sequential(pts, g, m1, none, k);
    show(`stop floor ${k} daily ATR`, run.trades, risk, `; ${run.trades.filter((x) => x.widened).length} widened, ${run.refused - base.refused} refused for the target`);
  }
  show('the three holds, no floor', sequential(pts, g, m1, (hs) => hs.length > 0, null).trades, risk);
  const all = sequential(pts, g, m1, (hs) => hs.length > 0, 1);
  show('all four (floor 1 ATR)', all.trades, risk, `; ${all.trades.filter((x) => x.widened).length} widened, ${all.refused - base.refused} refused for the target`);
}

/** The same on the live entries: the dossiers of data/trader-log.jsonl, the real results from the journal, the simulation on the minute bars. */
async function rulesLive(): Promise<void> {
  const g = lastLiveDossier().guardrails;
  const m1 = await liveMinuteBars(Date.UTC(2026, 9, 21));
  const records = readLines<{ ts: number; dossier?: TraderDossier; decision?: TraderDecision | null; verdict: string }>(`${ROOT}data/trader-log.jsonl`);
  const journal = JSON.parse(readFileSync(`${ROOT}data/journal.trader.json`, 'utf8')) as { trades: Array<{ trade: { source: string; status: string; direction: string; openedAt: number; netPnl: string; closeReason: string } }> };
  const closed = journal.trades.map((x) => x.trade).filter((t) => t.source === 'trader' && t.status === 'closed');
  const out: Array<RuleRow & { side: string; real: number | null; end: string }> = [];
  for (const r of records) {
    const d = r.decision;
    if (!r.dossier || !d || (d.action !== 'long' && d.action !== 'short')) continue;
    const m = /^(limit )?(long|short) .*?at ([\d.]+), stop ([\d.]+)/.exec(r.verdict);
    if (!m) continue;
    const v = checkDecision(d, r.dossier.mark, g, null);
    if (!v.ok || (v.action !== 'long' && v.action !== 'short')) continue;
    const f = { i: at(m1, r.ts), entry: Number(m[3]), fee: m[1] ? MAKER : TAKER };
    if (f.i >= m1.length) continue;
    const real = closed.find((t) => t.direction === v.action && t.openedAt >= r.ts && t.openedAt < r.ts + 20 * MIN) ?? null;
    out.push({ ...ruleRow(d, r.dossier, g, f, m1, v), side: v.action, real: real ? Number(real.netPnl) : null, end: real?.closeReason ?? '-' });
  }
  console.log(`\n== the live entries since 2026-10-21 (${out.length}) and what the rules would have read at each: real = the account's result with the model's own exits; sim = A, the live structure run to its stop or target, as decided and with the stop at 1 daily ATR (a different structure from the real exits: read it for whether the stop survives, not for the money)`);
  for (const r of out) console.log(`  ${new Date(r.t).toISOString().slice(5, 16)} ${r.side.padEnd(5)} real ${r.real === null ? '   open' : r.real.toFixed(0).padStart(7)} ${r.end.padEnd(8)} sim ${r.base.toFixed(2).padStart(6)}R  floor ${r.floor === null ? 'refused' : `${r.floor.toFixed(2).padStart(6)}R`}  ${r.holds.map(holdKind).join(',') || '-'}`);
  console.log(`  real total ${out.reduce((s, r) => s + (r.real ?? 0), 0).toFixed(0)} USDT over ${out.filter((r) => r.real !== null).length} closed trades: too few to score a rule on`);
}

const [cmd, arg] = process.argv.slice(2);
const commands: Record<string, () => Promise<void>> = { build, check, pilot: () => pilot(Number(arg ?? 3)), submit, collect, score, rules: () => (arg === 'live' ? rulesLive() : rules()) };
const run = commands[cmd ?? ''];
if (!run) {
  console.log(`usage: tsx scripts/trader-replay.ts ${Object.keys(commands).join('|')}`);
  process.exit(1);
}
await run();
