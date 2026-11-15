/**
 * YouTube through the owner's own Google app (the one Gudini uses for Shorts). Connecting a channel: Google's
 * login, the long refresh key kept encrypted, the channel read back. Access tokens live an hour and are renewed
 * with the app's keys (accounts.freshToken). Publishing videos is the next stage: until then the adapter says so
 * instead of pretending.
 * Docs (checked 2026-11-15): developers.google.com/identity/protocols/oauth2/web-server,
 * developers.google.com/youtube/v3/docs/channels/list.
 */
import { expiresAt, str, type Fetch } from './meta';
import { PublishError, type Capabilities, type ErrorKind, type MetaApp, type PublisherAdapter, type RemoteAccount, type Token } from './types';

/** The same permissions Gudini asks for: upload, reading the channel, its statistics. */
export const YOUTUBE_SCOPES = ['https://www.googleapis.com/auth/youtube.upload', 'https://www.googleapis.com/auth/youtube.readonly', 'https://www.googleapis.com/auth/yt-analytics.readonly'];
const NOT_YET = 'Публикация видео в YouTube — следующий этап: пока канал только подключается.';
export const youtubeCapabilities: Capabilities = { formats: ['video'], maxText: 5000, minCarousel: 0, maxCarousel: 0, imageTypes: [], maxImageBytes: 0, nativeScheduling: true, insights: true, dailyLimit: 6, inactive: NOT_YET };
const TOKEN_URL = 'https://oauth2.googleapis.com/token';
/** Google's client ID: «<project number>-<letters>.apps.googleusercontent.com». */
export const GOOGLE_CLIENT_ID = /^\d{5,20}-[a-z0-9]{10,60}\.apps\.googleusercontent\.com$/;
const iso = (ms: number) => new Date(ms).toISOString();

/** One call to Google: a form to the token endpoint or a GET with the access token. Errors are read the FERMA way. */
async function google(request: Fetch, url: string, { form, token }: { form?: Record<string, string>; token?: string } = {}) {
  let response: Response;
  try {
    response = await request(url, {
      method: form ? 'POST' : 'GET',
      headers: { ...(form ? { 'Content-Type': 'application/x-www-form-urlencoded' } : {}), ...(token ? { Authorization: `Bearer ${token}` } : {}) },
      body: form ? new URLSearchParams(form).toString() : undefined,
      signal: AbortSignal.timeout(20_000), redirect: 'manual',
    });
  } catch { throw new PublishError('Нет связи с Google. Повторим позже.', 'temporary', 'network'); }
  const body = await response.json().catch(() => null) as Record<string, unknown> | null;
  if (response.ok && body) return body;
  const error = body?.error;
  const reason = typeof error === 'string' ? error : str((error as { errors?: { reason?: unknown }[] } | undefined)?.errors?.[0]?.reason);
  const message = typeof error === 'object' && error ? str((error as { message?: unknown }).message) : str(body?.error_description);
  const kind: ErrorKind = response.status === 401 || ['invalid_grant', 'unauthorized_client', 'invalid_client'].includes(reason) ? 'auth'
    : response.status === 429 || ['quotaExceeded', 'rateLimitExceeded', 'userRateLimitExceeded'].includes(reason) ? 'rate_limit'
    : response.status >= 500 ? 'temporary' : 'invalid_request';
  const text = kind === 'auth' ? 'Google не принял доступ: подключите канал заново.' : kind === 'rate_limit' ? 'Google просит подождать: исчерпан лимит запросов.' : 'Google не выполнил запрос.';
  throw new PublishError(text, kind, `${response.status}${reason ? ` ${reason}` : ''}${message ? `: ${message}` : ''}`.slice(0, 300));
}

/** Step 1 of connecting: Google's login with the account choice; offline access gives the refresh key. */
export function youtubeAuthorizeUrl(app: MetaApp, state: string) {
  const url = new URL('https://accounts.google.com/o/oauth2/v2/auth');
  url.search = new URLSearchParams({ client_id: app.appId, redirect_uri: app.redirectUri, response_type: 'code', scope: YOUTUBE_SCOPES.join(' '), access_type: 'offline', prompt: 'select_account consent', include_granted_scopes: 'true', state }).toString();
  return url.toString();
}

