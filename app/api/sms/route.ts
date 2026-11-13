import { z } from 'zod';
import { getChatGPTUser } from '../../chatgpt-auth';
import { MailError } from '@/lib/mail';
import { bindSmsLine, listSms, registerWebhook, revealSigningKey, saveProfilePhone, saveSmsSettings, SmsError } from '@/lib/sms';

export const dynamic = 'force-dynamic';
const json = (data: unknown, status = 200) => Response.json(data, { status, headers: { 'Cache-Control': 'no-store', Pragma: 'no-cache' } });
const failure = (error: unknown) => error instanceof SmsError || error instanceof MailError ? json({ error: error.message }, error.status) : json({ error: 'Не удалось выполнить действие с СМС.' }, 500);
const profileId = z.string().uuid();
const inputSchema = z.discriminatedUnion('action', [
  z.object({ action: z.literal('settings'), baseUrl: z.string().max(500), apiToken: z.string().trim().min(1).max(4096), signingKey: z.string().trim().min(1).max(4096) }),
  z.object({ action: z.literal('register'), username: z.string().trim().min(1).max(200), password: z.string().min(1).max(200) }),
  z.object({ action: z.literal('reveal') }),
  z.object({ action: z.literal('phone'), profileId, phone: z.string().max(40) }),
  z.object({ action: z.literal('bind'), profileId, line: z.string().max(200) }),
]);
export async function GET() {
  const user = await getChatGPTUser();
  if (!user) return json({ error: 'Войдите в аккаунт.' }, 401);
  try { return json({ messages: await listSms(user.userId) }); }
  catch (error) { return failure(error); }
}
export async function POST(request: Request) {
  const user = await getChatGPTUser();
  if (!user) return json({ error: 'Войдите в аккаунт.' }, 401);
  if (request.headers.get('origin') !== new URL(request.url).origin) return json({ error: 'Недопустимый источник запроса.' }, 403);
  const parsed = inputSchema.safeParse(await request.json().catch(() => null));
  if (!parsed.success) return json({ error: 'Проверьте заполнение полей.' }, 400);
  const input = parsed.data, owner = user.userId;
  try {
    if (input.action === 'settings') return json(await saveSmsSettings(owner, input));
    if (input.action === 'register') return json(await registerWebhook(owner, input.username, input.password));
    if (input.action === 'reveal') return json({ signingKey: await revealSigningKey(owner) });
    if (input.action === 'phone') return json({ phone: await saveProfilePhone(owner, input.profileId, input.phone) });
    return json({ line: await bindSmsLine(owner, input.profileId, input.line) });
  } catch (error) { return failure(error); }
}
