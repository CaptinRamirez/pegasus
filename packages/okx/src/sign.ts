import { createHmac } from 'node:crypto';

/** ISO-8601 timestamp with millisecond precision, e.g. 2020-12-08T09:08:57.715Z */
export function restTimestamp(now: number = Date.now()): string {
  return new Date(now).toISOString();
}

/** Unix seconds as a string, used by the WebSocket login. */
export function wsTimestamp(now: number = Date.now()): string {
  return Math.floor(now / 1000).toString();
}

function hmacBase64(secret: string, message: string): string {
  return createHmac('sha256', secret).update(message).digest('base64');
}

/**
 * REST signature: Base64(HMAC-SHA256(secret, timestamp + METHOD + requestPath + body)).
 * `requestPath` includes the query string; `body` is '' for GET.
 */
export function signRest(secret: string, timestamp: string, method: string, requestPath: string, body: string): string {
  return hmacBase64(secret, `${timestamp}${method.toUpperCase()}${requestPath}${body}`);
}

/** WebSocket login signature: Base64(HMAC-SHA256(secret, timestamp + 'GET' + '/users/self/verify')). */
export function signWsLogin(secret: string, timestamp: string): string {
  return hmacBase64(secret, `${timestamp}GET/users/self/verify`);
}

export interface OkxCredentials {
  apiKey: string;
  apiSecret: string;
  passphrase: string;
}

export function restAuthHeaders(creds: OkxCredentials, method: string, requestPath: string, body: string, now?: number): Record<string, string> {
  const ts = restTimestamp(now);
  return {
    'OK-ACCESS-KEY': creds.apiKey,
    'OK-ACCESS-SIGN': signRest(creds.apiSecret, ts, method, requestPath, body),
    'OK-ACCESS-TIMESTAMP': ts,
    'OK-ACCESS-PASSPHRASE': creds.passphrase,
  };
}

export function wsLoginArgs(creds: OkxCredentials, now?: number): { apiKey: string; passphrase: string; timestamp: string; sign: string } {
  const timestamp = wsTimestamp(now);
  return {
    apiKey: creds.apiKey,
    passphrase: creds.passphrase,
    timestamp,
    sign: signWsLogin(creds.apiSecret, timestamp),
  };
}
