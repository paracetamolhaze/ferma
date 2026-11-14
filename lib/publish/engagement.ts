/**
 * «Активность»: replies (Threads) and comments (Instagram) under the posts FERMA published through the owner's
 * own Meta accounts. The AI only suggests an answer; an answer goes out only when the owner presses «Отправить»
 * with the text they approved. Nothing is answered automatically, nobody is imitated.
 * Docs (checked 2026-11-14): developers.facebook.com/documentation/threads/retrieve-and-manage-replies,
 * /threads/retrieve-and-manage-replies/create-replies, /instagram-platform/comment-moderation.
 */
import { and, asc, desc, eq, gte, inArray, isNotNull, isNull, lt, lte, or, sql } from 'drizzle-orm';
import { getDb } from '@/db';
import { engagementTasks, profileEditorial, profiles, publications, socialAccounts, sourceItems } from '@/db/schema';
import { freshToken } from './accounts';
import { INSTAGRAM_GRAPH } from './instagram';
import { graphClient, str } from './meta';
import { THREADS_GRAPH, threadsLength } from './threads';
import { PublishError } from './types';

export class EngagementError extends Error {
  constructor(message: string, readonly status = 400) { super(message); }
}
const now = () => new Date().toISOString();
type Task = typeof engagementTasks.$inferSelect;
const LIMITS: Record<string, number> = { threads: 500, instagram: 2200 };
/** Threads asks to wait about 30 seconds between creating a container and publishing it. */
const THREADS_WAIT_MS = 30_000;

/**
 * Reads new replies and comments under the posts of the last 7 days, the posts read longest ago first.
 * The account's own answers are skipped. Each reply is stored once (account + reply id).
 */
export async function fetchEngagement(owner: string, { request = fetch, nowMs = Date.now(), perPass = 10 }: { request?: typeof fetch; nowMs?: number; perPass?: number } = {}) {
  const db = getDb();
  const posts = await db.select({ p: publications, account: socialAccounts }).from(publications).innerJoin(socialAccounts, eq(socialAccounts.id, publications.accountId))
    .where(and(eq(publications.owner, owner), eq(publications.status, 'published'), isNotNull(publications.remoteId), gte(publications.publishedAt, new Date(nowMs - 7 * 86_400_000).toISOString()),
      eq(socialAccounts.status, 'connected'), or(isNull(publications.repliesAt), lt(publications.repliesAt, new Date(nowMs - 30 * 60_000).toISOString()))))
    .orderBy(asc(publications.repliesAt)).limit(perPass);
  let added = 0;
  const errors: string[] = [];
  for (const { p, account } of posts) {
    try {
      const token = await freshToken(owner, account, request, nowMs);
      const graph = graphClient(request, 20_000);
      const found = account.provider === 'meta_threads'
        ? ((await graph('GET', `${THREADS_GRAPH}/v1.0/${p.remoteId}/replies`, { fields: 'id,text,username,timestamp,is_reply_owned_by_me', reverse: false }, token.accessToken)).data as Record<string, unknown>[] | undefined || [])
          .filter(reply => reply.is_reply_owned_by_me !== true).map(reply => ({ id: str(reply.id), text: str(reply.text), author: str(reply.username) || null, at: str(reply.timestamp) }))
        : ((await graph('GET', `${INSTAGRAM_GRAPH}/v27.0/${p.remoteId}/comments`, { fields: 'id,text,username,timestamp' }, token.accessToken)).data as Record<string, unknown>[] | undefined || [])
          .filter(comment => str(comment.username) !== account.username).map(comment => ({ id: str(comment.id), text: str(comment.text), author: str(comment.username) || null, at: str(comment.timestamp) }));
      for (const reply of found.filter(entry => entry.id && entry.text)) {
        const inserted = await db.insert(engagementTasks).values({
          id: crypto.randomUUID(), owner, profileId: p.profileId, accountId: account.id, publicationId: p.id, kind: account.platform === 'threads' ? 'reply' : 'comment', remoteId: reply.id,
          author: reply.author, text: reply.text.slice(0, 2000), status: 'new', receivedAt: reply.at || now(), createdAt: now(), platform: account.platform, remotePostId: p.remoteId, updatedAt: now(),
        }).onConflictDoNothing().returning({ id: engagementTasks.id });
        added += inserted.length;
      }
    } catch (error) {
      errors.push(`@${account.username}: ${error instanceof Error ? error.message : 'не прочитано'}`);
    }
    await db.update(publications).set({ repliesAt: new Date(nowMs).toISOString() }).where(eq(publications.id, p.id));
  }
  return { posts: posts.length, added, errors };
}

