/**
 * Perceptual hashes of Gudini's original pictures (computed by ferma-media-worker). Two materials with the same
 * picture and a close meaning are one story: the later one is linked to the earlier, so one account does not get
 * both. Only the hash is written; the original files are never changed.
 */
import { and, desc, eq, gte, isNotNull, isNull, like, ne } from 'drizzle-orm';
import { getDb } from '@/db';
import { sourceAssets, sourceItems } from '@/db/schema';
import { storyText, type ExportItem } from './contract';
import { hammingDistance, idfOf, relate } from './text-quality';

/** Stored original pictures without a hash yet, newest first. */
export async function unhashedAssets(owner: string, limit = 6) {
  return getDb().select({ id: sourceAssets.id, key: sourceAssets.storageKey, contentType: sourceAssets.contentType }).from(sourceAssets)
    .where(and(eq(sourceAssets.owner, owner), eq(sourceAssets.status, 'stored'), isNull(sourceAssets.dhash), isNotNull(sourceAssets.storageKey), like(sourceAssets.contentType, 'image/%')))
    .orderBy(desc(sourceAssets.createdAt)).limit(limit);
}

const textOf = (payload: string) => { const item = JSON.parse(payload) as ExportItem; return { title: item.title, text: `${storyText(item)}\n${item.cards.map(card => `${card.title} ${card.body}`).join('\n')}` }; };

/** Marks a file the media worker could not read (not a picture, too large): it gets no hash and is not sent again. */
const NO_HASH = '-';
const isHash = (value: string | null) => Boolean(value && /^[0-9a-f]{16}$/.test(value));
/**
 * Stores a picture's hash (null: the worker could not read the file); a material without a relation yet is linked
 * to a recent one with the same picture.
 */
export async function storeAssetHash(owner: string, assetId: string, dhash: string | null) {
  if (dhash === null) {
    await getDb().update(sourceAssets).set({ dhash: NO_HASH }).where(and(eq(sourceAssets.id, assetId), eq(sourceAssets.owner, owner), isNull(sourceAssets.dhash)));
    return { ok: true, related: null };
  }
  if (!isHash(dhash)) return { ok: false, related: null };
  const db = getDb();
  const [asset] = await db.update(sourceAssets).set({ dhash }).where(and(eq(sourceAssets.id, assetId), eq(sourceAssets.owner, owner))).returning({ itemId: sourceAssets.itemId });
  if (!asset) return { ok: false, related: null };
  const [item] = await db.select().from(sourceItems).where(eq(sourceItems.id, asset.itemId));
  if (!item || item.relatedTo || item.duplicateOf) return { ok: true, related: null };
  const since = new Date(Date.now() - 14 * 86_400_000).toISOString();
  const twins = (await db.select({ itemId: sourceAssets.itemId, dhash: sourceAssets.dhash }).from(sourceAssets)
    .where(and(eq(sourceAssets.owner, owner), isNotNull(sourceAssets.dhash), ne(sourceAssets.itemId, item.id), gte(sourceAssets.createdAt, since))).limit(2000))
    .filter(row => isHash(row.dhash) && hammingDistance(row.dhash!, dhash) <= 6);
  if (!twins.length) return { ok: true, related: null };
  const mine = textOf(item.payload);
  for (const itemId of [...new Set(twins.map(row => row.itemId))].slice(0, 10)) {
    const [other] = await db.select({ id: sourceItems.id, payload: sourceItems.payload, importedAt: sourceItems.importedAt }).from(sourceItems).where(eq(sourceItems.id, itemId));
    // Only an earlier material can be the story's first version.
    if (!other || other.importedAt > item.importedAt) continue;
    const theirs = textOf(other.payload);
    const relation = relate({ ...mine, dhash }, { ...theirs, dhash }, idfOf([`${mine.title} ${mine.text}`, `${theirs.title} ${theirs.text}`]));
    if (relation.kind === 'independent' || relation.kind === 'similar_title') continue;
    await db.update(sourceItems).set({ relatedTo: other.id }).where(and(eq(sourceItems.id, item.id), isNull(sourceItems.relatedTo)));
    return { ok: true, related: other.id };
  }
  return { ok: true, related: null };
}
