/**
 * Social accounts connected through the owner's own apps: Meta for Threads and Instagram, Google for YouTube.
 * App settings, OAuth, encrypted tokens, connection checks and token renewal. Every account keeps its own token;
 * nothing is shared between accounts.
 */
import { and, asc, eq, inArray, lt, ne } from 'drizzle-orm';
import { getDb } from '@/db';
import { oauthStates, profiles, providerApps, publications, socialAccounts } from '@/db/schema';
import { openSecret, sealSecret } from '../content/secrets';
import { adapterFor, PROVIDERS } from './registry';
import { instagramAuthorizeUrl, instagramExchangeCode } from './instagram';
import { threadsAuthorizeUrl, threadsExchangeCode } from './threads';
import { GOOGLE_CLIENT_ID, youtubeAuthorizeUrl, youtubeExchangeCode, youtubeRefresh } from './youtube';
import { PublishError, type MetaApp, type Provider, type Token } from './types';

export class AccountError extends Error {
  constructor(message: string, readonly status = 400) { super(message); }
}
const now = () => new Date().toISOString();
/** Networks connected through the owner's own app (TikTok goes through Zernio). */
export type AppProvider = 'meta_threads' | 'meta_instagram' | 'youtube';
const NETWORK: Record<AppProvider, string> = { meta_threads: 'Threads', meta_instagram: 'Instagram', youtube: 'YouTube' };
const appName = (provider: AppProvider) => provider === 'youtube' ? 'Приложение Google для YouTube' : `Приложение Meta для ${NETWORK[provider]}`;
const STATE_TTL_MS = 15 * 60_000;

export async function readApp(owner: string, provider: AppProvider): Promise<MetaApp | null> {
  const [row] = await getDb().select().from(providerApps).where(and(eq(providerApps.owner, owner), eq(providerApps.provider, provider)));
  if (!row) return null;
  return { appId: row.appId, appSecret: await openSecret(owner, `app:${provider}`, row.encryptedSecret), redirectUri: row.redirectUri };
}
/** Saves the owner's app for a network. The secret is stored encrypted and never sent to the browser. */
export async function saveApp(owner: string, provider: AppProvider, input: { appId: string; appSecret?: string | null; redirectUri: string }) {
  if (provider === 'youtube' ? !GOOGLE_CLIENT_ID.test(input.appId.trim()) : !/^\d{5,25}$/.test(input.appId.trim())) {
    throw new AccountError(provider === 'youtube' ? 'ID клиента Google выглядит как 123456-abc….apps.googleusercontent.com (Google Cloud → Google Auth Platform → Клиенты).' : 'ID приложения состоит из цифр (его видно в кабинете Meta for Developers).');
  }
  let redirect: URL;
  try { redirect = new URL(input.redirectUri.trim()); } catch { throw new AccountError('Адрес возврата должен быть полным, например https://ваш-домен/oauth/threads.'); }
  if (redirect.protocol !== 'https:') throw new AccountError('Адрес возврата должен начинаться с https://.');
  const existing = await readApp(owner, provider).catch(() => null);
  const secret = input.appSecret?.trim() || existing?.appSecret || '';
  if (secret.length < 16) throw new AccountError('Добавьте секрет приложения.');
  const encryptedSecret = await sealSecret(owner, `app:${provider}`, secret);
  const values = { appId: input.appId.trim(), encryptedSecret, redirectUri: redirect.toString(), updatedAt: now() };
  await getDb().insert(providerApps).values({ id: crypto.randomUUID(), owner, provider, ...values }).onConflictDoUpdate({ target: [providerApps.owner, providerApps.provider], set: values });
  return { ok: true };
}

