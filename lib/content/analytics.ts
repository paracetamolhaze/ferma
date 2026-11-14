/**
 * Analytics of the posts FERMA published itself. Only numbers the networks returned (insights) are used: a post
 * without them is counted as «нет данных», never as zero. A recommendation names its rule and the numbers behind
 * it, and nothing changes until the owner accepts it.
 */
import { and, desc, eq, gte, inArray } from 'drizzle-orm';
import { getDb } from '@/db';
import { contentVariants, profileEditorial, profiles, publications, recommendations, socialAccounts, sourceItems } from '@/db/schema';
import { readEditorial, saveEditorial } from './distribution';
import { STYLE_NAMES, type Style } from './plan';
import { groupBy, metricsOf, proposalsFor, summarize, type Post } from './analytics-rules';
import { PROFILE_STYLE_NAMES, STYLE_ORDER } from './rules';

export class AnalyticsError extends Error {
  constructor(message: string, readonly status = 400) { super(message); }
}
const now = () => new Date().toISOString();
const QUIET_DAYS = 14;

async function publishedPosts(owner: string, days: number, nowMs: number): Promise<Post[]> {
  const rows = await getDb().select({ p: publications, style: contentVariants.style, layout: contentVariants.layout, categories: sourceItems.categories, username: socialAccounts.username, profile: profiles.name, offset: profileEditorial.timezoneOffsetMinutes })
    .from(publications).leftJoin(contentVariants, eq(contentVariants.id, publications.variantId)).leftJoin(sourceItems, eq(sourceItems.id, publications.itemId))
    .leftJoin(socialAccounts, eq(socialAccounts.id, publications.accountId)).leftJoin(profiles, eq(profiles.id, publications.profileId)).leftJoin(profileEditorial, eq(profileEditorial.profileId, publications.profileId))
    .where(and(eq(publications.owner, owner), eq(publications.status, 'published'), gte(publications.publishedAt, new Date(nowMs - days * 86_400_000).toISOString()))).orderBy(desc(publications.publishedAt)).limit(2000);
  return rows.map(({ p, style, layout, categories, username, profile, offset }) => {
    const local = Date.parse(p.publishedAt!) + (offset ?? 300) * 60_000;
    return { id: p.id, platform: p.platform, profileId: p.profileId, profile: profile || '', username, style, format: p.format, layout, hour: new Date(local).getUTCHours(), categories: categories ? JSON.parse(categories) as string[] : [], publishedAt: p.publishedAt!, ...metricsOf(p.stats ? JSON.parse(p.stats) : null) };
  });
}

/** «Аналитика»: totals and the same numbers by platform, account, version style, format, local hour and topic. */
export async function analyticsOverview(owner: string, { days = 30, nowMs = Date.now() }: { days?: number; nowMs?: number } = {}) {
  const posts = await publishedPosts(owner, days, nowMs);
  const proposed = await getDb().select().from(recommendations).where(and(eq(recommendations.owner, owner), eq(recommendations.status, 'proposed'))).orderBy(desc(recommendations.createdAt));
  return {
    days, total: summarize(posts),
    byPlatform: groupBy(posts, post => [post.platform]),
    byAccount: groupBy(posts, post => [`${post.profile} · @${post.username || '—'} (${post.platform === 'threads' ? 'Threads' : 'Instagram'})`]),
    byStyle: groupBy(posts, post => [STYLE_NAMES[post.style as Style] || post.style || 'без стиля']),
    byFormat: groupBy(posts, post => [post.format]),
    byHour: groupBy(posts, post => [`${String(Math.floor(post.hour / 3) * 3).padStart(2, '0')}–${String(Math.floor(post.hour / 3) * 3 + 3).padStart(2, '0')}`]).sort((a, b) => a.name.localeCompare(b.name)),
    byCategory: groupBy(posts, post => post.categories.length ? post.categories : ['без темы']),
    recommendations: proposed.map(row => ({ id: row.id, profileId: row.profileId, kind: row.kind, title: row.title, reason: row.reason, basis: JSON.parse(row.basis), change: JSON.parse(row.change), createdAt: row.createdAt })),
  };
}

/** Recomputed daily by the engine: a proposal the owner turned down or accepted stays quiet for two weeks. */
export async function computeRecommendations(owner: string, { nowMs = Date.now() }: { nowMs?: number } = {}) {
  const db = getDb();
  const posts = await publishedPosts(owner, 30, nowMs);
  const byProfile = new Map<string, Post[]>();
  for (const post of posts) byProfile.set(post.profileId, [...(byProfile.get(post.profileId) || []), post]);
  let proposed = 0;
  const existing = await db.select().from(recommendations).where(eq(recommendations.owner, owner));
  const fresh = new Set<string>();
  for (const [profileId, list] of byProfile) {
    const editorial = await readEditorial(profileId);
    for (const proposal of proposalsFor(profileId, list, editorial, { styleNames: STYLE_NAMES, styleOrder: STYLE_ORDER, profileStyleNames: PROFILE_STYLE_NAMES })) {
      const key = `${proposal.kind}|${profileId}`;
      fresh.add(key);
      const before = existing.find(row => row.kind === proposal.kind && row.profileId === profileId);
      if (before && before.status !== 'proposed' && before.decidedAt && nowMs - Date.parse(before.decidedAt) < QUIET_DAYS * 86_400_000) continue;
      const values = { title: proposal.title, reason: proposal.reason, basis: JSON.stringify(proposal.basis), change: JSON.stringify(proposal.change), status: 'proposed', decidedAt: null, createdAt: now() };
      if (before) await db.update(recommendations).set(values).where(eq(recommendations.id, before.id));
      else await db.insert(recommendations).values({ id: crypto.randomUUID(), owner, profileId, kind: proposal.kind, ...values });
      proposed++;
    }
  }
  // A proposal whose numbers no longer hold is withdrawn.
  const stale = existing.filter(row => row.status === 'proposed' && !fresh.has(`${row.kind}|${row.profileId}`)).map(row => row.id);
  if (stale.length) await db.delete(recommendations).where(inArray(recommendations.id, stale));
  return { proposed, withdrawn: stale.length };
}

export async function decideRecommendation(owner: string, id: string, accept: boolean) {
  const db = getDb();
  const [row] = await db.select().from(recommendations).where(and(eq(recommendations.id, id), eq(recommendations.owner, owner)));
  if (!row || row.status !== 'proposed') throw new AnalyticsError('Рекомендация не найдена или уже решена.', 404);
  if (accept && row.profileId) await saveEditorial(owner, row.profileId, JSON.parse(row.change));
  await db.update(recommendations).set({ status: accept ? 'accepted' : 'dismissed', decidedAt: now() }).where(eq(recommendations.id, id));
  return { ok: true };
}
