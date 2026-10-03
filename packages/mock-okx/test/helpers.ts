import { createHmac } from 'node:crypto';
import WebSocket from 'ws';
import { startMockOkx } from '../src/index.js';
import type { MockCredentials, MockOkxHandle, MockOkxOptions } from '../src/index.js';

export const CREDS: MockCredentials = { apiKey: 'test-key', apiSecret: 'test-secret', passphrase: 'test-pass' };

export function start(opts: MockOkxOptions = {}): Promise<MockOkxHandle> {
  return startMockOkx({ port: 0, tickIntervalMs: 0, seed: 1234, ...opts });
}

export interface Envelope<T = unknown> {
  code: string;
  msg: string;
  data: T[];
  status: number;
}

/** Signs exactly like packages/okx/src/sign.ts and performs the request. */
export async function rest<T = Record<string, string>>(
  h: MockOkxHandle,
  method: 'GET' | 'POST',
  requestPath: string,
  body?: unknown,
  creds?: MockCredentials,
  tweak: { sign?: string; timestamp?: string; omit?: string[] } = {},
): Promise<Envelope<T>> {
  const bodyText = method === 'POST' && body !== undefined ? JSON.stringify(body) : '';
  const headers: Record<string, string> = { 'Content-Type': 'application/json' };
  if (creds) {
    const ts = tweak.timestamp ?? new Date().toISOString();
    const sign = tweak.sign ?? createHmac('sha256', creds.apiSecret).update(`${ts}${method}${requestPath}${bodyText}`).digest('base64');
    headers['OK-ACCESS-KEY'] = creds.apiKey;
    headers['OK-ACCESS-SIGN'] = sign;
    headers['OK-ACCESS-TIMESTAMP'] = ts;
    headers['OK-ACCESS-PASSPHRASE'] = creds.passphrase;
    for (const k of tweak.omit ?? []) delete headers[k];
  }
  const init: RequestInit = { method, headers };
  if (method === 'POST') init.body = bodyText;
  const res = await fetch(`${h.restUrl}${requestPath}`, init);
  const json = (await res.json()) as { code: string; msg: string; data: T[] };
  return { ...json, status: res.status };
}

export function wsLoginArgs(creds: MockCredentials, now = Date.now()): { apiKey: string; passphrase: string; timestamp: string; sign: string } {
  const timestamp = Math.floor(now / 1000).toString();
  const sign = createHmac('sha256', creds.apiSecret).update(`${timestamp}GET/users/self/verify`).digest('base64');
  return { apiKey: creds.apiKey, passphrase: creds.passphrase, timestamp, sign };
}

interface Waiter {
  pred: (m: unknown, text: string) => boolean;
  resolve: (m: unknown) => void;
  timer: NodeJS.Timeout;
}

/** Minimal WebSocket client that buffers messages so tests can await specific ones. */
export class WsProbe {
  private readonly buffer: Array<{ text: string; json: unknown }> = [];
  private readonly waiters: Waiter[] = [];

  private constructor(private readonly ws: WebSocket) {
    ws.on('message', (raw) => {
      const text = raw.toString();
      let json: unknown = text;
      try {
        json = JSON.parse(text);
      } catch {
        /* text frame such as 'pong' */
      }
      for (let i = 0; i < this.waiters.length; i++) {
        const w = this.waiters[i];
        if (w && w.pred(json, text)) {
          clearTimeout(w.timer);
          this.waiters.splice(i, 1);
          w.resolve(json);
          return;
        }
      }
      this.buffer.push({ text, json });
    });
  }

  static connect(url: string): Promise<WsProbe> {
    return new Promise((resolve, reject) => {
      const ws = new WebSocket(url);
      ws.once('open', () => resolve(new WsProbe(ws)));
      ws.once('error', reject);
    });
  }

  send(payload: unknown): void {
    this.ws.send(typeof payload === 'string' ? payload : JSON.stringify(payload));
  }

  /** Resolves with the first buffered or future message matching `pred`. */
  next<T = Record<string, unknown>>(pred: (m: unknown, text: string) => boolean, timeoutMs = 4000): Promise<T> {
    const idx = this.buffer.findIndex((b) => pred(b.json, b.text));
    if (idx >= 0) {
      const [hit] = this.buffer.splice(idx, 1);
      return Promise.resolve(hit?.json as T);
    }
    return new Promise<T>((resolve, reject) => {
      const timer = setTimeout(() => {
        const i = this.waiters.findIndex((w) => w.resolve === (resolve as unknown));
        if (i >= 0) this.waiters.splice(i, 1);
        reject(new Error(`timed out waiting for ws message after ${timeoutMs}ms`));
      }, timeoutMs);
      this.waiters.push({ pred, resolve: resolve as (m: unknown) => void, timer });
    });
  }

  close(): Promise<void> {
    return new Promise((resolve) => {
      this.ws.once('close', () => resolve());
      this.ws.close();
    });
  }
}

export function isEvent(event: string, channel?: string): (m: unknown) => boolean {
  return (m) => {
    const o = m as { event?: string; arg?: { channel?: string } };
    return o?.event === event && (channel === undefined || o.arg?.channel === channel);
  };
}

export function isData(channel: string, action?: string): (m: unknown) => boolean {
  return (m) => {
    const o = m as { event?: string; arg?: { channel?: string }; action?: string; data?: unknown[] };
    return o?.event === undefined && o?.arg?.channel === channel && Array.isArray(o.data) && (action === undefined || o.action === action);
  };
}
