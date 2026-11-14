import { env } from 'cloudflare:workers';
import { z } from 'zod';
import { getChatGPTUser } from '../../chatgpt-auth';
import { fetchAssets, readSettings, requestSync, retryItem, saveGudiniSource, saveSettings, setItemIgnored, setSourceEnabled, SourceError, sourceOverview, syncSource, watchSource } from '@/lib/content/gudini-source';
import { acceptTexts, approveVariant, claimRender, claimWriting, completeRender, editVariant, ensureVariants, failRender, fixedContent, itemFiles, regenerateVariant, rejectVariant, renderWithGudini, VariantError, variantMedia, variantsOverview, writerQueue, writingFailed } from '@/lib/content/variants';
import { campaignsOverview, distributeTick, DistributionError, previewCampaign, saveCampaign, saveEditorial, setCampaignStatus } from '@/lib/content/distribution';
import { engineOverview, heartbeat } from '@/lib/content/engine-status';
import { acceptReview, reviewFailed, reviewJob } from '@/lib/content/editorial';
import { storeAssetHash, unhashedAssets } from '@/lib/content/pictures';
import { cleanupMedia } from '@/lib/content/cleanup';
import { acceptClassification, classificationJob, deleteCategory, listCategories, saveCategory, TopicError } from '@/lib/content/topics';

