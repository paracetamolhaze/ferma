/**
 * ContentDistributionEngine: which material goes to which account, in which version and when.
 *   - only accounts whose topics match the material (a profile without topics takes everything);
 *   - one version per account, never the same version twice, never the same material twice to one account;
 *   - the version's format must be supported by the platform (Instagram needs pictures);
 *   - each profile keeps its own rhythm: posts per day, active hours, a minimum gap;
 *   - accounts receiving the same material are spread in time, not posted at once;
 *   - the mode decides what happens next: draft, wait for approval, or publish after the quality check.
 */
import { and, desc, eq, gte, inArray, notInArray, sql } from 'drizzle-orm';
import { getDb } from '@/db';
import { campaigns, contentVariants, profileEditorial, profiles, publications, socialAccounts, sourceItems } from '@/db/schema';
import type { ExportItem } from './contract';
import { DEFAULT_EDITORIAL, effectiveMode, fitScore, nextSlot, pickVariant, PLATFORM_FORMATS, topicScore, type Editorial, type Mode } from './rules';
import { readSettings } from './gudini-source';
import { listCategories } from './topics';
import { ensureVariants, queueRender, VariantError } from './variants';

export class DistributionError extends Error {
  constructor(message: string, readonly status = 400) { super(message); }
}
const now = () => new Date().toISOString();
export { effectiveMode, nextSlot, pickVariant, topicScore, DEFAULT_EDITORIAL } from './rules';
export type { Editorial, Mode } from './rules';

const parse = <T>(value: string | null | undefined, fallback: T): T => { try { return value ? JSON.parse(value) as T : fallback; } catch { return fallback; } };
/** Why FERMA itself withdrew a waiting publication: the material changed in Gudini, or the owner hid it. */
const WITHDRAWN = ['revised', 'hidden'];
export async function readEditorial(profileId: string): Promise<Editorial> {
  const [row] = await getDb().select().from(profileEditorial).where(eq(profileEditorial.profileId, profileId));
  if (!row) return DEFAULT_EDITORIAL;
  return { topics: parse(row.topics, []), style: row.style, formats: parse(row.formats, DEFAULT_EDITORIAL.formats), perDay: parse(row.perDay, DEFAULT_EDITORIAL.perDay), windows: parse(row.windows, DEFAULT_EDITORIAL.windows), timezoneOffsetMinutes: row.timezoneOffsetMinutes, minGapMinutes: row.minGapMinutes, mode: row.mode as Mode };
}

type Campaign = typeof campaigns.$inferSelect;
type Item = typeof sourceItems.$inferSelect;
type Account = typeof socialAccounts.$inferSelect;
export type Assignment = { itemId: string; title: string; accountId: string; profileId: string; profile: string; platform: string; username: string | null; variantId: string | null; style: string | null; format: string | null; at: string | null; status: string; reason: string | null; urgent?: boolean };

async function candidates(owner: string, campaign: Campaign) {
  const db = getDb();
  const profileIds = parse<string[]>(campaign.profileIds, []);
  const platforms = parse<string[]>(campaign.platforms, ['threads', 'instagram']);
  const accounts = await db.select().from(socialAccounts).where(and(eq(socialAccounts.owner, owner), eq(socialAccounts.status, 'connected'), inArray(socialAccounts.platform, platforms), ...(profileIds.length ? [inArray(socialAccounts.profileId, profileIds)] : [])));
  const names = new Map((await db.select({ id: profiles.id, name: profiles.name }).from(profiles).where(eq(profiles.owner, owner))).map(row => [row.id, row.name]));
  return { accounts, names };
}
/**
 * Fresh materials of a campaign, urgent ones first. Older than the age limit = no longer news: never offered as new.
 */
async function itemsFor(owner: string, campaign: Campaign, limit: number, nowMs: number, maxAgeHours: number) {
  const kinds = parse<string[]>(campaign.kinds, ['news', 'carousel']);
  // Video carousels go out as picture carousels in stage 1, so they come with the «carousel» kind.
  const expanded = kinds.includes('carousel') ? [...kinds, 'video_carousel'] : kinds;
  const since = [campaign.since || campaign.createdAt, new Date(nowMs - maxAgeHours * 3600_000).toISOString()].sort().pop()!;
  return getDb().select().from(sourceItems).where(and(eq(sourceItems.owner, owner), eq(sourceItems.status, 'ready'), inArray(sourceItems.kind, expanded), gte(sourceItems.sourceReadyAt, since)))
    .orderBy(desc(sourceItems.urgent), desc(sourceItems.sourceReadyAt)).limit(limit);
}
/**
 * Accounts that already got this story in another version during the last week. The story is the whole chain of
 * retellings (each links to the latest earlier one: C → B → A) and every material that links to one of them.
 */
