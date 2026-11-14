/**
 * «Состояние системы»: what runs, what it has left, what waits and what went wrong, with the real reasons.
 * Only facts FERMA has: heartbeats of its processes, its own tables, and the readings the content engine takes
 * of its container (CPU, memory, disk of the Docker machine). Nothing here is estimated.
 */
import { and, desc, eq, inArray, sql } from 'drizzle-orm';
import { getDb } from '@/db';
import { autopilotState, contentSources, contentVariants, mediaJobs, publications, socialAccounts, sourceAssets, sourceItems, variantAssets } from '@/db/schema';
import { engineOverview } from './content/engine-status';
import { readSettings } from './content/gudini-source';

const counts = (rows: { status: string; n: number }[]) => Object.fromEntries(rows.map(row => [row.status, row.n]));

export async function systemOverview(owner: string, nowMs = Date.now()) {
  const db = getDb();
  // All reads in one batch: one trip to the database instead of a dozen.
  const [engine, settings] = await Promise.all([engineOverview(owner), readSettings(owner)]);
  const [[pilot], [source], itemRows, variantRows, queueRows, jobRows, [originals], [drawn], failedPublications, failedItems, failedVersions, accounts] = await db.batch([
    db.select().from(autopilotState).where(eq(autopilotState.owner, owner)),
    db.select({ status: contentSources.status, enabled: contentSources.enabled, lastSyncAt: contentSources.lastSyncAt, lastSuccessAt: contentSources.lastSuccessAt, lastError: contentSources.lastError, failures: contentSources.failures, nextSyncAt: contentSources.nextSyncAt }).from(contentSources).where(eq(contentSources.owner, owner)),
    db.select({ status: sourceItems.status, n: sql<number>`count(*)` }).from(sourceItems).where(eq(sourceItems.owner, owner)).groupBy(sourceItems.status),
    db.select({ status: contentVariants.status, n: sql<number>`count(*)` }).from(contentVariants).where(eq(contentVariants.owner, owner)).groupBy(contentVariants.status),
    db.select({ status: publications.status, n: sql<number>`count(*)` }).from(publications).where(eq(publications.owner, owner)).groupBy(publications.status),
    db.select({ status: mediaJobs.status, n: sql<number>`count(*)` }).from(mediaJobs).where(eq(mediaJobs.owner, owner)).groupBy(mediaJobs.status),
    db.select({ files: sql<number>`count(*)`, bytes: sql<number>`coalesce(sum(${sourceAssets.size}), 0)` }).from(sourceAssets).where(and(eq(sourceAssets.owner, owner), eq(sourceAssets.status, 'stored'))),
    db.select({ files: sql<number>`count(*)`, bytes: sql<number>`coalesce(sum(${variantAssets.size}), 0)` }).from(variantAssets).where(eq(variantAssets.owner, owner)),
    // Problems, newest first, each with what can be done about it.
    db.select({ id: publications.id, platform: publications.platform, error: publications.error, errorKind: publications.errorKind, at: publications.updatedAt, title: sourceItems.title, username: socialAccounts.username })
      .from(publications).leftJoin(sourceItems, eq(sourceItems.id, publications.itemId)).leftJoin(socialAccounts, eq(socialAccounts.id, publications.accountId))
      .where(and(eq(publications.owner, owner), eq(publications.status, 'failed'))).orderBy(desc(publications.updatedAt)).limit(20),
    db.select({ id: sourceItems.id, title: sourceItems.title, error: sourceItems.error, at: sourceItems.updatedAt }).from(sourceItems)
      .where(and(eq(sourceItems.owner, owner), eq(sourceItems.status, 'failed'))).orderBy(desc(sourceItems.updatedAt)).limit(20),
    db.select({ id: contentVariants.id, status: contentVariants.status, error: contentVariants.error, at: contentVariants.updatedAt, title: sourceItems.title, slot: contentVariants.slot })
      .from(contentVariants).leftJoin(sourceItems, eq(sourceItems.id, contentVariants.itemId))
      .where(and(eq(contentVariants.owner, owner), eq(contentVariants.status, 'failed'))).orderBy(desc(contentVariants.updatedAt)).limit(20),
    db.select({ id: socialAccounts.id, platform: socialAccounts.platform, username: socialAccounts.username, status: socialAccounts.status, error: socialAccounts.error, pausedUntil: socialAccounts.pausedUntil, tokenExpiresAt: socialAccounts.tokenExpiresAt })
      .from(socialAccounts).where(and(eq(socialAccounts.owner, owner), inArray(socialAccounts.status, ['connected', 'expired', 'error']))),
  ]);
  const [items, variants, queue, jobs] = [itemRows, variantRows, queueRows, jobRows].map(counts);
  return {
    at: new Date(nowMs).toISOString(),
    processes: {
      engine: engine.engine ?? null,
      media: engine.media ?? null,
      autopilot: pilot ? { heartbeatAt: pilot.heartbeatAt, ageSeconds: Math.round((nowMs - Date.parse(pilot.heartbeatAt)) / 1000), bridgeOk: Boolean(pilot.bridgeOk), note: pilot.note } : null,
    },
    source: source ? { ...source, enabled: Boolean(source.enabled) } : null,
    counts: { items, variants, publications: queue, mediaJobs: jobs },
    storage: { originals: { files: originals?.files ?? 0, bytes: originals?.bytes ?? 0 }, drawn: { files: drawn?.files ?? 0, bytes: drawn?.bytes ?? 0 }, retentionDays: settings.retentionDays },
    autopublish: Boolean(settings.autopublish),
    problems: {
      publications: failedPublications,
      items: failedItems,
      versions: failedVersions,
      accounts: accounts.map(account => ({ id: account.id, platform: account.platform, username: account.username, error: account.error, pausedUntil: account.pausedUntil, tokenExpiresAt: account.tokenExpiresAt,
        problem: account.status === 'expired' ? 'expired' as const : account.status === 'error' ? 'error' as const
          : account.pausedUntil && Date.parse(account.pausedUntil) > nowMs ? 'paused' as const
          : account.tokenExpiresAt && Date.parse(account.tokenExpiresAt) - nowMs < 7 * 86_400_000 ? 'token' as const : null })).filter(account => account.problem),
    },
  };
}
