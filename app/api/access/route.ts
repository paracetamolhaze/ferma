import { z } from 'zod';
import { getChatGPTUser } from '../../chatgpt-auth';
import { buyNumber, FivesimError, listOrders, offers, readBalance, saveFivesimKey, updateOrder } from '@/lib/fivesim';
import { markBackupCode, readSecurity, removeSecurity, revealBackupCodes, saveBackupCodes, saveTotp, SecurityError } from '@/lib/security';

export const dynamic = 'force-dynamic';
const json = (data: unknown, status = 200) => Response.json(data, { status, headers: { 'Cache-Control': 'no-store', Pragma: 'no-cache' } });
const failure = (error: unknown) => error instanceof FivesimError || error instanceof SecurityError ? json({ error: error.message }, error.status) : json({ error: 'Не удалось выполнить действие.' }, 500);
const profileId = z.string().uuid();
const platform = z.string().max(20);
const inputSchema = z.discriminatedUnion('action', [
  z.object({ action: z.literal('fivesimKey'), apiKey: z.string().trim().min(10).max(4096).regex(/^\S+$/) }),
  z.object({ action: z.literal('buy'), profileId, product: z.string().max(20) }),
  z.object({ action: z.enum(['check', 'finish', 'cancel']), id: z.string().regex(/^\d{1,20}$/) }),
  z.object({ action: z.literal('totp'), profileId, platform, secret: z.string().max(600) }),
  z.object({ action: z.literal('backup'), profileId, platform, text: z.string().max(5000) }),
  z.object({ action: z.literal('revealBackup'), profileId, platform }),
  z.object({ action: z.literal('markBackup'), profileId, platform, code: z.string().max(40), used: z.boolean() }),
  z.object({ action: z.literal('remove'), profileId, platform }),
]);
export async function GET(request: Request) {
  const user = await getChatGPTUser();
  if (!user) return json({ error: 'Войдите в аккаунт.' }, 401);
  const params = new URL(request.url).searchParams;
  try {
    if (params.get('view') === 'balance') return json(await readBalance(user.userId));
    if (params.get('view') === 'offers') return json(await offers());
    const profile = profileId.safeParse(params.get('profileId'));
    if (!profile.success) return json({ error: 'Профиль не найден.' }, 404);
    if (params.get('view') === 'orders') return json({ orders: await listOrders(user.userId, profile.data) });
    return json({ entries: await readSecurity(user.userId, profile.data) });
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
      case 'fivesimKey': return json(await saveFivesimKey(owner, input.apiKey));
      case 'buy': return json(await buyNumber(owner, input.profileId, input.product));
      case 'check': case 'finish': case 'cancel': return json(await updateOrder(owner, input.id, input.action));
      case 'totp': return json(await saveTotp(owner, input.profileId, input.platform, input.secret));
      case 'backup': return json(await saveBackupCodes(owner, input.profileId, input.platform, input.text));
      case 'revealBackup': return json({ codes: await revealBackupCodes(owner, input.profileId, input.platform) });
      case 'markBackup': return json({ codes: await markBackupCode(owner, input.profileId, input.platform, input.code, input.used) });
      case 'remove': return json(await removeSecurity(owner, input.profileId, input.platform));
    }
  } catch (error) { return failure(error); }
}
