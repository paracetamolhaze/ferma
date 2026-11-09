import { env } from "cloudflare:workers";
import { and, eq, inArray, desc, sql } from "drizzle-orm";
import { z } from "zod";
import { getChatGPTUser } from "../../chatgpt-auth";
import { getDb } from "@/db";
import { profiles, channels, media, posts, profileIntegrations } from "@/db/schema";
import { validateSchedule, validateTargets } from "@/lib/domain";
import { createZernioClient, ProviderError } from "@/lib/zernio";
import { canSaveIntegrationKey } from '@/lib/integration-settings';
import { importSocialAccounts } from '@/lib/social-import';
import { readMailSettings } from '@/lib/mail';

export const dynamic = "force-dynamic";
const id = z.string().uuid();
const network = z.enum(["youtube", "tiktok", "instagram", "threads", "twitter"]);
const inputSchema = z.discriminatedUnion("action", [
  z.object({ action: z.literal("profile"), name: z.string().trim().min(1).max(80), description: z.string().max(300).default(""), color: z.string().regex(/^#[0-9a-f]{6}$/i) }),
  z.object({ action: z.literal("renameProfile"), profileId: id, name: z.string().trim().min(1).max(80) }),
  z.object({ action: z.literal("importAccounts"), profileId: id, remoteProfileId: z.string().min(1).max(200).optional(), accountIds: z.array(z.string().min(1).max(200)).max(2).optional() }),
  z.object({ action: z.literal("sync"), profileId: id.optional() }),
  z.object({ action: z.literal("draft"), id: id.optional(), profileId: id, title: z.string().trim().min(1).max(100), content: z.string().max(5000), mediaId: id.nullable(), platforms: z.array(network).max(2) }),
  z.object({ action: z.literal("schedule"), id, scheduledFor: z.string().nullish(), queue: z.boolean().optional() }),
  z.object({ action: z.literal("deleteDraft"), id }),
]);
const now = () => new Date().toISOString();
function providerResult<T>(schema: z.ZodType<T>, value: unknown): T {
  const result = schema.safeParse(value);
  if (!result.success) throw new ProviderError('Zernio вернул некорректный ответ. Проверьте статус перед повтором.', 503);
  return result.data;
}
function json(data: unknown, status = 200) { return Response.json(data, { status, headers: { "Cache-Control": "no-store" } }); }
async function ownedProfile(owner: string, profileId: string) {
  const [p] = await getDb().select().from(profiles).where(and(eq(profiles.owner, owner), eq(profiles.id, profileId)));
  if (!p) throw new Error("Профиль не найден.");
  return p;
}
async function syncProfile(owner: string, p: typeof profiles.$inferSelect) {
  const db = getDb();
  const zernio = await createZernioClient(owner, p.id);
  const imported = await importSocialAccounts(owner, p.id);
  if (imported.status !== 'ready') throw new Error('Откройте карточку профиля и выберите соцсети из Zernio.');
  const pending = await db.select().from(posts).where(and(eq(posts.owner, owner), eq(posts.profileId, p.id), inArray(posts.status, ['scheduled', 'processing', 'partial'])));
  for (const post of pending) {
    if (!post.zernioId) continue;
    const data = providerResult(z.object({ post: z.object({ status: z.string(), platforms: z.array(z.object({ platform: z.string(), error: z.unknown().optional() })).optional() }) }), await zernio(`/posts/${encodeURIComponent(post.zernioId)}`));
    const remote = data.post;
    if (!remote) continue;
    const status = ['published', 'scheduled', 'failed', 'partial', 'processing'].includes(remote.status) ? remote.status : 'processing';
    const errors = (remote.platforms || []).filter(entry => entry.error).map(entry => `${entry.platform}: ${typeof entry.error === 'string' ? entry.error : 'Ошибка публикации'}`).join('; ');
    await db.update(posts).set({ status, error: errors || null }).where(and(eq(posts.id, post.id), inArray(posts.status, ['scheduled', 'processing', 'partial'])));
  }
}
export async function GET() {
  const user = await getChatGPTUser();
  if (!user) return json({ error: "Войдите в аккаунт." }, 401);
  const db = getDb();
  const ps = await db.select().from(profiles).where(eq(profiles.owner, user.userId)).orderBy(desc(profiles.createdAt));
  const [cs, ms, ts, keys, mail] = await Promise.all([
    ps.length ? db.select().from(channels).where(inArray(channels.profileId, ps.map(p => p.id))) : [],
    db.select({ id: media.id, name: media.name, type: media.type, size: media.size, createdAt: media.createdAt }).from(media).where(eq(media.owner, user.userId)).orderBy(desc(media.createdAt)),
    db.select({ id: posts.id, profileId: posts.profileId, zernioId: posts.zernioId, title: posts.title, content: posts.content, mediaId: posts.mediaId, platforms: posts.platforms, status: posts.status, scheduledFor: posts.scheduledFor, error: posts.error, createdAt: posts.createdAt }).from(posts).where(eq(posts.owner, user.userId)).orderBy(desc(posts.createdAt)),
    db.select({ profileId: profileIntegrations.profileId }).from(profileIntegrations).where(eq(profileIntegrations.owner, user.userId)),
    readMailSettings(user.userId),
  ]);
  const configuredIds = new Set(keys.map(key => key.profileId));
  return json({ profiles: ps.map(({ owner, zernioId, accountSelection, ...p }) => ({ ...p, configured: configuredIds.has(p.id) })), channels: cs, media: ms, posts: ts, canSaveKey: canSaveIntegrationKey(), mail });
}
export async function POST(request: Request) {
  const user = await getChatGPTUser();
  if (!user) return json({ error: "Войдите в аккаунт." }, 401);
  if (request.headers.get("origin") !== new URL(request.url).origin) return json({ error: "Недопустимый источник запроса." }, 403);
  try {
    const input = inputSchema.parse(await request.json());
    const owner = user.userId, db = getDb();
    if (input.action === "profile") {
      const profile = { id: crypto.randomUUID(), owner, name: input.name, description: input.description, color: input.color, createdAt: now() };
      await db.insert(profiles).values(profile);
      return json({ id: profile.id });
    }
    if (input.action === "sync") {
      const ps = input.profileId ? [await ownedProfile(owner, input.profileId)] : await db.select().from(profiles).where(eq(profiles.owner, owner));
      const keys = await db.select({ profileId: profileIntegrations.profileId }).from(profileIntegrations).where(eq(profileIntegrations.owner, owner));
      const configuredIds = new Set(keys.map(key => key.profileId));
      const failures: string[] = [];
      for (const p of ps) {
        if (!configuredIds.has(p.id) && !input.profileId) continue;
        try { await syncProfile(owner, p); }
        catch (error) { failures.push(`${p.name}: ${error instanceof Error ? error.message : 'Ошибка подключения'}`); }
      }
      if (failures.length) throw new Error(`Не удалось обновить: ${failures.join('; ')}. Остальные профили обработаны.`);
      return json({ ok: true });
    }
    if (input.action === "renameProfile") {
      const changed = await db.update(profiles).set({ name: input.name }).where(and(eq(profiles.id, input.profileId), eq(profiles.owner, owner))).returning({ id: profiles.id });
      if (!changed.length) throw new Error('Профиль не найден.');
      return json({ ok: true });
    }
    if (input.action === "importAccounts") return json(await importSocialAccounts(owner, input.profileId, input));
    if (input.action === "draft") {
      await ownedProfile(owner, input.profileId);
      if (input.mediaId) {
        const [m] = await db.select().from(media).where(and(eq(media.id, input.mediaId), eq(media.owner, owner)));
        if (!m) throw new Error("Файл не найден.");
      }
      const values = { profileId: input.profileId, title: input.title, content: input.content, mediaId: input.mediaId, platforms: JSON.stringify([...new Set(input.platforms)]) };
      if (input.id) {
        const changed = await db.update(posts).set(values).where(and(eq(posts.id, input.id), eq(posts.owner, owner), eq(posts.status, "draft"))).returning({ id: posts.id });
        if (!changed.length) throw new Error("Редактировать можно только свой черновик.");
        return json({ id: input.id });
      }
      const postId = crypto.randomUUID();
      await db.insert(posts).values({ ...values, id: postId, owner, createdAt: now() });
      return json({ id: postId });
    }
    const [post] = await db.select().from(posts).where(and(eq(posts.id, input.id), eq(posts.owner, owner)));
    if (!post) throw new Error("Публикация не найдена.");
    if (input.action === "deleteDraft") {
      const deleted = await db.delete(posts).where(and(eq(posts.id, post.id), eq(posts.status, "draft"))).returning({ id: posts.id });
      if (!deleted.length) throw new Error("Удалить можно только черновик.");
      return json({ ok: true });
    }
    await ownedProfile(owner, post.profileId);
    const [credential] = await db.select({ fingerprint: profileIntegrations.fingerprint }).from(profileIntegrations).where(and(eq(profileIntegrations.owner, owner), eq(profileIntegrations.profileId, post.profileId)));
    if (post.status === 'draft') {
      const imported = await importSocialAccounts(owner, post.profileId);
      if (imported.status !== 'ready') throw new Error('Выберите соцсети из Zernio в карточке профиля перед публикацией.');
    }
    const zernio = await createZernioClient(owner, post.profileId);
    if (!["draft", "uncertain"].includes(post.status)) throw new Error("Публикация уже отправлена или обрабатывается.");
    let payload: Record<string, unknown>;
    if (post.status === "uncertain") {
      if (!post.payload || Date.parse(post.scheduledFor || "") < Date.now()) throw new Error("Проверьте публикацию в Zernio перед повторной отправкой: запланированное время уже прошло.");
      payload = JSON.parse(post.payload);
    } else {
      const timing = input.queue
        ? { queuedFromProfile: (await ownedProfile(owner, post.profileId)).zernioId }
        : { scheduledFor: validateSchedule(input.scheduledFor || "") };
      if ("queuedFromProfile" in timing && !timing.queuedFromProfile) throw new Error("Сначала загрузите соцсети в настройках профиля.");
      const targets: string[] = JSON.parse(post.platforms);
      const connected = await db.select().from(channels).where(and(eq(channels.profileId, post.profileId), eq(channels.state, "connected")));
      if (targets.some(p => !connected.some(c => c.platform === p && c.accountId))) throw new Error("Подключите выбранные соцсети перед планированием.");
      const [m] = post.mediaId ? await db.select().from(media).where(and(eq(media.id, post.mediaId), eq(media.owner, owner))) : [];
      validateTargets(targets, post.content, m?.type.startsWith("video/") ? "video" : m ? "image" : undefined);
      if (!post.content.trim() && !m) throw new Error("Добавьте подпись или файл.");
      const mediaItems = [];
      if (m) {
        const object = await env.BUCKET!.get(m.key);
        if (!object) throw new Error("Файл отсутствует в хранилище.");
        const signed = providerResult(z.object({ uploadUrl:z.string().url(), publicUrl:z.string().url() }), await zernio("/media/presign", { method: "POST", body: JSON.stringify({ filename: m.name, contentType: m.type, size: m.size }) }));
        if (new URL(signed.uploadUrl).protocol !== "https:" || new URL(signed.publicUrl).protocol !== "https:") throw new Error("Некорректный адрес загрузки Zernio.");
        const upload = await fetch(signed.uploadUrl, { method: "PUT", headers: { "Content-Type": m.type, "Content-Length": String(m.size) }, body: object.body, signal: AbortSignal.timeout(120000) });
        if (!upload.ok) throw new Error("Не удалось передать файл в Zernio. Черновик сохранён.");
        mediaItems.push({ type: m.type.startsWith("video/") ? "video" : "image", url: signed.publicUrl });
      }
      payload = { title: post.title, content: post.content, mediaItems, ...timing, timezone: "Asia/Qyzylorda", platforms: targets.map(platform => ({ platform, accountId: connected.find(c => c.platform === platform)!.accountId, ...(platform === "youtube" ? { platformSpecificData: { title: post.title, visibility: "public" } } : {}) })) };
    }
    const lock = await db.update(posts).set({ status: "sending", payload: JSON.stringify(payload), scheduledFor: typeof payload.scheduledFor === "string" ? payload.scheduledFor : null, error: null }).where(and(eq(posts.id, post.id), eq(posts.status, post.status), sql`exists (select 1 from profile_integrations where profileId = ${post.profileId} and fingerprint = ${credential?.fingerprint || ''})`)).returning({ id: posts.id });
    if (!lock.length) throw new Error("Публикация уже отправляется или ключ профиля изменён. Обновите страницу.");
    try {
      const data = providerResult(z.object({post:z.object({_id:z.string().min(1),scheduledFor:z.string().nullish()})}), await zernio("/posts", { method: "POST", body: JSON.stringify(payload) }, `post-${post.id}`));
      if (!data.post?._id) throw new Error("Zernio не вернул ID публикации. Проверьте статус перед повтором.");
      // A queued post learns its time from the slot Zernio assigned.
      await db.update(posts).set({ status: "scheduled", zernioId: data.post._id, error: null, ...(data.post.scheduledFor ? { scheduledFor: data.post.scheduledFor } : {}) }).where(eq(posts.id, post.id));
      return json({ ok: true });
    } catch (error) {
      const certain = error instanceof ProviderError && error.status >= 400 && error.status < 500 && error.status !== 409;
      await db.update(posts).set({ status: certain ? "draft" : "uncertain", error: error instanceof Error ? error.message : "Ответ Zernio не получен" }).where(eq(posts.id, post.id));
      throw error;
    }
  } catch (error) {
    const message = error instanceof z.ZodError ? "Проверьте заполнение полей." : error instanceof Error ? error.message : "Не удалось выполнить действие.";
    return json({ error: message.includes("UNIQUE constraint") ? "Слот уже занят. Обновите список профилей." : message }, error instanceof ProviderError ? (error.status === 503 ? 503 : 502) : 400);
  }
}
