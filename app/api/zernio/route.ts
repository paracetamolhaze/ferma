import { z } from 'zod';
import { getChatGPTUser } from '../../chatgpt-auth';
import { ProviderError } from '@/lib/zernio';
import { queueInput, readQueue, readRemotePosts, readStats, saveQueue } from '@/lib/zernio-insights';

export const dynamic = 'force-dynamic';
const json = (data: unknown, status = 200) => Response.json(data, { status, headers: { 'Cache-Control': 'no-store' } });
const profileId = z.string().uuid();
function failure(error: unknown) {
  if (!(error instanceof ProviderError)) return json({ error: 'Не удалось получить данные Zernio.' }, 500);
  const status = error.status === 400 || error.status === 404 ? error.status : 502;
  const message = error.status === 402 ? 'Статистика недоступна на этом тарифе Zernio.' : error.message;
  return json({ error: message }, status);
}
export async function GET(request: Request) {
  const user = await getChatGPTUser();
  if (!user) return json({ error: 'Войдите в аккаунт.' }, 401);
  const params = new URL(request.url).searchParams;
  const profile = profileId.safeParse(params.get('profileId'));
  if (!profile.success) return json({ error: 'Профиль не найден.' }, 404);
  try {
    const view = params.get('view');
    if (view === 'posts') return json(await readRemotePosts(user.userId, profile.data, params.get('status'), Number(params.get('limit') || 50)));
    if (view === 'stats') return json(await readStats(user.userId, profile.data, Number(params.get('days'))));
    if (view === 'queue') return json(await readQueue(user.userId, profile.data));
    return json({ error: 'Неизвестный запрос.' }, 400);
  } catch (error) { return failure(error); }
}
export async function POST(request: Request) {
  const user = await getChatGPTUser();
  if (!user) return json({ error: 'Войдите в аккаунт.' }, 401);
  if (request.headers.get('origin') !== new URL(request.url).origin) return json({ error: 'Недопустимый источник запроса.' }, 403);
  const body = await request.json().catch(() => null) as { profileId?: unknown } | null;
  const profile = profileId.safeParse(body?.profileId);
  const input = queueInput.safeParse(body);
  if (!profile.success || !input.success) return json({ error: 'Добавьте хотя бы одно время публикации.' }, 400);
  try { return json(await saveQueue(user.userId, profile.data, input.data)); }
  catch (error) { return failure(error); }
}