async function storyTakenBy(item: Item, nowMs: number) {
  const db = getDb();
  const story = new Set<string>([item.id]);
  for (let next = item.relatedTo, hop = 0; next && !story.has(next) && hop < 10; hop++) {
    story.add(next);
    const [earlier] = await db.select({ relatedTo: sourceItems.relatedTo }).from(sourceItems).where(and(eq(sourceItems.owner, item.owner), eq(sourceItems.id, next)));
    next = earlier?.relatedTo ?? null;
  }
  for (const row of await db.select({ id: sourceItems.id }).from(sourceItems).where(and(eq(sourceItems.owner, item.owner), inArray(sourceItems.relatedTo, [...story])))) story.add(row.id);
  story.delete(item.id);
  if (!story.size) return new Set<string>();
  // Bound values stay small: a story has a handful of materials; past 90 only the first are looked at.
  const rows = await db.select({ accountId: publications.accountId }).from(publications).where(and(inArray(publications.itemId, [...story].slice(0, 90)), notInArray(publications.status, ['cancelled', 'failed']), gte(publications.scheduledFor, new Date(nowMs - 7 * 86_400_000).toISOString())));
  return new Set(rows.map(row => row.accountId));
}

/**
 * Plans one material for a campaign: picks the accounts whose topics it fits, gives each the best version the
 * editor passed and a time in its own rhythm. With `dry` nothing is written (preview). A material whose versions
 * are not written and checked yet is planned on a later pass: nothing goes out unchecked, nothing fills a gap.
 */
