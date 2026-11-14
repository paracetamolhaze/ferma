/**
 * ContentVariantEngine: versions of each material, their texts, their checks and their pictures.
 *   plan    — the set of versions for a material (plan.ts: angles and layouts)
 *   write   — one writer call per material returns all its texts; every text is checked against the facts
 *   bind    — the distribution engine gives a version to one profile and platform
 *   draw    — a «gudini» version is drawn by Gudini's own templates (gudini-export /v1/render) with the version's
 *             wording, the account's colour of Gudini's palette and its handle; when a text does not fit, Gudini says
 *             which field, the writer fixes exactly it (2 rounds), then Gudini's own text is used for that field
 * Pictures are always Gudini's: its finished cards, its cover, or its templates redrawn. FERMA draws nothing itself.
 * Statuses: planned → writing → written → (bound) → rendering → ready; review = needs a human look;
 * rejected/failed = not used until edited or regenerated; outdated = the material changed in Gudini.
 */
import { env } from 'cloudflare:workers';
import { and, asc, desc, eq, inArray, lt, ne, sql } from 'drizzle-orm';
import { getDb } from '@/db';
import { contentVariants, engineStatus, mediaJobs, profileEditorial, profiles, publications, socialAccounts, sourceAssets, sourceItems, variantAssets } from '@/db/schema';
import { editableTexts, factBasis, storyText, type EditableContent, type ExportItem } from './contract';
import { readSettings, sourceTransport, SourceError } from './gudini-source';
import { coverAsset, LAYOUT_NAMES, originalCards, paletteFor, planVariants, STYLE_BRIEFS, STYLE_NAMES, visible, type Style } from './plan';
import { checkFacts, hammingDistance, scoreVariant, similarity } from './text-quality';

export class VariantError extends Error {
  constructor(message: string, readonly status = 400) { super(message); }
}
const now = () => new Date().toISOString();
/** Threads text, Instagram caption of a version with Gudini's cards, Instagram caption of a redrawn version (Gudini's rule). */
export const LIMITS = { text: 480, caption: 1800, gudiniCaption: 600 };
const MAX_WRITES = 3;
const MAX_RENDERS = 3;
const MAX_FIX_ROUNDS = 2;
const STALE_WRITING_MS = 20 * 60_000;
const RENDER_LEASE_MS = 8 * 60_000;

type Variant = typeof contentVariants.$inferSelect;
type Item = typeof sourceItems.$inferSelect;
const material = (item: Pick<Item, 'payload'>) => JSON.parse(item.payload) as ExportItem;
const parse = <T>(value: string | null | undefined, fallback: T): T => { try { return value ? JSON.parse(value) as T : fallback; } catch { return fallback; } };
async function ownedItem(owner: string, itemId: string) {
  const [item] = await getDb().select().from(sourceItems).where(and(eq(sourceItems.id, itemId), eq(sourceItems.owner, owner)));
  if (!item) throw new VariantError('Материал не найден.', 404);
  return item;
}
async function ownedVariant(owner: string, variantId: string) {
  const [variant] = await getDb().select().from(contentVariants).where(and(eq(contentVariants.id, variantId), eq(contentVariants.owner, owner)));
  if (!variant) throw new VariantError('Вариант не найден.', 404);
  return variant;
}
async function storedAssets(itemId: string, revision: string) {
  const rows = await getDb().select({ assetId: sourceAssets.assetId, storageKey: sourceAssets.storageKey }).from(sourceAssets).where(and(eq(sourceAssets.itemId, itemId), eq(sourceAssets.revision, revision), eq(sourceAssets.status, 'stored')));
  return new Map(rows.filter(row => row.storageKey).map(row => [row.assetId, row.storageKey!]));
}

/** Creates the versions of a material once per revision. Repeated calls change nothing. */
export async function ensureVariants(owner: string, itemId: string) {
  const db = getDb();
  const item = await ownedItem(owner, itemId);
  if (item.status !== 'ready') throw new VariantError('Материал ещё не готов: файлы загружаются или есть ошибка.', 409);
  const existing = await db.select({ id: contentVariants.id }).from(contentVariants).where(and(eq(contentVariants.itemId, itemId), eq(contentVariants.revision, item.revision)));
  if (existing.length) return { created: 0 };
  const settings = await readSettings(owner);
  const data = material(item);
  const planned = planVariants(data, settings.variantsPerItem);
  // Gudini's covers and investigation covers are drawn by an image model; Threads gets its «made with AI» mark for them.
  const aiPictures = data.assets.some(asset => ['cover_art', 'illustration'].includes(asset.role)) || data.kind === 'news';
  const rows = planned.map(entry => ({ id: crypto.randomUUID(), owner, itemId, revision: item.revision, slot: entry.slot, style: entry.style, format: entry.format, layout: entry.layout, aiImagery: entry.layout === 'none' ? 0 : aiPictures ? 1 : 0, status: 'planned', createdAt: now(), updatedAt: now() }));
  if (rows.length) await db.insert(contentVariants).values(rows).onConflictDoNothing();
  return { created: rows.length };
}

// ---------------------------------------------------------------- writing

const DAY = () => new Date().toISOString().slice(0, 10);
async function writerCount(owner: string) {
  const [row] = await getDb().select().from(engineStatus).where(and(eq(engineStatus.owner, owner), eq(engineStatus.name, 'writer')));
  const details = parse<{ day?: string; calls?: number }>(row?.details, {});
  return details.day === DAY() ? details.calls || 0 : 0;
}
async function countWriterCall(owner: string) {
  const calls = await writerCount(owner) + 1;
  const values = { heartbeatAt: now(), ok: 1, note: `обращений к мосту сегодня: ${calls}`, details: JSON.stringify({ day: DAY(), calls }) };
  await getDb().insert(engineStatus).values({ id: crypto.randomUUID(), owner, name: 'writer', ...values }).onConflictDoUpdate({ target: [engineStatus.owner, engineStatus.name], set: values });
}

