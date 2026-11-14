/** Heartbeats of the content engine and the media worker, shown in the interface. */
import { and, eq } from 'drizzle-orm';
import { getDb } from '@/db';
import { engineStatus } from '@/db/schema';

export async function heartbeat(owner: string, name: string, ok: boolean, note: string | null, details: unknown = null) {
  // Cutting JSON would break it: details that do not fit are replaced by a short note.
  const text = details === null ? null : JSON.stringify(details);
  const values = { heartbeatAt: new Date().toISOString(), ok: ok ? 1 : 0, note: note?.slice(0, 500) ?? null, details: text && text.length > 16_000 ? JSON.stringify({ tooLarge: text.length }) : text };
  await getDb().insert(engineStatus).values({ id: crypto.randomUUID(), owner, name, ...values }).onConflictDoUpdate({ target: [engineStatus.owner, engineStatus.name], set: values });
}
export async function engineOverview(owner: string) {
  const rows = await getDb().select().from(engineStatus).where(eq(engineStatus.owner, owner));
  return Object.fromEntries(rows.map(row => [row.name, { heartbeatAt: row.heartbeatAt, ageSeconds: Math.round((Date.now() - Date.parse(row.heartbeatAt)) / 1000), ok: Boolean(row.ok), note: row.note, details: row.details ? JSON.parse(row.details) : null }]));
}
export async function readHeartbeat(owner: string, name: string) {
  const [row] = await getDb().select().from(engineStatus).where(and(eq(engineStatus.owner, owner), eq(engineStatus.name, name)));
  return row || null;
}
