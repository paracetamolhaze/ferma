/**
 * The numbers of the analytics and the rules of its recommendations, without any storage (tested directly, so no
 * imports on purpose). Only metrics the networks returned are used: a post without them is «нет данных», not zero.
 */
const INTERACTIONS = ['likes', 'replies', 'reposts', 'quotes', 'shares', 'comments', 'saved'];
/** A rule speaks only with at least this many measured posts on each side, and a difference of at least 30%. */
export const MIN_POSTS = 5;
export const MIN_GAIN = 1.3;

type Stats = Record<string, number>;
/** Views and reactions of one post; null where the network gave nothing. */
export function metricsOf(stats: Stats | null) {
  if (!stats) return { views: null as number | null, interactions: null as number | null, rate: null as number | null };
  const views = typeof stats.views === 'number' ? stats.views : null;
  const parts = INTERACTIONS.filter(key => typeof stats[key] === 'number');
  const interactions = typeof stats.total_interactions === 'number' ? stats.total_interactions : parts.length ? parts.reduce((sum, key) => sum + stats[key], 0) : null;
  return { views, interactions, rate: views && interactions !== null ? interactions / views : null };
}
export const median = (values: number[]) => {
  if (!values.length) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[middle] : (sorted[middle - 1] + sorted[middle]) / 2;
};

export type Post = { id: string; platform: string; profileId: string; profile: string; username: string | null; style: string | null; format: string; layout: string | null; hour: number; categories: string[]; publishedAt: string } & ReturnType<typeof metricsOf>;
export function summarize(posts: Post[]) {
  const measured = posts.filter(post => post.views !== null);
  const rates = posts.map(post => post.rate).filter((rate): rate is number => rate !== null);
  return { posts: posts.length, measured: measured.length, views: measured.reduce((sum, post) => sum + (post.views || 0), 0), medianViews: median(measured.map(post => post.views!)), medianRate: median(rates) };
}
export function groupBy(posts: Post[], key: (post: Post) => string[]) {
  const groups = new Map<string, Post[]>();
  for (const post of posts) for (const name of key(post)) groups.set(name, [...(groups.get(name) || []), post]);
  return [...groups.entries()].map(([name, list]) => ({ name, ...summarize(list) })).sort((a, b) => b.posts - a.posts);
}

export type Proposal = { profileId: string; kind: string; title: string; reason: string; basis: Record<string, unknown>; change: Record<string, unknown> };
const percent = (value: number | null) => value === null ? '—' : `${(value * 100).toFixed(1).replace('.', ',')}%`;
const FORMAT_NAMES: Record<string, string> = { text: 'текст', image: 'картинка', carousel: 'карусель' };
/**
 * Two rules. Versions: the angle (explainer, Q&A…) with clearly more reactions than the angle the profile now
 * prefers; the change is the profile style that puts that angle first. Threads: a format with clearly fewer
 * reactions than another one; the change switches it off. Each proposal carries its numbers.
 * styleOrder: the profile styles and the angles each one prefers, in order (rules.ts STYLE_ORDER).
 */
export function proposalsFor(profileId: string, posts: Post[], editorial: { style: string; formats: string[] }, { styleNames = {}, styleOrder = {}, profileStyleNames = {} }: { styleNames?: Record<string, string>; styleOrder?: Record<string, string[]>; profileStyleNames?: Record<string, string> } = {}): Proposal[] {
  const result: Proposal[] = [];
  const name = (style: string) => styleNames[style] || style;
  const rated = posts.filter(post => post.rate !== null);
  const angles = groupBy(rated, post => [post.style || '']).filter(group => group.name && group.measured >= MIN_POSTS && group.medianRate !== null);
  const preferred = styleOrder[editorial.style]?.[0];
  const current = angles.find(group => group.name === preferred);
  const best = [...angles].sort((a, b) => b.medianRate! - a.medianRate!)[0];
  const target = best && Object.keys(styleOrder).find(style => styleOrder[style][0] === best.name);
  if (current && best && target && best.name !== current.name && best.medianRate! >= current.medianRate! * MIN_GAIN) {
    result.push({ profileId, kind: 'style', title: `Подача «${name(best.name)}» собирает больше реакций`,
      reason: `Медианная доля реакций: «${name(best.name)}» ${percent(best.medianRate)} (${best.measured} постов), «${name(current.name)}», которую профиль берёт первой сейчас, ${percent(current.medianRate)} (${current.measured} постов). Правило: разница от 30% при 5 и более постах с каждой стороны. Изменение: стиль профиля «${profileStyleNames[target] || target}», он берёт «${name(best.name)}» первой.`,
      basis: { best: { angle: best.name, posts: best.measured, medianRate: best.medianRate }, current: { angle: current.name, posts: current.measured, medianRate: current.medianRate } }, change: { style: target } });
  }
  const formats = groupBy(rated.filter(post => post.platform === 'threads'), post => [post.format]).filter(group => group.measured >= MIN_POSTS && group.medianRate !== null && editorial.formats.includes(group.name));
  if (formats.length >= 2 && editorial.formats.length > 1) {
    const sorted = [...formats].sort((a, b) => b.medianRate! - a.medianRate!);
    const top = sorted[0], worst = sorted[sorted.length - 1];
    if (top.medianRate! >= worst.medianRate! * MIN_GAIN) {
      const label = (format: string) => FORMAT_NAMES[format] || format;
      result.push({ profileId, kind: `format:${worst.name}`, title: `В Threads формат «${label(worst.name)}» собирает меньше реакций`,
        reason: `Медианная доля реакций в Threads: «${label(top.name)}» ${percent(top.medianRate)} (${top.measured} постов), «${label(worst.name)}» ${percent(worst.medianRate)} (${worst.measured} постов). Правило: разница от 30% при 5 и более постах с каждой стороны.`,
        basis: { top: { format: top.name, posts: top.measured, medianRate: top.medianRate }, worst: { format: worst.name, posts: worst.measured, medianRate: worst.medianRate } }, change: { formats: editorial.formats.filter(format => format !== worst.name) } });
    }
  }
  return result;
}
