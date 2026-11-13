import { env } from 'cloudflare:workers';
import { and, eq } from 'drizzle-orm';
import { z } from 'zod';
import { getDb } from '@/db';
import { profiles, smsSettings } from '@/db/schema';
import { extractCode } from './mail-codes';
import { normalizeMailUrl } from './mail';
import { decryptSecret, encryptSecret } from './secret-crypto';

export class SmsError extends Error {
  constructor(message: string, readonly status = 400) { super(message); }
}
const GATEWAY_WEBHOOKS = 'https://api.sms-gate.app/3rdparty/v1/webhooks';
const encryptionKey = () => (env as unknown as Record<string, string>).SETTINGS_ENCRYPTION_KEY;
const context = (owner: string, purpose: string) => JSON.stringify([owner, purpose]);

export function normalizePhone(value: string) {
  const digits = value.replace(/[\s()-]/g, '');
  if (!/^\+?\d{10,15}$/.test(digits)) throw new SmsError('Укажите номер в международном формате, например +77001234567.');
  return digits.startsWith('+') ? digits : `+${digits}`;
}
// Android may report a local form of the number, so the national part is what gets compared.
const nationalPart = (value: string) => value.replace(/\D/g, '').slice(-10);

const stored = z.object({
  id: z.string(), device_id: z.string(), sender: z.string().nullable(), recipient: z.string().nullable(),
  sim_number: z.number().nullable(), message: z.string(), received_at: z.number(),
});
const listed = z.object({ messages: z.array(stored) });
export type SmsMessage = { id: string; sender: string | null; recipient: string | null; line: string; sim: number | null; text: string; receivedAt: number; code: string | null; profileId: string | null };

