import { getChatGPTUser } from '../../chatgpt-auth';
import { systemOverview } from '@/lib/system';

export const dynamic = 'force-dynamic';
const json = (data: unknown, status = 200) => Response.json(data, { status, headers: { 'Cache-Control': 'no-store' } });

/** «Состояние системы». Repeats go through the sections' own actions (sources, versions, publications). */
export async function GET() {
  const user = await getChatGPTUser();
  if (!user) return json({ error: 'Войдите в аккаунт.' }, 401);
  try { return json(await systemOverview(user.userId)); }
  catch (error) { return json({ error: error instanceof Error ? `Не удалось прочитать состояние: ${error.message}` : 'Не удалось прочитать состояние.' }, 500); }
}
