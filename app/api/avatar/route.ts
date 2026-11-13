import { env } from 'cloudflare:workers';
import { and, eq } from 'drizzle-orm';
import { getChatGPTUser } from '../../chatgpt-auth';
import { getDb } from '@/db';
import { profiles } from '@/db/schema';

export const dynamic = 'force-dynamic';
const TYPES = ['image/jpeg', 'image/png', 'image/webp'];
const MAX_AVATAR = 5 * 1024 * 1024;
const json = (data: unknown, status = 200) => Response.json(data, { status, headers: { 'Cache-Control': 'no-store' } });
const EXTENSIONS: Record<string, string> = { 'image/jpeg': 'jpg', 'image/png': 'png', 'image/webp': 'webp' };

async function owned(owner: string, profileId: string | null) {
  if (!profileId || !/^[0-9a-f-]{36}$/.test(profileId)) return null;
  const [profile] = await getDb().select({ id: profiles.id, name: profiles.name, avatarKey: profiles.avatarKey }).from(profiles).where(and(eq(profiles.id, profileId), eq(profiles.owner, owner)));
  return profile || null;
}
export async function GET(request: Request) {
  const user = await getChatGPTUser();
  if (!user) return new Response(null, { status: 401 });
  const params = new URL(request.url).searchParams;
  const profile = await owned(user.userId, params.get('profileId'));
  if (!profile?.avatarKey) return new Response(null, { status: 404 });
  const object = await env.BUCKET!.get(profile.avatarKey);
  if (!object) return new Response(null, { status: 404 });
  const type = object.httpMetadata?.contentType || 'image/jpeg';
  const headers = new Headers({ 'Content-Type': type, 'Cache-Control': 'private, max-age=31536000, immutable', 'X-Content-Type-Options': 'nosniff' });
  if (params.get('download')) headers.set('Content-Disposition', `attachment; filename*=UTF-8''${encodeURIComponent(`${profile.name}.${EXTENSIONS[type] || 'jpg'}`)}`);
  return new Response(object.body, { headers });
}
export async function POST(request: Request) {
  const user = await getChatGPTUser();
  if (!user) return json({ error: 'Войдите в аккаунт.' }, 401);
  if (request.headers.get('origin') !== new URL(request.url).origin) return json({ error: 'Недопустимый источник запроса.' }, 403);
  const profile = await owned(user.userId, new URL(request.url).searchParams.get('profileId'));
  if (!profile) return json({ error: 'Профиль не найден.' }, 404);
  const type = request.headers.get('content-type') || '';
  const size = Number(request.headers.get('content-length'));
  if (!TYPES.includes(type) || !(size > 0) || size > MAX_AVATAR) {
    // An unread request body restarts the local Workers runtime, so a refused upload is drained first.
    const reader = request.body?.getReader();
    if (reader) while (!(await reader.read()).done) { /* discard */ }
    return json({ error: 'Нужна картинка JPG, PNG или WebP до 5 МБ.' }, 400);
  }
  // A new key per upload lets browsers cache each version forever.
  const key = `${user.userId}/avatars/${profile.id}/${crypto.randomUUID()}`;
  try {
    await env.BUCKET!.put(key, request.body!, { httpMetadata: { contentType: type } });
    await getDb().update(profiles).set({ avatarKey: key }).where(and(eq(profiles.id, profile.id), eq(profiles.owner, user.userId)));
  } catch {
    await env.BUCKET!.delete(key);
    return json({ error: 'Не удалось сохранить аватарку. Повторите попытку.' }, 500);
  }
  if (profile.avatarKey) await env.BUCKET!.delete(profile.avatarKey).catch(() => undefined);
  return json({ avatar: key.split('/').pop() });
}
export async function DELETE(request: Request) {
  const user = await getChatGPTUser();
  if (!user) return json({ error: 'Войдите в аккаунт.' }, 401);
  if (request.headers.get('origin') !== new URL(request.url).origin) return json({ error: 'Недопустимый источник запроса.' }, 403);
  const profile = await owned(user.userId, new URL(request.url).searchParams.get('profileId'));
  if (!profile) return json({ error: 'Профиль не найден.' }, 404);
  await getDb().update(profiles).set({ avatarKey: null }).where(and(eq(profiles.id, profile.id), eq(profiles.owner, user.userId)));
  if (profile.avatarKey) await env.BUCKET!.delete(profile.avatarKey).catch(() => undefined);
  return json({ ok: true });
}
