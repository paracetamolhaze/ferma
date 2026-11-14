/**
 * Topic categories set by the owner and the sorting of Gudini's materials into them. The AI classifier (GPT bridge)
 * reads up to 20 materials at once; without it, the categories' own keywords decide. A material is «urgent» when
 * it is fresh breaking news: it goes into the priority queue.
 */
import { and, asc, desc, eq, gte, isNull, lt, or, sql } from 'drizzle-orm';
import { getDb } from '@/db';
import { sourceItems, topicCategories } from '@/db/schema';
import { storyText, type ExportItem } from './contract';
import { readSettings } from './gudini-source';
import { mentions, normalizeText } from './text-quality';

export class TopicError extends Error {
  constructor(message: string, readonly status = 400) { super(message); }
}
const now = () => new Date().toISOString();
/** The starting list; the owner renames, removes and adds categories freely. */
export const DEFAULT_CATEGORIES: { name: string; keywords: string[] }[] = [
  { name: 'Криптовалюты', keywords: ['криптовалюта', 'биткоин', 'bitcoin', 'btc', 'эфир', 'ethereum', 'binance', 'usdt', 'tether', 'блокчейн', 'токен', 'мемкоин', 'solana'] },
  { name: 'Финансы', keywords: ['банк', 'ставка', 'рубль', 'доллар', 'рынок', 'акции', 'инвестиции', 'нефть', 'экономика', 'кредит', 'вклад'] },
  { name: 'Технологии', keywords: ['технологии', 'iphone', 'apple', 'google', 'microsoft', 'nvidia', 'смартфон', 'гаджет', 'игра', 'playstation', 'steam', 'tesla'] },
  { name: 'Искусственный интеллект', keywords: ['нейросеть', 'chatgpt', 'openai', 'claude', 'anthropic', 'gpt', 'gemini', 'искусственный интеллект'] },
  { name: 'Политика', keywords: ['выборы', 'президент', 'правительство', 'санкции', 'закон', 'депутат', 'министр', 'госдума'] },
  { name: 'Общие новости', keywords: [] },
];
const parse = <T>(value: string | null | undefined, fallback: T): T => { try { return value ? JSON.parse(value) as T : fallback; } catch { return fallback; } };

export async function listCategories(owner: string) {
  const db = getDb();
  let rows = await db.select().from(topicCategories).where(eq(topicCategories.owner, owner)).orderBy(asc(topicCategories.sort), asc(topicCategories.createdAt));
  if (!rows.length) {
    await db.insert(topicCategories).values(DEFAULT_CATEGORIES.map((category, index) => ({ id: crypto.randomUUID(), owner, name: category.name, keywords: JSON.stringify(category.keywords), sort: index, createdAt: now(), updatedAt: now() }))).onConflictDoNothing();
    rows = await db.select().from(topicCategories).where(eq(topicCategories.owner, owner)).orderBy(asc(topicCategories.sort), asc(topicCategories.createdAt));
  }
  return rows.map(row => ({ id: row.id, name: row.name, keywords: parse<string[]>(row.keywords, []), sort: row.sort }));
}
export async function saveCategory(owner: string, input: { id?: string; name: string; keywords: string[] }) {
  const name = input.name.trim().replace(/\s+/g, ' ').slice(0, 40);
  if (!name) throw new TopicError('Назовите тему.');
  const keywords = [...new Set(input.keywords.map(word => normalizeText(word).trim()).filter(word => word.length >= 2))].slice(0, 40);
  const db = getDb();
  const [taken] = await db.select({ id: topicCategories.id }).from(topicCategories).where(and(eq(topicCategories.owner, owner), eq(topicCategories.name, name)));
  if (taken && taken.id !== input.id) throw new TopicError('Такая тема уже есть.');
  if (input.id) {
    const changed = await db.update(topicCategories).set({ name, keywords: JSON.stringify(keywords), updatedAt: now() }).where(and(eq(topicCategories.id, input.id), eq(topicCategories.owner, owner))).returning({ id: topicCategories.id });
    if (!changed.length) throw new TopicError('Тема не найдена.', 404);
    return { id: input.id };
  }
  const [last] = await db.select({ sort: sql<number>`coalesce(max(${topicCategories.sort}), -1)` }).from(topicCategories).where(eq(topicCategories.owner, owner));
  const id = crypto.randomUUID();
  await db.insert(topicCategories).values({ id, owner, name, keywords: JSON.stringify(keywords), sort: (last?.sort ?? -1) + 1, createdAt: now(), updatedAt: now() });
  return { id };
}
export async function deleteCategory(owner: string, id: string) {
  const changed = await getDb().delete(topicCategories).where(and(eq(topicCategories.id, id), eq(topicCategories.owner, owner))).returning({ id: topicCategories.id });
  if (!changed.length) throw new TopicError('Тема не найдена.', 404);
  return { ok: true };
}

