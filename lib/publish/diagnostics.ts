/**
 * Diagnostics of the connections (Meta for Threads and Instagram, Google for YouTube). Nothing here publishes anything.
 *  - The app: saved and readable, its return address leads to FERMA's public route, its keys (Threads checks them
 *    with an app token; Instagram has no such check, its keys are checked when an account connects).
 *  - Each account: token (readable, valid, expiry), granted permissions, profile, publishing quota, insights.
 *  - Pictures: a signed picture link opens through the public address; on the owner's request Meta itself
 *    fetches it into a hidden container. Such a container is never published and Meta drops it after 24 hours.
 * Docs (checked 2026-11-14): developers.facebook.com/documentation/threads/get-started/app-access-tokens,
 * /threads/troubleshooting/debug-access-token, /instagram-platform/instagram-api-with-instagram-login/business-login.
 */
import { and, desc, eq, isNotNull } from 'drizzle-orm';
import { getDb } from '@/db';
import { socialAccounts, sourceAssets, variantAssets } from '@/db/schema';
import { readSettings } from '../content/gudini-source';
import { AccountError, freshToken, readApp, tokenOf, type AppProvider } from './accounts';
import { INSTAGRAM_GRAPH, INSTAGRAM_SCOPES } from './instagram';
import { graphClient, str } from './meta';
import { signedMediaUrl } from './public-media';
import { adapterFor } from './registry';
import { THREADS_GRAPH, THREADS_SCOPES } from './threads';
import { PublishError, type MetaApp, type Provider, type Token } from './types';
import { YOUTUBE_SCOPES, youtubeCapabilities } from './youtube';

export type CheckState = 'ok' | 'warn' | 'fail' | 'skip';
export type Check = { key: string; label: string; state: CheckState; detail: string };
type MetaProvider = AppProvider;
type Account = typeof socialAccounts.$inferSelect;
export type MediaTest = { containerId: string; startedAt: string; state: 'pending' | 'ok' | 'fail'; detail: string };
export type AccountDiagnostics = { at: string; checks: Check[]; mediaTest?: MediaTest | null };

const NAMES: Record<MetaProvider, string> = { meta_threads: 'Threads', meta_instagram: 'Instagram', youtube: 'YouTube' };
const ROUTES: Record<MetaProvider, string> = { meta_threads: 'threads', meta_instagram: 'instagram', youtube: 'youtube' };
const day = (ms: number) => new Date(ms).toISOString().slice(0, 10);
const reason = (error: unknown) => error instanceof PublishError ? `${error.message}${error.detail ? ` (${error.detail})` : ''}` : error instanceof Error ? error.message : 'неизвестная ошибка';
const owned = async (owner: string, accountId: string) => {
  const [account] = await getDb().select().from(socialAccounts).where(and(eq(socialAccounts.id, accountId), eq(socialAccounts.owner, owner)));
  if (!account) throw new AccountError('Аккаунт не найден.', 404);
  return account;
};

/** The return address after login must open FERMA's public route; the network's answer shows it does. */
async function returnAddressChecks(app: MetaApp, provider: MetaProvider, base: string | null, request: typeof fetch): Promise<Check[]> {
  const checks: Check[] = [];
  const expected = base ? `${base}/oauth/${ROUTES[provider]}` : null;
  if (!expected) checks.push({ key: 'base', label: 'Публичный адрес', state: 'fail', detail: 'Не задан публичный адрес FERMA (Публикации → Настройки): без него соцсеть не вернёт вас после входа и не скачает картинки.' });
  else if (app.redirectUri !== expected) checks.push({ key: 'redirect', label: 'Адрес возврата', state: 'warn', detail: `Сохранён ${app.redirectUri}, а публичный адрес FERMA ведёт на ${expected}. Адрес должен совпадать здесь и в кабинете Meta.` });
  try {
    const response = await request(app.redirectUri, { redirect: 'manual', signal: AbortSignal.timeout(10_000) });
    const leadsHome = response.status === 302 && (response.headers.get('location') || '').includes('#accounts/oauth');
    checks.push(leadsHome
      ? { key: 'reachable', label: 'Адрес возврата открывается', state: 'ok', detail: 'Адрес открывается через интернет и ведёт в FERMA.' }
      : { key: 'reachable', label: 'Адрес возврата открывается', state: 'fail', detail: `Адрес открылся, но ведёт не в FERMA (ответ ${response.status}).` });
  } catch (error) {
    checks.push({ key: 'reachable', label: 'Адрес возврата открывается', state: 'fail', detail: `Адрес не открывается: ${error instanceof Error ? error.message : 'нет ответа'}.` });
  }
  return checks;
}

