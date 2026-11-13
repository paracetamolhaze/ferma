import { env } from 'cloudflare:workers';
import { and, asc, desc, eq, inArray, isNull, like, lt, notInArray, notLike, or, sql } from 'drizzle-orm';
import { z } from 'zod';
import { getDb } from '@/db';
import { autopilotItems, autopilotState, channels, personas, profileIntegrations, profiles, profileSources } from '@/db/schema';
import { DEFAULT_RHYTHM, KINDS, planNext, type Kind, type Rhythm } from './rhythm';

const FIRST_DELAY_MS = 60_000;
// Anything due this soon (a first post, or one the computer slept through) is published immediately.
const NOW_WINDOW_MS = 3 * 60_000;
import { createZernioClient, ProviderError } from './zernio';
import { readInstagramFollowers } from './zernio-insights';

export class AutopilotError extends Error {
  constructor(message: string, readonly status = 400) { super(message); }
}
export const ACTIVE = ['planned', 'generating', 'ready', 'scheduled'];
const STALE_GENERATING_MS = 30 * 60_000;
const RETRY_MS = 15 * 60_000;
const MAX_ATTEMPTS = 3;
const IMAGE_TYPES = ['image/png', 'image/jpeg', 'image/webp'];
const MAX_IMAGE = 20 * 1024 * 1024;
// Trial reels are rendered videos; they stay in storage only until Zernio has published them.
const MAX_VIDEO = 150 * 1024 * 1024;
export const MAX_SLIDES = 10;
// A carousel keeps its first picture under imageKey and the rest beside it.
const slideKey = (imageKey: string, index: number) => index === 0 ? imageKey : `${imageKey}-${index}`;
const now = () => new Date().toISOString();
const KIND_NETWORK: Record<Kind, string> = { threads: 'threads', story: 'instagram', post: 'instagram', reel: 'instagram' };

const personaSchema = z.object({
  name: z.string().min(1), timezoneOffsetMinutes: z.number().int().min(-720).max(840).default(300),
  rhythm: z.object({ threads: z.any(), story: z.any(), post: z.any(), reel: z.any() }).partial().optional(),
}).passthrough();
type Persona = z.infer<typeof personaSchema>;
const rhythmOf = (persona: Persona): Rhythm => ({ ...DEFAULT_RHYTHM, ...(persona.rhythm as Partial<Rhythm> | undefined) });

async function ownedProfile(owner: string, profileId: string) {
  const [profile] = await getDb().select({ id: profiles.id }).from(profiles).where(and(eq(profiles.id, profileId), eq(profiles.owner, owner)));
  if (!profile) throw new AutopilotError('Профиль не найден.', 404);
}
async function readPersonaRow(owner: string, profileId: string) {
  const [row] = await getDb().select().from(personas).where(and(eq(personas.profileId, profileId), eq(personas.owner, owner)));
  return row;
}
export async function savePersona(owner: string, profileId: string, personaJson: string) {
  await ownedProfile(owner, profileId);
  let parsed: Persona;
  try { parsed = personaSchema.parse(JSON.parse(personaJson)); } catch { throw new AutopilotError('Личность должна быть корректным JSON с полем name.'); }
  const value = JSON.stringify(parsed);
  await getDb().insert(personas).values({ profileId, owner, persona: value, enabled: 0, updatedAt: now() })
    .onConflictDoUpdate({ target: personas.profileId, set: { persona: value, updatedAt: now() } });
  return { ok: true };
}
export async function setEnabled(owner: string, profileId: string, enabled: boolean) {
  await ownedProfile(owner, profileId);
  const changed = await getDb().update(personas).set({ enabled: enabled ? 1 : 0, updatedAt: now() }).where(and(eq(personas.profileId, profileId), eq(personas.owner, owner))).returning({ id: personas.profileId });
  if (!changed.length) throw new AutopilotError('Сначала нужна личность профиля.');
  return { enabled };
}
const channelOf = async (profileId: string) => (await getDb().select({ tgChannel: profileSources.tgChannel }).from(profileSources).where(eq(profileSources.profileId, profileId)))[0]?.tgChannel || null;
export async function readProfileAutopilot(owner: string, profileId: string) {
  await ownedProfile(owner, profileId);
  const row = await readPersonaRow(owner, profileId);
  const items = await getDb().select().from(autopilotItems).where(and(eq(autopilotItems.owner, owner), eq(autopilotItems.profileId, profileId))).orderBy(desc(autopilotItems.dueAt)).limit(40);
  const [state] = await getDb().select().from(autopilotState).where(eq(autopilotState.owner, owner));
  return {
    persona: row ? JSON.parse(row.persona) : null, enabled: Boolean(row?.enabled), tgChannel: await channelOf(profileId), rhythm: row ? rhythmOf(JSON.parse(row.persona)) : null,
    engine: state ? { heartbeatAt: state.heartbeatAt, bridgeOk: Boolean(state.bridgeOk), note: state.note } : null,
    items: items.map(({ owner: _o, imageKey, ...item }) => ({ ...item, hasImage: Boolean(imageKey) })),
  };
}

