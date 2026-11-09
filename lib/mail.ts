import { env } from 'cloudflare:workers';
import { and, eq } from 'drizzle-orm';
import { z } from 'zod';
import { getDb } from '@/db';
import { mailSettings, profiles } from '@/db/schema';
import { extractCode } from './mail-codes';
import { decryptSecret, encryptSecret } from './secret-crypto';

export class MailError extends Error {
  constructor(message: string, readonly status = 400) { super(message); }
}
const encryptionKey = () => (env as unknown as Record<string, string>).SETTINGS_ENCRYPTION_KEY;
// The MailClaw token reaches every mailbox of the domain, so it is bound to its owner and never returned.
const tokenContext = (owner: string) => JSON.stringify([owner, 'mailclaw']);

export function normalizeMailUrl(value: string) {
  let url: URL;
  try { url = new URL(value.trim()); } catch { throw new MailError('Укажите адрес сервиса полностью, например https://mailclaw.example.workers.dev.'); }
  if (url.protocol !== 'https:' || url.username || url.password || url.search || url.hash) throw new MailError('Адрес сервиса должен начинаться с https:// и не содержать логин или параметры.');
  return url.origin + url.pathname.replace(/\/+$/, '');
}
export function normalizeMailDomain(value: string) {
  const domain = value.trim().toLowerCase().replace(/^@/, '');
  if (domain.length > 253 || !/^(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}$/.test(domain)) throw new MailError('Укажите домен почты, например mail.example.com.');
  return domain;
}
export function normalizeMailLocal(value: string) {
  const local = value.trim().toLowerCase();
  if (local.length > 64 || local.includes('..') || !/^[a-z0-9](?:[a-z0-9._-]*[a-z0-9])?$/.test(local)) throw new MailError('В имени адреса допустимы латинские буквы, цифры, точка, дефис и подчёркивание. Первый и последний символ: буква или цифра.');
  return local;
}

const summary = z.object({
  id: z.string().min(1), from_address: z.string(), to_address: z.string(), subject: z.string().nullable(),
  received_at: z.number(), attachment_count: z.coerce.number().default(0),
});
const envelope = <T extends z.ZodTypeAny>(data: T) => z.object({ success: z.literal(true), data });
const listResponse = envelope(z.object({ emails: z.array(summary), total: z.number() }));
const message = summary.extend({ html_content: z.string().nullable(), text_content: z.string().nullable() });
const messageResponse = envelope(message);
const exportResponse = envelope(z.object({ emails: z.array(message), total: z.number() }));
export type MailSummary = z.infer<typeof summary> & { code: string | null };
export type MailMessage = z.infer<typeof message>;
export type RecentMail = MailSummary & { profileId: string };
// Bodies stay on the server: a list carries only the code found in them.
const withCode = (mail: MailMessage): MailSummary => ({
  id: mail.id, from_address: mail.from_address, to_address: mail.to_address, subject: mail.subject, received_at: mail.received_at,
  attachment_count: mail.attachment_count, code: extractCode(mail.subject, mail.text_content),
});