const WRITER_RULES = `Жёсткие правила:
- Только факты из материала ниже. Нельзя добавлять числа, даты, имена, названия, цитаты и источники, которых в материале нет. Нельзя менять смысл и округлять числа иначе, чем в материале. Если чего-то нет в материале, не пиши этого.
- Каждая версия по-своему подаёт историю: другой заход, другой порядок слов, другие формулировки. Не копируй фразы материала и не повторяй одну версию в другой.
- Пиши по-русски, просто и живо. Без длинных тире (только дефис или запятая), без кавычек-ёлочек, без хештегов, без эмодзи.
- Не зови подписываться и не упоминай чужие каналы, Telegram и ссылки.
- Цитата допустима только дословно из материала.`;

function gudiniBrief(item: ExportItem) {
  const editable = item.editable!;
  const limits = editable.limits;
  const original = editable.content;
  return `Перерисовка карусели шаблоном Gudini «Расследование». Перепиши тексты карточек в своей подаче. Сохрани порядок: шаг N стоит над скриншотом своего источника, его факты остаются его фактами.
Поля и пределы (в знаках, **жирные** отметки не считаются):
- content.cover.title: 1-3 строки ПРОПИСНЫМИ, каждая до ${limits.coverLine} знаков, громко и коротко.
- content.cover.accentLine: до ${limits.coverAccent} знаков, главная цифра истории из материала.
- content.cover.hook: до 70 знаков, призыв листать, можно со стрелкой →.
- content.steps: ровно ${original.steps.length} шагов в том же порядке; у каждого title до ${limits.title} знаков, body до ${limits.body} знаков (1-3 ключевых места **жирным**), next до ${limits.next} знаков строчными (о чём следующий шаг).
- content.final.black и content.final.accent: по 1-2 строки ПРОПИСНЫМИ до ${limits.finalLine} знаков; content.final.body до ${limits.finalBody} знаков, заканчивается вопросом к читателю.
- caption: до ${LIMITS.gudiniCaption} знаков, заканчивается вопросом, без хештегов, эмодзи и Telegram.
Ярлыки шагов, плашки с цифрами и карточки финала не меняй: они взяты из источников.
Карусель сейчас (JSON):
${JSON.stringify({ cover: { title: original.cover.title, accentLine: original.cover.accentLine, hook: original.cover.hook }, steps: original.steps.map(step => ({ label: step.label, title: step.title, body: step.body, pills: step.pills, next: step.next })), final: { black: original.final.black, accent: original.final.accent, cards: original.final.cards, body: original.final.body } })}`;
}

/** The writer's task for one material: all its planned versions in one call, with the facts it may use. */
export function writerPrompt(item: ExportItem, variants: Pick<Variant, 'slot' | 'style' | 'format' | 'layout'>[]) {
  const system = `Ты редактор новостных аккаунтов в Threads и Instagram. Из одного материала пишешь несколько разных редакционных версий для разных аккаунтов.
${WRITER_RULES}
Отвечай строго одним JSON-объектом без пояснений.`;
  const cards = item.cards.map(card => `[${card.index}] ${[card.kicker, card.title, card.body, ...card.bullets].filter(Boolean).join(' | ')}`).join('\n');
  const sources = item.sources.slice(0, 15).map(source => `- ${[source.publisher, source.title, source.date, source.note].filter(Boolean).join(' · ')}`).join('\n');
  const facts = item.facts.slice(0, 30).map(fact => `- ${fact.claim}${fact.quote ? ` (цитата: «${fact.quote}»)` : ''}`).join('\n');
  const redraw = variants.some(variant => variant.layout === 'gudini');
  const tasks = variants.map(variant => {
    const style = variant.style === 'original' ? 'Подпись к исходной карусели: перескажи суть своими словами и позови листать карточки.' : STYLE_BRIEFS[variant.style as Exclude<Style, 'original'>];
    if (variant.layout === 'gudini') return `- slot ${variant.slot}: ${style} Нужно: text (пост для Threads до ${LIMITS.text} знаков), caption (подпись для Instagram) и content (тексты карточек, см. ниже).`;
    if (variant.layout === 'original') return `- slot ${variant.slot}: ${style} Нужно: text (пост для Threads до ${LIMITS.text} знаков) и caption (подпись для Instagram до ${LIMITS.caption} знаков, можно с абзацами).`;
    if (variant.layout === 'cover') return `- slot ${variant.slot}: ${style} Нужно: text (подпись к обложке ролика для Threads до ${LIMITS.text} знаков).`;
    return `- slot ${variant.slot}: ${style} Нужно: text (пост для Threads до ${LIMITS.text} знаков).`;
  }).join('\n');
  const user = `МАТЕРИАЛ (${item.kind === 'news' ? 'новость' : 'карусель'})
Заголовок: ${item.title}
${item.summary ? `Кратко: ${item.summary}\n` : ''}Текст:
${storyText(item).slice(0, 6000)}
${cards ? `\nКарточки:\n${cards.slice(0, 5000)}\n` : ''}${sources ? `\nИсточники и заметки к ним:\n${sources.slice(0, 3000)}\n` : ''}${facts ? `\nПроверенные факты:\n${facts.slice(0, 5000)}\n` : ''}
НУЖНЫЕ ВЕРСИИ:
${tasks}
${redraw ? `\n${gudiniBrief(item)}\n` : ''}
Верни JSON: {"variants": [{"slot": номер, "text": "...", "caption": "...", "content": {"cover": {"title": [...], "accentLine": "...", "hook": "..."}, "steps": [{"title": "...", "body": "...", "next": "..."}], "final": {"black": [...], "accent": [...], "body": "..."}}}]} - поля только те, что нужны версии.`;
  return { system, user };
}

