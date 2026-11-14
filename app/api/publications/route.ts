import { z } from 'zod';
import { getChatGPTUser } from '../../chatgpt-auth';
import { approve, cancelPublication, publicationEventsOf, publicationTick, queueOverview, QueueError, reschedule, retryPublication, stopAll, syncStats } from '@/lib/publish/queue';
import { checkAccounts } from '@/lib/publish/accounts';

export const dynamic = 'force-dynamic';
const json = (data: unknown, status = 200) => Response.json(data, { status, headers: { 'Cache-Control': 'no-store' } });
const failure = (error: unknown) => error instanceof QueueError ? json({ error: error.message }, error.status) : json({ error: error instanceof Error ? `Не удалось: ${error.message}` : 'Не удалось выполнить действие.' }, 500);
const id = z.string().uuid();
const inputSchema = z.discriminatedUnion('action', [
  z.object({ action: z.literal('tick') }),
  z.object({ action: z.literal('stats') }),
  z.object({ action: z.literal('checkAccounts') }),
  z.object({ action: z.literal('approve'), id }),
  z.object({ action: z.literal('approveMany'), ids: z.array(id).min(1).max(100) }),
  z.object({ action: z.literal('cancel'), id }),
  z.object({ action: z.literal('retry'), id }),
  z.object({ action: z.literal('reschedule'), id, at: z.string().max(40) }),
  z.object({ action: z.literal('stopAll'), zernio: z.boolean().default(false) }),
]);
export async function GET(request: Request) {
  const user = await getChatGPTUser();
  if (!user) return json({ error: 'Войдите в аккаунт.' }, 401);
  const params = new URL(request.url).searchParams;
  try {
    const events = params.get('events');
    if (events) return id.safeParse(events).success ? json({ events: await publicationEventsOf(user.userId, events) }) : json({ error: 'Публикация не найдена.' }, 404);
    return json(await queueOverview(user.userId));
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
      case 'tick': return json(await publicationTick(owner));
      case 'stats': return json(await syncStats(owner));
      case 'checkAccounts': return json(await checkAccounts(owner));
      case 'approve': return json(await approve(owner, input.id));
      case 'approveMany': { let approved = 0; for (const item of input.ids) { try { await approve(owner, item); approved++; } catch { /* already moved */ } } return json({ approved }); }
      case 'cancel': return json(await cancelPublication(owner, input.id));
      case 'retry': return json(await retryPublication(owner, input.id));
      case 'reschedule': return json(await reschedule(owner, input.id, input.at));
      case 'stopAll': return json(await stopAll(owner, { zernio: input.zernio }));
    }
  } catch (error) { return failure(error); }
}
