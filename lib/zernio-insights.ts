import { and, eq } from 'drizzle-orm';
import { z } from 'zod';
import { getDb } from '@/db';
import { profiles } from '@/db/schema';
import { createZernioClient, ProviderError } from './zernio';

export const QUEUE_TIMEZONE = 'Asia/Qyzylorda';
const count = z.number().catch(0).default(0);
function parse<T>(schema: z.ZodType<T, z.ZodTypeDef, unknown>, value: unknown): T {
  const result = schema.safeParse(value);
  if (!result.success) throw new ProviderError('Zernio вернул данные в неожиданном формате.', 503);
  return result.data;
}
async function connect(owner: string, profileId: string) {
  const [profile] = await getDb().select({ zernioId: profiles.zernioId }).from(profiles).where(and(eq(profiles.id, profileId), eq(profiles.owner, owner)));
  if (!profile) throw new ProviderError('Профиль не найден.', 404);
  const zernio = await createZernioClient(owner, profileId);
  if (!profile.zernioId) throw new ProviderError('Сначала загрузите соцсети в настройках профиля.', 400);
  return { zernio, remoteId: encodeURIComponent(profile.zernioId), rawRemoteId: profile.zernioId };
}

const remotePost = z.object({
  _id: z.string(), title: z.string().nullish(), content: z.string().nullish(), status: z.string(), scheduledFor: z.string().nullish(),
  queuedFromProfile: z.string().nullish(),
  mediaItems: z.array(z.object({ type: z.string().nullish() })).nullish(),
  platforms: z.array(z.object({
    platform: z.string(), status: z.string().nullish(), publishedAt: z.string().nullish(), platformPostUrl: z.string().nullish(),
    errorMessage: z.string().nullish(), error: z.unknown().optional(),
  })).nullish(),
});
const safeUrl = (value?: string | null) => value && value.startsWith('https://') ? value : null;
export type RemotePost = {
  id: string; title: string; content: string; status: string; at: string | null; queued: boolean; media: string | null;
  platforms: { platform: string; status: string | null; publishedAt: string | null; url: string | null; error: string | null }[];
};
const mapPost = (post: z.infer<typeof remotePost>): RemotePost => ({
  id: post._id, title: post.title || '', content: (post.content || '').slice(0, 280), status: post.status, at: post.scheduledFor || null,
  queued: Boolean(post.queuedFromProfile), media: post.mediaItems?.[0]?.type || null,
  platforms: (post.platforms || []).map(item => ({
    platform: item.platform, status: item.status || null, publishedAt: item.publishedAt || null, url: safeUrl(item.platformPostUrl),
    error: item.errorMessage || (typeof item.error === 'string' ? item.error : null),
  })),
});
const STATUSES = new Set(['draft', 'pending_approval', 'scheduled', 'publishing', 'published', 'partial', 'failed', 'cancelled']);
export async function readRemotePosts(owner: string, profileId: string, status?: string | null, limit = 50) {
  const { zernio, remoteId } = await connect(owner, profileId);
  const filter = status && STATUSES.has(status) ? `&status=${status}` : '';
  const size = Number.isInteger(limit) && limit >= 1 && limit <= 50 ? limit : 50;
  const data = parse(z.object({ posts: z.array(remotePost), pagination: z.object({ total: z.number() }).partial().optional() }), await zernio(`/posts?limit=${size}&profileId=${remoteId}${filter}`));
  return { posts: data.posts.map(mapPost), total: data.pagination?.total ?? data.posts.length };
}