/** Profiles that are ready to run but have no persona yet: a key and at least one connected network. */
export async function onboardList(owner: string) {
  const db = getDb();
  const owned = await db.select({ id: profiles.id, name: profiles.name, description: profiles.description }).from(profiles).where(eq(profiles.owner, owner));
  const withPersona = new Set((await db.select({ id: personas.profileId }).from(personas).where(eq(personas.owner, owner))).map(row => row.id));
  const withKey = new Set((await db.select({ id: profileIntegrations.profileId }).from(profileIntegrations).where(eq(profileIntegrations.owner, owner))).map(row => row.id));
  const result = [];
  for (const profile of owned) {
    if (withPersona.has(profile.id) || !withKey.has(profile.id)) continue;
    const linked = await db.select({ platform: channels.platform, username: channels.username }).from(channels).where(and(eq(channels.profileId, profile.id), eq(channels.state, 'connected')));
    const own = linked.filter(item => ['instagram', 'threads'].includes(item.platform));
    if (own.length) result.push({ profileId: profile.id, name: profile.name, city: profile.description.trim() || null, username: own[0].username });
  }
  return result;
}
const rhythmInput = z.union([
  z.object({ perDay: z.number().int().min(1).max(12) }),
  z.object({ minDays: z.number().int().min(1).max(90), maxDays: z.number().int().min(1).max(90) }).refine(value => value.maxDays >= value.minDays),
]);
export async function setRhythm(owner: string, profileId: string, input: unknown) {
  await ownedProfile(owner, profileId);
  const parsed = z.object({ threads: rhythmInput, story: rhythmInput, post: rhythmInput, reel: rhythmInput.optional() }).safeParse(input);
  if (!parsed.success) throw new AutopilotError('Укажите от 1 до 12 раз в день или дни от 1 до 90, «до» не меньше «от».');
  const row = await readPersonaRow(owner, profileId);
  if (!row) throw new AutopilotError('Сначала нужна личность профиля.');
  const persona = JSON.parse(row.persona);
  const current = rhythmOf(persona);
  // A kind left out of the form keeps its current regularity.
  const rhythm = Object.fromEntries(KINDS.map(kind => [kind, parsed.data[kind] ? { ...current[kind], perDay: null, ...parsed.data[kind], weekend: false } : current[kind]]));
  await getDb().update(personas).set({ persona: JSON.stringify({ ...persona, rhythm }), updatedAt: now() }).where(eq(personas.profileId, profileId));
  return { rhythm };
}
/** Instagram followers of every enabled profile: Instagram allows trial reels only from 1,000 followers. */
export async function reelReach(owner: string) {
  const db = getDb();
  const rows = await db.select({ profileId: personas.profileId }).from(personas).where(and(eq(personas.owner, owner), eq(personas.enabled, 1)));
  return Promise.all(rows.map(async row => {
    const [instagram] = await db.select({ accountId: channels.accountId }).from(channels).where(and(eq(channels.profileId, row.profileId), eq(channels.platform, 'instagram'), eq(channels.state, 'connected')));
    if (!instagram?.accountId) return { profileId: row.profileId, followers: null };
    try { return { profileId: row.profileId, followers: await readInstagramFollowers(owner, row.profileId, instagram.accountId) }; }
    catch { return { profileId: row.profileId, followers: null }; }
  }));
}
/** Everything the engine needs in one read. */
export async function engineState(owner: string) {
  const db = getDb();
  // A generation the engine never finished (restart, crash) goes back to the plan.
  await db.update(autopilotItems).set({ status: 'planned', updatedAt: now() }).where(and(eq(autopilotItems.owner, owner), eq(autopilotItems.status, 'generating'), lt(autopilotItems.updatedAt, new Date(Date.now() - STALE_GENERATING_MS).toISOString()), or(isNull(autopilotItems.imagePrompt), notLike(autopilotItems.imagePrompt, 'tg:%'))));
  const rows = await db.select().from(personas).where(and(eq(personas.owner, owner), eq(personas.enabled, 1)));
  return Promise.all(rows.map(async row => {
    const [profile] = await db.select({ avatarKey: profiles.avatarKey, name: profiles.name }).from(profiles).where(eq(profiles.id, row.profileId));
    const linked = await db.select({ platform: channels.platform }).from(channels).where(and(eq(channels.profileId, row.profileId), eq(channels.state, 'connected')));
    const networks = linked.map(item => item.platform);
    const items = await db.select().from(autopilotItems).where(and(eq(autopilotItems.owner, owner), eq(autopilotItems.profileId, row.profileId))).orderBy(desc(autopilotItems.dueAt)).limit(60);
    const [source] = await db.select({ tgChannel: profileSources.tgChannel }).from(profileSources).where(eq(profileSources.profileId, row.profileId));
    const fromChannel = Boolean(source?.tgChannel);
    return {
      profileId: row.profileId, name: profile?.name, hasAvatar: Boolean(profile?.avatarKey), persona: JSON.parse(row.persona), networks,
      // With a Telegram channel connected, Threads lives on the channel alone: no posts of her own are written.
      kinds: KINDS.filter(kind => networks.includes(KIND_NETWORK[kind]) && !(kind === 'threads' && fromChannel)),
      items: items.map(({ owner: _o, imageKey, ...item }) => ({ ...item, hasImage: Boolean(imageKey) })),
    };
  }));
}
/** The engine has just started, so nothing can be in the middle of generation: unfinished work is picked up again at once. */
export async function recover(owner: string) {
  const db = getDb();
  // A half-copied channel post is removed so that it is copied again from the start.
  const copies = await db.delete(autopilotItems).where(and(eq(autopilotItems.owner, owner), eq(autopilotItems.status, 'generating'), like(autopilotItems.imagePrompt, 'tg:%'))).returning({ id: autopilotItems.id });
  const own = await db.update(autopilotItems).set({ status: 'planned', retryAt: null, updatedAt: now() }).where(and(eq(autopilotItems.owner, owner), eq(autopilotItems.status, 'generating'))).returning({ id: autopilotItems.id });
  return { recovered: own.length + copies.length };
}
export async function heartbeat(owner: string, bridgeOk: boolean, note: string | null) {
  const values = { heartbeatAt: now(), bridgeOk: bridgeOk ? 1 : 0, note };
  await getDb().insert(autopilotState).values({ owner, ...values }).onConflictDoUpdate({ target: autopilotState.owner, set: values });
}

