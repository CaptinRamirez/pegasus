import { createHmac, timingSafeEqual } from 'node:crypto';
import type { IncomingHttpHeaders } from 'node:http';
import type { MockCredentials } from './types.js';

/** How far a request timestamp may drift from the server clock (OKX uses 30 s). */
export const TIMESTAMP_TOLERANCE_MS = 30_000;

export interface AuthError {
  code: string;
  msg: string;
}

function hmacBase64(secret: string, message: string): string {
  return createHmac('sha256', secret).update(message).digest('base64');
}

export function signRest(secret: string, timestamp: string, method: string, requestPath: string, body: string): string {
  return hmacBase64(secret, `${timestamp}${method.toUpperCase()}${requestPath}${body}`);
}

export function signWsLogin(secret: string, timestamp: string): string {
  return hmacBase64(secret, `${timestamp}GET/users/self/verify`);
}

function safeEqual(a: string, b: string): boolean {
  const ab = Buffer.from(a);
  const bb = Buffer.from(b);
  return ab.length === bb.length && timingSafeEqual(ab, bb);
}

function header(headers: IncomingHttpHeaders, name: string): string | undefined {
  const v = headers[name];
  if (Array.isArray(v)) return v[0];
  return v;
}

/**
 * Verifies the OK-ACCESS-* headers of a private REST request exactly as OKX
 * does: prehash = timestamp + METHOD + requestPath(with query) + body.
 * Returns null when the request is authentic.
 */
export function verifyRestAuth(creds: MockCredentials, headers: IncomingHttpHeaders, method: string, requestPath: string, body: string, now: number = Date.now()): AuthError | null {
  const key = header(headers, 'ok-access-key');
  const sign = header(headers, 'ok-access-sign');
  const ts = header(headers, 'ok-access-timestamp');
  const pass = header(headers, 'ok-access-passphrase');
  if (!key) return { code: '50103', msg: 'Request header "OK-ACCESS-KEY" cannot be empty.' };
  if (!sign) return { code: '50114', msg: 'Request header "OK-ACCESS-SIGN" cannot be empty.' };
  if (!ts) return { code: '50112', msg: 'Request header "OK-ACCESS-TIMESTAMP" cannot be empty.' };
  if (!pass) return { code: '50104', msg: 'Request header "OK-ACCESS-PASSPHRASE" cannot be empty.' };
  if (!safeEqual(key, creds.apiKey)) return { code: '50111', msg: 'Invalid OK-ACCESS-KEY.' };
  if (!safeEqual(pass, creds.passphrase)) return { code: '50105', msg: 'Invalid OK-ACCESS-PASSPHRASE.' };
  const parsed = Date.parse(ts);
  if (Number.isNaN(parsed)) return { code: '50107', msg: 'Invalid OK-ACCESS-TIMESTAMP.' };
  if (Math.abs(now - parsed) > TIMESTAMP_TOLERANCE_MS) return { code: '50102', msg: 'Timestamp request expired.' };
  const expected = signRest(creds.apiSecret, ts, method, requestPath, body);
  if (!safeEqual(sign, expected)) return { code: '50113', msg: 'Invalid Sign.' };
  return null;
}

export interface WsLoginArg {
  apiKey?: unknown;
  passphrase?: unknown;
  timestamp?: unknown;
  sign?: unknown;
}

/** Verifies a WebSocket login arg: prehash = timestampSeconds + 'GET' + '/users/self/verify'. */
export function verifyWsLogin(creds: MockCredentials, arg: WsLoginArg, now: number = Date.now()): AuthError | null {
  const { apiKey, passphrase, timestamp, sign } = arg;
  if (typeof apiKey !== 'string' || typeof passphrase !== 'string' || typeof timestamp !== 'string' || typeof sign !== 'string') {
    return { code: '60009', msg: 'Login failed.' };
  }
  if (!safeEqual(apiKey, creds.apiKey) || !safeEqual(passphrase, creds.passphrase)) return { code: '60009', msg: 'Login failed.' };
  const tsNum = Number(timestamp);
  if (!Number.isFinite(tsNum)) return { code: '60009', msg: 'Login failed.' };
  if (Math.abs(now / 1000 - tsNum) > TIMESTAMP_TOLERANCE_MS / 1000) return { code: '60009', msg: 'Login failed.' };
  if (!safeEqual(sign, signWsLogin(creds.apiSecret, timestamp))) return { code: '60009', msg: 'Login failed.' };
  return null;
}
