/**
 * Distribution rules without any storage: topic match, choice of version, the next free time of an account,
 * and which mode wins. Imported by distribution.ts and tested directly (no imports on purpose).
 */
export type Mode = 'draft' | 'manual' | 'auto';
const MODE_ORDER: Mode[] = ['draft', 'manual', 'auto'];
/** The stricter of the campaign's and the profile's modes wins. */
export const effectiveMode = (a: Mode, b: Mode): Mode => MODE_ORDER[Math.min(MODE_ORDER.indexOf(a), MODE_ORDER.indexOf(b))] || 'draft';

/** The profile's style as the interface names it. */
export const PROFILE_STYLE_NAMES: Record<string, string> = { neutral: 'Нейтрально', short: 'Коротко', expert: 'Экспертно', casual: 'Просто и живо' };
/** Which version angles a profile style takes first. */
export const STYLE_ORDER: Record<string, string[]> = {
  neutral: ['explainer', 'what_happened', 'brief', 'why_matters', 'qa', 'consequences', 'original'],
  short: ['brief', 'what_happened', 'qa', 'why_matters', 'original', 'explainer', 'consequences'],
  expert: ['explainer', 'consequences', 'why_matters', 'what_happened', 'original', 'qa', 'brief'],
  casual: ['qa', 'brief', 'why_matters', 'what_happened', 'original', 'explainer', 'consequences'],
};
/**
 * Instagram gets Gudini's carousels (4:5); a news cover is 9:16 and fits Threads only, like plain text.
 */
export const PLATFORM_FORMATS: Record<string, string[]> = { threads: ['text', 'image', 'carousel'], instagram: ['carousel'] };

export type Editorial = { topics: string[]; style: string; formats: string[]; perDay: Record<string, number>; windows: [number, number][]; timezoneOffsetMinutes: number; minGapMinutes: number; mode: Mode };
export const DEFAULT_EDITORIAL: Editorial = { topics: [], style: 'neutral', formats: ['text', 'image', 'carousel'], perDay: { threads: 2, instagram: 1 }, windows: [[9, 22]], timezoneOffsetMinutes: 300, minGapMinutes: 90, mode: 'manual' };

const normalize = (text: string) => text.toLowerCase().replace(/ё/g, 'е').replace(/[  ]/g, ' ');
type Topical = { title: string; topic?: string | null; category?: string | null; text: string; caption?: string | null; cards: { title: string }[] };
/** How well a material fits a profile's topics: the number of topics found in it. 0 = does not fit; no topics = takes everything. */
export function topicScore(topics: string[], item: Topical) {
  if (!topics.length) return 1;
  const haystack = normalize([item.title, item.topic, item.category, item.caption, item.text, ...item.cards.map(card => card.title)].filter(Boolean).join(' '));
  let score = 0;
  for (const topic of topics) {
    const words = normalize(topic).split(/[\s,]+/).filter(word => word.length >= 2);
    // Every word of the topic must appear, by its beginning, so Russian endings do not matter.
    if (words.length && words.every(word => haystack.includes(word.length > 5 ? word.slice(0, word.length - 2) : word))) score++;
  }
  return score;
}

/** The version for an account: a format the platform takes and the profile wants, then the profile's preferred style. */
/**
 * The version for an account. Only versions the editor passed are given out (a preview may look at planned ones):
 * a format the platform takes and the profile wants, then the editor's best rating, then the profile's style.
 */
export function pickVariant<T extends { id: string; style: string; format: string; status: string; profileId: string | null; score?: number | null }>(variants: T[], platform: string, editorial: Pick<Editorial, 'style' | 'formats'>, kind: string, { passedOnly = true } = {}): T | null {
  const allowed = PLATFORM_FORMATS[platform] || [];
  const usable = passedOnly ? ['ready', 'written', 'rendering'] : ['planned', 'writing', 'reviewing', 'written', 'rendering', 'ready'];
  const free = variants.filter(variant => !variant.profileId && usable.includes(variant.status) && allowed.includes(variant.format) && editorial.formats.includes(variant.format));
  const styles = STYLE_ORDER[editorial.style] || STYLE_ORDER.neutral;
  // Threads reads news best as text, Instagram as cards: the format comes before the rating and the style.
  const formatRank = (format: string) => platform === 'threads' && kind === 'news' ? ['text', 'image', 'carousel'].indexOf(format) : platform === 'instagram' ? ['carousel'].indexOf(format) : ['carousel', 'text', 'image'].indexOf(format);
  return [...free].sort((a, b) => formatRank(a.format) - formatRank(b.format) || (b.score ?? 0) - (a.score ?? 0) || styles.indexOf(a.style) - styles.indexOf(b.style))[0] || null;
}

/**
 * How well a material fits a profile: its topics are names of the owner's categories (the classifier's result
 * decides) or plain words (searched in the text). No topics = takes everything; 0 = does not fit.
 */
export function fitScore(topics: string[], known: Set<string>, itemCategories: string[], item: Topical) {
  if (!topics.length) return 1;
  const categories = topics.filter(topic => known.has(topic));
  const words = topics.filter(topic => !known.has(topic));
  return categories.filter(category => itemCategories.includes(category)).length + (words.length ? topicScore(words, item) : 0);
}

/**
 * The next free moment of an account: inside the profile's hours (its own UTC offset), under its daily number
 * for the platform, at least the minimum gap from its other posts and at least `spreadMinutes` from other
 * accounts that get the same material. 15-minute steps, up to two weeks ahead; null when nothing fits.
 */
export function nextSlot(input: { nowMs: number; editorial: Pick<Editorial, 'perDay' | 'windows' | 'timezoneOffsetMinutes' | 'minGapMinutes'>; platform: string; taken: number[]; sameItem: number[]; spreadMinutes: number; jitterMinutes?: number }) {
  const { editorial, platform } = input;
  const offset = editorial.timezoneOffsetMinutes * 60_000;
  const perDay = editorial.perDay[platform] ?? 1;
  if (perDay <= 0) return null;
  const gap = editorial.minGapMinutes * 60_000;
  const spread = input.spreadMinutes * 60_000;
  const STEP = 15 * 60_000;
  const localDay = (ms: number) => Math.floor((ms + offset) / 86_400_000);
  const localHour = (ms: number) => (((ms + offset) % 86_400_000) + 86_400_000) % 86_400_000 / 3_600_000;
  let at = Math.ceil((input.nowMs + 15 * 60_000) / STEP) * STEP;
  for (let guard = 0; guard < 14 * 96; guard++, at += STEP) {
    const hour = localHour(at);
    if (!editorial.windows.some(([from, to]) => hour >= from && hour < to)) continue;
    if (input.taken.filter(time => localDay(time) === localDay(at)).length >= perDay) continue;
    if (input.taken.some(time => Math.abs(time - at) < gap)) continue;
    if (input.sameItem.some(time => Math.abs(time - at) < spread)) continue;
    return at + Math.floor((input.jitterMinutes ?? 0) * 60_000);
  }
  return null;
}