export async function plan(owner: string, profileId: string, kind: Kind, nowMs = Date.now(), random = Math.random) {
  if (!KINDS.includes(kind)) throw new AutopilotError('Неизвестный вид публикации.');
  const row = await readPersonaRow(owner, profileId);
  if (!row?.enabled) throw new AutopilotError('Автопилот профиля выключен.');
  const db = getDb();
  const items = await db.select().from(autopilotItems).where(and(eq(autopilotItems.owner, owner), eq(autopilotItems.profileId, profileId), eq(autopilotItems.kind, kind), notInArray(autopilotItems.status, ['stock', 'skipped']))).orderBy(desc(autopilotItems.dueAt)).limit(1);
  const last = items[0];
  if (last && ACTIVE.includes(last.status)) return last;
  // A freshly connected profile posts right away: one of each kind, a few minutes apart.
  const due = !last ? nowMs + FIRST_DELAY_MS : planNext(rhythmOf(JSON.parse(row.persona))[kind], Date.parse(last.dueAt), nowMs, JSON.parse(row.persona).timezoneOffsetMinutes ?? 300, random);
  const item = { id: crypto.randomUUID(), owner, profileId, kind, status: 'planned', dueAt: new Date(due).toISOString(), attempts: 0, createdAt: now(), updatedAt: now() };
  await db.insert(autopilotItems).values(item);
  return item;
}
async function ownedItem(owner: string, id: string) {
  const [item] = await getDb().select().from(autopilotItems).where(and(eq(autopilotItems.id, id), eq(autopilotItems.owner, owner)));
  if (!item) throw new AutopilotError('Публикация не найдена.', 404);
  return item;
}
/** Only one engine pass can take an item: the status change is the lock. */
export async function claim(owner: string, id: string) {
  const changed = await getDb().update(autopilotItems).set({ status: 'generating', attempts: sql`${autopilotItems.attempts} + 1`, updatedAt: now() })
    .where(and(eq(autopilotItems.id, id), eq(autopilotItems.owner, owner), eq(autopilotItems.status, 'planned'))).returning({ id: autopilotItems.id });
  return { claimed: changed.length > 0 };
}
export async function storeImage(owner: string, id: string, type: string, body: ArrayBuffer, index = 0) {
  const item = await ownedItem(owner, id);
  if (!['generating', 'stock'].includes(item.status)) throw new AutopilotError('Картинку можно сохранить только во время генерации.', 409);
  if (item.kind === 'reel') {
    if (type !== 'video/mp4' || !body.byteLength || body.byteLength > MAX_VIDEO || index !== 0) throw new AutopilotError('Для пробного рилса нужно одно видео MP4 до 150 МБ.');
  } else if (!IMAGE_TYPES.includes(type) || !body.byteLength || body.byteLength > MAX_IMAGE) throw new AutopilotError('Нужна картинка PNG, JPEG или WebP до 20 МБ.');
  if (!Number.isInteger(index) || index < 0 || index >= MAX_SLIDES) throw new AutopilotError(`В карусели до ${MAX_SLIDES} фото.`);
  if (index > 0 && (item.kind === 'story' || !item.imageKey)) throw new AutopilotError('У сторис одно фото, а карусель начинается с первого фото.');
  const base = item.imageKey || `${owner}/autopilot/${id}`;
  await env.BUCKET!.put(slideKey(base, index), body, { httpMetadata: { contentType: type } });
  await getDb().update(autopilotItems).set({ imageKey: base, extraImages: Math.max(item.extraImages, index), updatedAt: now() }).where(eq(autopilotItems.id, id));
  return { ok: true };
}
export async function readImage(owner: string, id: string, index = 0) {
  const item = await ownedItem(owner, id);
  if (!item.imageKey || !Number.isInteger(index) || index < 0 || index > item.extraImages) return null;
  return env.BUCKET!.get(slideKey(item.imageKey, index));
}
export async function complete(owner: string, id: string, input: { text?: string | null; imagePrompt?: string | null }) {
  const item = await ownedItem(owner, id);
  if (item.status !== 'generating') throw new AutopilotError('Публикация не в генерации.', 409);
  const text = input.text === undefined ? item.text : input.text;
  if (item.kind === 'threads' && !text?.trim() && !item.imageKey) throw new AutopilotError('Для Threads нужен текст или фото.');
  if (item.kind !== 'threads' && !item.imageKey) throw new AutopilotError(item.kind === 'reel' ? 'Для пробного рилса нужно видео.' : 'Для Instagram нужна картинка.');
  await getDb().update(autopilotItems).set({ status: 'ready', text: text?.trim() || null, imagePrompt: input.imagePrompt || item.imagePrompt || null, error: null, retryAt: null, updatedAt: now() }).where(eq(autopilotItems.id, id));
  return { ok: true };
}
/** A ready-made publication kept for later: the engine uses it instead of generating when its kind is next due. */
export async function addStock(owner: string, profileId: string, kind: Kind, text: string | null) {
  await ownedProfile(owner, profileId);
  if (!KINDS.includes(kind)) throw new AutopilotError('Неизвестный вид публикации.');
  const item = { id: crypto.randomUUID(), owner, profileId, kind, status: 'stock', dueAt: now(), text: text?.trim() || null, attempts: 0, createdAt: now(), updatedAt: now() };
  await getDb().insert(autopilotItems).values(item);
  return item;
}
/** Moves the oldest stocked publication of the same kind into a claimed item. */
export async function takeStock(owner: string, id: string) {
  const item = await ownedItem(owner, id);
  if (item.status !== 'generating') throw new AutopilotError('Публикация не в генерации.', 409);
  const db = getDb();
  const [stock] = await db.select().from(autopilotItems).where(and(eq(autopilotItems.owner, owner), eq(autopilotItems.profileId, item.profileId), eq(autopilotItems.kind, item.kind), eq(autopilotItems.status, 'stock'))).orderBy(asc(autopilotItems.createdAt)).limit(1);
  if (!stock || (item.kind !== 'threads' && !stock.imageKey) || (item.kind === 'threads' && !stock.text)) return { used: false };
  await db.batch([
    db.update(autopilotItems).set({ status: 'ready', text: stock.text, imagePrompt: stock.imagePrompt, imageKey: stock.imageKey, extraImages: stock.extraImages, error: null, retryAt: null, updatedAt: now() }).where(eq(autopilotItems.id, id)),
    db.delete(autopilotItems).where(eq(autopilotItems.id, stock.id)),
  ]);
  return { used: true, hasText: Boolean(stock.text), slides: stock.extraImages + 1 };
}
/** A caption written for a photo taken from the stock, before it is handed to Zernio. */
export async function setCaption(owner: string, id: string, text: string) {
  const changed = await getDb().update(autopilotItems).set({ text: text.trim().slice(0, 2200) || null, updatedAt: now() })
    .where(and(eq(autopilotItems.id, id), eq(autopilotItems.owner, owner), eq(autopilotItems.status, 'ready'))).returning({ id: autopilotItems.id });
  if (!changed.length) throw new AutopilotError('Подпись можно задать только готовой публикации.', 409);
  return { ok: true };
}
export async function fail(owner: string, id: string, error: string) {
  const item = await ownedItem(owner, id);
  const finished = item.attempts >= MAX_ATTEMPTS;
  await getDb().update(autopilotItems).set({ status: finished ? 'failed' : 'planned', error: error.slice(0, 500), retryAt: finished ? null : new Date(Date.now() + RETRY_MS).toISOString(), updatedAt: now() }).where(eq(autopilotItems.id, id));
  return { finished };
}
export async function skip(owner: string, id: string) {
  const changed = await getDb().update(autopilotItems).set({ status: 'skipped', updatedAt: now() }).where(and(eq(autopilotItems.id, id), eq(autopilotItems.owner, owner), inArray(autopilotItems.status, ['planned', 'ready', 'failed', 'stock']))).returning({ id: autopilotItems.id });
  if (!changed.length) throw new AutopilotError('Эту публикацию уже нельзя пропустить: она передана в Zernio.');
  return { ok: true };
}

