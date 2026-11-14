/**
 * EditorialQualityEngine: an AI editor and fact checker reads every version before it can be used.
 * Every factual claim is matched against the material and Gudini's research (facts with exact quotes and links):
 * supported, unsupported (not found in the sources) or contradicted. Clarity, grammar, inner contradictions,
 * headline quality and repetition are judged too. The rating 0-100 helps to choose the best versions; it is not a
 * proof of accuracy: any unsupported claim sends the version to the owner, a contradicted one back to the writer.
 */
import { and, asc, eq, sql } from 'drizzle-orm';
import { getDb } from '@/db';
import { contentVariants, sourceItems } from '@/db/schema';
import { editableTexts, storyText, type EditableContent, type ExportItem } from './contract';
import { readSettings } from './gudini-source';
import { STYLE_NAMES, type Style } from './plan';
import { queueRender } from './variants';

const now = () => new Date().toISOString();
const MAX_REWRITES = 3;
const parse = <T>(value: string | null | undefined, fallback: T): T => { try { return value ? JSON.parse(value) as T : fallback; } catch { return fallback; } };

export type Claim = { text: string; status: 'supported' | 'unsupported' | 'contradicted'; refs: string[] };
export type Review = { slot: number; score: number; claims: Claim[]; issues: string[]; summary: string };
export type Verdict = { status: 'ready' | 'written' | 'review' | 'planned'; score: number; unverified: string[]; contradicted: string[]; reasons: string[] };

/**
 * The editor's verdict for one version. Pure: the rules are tested directly.
 *   contradicted claim → rewrite (or the owner after the last attempt), rating at most 40
 *   unsupported claim  → the owner checks it, rating at most 69
 *   rating below 60    → rewrite; below the threshold → the owner; otherwise the version may be used
 */
export function verdictOf(review: Review | undefined, input: { attempts: number; threshold: number; redraw: boolean }): Verdict {
  if (!review) return { status: 'review', score: 0, unverified: [], contradicted: [], reasons: ['редактор не прислал оценку этой версии'] };
  const unverified = review.claims.filter(claim => claim.status === 'unsupported').map(claim => claim.text);
  const contradicted = review.claims.filter(claim => claim.status === 'contradicted').map(claim => claim.text);
  let score = Math.max(0, Math.min(100, Math.round(Number(review.score) || 0)));
  if (contradicted.length) score = Math.min(score, 40);
  else if (unverified.length) score = Math.min(score, 69);
  const reasons = [...(review.summary ? [review.summary] : []), ...contradicted.map(text => `противоречит источникам: «${text}»`), ...unverified.map(text => `не подтверждено источниками: «${text}»`), ...review.issues];
  const rewrite = contradicted.length > 0 || score < 60;
  if (rewrite) return { status: input.attempts >= MAX_REWRITES ? 'review' : 'planned', score, unverified, contradicted, reasons };
  if (unverified.length || score < input.threshold) return { status: 'review', score, unverified, contradicted, reasons };
  return { status: input.redraw ? 'written' : 'ready', score, unverified, contradicted, reasons };
}

const material = (payload: string) => JSON.parse(payload) as ExportItem;
function versionText(variant: typeof contentVariants.$inferSelect, item: ExportItem) {
  const parts = [`Threads: ${variant.text || '(нет)'}`];
  if (variant.caption) parts.push(`Instagram: ${variant.caption}`);
  if (variant.layout === 'gudini' && variant.cards) parts.push(`Карточки: ${editableTexts(parse<EditableContent>(variant.cards, item.editable!.content)).join(' | ')}`);
  if (variant.layout === 'original') parts.push('Карточки: исходные карточки Gudini без изменений.');
  if (variant.layout === 'cover') parts.push('Картинка: обложка ролика Gudini без изменений.');
  return parts.join('\n');
}