async function planItem(owner: string, campaign: Campaign, item: Item, accounts: Account[], names: Map<string, string>, known: Set<string>, { dry, nowMs, maxAgeHours }: { dry: boolean; nowMs: number; maxAgeHours: number }) {
  const db = getDb();
  const data = JSON.parse(item.payload) as ExportItem;
  const itemCategories = parse<string[]>(item.categories, []);
  const wanted = parse<string[]>(campaign.categories, []);
  if (wanted.length && !wanted.some(category => itemCategories.includes(category))) return [];
  const keywords = parse<string[]>(campaign.keywords, []);
  if (keywords.length && !topicScore(keywords, data)) return [];
  // One publication per material and account, whatever its status: one the owner cancelled is not made again.
  // One withdrawn because the material changed in Gudini (or was hidden and brought back) is planned again.
  const existing = await db.select({ id: publications.id, accountId: publications.accountId, scheduledFor: publications.scheduledFor, status: publications.status, errorKind: publications.errorKind }).from(publications).where(eq(publications.itemId, item.id));
  const revised = new Map(existing.filter(row => row.status === 'cancelled' && WITHDRAWN.includes(row.errorKind ?? '')).map(row => [row.accountId, row.id]));
  const already = existing.filter(row => !revised.has(row.accountId) && row.status !== 'cancelled');
  const story = await storyTakenBy(item, nowMs);
  const editorials = new Map<string, Editorial>();
  for (const account of accounts) if (!editorials.has(account.profileId)) editorials.set(account.profileId, await readEditorial(account.profileId));
  const scored = accounts.filter(account => (revised.has(account.id) || !existing.some(row => row.accountId === account.id)) && !story.has(account.id))
    .map(account => ({ account, score: fitScore(editorials.get(account.profileId)!.topics, known, itemCategories, data) }))
    .filter(entry => entry.score > 0)
    .sort((a, b) => b.score - a.score);
  const room = Math.max(0, campaign.maxAccountsPerItem - already.length);
  const chosen = scored.slice(0, room);
  if (!chosen.length) return [];
  if (!dry) await ensureVariants(owner, item.id).catch(error => { if (!(error instanceof VariantError)) throw error; });
  const variants = await db.select().from(contentVariants).where(and(eq(contentVariants.itemId, item.id), eq(contentVariants.revision, item.revision)));
  const pool = dry ? variants.map(variant => ({ ...variant })) : variants;
  const sameItem = already.map(row => Date.parse(row.scheduledFor));
  const result: Assignment[] = [];
  const urgent = Boolean(item.urgent);
  // The platform that takes the fewest formats (Instagram: carousels only) chooses its version first.
  const formatsOf = (platform: string) => PLATFORM_FORMATS[platform]?.length ?? 9;
  for (const { account } of [...chosen].sort((a, b) => formatsOf(a.account.platform) - formatsOf(b.account.platform) || b.score - a.score)) {
    const editorial = editorials.get(account.profileId)!;
    const base = { itemId: item.id, title: item.title, accountId: account.id, profileId: account.profileId, profile: names.get(account.profileId) || '', platform: account.platform, username: account.username, urgent };
    const variant = pickVariant(pool, account.platform, editorial, item.kind, { passedOnly: !dry });
    if (!variant) {
      const waiting = pool.some(entry => ['planned', 'writing', 'reviewing'].includes(entry.status)) || !pool.length;
      result.push({ ...base, variantId: null, style: null, format: null, at: null, status: 'skipped', reason: waiting ? 'версии ещё пишутся и проверяются' : 'нет проверенной версии подходящего формата' });
      continue;
    }
    const taken = (await db.select({ at: publications.scheduledFor }).from(publications).where(and(eq(publications.accountId, account.id), notInArray(publications.status, ['cancelled', 'failed'])))).map(row => Date.parse(row.at));
    // Urgent news: the account's next free moment, without spreading it after other accounts.
    const slot = nextSlot({ nowMs, editorial, platform: account.platform, taken, sameItem, spreadMinutes: urgent ? 0 : campaign.spreadMinutes, jitterMinutes: dry || urgent ? 0 : Math.random() * 10 });
    // A news item must go out while it is still news: a time after the age limit is no time.
    const freshUntil = item.sourceReadyAt ? Date.parse(item.sourceReadyAt) + maxAgeHours * 3600_000 : Infinity;
    if (!slot || slot > freshUntil) { result.push({ ...base, variantId: variant.id, style: variant.style, format: variant.format, at: null, status: 'skipped', reason: slot ? `материал станет старше ${maxAgeHours} ч раньше, чем у аккаунта найдётся свободное время` : 'нет свободного времени в ближайшие две недели' }); continue; }
    const mode = effectiveMode(campaign.mode as Mode, editorial.mode);
    const status = mode === 'draft' ? 'draft' : mode === 'manual' ? 'awaiting_approval' : 'scheduled';
    const planned = { ...base, variantId: variant.id, style: variant.style, format: variant.format, at: new Date(slot).toISOString(), status, reason: null };
    if (!dry) {
      // The publication first: the version is bound and drawn only for a publication that was really written.
      const fields = { campaignId: campaign.id, variantId: variant.id, format: variant.format, status, scheduledFor: new Date(slot).toISOString(), priority: urgent ? 1 : 0, updatedAt: now() };
      const revisedId = revised.get(account.id);
      const written = revisedId
        ? await db.update(publications).set({ ...fields, attempts: 0, nextAttemptAt: null, lockedUntil: null, containerIds: null, parentContainerId: null, containerReadyAt: null, mediaKeys: null, mediaCount: 0, text: '', error: null, errorKind: null, approvedAt: null })
          .where(and(eq(publications.id, revisedId), eq(publications.status, 'cancelled'), inArray(publications.errorKind, WITHDRAWN))).returning({ id: publications.id })
        : await db.insert(publications).values({ id: crypto.randomUUID(), owner, profileId: account.profileId, accountId: account.id, provider: account.provider, platform: account.platform, itemId: item.id, idempotencyKey: `pub:${item.id}:${account.id}`, createdAt: now(), ...fields })
          .onConflictDoNothing().returning({ id: publications.id });
      if (!written.length) continue;
      await db.update(contentVariants).set({ profileId: account.profileId, platform: account.platform, updatedAt: now() }).where(and(eq(contentVariants.id, variant.id), sql`${contentVariants.profileId} is null`));
      if (variant.status === 'written') await queueRender(owner, variant.id);
    }
    sameItem.push(slot);
    variant.profileId = account.profileId;
    result.push(planned);
  }
  return result;
}

