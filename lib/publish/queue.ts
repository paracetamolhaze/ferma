/**
 * The publication queue for every provider. Each step is stored before the next one starts:
 *   scheduled → preparing (containers are created) → processing (the network fetches the pictures)
 *   → publishing (the publish call) → published.
 * A lost answer becomes «uncertain» and is settled by asking the network (container status, latest posts) before
 * anything is sent again, so a restart never publishes twice. Nothing goes out while automatic publishing is off.
 */
import { and, asc, desc, eq, gte, inArray, lt, lte, isNull, or, sql } from 'drizzle-orm';
import { getDb } from '@/db';
import { autopilotItems, campaigns, contentVariants, personas, posts, profiles, publicationEvents, publications, socialAccounts, sourceItems } from '@/db/schema';
import { cancel as cancelAutopilot } from '../autopilot';
import { readSettings, saveSettings } from '../content/gudini-source';
import { variantMedia } from '../content/variants';
import { AccountError, freshToken } from './accounts';
import { signedMediaUrl } from './public-media';
import { adapterFor } from './registry';
import { PublishError, type Format, type Prepared, type Provider } from './types';

export class QueueError extends Error {
  constructor(message: string, readonly status = 400) { super(message); }
}
const now = () => new Date().toISOString();
const LOCK_MS = 3 * 60_000;
const CHECK_EVERY_MS = 60_000;
const PROCESSING_LIMIT_MS = 10 * 60_000;
const MAX_ATTEMPTS = 5;
const PER_TICK = 3;
const retryDelay = (attempts: number) => Math.min(6 * 3600_000, 5 * 60_000 * 3 ** Math.max(0, attempts - 1));

type Publication = typeof publications.$inferSelect;
const iso = (ms: number) => new Date(ms).toISOString();
/** The network asked this account to wait: nothing goes out of it until then. */
async function pauseAccount(accountId: string, untilMs: number) {
  const until = iso(untilMs);
  await getDb().update(socialAccounts).set({ pausedUntil: until, updatedAt: now() }).where(and(eq(socialAccounts.id, accountId), or(isNull(socialAccounts.pausedUntil), lt(socialAccounts.pausedUntil, until))));
}
const pausedUntil = (account: { pausedUntil: string | null }, nowMs: number) => account.pausedUntil && Date.parse(account.pausedUntil) > nowMs ? Date.parse(account.pausedUntil) : null;
const minutesLeft = (untilMs: number, nowMs: number) => Math.max(1, Math.ceil((untilMs - nowMs) / 60_000));
/** A material older than the age limit is no longer news: it is not published as new. */
async function staleReason(row: Publication, atMs: number, maxAgeHours: number) {
  const [item] = await getDb().select({ readyAt: sourceItems.sourceReadyAt }).from(sourceItems).where(eq(sourceItems.id, row.itemId));
  if (!item?.readyAt || atMs - Date.parse(item.readyAt) <= maxAgeHours * 3600_000) return null;
  return `Материал старше ${maxAgeHours} ч: как новость он уже не выйдет. Публикация снята.`;
}
async function log(owner: string, publicationId: string, level: 'info' | 'warn' | 'error', message: string) {
  await getDb().insert(publicationEvents).values({ id: crypto.randomUUID(), owner, publicationId, at: now(), level, message: message.slice(0, 500) });
}
/** Moves a publication on only if nobody else did since it was read: the stored row is the lock. */
async function move(row: Publication, set: Partial<Publication>) {
  const changed = await getDb().update(publications).set({ ...set, updatedAt: now() }).where(and(eq(publications.id, row.id), eq(publications.status, row.status), eq(publications.updatedAt, row.updatedAt))).returning({ id: publications.id, updatedAt: publications.updatedAt });
  return changed.length ? { ...row, ...set, updatedAt: changed[0].updatedAt } as Publication : null;
}

