import { isBar, type Bar } from './engine/candles.js';
import type { Engine } from './engine/engine.js';
import type { OkxWsArg } from './wire.js';

export type Endpoint = 'public' | 'private' | 'business';

const PUBLIC_CHANNELS: ReadonlySet<string> = new Set(['tickers', 'books', 'books5', 'bbo-tbt', 'trades', 'mark-price', 'funding-rate', 'instruments']);
const PRIVATE_CHANNELS: ReadonlySet<string> = new Set(['orders', 'positions', 'account', 'balance_and_position']);

export function endpointOfPath(pathname: string): Endpoint | null {
  switch (pathname.replace(/\/+$/, '')) {
    case '/ws/v5/public':
      return 'public';
    case '/ws/v5/private':
      return 'private';
    case '/ws/v5/business':
      return 'business';
    default:
      return null;
  }
}

export function candleBar(channel: string): Bar | null {
  if (!channel.startsWith('candle')) return null;
  const bar = channel.slice('candle'.length);
  return isBar(bar) ? bar : null;
}

export function isPrivateChannel(channel: string): boolean {
  return PRIVATE_CHANNELS.has(channel);
}

/** Subscription index key: channel plus the instrument or instType it is scoped to. */
export function subKey(channel: string, scope: string): string {
  return `${channel}|${scope}`;
}

export function wrongChannelMsg(arg: OkxWsArg): string {
  let detail = `channel:${arg.channel}`;
  if (arg.instId !== undefined) detail += `,instId:${arg.instId}`;
  else if (arg.instType !== undefined) detail += `,instType:${arg.instType}`;
  return `Wrong URL or ${detail} doesn't exist. Please use the correct URL, channel and parameters referring to API document.`;
}

export type ArgCheck = { ok: true; key: string; arg: OkxWsArg } | { ok: false; code: string; msg: string };

export function parseArg(raw: unknown): OkxWsArg | null {
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) return null;
  const arg: OkxWsArg = { channel: '' };
  for (const [k, v] of Object.entries(raw as Record<string, unknown>)) {
    if (typeof v === 'string') arg[k] = v;
  }
  return arg.channel ? arg : null;
}

/** Validates a subscribe arg for the endpoint it arrived on and returns its index key. */
export function checkArg(endpoint: Endpoint, arg: OkxWsArg, engine: Engine): ArgCheck {
  const wrong = (): ArgCheck => ({ ok: false, code: '60018', msg: wrongChannelMsg(arg) });
  const ch = arg.channel;
  if (endpoint === 'public') {
    if (!PUBLIC_CHANNELS.has(ch)) return wrong();
    if (ch === 'instruments') {
      if (!arg.instType) return { ok: false, code: '60012', msg: 'Illegal request: instType is required' };
      return { ok: true, key: subKey(ch, arg.instType), arg: { channel: ch, instType: arg.instType } };
    }
    if (!arg.instId || !engine.instruments.has(arg.instId)) return wrong();
    return { ok: true, key: subKey(ch, arg.instId), arg: { channel: ch, instId: arg.instId } };
  }
  if (endpoint === 'business') {
    const bar = candleBar(ch);
    if (!bar || !arg.instId || !engine.instruments.has(arg.instId)) return wrong();
    return { ok: true, key: subKey(ch, arg.instId), arg: { channel: ch, instId: arg.instId } };
  }
  if (!PRIVATE_CHANNELS.has(ch)) return wrong();
  if (ch === 'orders' || ch === 'positions') {
    if (!arg.instType) return { ok: false, code: '60012', msg: 'Illegal request: instType is required' };
    const out: OkxWsArg = { channel: ch, instType: arg.instType };
    if (arg.instId !== undefined) out.instId = arg.instId;
    return { ok: true, key: subKey(ch, arg.instType), arg: out };
  }
  return { ok: true, key: subKey(ch, ''), arg: { channel: ch } };
}