/** Materials whose versions wait for texts, within the daily limit of writer calls. */
export async function writerQueue(owner: string, limit = 1) {
  const db = getDb();
  // A write the engine never finished (restart, crash) goes back to the queue.
  await db.update(contentVariants).set({ status: 'planned', updatedAt: now() }).where(and(eq(contentVariants.owner, owner), eq(contentVariants.status, 'writing'), lt(contentVariants.updatedAt, new Date(Date.now() - STALE_WRITING_MS).toISOString())));
  const settings = await readSettings(owner);
  const used = await writerCount(owner);
  if (used >= settings.dailyWriterCalls) return { jobs: [], limitReached: true, used, limit: settings.dailyWriterCalls };
  // A version sent back by the checks waits two minutes before it is written again.
  const settled = new Date(Date.now() - 2 * 60_000).toISOString();
  const rows = await db.select({ itemId: contentVariants.itemId }).from(contentVariants).where(and(eq(contentVariants.owner, owner), eq(contentVariants.status, 'planned'), sql`(${contentVariants.attempts} = 0 or ${contentVariants.updatedAt} < ${settled})`)).groupBy(contentVariants.itemId).orderBy(asc(sql`min(${contentVariants.createdAt})`)).limit(limit);
  const jobs = [];
  for (const { itemId } of rows) {
    const item = await ownedItem(owner, itemId);
    const variants = await db.select().from(contentVariants).where(and(eq(contentVariants.itemId, itemId), eq(contentVariants.revision, item.revision), eq(contentVariants.status, 'planned')));
    if (!variants.length) continue;
    const { system, user } = writerPrompt(material(item), variants);
    jobs.push({ itemId, revision: item.revision, slots: variants.map(variant => variant.slot), system, user });
  }
  return { jobs, limitReached: false, used, limit: settings.dailyWriterCalls };
}
/** Takes the planned versions of a material for writing; only one engine pass gets them. */
export async function claimWriting(owner: string, itemId: string, revision: string) {
  const changed = await getDb().update(contentVariants).set({ status: 'writing', attempts: sql`${contentVariants.attempts} + 1`, updatedAt: now() })
    .where(and(eq(contentVariants.owner, owner), eq(contentVariants.itemId, itemId), eq(contentVariants.revision, revision), eq(contentVariants.status, 'planned'))).returning({ slot: contentVariants.slot });
  if (changed.length) await countWriterCall(owner);
  return { slots: changed.map(row => row.slot) };
}

export type WriterOutput = { slot: number; text?: string | null; caption?: string | null; content?: unknown };
const tidy = (value: unknown, limit: number) => typeof value === 'string' ? value.replace(/\s*[—–]\s*/g, ' - ').replace(/[«»]/g, '"').replace(/[ \t]+/g, ' ').replace(/\n{3,}/g, '\n\n').trim().slice(0, limit + 200) : '';
const line = (value: unknown) => typeof value === 'string' ? value.replace(/\s*[—–]\s*/g, ' - ').replace(/[«»]/g, '"').replace(/\s+/g, ' ').trim() : '';
const lines = (value: unknown) => Array.isArray(value) ? value.map(line).filter(Boolean).slice(0, 3) : [];