function formatOf(variantFormat: string, media: number): Format {
  if (variantFormat === 'text' || media === 0) return 'text';
  return media === 1 ? 'image' : 'carousel';
}
/** What the network receives: the short text on Threads, the long caption on Instagram. */
async function requestFor(owner: string, row: Publication, publicBaseUrl: string | null, nowMs: number) {
  const [variant] = await getDb().select().from(contentVariants).where(eq(contentVariants.id, row.variantId));
  if (!variant) throw new PublishError('Вариант удалён.', 'invalid_request');
  if (variant.status !== 'ready') return { waiting: variant.status === 'rendering' || variant.status === 'written' ? 'ждём карточки от медиа-воркера' : `вариант в состоянии «${variant.status}»` } as const;
  const media = variant.format === 'text' ? [] : await variantMedia(owner, variant.id);
  if (variant.format !== 'text' && !media.length) throw new PublishError('У варианта нет картинок.', 'invalid_request');
  if (media.length && !publicBaseUrl) throw new PublishError('Не задан публичный адрес для картинок (Настройки → Публикации).', 'not_available');
  const mediaUrls = [];
  for (const file of media.slice(0, 20)) mediaUrls.push(await signedMediaUrl(publicBaseUrl!, file.key, file.contentType, nowMs));
  const text = row.platform === 'instagram' ? (variant.caption || variant.text || '') : (variant.text || '');
  return { request: { format: formatOf(variant.format, mediaUrls.length), text, mediaUrls }, aiImagery: Boolean(variant.aiImagery), keys: media.map(file => file.key) } as const;
}

async function fail(owner: string, row: Publication, error: unknown, nowMs: number) {
  const known = error instanceof PublishError ? error : error instanceof AccountError ? new PublishError(error.message, error.status === 409 ? 'auth' : 'invalid_request') : new PublishError(error instanceof Error ? error.message : 'Неизвестная ошибка.', 'temporary');
  const attempts = row.attempts + 1;
  const retry = known.retryable && attempts < MAX_ATTEMPTS;
  // The network's own wait (Retry-After, usage headers) wins when it is longer than ours.
  const wait = Math.max(retryDelay(attempts), known.retryAfterMs ?? 0);
  if (known.kind === 'auth') await getDb().update(socialAccounts).set({ status: 'expired', error: known.message, updatedAt: now() }).where(eq(socialAccounts.id, row.accountId));
  if (known.kind === 'rate_limit') await pauseAccount(row.accountId, nowMs + Math.max(known.retryAfterMs ?? 0, 15 * 60_000));
  await move(row, { status: retry ? 'scheduled' : 'failed', attempts, nextAttemptAt: retry ? iso(nowMs + wait) : null, lockedUntil: null, error: known.message.slice(0, 500), errorKind: known.kind });
  await log(owner, row.id, retry ? 'warn' : 'error', `${known.message}${known.detail ? ` [${known.detail}]` : ''}${retry ? `; повтор через ${Math.round(wait / 60000)} мин (попытка ${attempts} из ${MAX_ATTEMPTS})` : ''}`);
}

async function accountOf(row: Publication) {
  const [account] = await getDb().select().from(socialAccounts).where(eq(socialAccounts.id, row.accountId));
  if (!account || account.status === 'disabled') throw new PublishError('Аккаунт отключён.', 'auth');
  if (account.status === 'expired') throw new PublishError('Доступ к аккаунту истёк. Подключите его заново.', 'auth');
  return account;
}
async function publishedToday(accountId: string, nowMs: number) {
  const [row] = await getDb().select({ count: sql<number>`count(*)` }).from(publications).where(and(eq(publications.accountId, accountId), eq(publications.status, 'published'), gte(publications.publishedAt, new Date(nowMs - 86_400_000).toISOString())));
  return row?.count || 0;
}

