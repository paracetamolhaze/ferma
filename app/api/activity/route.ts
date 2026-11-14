import { z } from 'zod';
import { getChatGPTUser } from '../../chatgpt-auth';
import { acceptSuggestions, activityOverview, EngagementError, fetchEngagement, ignoreTask, replyTick, sendReply, suggestionJob } from '@/lib/publish/engagement';

export const dynamic = 'force-dynamic';
const json = (data: unknown, status = 200) => Response.json(data, { status, headers: { 'Cache-Control': 'no-store' } });
const failure = (error: unknown) => error instanceof EngagementError ? json({ error: error.message }, error.status) : json({ error: error instanceof Error ? `Не удалось: ${error.message}` : 'Не удалось выполнить действие.' }, 500);
const id = z.string().uuid();
const inputSchema = z.discriminatedUnion('action', [
  z.object({ action: z.literal('fetch') }),
  z.object({ action: z.literal('acceptSuggestions'), ids: z.array(id).min(1).max(20), replies: z.array(z.object({ id: z.string().max(80).optional(), text: z.string().max(4000).optional(), skip: z.boolean().optional() })).max(20).nullable() }),
  z.object({ action: z.literal('replyTick') }),
  z.object({ action: z.literal('send'), id, text: z.string().min(1).max(4000) }),
  z.object({ action: z.literal('ignore'), id }),
]);

export async function GET(request: Request) {
  const user = await getChatGPTUser();
  if (!user) return json({ error: 'Войдите в аккаунт.' }, 401);
  const params = new URL(request.url).searchParams;
  try {
    if (params.get('view') === 'suggest') return json({ job: await suggestionJob(user.userId) });
    const accountId = id.safeParse(params.get('accountId'));
    return json(await activityOverview(user.userId, { accountId: accountId.success ? accountId.data : undefined }));
  } catch (error) { return failure(error); }
}
export async function POST(request: Request) {
  const user = await getChatGPTUser();
  if (!user) return json({ error: 'Войдите в аккаунт.' }, 401);
  if (request.headers.get('origin') !== new URL(request.url).origin) return json({ error: 'Недопустимый источник запроса.' }, 403);
  const parsed = inputSchema.safeParse(await request.json().catch(() => null));
  if (!parsed.success) return json({ error: 'Проверьте заполнение полей.' }, 400);
  const input = parsed.data;
  const owner = user.userId;
  try {
    switch (input.action) {
      case 'fetch': return json(await fetchEngagement(owner));
      case 'acceptSuggestions': return json(await acceptSuggestions(owner, input.ids, input.replies));
      case 'replyTick': return json(await replyTick(owner));
      case 'send': return json(await sendReply(owner, input.id, input.text));
      case 'ignore': return json(await ignoreTask(owner, input.id));
    }
  } catch (error) { return failure(error); }
}
