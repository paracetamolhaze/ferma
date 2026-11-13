import { z } from 'zod';
import { getChatGPTUser } from '../../chatgpt-auth';
import { AutopilotError } from '@/lib/autopilot';
import { engineSources, markSeen, mirrorBegin, pendingComments, readSource, saveSource, sendReply, skipComment } from '@/lib/social';
import { ProviderError } from '@/lib/zernio';

export const dynamic = 'force-dynamic';
const json = (data: unknown, status = 200) => Response.json(data, { status, headers: { 'Cache-Control': 'no-store' } });
const failure = (error: unknown) => error instanceof AutopilotError || error instanceof ProviderError ? json({ error: error.message }, error.status >= 400 && error.status < 600 ? error.status : 502) : json({ error: 'Не удалось выполнить действие.' }, 500);
const id = z.string().uuid();
const inputSchema = z.discriminatedUnion('action', [
  z.object({ action: z.literal('save'), profileId: id, tgChannel: z.string().max(200), replies: z.boolean() }),
  z.object({ action: z.literal('seen'), profileId: id, tgLastId: z.number().int().min(0) }),
  z.object({ action: z.literal('mirror'), profileId: id, tgId: z.number().int().min(1), text: z.string().max(8000), dueAt: z.string().datetime().optional() }),
  z.object({ action: z.literal('reply'), profileId: id, postId: z.string().max(200), commentId: z.string().max(200), message: z.string().max(1000) }),
  z.object({ action: z.literal('skipComment'), profileId: id, postId: z.string().max(200), commentId: z.string().max(200) }),
]);
export async function GET(request: Request) {
  const user = await getChatGPTUser();
  if (!user) return json({ error: 'Войдите в аккаунт.' }, 401);
  const params = new URL(request.url).searchParams;
  try {
    if (params.get('view') === 'engine') return json({ sources: await engineSources(user.userId) });
    const profileId = id.safeParse(params.get('profileId'));
    if (!profileId.success) return json({ error: 'Профиль не найден.' }, 404);
    if (params.get('view') === 'comments') return json(await pendingComments(user.userId, profileId.data));
    return json(await readSource(user.userId, profileId.data));
  } catch (error) { return failure(error); }
}
export async function POST(request: Request) {
  const user = await getChatGPTUser();
  if (!user) return json({ error: 'Войдите в аккаунт.' }, 401);
  if (request.headers.get('origin') !== new URL(request.url).origin) return json({ error: 'Недопустимый источник запроса.' }, 403);
  const parsed = inputSchema.safeParse(await request.json().catch(() => null));
  if (!parsed.success) return json({ error: 'Проверьте заполнение полей.' }, 400);
  const input = parsed.data, owner = user.userId;
  try {
    switch (input.action) {
      case 'save': return json(await saveSource(owner, input.profileId, input));
      case 'seen': return json(await markSeen(owner, input.profileId, input.tgLastId));
      case 'mirror': return json(await mirrorBegin(owner, input.profileId, input.tgId, input.text, input.dueAt));
      case 'reply': return json(await sendReply(owner, input.profileId, input.postId, input.commentId, input.message));
      case 'skipComment': return json(await skipComment(owner, input.profileId, input.postId, input.commentId));
    }
  } catch (error) { return failure(error); }
}
