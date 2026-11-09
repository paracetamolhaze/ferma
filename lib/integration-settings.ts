import { env } from 'cloudflare:workers';
import { and, eq, ne, inArray, sql } from 'drizzle-orm';
import { getDb } from '@/db';
import { profileIntegrations, profiles, channels, posts } from '@/db/schema';
import { decryptSecret, encryptSecret, profileKeyContext, secretFingerprint } from './secret-crypto';

const encryptionKey = () => (env as unknown as Record<string, string>).SETTINGS_ENCRYPTION_KEY;
export function canSaveIntegrationKey() { return Boolean(encryptionKey()); }
export async function readZernioKey(owner: string, profileId: string) {
  const [saved] = await getDb().select({ encryptedKey: profileIntegrations.encryptedKey })
    .from(profileIntegrations).innerJoin(profiles, eq(profiles.id, profileIntegrations.profileId))
    .where(and(eq(profileIntegrations.profileId, profileId), eq(profileIntegrations.owner, owner), eq(profiles.owner, owner)));
  if (!saved) return '';
  try { return await decryptSecret(saved.encryptedKey, encryptionKey(), profileKeyContext(owner, profileId)); }
  catch { throw new Error('Не удалось прочитать ключ Zernio. Сохраните его заново в этом профиле.'); }
}
export async function saveZernioKey(owner: string, profileId: string, token: string, resetBinding = false) {
  if (!canSaveIntegrationKey()) throw new Error('Хранилище ключей не настроено на сервере.');
  const db = getDb();
  const [profile] = await db.select({ id: profiles.id }).from(profiles).where(and(eq(profiles.id, profileId), eq(profiles.owner, owner)));
  if (!profile) throw new Error('Профиль не найден.');
  const fingerprint = await secretFingerprint(token, encryptionKey(), owner);
  const [duplicate] = await db.select({ id: profileIntegrations.profileId }).from(profileIntegrations)
    .where(and(eq(profileIntegrations.owner, owner), eq(profileIntegrations.fingerprint, fingerprint), ne(profileIntegrations.profileId, profileId)));
  if (duplicate) throw new Error('Этот ключ уже используется в другом профиле. Добавьте отдельный ключ.');
  const encryptedKey = await encryptSecret(token, encryptionKey(), profileKeyContext(owner, profileId));
  const updatedAt = new Date().toISOString();
  const write = db.insert(profileIntegrations).values({ profileId, owner, encryptedKey, fingerprint, updatedAt })
    .onConflictDoUpdate({ target: profileIntegrations.profileId, set: { encryptedKey, fingerprint, updatedAt }, setWhere: sql`not exists (select 1 from posts where profileId = ${profileId} and status = 'sending')` }).returning({ id: profileIntegrations.profileId });
  // A key and its account binding change together. A blocked update must not clear channels.
  const saved = sql`exists (select 1 from profile_integrations where profileId = ${profileId} and encryptedKey = ${encryptedKey})`;
  const results = resetBinding ? await db.batch([
    write,
    db.update(profiles).set({ zernioId: null, accountSelection: null }).where(and(eq(profiles.id, profileId), saved)),
    db.delete(channels).where(and(eq(channels.profileId, profileId), saved)),
    db.update(posts).set({ platforms: '[]' }).where(and(eq(posts.profileId, profileId), eq(posts.status, 'draft'), saved)),
    db.update(posts).set({ status: 'external', error: 'Ключ заменён на другой кабинет. Публикация осталась в прежнем Zernio; проверьте её там.' }).where(and(eq(posts.profileId, profileId), inArray(posts.status, ['scheduled', 'processing', 'partial', 'uncertain']), saved)),
  ]) : [await write];
  if (!results[0].length) throw new Error('Публикация сейчас отправляется. Дождитесь завершения и повторите замену ключа.');
}