/** Creates the containers of a due publication. */
async function prepare(owner: string, row: Publication, request: typeof fetch, nowMs: number, settings: { publicBaseUrl: string | null; maxAgeHours: number }) {
  const { publicBaseUrl } = settings;
  const claimed = await move(row, { status: 'preparing', lockedUntil: new Date(nowMs + LOCK_MS).toISOString() });
  if (!claimed) return 'busy';
  try {
    const account = await accountOf(claimed);
    const paused = pausedUntil(account, nowMs);
    if (paused) { await move(claimed, { status: 'scheduled', lockedUntil: null, nextAttemptAt: iso(paused), error: `Соцсеть попросила подождать: аккаунт на паузе ещё ${minutesLeft(paused, nowMs)} мин.` }); return 'paused'; }
    const stale = await staleReason(claimed, nowMs, settings.maxAgeHours);
    if (stale) { await move(claimed, { status: 'cancelled', lockedUntil: null, error: stale }); await log(owner, row.id, 'warn', stale); return 'stale'; }
    const adapter = adapterFor(account.provider as Provider, request);
    const built = await requestFor(owner, claimed, publicBaseUrl, nowMs);
    if ('waiting' in built) { await move(claimed, { status: 'scheduled', lockedUntil: null, nextAttemptAt: new Date(nowMs + 10 * 60_000).toISOString(), error: `Ждёт: ${built.waiting}.` }); return 'waiting'; }
    const problem = adapter.validate(built.request);
    if (problem) throw new PublishError(problem, 'invalid_request');
    const limit = account.quotaTotal ?? adapter.capabilities.dailyLimit;
    if (Math.max(account.quotaUsed ?? 0, await publishedToday(account.id, nowMs)) >= limit) {
      await move(claimed, { status: 'scheduled', lockedUntil: null, nextAttemptAt: new Date(nowMs + 3600_000).toISOString(), error: `Дневной лимит публикаций аккаунта (${limit}) исчерпан, ждём.` });
      return 'limit';
    }
    const token = await freshToken(owner, account, request, nowMs);
    const prepared = await adapter.prepare(token, { ...built.request, ...(account.provider === 'meta_threads' && built.aiImagery ? { aiImagery: true } : {}) });
    const next = await move(claimed, { status: 'processing', containerIds: JSON.stringify({ ids: prepared.containerIds, at: nowMs }), parentContainerId: prepared.parentId, containerReadyAt: iso(nowMs + Math.max(prepared.waitMs, 5_000)), mediaKeys: JSON.stringify(built.keys), mediaCount: built.request.mediaUrls.length, text: built.request.text, lockedUntil: null, error: null, errorKind: null });
    await log(owner, row.id, 'info', `Контейнер создан (${built.request.format}, картинок: ${built.request.mediaUrls.length}).`);
    return next ? 'prepared' : 'busy';
  } catch (error) {
    await fail(owner, claimed, error, nowMs);
    return 'failed';
  }
}

