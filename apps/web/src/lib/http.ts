import type { ApiResponse } from '@pegasus/shared';

export const TOKEN_KEY = 'pegasus.token';

export function readStoredToken(): string | null {
  try {
    return localStorage.getItem(TOKEN_KEY);
  } catch {
    return null;
  }
}

export function writeStoredToken(token: string | null): void {
  try {
    if (token === null) localStorage.removeItem(TOKEN_KEY);
    else localStorage.setItem(TOKEN_KEY, token);
  } catch {
    // storage unavailable (private mode etc.) – the in-memory token still works for this session
  }
}

export class ApiError extends Error {
  readonly code: string;
  readonly details: Record<string, unknown> | undefined;
  readonly status: number;

  constructor(code: string, message: string, details: Record<string, unknown> | undefined, status: number) {
    super(message);
    this.name = 'ApiError';
    this.code = code;
    this.details = details;
    this.status = status;
  }
}

export function isApiError(e: unknown): e is ApiError {
  return e instanceof ApiError;
}

export function errorMessage(e: unknown): string {
  if (isApiError(e)) return `${e.code}: ${e.message}`;
  if (e instanceof Error) return e.message;
  return String(e);
}

export type QueryParams = Record<string, string | number | boolean | undefined>;

export interface HttpOptions {
  method?: 'GET' | 'POST';
  body?: unknown;
  query?: QueryParams;
  /** Overrides the token from localStorage (used to validate a token before storing it). */
  token?: string;
  signal?: AbortSignal;
}

function buildUrl(path: string, query: QueryParams | undefined): string {
  if (query === undefined) return path;
  const params = new URLSearchParams();
  for (const [k, v] of Object.entries(query)) {
    if (v !== undefined) params.set(k, String(v));
  }
  const qs = params.toString();
  return qs.length > 0 ? `${path}?${qs}` : path;
}

function isEnvelope(v: unknown): v is ApiResponse<unknown> {
  if (typeof v !== 'object' || v === null) return false;
  const o = v as { ok?: unknown; error?: unknown };
  if (o.ok === true) return 'data' in o;
  if (o.ok === false) {
    const err = o.error as { code?: unknown; message?: unknown } | undefined;
    return typeof err === 'object' && err !== null && typeof err.code === 'string' && typeof err.message === 'string';
  }
  return false;
}

/**
 * Fetch wrapper: attaches the bearer token, unwraps the ApiResponse envelope and
 * throws ApiError on ok=false, non-2xx or network failure.
 */
export async function http<T>(path: string, opts: HttpOptions = {}): Promise<T> {
  const headers: Record<string, string> = { Accept: 'application/json' };
  const token = opts.token ?? readStoredToken();
  if (token !== null && token !== '') headers['Authorization'] = `Bearer ${token}`;
  if (opts.body !== undefined) headers['Content-Type'] = 'application/json';

  let res: Response;
  try {
    res = await fetch(buildUrl(path, opts.query), {
      method: opts.method ?? (opts.body !== undefined ? 'POST' : 'GET'),
      headers,
      body: opts.body !== undefined ? JSON.stringify(opts.body) : undefined,
      signal: opts.signal,
    });
  } catch (e) {
    if (e instanceof DOMException && e.name === 'AbortError') throw e;
    throw new ApiError('NETWORK', e instanceof Error ? e.message : 'network error', undefined, 0);
  }

  const text = await res.text();
  let payload: unknown = null;
  if (text.length > 0) {
    try {
      payload = JSON.parse(text);
    } catch {
      payload = null;
    }
  }

  if (isEnvelope(payload)) {
    if (!payload.ok) throw new ApiError(payload.error.code, payload.error.message, payload.error.details, res.status);
    if (!res.ok) throw new ApiError('INTERNAL', `HTTP ${res.status}`, undefined, res.status);
    return payload.data as T;
  }
  const code = res.status === 401 ? 'UNAUTHORIZED' : res.status === 404 ? 'NOT_FOUND' : 'INTERNAL';
  throw new ApiError(code, `HTTP ${res.status} ${res.statusText}`.trim(), undefined, res.status);
}