export const dynamic = 'force-dynamic';
const json = (data: unknown, status = 200) => Response.json(data, { status, headers: { 'Cache-Control': 'no-store' } });
const known = (error: unknown): error is Error & { status: number } => error instanceof SourceError || error instanceof VariantError || error instanceof DistributionError || error instanceof TopicError;
const failure = (error: unknown) => known(error) ? json({ error: error.message }, error.status >= 400 && error.status < 600 ? error.status : 400) : json({ error: error instanceof Error ? `Не удалось выполнить действие: ${error.message}` : 'Не удалось выполнить действие.' }, 500);
const id = z.string().uuid();
const mode = z.enum(['draft', 'manual', 'auto']);
const outputs = z.array(z.object({ slot: z.number().int().min(0).max(20), text: z.string().max(4000).nullish(), caption: z.string().max(6000).nullish(), content: z.unknown().optional() })).max(20);
const inputSchema = z.discriminatedUnion('action', [
  z.object({ action: z.literal('saveSource'), baseUrl: z.string().min(8).max(300), token: z.string().max(400).nullish(), enabled: z.boolean().optional() }),
  z.object({ action: z.literal('sourceEnabled'), enabled: z.boolean() }),
  z.object({ action: z.literal('sync'), force: z.boolean().optional() }),
  z.object({ action: z.literal('requestSync') }),
  z.object({ action: z.literal('watch'), wait: z.number().int().min(0).max(50).optional() }),
  z.object({ action: z.literal('fetchAssets'), limit: z.number().int().min(1).max(30).optional() }),
  z.object({ action: z.literal('retryItem'), itemId: id }),
  z.object({ action: z.literal('ignoreItem'), itemId: id, ignored: z.boolean() }),
  z.object({ action: z.literal('settings'), variantsPerItem: z.number().int().min(1).max(8).optional(), dailyWriterCalls: z.number().int().min(1).max(500).optional(), autopublish: z.boolean().optional(), fetchVideo: z.boolean().optional(), publicBaseUrl: z.string().max(300).nullish(), qualityThreshold: z.number().int().min(50).max(100).optional(), maxAgeHours: z.number().int().min(1).max(720).optional(), retentionDays: z.number().int().min(3).max(365).optional(), reviewEnabled: z.boolean().optional() }),
  z.object({ action: z.literal('saveCategory'), id: id.optional(), name: z.string().max(60), keywords: z.array(z.string().max(60)).max(60) }),
  z.object({ action: z.literal('deleteCategory'), id }),
  z.object({ action: z.literal('classifyJob') }),
  z.object({ action: z.literal('acceptClassification'), ids: z.array(id).min(1).max(40), items: z.array(z.object({ id: z.string().max(80), categories: z.unknown().optional(), urgent: z.unknown().optional() })).max(40).nullable() }),
  z.object({ action: z.literal('acceptReview'), itemId: id, revision: z.string().max(80), reviews: z.array(z.unknown()).max(20) }),
  z.object({ action: z.literal('reviewFailed'), itemId: id, revision: z.string().max(80) }),
  z.object({ action: z.literal('assetHash'), assetId: id, dhash: z.string().max(32) }),
  z.object({ action: z.literal('cleanup') }),
  z.object({ action: z.literal('ensureVariants'), itemId: id }),
  z.object({ action: z.literal('claimWriting'), itemId: id, revision: z.string().max(80) }),
  z.object({ action: z.literal('acceptTexts'), itemId: id, revision: z.string().max(80), variants: outputs }),
  z.object({ action: z.literal('writingFailed'), itemId: id, revision: z.string().max(80), error: z.string().max(1000), bridge: z.boolean().optional() }),
  z.object({ action: z.literal('editVariant'), variantId: id, text: z.string().max(4000).nullish(), caption: z.string().max(6000).nullish() }),
  z.object({ action: z.literal('regenerateVariant'), variantId: id }),
  z.object({ action: z.literal('rejectVariant'), variantId: id }),
  z.object({ action: z.literal('approveVariant'), variantId: id }),
  z.object({ action: z.literal('claimRender') }),
  z.object({ action: z.literal('renderGudini'), jobId: id }),
  z.object({ action: z.literal('fixedContent'), jobId: id, content: z.unknown(), caption: z.string().max(4000).nullish() }),
  z.object({ action: z.literal('renderComplete'), jobId: id, files: z.array(z.object({ index: z.number().int().min(0).max(19), contentType: z.string(), width: z.number().int(), height: z.number().int(), size: z.number().int(), sha256: z.string().max(80), dhash: z.string().max(32) })).max(20), elapsedMs: z.number().int().optional(), cpuMs: z.number().int().optional() }),
  z.object({ action: z.literal('renderFailed'), jobId: id, error: z.string().max(1000), retryable: z.boolean() }),
  z.object({ action: z.literal('distribute') }),
  z.object({ action: z.literal('saveCampaign'), id: id.optional(), name: z.string().max(80), mode, kinds: z.array(z.enum(['news', 'carousel'])).min(1), keywords: z.array(z.string().max(80)).max(30), categories: z.array(z.string().max(60)).max(30).optional(), profileIds: z.array(id).max(200), platforms: z.array(z.enum(['threads', 'instagram'])).min(1), maxAccountsPerItem: z.number().int().min(1).max(50), spreadMinutes: z.number().int().min(0).max(1440), since: z.string().max(40).nullish() }),
  z.object({ action: z.literal('campaignStatus'), id, status: z.enum(['active', 'paused']) }),
  z.object({ action: z.literal('previewCampaign'), id }),
  z.object({ action: z.literal('saveEditorial'), profileId: id, topics: z.array(z.string().max(80)).max(30).optional(), style: z.enum(['neutral', 'short', 'expert', 'casual']).optional(), formats: z.array(z.enum(['text', 'image', 'carousel'])).min(1).optional(), perDay: z.record(z.number().int().min(0).max(20)).optional(), windows: z.array(z.tuple([z.number().min(0).max(24), z.number().min(0).max(24)])).min(1).max(4).optional(), timezoneOffsetMinutes: z.number().int().min(-720).max(840).optional(), minGapMinutes: z.number().int().min(15).max(1440).optional(), mode: mode.optional(), design: z.record(z.unknown()).nullish() }),
  z.object({ action: z.literal('heartbeat'), name: z.enum(['engine', 'media']), ok: z.boolean(), note: z.string().max(5000).nullish(), details: z.unknown().optional() }),
]);

export async function GET(request: Request) {
  const user = await getChatGPTUser();
  if (!user) return json({ error: 'Войдите в аккаунт.' }, 401);
  const owner = user.userId;
  const params = new URL(request.url).searchParams;
  try {
    const file = params.get('file');
    if (file) {
      // Only the owner's own stored files: originals from sources and drawn cards.
      if (!file.startsWith(`${owner}/src/`) && !file.startsWith(`${owner}/variants/`)) return new Response(null, { status: 404 });
      const object = await env.BUCKET!.get(file);
      if (!object) return new Response(null, { status: 404 });
      return new Response(object.body, { headers: { 'Content-Type': object.httpMetadata?.contentType || 'application/octet-stream', 'Cache-Control': 'private, max-age=86400', 'X-Content-Type-Options': 'nosniff' } });
    }
    const view = params.get('view');
    if (view === 'sources') return json(await sourceOverview(owner));
    if (view === 'variants') return json(await variantsOverview(owner, { itemId: id.safeParse(params.get('itemId')).success ? params.get('itemId')! : undefined }));
    if (view === 'campaigns') return json(await campaignsOverview(owner));
    if (view === 'writer') return json(await writerQueue(owner, Number(params.get('limit')) || 1));
    if (view === 'engine') return json({ engine: await engineOverview(owner), settings: await readSettings(owner) });
    if (view === 'variantFiles') { const variantId = id.safeParse(params.get('variantId')); return variantId.success ? json({ files: await variantMedia(owner, variantId.data) }) : json({ error: 'Вариант не найден.' }, 404); }
    if (view === 'itemFiles') { const itemId = id.safeParse(params.get('itemId')); return itemId.success ? json({ files: await itemFiles(owner, itemId.data) }) : json({ error: 'Материал не найден.' }, 404); }
    if (view === 'categories') return json({ categories: await listCategories(owner) });
    if (view === 'review') return json({ job: await reviewJob(owner) });
    if (view === 'unhashed') return json({ assets: await unhashedAssets(owner) });
    return json({ error: 'Неизвестный раздел.' }, 404);
  } catch (error) { return failure(error); }
}