function containersOf(row: Publication): { ids: string[]; at: number } {
  if (!row.containerIds) return { ids: [], at: 0 };
  const parsed = JSON.parse(row.containerIds);
  return Array.isArray(parsed) ? { ids: parsed, at: 0 } : { ids: parsed.ids || [], at: Number(parsed.at) || 0 };
}
const preparedOf = (row: Publication): Prepared => ({ containerIds: containersOf(row).ids, parentId: row.parentContainerId || '', waitMs: 0 });
/** Checks the containers and publishes when the network is ready. */
async function advance(owner: string, row: Publication, request: typeof fetch, nowMs: number) {
  let account;
  try { account = await accountOf(row); } catch (error) { await fail(owner, row, error, nowMs); return 'failed'; }
  const paused = pausedUntil(account, nowMs);
  if (paused) { await move(row, row.status === 'uncertain' ? { nextAttemptAt: iso(paused) } : { containerReadyAt: iso(paused) }); return 'paused'; }
  const adapter = adapterFor(account.provider as Provider, request);
  let token;
  try { token = await freshToken(owner, account, request, nowMs); } catch (error) { await fail(owner, row, error, nowMs); return 'failed'; }
  let state;
  try { state = await adapter.checkPrepared(token, preparedOf(row)); }
  catch (error) {
    if (error instanceof PublishError && !error.retryable) { await fail(owner, row, error, nowMs); return 'failed'; }
    await move(row, { containerReadyAt: new Date(nowMs + CHECK_EVERY_MS).toISOString() });
    return 'later';
  }
  if (state.state === 'processing') {
    const since = containersOf(row).at;
    if (row.status === 'processing' && since && nowMs - since > PROCESSING_LIMIT_MS) { await fail(owner, row, new PublishError('Соцсеть слишком долго обрабатывает картинки.', 'temporary'), nowMs); return 'failed'; }
    await move(row, { containerReadyAt: new Date(nowMs + CHECK_EVERY_MS).toISOString() });
    return 'later';
  }
  if (state.state === 'failed') { await fail(owner, row, new PublishError(`Соцсеть не обработала публикацию: ${state.error}`, row.attempts + 1 < 3 ? 'temporary' : 'invalid_media'), nowMs); return 'failed'; }
  if (state.state === 'published' || (state.state === 'expired' && row.status === 'uncertain')) {
    // Posts that appeared after the containers were made (the queue's own clock, stored with them).
    const since = iso(containersOf(row).at || Date.parse(row.updatedAt));
    const found = await adapter.findRecent(token, row.text, since).catch(() => null);
    if (found || state.state === 'published') {
      await move(row, { status: 'published', remoteId: found?.remoteId ?? row.remoteId, permalink: found?.permalink ?? null, publishedAt: found?.publishedAt || now(), lockedUntil: null, error: found ? null : 'Опубликовано (подтверждено статусом контейнера, ссылка не найдена).' });
      await log(owner, row.id, 'info', 'Публикация подтверждена после потерянного ответа.');
      return 'published';
    }
  }
  if (state.state === 'expired') {
    await move(row, { status: 'scheduled', containerIds: null, parentContainerId: null, containerReadyAt: null, lockedUntil: null, error: 'Контейнер устарел, создаём заново.' });
    await log(owner, row.id, 'warn', 'Контейнер устарел (24 ч), будет создан заново.');
    return 'expired';
  }
  // Ready: publish. The container id makes a repeat harmless: a published container is refused, not posted twice.
  const claimed = await move(row, { status: 'publishing', lockedUntil: new Date(nowMs + LOCK_MS).toISOString() });
  if (!claimed) return 'busy';
  try {
    const result = await adapter.publish(token, preparedOf(claimed));
    await move(claimed, { status: 'published', remoteId: result.remoteId, permalink: result.permalink, publishedAt: result.publishedAt || now(), lockedUntil: null, error: null, errorKind: null });
    await log(owner, row.id, 'info', `Опубликовано${result.permalink ? `: ${result.permalink}` : ''}.`);
    return 'published';
  } catch (error) {
    // No answer, or the network's own failure: the post may be out. Ask the network before doing anything again.
    if (error instanceof PublishError && error.kind === 'temporary') {
      await move(claimed, { status: 'uncertain', lockedUntil: null, nextAttemptAt: new Date(nowMs + 2 * 60_000).toISOString(), error: 'Ответ соцсети потерялся. Проверим, вышел ли пост, прежде чем повторять.' });
      await log(owner, row.id, 'warn', `Ответ на публикацию потерялся (${error.detail || error.message}); статус будет сверен с соцсетью.`);
      return 'uncertain';
    }
    // A clear «too many requests» means nothing was published: the same container is tried again later.
    if (error instanceof PublishError && error.kind === 'rate_limit' && claimed.attempts + 1 < MAX_ATTEMPTS) {
      const wait = Math.max(retryDelay(claimed.attempts + 1), error.retryAfterMs ?? 0);
      await pauseAccount(claimed.accountId, nowMs + Math.max(error.retryAfterMs ?? 0, 15 * 60_000));
      await move(claimed, { status: 'processing', lockedUntil: null, attempts: claimed.attempts + 1, containerReadyAt: iso(nowMs + wait), error: error.message });
      await log(owner, row.id, 'warn', `${error.message} Повтор публикации того же контейнера через ${Math.round(wait / 60000)} мин.`);
      return 'later';
    }
    await fail(owner, claimed, error, nowMs);
    return 'failed';
  }
}