const metrics = z.object({ impressions: count, reach: count, likes: count, comments: count, shares: count, saves: count, clicks: count, views: count });
const dashboard = z.object({
  totals: metrics,
  previousTotals: metrics.optional(),
  followers: z.object({ current: count, gained: count }),
  daily: z.array(z.object({ date: z.string(), impressions: count, reach: count, engagement: count, views: count, followersGained: count })),
  topPosts: z.array(z.object({ postId: z.string(), platform: z.string().nullish(), publishedAt: z.string().nullish(), metrics })),
  dataAsOf: z.string().nullish(),
});
export type ProfileStats = z.infer<typeof dashboard>;
const day = (offset: number) => new Date(Date.now() - offset * 86400000).toISOString().slice(0, 10);
export async function readStats(owner: string, profileId: string, days: number): Promise<ProfileStats> {
  const { zernio, remoteId } = await connect(owner, profileId);
  const window = [7, 30, 90].includes(days) ? days : 30;
  return parse(dashboard, await zernio(`/analytics/dashboard?profileId=${remoteId}&fromDate=${day(window - 1)}&toDate=${day(0)}&compare=previous_period&topPosts=10&recentPosts=0`));
}

const followersByAccount = z.object({
  followers: z.object({ byAccount: z.array(z.object({ accountId: z.string().nullish(), platform: z.string().nullish(), current: z.number().nullish() })).nullish() }).nullish(),
}).passthrough();
/** Followers of the profile's Instagram account (not the Threads one), or null when Zernio does not say. */
export async function readInstagramFollowers(owner: string, profileId: string, accountId: string) {
  const { zernio, remoteId } = await connect(owner, profileId);
  const data = followersByAccount.parse(await zernio(`/analytics/dashboard?profileId=${remoteId}&fromDate=${day(6)}&toDate=${day(0)}&compare=previous_period&topPosts=10&recentPosts=0`));
  const accounts = data.followers?.byAccount || [];
  const entry = accounts.find(item => item.accountId === accountId) ?? accounts.find(item => item.platform === 'instagram');
  return typeof entry?.current === 'number' ? entry.current : null;
}

export const CONNECT_PLATFORMS = ['instagram', 'threads'];
export async function readConnectUrl(owner: string, profileId: string, platform: string) {
  if (!CONNECT_PLATFORMS.includes(platform)) throw new ProviderError('Эту соцсеть нельзя подключить отсюда.', 400);
  const { zernio, remoteId } = await connect(owner, profileId);
  const { authUrl } = parse(z.object({ authUrl: z.string().url() }), await zernio(`/connect/${platform}?profileId=${remoteId}`));
  if (!authUrl.startsWith('https://')) throw new ProviderError('Zernio вернул небезопасную ссылку подключения.', 503);
  return { authUrl };
}

const slot = z.object({ dayOfWeek: z.number().int().min(0).max(6), time: z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/) });
const queueResponse = z.object({
  exists: z.boolean().optional(),
  schedule: z.object({ slots: z.array(slot).default([]), active: z.boolean().default(true), timezone: z.string().nullish() }).nullish(),
  nextSlots: z.array(z.string()).nullish(),
});
export type ProfileQueue = { exists: boolean; active: boolean; slots: z.infer<typeof slot>[]; timezone: string; nextSlots: string[] };
const mapQueue = (data: z.infer<typeof queueResponse>): ProfileQueue => ({
  exists: Boolean(data.schedule), active: Boolean(data.schedule?.active), slots: data.schedule?.slots || [],
  timezone: data.schedule?.timezone || QUEUE_TIMEZONE, nextSlots: data.nextSlots || [],
});
export const queueInput = z.object({ slots: z.array(slot).min(1).max(100), active: z.boolean() });
export async function readQueue(owner: string, profileId: string) {
  const { zernio, remoteId } = await connect(owner, profileId);
  return mapQueue(parse(queueResponse, await zernio(`/queue/slots?profileId=${remoteId}`)));
}
export async function saveQueue(owner: string, profileId: string, input: z.infer<typeof queueInput>) {
  const { zernio, rawRemoteId } = await connect(owner, profileId);
  const unique = [...new Map(input.slots.map(item => [`${item.dayOfWeek} ${item.time}`, item])).values()];
  await zernio('/queue/slots', { method: 'PUT', body: JSON.stringify({ profileId: rawRemoteId, name: 'FERMA', timezone: QUEUE_TIMEZONE, slots: unique, active: input.active }) });
  return readQueue(owner, profileId);
}
