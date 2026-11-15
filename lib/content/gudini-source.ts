/**
 * GudiniSourceAdapter: finds new finished materials in Gudini and imports them without anyone moving files.
 * Works the same against a local Gudini (http://host.docker.internal:8610) and a remote one behind HTTPS.
 * The cursor is stored after every page, so a restart continues where it stopped; a material is imported once
 * (unique source + external id) and its files are kept byte for byte under their SHA-256.
 */
import { env } from 'cloudflare:workers';
import { and, asc, desc, eq, inArray, lt, ne, or, isNull, sql } from 'drizzle-orm';
import { getDb } from '@/db';
import { contentSettings, contentSources, contentVariants, publications, sourceAssets, sourceItems } from '@/db/schema';
import { exportChanges, exportItem, exportPage, storyText, type ExportItem } from './contract';
import { openSecret, sealSecret, sha256Hex } from './secrets';
import { idfOf, relate, simhash } from './text-quality';

export class SourceError extends Error {
  constructor(message: string, readonly status = 400, readonly retryable = false) { super(message); }
}
const now = () => new Date().toISOString();
const PAGE = 25;
const PAGES_PER_SYNC = 4;
const IMAGE_LIMIT = 25 * 1024 * 1024;
const VIDEO_LIMIT = 400 * 1024 * 1024;
const MAX_ASSET_ATTEMPTS = 5;
const SYNC_EVERY_MS = 5 * 60_000;
const backoff = (failures: number) => Math.min(30 * 60_000, 60_000 * 2 ** Math.max(0, failures - 1));
const VIDEO_ROLES = ['video', 'video_slide'];

export type RenderedSlide = { index: number; contentType: string; width: number; height: number; size: number; data: string };
export type RenderAnswer = { ok: true; slides: RenderedSlide[]; palette: string | null } | { ok: false; problems: string[] };
export type Transport = {
  page(cursor: string, limit: number): Promise<{ items: unknown[]; cursor: string; more: boolean }>;
  changes(cursor: string, waitSeconds: number): Promise<boolean>;
  asset(url: string): Promise<Response>;
  health(): Promise<void>;
  /** A version drawn by Gudini's own templates; problems come back instead of pictures when texts do not fit. */
  /** handle: the account's name on the cards; null leaves Gudini's own. */
  render(body: { itemId: string; content: unknown; palette: number; handle: string | null }): Promise<RenderAnswer>;
};

