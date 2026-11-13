import { and, desc, eq, gt, inArray, like, sql } from 'drizzle-orm';
import { z } from 'zod';
import { getDb } from '@/db';
import { autopilotItems, channels, commentReplies, personas, profiles, profileSources } from '@/db/schema';
import { AutopilotError } from './autopilot';
import { createZernioClient } from './zernio';

const now = () => new Date().toISOString();
const HOUR = 3_600_000;
// Reply pace of a person, not a bot: a few an hour, never two in a row.
export const REPLY_LIMITS = { perHour: 6, perDay: 30, gapMs: 5 * 60_000, lookbackMs: 72 * HOUR };

async function ownedProfile(owner: string, profileId: string) {
  const [profile] = await getDb().select({ id: profiles.id }).from(profiles).where(and(eq(profiles.id, profileId), eq(profiles.owner, owner)));
  if (!profile) throw new AutopilotError('Профиль не найден.', 404);
}
export function normalizeChannel(value: string) {
  const name = value.trim().replace(/^https?:\/\/t\.me\/(s\/)?/i, '').replace(/^@/, '').replace(/\/.*$/, '');
  if (!name) return null;
  if (!/^[A-Za-z][A-Za-z0-9_]{3,31}$/.test(name)) throw new AutopilotError('Укажите публичный канал, например @mychannel или https://t.me/mychannel.');
  return name;
}
export async function readSource(owner: string, profileId: string) {
  await ownedProfile(owner, profileId);
  const [row] = await getDb().select().from(profileSources).where(and(eq(profileSources.profileId, profileId), eq(profileSources.owner, owner)));
  const sent = await getDb().select({ id: commentReplies.commentId }).from(commentReplies).where(and(eq(commentReplies.profileId, profileId), eq(commentReplies.owner, owner), eq(commentReplies.status, 'sent')));
  return { tgChannel: row?.tgChannel || null, tgLastId: row?.tgLastId ?? null, replies: Boolean(row?.replies), repliesSent: sent.length };
}
export async function saveSource(owner: string, profileId: string, input: { tgChannel: string; replies: boolean }) {
  await ownedProfile(owner, profileId);
  const tgChannel = normalizeChannel(input.tgChannel);
  const [row] = await getDb().select().from(profileSources).where(eq(profileSources.profileId, profileId));
  // A new channel starts from its newest post: old posts are never dumped into the feed.
  const tgLastId = row && row.tgChannel === tgChannel ? row.tgLastId : null;
  const values = { tgChannel, tgLastId, replies: input.replies ? 1 : 0, updatedAt: now() };
  await getDb().insert(profileSources).values({ profileId, owner, ...values }).onConflictDoUpdate({ target: profileSources.profileId, set: values });
  // Her own Threads posts that were only planned are dropped; anything already written or sent stays.
  if (tgChannel) await getDb().update(autopilotItems).set({ status: 'skipped', updatedAt: now() }).where(and(eq(autopilotItems.profileId, profileId), eq(autopilotItems.kind, 'threads'), eq(autopilotItems.status, 'planned')));
  return readSource(owner, profileId);
}
/** What the engine works through: every profile with a channel to mirror or replies switched on. */
export async function engineSources(owner: string, nowMs = Date.now()) {
  const db = getDb();
  const rows = await db.select().from(profileSources).where(eq(profileSources.owner, owner));
  const result = [];
  for (const row of rows) {
    if (!row.tgChannel && !row.replies) continue;
    const [profile] = await db.select({ name: profiles.name }).from(profiles).where(eq(profiles.id, row.profileId));
    const [threads] = await db.select().from(channels).where(and(eq(channels.profileId, row.profileId), eq(channels.platform, 'threads'), eq(channels.state, 'connected')));
    const [persona] = await db.select().from(personas).where(eq(personas.profileId, row.profileId));
    if (!profile || !threads?.accountId) continue;
    // Where the queue of copied posts ends: a new copy goes after it, not in the middle.
    const [queue] = await db.select({ until: sql<string | null>`max(${autopilotItems.dueAt})` }).from(autopilotItems).where(and(eq(autopilotItems.profileId, row.profileId), like(autopilotItems.imagePrompt, 'tg:%'), inArray(autopilotItems.status, ['generating', 'ready', 'scheduled']), gt(autopilotItems.dueAt, new Date(nowMs).toISOString())));
    result.push({ profileId: row.profileId, name: profile.name, tgChannel: row.tgChannel, tgLastId: row.tgLastId, replies: Boolean(row.replies), queuedUntil: queue?.until || null, persona: persona ? JSON.parse(persona.persona) : null });
  }
  return result;
}
export async function markSeen(owner: string, profileId: string, tgLastId: number) {
  await getDb().update(profileSources).set({ tgLastId, updatedAt: now() }).where(and(eq(profileSources.profileId, profileId), eq(profileSources.owner, owner)));
  return { ok: true };
}
const MIRROR_ATTEMPTS = 3, MIRROR_STALE_MS = 5 * 60_000;
/**
 * Starts a Threads post copied from the channel, now or at `dueAt` (posts that piled up go out spaced).
 * The marker makes a second copy of the same post impossible; a copy that broke off midway is started again, three times at most.
 */