/** Step 1 of connecting: a one-time state bound to the profile, and the login page of the network. */
export async function startConnect(owner: string, profileId: string, provider: AppProvider) {
  const db = getDb();
  const [profile] = await db.select({ id: profiles.id }).from(profiles).where(and(eq(profiles.id, profileId), eq(profiles.owner, owner)));
  if (!profile) throw new AccountError('Профиль не найден.', 404);
  const app = await readApp(owner, provider);
  if (!app) throw new AccountError(`Сначала добавьте ${appName(provider).toLowerCase()} в «Аккаунтах».`, 409);
  await db.delete(oauthStates).where(lt(oauthStates.expiresAt, now()));
  const state = `${{ meta_threads: 'th', meta_instagram: 'ig', youtube: 'yt' }[provider]}_${crypto.randomUUID().replace(/-/g, '')}`;
  await db.insert(oauthStates).values({ state, owner, profileId, provider, createdAt: now(), expiresAt: new Date(Date.now() + STATE_TTL_MS).toISOString() });
  return { url: provider === 'meta_threads' ? threadsAuthorizeUrl(app, state) : provider === 'meta_instagram' ? instagramAuthorizeUrl(app, state) : youtubeAuthorizeUrl(app, state) };
}

/** Step 2: the network sent the owner back with a code. Exchanges it, checks the account and stores its token. */
export async function finishConnect(owner: string, state: string, code: string, request: typeof fetch = fetch) {
  const db = getDb();
  const [saved] = await db.select().from(oauthStates).where(and(eq(oauthStates.state, state), eq(oauthStates.owner, owner)));
  await db.delete(oauthStates).where(eq(oauthStates.state, state));
  if (!saved || Date.parse(saved.expiresAt) < Date.now()) throw new AccountError('Ссылка входа устарела. Нажмите «Подключить» ещё раз.', 410);
  const provider = saved.provider as AppProvider;
  const app = await readApp(owner, provider);
  if (!app) throw new AccountError(`${appName(provider)} не настроено.`, 409);
  let token: Token;
  try { token = provider === 'meta_threads' ? await threadsExchangeCode(app, code, request) : provider === 'meta_instagram' ? await instagramExchangeCode(app, code, request) : await youtubeExchangeCode(app, code, request); }
  catch (error) { throw new AccountError(error instanceof PublishError ? `${error.message}${error.detail ? ` (${error.detail})` : ''}` : 'Соцсеть не выдала доступ.', 502); }
  const adapter = adapterFor(provider, request);
  let account;
  try { account = await adapter.checkConnection(token); }
  catch (error) { throw new AccountError(error instanceof PublishError ? `${error.message}${error.detail ? ` (${error.detail})` : ''}` : 'Аккаунт не прочитан.', 502); }
  if (provider === 'meta_instagram' && account.accountType && !['BUSINESS', 'MEDIA_CREATOR', 'CREATOR'].includes(account.accountType.toUpperCase())) {
    throw new AccountError('Instagram публикует через API только профессиональные аккаунты (бизнес или автор). Переключите тип аккаунта в Instagram и подключите снова.', 409);
  }
  const [taken] = await db.select({ profileId: socialAccounts.profileId }).from(socialAccounts).where(and(eq(socialAccounts.owner, owner), eq(socialAccounts.provider, provider), eq(socialAccounts.remoteId, account.id)));
  if (taken && taken.profileId !== saved.profileId) throw new AccountError('Этот аккаунт уже подключён к другому профилю FERMA.', 409);
  const id = crypto.randomUUID();
  const encryptedToken = await sealSecret(owner, `account:${provider}:${account.id}`, JSON.stringify(token));
  const platform = PROVIDERS.find(entry => entry.provider === provider)!.platform;
  const values = { remoteId: account.id, username: account.username, name: account.name || null, accountType: account.accountType || null, followers: account.followers ?? null, encryptedToken, tokenExpiresAt: accessUntil(provider, token), tokenObtainedAt: token.obtainedAt, status: 'connected', error: null, lastCheckedAt: now(), updatedAt: now() };
  await db.insert(socialAccounts).values({ id, owner, profileId: saved.profileId, platform, provider, createdAt: now(), ...values })
    .onConflictDoUpdate({ target: [socialAccounts.profileId, socialAccounts.provider], set: values });
  return { profileId: saved.profileId, provider, username: account.username };
}

