import { z } from 'zod';
import { getChatGPTUser } from '../../chatgpt-auth';
import { AnalyticsError, analyticsOverview, computeRecommendations, decideRecommendation } from '@/lib/content/analytics';
import { DistributionError } from '@/lib/content/distribution';

export const dynamic = 'force-dynamic';
const json = (data: unknown, status = 200) => Response.json(data, { status, headers: { 'Cache-Control': 'no-store' } });
const failure = (error: unknown) => error instanceof AnalyticsError || error instanceof DistributionError ? json({ error: error.message }, error.status) : json({ error: error instanceof Error ? `Не удалось: ${error.message}` : 'Не удалось выполнить действие.' }, 500);
const inputSchema = z.discriminatedUnion('action', [
  z.object({ action: z.literal('compute') }),
  z.object({ action: z.literal('decide'), id: z.string().uuid(), accept: z.boolean() }),
]);

export async function GET(request: Request) {
  const user = await getChatGPTUser();
  if (!user) return json({ error: 'Войдите в аккаунт.' }, 401);
  const days = Number(new URL(request.url).searchParams.get('days')) || 30;
  try { return json(await analyticsOverview(user.userId, { days: Math.min(90, Math.max(1, days)) })); } catch (error) { return failure(error); }
}
export async function POST(request: Request) {
  const user = await getChatGPTUser();
  if (!user) return json({ error: 'Войдите в аккаунт.' }, 401);
  if (request.headers.get('origin') !== new URL(request.url).origin) return json({ error: 'Недопустимый источник запроса.' }, 403);
  const parsed = inputSchema.safeParse(await request.json().catch(() => null));
  if (!parsed.success) return json({ error: 'Проверьте заполнение полей.' }, 400);
  try {
    if (parsed.data.action === 'compute') return json(await computeRecommendations(user.userId));
    return json(await decideRecommendation(user.userId, parsed.data.id, parsed.data.accept));
  } catch (error) { return failure(error); }
}
