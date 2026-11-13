import { env } from 'cloudflare:workers';
import { and, eq } from 'drizzle-orm';
import { getDb } from '@/db';
import { activations, autopilotItems, channels, commentReplies, personas, posts, profileIntegrations, profiles, profileSecrets, profileSources } from '@/db/schema';
import { createZernioClient } from './zernio';

/**
 * Removes a profile and everything FERMA keeps for it. Publications still waiting in Zernio are cancelled
 * first, so nothing keeps posting for a profile that no longer exists here.
 */
export async function deleteProfile(owner: string, profileId: string) {
  const db = getDb();
  const [profile] = await db.select().from(profiles).where(and(eq(profiles.id, profileId), eq(profiles.owner, owner)));
  if (!profile) throw new Error('Профиль не найден.');
  const ownPosts = await db.select({ status: posts.status, zernioId: posts.zernioId }).from(posts).where(and(eq(posts.profileId, profileId), eq(posts.owner, owner)));
  if (ownPosts.some(post => post.status === 'sending')) throw new Error('Публикация сейчас отправляется. Повторите удаление через минуту.');
  const items = await db.select().from(autopilotItems).where(and(eq(autopilotItems.profileId, profileId), eq(autopilotItems.owner, owner)));

  const waiting = [
    ...items.filter(item => item.status === 'scheduled' && item.zernioPostId).map(item => item.zernioPostId!),
    ...ownPosts.filter(post => post.status === 'scheduled' && post.zernioId).map(post => post.zernioId!),
  ];
  let cancelled = 0;
  const notCancelled: string[] = [];
  if (waiting.length) {
    let zernio: Awaited<ReturnType<typeof createZernioClient>> | null = null;
    try { zernio = await createZernioClient(owner, profileId); } catch { /* no key: nothing can be cancelled */ }
    for (const id of waiting) {
      try { if (!zernio) throw new Error('no key'); await zernio(`/posts/${encodeURIComponent(id)}`, { method: 'DELETE' }); cancelled++; }
      catch { notCancelled.push(id); }
    }
  }
  // Children first: every table that points at the profile, then the profile itself, in one atomic batch.
  await db.batch([
    db.delete(autopilotItems).where(and(eq(autopilotItems.profileId, profileId), eq(autopilotItems.owner, owner))),
    db.delete(profileSources).where(and(eq(profileSources.profileId, profileId), eq(profileSources.owner, owner))),
    db.delete(commentReplies).where(and(eq(commentReplies.profileId, profileId), eq(commentReplies.owner, owner))),
    db.delete(personas).where(and(eq(personas.profileId, profileId), eq(personas.owner, owner))),
    db.delete(profileSecrets).where(and(eq(profileSecrets.profileId, profileId), eq(profileSecrets.owner, owner))),
    db.delete(activations).where(and(eq(activations.profileId, profileId), eq(activations.owner, owner))),
    db.delete(posts).where(and(eq(posts.profileId, profileId), eq(posts.owner, owner))),
    db.delete(channels).where(eq(channels.profileId, profileId)),
    db.delete(profileIntegrations).where(and(eq(profileIntegrations.profileId, profileId), eq(profileIntegrations.owner, owner))),
    db.delete(profiles).where(and(eq(profiles.id, profileId), eq(profiles.owner, owner))),
  ]);
  // Files go last: a failure here leaves orphan files, never a half-deleted profile.
  const keys = [profile.avatarKey, ...items.flatMap(item => item.imageKey ? Array.from({ length: item.extraImages + 1 }, (_, index) => index === 0 ? item.imageKey! : `${item.imageKey}-${index}`) : [])].filter((key): key is string => Boolean(key));
  for (let index = 0; index < keys.length; index += 100) await env.BUCKET!.delete(keys.slice(index, index + 100)).catch(() => undefined);
  return { ok: true, cancelled, notCancelled: notCancelled.length };
}