async function callMailClaw<T>(baseUrl: string, token: string, path: string, schema: z.ZodType<T, z.ZodTypeDef, unknown>): Promise<T> {
  let response: Response;
  try {
    // Redirects stay unfollowed so the bearer token cannot be forwarded to another host.
    response = await fetch(baseUrl + path, { headers: { Authorization: `Bearer ${token}`, Accept: 'application/json' }, redirect: 'manual', signal: AbortSignal.timeout(15000) });
  } catch { throw new MailError('Почтовый сервис не отвечает. Проверьте адрес и повторите попытку.', 502); }
  if (response.status === 401 || response.status === 403) throw new MailError('Почтовый сервис отклонил токен. Проверьте его в настройках.', 502);
  if (response.status === 404) throw new MailError('Не найдено в почтовом сервисе.', 404);
  if (!response.ok) throw new MailError('Почтовый сервис временно недоступен. Повторите попытку.', 502);
  const parsed = schema.safeParse(await response.json().catch(() => null));
  if (!parsed.success) throw new MailError('По этому адресу отвечает не MailClaw. Проверьте адрес сервиса.', 502);
  return parsed.data;
}
async function savedSettings(owner: string) {
  const [saved] = await getDb().select().from(mailSettings).where(eq(mailSettings.owner, owner));
  return saved;
}
export async function readMailSettings(owner: string) {
  const saved = await savedSettings(owner);
  return saved ? { baseUrl: saved.baseUrl, domain: saved.domain } : null;
}
export async function saveMailSettings(owner: string, input: { baseUrl: string; domain: string; apiToken?: string }) {
  if (!encryptionKey()) throw new MailError('Хранилище ключей не настроено на сервере.', 503);
  const baseUrl = normalizeMailUrl(input.baseUrl), domain = normalizeMailDomain(input.domain);
  const saved = await savedSettings(owner);
  let token = input.apiToken?.trim();
  if (!token && saved) {
    try { token = await decryptSecret(saved.encryptedToken, encryptionKey(), tokenContext(owner)); }
    catch { throw new MailError('Не удалось прочитать сохранённый токен. Введите его заново.'); }
  }
  if (!token) throw new MailError('Вставьте API-токен MailClaw.');
  // Only a pair of address and token that actually works gets saved.
  try { await callMailClaw(baseUrl, token, '/api/emails?limit=1', listResponse); }
  catch (error) {
    if (error instanceof MailError && error.status === 404) throw new MailError('По этому адресу отвечает не MailClaw. Проверьте адрес сервиса.', 502);
    throw error;
  }
  const values = { baseUrl, domain, encryptedToken: await encryptSecret(token, encryptionKey(), tokenContext(owner)), updatedAt: new Date().toISOString() };
  await getDb().insert(mailSettings).values({ owner, ...values }).onConflictDoUpdate({ target: mailSettings.owner, set: values });
  return { baseUrl, domain };
}
export async function saveProfileAddress(owner: string, profileId: string, value: string) {
  const db = getDb();
  const local = value.trim() ? normalizeMailLocal(value) : null;
  if (local && !await savedSettings(owner)) throw new MailError('Сначала подключите почтовый сервис в настройках.');
  try {
    const changed = await db.update(profiles).set({ emailLocal: local }).where(and(eq(profiles.id, profileId), eq(profiles.owner, owner))).returning({ id: profiles.id });
    if (!changed.length) throw new MailError('Профиль не найден.', 404);
  } catch (error) {
    if (error instanceof MailError) throw error;
    const text = `${error instanceof Error ? error.message : ''} ${error instanceof Error && error.cause instanceof Error ? error.cause.message : ''}`;
    if (text.includes('UNIQUE')) throw new MailError('Этот адрес уже занят другим профилем.', 409);
    throw new MailError('Не удалось сохранить адрес. Повторите попытку.', 500);
  }
  return local;
}
async function mailbox(owner: string, profileId: string) {
  const [profile] = await getDb().select({ emailLocal: profiles.emailLocal }).from(profiles).where(and(eq(profiles.id, profileId), eq(profiles.owner, owner)));
  if (!profile) throw new MailError('Профиль не найден.', 404);
  if (!profile.emailLocal) throw new MailError('У профиля ещё нет адреса почты.');
  const saved = await savedSettings(owner);
  if (!saved) throw new MailError('Почтовый сервис не подключён.');
  let token: string;
  try { token = await decryptSecret(saved.encryptedToken, encryptionKey(), tokenContext(owner)); }
  catch { throw new MailError('Не удалось прочитать токен почты. Сохраните его заново в настройках.', 500); }
  return { address: `${profile.emailLocal}@${saved.domain}`, baseUrl: saved.baseUrl, token };
}
export async function listProfileMail(owner: string, profileId: string) {
  const { address, baseUrl, token } = await mailbox(owner, profileId);
  const { data } = await callMailClaw(baseUrl, token, `/api/emails/export?limit=30&to=${encodeURIComponent(address)}`, exportResponse);
  return { address, total: data.total, emails: data.emails.map(withCode) };
}
export async function listRecentMail(owner: string): Promise<RecentMail[]> {
  const saved = await savedSettings(owner);
  if (!saved) return [];
  const owned = await getDb().select({ id: profiles.id, emailLocal: profiles.emailLocal }).from(profiles).where(eq(profiles.owner, owner));
  const byAddress = new Map(owned.filter(item => item.emailLocal).map(item => [`${item.emailLocal}@${saved.domain}`, item.id]));
  if (!byAddress.size) return [];
  let token: string;
  try { token = await decryptSecret(saved.encryptedToken, encryptionKey(), tokenContext(owner)); }
  catch { throw new MailError('Не удалось прочитать токен почты. Сохраните его заново в настройках.', 500); }
  const { data } = await callMailClaw(saved.baseUrl, token, '/api/emails/export?limit=50', exportResponse);
  // One token opens the whole domain: only mail addressed to the owner's profiles passes.
  return data.emails.flatMap(email => {
    const profileId = byAddress.get(email.to_address.toLowerCase());
    return profileId ? [{ ...withCode(email), profileId }] : [];
  });
}
export async function readProfileMail(owner: string, profileId: string, id: string) {
  if (!/^[A-Za-z0-9_-]{1,128}$/.test(id)) throw new MailError('Письмо не найдено.', 404);
  const { address, baseUrl, token } = await mailbox(owner, profileId);
  const { data } = await callMailClaw(baseUrl, token, `/api/emails/${id}`, messageResponse);
  // One token opens the whole domain: a profile may read only mail addressed to it.
  if (data.to_address.toLowerCase() !== address) throw new MailError('Письмо не найдено.', 404);
  return data;
}