/**
 * One pass of the queue, called by the engine every ~20 s. Does a few steps and returns; long waits (processing
 * of pictures by the network) happen between passes, not inside a request.
 */
export async function publicationTick(owner: string, { nowMs = Date.now(), request = fetch }: { nowMs?: number; request?: typeof fetch } = {}) {
  const db = getDb();
  const at = new Date(nowMs).toISOString();
  // Work a crashed pass left behind: an unfinished container step starts again, an unfinished publish is checked.
  await db.update(publications).set({ status: 'scheduled', lockedUntil: null, updatedAt: at }).where(and(eq(publications.owner, owner), eq(publications.status, 'preparing'), lt(publications.lockedUntil, at)));
  await db.update(publications).set({ status: 'uncertain', lockedUntil: null, nextAttemptAt: at, updatedAt: at }).where(and(eq(publications.owner, owner), eq(publications.status, 'publishing'), lt(publications.lockedUntil, at)));
  const settings = await readSettings(owner);
  const results: Record<string, number> = {};
  const count = (key: string) => { results[key] = (results[key] || 0) + 1; };
  // Settling an uncertain publication only reads from the network, so it runs even with publishing switched off.
  const uncertain = await db.select().from(publications).where(and(eq(publications.owner, owner), eq(publications.status, 'uncertain'), or(isNull(publications.nextAttemptAt), lte(publications.nextAttemptAt, at)))).limit(PER_TICK);
  for (const row of uncertain) count(await advance(owner, row, request, nowMs));
  if (!settings.autopublish) return { off: true, results };
  const processing = await db.select().from(publications).where(and(eq(publications.owner, owner), eq(publications.status, 'processing'), lte(publications.containerReadyAt, at))).orderBy(asc(publications.containerReadyAt)).limit(PER_TICK);
  for (const row of processing) count(await advance(owner, row, request, nowMs));
  // Urgent news first, then by time.
  const due = await db.select().from(publications).where(and(eq(publications.owner, owner), eq(publications.status, 'scheduled'), lte(publications.scheduledFor, at), or(isNull(publications.nextAttemptAt), lte(publications.nextAttemptAt, at)))).orderBy(desc(publications.priority), asc(publications.scheduledFor)).limit(PER_TICK);
  for (const row of due) count(await prepare(owner, row, request, nowMs, settings));
  return { off: false, results };
}

/** Reads reactions of fresh posts every few hours. */
export async function syncStats(owner: string, { nowMs = Date.now(), request = fetch }: { nowMs?: number; request?: typeof fetch } = {}) {
  const db = getDb();
  const stale = new Date(nowMs - 6 * 3600_000).toISOString();
  const rows = await db.select().from(publications).where(and(eq(publications.owner, owner), eq(publications.status, 'published'), gte(publications.publishedAt, new Date(nowMs - 30 * 86_400_000).toISOString()), or(isNull(publications.statsAt), lt(publications.statsAt, stale)))).orderBy(asc(publications.statsAt)).limit(10);
  let updated = 0;
  for (const row of rows) {
    if (!row.remoteId) { await db.update(publications).set({ statsAt: now() }).where(eq(publications.id, row.id)); continue; }
    try {
      const account = await accountOf(row);
      const token = await freshToken(owner, account, request, nowMs);
      const stats = await adapterFor(account.provider as Provider, request).stats(token, row.remoteId);
      await db.update(publications).set({ stats: stats ? JSON.stringify(stats) : null, statsAt: now() }).where(eq(publications.id, row.id));
      updated++;
    } catch { await db.update(publications).set({ statsAt: now() }).where(eq(publications.id, row.id)); }
  }
  return { updated };
}

// ---------------------------------------------------------------- owner's actions