/** The next material whose versions wait for the editor, as one task for the GPT bridge. */
export async function reviewJob(owner: string) {
  const db = getDb();
  const [next] = await db.select({ itemId: contentVariants.itemId }).from(contentVariants).where(and(eq(contentVariants.owner, owner), eq(contentVariants.status, 'reviewing'))).groupBy(contentVariants.itemId).orderBy(asc(sql`min(${contentVariants.updatedAt})`)).limit(1);
  if (!next) return null;
  const [row] = await db.select().from(sourceItems).where(and(eq(sourceItems.id, next.itemId), eq(sourceItems.owner, owner)));
  if (!row) return null;
  const item = material(row.payload);
  const variants = await db.select().from(contentVariants).where(and(eq(contentVariants.itemId, row.id), eq(contentVariants.revision, row.revision), eq(contentVariants.status, 'reviewing'))).orderBy(asc(contentVariants.slot));
  if (!variants.length) return null;
  const facts = item.facts.slice(0, 40).map((fact, index) => `F${index + 1}. ${fact.claim}${fact.quote ? ` | цитата: «${fact.quote}»` : ''}${fact.url ? ` | ${fact.url}` : ''}`).join('\n');
  const sources = item.sources.slice(0, 20).map((source, index) => `S${index + 1}. ${[source.publisher, source.title, source.date, source.note].filter(Boolean).join(' · ')}${source.url ? ` | ${source.url}` : ''}`).join('\n');
  const system = `Ты выпускающий редактор и фактчекер новостных аккаунтов. Проверяешь версии публикаций перед выходом, строго и честно.
Для каждой версии:
1. Выпиши каждое фактическое утверждение (числа, даты, кто что сделал или сказал, причины и следствия) и отметь: supported - есть в материале, фактах F или источниках S (укажи ссылки); unsupported - в источниках этого нет; contradicted - противоречит источникам.
2. Отметь проблемы: непонятно, ошибки в словах и грамматике, противоречия внутри текста, слабый или вводящий в заблуждение заголовок, повторы, кликбейт, слишком плотные карточки.
3. Поставь оценку 0-100: 90+ ясно, точно, все утверждения подтверждены, интересно; минус 25 за каждое неподтверждённое, минус 50 за противоречие, минус 5 за каждую ошибку, минус 10 за слабый заголовок или мутный текст.
Не придумывай подтверждений: если не нашёл - unsupported. Отвечай строго одним JSON-объектом без пояснений.`;
  const user = `МАТЕРИАЛ
Заголовок: ${item.title}
${item.summary ? `Кратко: ${item.summary}\n` : ''}Текст: ${storyText(item).slice(0, 6000)}
${item.cards.length ? `Карточки Gudini: ${item.cards.map(card => [card.title, card.body].filter(Boolean).join(' - ')).join(' | ').slice(0, 4000)}\n` : ''}${facts ? `\nФАКТЫ ИССЛЕДОВАНИЯ GUDINI:\n${facts.slice(0, 7000)}\n` : ''}${sources ? `\nИСТОЧНИКИ:\n${sources.slice(0, 4000)}\n` : ''}
ВЕРСИИ:
${variants.map(variant => `--- slot ${variant.slot} (${STYLE_NAMES[variant.style as Style] || variant.style})\n${versionText(variant, item)}`).join('\n')}

Верни JSON: {"reviews": [{"slot": номер, "score": 0-100, "claims": [{"text": "...", "status": "supported", "refs": ["F1"]}], "issues": ["..."], "summary": "одна фраза: почему такая оценка"}]}`;
  return { itemId: row.id, revision: row.revision, slots: variants.map(variant => variant.slot), system, user };
}

const asReview = (raw: unknown): Review | null => {
  if (!raw || typeof raw !== 'object') return null;
  const value = raw as Record<string, unknown>;
  if (!Number.isInteger(value.slot)) return null;
  const claims = Array.isArray(value.claims) ? value.claims.map(claim => claim as Record<string, unknown>).filter(claim => typeof claim?.text === 'string').map(claim => ({ text: String(claim.text).slice(0, 300), status: (['supported', 'unsupported', 'contradicted'].includes(String(claim.status)) ? claim.status : 'unsupported') as Claim['status'], refs: Array.isArray(claim.refs) ? claim.refs.map(String).slice(0, 6) : [] })) : [];
  return { slot: value.slot as number, score: Number(value.score) || 0, claims: claims.slice(0, 40), issues: Array.isArray(value.issues) ? value.issues.map(String).map(issue => issue.slice(0, 200)).slice(0, 10) : [], summary: typeof value.summary === 'string' ? value.summary.slice(0, 300) : '' };
};
/** Stores the editor's ratings and moves every reviewed version on. */
export async function acceptReview(owner: string, itemId: string, revision: string, raw: unknown[]) {
  const db = getDb();
  const settings = await readSettings(owner);
  const reviews = raw.map(asReview).filter((review): review is Review => Boolean(review));
  const variants = await db.select().from(contentVariants).where(and(eq(contentVariants.owner, owner), eq(contentVariants.itemId, itemId), eq(contentVariants.revision, revision), eq(contentVariants.status, 'reviewing')));
  const results = [];
  for (const variant of variants) {
    const review = reviews.find(entry => entry.slot === variant.slot);
    // A Gudini redraw that already has its cards (the owner changed only the post text) is not drawn again.
    const verdict = verdictOf(review, { attempts: variant.attempts, threshold: settings.qualityThreshold, redraw: variant.layout === 'gudini' && !variant.assetsCount });
    // The owner's own words are never handed back to the writer: the owner decides about them.
    if (verdict.status === 'planned' && parse<{ editedAt?: string }>(variant.quality, {}).editedAt) verdict.status = 'review';
    const stored = { score: verdict.score, claims: review?.claims ?? [], issues: review?.issues ?? [], summary: review?.summary ?? '', unverified: verdict.unverified, contradicted: verdict.contradicted, reviewedAt: now() };
    await db.update(contentVariants).set({ status: verdict.status, score: verdict.score, review: JSON.stringify(stored), error: verdict.status === 'ready' || verdict.status === 'written' ? null : verdict.reasons.slice(0, 4).join('; ').slice(0, 800), updatedAt: now() }).where(eq(contentVariants.id, variant.id));
    if (verdict.status === 'written' && variant.profileId) await queueRender(owner, variant.id);
    results.push({ slot: variant.slot, status: verdict.status, score: verdict.score });
  }
  return { results };
}
/** The editor could not answer: the versions keep waiting and are reviewed later. */
export async function reviewFailed(owner: string, itemId: string, revision: string) {
  await getDb().update(contentVariants).set({ updatedAt: now() }).where(and(eq(contentVariants.owner, owner), eq(contentVariants.itemId, itemId), eq(contentVariants.revision, revision), eq(contentVariants.status, 'reviewing')));
  return { ok: true };
}