/** New replies waiting for a suggested answer, as one task for the GPT bridge (up to 10 at once). */
export async function suggestionJob(owner: string) {
  const db = getDb();
  const tasks = await db.select({ t: engagementTasks, post: publications.text, title: sourceItems.title, profile: profiles.name, style: profileEditorial.style }).from(engagementTasks)
    .leftJoin(publications, eq(publications.id, engagementTasks.publicationId)).leftJoin(sourceItems, eq(sourceItems.id, publications.itemId))
    .leftJoin(profiles, eq(profiles.id, engagementTasks.profileId)).leftJoin(profileEditorial, eq(profileEditorial.profileId, engagementTasks.profileId))
    .where(and(eq(engagementTasks.owner, owner), eq(engagementTasks.status, 'new'))).orderBy(asc(engagementTasks.receivedAt)).limit(10);
  if (!tasks.length) return null;
  const system = `Ты помогаешь автору новостного аккаунта отвечать на комментарии под его постами. Предлагаешь ответ, который автор прочитает, поправит и отправит сам.
Правила: коротко и по делу, вежливо, на языке комментария; никаких новых фактов, чисел и обещаний, которых нет в посте; не спорь и не оскорбляй; не выдавай себя за другого человека.
Если комментарий - спам, реклама, оскорбление или на него не нужно отвечать, верни "skip": true и пустой ответ. Отвечай строго одним JSON-объектом без пояснений.`;
  const user = `${tasks.map(({ t, post, title, profile, style }) => `--- id ${t.id}
Аккаунт: ${profile || ''} (${t.platform === 'threads' ? 'Threads' : 'Instagram'}, подача: ${style || 'neutral'}), лимит ответа ${LIMITS[t.platform || 'threads']} знаков
Пост: ${(post || title || '').slice(0, 800)}
Комментарий${t.author ? ` от @${t.author}` : ''}: ${(t.text || '').slice(0, 800)}`).join('\n')}

Верни JSON: {"replies": [{"id": "...", "text": "...", "skip": false}]}`;
  return { ids: tasks.map(({ t }) => t.id), system, user };
}
/** Stores the suggestions; the owner sees each one with the comment and decides. */
export async function acceptSuggestions(owner: string, ids: string[], answer: { id?: unknown; text?: unknown; skip?: unknown }[] | null) {
  const db = getDb();
  let suggested = 0;
  for (const id of ids) {
    const given = answer?.find(entry => entry.id === id);
    const [task] = await db.select().from(engagementTasks).where(and(eq(engagementTasks.id, id), eq(engagementTasks.owner, owner), eq(engagementTasks.status, 'new')));
    if (!task) continue;
    const limit = LIMITS[task.platform || 'threads'];
    const text = typeof given?.text === 'string' ? given.text.trim().slice(0, limit) : '';
    await db.update(engagementTasks).set({ status: 'suggested', suggestion: given?.skip === true ? null : text || null, error: given?.skip === true ? 'ИИ советует не отвечать.' : !given ? 'ИИ не предложил ответ.' : null, updatedAt: now() }).where(eq(engagementTasks.id, id));
    suggested++;
  }
  return { suggested };
}

async function ownedTask(owner: string, id: string) {
  const [task] = await getDb().select().from(engagementTasks).where(and(eq(engagementTasks.id, id), eq(engagementTasks.owner, owner)));
  if (!task) throw new EngagementError('Комментарий не найден.', 404);
  return task;
}
async function accountOf(owner: string, task: Task) {
  const [account] = await getDb().select().from(socialAccounts).where(and(eq(socialAccounts.id, task.accountId), eq(socialAccounts.owner, owner)));
  if (!account || account.status !== 'connected') throw new EngagementError('Аккаунт не подключён: ответить нельзя.', 409);
  return account;
}

/**
 * The owner's approved answer. Instagram: one call. Threads: a reply container now, its publication by the engine
 * half a minute later. A task already being sent or sent is refused, so an answer never goes out twice.
 */