async function owned(owner: string, id: string) {
  const [row] = await getDb().select().from(publications).where(and(eq(publications.id, id), eq(publications.owner, owner)));
  if (!row) throw new QueueError('Публикация не найдена.', 404);
  return row;
}
export async function approve(owner: string, id: string) {
  const row = await owned(owner, id);
  if (!['awaiting_approval', 'draft'].includes(row.status)) throw new QueueError('Одобрить можно только черновик или публикацию на проверке.', 409);
  const next = await move(row, { status: 'scheduled', approvedAt: now(), error: null });
  if (!next) throw new QueueError('Публикация изменилась, обновите страницу.', 409);
  await log(owner, id, 'info', 'Одобрено владельцем.');
  return { ok: true };
}
export async function cancelPublication(owner: string, id: string) {
  const row = await owned(owner, id);
  if (!['draft', 'awaiting_approval', 'scheduled', 'failed', 'processing'].includes(row.status)) throw new QueueError('Эту публикацию уже нельзя отменить.', 409);
  const next = await move(row, { status: 'cancelled', lockedUntil: null });
  if (!next) throw new QueueError('Публикация изменилась, обновите страницу.', 409);
  await log(owner, id, 'info', 'Отменено владельцем.');
  return { ok: true };
}
export async function retryPublication(owner: string, id: string) {
  const row = await owned(owner, id);
  if (row.status !== 'failed') throw new QueueError('Повторить можно только публикацию с ошибкой.', 409);
  await move(row, { status: 'scheduled', attempts: 0, nextAttemptAt: null, error: null, errorKind: null, containerIds: null, parentContainerId: null, containerReadyAt: null });
  await log(owner, id, 'info', 'Повтор по кнопке владельца.');
  return { ok: true };
}
export async function reschedule(owner: string, id: string, at: string, nowMs = Date.now()) {
  const row = await owned(owner, id);
  if (!['draft', 'awaiting_approval', 'scheduled'].includes(row.status)) throw new QueueError('Время можно менять только до отправки.', 409);
  const time = Date.parse(at);
  if (!Number.isFinite(time) || time < nowMs + 60_000) throw new QueueError('Выберите время хотя бы на минуту позже текущего.');
  const { maxAgeHours } = await readSettings(owner);
  if (await staleReason(row, time, maxAgeHours)) throw new QueueError(`К этому времени материал будет старше ${maxAgeHours} ч и не выйдет. Выберите время раньше или увеличьте срок в настройках.`);
  const next = await move(row, { scheduledFor: iso(time), nextAttemptAt: null });
  if (!next) throw new QueueError('Публикация изменилась, обновите страницу.', 409);
  await log(owner, id, 'info', `Время изменено владельцем: ${iso(time)}.`);
  return { ok: true };
}

/**
 * «Остановить всё»: automatic publishing off, campaigns and autopilots paused. Containers already created stay
 * unpublished; a publish call already in flight cannot be taken back and is settled as usual. Posts the
 * autopilot already handed to Zernio go out at their time unless `zernio` asks to take them back too.
 */
export async function stopAll(owner: string, { zernio = false }: { zernio?: boolean } = {}) {
  const db = getDb();
  await saveSettings(owner, { autopublish: false });
  const stoppedCampaigns = await db.update(campaigns).set({ status: 'paused', updatedAt: now() }).where(and(eq(campaigns.owner, owner), eq(campaigns.status, 'active'))).returning({ id: campaigns.id });
  const stoppedPilots = await db.update(personas).set({ enabled: 0, updatedAt: now() }).where(and(eq(personas.owner, owner), eq(personas.enabled, 1))).returning({ id: personas.profileId });
  const handed = await db.select({ id: autopilotItems.id }).from(autopilotItems).where(and(eq(autopilotItems.owner, owner), eq(autopilotItems.status, 'scheduled')));
  let takenBack = 0;
  const errors: string[] = [];
  if (zernio) for (const item of handed) {
    try { await cancelAutopilot(owner, item.id); takenBack++; }
    catch (error) { errors.push(error instanceof Error ? error.message : 'Zernio не отменил публикацию.'); }
  }
  return { campaigns: stoppedCampaigns.length, autopilots: stoppedPilots.length, zernioWaiting: handed.length - takenBack, zernioTakenBack: takenBack, errors: [...new Set(errors)] };
}

