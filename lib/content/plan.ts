/**
 * ContentVariantEngine, the deterministic half: which versions a material gets. Pictures are always Gudini's:
 *   original — Gudini's finished cards exactly as they are (one account gets them)
 *   gudini   — the same carousel redrawn by Gudini's own templates (gudini-export /v1/render) with the version's
 *              wording, another colour of Gudini's palette and the account's handle
 *   cover    — a news video's Gudini cover with the version's text (Threads: the cover is 9:16)
 *   none     — text only (Threads)
 * FERMA never draws its own cards. Pure functions: tested directly.
 */
import type { ExportItem } from './contract';

export type Style = 'brief' | 'explainer' | 'qa' | 'what_happened' | 'why_matters' | 'consequences' | 'original';
export type VariantFormat = 'text' | 'image' | 'carousel';
export type Layout = 'original' | 'gudini' | 'cover' | 'none';

export const STYLE_NAMES: Record<Style, string> = {
  brief: 'Коротко', explainer: 'Разбор', qa: 'Вопрос и ответ', what_happened: 'Что произошло',
  why_matters: 'Почему это важно', consequences: 'Последствия', original: 'Как в Gudini',
};
export const LAYOUT_NAMES: Record<Layout, string> = { original: 'карточки Gudini', gudini: 'перерисовка Gudini', cover: 'обложка Gudini', none: 'только текст' };
/** What the writer is asked for in each style. Facts may only come from the material. */
export const STYLE_BRIEFS: Record<Exclude<Style, 'original'>, string> = {
  brief: 'Коротко: два-три предложения, только главное, без вступлений.',
  explainer: 'Разбор: контекст и детали по порядку, простыми словами, без оценок.',
  qa: 'Вопрос и ответ: начни с вопроса, который задал бы читатель, и ответь фактами из материала.',
  what_happened: 'Что произошло: факты по порядку событий, кто, что, когда.',
  why_matters: 'Почему это важно: что это значит для читателя, только то, что прямо следует из материала.',
  consequences: 'Последствия: что изменится или уже изменилось, только если это сказано в материале; не гадай о будущем.',
};

export type PlannedVariant = { slot: number; style: Style; format: VariantFormat; layout: Layout };
type Entry = Omit<PlannedVariant, 'slot'>;

const NEWS_POOL: Entry[] = [
  { style: 'brief', format: 'text', layout: 'none' },
  { style: 'what_happened', format: 'image', layout: 'cover' },
  { style: 'qa', format: 'text', layout: 'none' },
  { style: 'why_matters', format: 'text', layout: 'none' },
  { style: 'consequences', format: 'text', layout: 'none' },
  { style: 'explainer', format: 'text', layout: 'none' },
];
/** Investigation carousels: Gudini redraws each version with its own wording and colour. */
const EDITABLE_POOL: Entry[] = [
  { style: 'original', format: 'carousel', layout: 'original' },
  { style: 'explainer', format: 'carousel', layout: 'gudini' },
  { style: 'qa', format: 'carousel', layout: 'gudini' },
  { style: 'why_matters', format: 'carousel', layout: 'gudini' },
  { style: 'brief', format: 'text', layout: 'none' },
  { style: 'what_happened', format: 'carousel', layout: 'gudini' },
  { style: 'consequences', format: 'carousel', layout: 'gudini' },
  { style: 'qa', format: 'text', layout: 'none' },
];
/** Other carousels (other Gudini styles, video carousels, memes): Gudini's cards go to one account, texts to others. */
const FIXED_POOL: Entry[] = [
  { style: 'original', format: 'carousel', layout: 'original' },
  { style: 'brief', format: 'text', layout: 'none' },
  { style: 'qa', format: 'text', layout: 'none' },
  { style: 'what_happened', format: 'text', layout: 'none' },
  { style: 'why_matters', format: 'text', layout: 'none' },
];

export const MAX_VARIANTS = 8;
const pictures = (item: Pick<ExportItem, 'cards' | 'assets'>) => item.cards.filter(card => card.asset && item.assets.some(asset => asset.id === card.asset && asset.contentType.startsWith('image/'))).length;
/**
 * The set of versions for a material. One short material does not give dozens of really different versions,
 * so the count is capped by the pool of different angles (8).
 */
export function planVariants(item: Pick<ExportItem, 'kind' | 'cards' | 'assets' | 'editable'>, count: number): PlannedVariant[] {
  const pool = item.kind === 'news' ? NEWS_POOL : item.editable ? EDITABLE_POOL : FIXED_POOL;
  const usable = pool.filter(entry => {
    if (entry.layout === 'original') return pictures(item) >= 2;
    if (entry.layout === 'cover') return item.assets.some(asset => asset.role === 'cover' && asset.contentType.startsWith('image/'));
    return true;
  });
  return usable.slice(0, Math.max(1, Math.min(MAX_VARIANTS, count))).map((entry, slot) => ({ ...entry, slot }));
}

/** Gudini's own finished cards, unchanged, in their order. */
export function originalCards(item: Pick<ExportItem, 'cards' | 'assets'>, stored: Set<string>) {
  return item.cards.map(card => card.asset).filter((id): id is string => Boolean(id) && stored.has(id!) && item.assets.some(asset => asset.id === id && asset.contentType.startsWith('image/'))).slice(0, 20);
}
/** The news video's cover made by Gudini. */
export const coverAsset = (item: Pick<ExportItem, 'assets'>, stored: Set<string>) => item.assets.find(asset => asset.role === 'cover' && stored.has(asset.id))?.id ?? null;

/**
 * The colour of Gudini's palette for an account: the one chosen in the profile, otherwise one by the profile's place
 * in the list. A redrawn version never keeps the original carousel's colour, so it does not look like a copy.
 */
export function paletteFor(chosen: number | null | undefined, profileIndex: number, original: number, size: number) {
  const base = Number.isInteger(chosen) && chosen! >= 0 ? chosen! % size : (profileIndex + 1) % size;
  return base === original % size ? (base + 1) % size : base;
}

/** Visible length as Gudini counts it: **bold** marks are not letters. */
export const visible = (text: string) => [...text.replace(/\*\*/g, '')].length;