/** HTTP transport of gudini.export/v1. Every call carries the bearer token; nothing else is sent to Gudini. */
export function gudiniTransport(baseUrl: string, token: string, request: typeof fetch = fetch): Transport {
  const base = baseUrl.replace(/\/+$/, '');
  const call = async (path: string, timeoutMs: number) => {
    let response: Response | null = null;
    // Reading is safe to repeat: one quick second try covers a connection the server closed a moment earlier.
    for (let attempt = 0; attempt < 2 && !response; attempt++) {
      try { response = await request(`${base}${path}`, { headers: { Authorization: `Bearer ${token}` }, signal: AbortSignal.timeout(timeoutMs), redirect: 'manual' }); }
      catch { if (attempt) throw new SourceError('Gudini не отвечает. Проверим ещё раз позже.', 503, true); await new Promise(resolve => setTimeout(resolve, 500)); }
    }
    if (!response) throw new SourceError('Gudini не отвечает. Проверим ещё раз позже.', 503, true);
    if (response.status === 401 || response.status === 403) throw new SourceError('Gudini не принял токен выгрузки. Проверьте токен в «Источниках».', 401);
    if (response.status === 429 || response.status >= 500) throw new SourceError(`Gudini временно недоступен (ошибка ${response.status}).`, 503, true);
    if (!response.ok) throw new SourceError(`Gudini ответил ошибкой ${response.status}.`, 502);
    return response;
  };
  const json = async (path: string, timeoutMs = 30_000) => {
    const response = await call(path, timeoutMs);
    try { return await response.json(); } catch { throw new SourceError('Gudini прислал не JSON.', 502, true); }
  };
  return {
    async page(cursor, limit) {
      const parsed = exportPage.safeParse(await json(`/v1/items?limit=${limit}${cursor ? `&cursor=${encodeURIComponent(cursor)}` : ''}`));
      if (!parsed.success) throw new SourceError('Ответ Gudini не совпадает с контрактом gudini.export/v1.', 502);
      return parsed.data;
    },
    async changes(cursor, waitSeconds) {
      const parsed = exportChanges.safeParse(await json(`/v1/changes?wait=${waitSeconds}${cursor ? `&cursor=${encodeURIComponent(cursor)}` : ''}`, (waitSeconds + 15) * 1000));
      if (!parsed.success) throw new SourceError('Ответ Gudini не совпадает с контрактом gudini.export/v1.', 502);
      return parsed.data.changed;
    },
    asset: url => call(url, 180_000),
    async render(body) {
      let response: Response;
      try { response = await request(`${base}/v1/render`, { method: 'POST', headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' }, body: JSON.stringify(body), signal: AbortSignal.timeout(300_000), redirect: 'manual' }); }
      catch { throw new SourceError('Gudini не ответил на рендер. Повторим позже.', 503, true); }
      const data = await response.json().catch(() => null) as { slides?: RenderedSlide[]; problems?: string[]; palette?: string; error?: string } | null;
      if (response.status === 422 && Array.isArray(data?.problems)) return { ok: false, problems: data!.problems.map(String).slice(0, 30) };
      if (response.status === 401 || response.status === 403) throw new SourceError('Gudini не принял токен выгрузки.', 401);
      if (!response.ok || !Array.isArray(data?.slides)) throw new SourceError(`Gudini не нарисовал карточки: ${data?.error || response.status}.`, response.status >= 500 ? 503 : 502, response.status >= 500);
      return { ok: true, slides: data!.slides, palette: data!.palette ?? null };
    },
    async health() {
      let response: Response;
      try { response = await request(`${base}/v1/health`, { signal: AbortSignal.timeout(10_000), redirect: 'manual' }); }
      catch { throw new SourceError('По этому адресу Gudini не отвечает.', 400); }
      const data = await response.json().catch(() => null) as { contract?: string } | null;
      if (!response.ok || data?.contract !== 'gudini.export/v1') throw new SourceError('По этому адресу нет выгрузки Gudini (gudini.export/v1).', 400);
    },
  };
}

type Source = typeof contentSources.$inferSelect;
export async function readSource(owner: string) {
  const [source] = await getDb().select().from(contentSources).where(and(eq(contentSources.owner, owner), eq(contentSources.kind, 'gudini')));
  return source || null;
}
/** The transport of the owner's Gudini, for drawing versions. */
export async function sourceTransport(owner: string, request?: typeof fetch) {
  const source = await readSource(owner);
  if (!source || !source.enabled) throw new SourceError('Gudini не подключён или остановлен.', 409);
  return transportFor(owner, source, request);
}
async function transportFor(owner: string, source: Source, request?: typeof fetch) {
  let token: string;
  try { token = await openSecret(owner, `source:${source.id}`, source.encryptedToken); }
  catch { throw new SourceError('Токен Gudini не читается. Сохраните его заново.', 409); }
  return gudiniTransport(source.baseUrl, token, request);
}
/** The owner's pipeline settings as stored, or the defaults while nothing was saved. */
export const settingsOf = (owner: string, row: typeof contentSettings.$inferSelect | undefined) =>
  row || { owner, variantsPerItem: 5, autopublish: 0, dailyWriterCalls: 60, fetchVideo: 0, publicBaseUrl: null as string | null, updatedAt: now(), qualityThreshold: 80, maxAgeHours: 48, retentionDays: 30, reviewEnabled: 1 };
export async function readSettings(owner: string) {
  const [row] = await getDb().select().from(contentSettings).where(eq(contentSettings.owner, owner));
  return settingsOf(owner, row);
}

/** Connects Gudini: the address must answer as gudini.export/v1 and accept the token before anything is saved. */
export async function saveGudiniSource(owner: string, input: { baseUrl: string; token?: string | null; enabled?: boolean }, request: typeof fetch = fetch) {
  let url: URL;
  try { url = new URL(input.baseUrl.trim()); } catch { throw new SourceError('Укажите адрес полностью, например http://host.docker.internal:8610.'); }
  if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password) throw new SourceError('Адрес должен начинаться с http:// или https://, без логина в нём.');
  const baseUrl = url.toString().replace(/\/+$/, '');
  const existing = await readSource(owner);
  const token = input.token?.trim() || (existing ? await openSecret(owner, `source:${existing.id}`, existing.encryptedToken).catch(() => '') : '');
  if (!token) throw new SourceError('Добавьте токен выгрузки Gudini.');
  const transport = gudiniTransport(baseUrl, token, request);
  await transport.health();
  await transport.page('', 1);
  const id = existing?.id || crypto.randomUUID();
  const encryptedToken = await sealSecret(owner, `source:${id}`, token);
  const values = { baseUrl, encryptedToken, enabled: input.enabled === false ? 0 : 1, status: 'idle', lastError: null, failures: 0, nextSyncAt: null, syncRequested: 1, updatedAt: now() };
  if (existing) await getDb().update(contentSources).set(values).where(eq(contentSources.id, id));
  else await getDb().insert(contentSources).values({ id, owner, kind: 'gudini', name: 'Gudini', createdAt: now(), ...values });
  return { ok: true };
}
export async function setSourceEnabled(owner: string, enabled: boolean) {
  const changed = await getDb().update(contentSources).set({ enabled: enabled ? 1 : 0, syncRequested: enabled ? 1 : 0, updatedAt: now() }).where(and(eq(contentSources.owner, owner), eq(contentSources.kind, 'gudini'))).returning({ id: contentSources.id });
  if (!changed.length) throw new SourceError('Gudini ещё не подключён.', 404);
  return { enabled };
}
export async function requestSync(owner: string) {
  await getDb().update(contentSources).set({ syncRequested: 1 }).where(eq(contentSources.owner, owner));
  return { ok: true };
}

/** Which files FERMA keeps now. Videos wait for stage 2 unless the owner switched their download on. */
const wanted = (role: string, fetchVideo: boolean) => !VIDEO_ROLES.includes(role) || fetchVideo;

/** One material from the feed: new, changed, a repeat, or a near copy of another material. */
export async function upsertItem(owner: string, source: Source, raw: unknown, fetchVideo = false) {
  const parsed = exportItem.safeParse(raw);
  if (!parsed.success) return { result: 'invalid' as const, error: parsed.error.issues.slice(0, 3).map(issue => `${issue.path.join('.')}: ${issue.message}`).join('; ') };
  const item = parsed.data;
  const db = getDb();
  const [existing] = await db.select().from(sourceItems).where(and(eq(sourceItems.sourceId, source.id), eq(sourceItems.externalId, item.id)));
  if (existing?.revision === item.revision) return { result: 'same' as const, id: existing.id };
  // The cards take part: two carousels with one title (memes of one series) are different materials.
  const body = `${storyText(item)}\n${item.cards.map(card => `${card.title} ${card.body}`).join('\n')}`;
  const hash = simhash(`${item.title}\n${body}`);
  // Meaning, not only wording: a copy or a retelling is not imported as a new material; another version of the
  // same story is linked to it, so that one account does not get both.
  const recent = await db.select({ id: sourceItems.id, title: sourceItems.title, payload: sourceItems.payload }).from(sourceItems).where(and(eq(sourceItems.owner, owner), ne(sourceItems.externalId, item.id), isNull(sourceItems.duplicateOf))).orderBy(desc(sourceItems.importedAt)).limit(300);
  const others = recent.map(row => { const other = JSON.parse(row.payload) as ExportItem; return { id: row.id, title: other.title, text: `${storyText(other)}\n${other.cards.map(card => `${card.title} ${card.body}`).join('\n')}` }; });
  const idf = idfOf([`${item.title} ${body}`, ...others.map(other => `${other.title} ${other.text}`)]);
  const relations = others.map(other => ({ id: other.id, ...relate({ title: item.title, text: body }, other, idf) }));
  const twin = relations.find(relation => relation.kind === 'identical' || relation.kind === 'paraphrase');
  const sibling = relations.find(relation => relation.kind === 'same_story');
  const id = existing?.id || crypto.randomUUID();
  const fields = {
    kind: item.kind, revision: item.revision, title: item.title.slice(0, 500), category: item.category, topic: item.topic, language: item.language,
    // A material the owner hid stays hidden when Gudini changes it.
    payload: JSON.stringify(item), simhash: hash, duplicateOf: twin?.id || null, relatedTo: sibling?.id || null, status: existing?.status === 'ignored' ? 'ignored' : twin ? 'duplicate' : 'importing',
    assetsTotal: item.assets.filter(asset => wanted(asset.role, fetchVideo)).length, assetsStored: 0, attempts: 0, nextAttemptAt: null, error: null,
    sourceCreatedAt: item.createdAt, sourceReadyAt: item.readyAt, updatedAt: now(),
  };
  const assetRows = twin ? [] : item.assets.map(asset => ({
    id: crypto.randomUUID(), owner, itemId: id, revision: item.revision, assetId: asset.id, role: asset.role, card: asset.card, contentType: asset.contentType, size: asset.size,
    status: wanted(asset.role, fetchVideo) ? 'pending' : 'deferred', createdAt: now(), updatedAt: now(),
  }));
  const writes = [];
  if (existing) {
    writes.push(db.update(sourceItems).set(fields).where(eq(sourceItems.id, id)));
    // Versions made from the previous text are out of date; what is not published yet is withdrawn.
    writes.push(db.update(contentVariants).set({ status: 'outdated', updatedAt: now() }).where(and(eq(contentVariants.itemId, id), ne(contentVariants.revision, item.revision), inArray(contentVariants.status, ['planned', 'writing', 'reviewing', 'written', 'rendering', 'review', 'ready', 'rejected', 'failed']))));
    // errorKind «revised»: distribution plans the same account again with a version of the new text.
    writes.push(db.update(publications).set({ status: 'cancelled', error: 'Материал изменился в Gudini: будет новая версия.', errorKind: 'revised', updatedAt: now() }).where(and(eq(publications.itemId, id), inArray(publications.status, ['draft', 'awaiting_approval', 'scheduled']))));
  } else {
    writes.push(db.insert(sourceItems).values({ id, owner, sourceId: source.id, externalId: item.id, importedAt: now(), ...fields }).onConflictDoNothing());
  }
  // D1 takes at most 100 bound values per statement: 7 rows of 12 columns stay under it.
  for (let index = 0; index < assetRows.length; index += 7) writes.push(db.insert(sourceAssets).values(assetRows.slice(index, index + 7)).onConflictDoNothing());
  await db.batch(writes as unknown as Parameters<typeof db.batch>[0]);
  // Settled from the stored rows: a text that came back to an earlier revision (an edit undone) has its files already.
  if (!twin) await settleItem(id);
  return { result: twin ? 'duplicate' as const : existing ? 'updated' as const : 'new' as const, id };
}

/** One pass over the feed. Pages are stored one by one, the cursor right after its page. */
export async function syncSource(owner: string, { force = false, nowMs = Date.now(), request }: { force?: boolean; nowMs?: number; request?: typeof fetch } = {}) {
  const source = await readSource(owner);
  if (!source || !source.enabled) return { skipped: 'off' };
  if (!force && !source.syncRequested && source.nextSyncAt && Date.parse(source.nextSyncAt) > nowMs) return { skipped: 'later' };
  const db = getDb();
  const settings = await readSettings(owner);
  await db.update(contentSources).set({ status: 'syncing', syncRequested: 0, lastSyncAt: new Date(nowMs).toISOString() }).where(eq(contentSources.id, source.id));
  const counts = { new: 0, updated: 0, same: 0, duplicate: 0, invalid: 0 };
  const problems: string[] = [];
  let cursor = source.cursor || '';
  try {
    const transport = await transportFor(owner, source, request);
    for (let pageNumber = 0; pageNumber < PAGES_PER_SYNC; pageNumber++) {
      const page = await transport.page(cursor, PAGE);
      for (const raw of page.items) {
        const outcome = await upsertItem(owner, source, raw, Boolean(settings.fetchVideo));
        counts[outcome.result]++;
        if (outcome.result === 'invalid') problems.push(outcome.error);
      }
      cursor = page.cursor || cursor;
      await db.update(contentSources).set({ cursor, updatedAt: now() }).where(eq(contentSources.id, source.id));
      if (!page.more) break;
    }
    const more = await transport.page(cursor, 1).then(page => page.items.length > 0).catch(() => false);
    await db.update(contentSources).set({
      status: 'ok', failures: 0, lastSuccessAt: now(), lastError: problems.length ? `Пропущено материалов не по контракту: ${problems.length}. ${problems[0]}` : null,
      nextSyncAt: new Date(nowMs + (more ? 0 : SYNC_EVERY_MS)).toISOString(), syncRequested: more ? 1 : 0,
    }).where(eq(contentSources.id, source.id));
    return { ...counts, more };
  } catch (error) {
    const failures = source.failures + 1;
    const message = error instanceof Error ? error.message : 'Ошибка синхронизации.';
    const wait = error instanceof SourceError && error.status === 401 ? 30 * 60_000 : backoff(failures);
    await db.update(contentSources).set({ status: 'error', failures, lastError: message, nextSyncAt: new Date(nowMs + wait).toISOString() }).where(eq(contentSources.id, source.id));
    return { ...counts, error: message, retryInMs: wait };
  }
}

/** Long poll: true as soon as Gudini has something after our cursor. Used instead of a webhook. */
export async function watchSource(owner: string, waitSeconds = 25, request?: typeof fetch, nowMs = Date.now()) {
  const source = await readSource(owner);
  if (!source || !source.enabled) return { changed: false, off: true };
  // During a pause after errors the long poll stays silent: retries keep their growing intervals.
  if (source.status === 'error' && source.nextSyncAt && Date.parse(source.nextSyncAt) > nowMs) return { changed: false, waiting: true, retryAt: source.nextSyncAt };
  try {
    const changed = await (await transportFor(owner, source, request)).changes(source.cursor || '', waitSeconds);
    if (changed) await requestSync(owner);
    return { changed };
  } catch (error) { return { changed: false, error: error instanceof Error ? error.message : 'нет связи' }; }
}

const storageKey = (owner: string, sha: string) => `${owner}/src/${sha}`;
/** Downloads waiting files of imported materials, a few per pass; a material is ready when all its files are in. */
export async function fetchAssets(owner: string, { limit = 8, nowMs = Date.now(), request }: { limit?: number; nowMs?: number; request?: typeof fetch } = {}) {
  const source = await readSource(owner);
  if (!source || !source.enabled) return { fetched: 0 };
  const db = getDb();
  const pending = await db.select({ asset: sourceAssets, payload: sourceItems.payload, itemRevision: sourceItems.revision }).from(sourceAssets).innerJoin(sourceItems, eq(sourceItems.id, sourceAssets.itemId))
    .where(and(eq(sourceAssets.owner, owner), eq(sourceAssets.status, 'pending'), or(isNull(sourceItems.nextAttemptAt), lt(sourceItems.nextAttemptAt, new Date(nowMs).toISOString()))))
    .orderBy(asc(sourceAssets.createdAt)).limit(limit);
  if (!pending.length) return { fetched: 0 };
  const transport = await transportFor(owner, source, request);
  let fetched = 0;
  const touched = new Set<string>();
  for (const { asset, payload, itemRevision } of pending) {
    touched.add(asset.itemId);
    if (asset.revision !== itemRevision) { await db.update(sourceAssets).set({ status: 'skipped', error: 'старая версия материала', updatedAt: now() }).where(eq(sourceAssets.id, asset.id)); continue; }
    const described = (JSON.parse(payload) as ExportItem).assets.find(entry => entry.id === asset.assetId);
    try {
      if (!described) throw new SourceError('файла больше нет в материале', 410);
      const limitBytes = VIDEO_ROLES.includes(asset.role) ? VIDEO_LIMIT : IMAGE_LIMIT;
      if (asset.size > limitBytes) throw new SourceError(`файл больше ${Math.round(limitBytes / 1048576)} МБ`, 413);
      const response = await transport.asset(described.url);
      const body = await response.arrayBuffer();
      if (body.byteLength !== asset.size) throw new SourceError('размер файла изменился во время загрузки', 409, true);
      const sha = await sha256Hex(body);
      const key = storageKey(owner, sha);
      if (!(await env.BUCKET!.head(key))) await env.BUCKET!.put(key, body, { httpMetadata: { contentType: asset.contentType }, customMetadata: { item: asset.itemId, asset: asset.assetId } });
      await db.update(sourceAssets).set({ status: 'stored', sha256: sha, storageKey: key, error: null, updatedAt: now() }).where(eq(sourceAssets.id, asset.id));
      fetched++;
    } catch (error) {
      const message = error instanceof Error ? error.message : 'ошибка загрузки';
      const retryable = !(error instanceof SourceError) || error.retryable;
      const attempts = asset.attempts + 1;
      const final = !retryable || attempts >= MAX_ASSET_ATTEMPTS;
      await db.update(sourceAssets).set({ status: final ? 'failed' : 'pending', attempts, error: message.slice(0, 300), updatedAt: now() }).where(eq(sourceAssets.id, asset.id));
      if (!final) await db.update(sourceItems).set({ nextAttemptAt: new Date(nowMs + backoff(attempts)).toISOString() }).where(eq(sourceItems.id, asset.itemId));
    }
  }
  for (const itemId of touched) await settleItem(itemId);
  return { fetched };
}
/** A material whose files are all in becomes ready; one whose files failed is marked with the reason. */
async function settleItem(itemId: string) {
  const db = getDb();
  const [item] = await db.select({ revision: sourceItems.revision, status: sourceItems.status }).from(sourceItems).where(eq(sourceItems.id, itemId));
  if (!item || item.status !== 'importing') return;
  const rows = await db.select({ status: sourceAssets.status, error: sourceAssets.error, assetId: sourceAssets.assetId }).from(sourceAssets).where(and(eq(sourceAssets.itemId, itemId), eq(sourceAssets.revision, item.revision)));
  const stored = rows.filter(row => row.status === 'stored').length;
  const failed = rows.filter(row => row.status === 'failed');
  if (rows.some(row => row.status === 'pending')) { await db.update(sourceItems).set({ assetsStored: stored }).where(eq(sourceItems.id, itemId)); return; }
  await db.update(sourceItems).set({ assetsStored: stored, status: failed.length ? 'failed' : 'ready', error: failed.length ? `Не загрузились файлы: ${failed.map(row => `${row.assetId} (${row.error})`).slice(0, 3).join(', ')}` : null, updatedAt: new Date().toISOString() }).where(eq(sourceItems.id, itemId));
}
/** «Повторить»: failed files of a material go back to the queue. */
export async function retryItem(owner: string, itemId: string) {
  const db = getDb();
  const [item] = await db.select().from(sourceItems).where(and(eq(sourceItems.id, itemId), eq(sourceItems.owner, owner)));
  if (!item) throw new SourceError('Материал не найден.', 404);
  await db.batch([
    db.update(sourceAssets).set({ status: 'pending', attempts: 0, error: null, updatedAt: now() }).where(and(eq(sourceAssets.itemId, itemId), eq(sourceAssets.revision, item.revision), eq(sourceAssets.status, 'failed'))),
    db.update(sourceItems).set({ status: 'importing', error: null, nextAttemptAt: null, updatedAt: now() }).where(eq(sourceItems.id, itemId)),
  ]);
  return { ok: true };
}
/**
 * The owner can hide a material from distribution, or bring it back. Hidden, what was waiting to go out is
 * withdrawn (and planned again once it is back). Brought back, it is settled again from its files: a repeat stays
 * a repeat, missing files stay a failure, files of a newer Gudini text are fetched first.
 */
export async function setItemIgnored(owner: string, itemId: string, ignored: boolean) {
  const db = getDb();
  const changed = await db.update(sourceItems).set({ status: ignored ? 'ignored' : sql<string>`case when ${sourceItems.duplicateOf} is not null then 'duplicate' else 'importing' end`, updatedAt: now() })
    .where(and(eq(sourceItems.id, itemId), eq(sourceItems.owner, owner), inArray(sourceItems.status, ignored ? ['ready', 'failed', 'duplicate'] : ['ignored']))).returning({ id: sourceItems.id });
  if (!changed.length) throw new SourceError('Этот материал сейчас нельзя изменить.', 409);
  if (ignored) await db.update(publications).set({ status: 'cancelled', error: 'Материал скрыт владельцем.', errorKind: 'hidden', updatedAt: now() }).where(and(eq(publications.itemId, itemId), inArray(publications.status, ['draft', 'awaiting_approval', 'scheduled'])));
  else await settleItem(itemId);
  return { ok: true };
}

/** The «Источники» screen: connection, sync state, numbers and the latest materials. */
export async function sourceOverview(owner: string) {
  const db = getDb();
  const source = await readSource(owner);
  const counts = await db.select({ status: sourceItems.status, kind: sourceItems.kind, count: sql<number>`count(*)` }).from(sourceItems).where(eq(sourceItems.owner, owner)).groupBy(sourceItems.status, sourceItems.kind);
  const assets = await db.select({ status: sourceAssets.status, count: sql<number>`count(*)`, bytes: sql<number>`coalesce(sum(${sourceAssets.size}), 0)` }).from(sourceAssets).where(eq(sourceAssets.owner, owner)).groupBy(sourceAssets.status);
  const latest = await db.select({ id: sourceItems.id, externalId: sourceItems.externalId, kind: sourceItems.kind, title: sourceItems.title, category: sourceItems.category, status: sourceItems.status, error: sourceItems.error, assetsTotal: sourceItems.assetsTotal, assetsStored: sourceItems.assetsStored, sourceReadyAt: sourceItems.sourceReadyAt, importedAt: sourceItems.importedAt, duplicateOf: sourceItems.duplicateOf, relatedTo: sourceItems.relatedTo, categories: sourceItems.categories, urgent: sourceItems.urgent })
    .from(sourceItems).where(eq(sourceItems.owner, owner)).orderBy(desc(sourceItems.sourceReadyAt)).limit(60);
  return {
    source: source ? { baseUrl: source.baseUrl, enabled: Boolean(source.enabled), status: source.status, lastSyncAt: source.lastSyncAt, lastSuccessAt: source.lastSuccessAt, lastError: source.lastError, failures: source.failures, nextSyncAt: source.nextSyncAt, hasCursor: Boolean(source.cursor) } : null,
    counts, assets, latest: latest.map(row => ({ ...row, categories: JSON.parse(row.categories) as string[], urgent: Boolean(row.urgent) })),
  };
}

/** Pipeline settings from the interface. Automatic publishing is switched on only by the owner. */
export async function saveSettings(owner: string, input: { variantsPerItem?: number; dailyWriterCalls?: number; autopublish?: boolean; fetchVideo?: boolean; publicBaseUrl?: string | null; qualityThreshold?: number; maxAgeHours?: number; retentionDays?: number; reviewEnabled?: boolean }) {
  const current = await readSettings(owner);
  let publicBaseUrl = current.publicBaseUrl;
  if (input.publicBaseUrl !== undefined) {
    if (!input.publicBaseUrl) publicBaseUrl = null;
    else {
      let url: URL;
      try { url = new URL(input.publicBaseUrl.trim()); } catch { throw new SourceError('Публичный адрес должен быть полным, например https://ваш-домен/ferma.'); }
      if (url.protocol !== 'https:') throw new SourceError('Соцсети забирают картинки только по https://.');
      publicBaseUrl = url.toString().replace(/\/+$/, '');
    }
  }
  const values = {
    variantsPerItem: Math.max(1, Math.min(8, Math.round(input.variantsPerItem ?? current.variantsPerItem))),
    dailyWriterCalls: Math.max(1, Math.min(500, Math.round(input.dailyWriterCalls ?? current.dailyWriterCalls))),
    autopublish: input.autopublish === undefined ? current.autopublish : input.autopublish ? 1 : 0,
    fetchVideo: input.fetchVideo === undefined ? current.fetchVideo : input.fetchVideo ? 1 : 0,
    qualityThreshold: Math.max(50, Math.min(100, Math.round(input.qualityThreshold ?? current.qualityThreshold))),
    maxAgeHours: Math.max(1, Math.min(24 * 30, Math.round(input.maxAgeHours ?? current.maxAgeHours))),
    retentionDays: Math.max(1, Math.min(365, Math.round(input.retentionDays ?? current.retentionDays))),
    reviewEnabled: input.reviewEnabled === undefined ? current.reviewEnabled : input.reviewEnabled ? 1 : 0,
    publicBaseUrl, updatedAt: now(),
  };
  await getDb().insert(contentSettings).values({ owner, ...values }).onConflictDoUpdate({ target: contentSettings.owner, set: values });
  return values;
}