/** The original carousel with the version's rewritten fields; labels, value pills and final cards stay Gudini's. */
export function mergeContent(original: EditableContent, raw: unknown, caption: string): EditableContent {
  const input = (raw && typeof raw === 'object' ? raw : {}) as { cover?: Record<string, unknown>; steps?: Record<string, unknown>[]; final?: Record<string, unknown> };
  const title = lines(input.cover?.title).map(value => value.toUpperCase());
  const black = lines(input.final?.black).map(value => value.toUpperCase());
  const accent = lines(input.final?.accent).map(value => value.toUpperCase());
  return {
    cover: { pill: original.cover.pill, title: title.length ? title : original.cover.title, accentLine: line(input.cover?.accentLine).toUpperCase() || original.cover.accentLine, hook: line(input.cover?.hook) || original.cover.hook },
    steps: original.steps.map((step, index) => {
      const next = Array.isArray(input.steps) ? input.steps[index] || {} : {};
      return { ...step, title: line(next.title) || step.title, body: line(next.body) || step.body, next: line(next.next).replace(/\s*→\s*$/, '') || step.next };
    }),
    final: { black: black.length ? black : original.final.black, accent: accent.length ? accent : original.final.accent, cards: original.final.cards, body: line(input.final?.body) || original.final.body },
    caption: caption || original.caption,
  };
}
/** Gudini's limits and caption rules, checked before Gudini is asked to draw (it checks again itself). */
export function contentProblems(content: EditableContent, limits: Record<string, number>) {
  const problems: string[] = [];
  const over = (path: string, text: string, max: number | undefined) => { if (max && visible(text) > max) problems.push(`${path}: ${visible(text)} знаков при пределе ${max}`); };
  content.cover.title.forEach((text, index) => over(`cover.title[${index}]`, text, limits.coverLine));
  over('cover.accentLine', content.cover.accentLine, limits.coverAccent);
  content.steps.forEach((step, index) => { over(`steps[${index}].title`, step.title, limits.title); over(`steps[${index}].body`, step.body, limits.body); over(`steps[${index}].next`, step.next, limits.next); });
  [...content.final.black, ...content.final.accent].forEach((text, index) => over(`final line ${index + 1}`, text, limits.finalLine));
  over('final.body', content.final.body, limits.finalBody);
  if ([...content.caption].length > LIMITS.gudiniCaption) problems.push(`caption: ${[...content.caption].length} знаков при пределе ${LIMITS.gudiniCaption}`);
  if (!/\?\s*$/.test(content.caption)) problems.push('caption: нужен вопрос в конце');
  if (/#/.test(content.caption)) problems.push('caption: без хештегов');
  if (/\p{Extended_Pictographic}/u.test(content.caption)) problems.push('caption: без эмодзи');
  if (/телеграм|telegram|в директ|в личк/i.test(content.caption + content.final.body)) problems.push('caption/final.body: без Telegram и обещаний прислать в личку');
  return problems;
}

/**
 * Stores the writer's texts and checks each one: facts only from the material, not a near copy of the source or
 * of a sibling version, within the platform's and Gudini's limits. A version that fails is written again (up to 3
 * times); after that it waits for the owner as «review» with the reasons shown.
 */
export async function acceptTexts(owner: string, itemId: string, revision: string, outputs: WriterOutput[]) {
  const db = getDb();
  const item = await ownedItem(owner, itemId);
  if (item.revision !== revision) return { stale: true };
  const data = material(item);
  const basis = factBasis(data);
  const source = { text: basis.text, links: basis.links };
  const review = Boolean((await readSettings(owner)).reviewEnabled);
  const variants = await db.select().from(contentVariants).where(and(eq(contentVariants.itemId, itemId), eq(contentVariants.revision, revision)));
  const accepted: string[] = variants.filter(variant => variant.status !== 'writing' && variant.text).map(variant => variant.text!);
  const captions: string[] = variants.filter(variant => variant.status !== 'writing' && variant.caption).map(variant => variant.caption!);
  const drawn: string[] = variants.filter(variant => variant.status !== 'writing' && variant.layout === 'gudini' && variant.cards).map(variant => editableTexts(parse<EditableContent>(variant.cards, data.editable!.content)).join('\n'));
  const originalCards = data.editable ? editableTexts(data.editable.content).join('\n') : '';
  const results: { slot: number; status: string; problems: string[] }[] = [];
  for (const variant of variants.filter(entry => entry.status === 'writing').sort((a, b) => a.slot - b.slot)) {
    const output = outputs.find(entry => entry.slot === variant.slot);
    const text = tidy(output?.text, LIMITS.text);
    const captionLimit = variant.layout === 'gudini' ? LIMITS.gudiniCaption : LIMITS.caption;
    const caption = ['original', 'gudini'].includes(variant.layout) ? tidy(output?.caption, captionLimit) : '';
    const problems: string[] = [];
    if (!output) problems.push('мост не прислал эту версию');
    const score = scoreVariant(source, text, accepted, LIMITS.text);
    problems.push(...score.problems.map(problem => `текст: ${problem}`));
    if (['original', 'gudini'].includes(variant.layout)) {
      const captionFacts = checkFacts(source, caption);
      if (!caption) problems.push('нет подписи для Instagram');
      if (!captionFacts.ok) problems.push(`подпись: факты не из источника: ${captionFacts.problems.map(entry => entry.value).slice(0, 4).join(', ')}`);
      if (caption.length > captionLimit) problems.push(`подпись длиннее ${captionLimit} знаков`);
      const closest = captions.reduce((max, other) => Math.max(max, similarity(other, caption)), 0);
      if (caption && closest > 0.55) problems.push('подпись слишком похожа на другую версию');
    }
    let cards: string | null = variant.cards;
    let headline = variant.headline;
    if (variant.layout === 'gudini' && data.editable) {
      const merged = mergeContent(data.editable.content, output?.content, caption);
      const all = editableTexts(merged).join('\n');
      const facts = checkFacts(source, all);
      if (!facts.ok) problems.push(`карточки: факты не из источника: ${facts.problems.map(entry => entry.value).slice(0, 5).join(', ')}`);
      problems.push(...contentProblems(merged, data.editable.limits).map(problem => `карточки: ${problem}`));
      if (similarity(originalCards, all) > 0.75) problems.push('карточки почти не отличаются от оригинала Gudini');
      if (drawn.some(other => similarity(other, all) > 0.6)) problems.push('карточки слишком похожи на другую перерисовку');
      cards = JSON.stringify(merged);
      headline = merged.cover.title.join(' ');
      if (!problems.length) drawn.push(all);
    }
    const quality = JSON.stringify({ toSource: score.toSource, closest: score.closest, facts: score.facts.problems, problems, checkedAt: now() });
    let status: string;
    if (!problems.length) {
      // With the AI editor on, every version is read by it before use; otherwise the checks above decide.
      status = review ? 'reviewing' : variant.layout === 'gudini' ? 'written' : 'ready';
      accepted.push(text); if (caption) captions.push(caption);
    } else status = variant.attempts >= MAX_WRITES ? 'review' : 'planned';
    await db.update(contentVariants).set({ status, headline: headline || null, text: text || null, caption: caption || null, cards, quality, error: problems.length ? problems.join('; ').slice(0, 800) : null, updatedAt: now() }).where(eq(contentVariants.id, variant.id));
    // A version already given to a profile is drawn as soon as its texts are in.
    if (status === 'written' && variant.profileId) await queueRender(owner, variant.id);
    results.push({ slot: variant.slot, status, problems });
  }
  return { results };
}
/**
 * The writer could not answer. A failure of the bridge itself (down, refused) gives the attempt back; an answer
 * that could not be read counts as an attempt, and after the last one the version is marked failed.
 */
export async function writingFailed(owner: string, itemId: string, revision: string, error: string, bridge = false) {
  const db = getDb();
  const writing = await db.select().from(contentVariants).where(and(eq(contentVariants.owner, owner), eq(contentVariants.itemId, itemId), eq(contentVariants.revision, revision), eq(contentVariants.status, 'writing')));
  for (const variant of writing) {
    const attempts = bridge ? Math.max(0, variant.attempts - 1) : variant.attempts;
    await db.update(contentVariants).set({ status: !bridge && attempts >= MAX_WRITES ? 'failed' : 'planned', attempts, error: `${bridge ? 'GPT-мост: ' : ''}${error}`.slice(0, 300), updatedAt: now() }).where(eq(contentVariants.id, variant.id));
  }
  return { returned: writing.length };
}

// ---------------------------------------------------------------- owner's edits

/** The owner corrects the post text or the caption by hand; they are checked the same way before use. */
export async function editVariant(owner: string, variantId: string, input: { text?: string | null; caption?: string | null }) {
  const variant = await ownedVariant(owner, variantId);
  if (['outdated', 'rendering', 'writing'].includes(variant.status)) throw new VariantError('Этот вариант сейчас нельзя менять.', 409);
  const item = await ownedItem(owner, variant.itemId);
  const basis = factBasis(material(item));
  const source = { text: basis.text, links: basis.links };
  const captionLimit = variant.layout === 'gudini' ? LIMITS.gudiniCaption : LIMITS.caption;
  const text = input.text === undefined ? variant.text || '' : tidy(input.text, LIMITS.text);
  const caption = input.caption === undefined ? variant.caption || '' : tidy(input.caption, captionLimit);
  const problems = [...checkFacts(source, `${text}\n${caption}`).problems.map(problem => `факт не из источника: ${problem.value}`)];
  if (text.length > LIMITS.text) problems.push(`текст длиннее ${LIMITS.text} знаков`);
  if (caption.length > captionLimit) problems.push(`подпись длиннее ${captionLimit} знаков`);
  if (!text.trim()) problems.push('нет текста');
  if (problems.length) throw new VariantError(`Не сохранено: ${problems.join('; ')}.`);
  // With the AI editor on, the owner's text is read by it too (a new rating); the cards do not change with the
  // post text, so a drawn version keeps its pictures.
  const review = Boolean((await readSettings(owner)).reviewEnabled);
  const drawn = variant.layout !== 'gudini' || variant.assetsCount > 0;
  const status = review ? 'reviewing' : variant.status === 'rendering' ? 'rendering' : drawn ? 'ready' : 'written';
  await getDb().update(contentVariants).set({
    text, caption: caption || null, error: null, status, updatedAt: now(), ...(review ? { score: null, review: null } : {}),
    quality: JSON.stringify({ ...parse<Record<string, unknown>>(variant.quality, {}), editedAt: now(), problems: [] }),
  }).where(eq(contentVariants.id, variantId));
  if (status === 'written' && variant.profileId) await queueRender(owner, variantId);
  return { ok: true, status };
}
/** The owner accepts, as it is, a version that waits for them («review»): the editor's notes stay for history. */
export async function approveVariant(owner: string, variantId: string) {
  const variant = await ownedVariant(owner, variantId);
  if (variant.status !== 'review') throw new VariantError('Одобрить можно только версию, которая ждёт вашей проверки.', 409);
  const status = variant.layout === 'gudini' && !variant.assetsCount ? 'written' : 'ready';
  await getDb().update(contentVariants).set({ status, error: null, review: JSON.stringify({ ...parse<Record<string, unknown>>(variant.review, {}), approvedByOwnerAt: now() }), updatedAt: now() }).where(eq(contentVariants.id, variantId));
  if (status === 'written' && variant.profileId) await queueRender(owner, variantId);
  return { ok: true, status };
}
/** «Сделать заново»: new texts (and new cards) for this version. Published versions stay as they are. */
export async function regenerateVariant(owner: string, variantId: string) {
  const variant = await ownedVariant(owner, variantId);
  if (variant.status === 'outdated') throw new VariantError('Материал изменился: у него уже новые версии.', 409);
  await getDb().batch([
    getDb().update(contentVariants).set({ status: 'planned', attempts: 0, error: null, quality: null, cards: null, assetsCount: 0, updatedAt: now() }).where(eq(contentVariants.id, variantId)),
    getDb().delete(mediaJobs).where(and(eq(mediaJobs.kind, 'render'), eq(mediaJobs.subjectId, variantId))),
    getDb().delete(variantAssets).where(eq(variantAssets.variantId, variantId)),
  ]);
  return { ok: true };
}
export async function rejectVariant(owner: string, variantId: string) {
  await ownedVariant(owner, variantId);
  await getDb().update(contentVariants).set({ status: 'rejected', updatedAt: now() }).where(eq(contentVariants.id, variantId));
  return { ok: true };
}

// ---------------------------------------------------------------- drawing with Gudini's templates

export const queueRender = async (owner: string, variantId: string) => {
  await getDb().insert(mediaJobs).values({ id: crypto.randomUUID(), owner, kind: 'render', subjectId: variantId, status: 'queued', createdAt: now(), updatedAt: now() })
    .onConflictDoUpdate({ target: [mediaJobs.kind, mediaJobs.subjectId], set: { status: 'queued', attempts: 0, error: null, leaseUntil: null, nextAttemptAt: null, updatedAt: now() } });
  await getDb().update(contentVariants).set({ status: 'rendering', updatedAt: now() }).where(eq(contentVariants.id, variantId));
};

/** The account's look in Gudini's terms: a colour of Gudini's palette and the handle of the account. */
export async function lookFor(owner: string, profileId: string | null, platform: string | null) {
  if (!profileId) return { palette: null as number | null, profileIndex: 0, handle: null as string | null };
  const [row] = await getDb().select({ design: profileEditorial.design }).from(profileEditorial).where(eq(profileEditorial.profileId, profileId));
  const ordered = await getDb().select({ id: profiles.id }).from(profiles).where(eq(profiles.owner, owner)).orderBy(asc(profiles.createdAt));
  const [account] = await getDb().select({ username: socialAccounts.username }).from(socialAccounts).where(and(eq(socialAccounts.profileId, profileId), eq(socialAccounts.status, 'connected'), ...(platform ? [eq(socialAccounts.platform, platform)] : []))).limit(1);
  const design = parse<{ palette?: number }>(row?.design, {});
  return { palette: Number.isInteger(design.palette) ? design.palette! : null, profileIndex: Math.max(0, ordered.findIndex(entry => entry.id === profileId)), handle: account?.username ?? null };
}

/** The next drawing job, or null. The lease makes a crashed job come back. */
export async function claimRender(owner: string, nowMs = Date.now()) {
  const db = getDb();
  const at = new Date(nowMs).toISOString();
  const [job] = await db.select().from(mediaJobs).where(and(eq(mediaJobs.owner, owner), eq(mediaJobs.kind, 'render'),
    sql`((${mediaJobs.status} = 'queued' and (${mediaJobs.nextAttemptAt} is null or ${mediaJobs.nextAttemptAt} <= ${at})) or (${mediaJobs.status} = 'running' and ${mediaJobs.leaseUntil} < ${at}))`))
    .orderBy(asc(mediaJobs.createdAt)).limit(1);
  if (!job) return null;
  const taken = await db.update(mediaJobs).set({ status: 'running', attempts: sql`${mediaJobs.attempts} + 1`, leaseUntil: new Date(nowMs + RENDER_LEASE_MS).toISOString(), updatedAt: at })
    .where(and(eq(mediaJobs.id, job.id), eq(mediaJobs.updatedAt, job.updatedAt))).returning({ id: mediaJobs.id });
  if (!taken.length) return null;
  return { jobId: job.id, variantId: job.subjectId, attempt: job.attempts + 1 };
}

const fieldPath = (problem: string) => /^(cover|steps\[\d+\]|final|caption)/.exec(problem.replace(/^карточки: /, ''))?.[1] ?? null;
/** Puts Gudini's own text back into every field Gudini still could not fit. */
export function restoreOriginal(content: EditableContent, original: EditableContent, problems: string[]) {
  const next: EditableContent = structuredClone(content);
  for (const path of new Set(problems.map(fieldPath).filter(Boolean))) {
    if (path === 'cover') next.cover = structuredClone(original.cover);
    else if (path === 'final') next.final = structuredClone(original.final);
    else if (path === 'caption') next.caption = original.caption;
    else { const index = Number(/\d+/.exec(path!)![0]); if (original.steps[index]) next.steps[index] = structuredClone(original.steps[index]); }
  }
  // «final line N» names no block: the final lines come back together with the final.
  if (problems.some(problem => /final line/.test(problem))) next.final = structuredClone(original.final);
  return next;
}

/**
 * Draws a claimed version with Gudini's templates and stores the cards. When Gudini says a text does not fit, the
 * answer carries a short task for the writer (rounds 1-2); after that Gudini's own text is put back into those
 * fields and the version is drawn again.
 */
export async function renderWithGudini(owner: string, jobId: string, request?: typeof fetch) {
  const db = getDb();
  const [job] = await db.select().from(mediaJobs).where(and(eq(mediaJobs.id, jobId), eq(mediaJobs.owner, owner)));
  if (!job || job.status !== 'running') throw new VariantError('Задание не выполняется.', 409);
  const variant = await ownedVariant(owner, job.subjectId);
  const item = await ownedItem(owner, variant.itemId);
  const data = material(item);
  if (variant.layout !== 'gudini' || !data.editable || !variant.cards) throw new VariantError('Этот вариант не перерисовывается.', 409);
  const content = parse<EditableContent>(variant.cards, data.editable.content);
  const look = await lookFor(owner, variant.profileId, variant.platform);
  const palette = paletteFor(look.palette, look.profileIndex, data.editable.palette, data.editable.palettes.length || 7);
  let answer;
  try { answer = await (await sourceTransport(owner, request)).render({ itemId: data.id, content, palette, handle: look.handle }); }
  catch (error) { throw error instanceof SourceError ? new VariantError(error.message, error.retryable ? 503 : 502) : error; }
  const quality = parse<Record<string, unknown>>(variant.quality, {});
  if (!answer.ok) {
    const rounds = Number(quality.fixRounds) || 0;
    if (rounds < MAX_FIX_ROUNDS) {
      await db.update(contentVariants).set({ quality: JSON.stringify({ ...quality, fixRounds: rounds + 1, renderProblems: answer.problems }), updatedAt: now() }).where(eq(contentVariants.id, variant.id));
      return { ok: false as const, problems: answer.problems, fix: fixPrompt(data, content, answer.problems) };
    }
    if (!quality.restored) {
      const restored = restoreOriginal(content, data.editable.content, answer.problems);
      await db.update(contentVariants).set({ cards: JSON.stringify(restored), quality: JSON.stringify({ ...quality, restored: answer.problems }), updatedAt: now() }).where(eq(contentVariants.id, variant.id));
      await db.update(mediaJobs).set({ status: 'queued', leaseUntil: null, updatedAt: now() }).where(eq(mediaJobs.id, jobId));
      return { ok: false as const, problems: answer.problems, restored: true };
    }
    await failRender(owner, jobId, `Gudini не смог сверстать: ${answer.problems.slice(0, 3).join('; ')}`, false);
    return { ok: false as const, problems: answer.problems, failed: true };
  }
  for (const slide of answer.slides) {
    const bytes = Uint8Array.from(atob(slide.data), char => char.charCodeAt(0));
    if (slide.contentType !== 'image/jpeg' || bytes.byteLength > 8 * 1024 * 1024) throw new VariantError('Gudini вернул не JPEG или слишком большой файл.', 502);
    await env.BUCKET!.put(`${owner}/variants/${variant.id}/${slide.index}.jpg`, bytes, { httpMetadata: { contentType: 'image/jpeg' } });
  }
  await db.update(contentVariants).set({ quality: JSON.stringify({ ...quality, palette: answer.palette, handle: look.handle }), updatedAt: now() }).where(eq(contentVariants.id, variant.id));
  return { ok: true as const, slides: answer.slides.map(slide => ({ index: slide.index, key: `${owner}/variants/${variant.id}/${slide.index}.jpg`, width: slide.width, height: slide.height, size: slide.size })) };
}
/** The writer's task after Gudini's layout refused texts: the same version, only the named fields shorter. */
function fixPrompt(item: ExportItem, content: EditableContent, problems: string[]) {
  return {
    system: `Ты редактор каруселей Gudini. Карточка не свёрстана, потому что тексты не поместились. Исправь только названные поля: сократи или перескажи короче, смысл и факты те же.\n${WRITER_RULES}\nОтвечай строго одним JSON-объектом без пояснений.`,
    user: `Пределы в знаках: ${JSON.stringify(item.editable!.limits)}.\nЧто не так (слово вёрстки Gudini):\n${problems.map(problem => `- ${problem}`).join('\n')}\n\nТексты сейчас:\n${JSON.stringify({ cover: content.cover, steps: content.steps.map(step => ({ title: step.title, body: step.body, next: step.next })), final: { black: content.final.black, accent: content.final.accent, body: content.final.body }, caption: content.caption })}\n\nВерни JSON: {"content": {"cover": {...}, "steps": [...], "final": {...}}, "caption": "..."} - все поля, исправлены только названные.`,
  };
}
/** The writer's corrected texts after a refused layout: checked like any text, then drawn again. */
export async function fixedContent(owner: string, jobId: string, output: { content?: unknown; caption?: string | null }) {
  const db = getDb();
  const [job] = await db.select().from(mediaJobs).where(and(eq(mediaJobs.id, jobId), eq(mediaJobs.owner, owner)));
  if (!job) throw new VariantError('Задание не найдено.', 404);
  const variant = await ownedVariant(owner, job.subjectId);
  const item = await ownedItem(owner, variant.itemId);
  const data = material(item);
  const current = parse<EditableContent>(variant.cards, data.editable!.content);
  const merged = mergeContent(current, output.content, tidy(output.caption, LIMITS.gudiniCaption) || current.caption);
  const basis = factBasis(data);
  // Invented facts never reach the cards: the blocks that have them go back to Gudini's text at once.
  const { content, restored } = restoreUnsupported(merged, data.editable!.content, { text: basis.text, links: basis.links });
  await db.update(contentVariants).set({ cards: JSON.stringify(content), caption: content.caption, updatedAt: now() }).where(eq(contentVariants.id, variant.id));
  await db.update(mediaJobs).set({ status: 'queued', leaseUntil: null, updatedAt: now() }).where(eq(mediaJobs.id, jobId));
  return { ok: true, restored };
}
/** Checks each block of cards on its own and gives Gudini's text back to any block with a fact not in the material. */
export function restoreUnsupported(content: EditableContent, original: EditableContent, source: { text: string; links: string[] }) {
  const problems: string[] = [];
  const bad = (texts: string[]) => !checkFacts(source, texts.join('\n')).ok;
  if (bad([...content.cover.title, content.cover.accentLine, content.cover.hook])) problems.push('cover');
  content.steps.forEach((step, index) => { if (bad([step.title, step.body.replace(/\*\*/g, ''), step.next])) problems.push(`steps[${index}]`); });
  if (bad([...content.final.black, ...content.final.accent, content.final.body])) problems.push('final');
  if (bad([content.caption])) problems.push('caption');
  return { content: problems.length ? restoreOriginal(content, original, problems) : content, restored: problems };
}

export type RenderedFile = { index: number; contentType: string; width: number; height: number; size: number; sha256: string; dhash: string };
/** Finishes a drawing job: every card stored, the right size; the cover must differ from sibling versions' covers. */
export async function completeRender(owner: string, jobId: string, files: RenderedFile[], stats: { elapsedMs?: number; cpuMs?: number }) {
  const db = getDb();
  const [job] = await db.select().from(mediaJobs).where(and(eq(mediaJobs.id, jobId), eq(mediaJobs.owner, owner)));
  if (!job || job.status !== 'running') throw new VariantError('Задание не выполняется.', 409);
  const variant = await ownedVariant(owner, job.subjectId);
  const content = parse<EditableContent | null>(variant.cards, null);
  const expected = content ? content.steps.length + 2 : files.length;
  if (!files.length || files.length !== expected || files.some((file, index) => file.index !== index || file.width !== 1080 || file.height !== 1350)) throw new VariantError('Gudini вернул не все карточки или не того размера.', 422);
  for (const file of files) if (!(await env.BUCKET!.head(`${owner}/variants/${variant.id}/${file.index}.jpg`))) throw new VariantError(`Карточка ${file.index + 1} не сохранилась.`, 409);
  const siblings = await db.select({ dhash: variantAssets.dhash }).from(variantAssets).innerJoin(contentVariants, eq(contentVariants.id, variantAssets.variantId))
    .where(and(eq(contentVariants.itemId, variant.itemId), ne(contentVariants.id, variant.id), eq(variantAssets.index, 0)));
  const close = siblings.filter(row => row.dhash && hammingDistance(row.dhash, files[0].dhash) <= 4);
  const quality = parse<Record<string, unknown>>(variant.quality, {});
  await db.batch([
    db.delete(variantAssets).where(eq(variantAssets.variantId, variant.id)),
    ...files.map(file => db.insert(variantAssets).values({ id: `${variant.id}:${file.index}`, owner, variantId: variant.id, index: file.index, storageKey: `${owner}/variants/${variant.id}/${file.index}.jpg`, contentType: 'image/jpeg', size: file.size, width: file.width, height: file.height, sha256: file.sha256, dhash: file.dhash, createdAt: now() })),
    db.update(mediaJobs).set({ status: 'done', error: null, leaseUntil: null, elapsedMs: stats.elapsedMs ?? null, cpuMs: stats.cpuMs ?? null, updatedAt: now() }).where(eq(mediaJobs.id, jobId)),
    db.update(contentVariants).set({
      status: close.length ? 'review' : 'ready', assetsCount: files.length, error: close.length ? 'Обложка почти такая же, как у другой перерисовки этого материала.' : null,
      quality: JSON.stringify({ ...quality, coverLikeOthers: close.length, renderedAt: now() }), updatedAt: now(),
    }).where(eq(contentVariants.id, variant.id)),
    // A publication that was waiting for these cards may go at its time again, without the waiting pause.
    db.update(publications).set({ nextAttemptAt: null, error: null, updatedAt: now() }).where(and(eq(publications.variantId, variant.id), eq(publications.status, 'scheduled'))),
  ] as unknown as Parameters<typeof db.batch>[0]);
  return { ok: true, review: close.length > 0 };
}
export async function failRender(owner: string, jobId: string, error: string, retryable: boolean, nowMs = Date.now()) {
  const db = getDb();
  const [job] = await db.select().from(mediaJobs).where(and(eq(mediaJobs.id, jobId), eq(mediaJobs.owner, owner)));
  if (!job) return { finished: true };
  const finished = !retryable || job.attempts >= MAX_RENDERS;
  await db.update(mediaJobs).set({ status: finished ? 'failed' : 'queued', error: error.slice(0, 500), leaseUntil: null, nextAttemptAt: finished ? null : new Date(nowMs + 60_000 * 2 ** job.attempts).toISOString(), updatedAt: now() }).where(eq(mediaJobs.id, jobId));
  if (finished) await db.update(contentVariants).set({ status: 'review', error: `Карточки не нарисованы: ${error}`.slice(0, 500), updatedAt: now() }).where(eq(contentVariants.id, job.subjectId));
  return { finished };
}

/** Files a version publishes, in order: Gudini's cards, Gudini's redrawn cards or Gudini's cover. */
export async function variantMedia(owner: string, variantId: string) {
  const variant = await ownedVariant(owner, variantId);
  if (variant.layout === 'none') return [];
  if (variant.layout === 'original' || variant.layout === 'cover') {
    const item = await ownedItem(owner, variant.itemId);
    const stored = await storedAssets(item.id, item.revision);
    const ids = variant.layout === 'original' ? originalCards(material(item), new Set(stored.keys())) : [coverAsset(material(item), new Set(stored.keys()))].filter((id): id is string => Boolean(id));
    return ids.map(id => ({ key: stored.get(id)!, contentType: 'image/jpeg' }));
  }
  const rows = await getDb().select().from(variantAssets).where(eq(variantAssets.variantId, variantId)).orderBy(asc(variantAssets.index));
  return rows.map(row => ({ key: row.storageKey, contentType: row.contentType }));
}

/** Stored original files of a material (current revision) for previews. */
export async function itemFiles(owner: string, itemId: string) {
  const item = await ownedItem(owner, itemId);
  return getDb().select({ assetId: sourceAssets.assetId, role: sourceAssets.role, card: sourceAssets.card, key: sourceAssets.storageKey, contentType: sourceAssets.contentType, size: sourceAssets.size, status: sourceAssets.status })
    .from(sourceAssets).where(and(eq(sourceAssets.itemId, itemId), eq(sourceAssets.revision, item.revision))).orderBy(asc(sourceAssets.card));
}
/** The «Варианты» screen: materials with their versions, texts, checks and a preview picture. */
export async function variantsOverview(owner: string, filter: { itemId?: string } = {}) {
  const db = getDb();
  const items = filter.itemId ? [await ownedItem(owner, filter.itemId)]
    : await db.select().from(sourceItems).where(and(eq(sourceItems.owner, owner), eq(sourceItems.status, 'ready'), sql`exists (select 1 from content_variants v where v.itemId = ${sourceItems.id} and v.status != 'outdated')`)).orderBy(desc(sourceItems.sourceReadyAt)).limit(40);
  const ids = items.map(item => item.id);
  const variants = ids.length ? await db.select().from(contentVariants).where(and(inArray(contentVariants.itemId, ids), ne(contentVariants.status, 'outdated'))).orderBy(asc(contentVariants.slot)) : [];
  const firsts = variants.length ? await db.select({ variantId: variantAssets.variantId, key: variantAssets.storageKey }).from(variantAssets).where(and(inArray(variantAssets.variantId, variants.map(variant => variant.id)), eq(variantAssets.index, 0))) : [];
  const settings = await readSettings(owner);
  // The stored files of every listed material in one read, not one read per material.
  const files = ids.length ? await db.select({ itemId: sourceAssets.itemId, revision: sourceAssets.revision, assetId: sourceAssets.assetId, storageKey: sourceAssets.storageKey }).from(sourceAssets).where(and(inArray(sourceAssets.itemId, ids), eq(sourceAssets.status, 'stored'))) : [];
  const out = [];
  for (const item of items) {
    const data = material(item);
    const stored = new Map(files.filter(row => row.itemId === item.id && row.revision === item.revision && row.storageKey).map(row => [row.assetId, row.storageKey!]));
    const originals = originalCards(data, new Set(stored.keys()));
    const cover = coverAsset(data, new Set(stored.keys()));
    out.push({
      id: item.id, kind: item.kind, title: item.title, category: item.category, readyAt: item.sourceReadyAt, categories: parse<string[]>(item.categories, []), urgent: Boolean(item.urgent),
      variants: variants.filter(variant => variant.itemId === item.id && variant.revision === item.revision).map(variant => {
        const quality = parse<Record<string, unknown>>(variant.quality, {});
        const preview = variant.layout === 'original' ? stored.get(originals[0]) : variant.layout === 'cover' ? (cover ? stored.get(cover) : null) : firsts.find(row => row.variantId === variant.id)?.key;
        return {
          id: variant.id, slot: variant.slot, style: variant.style, styleName: STYLE_NAMES[variant.style as Style] || variant.style, format: variant.format,
          layout: variant.layout, layoutName: LAYOUT_NAMES[variant.layout as keyof typeof LAYOUT_NAMES] || variant.layout, status: variant.status,
          headline: variant.headline, text: variant.text, caption: variant.caption, error: variant.error, profileId: variant.profileId, platform: variant.platform,
          aiImagery: Boolean(variant.aiImagery), palette: typeof quality.palette === 'string' ? quality.palette : null, preview: preview ?? null,
          cards: variant.layout === 'original' ? originals.length : variant.layout === 'cover' ? (cover ? 1 : 0) : variant.assetsCount,
          checks: { toSource: quality.toSource ?? null, closest: quality.closest ?? null, problems: Array.isArray(quality.problems) ? quality.problems : [] },
          // The editor's rating and notes; editedAt: the current text is the owner's own.
          score: variant.score, review: parse<Record<string, unknown> | null>(variant.review, null), editedByOwner: typeof quality.editedAt === 'string',
        };
      }),
    });
  }
  return { settings: { variantsPerItem: settings.variantsPerItem, dailyWriterCalls: settings.dailyWriterCalls, used: await writerCount(owner) }, items: out };
}
