/**
 * gudini.export/v1 as FERMA reads it. Mirror of gudini/export/contract.ts: every answer from Gudini is validated
 * here before anything is stored, so a changed or broken export stops the import instead of filling the base.
 */
import { z } from 'zod';

export const CONTRACT = 'gudini.export/v1';
export const KINDS = ['news', 'carousel', 'video_carousel', 'video'] as const;
export const ASSET_ROLES = ['video', 'cover', 'frame', 'render', 'video_slide', 'cover_art', 'illustration', 'screenshot'] as const;

const iso = z.string().refine(value => Number.isFinite(Date.parse(value)), 'date');
export const exportAsset = z.object({
  id: z.string().min(1).max(300).refine(value => !value.startsWith('/') && !value.split('/').includes('..'), 'relative path'),
  role: z.enum(ASSET_ROLES), card: z.number().int().min(0).nullable(), contentType: z.string().min(3).max(80),
  size: z.number().int().min(0), modifiedAt: iso, url: z.string().startsWith('/v1/assets/'),
});
export const exportCard = z.object({
  index: z.number().int().min(0), role: z.enum(['cover', 'content', 'final']), kicker: z.string().max(400), title: z.string().max(1000),
  body: z.string().max(5000), bullets: z.array(z.string().max(600)).max(30), asset: z.string().nullable(), image: z.string().nullable(),
});
export const exportSource = z.object({ url: z.string().max(2000), title: z.string().nullable(), publisher: z.string().nullable(), date: z.string().nullable(), note: z.string().nullable() });
export const exportFact = z.object({ claim: z.string().max(3000), quote: z.string().nullable(), url: z.string().nullable() });
const pair = z.tuple([z.string().max(60), z.string().max(60)]);
/** Investigation carousels: the texts a version may change and Gudini's limits (gudini/export/render.ts). */
export const exportEditable = z.object({
  style: z.literal('investigation'), palette: z.number().int().min(0),
  palettes: z.array(z.object({ index: z.number().int(), name: z.string(), accent: z.string(), cover: z.string() })).max(20),
  limits: z.record(z.number()),
  content: z.object({
    cover: z.object({ pill: z.string().max(60), title: z.array(z.string().max(60)).max(3), accentLine: z.string().max(120), hook: z.string().max(200) }),
    steps: z.array(z.object({ label: z.string().max(120), title: z.string().max(120), body: z.string().max(800), pills: z.tuple([pair, pair]), next: z.string().max(80) })).max(12),
    final: z.object({ black: z.array(z.string().max(60)).max(3), accent: z.array(z.string().max(60)).max(3), cards: z.array(z.tuple([z.string().max(30), z.string().max(60), z.string().max(80)])).max(3), body: z.string().max(600) }),
    caption: z.string().max(3000),
  }),
});
export type EditableContent = z.infer<typeof exportEditable>['content'];

export const exportItem = z.object({
  contract: z.literal(CONTRACT), id: z.string().regex(/^(news|carousel|video):[a-z0-9-]{6,60}$/), kind: z.enum(KINDS), nativeId: z.string().min(1),
  revision: z.string().min(8).max(80), status: z.enum(['ready', 'published', 'scheduled']), language: z.string().min(2).max(10),
  title: z.string().min(1).max(1000), summary: z.string().nullable(), text: z.string().max(50_000), caption: z.string().nullable(), hashtags: z.array(z.string()).max(60),
  category: z.string().nullable(), topic: z.string().nullable(), topicKey: z.string().nullable(), style: z.string().nullable(),
  cards: z.array(exportCard).max(40), sources: z.array(exportSource).max(80), facts: z.array(exportFact).max(200), assets: z.array(exportAsset).max(120),
  montage: z.unknown().nullable(), editable: exportEditable.optional(), meta: z.record(z.union([z.string(), z.number(), z.boolean(), z.null()])),
  createdAt: iso, readyAt: iso, updatedAt: iso,
});
export const exportPage = z.object({ contract: z.literal(CONTRACT), items: z.array(z.unknown()), cursor: z.string().max(500), more: z.boolean(), serverTime: iso });
export const exportChanges = z.object({ contract: z.literal(CONTRACT), changed: z.boolean(), cursor: z.string().max(500), serverTime: iso });

export type ExportItem = z.infer<typeof exportItem>;
export type ExportAsset = z.infer<typeof exportAsset>;
export type ExportCard = z.infer<typeof exportCard>;

/** Everything the facts of a variant may come from: texts, card texts, source notes and research quotes. */
export function factBasis(item: ExportItem) {
  const parts = [item.title, item.summary || '', item.text, item.caption || '',
    ...item.cards.flatMap(card => [card.kicker, card.title, card.body, ...card.bullets]),
    ...item.sources.flatMap(source => [source.title || '', source.publisher || '', source.date || '', source.note || '']),
    ...item.facts.flatMap(fact => [fact.claim, fact.quote || '']),
    ...(item.editable ? editableTexts(item.editable.content) : [])];
  const promo = typeof item.meta.promoLine === 'string' ? item.meta.promoLine : null;
  return { text: parts.filter(Boolean).join('\n'), links: item.sources.map(source => source.url).filter(Boolean), promo };
}
/** The main story text without the author's own promotional line (it belongs to Gudini's channel only). */
export function storyText(item: ExportItem) {
  const promo = typeof item.meta.promoLine === 'string' ? item.meta.promoLine.trim() : '';
  return promo ? item.text.replace(promo, '').trim() : item.text;
}

/** Every visible text of an investigation carousel, for checks and for comparing versions. */
export function editableTexts(content: EditableContent) {
  return [...content.cover.title, content.cover.accentLine, content.cover.hook,
    ...content.steps.flatMap(step => [step.label, step.title, step.body.replace(/\*\*/g, ''), ...step.pills.flat(), step.next]),
    ...content.final.black, ...content.final.accent, ...content.final.cards.flat(), content.final.body, content.caption].filter(Boolean);
}