export async function POST(request: Request) {
  const user = await getChatGPTUser();
  if (!user) return json({ error: 'Войдите в аккаунт.' }, 401);
  if (request.headers.get('origin') !== new URL(request.url).origin) return json({ error: 'Недопустимый источник запроса.' }, 403);
  const owner = user.userId;
  try {
    const parsed = inputSchema.safeParse(await request.json().catch(() => null));
    if (!parsed.success) return json({ error: 'Проверьте заполнение полей.' }, 400);
    const input = parsed.data;
    switch (input.action) {
      case 'saveSource': return json(await saveGudiniSource(owner, input));
      case 'sourceEnabled': return json(await setSourceEnabled(owner, input.enabled));
      case 'sync': return json(await syncSource(owner, { force: input.force }));
      case 'requestSync': return json(await requestSync(owner));
      case 'watch': return json(await watchSource(owner, input.wait ?? 25));
      case 'fetchAssets': return json(await fetchAssets(owner, { limit: input.limit }));
      case 'retryItem': return json(await retryItem(owner, input.itemId));
      case 'ignoreItem': return json(await setItemIgnored(owner, input.itemId, input.ignored));
      case 'settings': return json(await saveSettings(owner, input));
      case 'saveCategory': return json(await saveCategory(owner, input));
      case 'deleteCategory': return json(await deleteCategory(owner, input.id));
      case 'classifyJob': return json({ job: await classificationJob(owner) });
      case 'acceptClassification': return json(await acceptClassification(owner, input.items, input.ids));
      case 'acceptReview': return json(await acceptReview(owner, input.itemId, input.revision, input.reviews));
      case 'reviewFailed': return json(await reviewFailed(owner, input.itemId, input.revision));
      case 'assetHash': return json(await storeAssetHash(owner, input.assetId, input.dhash));
      case 'cleanup': return json(await cleanupMedia(owner));
      case 'ensureVariants': return json(await ensureVariants(owner, input.itemId));
      case 'claimWriting': return json(await claimWriting(owner, input.itemId, input.revision));
      case 'acceptTexts': return json(await acceptTexts(owner, input.itemId, input.revision, input.variants));
      case 'writingFailed': return json(await writingFailed(owner, input.itemId, input.revision, input.error, Boolean(input.bridge)));
      case 'editVariant': return json(await editVariant(owner, input.variantId, input));
      case 'regenerateVariant': return json(await regenerateVariant(owner, input.variantId));
      case 'rejectVariant': return json(await rejectVariant(owner, input.variantId));
      case 'approveVariant': return json(await approveVariant(owner, input.variantId));
      case 'claimRender': return json({ job: await claimRender(owner) });
      case 'renderGudini': return json(await renderWithGudini(owner, input.jobId));
      case 'fixedContent': return json(await fixedContent(owner, input.jobId, input));
      case 'renderComplete': return json(await completeRender(owner, input.jobId, input.files, input));
      case 'renderFailed': return json(await failRender(owner, input.jobId, input.error, input.retryable));
      case 'distribute': return json(await distributeTick(owner));
      case 'saveCampaign': return json(await saveCampaign(owner, input));
      case 'campaignStatus': return json(await setCampaignStatus(owner, input.id, input.status));
      case 'previewCampaign': return json(await previewCampaign(owner, input.id));
      case 'saveEditorial': return json(await saveEditorial(owner, input.profileId, input as Parameters<typeof saveEditorial>[2]));
      case 'heartbeat': await heartbeat(owner, input.name, input.ok, input.note ?? null, input.details ?? null); return json({ ok: true });
    }
  } catch (error) { return failure(error); }
}
