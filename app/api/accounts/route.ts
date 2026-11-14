import { z } from 'zod';
import { getChatGPTUser } from '../../chatgpt-auth';
import { AccountError, accountsOverview, checkAccounts, finishConnect, removeAccount, saveApp, setAccountEnabled, startConnect } from '@/lib/publish/accounts';
import { appDiagnostics, diagnoseAccount, mediaLinkCheck, readMediaTest, startMediaTest } from '@/lib/publish/diagnostics';
import { PublishError } from '@/lib/publish/types';

export const dynamic = 'force-dynamic';
const json = (data: unknown, status = 200) => Response.json(data, { status, headers: { 'Cache-Control': 'no-store' } });
const failure = (error: unknown) => error instanceof AccountError ? json({ error: error.message }, error.status)
  : error instanceof PublishError ? json({ error: error.message }, error.kind === 'auth' ? 409 : 502)
  : json({ error: 'Не удалось выполнить действие с аккаунтом.' }, 500);
const id = z.string().uuid();
const provider = z.enum(['meta_threads', 'meta_instagram']);
const inputSchema = z.discriminatedUnion('action', [
  z.object({ action: z.literal('saveApp'), provider, appId: z.string().max(40), appSecret: z.string().max(200).nullish(), redirectUri: z.string().max(300) }),
  z.object({ action: z.literal('connect'), provider, profileId: id }),
  z.object({ action: z.literal('finish'), state: z.string().min(10).max(100), code: z.string().min(4).max(2000) }),
  z.object({ action: z.literal('check') }),
  z.object({ action: z.literal('enabled'), accountId: id, enabled: z.boolean() }),
  z.object({ action: z.literal('remove'), accountId: id }),
  z.object({ action: z.literal('diagnoseApps') }),
  z.object({ action: z.literal('diagnose'), accountId: id }),
  // staleHours: only accounts not checked for that long (the engine's daily run survives restarts this way).
  z.object({ action: z.literal('diagnoseAll'), staleHours: z.number().int().min(0).max(168).optional() }),
  z.object({ action: z.literal('mediaTest'), accountId: id }),
  z.object({ action: z.literal('mediaTestStatus'), accountId: id }),
]);
export async function GET() {
  const user = await getChatGPTUser();
  if (!user) return json({ error: 'Войдите в аккаунт.' }, 401);
  try { return json(await accountsOverview(user.userId)); } catch (error) { return failure(error); }
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
      case 'saveApp': return json(await saveApp(owner, input.provider, input));
      case 'connect': return json(await startConnect(owner, input.profileId, input.provider));
      case 'finish': return json(await finishConnect(owner, input.state, input.code));
      case 'check': return json(await checkAccounts(owner));
      case 'enabled': return json(await setAccountEnabled(owner, input.accountId, input.enabled));
      case 'remove': return json(await removeAccount(owner, input.accountId));
      case 'diagnoseApps': return json({ ...await appDiagnostics(owner), media: await mediaLinkCheck(owner) });
      case 'diagnose': return json(await diagnoseAccount(owner, input.accountId));
      case 'diagnoseAll': {
        const { accounts } = await accountsOverview(owner);
        let checked = 0;
        const since = Date.now() - (input.staleHours ?? 0) * 3600_000;
        for (const account of accounts) {
          if (account.status === 'disabled' || (input.staleHours && account.diagnostics && Date.parse(account.diagnostics.at) > since)) continue;
          await diagnoseAccount(owner, account.id);
          checked++;
        }
        return json({ checked });
      }
      case 'mediaTest': return json(await startMediaTest(owner, input.accountId));
      case 'mediaTestStatus': return json(await readMediaTest(owner, input.accountId));
    }
  } catch (error) { return failure(error); }
}
