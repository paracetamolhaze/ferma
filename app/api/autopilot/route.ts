import { z } from 'zod';
import { getChatGPTUser } from '../../chatgpt-auth';
import { AutopilotError, reelReach, recover, setCaption, onboardList, setRhythm, cancel, addStock, takeStock, claim, complete, engineState, fail, heartbeat, plan, publish, readImage, readProfileAutopilot, savePersona, setEnabled, skip, storeImage, sync } from '@/lib/autopilot';
import { KINDS } from '@/lib/rhythm';
import { ProviderError } from '@/lib/zernio';

export const dynamic = 'force-dynamic';
const json = (data: unknown, status = 200) => Response.json(data, { status, headers: { 'Cache-Control': 'no-store' } });
const failure = (error: unknown) => error instanceof AutopilotError || error instanceof ProviderError ? json({ error: error.message }, error.status >= 400 && error.status < 600 ? error.status : 502) : json({ error: 'Не удалось выполнить действие автопилота.' }, 500);
const id = z.string().uuid();
const inputSchema = z.discriminatedUnion('action', [
  z.object({ action: z.literal('persona'), profileId: id, persona: z.string().max(20000) }),
  z.object({ action: z.literal('rhythm'), profileId: id, rhythm: z.unknown() }),
  z.object({ action: z.literal('enabled'), profileId: id, enabled: z.boolean() }),
  z.object({ action: z.literal('plan'), profileId: id, kind: z.enum(KINDS) }),
  z.object({ action: z.literal('claim'), id }),
  z.object({ action: z.literal('stock'), profileId: id, kind: z.enum(KINDS), text: z.string().max(5000).nullish() }),
  z.object({ action: z.literal('takeStock'), id }),
  z.object({ action: z.literal('caption'), id, text: z.string().max(2200) }),
  z.object({ action: z.literal('complete'), id, text: z.string().max(5000).nullish(), imagePrompt: z.string().max(6000).nullish() }),
  z.object({ action: z.literal('fail'), id, error: z.string().max(2000) }),
  z.object({ action: z.literal('skip'), id }),
  z.object({ action: z.literal('cancel'), id }),
  z.object({ action: z.literal('publish'), id }),
  z.object({ action: z.literal('sync') }),
  z.object({ action: z.literal('recover') }),
  z.object({ action: z.literal('heartbeat'), bridgeOk: z.boolean(), note: z.string().max(500).nullish() }),
]);
export async function GET(request: Request) {
  const user = await getChatGPTUser();
  if (!user) return json({ error: 'Войдите в аккаунт.' }, 401);
  const params = new URL(request.url).searchParams;
  try {
    if (params.get('view') === 'onboard') return json({ profiles: await onboardList(user.userId) });
    if (params.get('view') === 'engine') return json({ profiles: await engineState(user.userId) });
    if (params.get('view') === 'reels') return json({ profiles: await reelReach(user.userId) });
    const image = params.get('image');
    if (image) {
      if (!id.safeParse(image).success) return new Response(null, { status: 404 });
      const object = await readImage(user.userId, image, Number(params.get('n') || 0));
      if (!object) return new Response(null, { status: 404 });
      return new Response(object.body, { headers: { 'Content-Type': object.httpMetadata?.contentType || 'image/png', 'Cache-Control': 'private, max-age=86400', 'X-Content-Type-Options': 'nosniff' } });
    }
    const profileId = id.safeParse(params.get('profileId'));
    if (!profileId.success) return json({ error: 'Профиль не найден.' }, 404);
    return json(await readProfileAutopilot(user.userId, profileId.data));
  } catch (error) { return failure(error); }
}
export async function POST(request: Request) {
  const user = await getChatGPTUser();
  if (!user) return json({ error: 'Войдите в аккаунт.' }, 401);
  if (request.headers.get('origin') !== new URL(request.url).origin) return json({ error: 'Недопустимый источник запроса.' }, 403);
  const owner = user.userId;
  const upload = new URL(request.url).searchParams.get('upload');
  try {
    if (upload) {
      if (!id.safeParse(upload).success) return json({ error: 'Публикация не найдена.' }, 404);
      return json(await storeImage(owner, upload, request.headers.get('content-type') || '', await request.arrayBuffer(), Number(new URL(request.url).searchParams.get('n') || 0)));
    }
    const parsed = inputSchema.safeParse(await request.json().catch(() => null));
    if (!parsed.success) return json({ error: 'Проверьте заполнение полей.' }, 400);
    const input = parsed.data;
    switch (input.action) {
      case 'persona': return json(await savePersona(owner, input.profileId, input.persona));
      case 'rhythm': return json(await setRhythm(owner, input.profileId, input.rhythm));
      case 'enabled': return json(await setEnabled(owner, input.profileId, input.enabled));
      case 'plan': return json(await plan(owner, input.profileId, input.kind));
      case 'claim': return json(await claim(owner, input.id));
      case 'stock': return json(await addStock(owner, input.profileId, input.kind, input.text ?? null));
      case 'takeStock': return json(await takeStock(owner, input.id));
      case 'caption': return json(await setCaption(owner, input.id, input.text));
      case 'complete': return json(await complete(owner, input.id, input));
      case 'fail': return json(await fail(owner, input.id, input.error));
      case 'skip': return json(await skip(owner, input.id));
      case 'cancel': return json(await cancel(owner, input.id));
      case 'publish': return json(await publish(owner, input.id));
      case 'sync': return json(await sync(owner));
      case 'recover': return json(await recover(owner));
      case 'heartbeat': await heartbeat(owner, input.bridgeOk, input.note ?? null); return json({ ok: true });
    }
  } catch (error) { return failure(error); }
}