type Account = typeof socialAccounts.$inferSelect;
/**
 * Until when the owner's access lasts, as the screens show it: Meta's token itself; for YouTube the refresh key
 * (Google's access token lives only an hour and is renewed by itself), null when Google set it no end.
 */
const accessUntil = (provider: string, token: Token) => provider === 'youtube' ? token.refreshExpiresAt ?? null : token.expiresAt;
export async function tokenOf(owner: string, account: Account): Promise<Token> {
  try { return JSON.parse(await openSecret(owner, `account:${account.provider}:${account.remoteId}`, account.encryptedToken)) as Token; }
  catch { throw new AccountError('Токен аккаунта не читается. Подключите аккаунт заново.', 409); }
}
async function storeToken(owner: string, account: Account, token: Token) {
  const encryptedToken = await sealSecret(owner, `account:${account.provider}:${account.remoteId}`, JSON.stringify(token));
  // An account removed meanwhile keeps its empty token.
  await getDb().update(socialAccounts).set({ encryptedToken, tokenExpiresAt: accessUntil(account.provider, token), tokenObtainedAt: token.obtainedAt, updatedAt: now() }).where(and(eq(socialAccounts.id, account.id), ne(socialAccounts.status, 'disabled')));
}
/** A token that is about to run out is renewed; an account whose token was refused is marked for reconnection. */
export async function freshToken(owner: string, account: Account, request: typeof fetch = fetch, nowMs = Date.now()) {
  const token = await tokenOf(owner, account);
  const until = accessUntil(account.provider, token);
  if (until && Date.parse(until) < nowMs) {
    await getDb().update(socialAccounts).set({ status: 'expired', error: 'Доступ истёк. Подключите аккаунт заново.', updatedAt: now() }).where(eq(socialAccounts.id, account.id));
    throw new AccountError('Доступ к аккаунту истёк. Подключите его заново.', 409);
  }
  try {
    let fresh: Token;
    if (account.provider === 'youtube') {
      // Google renews with the app's own keys.
      const app = await readApp(owner, 'youtube');
      if (!app) throw new AccountError('Приложение Google для YouTube не добавлено.', 409);
      fresh = await youtubeRefresh(app, token, request, nowMs);
    } else fresh = await adapterFor(account.provider as Provider, request).refresh(token, nowMs);
    // A renewal may keep the same token string with a new expiry: whatever was renewed is stored.
    if (fresh !== token) await storeToken(owner, account, fresh);
    return fresh;
  } catch (error) {
    if (error instanceof PublishError && error.kind === 'auth') {
      await getDb().update(socialAccounts).set({ status: 'expired', error: error.message, updatedAt: now() }).where(eq(socialAccounts.id, account.id));
    }
    throw error;
  }
}

/** Checks every connected account: token alive, account reachable, publishing limit used. */
export async function checkAccounts(owner: string, request: typeof fetch = fetch, nowMs = Date.now()) {
  const db = getDb();
  const rows = await db.select().from(socialAccounts).where(eq(socialAccounts.owner, owner)).orderBy(asc(socialAccounts.lastCheckedAt));
  const changes = [];
  for (const account of rows) {
    if (account.status === 'disabled') continue;
    try {
      const token = await freshToken(owner, account, request, nowMs);
      const adapter = adapterFor(account.provider as Provider, request);
      const remote = await adapter.checkConnection(token);
      const quota = await adapter.quota(token).catch(() => null);
      // Written only if nobody changed the account during the check (the owner may have disabled or removed it).
      const updated = await db.update(socialAccounts).set({ status: 'connected', error: null, username: remote.username || account.username, followers: remote.followers ?? account.followers, quotaUsed: quota?.used ?? null, quotaTotal: quota?.total ?? null, lastCheckedAt: new Date(nowMs).toISOString(), updatedAt: now() })
        .where(and(eq(socialAccounts.id, account.id), eq(socialAccounts.status, account.status))).returning({ id: socialAccounts.id });
      if (updated.length && account.status !== 'connected') changes.push({ id: account.id, status: 'connected' });
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Проверка не удалась.';
      const status = error instanceof PublishError && error.kind === 'auth' ? 'expired' : error instanceof AccountError && error.status === 409 ? 'expired' : account.status === 'connected' ? 'connected' : 'error';
      const updated = await db.update(socialAccounts).set({ status, error: message.slice(0, 300), lastCheckedAt: new Date(nowMs).toISOString(), updatedAt: now() })
        .where(and(eq(socialAccounts.id, account.id), inArray(socialAccounts.status, [account.status, 'expired']))).returning({ id: socialAccounts.id });
      if (updated.length && status !== account.status) changes.push({ id: account.id, status });
    }
  }
  return { checked: rows.length, changes };
}

