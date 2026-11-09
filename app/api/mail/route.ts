import { z } from 'zod';
import { getChatGPTUser } from '../../chatgpt-auth';
import { listProfileMail, MailError, readProfileMail, saveMailSettings, saveProfileAddress } from '@/lib/mail';

export const dynamic = 'force-dynamic';
const json = (data: unknown, status = 200) => Response.json(data, { status, headers: { 'Cache-Control': 'no-store', Pragma: 'no-cache' } });
const failure = (error: unknown) => error instanceof MailError ? json({ error: error.message }, error.status) : json({ error: 'Не удалось выполнить действие с почтой.' }, 500);
const profileId = z.string().uuid();
const inputSchema = z.discriminatedUnion('action', [
  z.object({ action: z.literal('settings'), baseUrl: z.string().max(500), domain: z.string().max(253), apiToken: z.string().trim().max(4096).regex(/^\S*$/).optional() }),
  z.object({ action: z.literal('address'), profileId, local: z.string().max(100) }),
]);

export async function GET(request: Request) {
  const user = await getChatGPTUser();
  if (!user) return json({ error: 'Войдите в аккаунт.' }, 401);
  const params = new URL(request.url).searchParams;
  const profile = profileId.safeParse(params.get('profileId'));
  if (!profile.success) return json({ error: 'Профиль не найден.' }, 404);
  const id = params.get('id');
  try { return json(id ? await readProfileMail(user.userId, profile.data, id) : await listProfileMail(user.userId, profile.data)); }
  catch (error) { return failure(error); }
}
export async function POST(request: Request) {
  const user = await getChatGPTUser();
  if (!user) return json({ error: 'Войдите в аккаунт.' }, 401);
  if (request.headers.get('origin') !== new URL(request.url).origin) return json({ error: 'Недопустимый источник запроса.' }, 403);
  const input = inputSchema.safeParse(await request.json().catch(() => null));
  if (!input.success) return json({ error: 'Проверьте заполнение полей.' }, 400);
  try {
    if (input.data.action === 'settings') return json(await saveMailSettings(user.userId, input.data));
    return json({ local: await saveProfileAddress(user.userId, input.data.profileId, input.data.local) });
  } catch (error) { return failure(error); }
}
