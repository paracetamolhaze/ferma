/**
 * Media retention. Only FERMA's own drawn cards (`<owner>/variants/…`) are ever removed; Gudini's originals
 * (`<owner>/src/…`) are never touched. A version's cards go when nobody can use them any more:
 *  - the version was replaced, rejected or failed, and that was longer ago than the retention period;
 *  - the material itself is older than the retention period and none of its posts is still waiting to go out.
 * Such a version becomes «archived»: its texts, rating and published links stay for the history.
 */
import { and, eq, inArray, lt, sql } from 'drizzle-orm';
import { env } from 'cloudflare:workers';
import { getDb } from '@/db';
import { contentVariants, publicationEvents, publications, sourceItems, variantAssets } from '@/db/schema';
import { readSettings } from './gudini-source';

const WAITING = ['draft', 'awaiting_approval', 'scheduled', 'preparing', 'processing', 'publishing', 'uncertain'];
const now = () => new Date().toISOString();

export async function cleanupMedia(owner: string, { nowMs = Date.now(), limit = 100 }: { nowMs?: number; limit?: number } = {}) {
  const db = getDb();
  const { retentionDays } = await readSettings(owner);
  const before = new Date(nowMs - retentionDays * 86_400_000).toISOString();
  const dropped = await db.select({ id: contentVariants.id }).from(contentVariants)
    .where(and(eq(contentVariants.owner, owner), inArray(contentVariants.status, ['outdated', 'rejected', 'failed']), lt(contentVariants.updatedAt, before), sql`${contentVariants.assetsCount} > 0`)).limit(limit);
  const old = await db.select({ id: contentVariants.id }).from(contentVariants).innerJoin(sourceItems, eq(sourceItems.id, contentVariants.itemId))
    .where(and(eq(contentVariants.owner, owner), sql`${contentVariants.assetsCount} > 0`, lt(sourceItems.sourceReadyAt, before), sql`${contentVariants.status} <> 'archived'`,
      sql`not exists (select 1 from ${publications} where ${publications.variantId} = ${contentVariants.id} and ${publications.status} in (${sql.join(WAITING.map(status => sql`${status}`), sql`, `)}))`)).limit(limit);
  let files = 0, bytes = 0;
  for (const { id } of [...dropped, ...old]) {
    const assets = await db.select().from(variantAssets).where(eq(variantAssets.variantId, id));
    for (const asset of assets) {
      // Defence in depth: only keys under the owner's own drawn cards.
      if (!asset.storageKey.startsWith(`${owner}/variants/`)) continue;
      await env.BUCKET!.delete(asset.storageKey);
      files++; bytes += asset.size;
    }
    await db.delete(variantAssets).where(eq(variantAssets.variantId, id));
    await db.update(contentVariants).set({ assetsCount: 0, ...(old.some(entry => entry.id === id) ? { status: 'archived' } : {}), updatedAt: now() }).where(eq(contentVariants.id, id));
  }
  // The step-by-step log of old publications is not needed after half a year.
  const events = await db.delete(publicationEvents).where(and(eq(publicationEvents.owner, owner), lt(publicationEvents.at, new Date(nowMs - 180 * 86_400_000).toISOString()))).returning({ id: publicationEvents.id });
  return { versions: dropped.length + old.length, files, bytes, events: events.length, retentionDays };
}