/** One pass over active campaigns: urgent and newest ready materials first, a few per pass. */
export async function distributeTick(owner: string, { nowMs = Date.now(), perPass = 6 }: { nowMs?: number; perPass?: number } = {}) {
  const db = getDb();
  const active = await db.select().from(campaigns).where(and(eq(campaigns.owner, owner), eq(campaigns.status, 'active')));
  const settings = await readSettings(owner);
  const known = new Set((await listCategories(owner)).map(category => category.name));
  const planned: Assignment[] = [];
  for (const campaign of active) {
    const { accounts, names } = await candidates(owner, campaign);
    if (!accounts.length) continue;
    for (const item of await itemsFor(owner, campaign, 30, nowMs, settings.maxAgeHours)) {
      if (planned.length >= perPass) break;
      planned.push(...(await planItem(owner, campaign, item, accounts, names, known, { dry: false, nowMs, maxAgeHours: settings.maxAgeHours })).filter(entry => entry.status !== 'skipped'));
    }
  }
  await settleQuality(owner);
  return { planned: planned.length };
}

/**
 * Auto mode publishes only what passed the checks: a scheduled publication whose version needs a human look
 * waits for approval instead; one whose version failed is marked so.
 */
export async function settleQuality(owner: string) {
  const db = getDb();
  const rows = await db.select({ id: publications.id, status: publications.status, variantStatus: contentVariants.status, variantError: contentVariants.error })
    .from(publications).innerJoin(contentVariants, eq(contentVariants.id, publications.variantId))
    .where(and(eq(publications.owner, owner), eq(publications.status, 'scheduled'), inArray(contentVariants.status, ['review', 'rejected', 'failed'])));
  for (const row of rows) {
    const status = row.variantStatus === 'review' ? 'awaiting_approval' : 'failed';
    await db.update(publications).set({ status, error: row.variantStatus === 'review' ? `Проверка качества: ${row.variantError || 'нужен взгляд владельца'}` : `Вариант не готов: ${row.variantError || row.variantStatus}`, errorKind: status === 'failed' ? 'invalid_request' : null, updatedAt: now() }).where(and(eq(publications.id, row.id), eq(publications.status, 'scheduled')));
  }
  return { moved: rows.length };
}

/** «Предпросмотр»: what the campaign would do with recent materials, without writing anything. */
export async function previewCampaign(owner: string, campaignId: string, nowMs = Date.now()) {
  const [campaign] = await getDb().select().from(campaigns).where(and(eq(campaigns.id, campaignId), eq(campaigns.owner, owner)));
  if (!campaign) throw new DistributionError('Кампания не найдена.', 404);
  const { accounts, names } = await candidates(owner, { ...campaign, since: campaign.since || new Date(nowMs - 7 * 86_400_000).toISOString() });
  if (!accounts.length) return { assignments: [], note: 'Нет подключённых аккаунтов в выбранных профилях и соцсетях.' };
  const assignments: Assignment[] = [];
  const settings = await readSettings(owner);
  const known = new Set((await listCategories(owner)).map(category => category.name));
  for (const item of await itemsFor(owner, { ...campaign, since: campaign.since || new Date(nowMs - 7 * 86_400_000).toISOString() }, 8, nowMs, settings.maxAgeHours)) assignments.push(...await planItem(owner, campaign, item, accounts, names, known, { dry: true, nowMs, maxAgeHours: settings.maxAgeHours }));
  return { assignments, note: null };
}

// ---------------------------------------------------------------- settings

