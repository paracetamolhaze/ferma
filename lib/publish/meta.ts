/**
 * Shared transport for Meta's Graph APIs (Threads and Instagram API with Instagram Login).
 * Only the transport and error reading are shared; each adapter builds its own requests.
 */
import { PublishError, type ErrorKind } from './types';

export type Fetch = typeof fetch;
type Params = Record<string, string | number | boolean | undefined | null>;
export type GraphCall = (method: 'GET' | 'POST', url: string, params: Params, token?: string) => Promise<Record<string, unknown>>;

const RATE_CODES = new Set([4, 17, 32, 613, 80001, 80002, 80006, 80008]);
const AUTH_CODES = new Set([102, 190, 10, 200, 3]);
// Instagram media fetch/format problems: the picture link, size or format is wrong.
const MEDIA_SUBCODES = new Set([2207003, 2207004, 2207005, 2207009, 2207010, 2207026, 2207050, 2207052, 36000, 36001, 36003, 36004]);

/** Reads Meta's error object and decides what FERMA should do about it. */
export function classifyGraphError(status: number, body: unknown): { kind: ErrorKind; message: string; detail: string } {
  const error = (body && typeof body === 'object' && 'error' in body ? (body as { error: Record<string, unknown> }).error : null) || {};
  const code = Number(error.code ?? 0), subcode = Number(error.error_subcode ?? 0);
  const text = String(error.error_user_msg || error.message || `HTTP ${status}`);
  const detail = `${status} code=${code}${subcode ? ` subcode=${subcode}` : ''}: ${text}`.slice(0, 500);
  if (AUTH_CODES.has(code) || (code >= 200 && code < 300) || status === 401) return { kind: 'auth', message: 'Доступ к аккаунту истёк или отозван. Подключите аккаунт заново.', detail };
  if (RATE_CODES.has(code) || status === 429) return { kind: 'rate_limit', message: 'Соцсеть ограничила частоту запросов. Повторим позже.', detail };
  if (MEDIA_SUBCODES.has(subcode) || code === 9004 || code === 36003) return { kind: 'invalid_media', message: `Соцсеть не приняла картинку: ${text}`, detail };
  if (code === 9007 || error.is_transient === true || status >= 500 || code === 1 || code === 2) return { kind: 'temporary', message: 'Соцсеть временно не ответила. Повторим позже.', detail };
  if (code === 100 || status === 400) return { kind: 'invalid_request', message: `Соцсеть отклонила публикацию: ${text}`, detail };
  return { kind: 'temporary', message: `Ошибка соцсети: ${text}`, detail };
}

/**
 * How long Meta asks to wait: the Retry-After header, or estimated_time_to_regain_access (minutes) in the
 * X-Business-Use-Case-Usage header that Meta sends when an account or app is throttled.
 */
export function retryAfterOf(headers: Headers, nowMs = Date.now()) {
  let wait = 0;
  const retry = headers.get('retry-after')?.trim();
  if (retry) wait = /^\d+$/.test(retry) ? Number(retry) * 1000 : Math.max(0, Date.parse(retry) - nowMs) || 0;
  for (const name of ['x-business-use-case-usage', 'x-app-usage', 'x-ad-account-usage']) {
    const raw = headers.get(name);
    if (!raw) continue;
    try { wait = Math.max(wait, regainMinutes(JSON.parse(raw)) * 60_000); } catch { /* not JSON */ }
  }
  return wait || null;
}
/** The largest estimated_time_to_regain_access anywhere in a usage header (it sits inside per-object lists). */
function regainMinutes(value: unknown): number {
  if (Array.isArray(value)) return value.reduce((best: number, inner) => Math.max(best, regainMinutes(inner)), 0);
  if (!value || typeof value !== 'object') return 0;
  let best = 0;
  for (const [key, inner] of Object.entries(value)) best = Math.max(best, key === 'estimated_time_to_regain_access' && typeof inner === 'number' ? inner : regainMinutes(inner));
  return best;
}
/** A tiny Graph API client. Tokens never appear in thrown messages. */
export function graphClient(request: Fetch = fetch, timeoutMs = 30_000): GraphCall {
  return async (method, url, params, token) => {
    const all: Record<string, string> = {};
    for (const [key, value] of Object.entries(params)) if (value !== undefined && value !== null) all[key] = String(value);
    if (token) all.access_token = token;
    const query = new URLSearchParams(all).toString();
    let response: Response;
    try {
      response = method === 'GET'
        ? await request(`${url}${url.includes('?') ? '&' : '?'}${query}`, { method, signal: AbortSignal.timeout(timeoutMs), redirect: 'manual' })
        : await request(url, { method, body: query, headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, signal: AbortSignal.timeout(timeoutMs), redirect: 'manual' });
    } catch {
      throw new PublishError('Нет связи с соцсетью. Повторим позже.', 'temporary', 'network');
    }
    const body = await response.json().catch(() => null);
    if (!response.ok || (body && typeof body === 'object' && 'error' in body)) {
      const { kind, message, detail } = classifyGraphError(response.status, body);
      throw new PublishError(token ? message.replaceAll(token, '[скрыт]') : message, kind, token ? detail.replaceAll(token, '[скрыт]') : detail, retryAfterOf(response.headers));
    }
    if (!body || typeof body !== 'object') throw new PublishError('Соцсеть вернула непонятный ответ.', 'temporary', `HTTP ${response.status}`);
    return body as Record<string, unknown>;
  };
}

export const str = (value: unknown) => typeof value === 'string' ? value : typeof value === 'number' ? String(value) : '';
/** Values of an insights answer: `values[0].value` or `total_value.value`. */
export function readInsights(body: Record<string, unknown>) {
  const result: Record<string, number> = {};
  for (const entry of Array.isArray(body.data) ? body.data as Record<string, unknown>[] : []) {
    const name = str(entry.name);
    const values = Array.isArray(entry.values) ? entry.values as { value?: unknown }[] : [];
    const raw = values.length ? values[values.length - 1].value : (entry.total_value as { value?: unknown } | undefined)?.value;
    if (name && typeof raw === 'number') result[name] = raw;
  }
  return result;
}
/** Text comparison for finding a post whose publish answer was lost. */
export const sameText = (a: string, b: string) => a.replace(/\s+/g, ' ').trim().toLowerCase() === b.replace(/\s+/g, ' ').trim().toLowerCase();
/** Refresh a long-lived token when it is older than a day and has less than this many days left. */
export const REFRESH_WITHIN_MS = 15 * 86_400_000;
export const tokenDue = (token: { expiresAt: string | null; obtainedAt: string }, nowMs: number) =>
  Boolean(token.expiresAt) && Date.parse(token.expiresAt!) - nowMs < REFRESH_WITHIN_MS && nowMs - Date.parse(token.obtainedAt) > 86_400_000;
export const expiresAt = (seconds: unknown, nowMs: number) => typeof seconds === 'number' && seconds > 0 ? new Date(nowMs + seconds * 1000).toISOString() : null;