/** Threads gives an app token for the app's own keys: a refusal means the ID or the secret is wrong. */
async function threadsKeys(app: MetaApp, request: typeof fetch): Promise<Check> {
  try {
    const body = await graphClient(request, 15_000)('GET', `${THREADS_GRAPH}/oauth/access_token`, { client_id: app.appId, client_secret: app.appSecret, grant_type: 'client_credentials' });
    return str(body.access_token)
      ? { key: 'keys', label: 'Ключи приложения', state: 'ok', detail: 'Meta приняла ID и секрет приложения.' }
      : { key: 'keys', label: 'Ключи приложения', state: 'fail', detail: 'Meta не выдала токен приложения.' };
  } catch (error) {
    return { key: 'keys', label: 'Ключи приложения', state: 'fail', detail: `Meta не приняла ID или секрет: ${reason(error)}` };
  }
}

/** The «Аккаунты» checks of every app: Meta for Threads and Instagram, Google for YouTube. */
export async function appDiagnostics(owner: string, request: typeof fetch = fetch) {
  const settings = await readSettings(owner);
  const base = settings.publicBaseUrl?.replace(/\/+$/, '') || null;
  const result: { provider: MetaProvider; checks: Check[] }[] = [];
  for (const provider of ['meta_threads', 'meta_instagram', 'youtube'] as const) {
    let app: MetaApp | null;
    try { app = await readApp(owner, provider); }
    catch { result.push({ provider, checks: [{ key: 'app', label: 'Приложение', state: 'fail', detail: 'Секрет приложения не читается. Сохраните приложение заново.' }] }); continue; }
    if (!app) { result.push({ provider, checks: [{ key: 'app', label: 'Приложение', state: 'fail', detail: `${provider === 'youtube' ? 'Приложение Google' : 'Приложение Meta'} для ${NAMES[provider]} не добавлено.` }] }); continue; }
    const checks: Check[] = [{ key: 'app', label: 'Приложение', state: 'ok', detail: `ID ${app.appId}. Секрет хранится в зашифрованном виде.` }];
    checks.push(...await returnAddressChecks(app, provider, base, request));
    checks.push(provider === 'meta_threads' ? await threadsKeys(app, request)
      : { key: 'keys', label: 'Ключи приложения', state: 'skip', detail: provider === 'youtube' ? 'Google не даёт проверить ключи без входа. Они проверятся, когда вы подключите канал.' : 'Meta не даёт проверить ключи Instagram без входа. Они проверятся, когда вы подключите аккаунт.' });
    result.push({ provider, checks });
  }
  return { apps: result };
}

/** What the token itself says: Threads answers debug_token; Instagram listed the permissions when it gave the token. */
async function grantedScopes(owner: string, account: Account, token: Token, request: typeof fetch) {
  // Instagram and Google listed the permissions when they gave the token.
  if (account.provider === 'meta_instagram' || account.provider === 'youtube') return { scopes: token.scopes ?? null, dataAccessUntil: null as number | null };
  const app = await readApp(owner, 'meta_threads');
  if (!app) throw new AccountError('Приложение Meta для Threads не добавлено.', 409);
  const body = await graphClient(request, 15_000)('GET', `${THREADS_GRAPH}/v1.0/debug_token`, { input_token: token.accessToken, access_token: `TH|${app.appId}|${app.appSecret}` });
  const data = (body.data && typeof body.data === 'object' ? body.data : {}) as { is_valid?: boolean; scopes?: unknown; data_access_expires_at?: number };
  if (data.is_valid === false) throw new PublishError('Meta считает токен недействительным. Подключите аккаунт заново.', 'auth');
  return { scopes: Array.isArray(data.scopes) ? data.scopes.map(String) : null, dataAccessUntil: typeof data.data_access_expires_at === 'number' && data.data_access_expires_at > 0 ? data.data_access_expires_at * 1000 : null };
}

/** Account-level insights: the cheapest read that needs the insights permission. */
async function insightsCheck(account: Account, token: Token, request: typeof fetch): Promise<Check> {
  const graph = graphClient(request, 15_000);
  try {
    if (account.provider === 'meta_threads') await graph('GET', `${THREADS_GRAPH}/v1.0/${token.userId}/threads_insights`, { metric: 'views' }, token.accessToken);
    else await graph('GET', `${INSTAGRAM_GRAPH}/v27.0/${token.userId}/insights`, { metric: 'reach', period: 'day' }, token.accessToken);
    return { key: 'insights', label: 'Статистика', state: 'ok', detail: 'Статистика аккаунта читается.' };
  } catch (error) {
    return { key: 'insights', label: 'Статистика', state: 'fail', detail: `Статистика не читается: ${reason(error)}` };
  }
}