const modeSchema = (value: unknown): Mode => (['draft', 'manual', 'auto'].includes(String(value)) ? value as Mode : 'manual');
export async function saveEditorial(owner: string, profileId: string, input: Partial<Editorial> & { design?: Record<string, unknown> | null }) {
  const db = getDb();
  const [profile] = await db.select({ id: profiles.id }).from(profiles).where(and(eq(profiles.id, profileId), eq(profiles.owner, owner)));
  if (!profile) throw new DistributionError('Профиль не найден.', 404);
  const current = await readEditorial(profileId);
  const next: Editorial = { ...current, ...input, mode: modeSchema(input.mode ?? current.mode) };
  if (!next.windows.length || next.windows.some(([from, to]) => !(from >= 0 && to <= 24 && to > from))) throw new DistributionError('Часы публикаций: от 0 до 24, «до» больше «от».');
  if (Object.values(next.perDay).some(value => !Number.isInteger(value) || value < 0 || value > 20)) throw new DistributionError('Публикаций в день: от 0 до 20.');
  if (next.minGapMinutes < 15 || next.minGapMinutes > 24 * 60) throw new DistributionError('Перерыв между публикациями: от 15 минут до суток.');
  const values = {
    topics: JSON.stringify(next.topics.map(topic => topic.trim()).filter(Boolean).slice(0, 30)), style: next.style, language: 'ru', formats: JSON.stringify(next.formats), perDay: JSON.stringify(next.perDay),
    windows: JSON.stringify(next.windows), timezoneOffsetMinutes: next.timezoneOffsetMinutes, minGapMinutes: next.minGapMinutes, mode: next.mode,
    ...(input.design !== undefined ? { design: input.design ? JSON.stringify(input.design) : null } : {}), updatedAt: now(),
  };
  await db.insert(profileEditorial).values({ profileId, owner, ...values }).onConflictDoUpdate({ target: profileEditorial.profileId, set: values });
  return { ok: true };
}
export async function saveCampaign(owner: string, input: { id?: string; name: string; mode: Mode; kinds: string[]; keywords: string[]; categories?: string[]; profileIds: string[]; platforms: string[]; maxAccountsPerItem: number; spreadMinutes: number; since?: string | null }) {
  const db = getDb();
  const values = {
    name: input.name.trim().slice(0, 80) || 'Кампания', mode: modeSchema(input.mode), kinds: JSON.stringify(input.kinds.filter(kind => ['news', 'carousel'].includes(kind))),
    keywords: JSON.stringify(input.keywords.map(word => word.trim()).filter(Boolean).slice(0, 30)), categories: JSON.stringify((input.categories || []).map(name => name.trim()).filter(Boolean).slice(0, 20)), profileIds: JSON.stringify(input.profileIds), platforms: JSON.stringify(input.platforms.filter(platform => ['threads', 'instagram'].includes(platform))),
    maxAccountsPerItem: Math.max(1, Math.min(50, Math.round(input.maxAccountsPerItem))), spreadMinutes: Math.max(0, Math.min(24 * 60, Math.round(input.spreadMinutes))), since: input.since || null, updatedAt: now(),
  };
  if (input.id) {
    const changed = await db.update(campaigns).set(values).where(and(eq(campaigns.id, input.id), eq(campaigns.owner, owner))).returning({ id: campaigns.id });
    if (!changed.length) throw new DistributionError('Кампания не найдена.', 404);
    return { id: input.id };
  }
  const id = crypto.randomUUID();
  // A new campaign starts paused and takes only materials that are ready from now on, unless a date is given.
  await db.insert(campaigns).values({ id, owner, status: 'paused', createdAt: now(), ...values, since: input.since || now() });
  return { id };
}
export async function setCampaignStatus(owner: string, id: string, status: 'active' | 'paused') {
  const changed = await getDb().update(campaigns).set({ status, updatedAt: now() }).where(and(eq(campaigns.id, id), eq(campaigns.owner, owner))).returning({ id: campaigns.id });
  if (!changed.length) throw new DistributionError('Кампания не найдена.', 404);
  return { ok: true };
}
export async function campaignsOverview(owner: string) {
  const db = getDb();
  const rows = await db.select().from(campaigns).where(eq(campaigns.owner, owner)).orderBy(desc(campaigns.createdAt));
  const counts = await db.select({ campaignId: publications.campaignId, status: publications.status, count: sql<number>`count(*)` }).from(publications).where(eq(publications.owner, owner)).groupBy(publications.campaignId, publications.status);
  const editorial = await db.select().from(profileEditorial).where(eq(profileEditorial.owner, owner));
  // Gudini's own palette, as its latest redrawable carousel describes it: the colours a profile can choose from.
  const recent = await db.select({ payload: sourceItems.payload }).from(sourceItems).where(and(eq(sourceItems.owner, owner), inArray(sourceItems.kind, ['carousel', 'video_carousel']))).orderBy(desc(sourceItems.sourceReadyAt)).limit(30);
  const palettes = recent.map(row => (JSON.parse(row.payload) as ExportItem).editable?.palettes || []).find(list => list.length) || [];
  return {
    palettes, categories: await listCategories(owner),
    campaigns: rows.map(row => ({ ...row, kinds: parse(row.kinds, []), keywords: parse(row.keywords, []), categories: parse(row.categories, []), profileIds: parse(row.profileIds, []), platforms: parse(row.platforms, []), counts: counts.filter(entry => entry.campaignId === row.id) })),
    editorial: editorial.map(row => ({ ...row, topics: parse(row.topics, []), formats: parse(row.formats, []), perDay: parse(row.perDay, {}), windows: parse(row.windows, []), design: parse(row.design, null) })),
  };
}