/**
 * «Публикации»: one list for every provider. FERMA's own queue, the autopilot's Zernio posts and the Zernio
 * drafts are shown together; each keeps working the way it did.
 */
export async function queueOverview(owner: string, { limit = 200 }: { limit?: number } = {}) {
  const db = getDb();
  const own = await db.select({ p: publications, title: sourceItems.title, kind: sourceItems.kind, style: contentVariants.style, layout: contentVariants.layout, username: socialAccounts.username })
    .from(publications).leftJoin(sourceItems, eq(sourceItems.id, publications.itemId)).leftJoin(contentVariants, eq(contentVariants.id, publications.variantId)).leftJoin(socialAccounts, eq(socialAccounts.id, publications.accountId))
    .where(eq(publications.owner, owner)).orderBy(desc(publications.scheduledFor)).limit(limit);
  const auto = await db.select().from(autopilotItems).where(and(eq(autopilotItems.owner, owner), inArray(autopilotItems.status, ['ready', 'scheduled', 'published', 'failed']))).orderBy(desc(autopilotItems.dueAt)).limit(100);
  const zernio = await db.select().from(posts).where(eq(posts.owner, owner)).orderBy(desc(posts.createdAt)).limit(100);
  const names = new Map((await db.select({ id: profiles.id, name: profiles.name }).from(profiles).where(eq(profiles.owner, owner))).map(row => [row.id, row.name]));
  const rows = [
    ...own.map(({ p, title, kind, style, layout, username }) => ({ source: 'ferma', provider: p.provider, id: p.id, profileId: p.profileId, profile: names.get(p.profileId) || '', platform: p.platform, account: username, status: p.status, at: p.publishedAt || p.scheduledFor, title: title || '', text: p.text, kind, style, layout, format: p.format, error: p.error, permalink: p.permalink, stats: p.stats ? JSON.parse(p.stats) : null, mediaCount: p.mediaCount, variantId: p.variantId, campaignId: p.campaignId })),
    ...auto.map(item => ({ source: 'autopilot', provider: 'zernio', id: item.id, profileId: item.profileId, profile: names.get(item.profileId) || '', platform: item.kind === 'threads' ? 'threads' : 'instagram', account: null, status: item.status, at: item.dueAt, title: item.kind, text: item.text || '', kind: item.kind, style: null, layout: null, format: item.kind, error: item.error, permalink: null, stats: null, mediaCount: item.imageKey ? item.extraImages + 1 : 0, variantId: null, campaignId: null })),
    ...zernio.map(post => ({ source: 'zernio', provider: 'zernio', id: post.id, profileId: post.profileId, profile: names.get(post.profileId) || '', platform: (JSON.parse(post.platforms) as string[]).join(', '), account: null, status: post.status, at: post.scheduledFor || post.createdAt, title: post.title, text: post.content, kind: 'post', style: null, layout: null, format: post.mediaId ? 'media' : 'text', error: post.error, permalink: null, stats: null, mediaCount: post.mediaId ? 1 : 0, variantId: null, campaignId: null })),
  ].sort((a, b) => b.at.localeCompare(a.at));
  const settings = await readSettings(owner);
  // What «Остановить всё» would stop right now.
  const [{ active }] = await db.select({ active: sql<number>`count(*)` }).from(campaigns).where(and(eq(campaigns.owner, owner), eq(campaigns.status, 'active')));
  const [{ pilots }] = await db.select({ pilots: sql<number>`count(*)` }).from(personas).where(and(eq(personas.owner, owner), eq(personas.enabled, 1)));
  const zernioWaiting = auto.filter(item => item.status === 'scheduled').length;
  return { autopublish: Boolean(settings.autopublish), publicBaseUrl: settings.publicBaseUrl, running: { campaigns: active, autopilots: pilots, zernioWaiting }, rows };
}
export async function publicationEventsOf(owner: string, id: string) {
  await owned(owner, id);
  return getDb().select().from(publicationEvents).where(and(eq(publicationEvents.owner, owner), eq(publicationEvents.publicationId, id))).orderBy(desc(publicationEvents.at)).limit(50);
}