/** Step 2: the code from Google's return becomes an access token and the long refresh key. */
export async function youtubeExchangeCode(app: MetaApp, code: string, request: Fetch = fetch, nowMs = Date.now()): Promise<Token> {
  const body = await google(request, TOKEN_URL, { form: { code, client_id: app.appId, client_secret: app.appSecret, redirect_uri: app.redirectUri, grant_type: 'authorization_code' } });
  const accessToken = str(body.access_token);
  if (!accessToken) throw new PublishError('Google не выдал доступ.', 'auth');
  if (!str(body.refresh_token)) throw new PublishError('Google не выдал ключ продления. Уберите доступ FERMA в аккаунте Google (Безопасность → Сторонние приложения) и подключите канал снова.', 'invalid_request');
  return {
    accessToken, refreshToken: str(body.refresh_token), userId: '', expiresAt: expiresAt(body.expires_in, nowMs), obtainedAt: iso(nowMs),
    scopes: str(body.scope).split(' ').filter(Boolean), refreshExpiresAt: expiresAt(body.refresh_token_expires_in, nowMs),
  };
}

/** A fresh access token: the same one while more than 5 minutes are left (Google's live an hour). */
export async function youtubeRefresh(app: MetaApp, token: Token, request: Fetch = fetch, nowMs = Date.now()): Promise<Token> {
  if (token.expiresAt && Date.parse(token.expiresAt) - nowMs > 5 * 60_000) return token;
  if (!token.refreshToken) throw new PublishError('Нет ключа продления: подключите канал заново.', 'auth');
  const body = await google(request, TOKEN_URL, { form: { client_id: app.appId, client_secret: app.appSecret, refresh_token: token.refreshToken, grant_type: 'refresh_token' } });
  const accessToken = str(body.access_token);
  if (!accessToken) throw new PublishError('Google не продлил доступ. Подключите канал заново.', 'auth');
  const scopes = str(body.scope).split(' ').filter(Boolean);
  return { ...token, accessToken, refreshToken: str(body.refresh_token) || token.refreshToken, expiresAt: expiresAt(body.expires_in, nowMs), obtainedAt: iso(nowMs), scopes: scopes.length ? scopes : token.scopes };
}

/** The channel of the logged-in Google account (a brand account answers with its own channel). */
async function channelOf(request: Fetch, token: Token): Promise<RemoteAccount> {
  const body = await google(request, 'https://www.googleapis.com/youtube/v3/channels?part=snippet,statistics&mine=true', { token: token.accessToken });
  const channel = Array.isArray(body.items) ? body.items[0] as { id?: unknown; snippet?: { title?: unknown; customUrl?: unknown; thumbnails?: { default?: { url?: unknown } } }; statistics?: { subscriberCount?: unknown; hiddenSubscriberCount?: unknown } } : null;
  if (!channel || !str(channel.id)) throw new PublishError('У этого аккаунта Google нет канала YouTube. Создайте канал или выберите другой аккаунт при входе.', 'invalid_request');
  const title = str(channel.snippet?.title);
  const subscribers = Number(channel.statistics?.subscriberCount);
  return {
    id: str(channel.id), username: str(channel.snippet?.customUrl).replace(/^@/, '') || title, name: title || null, accountType: 'CHANNEL',
    followers: channel.statistics?.hiddenSubscriberCount === true || !Number.isFinite(subscribers) ? null : subscribers, picture: str(channel.snippet?.thumbnails?.default?.url) || null,
  };
}

export function youtubeAdapter(request: Fetch = fetch): PublisherAdapter {
  const notYet = async (): Promise<never> => { throw new PublishError(NOT_YET, 'not_available'); };
  return {
    provider: 'youtube', platform: 'youtube', capabilities: youtubeCapabilities,
    checkConnection: token => channelOf(request, token),
    listAccounts: async token => [await channelOf(request, token)],
    validate: () => NOT_YET,
    prepare: notYet, checkPrepared: notYet, publish: notYet,
    findRecent: async () => null, stats: async () => null, quota: async () => null,
    // Renewing needs the app's keys: accounts.freshToken() renews YouTube tokens with them.
    refresh: async token => token,
  };
}