/** Every check of one account. The result is stored, so the screen shows it without asking Meta again. */
export async function diagnoseAccount(owner: string, accountId: string, request: typeof fetch = fetch, nowMs = Date.now()): Promise<AccountDiagnostics> {
  const account = await owned(owner, accountId);
  const checks: Check[] = [];
  const finish = async () => {
    const previous = account.diagnostics ? JSON.parse(account.diagnostics) as AccountDiagnostics : null;
    const result: AccountDiagnostics = { at: new Date(nowMs).toISOString(), checks, mediaTest: previous?.mediaTest ?? null };
    await getDb().update(socialAccounts).set({ diagnostics: JSON.stringify(result), lastCheckedAt: result.at }).where(eq(socialAccounts.id, account.id));
    return result;
  };
  if (account.status === 'disabled') { checks.push({ key: 'status', label: 'Аккаунт', state: 'skip', detail: 'Аккаунт отключён в FERMA.' }); return finish(); }
  let token: Token;
  try { token = await tokenOf(owner, account); }
  catch (error) { checks.push({ key: 'token', label: 'Токен', state: 'fail', detail: reason(error) }); return finish(); }
  const youtube = account.provider === 'youtube';
  if (youtube) {
    // Google's access token lives an hour and is renewed by itself; what matters is the refresh key.
    const until = token.refreshExpiresAt ? Date.parse(token.refreshExpiresAt) : null;
    checks.push(!token.refreshToken ? { key: 'token', label: 'Токен', state: 'fail', detail: 'Нет ключа продления. Подключите канал заново.' }
      : until === null ? { key: 'token', label: 'Токен', state: 'ok', detail: 'Ключ продления без срока: доступ продлевается сам каждый час.' }
      : { key: 'token', label: 'Токен', state: until - nowMs < 2 * 86_400_000 ? 'warn' : 'ok', detail: `Ключ продления действует до ${day(until)}: у приложения Google в режиме тестирования вход живёт 7 дней, потом канал подключают заново.` });
    if (!token.refreshToken || (until !== null && until <= nowMs)) return finish();
  } else if (token.expiresAt) {
    const left = Date.parse(token.expiresAt) - nowMs;
    const days = Math.floor(left / 86_400_000);
    checks.push(left <= 0 ? { key: 'token', label: 'Токен', state: 'fail', detail: `Токен истёк ${day(Date.parse(token.expiresAt))}. Подключите аккаунт заново.` }
      : { key: 'token', label: 'Токен', state: days < 3 ? 'warn' : 'ok', detail: `Действует до ${day(Date.parse(token.expiresAt))} (${days} дн.). FERMA продлевает его сама за 15 дней до конца.` });
    if (left <= 0) return finish();
  } else checks.push({ key: 'token', label: 'Токен', state: 'ok', detail: 'Токен без срока окончания.' });
  try { token = await freshToken(owner, account, request, nowMs); }
  catch (error) { checks.push({ key: 'refresh', label: 'Продление токена', state: 'fail', detail: reason(error) }); return finish(); }
  const adapter = adapterFor(account.provider as Provider, request);
  try {
    const remote = await adapter.checkConnection(token);
    const professional = account.provider !== 'meta_instagram' || ['BUSINESS', 'MEDIA_CREATOR', 'CREATOR'].includes((remote.accountType || '').toUpperCase());
    checks.push(youtube ? { key: 'profile', label: 'Канал', state: 'ok', detail: `«${remote.name || remote.username}»${remote.followers !== null && remote.followers !== undefined ? `, подписчиков: ${remote.followers}` : ''}.` }
      : professional ? { key: 'profile', label: 'Профиль', state: 'ok', detail: `@${remote.username}${remote.accountType ? ` (${remote.accountType})` : ''}.` }
      : { key: 'profile', label: 'Профиль', state: 'fail', detail: `@${remote.username}: не профессиональный аккаунт. Instagram публикует через API только бизнес-аккаунты и аккаунты авторов.` });
  } catch (error) { checks.push({ key: 'profile', label: 'Профиль', state: 'fail', detail: reason(error) }); return finish(); }
  try {
    const needed = account.provider === 'meta_threads' ? THREADS_SCOPES : youtube ? YOUTUBE_SCOPES : INSTAGRAM_SCOPES;
    const { scopes, dataAccessUntil } = await grantedScopes(owner, account, token, request);
    if (!scopes) checks.push({ key: 'scopes', label: 'Права', state: 'warn', detail: 'Список выданных прав неизвестен: аккаунт подключён до этой версии FERMA. Подключите его заново.' });
    else {
      const missing = needed.filter(scope => !scopes.includes(scope));
      checks.push(missing.length ? { key: 'scopes', label: 'Права', state: 'warn', detail: `Не выданы: ${missing.join(', ')}. Подключите аккаунт заново и разрешите их.` }
        : { key: 'scopes', label: 'Права', state: 'ok', detail: `Выданы все нужные: ${needed.join(', ')}.` });
    }
    // Meta's separate limit on data access (about 90 days after the last login): after it the owner logs in again.
    if (dataAccessUntil && dataAccessUntil - nowMs < 14 * 86_400_000) checks.push({ key: 'data_access', label: 'Доступ к данным', state: dataAccessUntil < nowMs ? 'fail' : 'warn', detail: `Meta закрывает доступ к данным аккаунта ${day(dataAccessUntil)}. До этого подключите аккаунт заново.` });
  } catch (error) { checks.push({ key: 'scopes', label: 'Права', state: error instanceof PublishError && error.kind === 'auth' ? 'fail' : 'warn', detail: `Права не проверены: ${reason(error)}` }); }
  // The publishing limit and the statistics below are Meta's; YouTube publishing comes with the video stage.
  if (youtube) { checks.push({ key: 'publish', label: 'Публикация', state: 'skip', detail: youtubeCapabilities.inactive! }); return finish(); }
  try {
    const quota = await adapter.quota(token);
    checks.push(quota ? { key: 'quota', label: 'Лимит публикаций', state: quota.used >= quota.total ? 'warn' : 'ok', detail: `Использовано ${quota.used} из ${quota.total} за последние 24 часа.` }
      : { key: 'quota', label: 'Лимит публикаций', state: 'warn', detail: 'Meta не сообщила лимит.' });
    if (quota) await getDb().update(socialAccounts).set({ quotaUsed: quota.used, quotaTotal: quota.total }).where(eq(socialAccounts.id, account.id));
  } catch (error) { checks.push({ key: 'quota', label: 'Лимит публикаций', state: 'fail', detail: `Лимит не читается (нужно право на публикацию): ${reason(error)}` }); }
  checks.push(await insightsCheck(account, token, request));
  if (account.pausedUntil && Date.parse(account.pausedUntil) > nowMs) checks.push({ key: 'pause', label: 'Пауза', state: 'warn', detail: `Соцсеть попросила подождать: публикации из аккаунта не уходят до ${account.pausedUntil.slice(11, 16)} UTC.` });
  return finish();
}