export async function sendReply(owner: string, id: string, text: string, { request = fetch, nowMs = Date.now() }: { request?: typeof fetch; nowMs?: number } = {}) {
  const db = getDb();
  const task = await ownedTask(owner, id);
  if (!['new', 'suggested', 'failed'].includes(task.status)) throw new EngagementError('На этот комментарий ответ уже отправляется или отправлен.', 409);
  const answer = text.trim();
  if (!answer) throw new EngagementError('Напишите ответ.');
  const limit = LIMITS[task.platform || 'threads'];
  if ((task.platform === 'threads' ? threadsLength(answer) : answer.length) > limit) throw new EngagementError(`Ответ длиннее ${limit} знаков.`);
  const account = await accountOf(owner, task);
  // The lock: the status changes in one statement, so a second press finds «sending» and stops here.
  const claimed = await db.update(engagementTasks).set({ status: 'sending', reply: answer, error: null, updatedAt: new Date(nowMs).toISOString() }).where(and(eq(engagementTasks.id, id), eq(engagementTasks.status, task.status))).returning({ id: engagementTasks.id });
  if (!claimed.length) throw new EngagementError('На этот комментарий ответ уже отправляется.', 409);
  try {
    const token = await freshToken(owner, account, request, nowMs);
    const graph = graphClient(request, 20_000);
    if (account.provider === 'meta_threads') {
      const body = await graph('POST', `${THREADS_GRAPH}/v1.0/${token.userId}/threads`, { media_type: 'TEXT', text: answer, reply_to_id: task.remoteId }, token.accessToken);
      if (!str(body.id)) throw new PublishError('Threads не создал ответ.', 'temporary');
      await db.update(engagementTasks).set({ replyContainerId: str(body.id), updatedAt: new Date(nowMs).toISOString() }).where(eq(engagementTasks.id, id));
      return { status: 'sending' };
    }
    const body = await graph('POST', `${INSTAGRAM_GRAPH}/v27.0/${task.remoteId}/replies`, { message: answer }, token.accessToken);
    await db.update(engagementTasks).set({ status: 'sent', replyRemoteId: str(body.id) || null, repliedAt: new Date(nowMs).toISOString(), updatedAt: new Date(nowMs).toISOString() }).where(eq(engagementTasks.id, id));
    return { status: 'sent' };
  } catch (error) {
    const lost = error instanceof PublishError && error.kind === 'temporary' && error.detail === 'network';
    const message = lost ? 'Ответ соцсети потерялся: проверьте пост, прежде чем отправлять снова.' : error instanceof Error ? error.message : 'Ответ не отправлен.';
    await db.update(engagementTasks).set({ status: 'failed', error: message.slice(0, 300), updatedAt: now() }).where(eq(engagementTasks.id, id));
    throw new EngagementError(message, 502);
  }
}
/** Threads answers whose container is half a minute old: published now. Called by the engine. */
export async function replyTick(owner: string, { request = fetch, nowMs = Date.now() }: { request?: typeof fetch; nowMs?: number } = {}) {
  const db = getDb();
  const due = await db.select().from(engagementTasks).where(and(eq(engagementTasks.owner, owner), eq(engagementTasks.status, 'sending'), isNotNull(engagementTasks.replyContainerId), lte(engagementTasks.updatedAt, new Date(nowMs - THREADS_WAIT_MS).toISOString()))).limit(10);
  let sent = 0;
  for (const task of due) {
    try {
      const account = await accountOf(owner, task);
      const token = await freshToken(owner, account, request, nowMs);
      const body = await graphClient(request, 20_000)('POST', `${THREADS_GRAPH}/v1.0/${token.userId}/threads_publish`, { creation_id: task.replyContainerId }, token.accessToken);
      await db.update(engagementTasks).set({ status: 'sent', replyRemoteId: str(body.id) || null, repliedAt: new Date(nowMs).toISOString(), updatedAt: new Date(nowMs).toISOString() }).where(eq(engagementTasks.id, task.id));
      sent++;
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Ответ не опубликован.';
      await db.update(engagementTasks).set({ status: 'failed', error: `Ответ не опубликован: ${message}`.slice(0, 300), updatedAt: now() }).where(eq(engagementTasks.id, task.id));
    }
  }
  return { sent };
}
export async function ignoreTask(owner: string, id: string) {
  const task = await ownedTask(owner, id);
  if (['sending', 'sent'].includes(task.status)) throw new EngagementError('Ответ уже отправлен.', 409);
  await getDb().update(engagementTasks).set({ status: 'ignored', updatedAt: now() }).where(eq(engagementTasks.id, id));
  return { ok: true };
}

