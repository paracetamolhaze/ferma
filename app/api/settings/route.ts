import { z } from 'zod';
import { getChatGPTUser } from '../../chatgpt-auth';
import { canSaveIntegrationKey, saveZernioKey, readZernioKey } from '@/lib/integration-settings';
import { importSocialAccounts } from '@/lib/social-import';
import { validateZernioKey } from '@/lib/zernio-validation';
import { getDb } from '@/db';
import { profiles } from '@/db/schema';
import { and, eq } from 'drizzle-orm';

const schema = z.union([z.object({ action: z.literal('reveal'), profileId: z.string().uuid() }), z.object({ profileId: z.string().uuid(), apiKey: z.string().trim().min(1).max(4096).regex(/^\S+$/) })]);
const json = (data: unknown, status = 200) => Response.json(data, { status, headers: { 'Cache-Control': 'no-store', 'Pragma': 'no-cache' } });
export async function POST(request: Request) {
  const user = await getChatGPTUser();
  if (!user) return json({ error: 'Войдите в аккаунт.' }, 401);
  if (request.headers.get('origin') !== new URL(request.url).origin) return json({ error: 'Недопустимый источник запроса.' }, 403);
  if (!canSaveIntegrationKey()) return json({ error: 'Хранилище ключей не настроено на сервере.' }, 503);
  const input = schema.safeParse(await request.json().catch(() => null));
  if (!input.success) return json({ error: 'Выберите профиль и вставьте API-ключ Zernio без пробелов.' }, 400);
  const [profile] = await getDb().select().from(profiles).where(and(eq(profiles.id, input.data.profileId), eq(profiles.owner, user.userId)));
  if (!profile) return json({ error: 'Профиль не найден.' }, 404);
  if ('action' in input.data) {
    try {
      const apiKey = await readZernioKey(user.userId, profile.id);
      return apiKey ? json({ apiKey }) : json({ error: 'В профиле ещё нет сохранённого ключа.' }, 404);
    } catch { return json({ error: 'Не удалось прочитать сохранённый ключ.' }, 500); }
  }
  let remoteProfiles: string[];
  try {
    remoteProfiles = await validateZernioKey(input.data.apiKey);
  } catch (error) {
    return json({ error: error instanceof Error ? error.message : 'Не удалось проверить ключ.' }, 400);
  }
  try {
    await saveZernioKey(user.userId, profile.id, input.data.apiKey, Boolean(profile.zernioId && !remoteProfiles.includes(profile.zernioId)));
    try { return json({ ok: true, sync: await importSocialAccounts(user.userId, profile.id) }); }
    catch { return json({ ok: true, warning: 'Ключ сохранён, но соцсети пока не удалось загрузить. Нажмите «Обновить» в профиле.' }); }
  } catch (error) {
    if (error instanceof Error && (error.message.startsWith('Этот ключ') || error.message.includes('UNIQUE constraint'))) return json({ error: 'Этот ключ уже используется в другом профиле. Добавьте отдельный ключ.' }, 409);
    if (error instanceof Error && error.message.startsWith('Публикация сейчас')) return json({ error: error.message }, 409);
    return json({ error: 'Не удалось сохранить ключ. Попробуйте ещё раз.' }, 500);
  }
}
