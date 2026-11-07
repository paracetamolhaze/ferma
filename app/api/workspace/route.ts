import { env } from "cloudflare:workers";
import { and, eq, inArray, desc } from "drizzle-orm";
import { z } from "zod";
import { getChatGPTUser } from "../../chatgpt-auth";
import { getDb } from "@/db";
import { profiles, channels, media, posts } from "@/db/schema";
import { NETWORKS, validateSchedule, validateTargets } from "@/lib/domain";
import { isConfigured, zernio, ProviderError } from "@/lib/zernio";

export const dynamic = "force-dynamic";
const id = z.string().uuid();
const network = z.enum(["youtube", "tiktok", "instagram", "threads", "twitter"]);
const inputSchema = z.discriminatedUnion("action", [
  z.object({ action: z.literal("profile"), name: z.string().trim().min(1).max(80), description: z.string().max(300).default(""), color: z.string().regex(/^#[0-9a-f]{6}$/i) }),
  z.object({ action: z.literal("connect"), profileId: id, platform: network }),
  z.object({ action: z.literal("sync") }),
  z.object({ action: z.literal("cancelConnection"), channelId: id }),
  z.object({ action: z.literal("draft"), id: id.optional(), profileId: id, title: z.string().trim().min(1).max(100), content: z.string().max(5000), mediaId: id.nullable(), platforms: z.array(network).max(2) }),
  z.object({ action: z.literal("schedule"), id, scheduledFor: z.string() }),
  z.object({ action: z.literal("deleteDraft"), id }),
]);
const now = () => new Date().toISOString();
function json(data: unknown, status = 200) { return Response.json(data, { status, headers: { "Cache-Control": "no-store" } }); }
async function ownedProfile(owner: string, profileId: string) {
  const [p] = await getDb().select().from(profiles).where(and(eq(profiles.owner, owner), eq(profiles.id, profileId)));
  if (!p) throw new Error("Профиль не найден.");
  return p;
}
async function syncChannels(owner: string) {
  const db = getDb();
  const ps = await db.select().from(profiles).where(eq(profiles.owner, owner));
  for (const p of ps) {
    if (!p.zernioId) continue;
    const data = await zernio(`/accounts?profileId=${encodeURIComponent(p.zernioId)}`);
    const list = Array.isArray(data.accounts) ? data.accounts : [];
    const slots = await db.select().from(channels).where(eq(channels.profileId, p.id));
    for (const c of slots) {
      const a = c.accountId ? list.find((a: any) => a._id === c.accountId) : list.find((a: any) => a.platform === c.platform);
      if (a) await db.update(channels).set({ accountId: a._id, username: a.username || a.displayName || c.platform, state: a.isActive === false ? "disconnected" : "connected" }).where(eq(channels.id, c.id));
      else if (c.accountId) await db.update(channels).set({ state: "disconnected" }).where(eq(channels.id, c.id));
    }
  }
}
export async function GET() {
  const user = await getChatGPTUser();
  if (!user) return json({ error: "Войдите в аккаунт." }, 401);
  const db = getDb();
  const ps = await db.select().from(profiles).where(eq(profiles.owner, user.userId)).orderBy(desc(profiles.createdAt));
  const [cs, ms, ts] = await Promise.all([
    ps.length ? db.select().from(channels).where(inArray(channels.profileId, ps.map(p => p.id))) : [],
    db.select({ id: media.id, name: media.name, type: media.type, size: media.size, createdAt: media.createdAt }).from(media).where(eq(media.owner, user.userId)).orderBy(desc(media.createdAt)),
    db.select({ id: posts.id, profileId: posts.profileId, title: posts.title, content: posts.content, mediaId: posts.mediaId, platforms: posts.platforms, status: posts.status, scheduledFor: posts.scheduledFor, error: posts.error, createdAt: posts.createdAt }).from(posts).where(eq(posts.owner, user.userId)).orderBy(desc(posts.createdAt)),
  ]);
  return json({ profiles: ps.map(({ owner, zernioId, ...p }) => p), channels: cs, media: ms, posts: ts, configured: isConfigured() });
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
      await zernio("/profiles?limit=1");
      await syncChannels(owner);
      const pending = await db.select().from(posts).where(and(eq(posts.owner, owner), inArray(posts.status, ["scheduled", "processing", "partial"])));
      for (const post of pending) {
        if (!post.zernioId) continue;
        const data = await zernio(`/posts/${encodeURIComponent(post.zernioId)}`);
        const remote = data.post;
        if (!remote) continue;
        const status = ["published", "scheduled", "failed", "partial", "processing"].includes(remote.status) ? remote.status : "processing";
        const errors = (remote.platforms || []).filter((p: any) => p.error).map((p: any) => `${p.platform}: ${typeof p.error === "string" ? p.error : "Ошибка публикации"}`).join("; ");
        await db.update(posts).set({ status, error: errors || null }).where(eq(posts.id, post.id));
      }
      return json({ ok: true });
    }
    if (input.action === "connect") {
      if (!isConfigured()) throw new ProviderError("Сначала настройте ключ Zernio в разделе «Настройки».", 503);
      const p = await ownedProfile(owner, input.profileId);
      if (!p.zernioId) {
        const found = await zernio(`/profiles?externalId=${encodeURIComponent(p.id)}`);
        const remote = found.profiles?.[0] || (await zernio("/profiles", { method: "POST", body: JSON.stringify({ name: `${p.name} · ${p.id.slice(0,8)}`, externalId: p.id, color: p.color, timezone: "Asia/Qyzylorda" }) }, `profile-${p.id}`)).profile;
        if (!remote?._id) throw new Error("Zernio не вернул идентификатор профиля.");
        p.zernioId = remote._id;
        await db.update(profiles).set({ zernioId: p.zernioId }).where(eq(profiles.id, p.id));
      }
      const existing = await db.select().from(channels).where(eq(channels.profileId, p.id));
      let channel = existing.find(c => c.platform === input.platform);
      if (!channel) {
        const slot = [0, 1].find(slot => !existing.some(c => c.slot === slot));
        if (slot === undefined) throw new Error("У профиля уже заняты оба слота соцсетей.");
        channel = { id: crypto.randomUUID(), profileId: p.id, slot, platform: input.platform, accountId: null, username: null, state: "pending", createdAt: now() };
        await db.insert(channels).values(channel);
      }
      const query = new URLSearchParams({ profileId: p.zernioId!, redirect_url: `${new URL(request.url).origin}/?oauth=1` });
      if (channel.accountId) query.set("reconnectAccountId", channel.accountId);
      const data = await zernio(`/connect/${input.platform}?${query}`);
      if (!data.authUrl || new URL(data.authUrl).protocol !== "https:") throw new Error("Не удалось получить ссылку авторизации.");
      return json({ authUrl: data.authUrl });
    }
    if (input.action === "cancelConnection") {
      const [c] = await db.select().from(channels).where(eq(channels.id, input.channelId));
      if (!c) throw new Error("Подключение не найдено.");
      const p = await ownedProfile(owner, c.profileId);
      if (c.accountId) throw new Error("Можно отменить только незавершённое подключение.");
      if (p.zernioId) {
        const data = await zernio(`/accounts?profileId=${encodeURIComponent(p.zernioId)}`);
        if (data.accounts?.some((a: any) => a.platform === c.platform)) throw new Error("Соцсеть уже авторизована. Нажмите «Обновить статусы».");
      }
      await db.delete(channels).where(eq(channels.id, c.id));
      return json({ ok: true });
    }
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
    if (!isConfigured()) throw new ProviderError("Для публикации настройте Zernio.", 503);
    if (!["draft", "uncertain"].includes(post.status)) throw new Error("Публикация уже отправлена или обрабатывается.");
    let payload: Record<string, unknown>;
    if (post.status === "uncertain") {
      if (!post.payload || Date.parse(post.scheduledFor || "") < Date.now()) throw new Error("Проверьте публикацию в Zernio перед повторной отправкой: запланированное время уже прошло.");
      payload = JSON.parse(post.payload);
    } else {
      const scheduledFor = validateSchedule(input.scheduledFor);
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
        const signed = await zernio("/media/presign", { method: "POST", body: JSON.stringify({ filename: m.name, contentType: m.type, size: m.size }) });
        if (new URL(signed.uploadUrl).protocol !== "https:" || new URL(signed.publicUrl).protocol !== "https:") throw new Error("Некорректный адрес загрузки Zernio.");
        const upload = await fetch(signed.uploadUrl, { method: "PUT", headers: { "Content-Type": m.type, "Content-Length": String(m.size) }, body: object.body, signal: AbortSignal.timeout(120000) });
        if (!upload.ok) throw new Error("Не удалось передать файл в Zernio. Черновик сохранён.");
        mediaItems.push({ type: m.type.startsWith("video/") ? "video" : "image", url: signed.publicUrl });
      }
      payload = { title: post.title, content: post.content, mediaItems, scheduledFor, timezone: "Asia/Qyzylorda", platforms: targets.map(platform => ({ platform, accountId: connected.find(c => c.platform === platform)!.accountId, ...(platform === "youtube" ? { platformSpecificData: { title: post.title, visibility: "public" } } : {}) })) };
    }
    const lock = await db.update(posts).set({ status: "sending", payload: JSON.stringify(payload), scheduledFor: String(payload.scheduledFor), error: null }).where(and(eq(posts.id, post.id), eq(posts.status, post.status))).returning({ id: posts.id });
    if (!lock.length) throw new Error("Публикация уже отправляется в другой вкладке.");
    try {
      const data = await zernio("/posts", { method: "POST", body: JSON.stringify(payload) }, `post-${post.id}`);
      if (!data.post?._id) throw new Error("Zernio не вернул ID публикации. Проверьте статус перед повтором.");
      await db.update(posts).set({ status: "scheduled", zernioId: data.post._id, error: null }).where(eq(posts.id, post.id));
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
