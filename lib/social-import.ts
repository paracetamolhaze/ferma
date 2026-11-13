import { and, eq } from 'drizzle-orm';
import { z } from 'zod';
import { getDb } from '@/db';
import { profiles, channels } from '@/db/schema';
import { createZernioClient } from './zernio';
import { NETWORKS } from './domain';

const remoteProfile = z.object({ _id: z.string().min(1), name: z.string(), externalId: z.string().optional().nullable() });
const remoteAccount = z.object({
  _id: z.string().min(1), platform: z.string(), username: z.string().optional().nullable(), displayName: z.string().optional().nullable(),
  isActive: z.boolean().optional(), profileId: z.union([z.string(), z.object({ _id: z.string() })]).optional().nullable(),
});
export type ImportResult = {
  status: 'ready' | 'chooseProfile' | 'chooseAccounts';
  message?: string;
  profiles?: { id: string; name: string }[];
  accounts?: { id: string; platform: string; username: string; active: boolean }[];
  imported?: number;
};
export async function importSocialAccounts(owner: string, profileId: string, selection: { remoteProfileId?: string; accountIds?: string[] } = {}): Promise<ImportResult> {
  const db = getDb();
  const [profile] = await db.select().from(profiles).where(and(eq(profiles.id, profileId), eq(profiles.owner, owner)));
  if (!profile) throw new Error('Профиль не найден.');
  const zernio = await createZernioClient(owner, profileId);
  const listed = z.object({ profiles: z.array(remoteProfile) }).parse(await zernio('/profiles'));
  let remoteId = profile.zernioId;
  if (remoteId && selection.remoteProfileId && selection.remoteProfileId !== remoteId) throw new Error('Этот профиль уже связан с другим профилем Zernio.');
  if (!remoteId) {
    if (selection.remoteProfileId) remoteId = selection.remoteProfileId;
    else if (listed.profiles.length === 1) remoteId = listed.profiles[0]._id;
    else remoteId = listed.profiles.find(item => item.externalId === profileId)?._id || null;
  }
  if (!remoteId) {
    if (!listed.profiles.length) return { status: 'ready', imported: 0, message: 'Создайте профиль и подключите соцсети в Zernio, затем нажмите «Обновить».' };
    return { status: 'chooseProfile', profiles: listed.profiles.map(item => ({ id: item._id, name: item.name })) };
  }
  if (!listed.profiles.some(item => item._id === remoteId)) throw new Error('Ключ не имеет доступа к связанному профилю Zernio.');
  const [assigned] = await db.select({ id: profiles.id }).from(profiles).where(and(eq(profiles.owner, owner), eq(profiles.zernioId, remoteId)));
  if (assigned && assigned.id !== profileId) throw new Error('Этот профиль Zernio уже используется другим профилем FERMA.');
  const response = z.object({ accounts: z.array(remoteAccount) }).parse(await zernio(`/accounts?profileId=${encodeURIComponent(remoteId)}`));
  const supported = new Set(NETWORKS.map(item => item.id));
  const accounts = response.accounts.filter(account => {
    const accountProfile = typeof account.profileId === 'string' ? account.profileId : account.profileId?._id;
    return supported.has(account.platform) && (!accountProfile || accountProfile === remoteId);
  });
  const savedSelection = profile.accountSelection ? z.array(z.string()).parse(JSON.parse(profile.accountSelection)) : undefined;
  let selectedIds = selection.accountIds ?? savedSelection;
  if (!selection.accountIds && savedSelection?.some(id => !accounts.some(account => account._id === id))) selectedIds = undefined;
  const chosen = selectedIds ? accounts.filter(account => selectedIds.includes(account._id)) : accounts;
  const needsChoice = chosen.length > 2 || new Set(chosen.map(account => account.platform)).size !== chosen.length || (selectedIds && (new Set(selectedIds).size !== selectedIds.length || chosen.length !== selectedIds.length));
  if (needsChoice) {
    // An unresolved choice must not leave outdated accounts usable for new posts.
    await db.update(channels).set({ state: 'disconnected' }).where(eq(channels.profileId, profileId));
    return { status: 'chooseAccounts', profiles: [{ id: remoteId, name: listed.profiles.find(item => item._id === remoteId)!.name }], accounts: accounts.map(account => ({ id: account._id, platform: account.platform, username: account.username || account.displayName || account.platform, active: account.isActive !== false })) };
  }
  const previous = await db.select().from(channels).where(eq(channels.profileId, profileId));
  const values = chosen.map((account, slot) => ({
    id: previous.find(item => item.accountId === account._id)?.id || crypto.randomUUID(), profileId, slot, platform: account.platform,
    accountId: account._id, username: account.username || account.displayName || account.platform, state: account.isActive === false ? 'inactive' : 'connected', createdAt: new Date().toISOString(),
  }));
  // D1 batch is atomic: slot swaps and removals cannot leave a half-imported list.
  const bind = db.update(profiles).set({ zernioId: remoteId, accountSelection: selectedIds ? JSON.stringify(selectedIds) : null }).where(and(eq(profiles.id, profileId), eq(profiles.owner, owner)));
  const clear = db.delete(channels).where(eq(channels.profileId, profileId));
  if (values.length) await db.batch([bind, clear, db.insert(channels).values(values)]);
  else await db.batch([bind, clear]);
  return { status: 'ready', imported: values.length, message: values.length ? 'Соцсети обновлены из Zernio.' : 'В Zernio пока нет подключённых поддерживаемых соцсетей.' };
}