export async function mirrorBegin(owner: string, profileId: string, tgId: number, text: string, dueAt?: string, nowMs = Date.now()) {
  await ownedProfile(owner, profileId);
  const db = getDb();
  const [source] = await db.select().from(profileSources).where(eq(profileSources.profileId, profileId));
  if (!source?.tgChannel) throw new AutopilotError('У профиля не задан канал.');
  const at = dueAt ? Date.parse(dueAt) : nowMs;
  if (!Number.isFinite(at) || at > nowMs + 60 * 24 * HOUR) throw new AutopilotError('Некорректное время публикации.');
  const marker = `tg:${source.tgChannel}/${tgId}`;
  const [existing] = await db.select({ id: autopilotItems.id, status: autopilotItems.status, attempts: autopilotItems.attempts, updatedAt: autopilotItems.updatedAt }).from(autopilotItems).where(and(eq(autopilotItems.profileId, profileId), eq(autopilotItems.imagePrompt, marker)));
  if (existing && existing.status !== 'generating') return { skip: true };
  // Still being copied right now: the engine waits and keeps its place in the channel.
  if (existing && Date.parse(existing.updatedAt) > nowMs - MIRROR_STALE_MS) return { skip: true, busy: true };
  if (existing && existing.attempts >= MIRROR_ATTEMPTS) {
    await db.update(autopilotItems).set({ status: 'failed', error: 'Пост из канала не удалось скопировать', updatedAt: now() }).where(eq(autopilotItems.id, existing.id));
    return { skip: true };
  }
  if (existing) await db.delete(autopilotItems).where(eq(autopilotItems.id, existing.id));
  const item = { id: crypto.randomUUID(), owner, profileId, kind: 'threads', status: 'generating', dueAt: new Date(Math.max(at, nowMs)).toISOString(), text: text.trim() || null, imagePrompt: marker, attempts: (existing?.attempts || 0) + 1, createdAt: now(), updatedAt: now() };
  await db.insert(autopilotItems).values(item);
  return { skip: false, id: item.id, dueAt: item.dueAt };
}