/** A real picture of the kind FERMA publishes: the latest card drawn by Gudini, or else Gudini's latest original JPEG. */
async function samplePicture(owner: string) {
  const db = getDb();
  const [drawn] = await db.select({ key: variantAssets.storageKey, contentType: variantAssets.contentType }).from(variantAssets).where(and(eq(variantAssets.owner, owner), eq(variantAssets.contentType, 'image/jpeg'))).orderBy(desc(variantAssets.createdAt)).limit(1);
  if (drawn) return drawn;
  const [original] = await db.select({ key: sourceAssets.storageKey, contentType: sourceAssets.contentType }).from(sourceAssets).where(and(eq(sourceAssets.owner, owner), eq(sourceAssets.status, 'stored'), eq(sourceAssets.contentType, 'image/jpeg'), isNotNull(sourceAssets.storageKey))).orderBy(desc(sourceAssets.createdAt)).limit(1);
  return original?.key ? { key: original.key, contentType: original.contentType } : null;
}

/** A signed link of a real picture opens through the public address (the way Meta will fetch it). */
export async function mediaLinkCheck(owner: string, request: typeof fetch = fetch, nowMs = Date.now()): Promise<Check> {
  const { publicBaseUrl } = await readSettings(owner);
  if (!publicBaseUrl) return { key: 'media', label: 'Картинки по ссылке', state: 'fail', detail: 'Не задан публичный адрес FERMA.' };
  const picture = await samplePicture(owner);
  if (!picture) return { key: 'media', label: 'Картинки по ссылке', state: 'skip', detail: 'Пока нет готовых карточек для проверки.' };
  try {
    const response = await request(await signedMediaUrl(publicBaseUrl, picture.key, picture.contentType, nowMs, 600), { signal: AbortSignal.timeout(15_000) });
    const type = response.headers.get('content-type') || '';
    const size = (await response.arrayBuffer()).byteLength;
    return response.ok && type.startsWith('image/') && size > 0
      ? { key: 'media', label: 'Картинки по ссылке', state: 'ok', detail: `Карточка открывается по публичной ссылке (${type}, ${Math.round(size / 1024)} КБ).` }
      : { key: 'media', label: 'Картинки по ссылке', state: 'fail', detail: `Ссылка ответила ${response.status}${type ? `, ${type}` : ''}.` };
  } catch (error) {
    return { key: 'media', label: 'Картинки по ссылке', state: 'fail', detail: `Ссылка не открывается: ${error instanceof Error ? error.message : 'нет ответа'}.` };
  }
}