export async function setAccountEnabled(owner: string, accountId: string, enabled: boolean) {
  const changed = await getDb().update(socialAccounts).set({ status: enabled ? 'connected' : 'disabled', updatedAt: now() }).where(and(eq(socialAccounts.id, accountId), eq(socialAccounts.owner, owner))).returning({ id: socialAccounts.id });
  if (!changed.length) throw new AccountError('Аккаунт не найден.', 404);
  return { ok: true };
}
/** Disconnects an account in FERMA. Its published posts stay on the network; waiting ones are cancelled. */
export async function removeAccount(owner: string, accountId: string) {
  const db = getDb();
  const [account] = await db.select().from(socialAccounts).where(and(eq(socialAccounts.id, accountId), eq(socialAccounts.owner, owner)));
  if (!account) throw new AccountError('Аккаунт не найден.', 404);
  const busy = await db.select({ id: publications.id }).from(publications).where(and(eq(publications.accountId, accountId), inArray(publications.status, ['preparing', 'publishing']))).limit(1);
  if (busy.length) throw new AccountError('Сейчас идёт публикация в этот аккаунт. Повторите через минуту.', 409);
  // Publications keep their history; the account row stays as «disabled» so the history still points somewhere.
  // Waiting ones are cancelled (a container made for them is never published). One that may already be out stays
  // «uncertain»: it is settled if the account is connected again, or the owner cancels it in «Публикациях».
  await db.batch([
    db.update(publications).set({ status: 'cancelled', error: 'Аккаунт отключён в FERMA.', lockedUntil: null, updatedAt: now() }).where(and(eq(publications.accountId, accountId), inArray(publications.status, ['draft', 'awaiting_approval', 'scheduled', 'processing']))),
    db.update(socialAccounts).set({ status: 'disabled', encryptedToken: '', error: 'Отключён владельцем.', updatedAt: now() }).where(eq(socialAccounts.id, accountId)),
  ]);
  return { ok: true };
}

/** The «Аккаунты» screen: providers with their limits, apps (without secrets) and every account. */
export async function accountsOverview(owner: string) {
  const db = getDb();
  const apps = await db.select({ provider: providerApps.provider, appId: providerApps.appId, redirectUri: providerApps.redirectUri, updatedAt: providerApps.updatedAt }).from(providerApps).where(eq(providerApps.owner, owner));
  const accounts = await db.select().from(socialAccounts).where(eq(socialAccounts.owner, owner));
  return {
    providers: PROVIDERS.map(entry => ({ provider: entry.provider, platform: entry.platform, name: entry.name, capabilities: entry.capabilities, app: apps.find(app => app.provider === entry.provider) || null })),
    // eslint-disable-next-line @typescript-eslint/no-unused-vars
    accounts: accounts.map(({ encryptedToken: _token, diagnostics, ...account }) => ({ ...account, diagnostics: diagnostics ? JSON.parse(diagnostics) : null, paused: Boolean(account.pausedUntil && Date.parse(account.pausedUntil) > Date.now()) })),
  };
}