/**
 * The «Активность» screen: comments waiting for the owner, what was answered, a history per account and the
 * notifications (failures, expired access, pauses, Gudini trouble). Everything comes from FERMA's own records.
 */
export async function activityOverview(owner: string, { accountId, nowMs = Date.now() }: { accountId?: string; nowMs?: number } = {}) {
  const db = getDb();
  const filter = accountId ? [eq(engagementTasks.accountId, accountId)] : [];
  const tasks = await db.select({ t: engagementTasks, post: publications.text, permalink: publications.permalink, username: socialAccounts.username }).from(engagementTasks)
    .leftJoin(publications, eq(publications.id, engagementTasks.publicationId)).leftJoin(socialAccounts, eq(socialAccounts.id, engagementTasks.accountId))
    .where(and(eq(engagementTasks.owner, owner), ...filter)).orderBy(desc(engagementTasks.receivedAt)).limit(200);
  const accounts = await db.select({ id: socialAccounts.id, platform: socialAccounts.platform, username: socialAccounts.username, status: socialAccounts.status, profileId: socialAccounts.profileId }).from(socialAccounts).where(and(eq(socialAccounts.owner, owner), inArray(socialAccounts.status, ['connected', 'expired', 'error'])));
  const history = accountId ? await db.select({ id: publications.id, status: publications.status, at: sql<string>`coalesce(${publications.publishedAt}, ${publications.scheduledFor})`, text: publications.text, permalink: publications.permalink, stats: publications.stats, error: publications.error, title: sourceItems.title })
    .from(publications).leftJoin(sourceItems, eq(sourceItems.id, publications.itemId)).where(and(eq(publications.owner, owner), eq(publications.accountId, accountId))).orderBy(desc(sql`coalesce(${publications.publishedAt}, ${publications.scheduledFor})`)).limit(50) : [];
  const day = new Date(nowMs - 86_400_000).toISOString();
  const failed = await db.select({ id: publications.id, error: publications.error, at: publications.updatedAt, platform: publications.platform }).from(publications).where(and(eq(publications.owner, owner), eq(publications.status, 'failed'), gte(publications.updatedAt, new Date(nowMs - 7 * 86_400_000).toISOString()))).orderBy(desc(publications.updatedAt)).limit(10);
  const notifications = [
    ...failed.map(row => ({ kind: 'publication_failed', at: row.at, text: `Публикация в ${row.platform === 'threads' ? 'Threads' : 'Instagram'} не вышла: ${row.error || 'без причины'}`, id: row.id })),
    ...accounts.filter(account => account.status !== 'connected').map(account => ({ kind: 'account', at: null as string | null, text: `@${account.username}: ${account.status === 'expired' ? 'доступ истёк, подключите заново' : 'ошибка проверки аккаунта'}`, id: account.id })),
  ];
  const [waiting] = await db.select({ n: sql<number>`count(*)` }).from(engagementTasks).where(and(eq(engagementTasks.owner, owner), inArray(engagementTasks.status, ['new', 'suggested'])));
  const [answeredToday] = await db.select({ n: sql<number>`count(*)` }).from(engagementTasks).where(and(eq(engagementTasks.owner, owner), eq(engagementTasks.status, 'sent'), gte(engagementTasks.repliedAt, day)));
  return {
    waiting: waiting?.n ?? 0, answeredToday: answeredToday?.n ?? 0, accounts, notifications,
    tasks: tasks.map(({ t, post, permalink, username }) => ({ id: t.id, accountId: t.accountId, username, platform: t.platform, kind: t.kind, author: t.author, text: t.text, status: t.status, receivedAt: t.receivedAt, suggestion: t.suggestion, reply: t.reply, repliedAt: t.repliedAt, error: t.error, post: post?.slice(0, 300) ?? null, permalink })),
    history: history.map(row => ({ ...row, stats: row.stats ? JSON.parse(row.stats) : null })),
  };
}