/** Takes back a publication already handed to Zernio, while it is not out yet. */
export async function cancel(owner: string, id: string) {
  const item = await ownedItem(owner, id);
  if (item.status !== 'scheduled' || !item.zernioPostId) throw new AutopilotError('Отменить можно только публикацию, которая ждёт выхода в Zernio.', 409);
  const zernio = await createZernioClient(owner, item.profileId);
  try { await zernio(`/posts/${encodeURIComponent(item.zernioPostId)}`, { method: 'DELETE' }); }
  catch (error) { throw new AutopilotError(error instanceof Error ? error.message : 'Zernio не отменил публикацию.', 502); }
  await getDb().update(autopilotItems).set({ status: 'skipped', error: null, updatedAt: now() }).where(eq(autopilotItems.id, id));
  return { ok: true };
}
const THREADS_LIMIT = 500;
/** Cuts a text into Threads-sized parts at paragraph, sentence or word ends. */
export function splitForThreads(text: string) {
  const parts: string[] = [];
  let rest = text.trim();
  while (rest.length > THREADS_LIMIT) {
    const window = rest.slice(0, THREADS_LIMIT);
    const cut = Math.max(window.lastIndexOf('\n\n'), window.lastIndexOf('. ') + 1, window.lastIndexOf('! ') + 1, window.lastIndexOf('? ') + 1);
    const at = cut > THREADS_LIMIT * 0.4 ? cut : Math.max(window.lastIndexOf(' '), Math.floor(THREADS_LIMIT * 0.6));
    parts.push(rest.slice(0, at).trim());
    rest = rest.slice(at).trim();
  }
  if (rest) parts.push(rest);
  return parts;
}
/** What Zernio receives for each kind. Pure, so it is tested directly. */
export function zernioPayload(item: { kind: string; text: string | null; dueAt: string }, accountId: string, mediaUrls: string[], nowMs: number) {
  const base = Date.parse(item.dueAt) <= nowMs + NOW_WINDOW_MS ? { publishNow: true } : { scheduledFor: item.dueAt, timezone: 'UTC' };
  const mediaItems = mediaUrls.map(url => ({ type: item.kind === 'reel' ? 'video' : 'image', url }));
  if (item.kind === 'threads') {
    const parts = splitForThreads(item.text || '');
    // A long text goes out as a chain of replies under the first part.
    if (parts.length > 1) return { ...base, content: parts[0], platforms: [{ platform: 'threads', accountId, platformSpecificData: { threadItems: parts.map((content, index) => ({ content, ...(index === 0 && mediaItems.length ? { mediaItems } : {}) })) } }] };
    return { ...base, content: item.text || '', ...(mediaItems.length ? { mediaItems } : {}), platforms: [{ platform: 'threads', accountId }] };
  }
  if (item.kind === 'story') return { ...base, content: '', mediaItems, platforms: [{ platform: 'instagram', accountId, platformSpecificData: { contentType: 'story' } }] };
  // Trial reel: Instagram shows it to non-followers only; MANUAL = it never moves to the followers' feed by itself.
  if (item.kind === 'reel') return { ...base, content: item.text || '', mediaItems, platforms: [{ platform: 'instagram', accountId, platformSpecificData: { trialParams: { graduationStrategy: 'MANUAL' } } }] };
  return { ...base, content: item.text || '', mediaItems, platforms: [{ platform: 'instagram', accountId }] };
}
export async function publish(owner: string, id: string, nowMs = Date.now()) {
  const item = await ownedItem(owner, id);
  if (item.status !== 'ready') throw new AutopilotError('Публикация не готова.', 409);
  const network = KIND_NETWORK[item.kind as Kind];
  const [channel] = await getDb().select().from(channels).where(and(eq(channels.profileId, item.profileId), eq(channels.platform, network), eq(channels.state, 'connected')));
  if (!channel?.accountId) throw new AutopilotError(`У профиля не подключён ${network === 'threads' ? 'Threads' : 'Instagram'}.`);
  const zernio = await createZernioClient(owner, item.profileId);
  try {
    const mediaUrls: string[] = [];
    if (item.imageKey) for (let index = 0; index <= item.extraImages; index++) {
      const object = await env.BUCKET!.get(slideKey(item.imageKey!, index));
      if (!object) throw new AutopilotError('Картинка пропала из хранилища.');
      const type = object.httpMetadata?.contentType || 'image/png';
      const signed = z.object({ uploadUrl: z.string().url(), publicUrl: z.string().url() }).parse(await zernio('/media/presign', { method: 'POST', body: JSON.stringify({ filename: `${id}-${index}.${type.split('/')[1]}`, contentType: type, size: object.size }) }));
      if (!signed.uploadUrl.startsWith('https://') || !signed.publicUrl.startsWith('https://')) throw new AutopilotError('Некорректный адрес загрузки Zernio.');
      const upload = await fetch(signed.uploadUrl, { method: 'PUT', headers: { 'Content-Type': type, 'Content-Length': String(object.size) }, body: object.body, signal: AbortSignal.timeout(type.startsWith('video/') ? 600000 : 120000) });
      if (!upload.ok) throw new AutopilotError(type.startsWith('video/') ? 'Не удалось передать видео в Zernio.' : 'Не удалось передать картинку в Zernio.');
      mediaUrls.push(signed.publicUrl);
    }
    const data = z.object({ post: z.object({ _id: z.string().min(1) }) }).parse(await zernio('/posts', { method: 'POST', body: JSON.stringify(zernioPayload(item, channel.accountId, mediaUrls, nowMs)) }, `autopilot-${item.id}`));
    await getDb().update(autopilotItems).set({ status: 'scheduled', zernioPostId: data.post._id, error: null, updatedAt: now() }).where(eq(autopilotItems.id, id));
    return { ok: true, zernioPostId: data.post._id };
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Ошибка Zernio';
    // A clear refusal ends the item; anything uncertain is retried later with the same idempotency key.
    const certain = (error instanceof ProviderError && error.status >= 400 && error.status < 500 && error.status !== 409) || error instanceof AutopilotError;
    await getDb().update(autopilotItems).set({ status: certain ? 'failed' : 'ready', error: message.slice(0, 500), updatedAt: now() }).where(eq(autopilotItems.id, id));
    throw new AutopilotError(message, 502);
  }
}
/**
 * Zernio switches an account off when the network logs it out (a security check, a deactivated profile).
 * FERMA follows: such an account is marked 'inactive' and the autopilot leaves it alone, and it comes back
 * by itself once it is reconnected in Zernio. A 'disconnected' account (an unresolved choice) is not touched.
 */
