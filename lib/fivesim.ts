import { env } from 'cloudflare:workers';
import { and, desc, eq } from 'drizzle-orm';
import { z } from 'zod';
import { getDb } from '@/db';
import { activations, fivesimSettings, profiles } from '@/db/schema';
import { extractCode } from './mail-codes';
import { decryptSecret, encryptSecret } from './secret-crypto';

export class FivesimError extends Error {
  constructor(message: string, readonly status = 400) { super(message); }
}
const BASE = 'https://5sim.net/v1';
export const PRODUCTS = ['instagram', 'google', 'tiktok'];
// A number below this delivery rate wastes the user's time more often than it saves money.
const MIN_RATE = 60;
const encryptionKey = () => (env as unknown as Record<string, string>).SETTINGS_ENCRYPTION_KEY;
const context = (owner: string) => JSON.stringify([owner, '5sim']);

async function call<T>(path: string, schema: z.ZodType<T, z.ZodTypeDef, unknown>, token?: string): Promise<T> {
  let response: Response;
  try {
    response = await fetch(BASE + path, { headers: { Accept: 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}) }, redirect: 'manual', signal: AbortSignal.timeout(20000) });
  } catch { throw new FivesimError('5SIM не отвечает. Повторите попытку.', 502); }
  const text = await response.text();
  if (response.status === 401) throw new FivesimError('5SIM не принял ключ API. Проверьте его в настройках.', 502);
  if (!response.ok) {
    const known: Record<string, string> = { 'no free phones': 'Сейчас нет свободных номеров. Попробуйте позже.', 'not enough user balance': 'На балансе 5SIM не хватает денег. Пополните его.', 'order has sms': 'По номеру уже пришла СМС, отменить нельзя.', 'order expired': 'Время номера уже вышло.' };
    const match = Object.entries(known).find(([key]) => text.toLowerCase().includes(key));
    throw new FivesimError(match ? match[1] : `5SIM вернул ошибку ${response.status}.`, 502);
  }
  // 5SIM answers some failures with 200 and a plain-text reason.
  let data: unknown;
  try { data = JSON.parse(text); } catch {
    if (/no free phones/i.test(text)) throw new FivesimError('Сейчас нет свободных номеров. Попробуйте позже.', 502);
    if (/not enough user balance/i.test(text)) throw new FivesimError('На балансе 5SIM не хватает денег. Пополните его.', 502);
    throw new FivesimError('5SIM вернул непонятный ответ.', 502);
  }
  const parsed = schema.safeParse(data);
  if (!parsed.success) throw new FivesimError('5SIM вернул данные в неожиданном формате.', 502);
  return parsed.data;
}
const profileResponse = z.object({ balance: z.number() });
const order = z.object({
  id: z.number(), phone: z.string(), country: z.string(), price: z.number(), status: z.string(), expires: z.string(),
  sms: z.array(z.object({ text: z.string().nullish(), code: z.union([z.string(), z.number()]).nullish() }).passthrough()).nullish(),
});