async function callWorker<T>(baseUrl: string, token: string, path: string, schema: z.ZodType<T, z.ZodTypeDef, unknown>): Promise<T> {
  let response: Response;
  try {
    // Redirects stay unfollowed so the token cannot be forwarded to another host.
    response = await fetch(baseUrl + path, { headers: { Authorization: `Bearer ${token}`, Accept: 'application/json' }, redirect: 'manual', signal: AbortSignal.timeout(15000) });
  } catch { throw new SmsError('Приёмник СМС не отвечает. Повторите попытку.', 502); }
  if (response.status === 401 || response.status === 403) throw new SmsError('Приёмник СМС отклонил токен.', 502);
  if (!response.ok) throw new SmsError('Приёмник СМС временно недоступен. Повторите попытку.', 502);
  const parsed = schema.safeParse(await response.json().catch(() => null));
  if (!parsed.success) throw new SmsError('По этому адресу отвечает не приёмник СМС.', 502);
  return parsed.data;
}
async function savedSettings(owner: string) {
  const [saved] = await getDb().select().from(smsSettings).where(eq(smsSettings.owner, owner));
  return saved;
}
export async function readSmsSettings(owner: string) {
  const saved = await savedSettings(owner);
  return saved ? { baseUrl: saved.baseUrl, webhookUrl: `${saved.baseUrl}/webhook` } : null;
}
export async function saveSmsSettings(owner: string, input: { baseUrl: string; apiToken: string; signingKey: string }) {
  if (!encryptionKey()) throw new SmsError('Хранилище ключей не настроено на сервере.', 503);
  const baseUrl = normalizeMailUrl(input.baseUrl);
  await callWorker(baseUrl, input.apiToken, '/api/messages?limit=1', listed);
  const values = {
    baseUrl, updatedAt: new Date().toISOString(),
    encryptedToken: await encryptSecret(input.apiToken, encryptionKey(), context(owner, 'sms-token')),
    encryptedSigningKey: await encryptSecret(input.signingKey, encryptionKey(), context(owner, 'sms-signing')),
  };
  await getDb().insert(smsSettings).values({ owner, ...values }).onConflictDoUpdate({ target: smsSettings.owner, set: values });
  return readSmsSettings(owner);
}
export async function revealSigningKey(owner: string) {
  const saved = await savedSettings(owner);
  if (!saved) throw new SmsError('Приём СМС не подключён.');
  try { return await decryptSecret(saved.encryptedSigningKey, encryptionKey(), context(owner, 'sms-signing')); }
  catch { throw new SmsError('Не удалось прочитать ключ подписи.', 500); }
}
/** Credentials from the phone app are used once to register the webhook and are never stored. */
export async function registerWebhook(owner: string, username: string, password: string) {
  const saved = await savedSettings(owner);
  if (!saved) throw new SmsError('Приём СМС не подключён.');
  let response: Response;
  try {
    response = await fetch(GATEWAY_WEBHOOKS, {
      method: 'POST', redirect: 'manual', signal: AbortSignal.timeout(20000),
      headers: { Authorization: `Basic ${btoa(`${username}:${password}`)}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ url: `${saved.baseUrl}/webhook`, event: 'sms:received' }),
    });
  } catch { throw new SmsError('Сервис SMS Gateway не отвечает. Повторите попытку.', 502); }
  if (response.status === 401 || response.status === 403) throw new SmsError('Неверный логин или пароль из приложения.');
  if (!response.ok) throw new SmsError(`SMS Gateway не принял настройку (ошибка ${response.status}).`, 502);
  return { ok: true };
}
async function writeProfile(owner: string, profileId: string, values: { phone?: string | null; smsLine?: string | null }, conflict: string) {
  try {
    const changed = await getDb().update(profiles).set(values).where(and(eq(profiles.id, profileId), eq(profiles.owner, owner))).returning({ id: profiles.id });
    if (!changed.length) throw new SmsError('Профиль не найден.', 404);
  } catch (error) {
    if (error instanceof SmsError) throw error;
    const text = `${error instanceof Error ? error.message : ''} ${error instanceof Error && error.cause instanceof Error ? error.cause.message : ''}`;
    if (text.includes('UNIQUE')) throw new SmsError(conflict, 409);
    throw new SmsError('Не удалось сохранить. Повторите попытку.', 500);
  }
}
export async function saveProfilePhone(owner: string, profileId: string, value: string) {
  const phone = value.trim() ? normalizePhone(value) : null;
  await writeProfile(owner, profileId, { phone }, 'Этот номер уже указан в другом профиле.');
  return phone;
}
export async function bindSmsLine(owner: string, profileId: string, line: string) {
  if (!/^[\w-]{1,128}:\d*$/.test(line)) throw new SmsError('Неизвестная SIM-карта.');
  await writeProfile(owner, profileId, { smsLine: line }, 'Эта SIM-карта уже привязана к другому профилю.');
  return line;
}
export async function listSms(owner: string): Promise<SmsMessage[]> {
  const saved = await savedSettings(owner);
  if (!saved) return [];
  let token: string;
  try { token = await decryptSecret(saved.encryptedToken, encryptionKey(), context(owner, 'sms-token')); }
  catch { throw new SmsError('Не удалось прочитать токен приёмника.', 500); }
  const owned = await getDb().select({ id: profiles.id, phone: profiles.phone, smsLine: profiles.smsLine }).from(profiles).where(eq(profiles.owner, owner));
  const { messages } = await callWorker(saved.baseUrl, token, '/api/messages?limit=100', listed);
  return messages.map(sms => {
    const line = `${sms.device_id}:${sms.sim_number ?? ''}`;
    // An explicit binding wins: it is the owner's own decision for this SIM.
    const profile = owned.find(item => item.smsLine === line) || (sms.recipient ? owned.find(item => item.phone && nationalPart(item.phone) === nationalPart(sms.recipient!)) : undefined);
    return { id: sms.id, sender: sms.sender, recipient: sms.recipient, line, sim: sms.sim_number, text: sms.message, receivedAt: sms.received_at, code: extractCode(null, sms.message), profileId: profile?.id || null };
  });
}
