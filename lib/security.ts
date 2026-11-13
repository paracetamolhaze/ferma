import { env } from 'cloudflare:workers';
import { and, eq } from 'drizzle-orm';
import { z } from 'zod';
import { getDb } from '@/db';
import { profiles, profileSecrets } from '@/db/schema';
import { decryptSecret, encryptSecret } from './secret-crypto';
import { normalizeTotpSecret, parseBackupCodes, totpCode } from './totp';

export class SecurityError extends Error {
  constructor(message: string, readonly status = 400) { super(message); }
}
export const SECURITY_PLATFORMS = ['instagram', 'threads', 'google', 'tiktok', 'other'];
const encryptionKey = () => (env as unknown as Record<string, string>).SETTINGS_ENCRYPTION_KEY;
// Each secret is bound to its owner, profile and platform: a row copied elsewhere does not decrypt.
const context = (owner: string, profileId: string, platform: string, kind: string) => JSON.stringify([owner, profileId, platform, kind]);
const backupList = z.array(z.object({ code: z.string(), used: z.boolean() }));
type Row = typeof profileSecrets.$inferSelect;

async function ownedProfile(owner: string, profileId: string) {
  const [profile] = await getDb().select({ id: profiles.id }).from(profiles).where(and(eq(profiles.id, profileId), eq(profiles.owner, owner)));
  if (!profile) throw new SecurityError('Профиль не найден.', 404);
}
async function rows(owner: string, profileId: string) {
  return getDb().select().from(profileSecrets).where(and(eq(profileSecrets.owner, owner), eq(profileSecrets.profileId, profileId)));
}
async function backups(owner: string, row: Row) {
  if (!row.encryptedBackup) return [];
  try { return backupList.parse(JSON.parse(await decryptSecret(row.encryptedBackup, encryptionKey(), context(owner, row.profileId, row.platform, 'backup')))); }
  catch { throw new SecurityError('Не удалось прочитать резервные коды.', 500); }
}
async function upsert(owner: string, profileId: string, platform: string, values: Partial<Pick<Row, 'encryptedTotp' | 'encryptedBackup'>>) {
  const updatedAt = new Date().toISOString();
  await getDb().insert(profileSecrets).values({ id: crypto.randomUUID(), owner, profileId, platform, updatedAt, ...values })
    .onConflictDoUpdate({ target: [profileSecrets.profileId, profileSecrets.platform], set: { ...values, updatedAt } });
}
const check = (platform: string) => { if (!SECURITY_PLATFORMS.includes(platform)) throw new SecurityError('Неизвестная соцсеть.'); };
const ready = () => { if (!encryptionKey()) throw new SecurityError('Хранилище ключей не настроено на сервере.', 503); };

/** What the profile page shows: the current codes and counts, never the stored keys or the backup codes themselves. */
export async function readSecurity(owner: string, profileId: string) {
  await ownedProfile(owner, profileId);
  return Promise.all((await rows(owner, profileId)).map(async row => {
    let totp: { code: string; remaining: number } | null = null;
    if (row.encryptedTotp) {
      try { totp = await totpCode(await decryptSecret(row.encryptedTotp, encryptionKey(), context(owner, profileId, row.platform, 'totp'))); }
      catch { throw new SecurityError('Не удалось прочитать ключ приложения.', 500); }
    }
    const list = await backups(owner, row);
    return { platform: row.platform, totp, backupTotal: list.length, backupLeft: list.filter(item => !item.used).length, updatedAt: row.updatedAt };
  }));
}
export async function saveTotp(owner: string, profileId: string, platform: string, secret: string) {
  ready(); check(platform); await ownedProfile(owner, profileId);
  let normalized: string;
  try { normalized = normalizeTotpSecret(secret); } catch (error) { throw new SecurityError(error instanceof Error ? error.message : 'Неверный ключ.'); }
  await upsert(owner, profileId, platform, { encryptedTotp: await encryptSecret(normalized, encryptionKey(), context(owner, profileId, platform, 'totp')) });
  return totpCode(normalized);
}
export async function saveBackupCodes(owner: string, profileId: string, platform: string, text: string) {
  ready(); check(platform); await ownedProfile(owner, profileId);
  const codes = parseBackupCodes(text);
  if (!codes.length) throw new SecurityError('Не нашёл резервных кодов в тексте. Вставьте их как выдала платформа.');
  const list = codes.map(code => ({ code, used: false }));
  await upsert(owner, profileId, platform, { encryptedBackup: await encryptSecret(JSON.stringify(list), encryptionKey(), context(owner, profileId, platform, 'backup')) });
  return { saved: list.length };
}
export async function revealBackupCodes(owner: string, profileId: string, platform: string) {
  check(platform); await ownedProfile(owner, profileId);
  const [row] = (await rows(owner, profileId)).filter(item => item.platform === platform);
  if (!row) throw new SecurityError('Резервных кодов нет.', 404);
  return backups(owner, row);
}
export async function markBackupCode(owner: string, profileId: string, platform: string, code: string, used: boolean) {
  check(platform); await ownedProfile(owner, profileId);
  const [row] = (await rows(owner, profileId)).filter(item => item.platform === platform);
  if (!row) throw new SecurityError('Резервных кодов нет.', 404);
  const list = await backups(owner, row);
  const item = list.find(entry => entry.code === code);
  if (!item) throw new SecurityError('Код не найден.', 404);
  item.used = used;
  await upsert(owner, profileId, platform, { encryptedBackup: await encryptSecret(JSON.stringify(list), encryptionKey(), context(owner, profileId, platform, 'backup')) });
  return list;
}
export async function removeSecurity(owner: string, profileId: string, platform: string) {
  check(platform); await ownedProfile(owner, profileId);
  await getDb().delete(profileSecrets).where(and(eq(profileSecrets.owner, owner), eq(profileSecrets.profileId, profileId), eq(profileSecrets.platform, platform)));
  return { ok: true };
}