const material = (payload: string) => JSON.parse(payload) as ExportItem;
const describe = (item: ExportItem) => `${item.title}. ${(item.summary || storyText(item)).replace(/\s+/g, ' ').slice(0, 400)}`;
/** Keyword sorting: the categories whose words the material mentions, in any form; the one without words when none. */
export function keywordCategories(item: Pick<ExportItem, 'title' | 'text' | 'summary' | 'caption' | 'cards'>, categories: { name: string; keywords: string[] }[]) {
  const text = [item.title, item.summary, item.caption, item.text, ...item.cards.map(card => card.title)].filter(Boolean).join(' ');
  const scored = categories.map(category => ({ name: category.name, hits: category.keywords.filter(keyword => mentions(text, keyword)).length })).filter(entry => entry.hits > 0).sort((a, b) => b.hits - a.hits);
  const general = categories.find(category => !category.keywords.length)?.name;
  return scored.length ? scored.slice(0, 2).map(entry => entry.name) : general ? [general] : [];
}
/** Breaking news that should not wait: Gudini's urgent style or a crypto news lane, ready less than 6 hours ago. */
export function heuristicUrgent(item: Pick<ExportItem, 'style' | 'meta' | 'readyAt'>, nowMs = Date.now()) {
  const fresh = nowMs - Date.parse(item.readyAt) < 6 * 3600_000;
  return fresh && (item.style === 'urgent' || item.meta.lane === 'crypto-news');
}

/**
 * Materials waiting to be sorted into categories, as one task for the AI classifier. Materials already older than
 * the freshness limit will never be published as news: their own words sort them, without a call to the bridge.
 */
export async function classificationJob(owner: string, { limit = 20, nowMs = Date.now() }: { limit?: number; nowMs?: number } = {}) {
  const db = getDb();
  const fresh = new Date(nowMs - (await readSettings(owner)).maxAgeHours * 3600_000).toISOString();
  const waiting = and(eq(sourceItems.owner, owner), eq(sourceItems.status, 'ready'), isNull(sourceItems.classifiedAt));
  const old = await db.select({ id: sourceItems.id }).from(sourceItems).where(and(waiting, or(isNull(sourceItems.sourceReadyAt), lt(sourceItems.sourceReadyAt, fresh)))).limit(200);
  if (old.length) await acceptClassification(owner, null, old.map(row => row.id), nowMs);
  const rows = await db.select({ id: sourceItems.id, payload: sourceItems.payload }).from(sourceItems).where(and(waiting, gte(sourceItems.sourceReadyAt, fresh))).orderBy(desc(sourceItems.sourceReadyAt)).limit(limit);
  if (!rows.length) return null;
  const categories = await listCategories(owner);
  const system = 'Ты раскладываешь новости по темам. Отвечай строго одним JSON-объектом без пояснений.';
  const user = `Темы: ${categories.map(category => `«${category.name}»${category.keywords.length ? ` (например: ${category.keywords.slice(0, 8).join(', ')})` : ''}`).join('; ')}.
Для каждого материала выбери 1-2 темы из списка (только из списка; если ни одна не подходит - «${categories.find(category => !category.keywords.length)?.name || categories[0]?.name}») и отметь urgent: true только для срочной новости, которую важно выложить в ближайшие часы.
Материалы:
${rows.map(row => `- id ${row.id}: ${describe(material(row.payload))}`).join('\n')}

Верни JSON: {"items": [{"id": "...", "categories": ["..."], "urgent": false}]}`;
  return { ids: rows.map(row => row.id), system, user };
}
/** The classifier's answer (or keyword sorting when it is missing) stored on the materials. */
export async function acceptClassification(owner: string, answer: { id: string; categories?: unknown; urgent?: unknown }[] | null, ids: string[], nowMs = Date.now()) {
  const db = getDb();
  const categories = await listCategories(owner);
  const names = new Set(categories.map(category => category.name));
  let byAi = 0, byKeywords = 0;
  for (const id of ids) {
    const [row] = await db.select({ payload: sourceItems.payload }).from(sourceItems).where(and(eq(sourceItems.id, id), eq(sourceItems.owner, owner)));
    if (!row) continue;
    const item = material(row.payload);
    const given = answer?.find(entry => entry.id === id);
    const chosen = Array.isArray(given?.categories) ? (given!.categories as unknown[]).map(String).filter(name => names.has(name)).slice(0, 2) : [];
    const result = chosen.length ? chosen : keywordCategories(item, categories);
    if (chosen.length) byAi++; else byKeywords++;
    const urgent = (given && typeof given.urgent === 'boolean' ? given.urgent : false) || heuristicUrgent(item, nowMs);
    await db.update(sourceItems).set({ categories: JSON.stringify(result), urgent: urgent ? 1 : 0, classifiedAt: now() }).where(eq(sourceItems.id, id));
  }
  return { byAi, byKeywords };
}