const comment = z.object({
  id: z.string(), message: z.string().nullish(), createdTime: z.string().nullish(), canReply: z.boolean().optional(),
  from: z.object({ username: z.string().nullish(), isOwner: z.boolean().optional() }).nullish(),
  replies: z.array(z.object({ from: z.object({ isOwner: z.boolean().optional() }).nullish() }).passthrough()).nullish(),
});
const postsList = z.object({ data: z.array(z.object({ id: z.string(), content: z.string().nullish(), commentCount: z.number().nullish() })) });
async function threadsAccount(profileId: string) {
  const [threads] = await getDb().select().from(channels).where(and(eq(channels.profileId, profileId), eq(channels.platform, 'threads'), eq(channels.state, 'connected')));
  if (!threads?.accountId) throw new AutopilotError('У профиля не подключён Threads.');
  return threads.accountId;
}
/** Comments on the profile's own Threads posts that nobody has answered yet. */
export async function pendingComments(owner: string, profileId: string, nowMs = Date.now()) {
  await ownedProfile(owner, profileId);
  const accountId = await threadsAccount(profileId);
  const zernio = await createZernioClient(owner, profileId);
  const since = new Date(nowMs - REPLY_LIMITS.lookbackMs).toISOString();
  const listed = postsList.parse(await zernio(`/inbox/comments?accountId=${encodeURIComponent(accountId)}&platform=threads&minComments=1&limit=20&since=${encodeURIComponent(since)}`));
  const handled = new Set((await getDb().select({ id: commentReplies.commentId }).from(commentReplies).where(eq(commentReplies.profileId, profileId))).map(row => row.id));
  const pending = [];
  for (const post of listed.data.slice(0, 8)) {
    const data = z.object({ comments: z.array(comment) }).parse(await zernio(`/inbox/comments/${encodeURIComponent(post.id)}?accountId=${encodeURIComponent(accountId)}&limit=30`));
    for (const item of data.comments) {
      if (handled.has(item.id) || item.from?.isOwner || item.canReply === false || !item.message?.trim()) continue;
      if (item.createdTime && Date.parse(item.createdTime) < nowMs - REPLY_LIMITS.lookbackMs) continue;
      // She already answered in this branch, by hand or earlier: leave it alone.
      if (item.replies?.some(reply => reply.from?.isOwner)) continue;
      pending.push({ postId: post.id, post: (post.content || '').slice(0, 500), commentId: item.id, author: item.from?.username || '', text: item.message.trim().slice(0, 500) });
    }
  }
  return { comments: pending };
}
export async function skipComment(owner: string, profileId: string, postId: string, commentId: string) {
  await ownedProfile(owner, profileId);
  await getDb().insert(commentReplies).values({ commentId, owner, profileId, postId, status: 'skipped', createdAt: now() }).onConflictDoNothing();
  return { ok: true };
}
export async function sendReply(owner: string, profileId: string, postId: string, commentId: string, message: string, nowMs = Date.now()) {
  await ownedProfile(owner, profileId);
  const text = message.trim().slice(0, 480);
  if (!text) throw new AutopilotError('Пустой ответ.');
  const db = getDb();
  const sent = await db.select({ at: commentReplies.createdAt }).from(commentReplies).where(and(eq(commentReplies.profileId, profileId), eq(commentReplies.status, 'sent'), gt(commentReplies.createdAt, new Date(nowMs - 24 * HOUR).toISOString()))).orderBy(desc(commentReplies.createdAt));
  if (sent.length >= REPLY_LIMITS.perDay || sent.filter(row => Date.parse(row.at) > nowMs - HOUR).length >= REPLY_LIMITS.perHour || (sent[0] && Date.parse(sent[0].at) > nowMs - REPLY_LIMITS.gapMs)) return { sent: false, reason: 'limit' };
  // The insert is the lock: a comment gets at most one reply, whatever happens next.
  const claimed = await db.insert(commentReplies).values({ commentId, owner, profileId, postId, status: 'sending', reply: text, createdAt: new Date(nowMs).toISOString() }).onConflictDoNothing().returning({ id: commentReplies.commentId });
  if (!claimed.length) return { sent: false, reason: 'handled' };
  try {
    const zernio = await createZernioClient(owner, profileId);
    await zernio(`/inbox/comments/${encodeURIComponent(postId)}`, { method: 'POST', body: JSON.stringify({ accountId: await threadsAccount(profileId), message: text, commentId }) }, `reply-${commentId}`);
    await db.update(commentReplies).set({ status: 'sent' }).where(eq(commentReplies.commentId, commentId));
    return { sent: true };
  } catch (error) {
    await db.update(commentReplies).set({ status: 'failed', reply: `${text}\n[${error instanceof Error ? error.message.slice(0, 200) : 'ошибка'}]` }).where(eq(commentReplies.commentId, commentId));
    return { sent: false, reason: 'failed' };
  }
}
export const repliesToday = async (profileId: string) => (await getDb().select({ n: sql<number>`count(*)` }).from(commentReplies).where(and(eq(commentReplies.profileId, profileId), eq(commentReplies.status, 'sent'))))[0]?.n ?? 0;