export async function checkAccounts(owner: string) {
  const db = getDb();
  const rows = await db.select({ id: profiles.id, zernioId: profiles.zernioId }).from(profiles).where(eq(profiles.owner, owner));
  const changes: { profileId: string; platform: string; state: string }[] = [];
  for (const profile of rows) {
    if (!profile.zernioId) continue;
    const linked = (await db.select().from(channels).where(eq(channels.profileId, profile.id))).filter(channel => channel.state === 'connected' || channel.state === 'inactive');
    if (!linked.length) continue;
    try {
      const zernio = await createZernioClient(owner, profile.id);
      const listed = z.object({ accounts: z.array(z.object({ _id: z.string(), isActive: z.boolean().optional() }).passthrough()) }).parse(await zernio(`/accounts?profileId=${encodeURIComponent(profile.zernioId)}`));
      for (const channel of linked) {
        const account = listed.accounts.find(item => item._id === channel.accountId);
        if (!account) continue;
        const state = account.isActive === false ? 'inactive' : 'connected';
        if (state === channel.state) continue;
        await db.update(channels).set({ state }).where(eq(channels.id, channel.id));
        changes.push({ profileId: profile.id, platform: channel.platform, state });
      }
    } catch { /* no key, or Zernio is unreachable: checked again on the next pass */ }
  }
  return changes;
}
export async function sync(owner: string, nowMs = Date.now()) {
  const due = await getDb().select().from(autopilotItems).where(and(eq(autopilotItems.owner, owner), eq(autopilotItems.status, 'scheduled'), lt(autopilotItems.dueAt, new Date(nowMs).toISOString())));
  let updated = 0;
  for (const item of due) {
    try {
      const zernio = await createZernioClient(owner, item.profileId);
      const data = z.object({ post: z.object({ status: z.string(), platforms: z.array(z.object({ errorMessage: z.string().nullish() })).optional() }) }).parse(await zernio(`/posts/${encodeURIComponent(item.zernioPostId!)}`));
      const status = data.post.status === 'published' ? 'published' : ['failed', 'partial'].includes(data.post.status) ? 'failed' : null;
      if (status) {
        await getDb().update(autopilotItems).set({ status, error: status === 'failed' ? (data.post.platforms || []).map(p => p.errorMessage).filter(Boolean).join('; ') || 'Zernio не опубликовал' : null, updatedAt: now() }).where(eq(autopilotItems.id, item.id));
        updated++;
      }
    } catch { /* checked again on the next pass */ }
  }
  return { updated, cleaned: await dropFinishedVideos(owner), accounts: await checkAccounts(owner) };
}
/** Reel videos are large: once a reel is out (or will never go out), its file is removed from storage. */
export async function dropFinishedVideos(owner: string) {
  const db = getDb();
  const done = await db.select({ id: autopilotItems.id, imageKey: autopilotItems.imageKey }).from(autopilotItems)
    .where(and(eq(autopilotItems.owner, owner), eq(autopilotItems.kind, 'reel'), inArray(autopilotItems.status, ['published', 'failed', 'skipped']), sql`${autopilotItems.imageKey} IS NOT NULL`));
  for (const item of done) {
    await env.BUCKET!.delete(item.imageKey!);
    await db.update(autopilotItems).set({ imageKey: null, updatedAt: now() }).where(eq(autopilotItems.id, item.id));
  }
  return done.length;
}