async function storeMediaTest(account: Account, test: MediaTest) {
  const previous = account.diagnostics ? JSON.parse(account.diagnostics) as AccountDiagnostics : { at: new Date().toISOString(), checks: [] };
  await getDb().update(socialAccounts).set({ diagnostics: JSON.stringify({ ...previous, mediaTest: test }) }).where(eq(socialAccounts.id, account.id));
  return test;
}
/**
 * Asks Meta to fetch a real picture into a hidden container of this account. Nothing is published: the container
 * is never sent to threads_publish / media_publish and Meta drops it after 24 hours.
 */
export async function startMediaTest(owner: string, accountId: string, request: typeof fetch = fetch, nowMs = Date.now()) {
  const account = await owned(owner, accountId);
  if (account.status !== 'connected') throw new AccountError('Сначала подключите аккаунт.', 409);
  const { publicBaseUrl } = await readSettings(owner);
  if (!publicBaseUrl) throw new AccountError('Не задан публичный адрес FERMA (Публикации → Настройки).', 409);
  const picture = await samplePicture(owner);
  if (!picture) throw new AccountError('Пока нет готовых карточек для проверки.', 409);
  const token = await freshToken(owner, account, request, nowMs);
  const url = await signedMediaUrl(publicBaseUrl, picture.key, picture.contentType, nowMs, 3600);
  const graph = graphClient(request, 30_000);
  const body = account.provider === 'meta_threads'
    ? await graph('POST', `${THREADS_GRAPH}/v1.0/${token.userId}/threads`, { media_type: 'IMAGE', image_url: url }, token.accessToken)
    : await graph('POST', `${INSTAGRAM_GRAPH}/v27.0/${token.userId}/media`, { image_url: url }, token.accessToken);
  const containerId = str(body.id);
  if (!containerId) throw new PublishError('Meta не вернула номер контейнера.', 'temporary');
  return storeMediaTest(account, { containerId, startedAt: new Date(nowMs).toISOString(), state: 'pending', detail: 'Meta скачивает картинку.' });
}
/** Reads the hidden container's status: finished means Meta fetched and accepted the picture. */
export async function readMediaTest(owner: string, accountId: string, request: typeof fetch = fetch) {
  const account = await owned(owner, accountId);
  const test = account.diagnostics ? (JSON.parse(account.diagnostics) as AccountDiagnostics).mediaTest : null;
  if (!test) throw new AccountError('Проверка картинок ещё не запускалась.', 404);
  if (test.state !== 'pending') return test;
  const token = await freshToken(owner, account, request);
  const graph = graphClient(request, 15_000);
  const body = account.provider === 'meta_threads'
    ? await graph('GET', `${THREADS_GRAPH}/v1.0/${test.containerId}`, { fields: 'status,error_message' }, token.accessToken)
    : await graph('GET', `${INSTAGRAM_GRAPH}/v27.0/${test.containerId}`, { fields: 'status_code,status' }, token.accessToken);
  const status = str(body.status_code) || str(body.status);
  if (status === 'FINISHED') return storeMediaTest(account, { ...test, state: 'ok', detail: 'Meta скачала и приняла картинку. Контейнер не публикуется и удалится через 24 часа.' });
  if (status === 'ERROR' || status === 'EXPIRED') return storeMediaTest(account, { ...test, state: 'fail', detail: `Meta не приняла картинку: ${str(body.error_message) || str(body.status) || status}.` });
  return test;
}