async function token(owner: string) {
  const [saved] = await getDb().select().from(fivesimSettings).where(eq(fivesimSettings.owner, owner));
  if (!saved) throw new FivesimError('5SIM не подключён. Вставьте ключ API в настройках.');
  try { return await decryptSecret(saved.encryptedToken, encryptionKey(), context(owner)); }
  catch { throw new FivesimError('Не удалось прочитать ключ 5SIM. Сохраните его заново.', 500); }
}
export async function hasFivesim(owner: string) {
  const [saved] = await getDb().select({ owner: fivesimSettings.owner }).from(fivesimSettings).where(eq(fivesimSettings.owner, owner));
  return Boolean(saved);
}
export async function saveFivesimKey(owner: string, apiKey: string) {
  if (!encryptionKey()) throw new FivesimError('Хранилище ключей не настроено на сервере.', 503);
  const { balance } = await call('/user/profile', profileResponse, apiKey);
  const values = { encryptedToken: await encryptSecret(apiKey, encryptionKey(), context(owner)), updatedAt: new Date().toISOString() };
  await getDb().insert(fivesimSettings).values({ owner, ...values }).onConflictDoUpdate({ target: fivesimSettings.owner, set: values });
  return { balance };
}
export async function readBalance(owner: string) {
  return { balance: (await call('/user/profile', profileResponse, await token(owner))).balance };
}
const prices = z.record(z.record(z.record(z.object({ cost: z.number(), count: z.number(), rate: z.number().optional() }))));
export type Offer = { country: string; operator: string; cost: number; rate: number };
/** The cheapest number that still delivers codes reliably, from 5SIM's public price list. */
export async function bestOffer(product: string): Promise<Offer | null> {
  if (!PRODUCTS.includes(product)) throw new FivesimError('Неизвестная соцсеть.');
  const table = await call(`/guest/prices?product=${product}`, prices);
  const offers: Offer[] = [];
  for (const countries of Object.values(table)) for (const [country, operators] of Object.entries(countries)) for (const [operator, item] of Object.entries(operators)) {
    if (item.count > 0 && (item.rate ?? 0) >= MIN_RATE) offers.push({ country, operator, cost: item.cost, rate: item.rate! });
  }
  offers.sort((a, b) => a.cost - b.cost || b.rate - a.rate);
  return offers[0] || null;
}
export async function offers() {
  return Object.fromEntries(await Promise.all(PRODUCTS.map(async product => [product, await bestOffer(product)])));
}
function codeOf(sms: z.infer<typeof order>['sms']) {
  const last = (sms || []).at(-1);
  if (!last) return null;
  const given = last.code === undefined || last.code === null ? '' : String(last.code).trim();
  return given || extractCode(null, last.text || null) || last.text?.match(/\d{4,8}/)?.[0] || null;
}
async function ownedProfile(owner: string, profileId: string) {
  const [profile] = await getDb().select({ id: profiles.id }).from(profiles).where(and(eq(profiles.id, profileId), eq(profiles.owner, owner)));
  if (!profile) throw new FivesimError('Профиль не найден.', 404);
}
export async function buyNumber(owner: string, profileId: string, product: string) {
  await ownedProfile(owner, profileId);
  const offer = await bestOffer(product);
  if (!offer) throw new FivesimError('Нет номеров с нормальной доставкой кодов. Попробуйте позже.');
  const bought = await call(`/user/buy/activation/${encodeURIComponent(offer.country)}/${encodeURIComponent(offer.operator)}/${product}`, order, await token(owner));
  const row = { id: String(bought.id), owner, profileId, product, phone: bought.phone, country: bought.country, price: String(bought.price), status: bought.status, code: codeOf(bought.sms), expiresAt: bought.expires, createdAt: new Date().toISOString() };
  await getDb().insert(activations).values(row);
  return row;
}
async function ownedOrder(owner: string, id: string) {
  const [row] = await getDb().select().from(activations).where(and(eq(activations.id, id), eq(activations.owner, owner)));
  if (!row) throw new FivesimError('Заказ не найден.', 404);
  return row;
}
const ACTIONS = { check: 'check', finish: 'finish', cancel: 'cancel' } as const;
export async function updateOrder(owner: string, id: string, action: keyof typeof ACTIONS) {
  const row = await ownedOrder(owner, id);
  const result = await call(`/user/${ACTIONS[action]}/${encodeURIComponent(row.id)}`, order, await token(owner));
  const values = { status: result.status, code: codeOf(result.sms) || row.code };
  await getDb().update(activations).set(values).where(eq(activations.id, row.id));
  return { ...row, ...values, smsText: (result.sms || []).map(item => item.text).filter(Boolean).join(' / ') || null };
}
export async function listOrders(owner: string, profileId: string) {
  await ownedProfile(owner, profileId);
  return getDb().select().from(activations).where(and(eq(activations.owner, owner), eq(activations.profileId, profileId))).orderBy(desc(activations.createdAt)).limit(20);
}
