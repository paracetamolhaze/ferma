import test from 'node:test';
import assert from 'node:assert/strict';
import { build } from 'esbuild';
import { Miniflare } from 'miniflare';
import { createHash } from 'node:crypto';
import { readFile, readdir } from 'node:fs/promises';
import path from 'node:path';

const root = path.resolve(import.meta.dirname, '..');
const OWNER = 'owner';
const P = '11111111-1111-4111-8111-111111111111';
const NOW = Date.parse('2026-11-14T03:00:00Z');

const asset = (itemId, id, role, card, size) => ({ id, role, card, contentType: id.endsWith('.png') ? 'image/png' : id.endsWith('.mp4') ? 'video/mp4' : 'image/jpeg', size, modifiedAt: '2026-11-13T10:00:00.000Z', url: `/v1/assets/${encodeURIComponent(itemId)}/${encodeURIComponent(id)}` });
const card = (index, role, title, body, assetId = null, image = null) => ({ index, role, kicker: '', title, body, bullets: [], asset: assetId, image });
const NEWS_TEXT = 'Инженер Coinbase подключил мозг мухи к графику биткоина и дал ему 100 долларов. В первый день муха заработала доллар. Мозг видит только свечи на графике, а за прибыль срабатывают 15 дофаминовых клеток.';
function exportItem(id, kind, fields = {}) {
  const assets = fields.assets || [];
  return {
    contract: 'gudini.export/v1', id, kind, nativeId: id.split(':')[1], revision: fields.revision || 'rev-0001-aaaa', status: 'ready', language: 'ru',
    title: fields.title || 'Мозг мухи торгует биткоином', summary: fields.summary ?? 'Муха торгует биткоином и в первый день в плюсе.', text: fields.text || NEWS_TEXT, caption: fields.caption ?? null, hashtags: [],
    category: fields.category ?? 'story', topic: fields.title || 'Мозг мухи торгует биткоином', topicKey: null, style: null,
    cards: fields.cards || [card(0, 'cover', 'МУХА ТОРГУЕТ БИТКОИНОМ', 'Муха торгует биткоином.', 'cover.jpg', 'cover-frame.jpg')],
    sources: [{ url: 'https://shazoo.ru/2026/09/14/1', title: null, publisher: null, date: null, note: 'Максимум $10 на одну сделку и 24 сделки в день' }],
    facts: [], assets, montage: null, ...(fields.editable ? { editable: fields.editable } : {}), meta: { hero: '@nftechie_', promoLine: null },
    createdAt: '2026-11-13T09:00:00.000Z', readyAt: fields.readyAt || '2026-11-13T10:00:00.000Z', updatedAt: fields.updatedAt || '2026-11-13T10:00:00.000Z',
  };
}

test('FERMA 2.0: Gudini import, versions, own Meta accounts, distribution and the publication queue', { timeout: 180000 }, async t => {
  const { outputFiles } = await build({
    stdin: { contents: `
      import * as src from './lib/content/gudini-source';
      import * as v from './lib/content/variants';
      import * as d from './lib/content/distribution';
      import * as acc from './lib/publish/accounts';
      import * as q from './lib/publish/queue';
      import * as pm from './lib/publish/public-media';
      import * as dg from './lib/publish/diagnostics';
      import * as topics from './lib/content/topics';
      import * as ed from './lib/content/editorial';
      import * as pic from './lib/content/pictures';
      import * as eg from './lib/publish/engagement';
      import * as an from './lib/content/analytics';
      import * as cl from './lib/content/cleanup';
      import * as sys from './lib/system';
      const handlers = {
        activityFetch: i => eg.fetchEngagement(i.owner, { nowMs: i.now }), suggest: i => eg.suggestionJob(i.owner), suggested: i => eg.acceptSuggestions(i.owner, i.ids, i.replies),
        sendReply: i => eg.sendReply(i.owner, i.id, i.text, { nowMs: i.now }), replyTick: i => eg.replyTick(i.owner, { nowMs: i.now }), ignoreReply: i => eg.ignoreTask(i.owner, i.id),
        activity: i => eg.activityOverview(i.owner, { accountId: i.accountId, nowMs: i.now }), analytics: i => an.analyticsOverview(i.owner, { nowMs: i.now }), computeRecs: i => an.computeRecommendations(i.owner, { nowMs: i.now }),
        cleanup: i => cl.cleanupMedia(i.owner, { nowMs: i.now }), system: i => sys.systemOverview(i.owner, i.now),
        classify: i => topics.classificationJob(i.owner, { nowMs: i.now }), classified: i => topics.acceptClassification(i.owner, i.items, i.ids, i.now), categories: i => topics.listCategories(i.owner),
        reviewJob: i => ed.reviewJob(i.owner), review: i => ed.acceptReview(i.owner, i.itemId, i.revision, i.reviews), approveVariant: i => v.approveVariant(i.owner, i.variantId),
        diagApps: async i => ({ ...await dg.appDiagnostics(i.owner), media: await dg.mediaLinkCheck(i.owner, fetch, i.now) }), diagnose: i => dg.diagnoseAccount(i.owner, i.accountId, fetch, i.now),
        mediaTest: i => dg.startMediaTest(i.owner, i.accountId, fetch, i.now), mediaTestStatus: i => dg.readMediaTest(i.owner, i.accountId),
        reschedule: i => q.reschedule(i.owner, i.id, i.at, i.now), stopAll: i => q.stopAll(i.owner, { zernio: Boolean(i.zernio) }), hash: i => pic.storeAssetHash(i.owner, i.assetId, i.dhash),
        saveSource: i => src.saveGudiniSource(i.owner, i), sync: i => src.syncSource(i.owner, { force: i.force ?? true, nowMs: i.now }), assets: i => src.fetchAssets(i.owner, { limit: 30, nowMs: i.now }),
        sourceView: i => src.sourceOverview(i.owner), settings: i => src.saveSettings(i.owner, i), retry: i => src.retryItem(i.owner, i.itemId), watch: i => src.watchSource(i.owner, 0, undefined, i.now),
        ensure: i => v.ensureVariants(i.owner, i.itemId), writer: i => v.writerQueue(i.owner, 5), claimWriting: i => v.claimWriting(i.owner, i.itemId, i.revision),
        accept: i => v.acceptTexts(i.owner, i.itemId, i.revision, i.variants), edit: i => v.editVariant(i.owner, i.variantId, i), variants: i => v.variantsOverview(i.owner, { itemId: i.itemId }),
        claimRender: i => v.claimRender(i.owner, i.now), renderGudini: i => v.renderWithGudini(i.owner, i.jobId), fixedContent: i => v.fixedContent(i.owner, i.jobId, i), completeRender: i => v.completeRender(i.owner, i.jobId, i.files, {}),
        saveApp: i => acc.saveApp(i.owner, i.provider, i), connect: i => acc.startConnect(i.owner, i.profileId, i.provider), finish: i => acc.finishConnect(i.owner, i.state, i.code), accounts: i => acc.accountsOverview(i.owner),
        editorial: i => d.saveEditorial(i.owner, i.profileId, i), campaign: i => d.saveCampaign(i.owner, i), campaignStatus: i => d.setCampaignStatus(i.owner, i.id, i.status), preview: i => d.previewCampaign(i.owner, i.id, i.now),
        distribute: i => d.distributeTick(i.owner, { nowMs: i.now }), tick: i => q.publicationTick(i.owner, { nowMs: i.now }), stats: i => q.syncStats(i.owner, { nowMs: i.now }), queue: i => q.queueOverview(i.owner),
        approve: i => q.approve(i.owner, i.id), events: i => q.publicationEventsOf(i.owner, i.id),
        sign: i => pm.signedMediaUrl(i.base, i.key, 'image/jpeg', i.now, i.ttl), open: async i => { const o = await pm.openSignedMedia(i.token, i.now); return { found: Boolean(o), size: o?.size ?? null }; },
      };
      export default { async fetch(request) {
        const i = await request.json();
        try { return Response.json(await handlers[i.action](i) ?? null); }
        catch (error) { return Response.json({ error: error.message, kind: error.kind }, { status: error.status || 500 }); }
      }};`, resolveDir: root, loader: 'ts' },
    bundle: true, write: false, format: 'esm', platform: 'browser', target: 'es2022', external: ['cloudflare:workers'], tsconfig: path.join(root, 'tsconfig.json'),
  });

  // ---- fake Gudini export, Threads and Instagram
  const files = new Map();
  const NEWS = 'news:mwdwmbxsa257e0b335', CAROUSEL = 'carousel:cmwdwmc1j3faf111a21eb', TWIN = 'news:mwdwmbxsa999999999', BROKEN = 'news:mwdwmbxbroken0001';
  const bytes = (seed, size) => Buffer.alloc(size, seed);
  files.set(`${NEWS}/cover.jpg`, bytes(1, 2048)); files.set(`${NEWS}/cover-frame.jpg`, bytes(2, 1024)); files.set(`${NEWS}/out.mp4`, bytes(3, 4096));
  for (let index = 0; index < 4; index++) files.set(`${CAROUSEL}/slides/s${index}.jpg`, bytes(10 + index, 1500 + index));
  files.set(`${CAROUSEL}/sid/cover.png`, bytes(20, 3000));
  for (let index = 0; index < 12; index++) files.set(`${CAROUSEL}/sid/shot-${index + 1}.png`, bytes(30 + index, 700 + index));
  const newsItem = exportItem(NEWS, 'news', { assets: [asset(NEWS, 'out.mp4', 'video', null, 4096), asset(NEWS, 'cover.jpg', 'cover', 0, 2048), asset(NEWS, 'cover-frame.jpg', 'frame', 0, 1024)] });
  let carouselItem = exportItem(CAROUSEL, 'carousel', {
    title: 'He Yi: USDT со скидкой могут заморозить', text: 'Сооснователь Binance He Yi предупредила: USDT со скидкой от друзей могут заморозить. Tether заморозила 24,35 млн USDT.', summary: null, category: null, updatedAt: '2026-11-13T11:00:00.000Z', readyAt: '2026-11-13T11:00:00.000Z',
    cards: [card(0, 'cover', 'USDT СО СКИДКОЙ ЗАМОРОЗЯТ?', 'Проверь, у кого брал USDT', 'slides/s0.jpg', 'sid/cover.png'), card(1, 'content', 'Не заводи USDT со скидкой', 'He Yi написала пост 8 ноября.', 'slides/s1.jpg'), card(2, 'content', 'Tether заморозила 24,35 млн', 'Причину не объяснила.', 'slides/s2.jpg'), card(3, 'final', 'Перешли тому, кто берёт USDT', 'Пиши в комментариях.', 'slides/s3.jpg')],
    // Gudini can redraw it: the texts a version may change and Gudini's limits.
    editable: {
      style: 'investigation', palette: 0, palettes: Array.from({ length: 7 }, (_, index) => ({ index, name: `цвет ${index}`, accent: '#000000', cover: '#ffffff' })),
      limits: { coverLine: 12, coverAccent: 22, label: 36, title: 32, body: 165, pillLabel: 11, pillValue: 13, next: 20, finalLine: 16, cardBadge: 4, cardTitle: 11, cardSub: 16, finalBody: 110, caption: 600 },
      content: {
        cover: { pill: 'СРОЧНО', title: ['USDT', 'СО СКИДКОЙ', 'ЗАМОРОЗЯТ?'], accentLine: 'ЗАМОРОЖЕНО 24,35 МЛН', hook: 'Проверь, у кого брал USDT →' },
        steps: [
          { label: 'crypto.news · 8 ноября', title: 'Не заводи USDT со скидкой.', body: '**8 ноября** сооснователь Binance **He Yi** написала пост.', pills: [['ПОСТ', '8 ноября'], ['АВТОР', 'He Yi']], next: 'кто ещё в списке' },
          { label: 'TechFlow · 10 ноября', title: 'Tether заморозила 24,35 млн.', body: 'Tether заморозила около **24,35 млн USDT** на пяти адресах.', pills: [['СУММА', '24,35 млн'], ['СЕТЬ', 'Ethereum']], next: 'что дальше' },
        ],
        final: { black: ['ПЕРЕШЛИ ТОМУ,', 'КТО БЕРЁТ USDT.'], accent: ['ТЫ БРАЛ USDT?'], cards: [['USDT', '24,35 млн', 'на 5 адресах'], ['$', '450 млн+', 'заморозила T3'], ['DCTF', 'Tron', 'новая группа']], body: 'Ты брал USDT со скидкой? Пиши в комментариях.' },
        caption: 'He Yi предупредила про USDT со скидкой. Ты брал такие?',
      },
    },
    // 17 files like a real investigation carousel: more rows than one D1 statement may carry.
    assets: [0, 1, 2, 3].map(index => asset(CAROUSEL, `slides/s${index}.jpg`, 'render', index, 1500 + index)).concat([asset(CAROUSEL, 'sid/cover.png', 'cover_art', 0, 3000)], Array.from({ length: 12 }, (_, index) => asset(CAROUSEL, `sid/shot-${index + 1}.png`, 'screenshot', index + 1, 700 + index))),
  });
  const twin = exportItem(TWIN, 'news', { updatedAt: '2026-11-13T12:00:00.000Z', assets: [] });
  const broken = { ...exportItem(BROKEN, 'news', { updatedAt: '2026-11-13T12:30:00.000Z' }), contract: 'something-else' };
  // A news item three days old: still in Gudini's feed, no longer news.
  const OLD = 'news:mwdwmbxold0000001';
  const oldItem = exportItem(OLD, 'news', { title: 'Старая новость про ставку банка', text: 'Банк поднял ставку до 21 процента три дня назад. Решение объяснили инфляцией.', summary: 'Банк поднял ставку.', readyAt: new Date(NOW - 3 * 86_400_000).toISOString(), updatedAt: '2026-11-14T01:00:00.000Z', assets: [] });
  let withOld = false;
  const feed = () => [newsItem, carouselItem, twin, broken, ...(withOld ? [oldItem] : [])].sort((a, b) => a.updatedAt.localeCompare(b.updatedAt) || a.id.localeCompare(b.id));
  let gudiniDown = false;
  const renders = [];
  const gudiniRequests = [];
  const threadsCalls = [], instagramCalls = [];
  // When the post whose answer is lost appears in the account (set on the test's own clock).
  let igPostAt = new Date(NOW + 3600_000).toISOString();
  let threadsContainer = 0, threadsPosts = 0, igContainer = 0, igPublishMode = 'ok', igContainerStatus = 'FINISHED', igPublished = null, threadsLimitOnce = false, threadsPublishLost = false;
  const publishedContainers = new Set();
  const THREADS_SCOPES = ['threads_basic', 'threads_content_publish', 'threads_manage_insights', 'threads_read_replies', 'threads_manage_replies'];
  const mf = new Miniflare({
    modules: true, script: outputFiles[0].text, compatibilityDate: '2026-05-15', d1Databases: ['DB'], r2Buckets: ['BUCKET'],
    bindings: { SETTINGS_ENCRYPTION_KEY: Buffer.alloc(32, 7).toString('base64') },
    outboundService: async request => {
      const url = new URL(request.url);
      if (url.hostname === 'gudini.test') {
        gudiniRequests.push(url.pathname);
        if (url.pathname === '/v1/health') return Response.json({ ok: true, contract: 'gudini.export/v1' });
        if (gudiniDown) return new Response('busy', { status: 503 });
        if (url.pathname === '/v1/render' && request.method === 'POST') {
          if (request.headers.get('authorization') !== 'Bearer good-token') return Response.json({ error: 'unauthorized' }, { status: 401 });
          const body = await request.json();
          renders.push(body);
          // Gudini's layout refuses a cover line that does not fit, like the real renderer does.
          const long = body.content.cover.title.find(line => line.includes('ПОМОЖЕТ'));
          if (long) return Response.json({ problems: [`cover.title: строка «${long}» не помещается крупным шрифтом; оставь 1–2 коротких слова`], slides: [] }, { status: 422 });
          const count = body.content.steps.length + 2;
          return Response.json({ problems: [], palette: `цвет ${body.palette}`, slides: Array.from({ length: count }, (_, index) => ({ index, contentType: 'image/jpeg', width: 1080, height: 1350, size: 600 + index, data: Buffer.alloc(600 + index, index + 1).toString('base64') })) });
        }
        if (request.headers.get('authorization') !== 'Bearer good-token') return Response.json({ error: 'unauthorized' }, { status: 401 });
        if (url.pathname === '/v1/items' || url.pathname === '/v1/changes') {
          const cursor = url.searchParams.get('cursor');
          const position = cursor ? JSON.parse(Buffer.from(cursor, 'base64url').toString()) : null;
          const rest = feed().filter(item => !position || item.updatedAt > position.u || (item.updatedAt === position.u && item.id > position.i));
          if (url.pathname === '/v1/changes') return Response.json({ contract: 'gudini.export/v1', changed: rest.length > 0, cursor: cursor || '', serverTime: new Date().toISOString() });
          const limit = Number(url.searchParams.get('limit'));
          const page = rest.slice(0, limit);
          const last = page[page.length - 1];
          return Response.json({ contract: 'gudini.export/v1', items: page, cursor: last ? Buffer.from(JSON.stringify({ u: last.updatedAt, i: last.id })).toString('base64url') : (cursor || ''), more: rest.length > limit, serverTime: new Date().toISOString() });
        }
        const match = /^\/v1\/assets\/([^/]+)\/(.+)$/.exec(url.pathname);
        const file = match && files.get(`${decodeURIComponent(match[1])}/${decodeURIComponent(match[2])}`);
        return file ? new Response(file, { headers: { 'content-type': 'application/octet-stream' } }) : new Response('no', { status: 404 });
      }
      const form = request.method === 'POST' ? Object.fromEntries(new URLSearchParams(await request.text())) : Object.fromEntries(url.searchParams);
      // FERMA's public route as Caddy serves it: the OAuth return leads home, signed links give the picture.
      if (url.hostname === 'pub.test') {
        if (/^\/ferma\/oauth\/(threads|instagram)$/.test(url.pathname)) return new Response(null, { status: 302, headers: { location: 'http://127.0.0.1:3100/#accounts/oauth?provider=threads' } });
        if (url.pathname.startsWith('/ferma/m/')) return new Response(Buffer.alloc(900, 9), { headers: { 'content-type': 'image/jpeg' } });
      }
      if (url.hostname === 'graph.threads.com') {
        threadsCalls.push({ method: request.method, path: url.pathname, form });
        if (url.pathname === '/oauth/access_token' && form.grant_type === 'client_credentials') return form.client_id === '1234567' && form.client_secret === 's'.repeat(32) ? Response.json({ access_token: 'TH|1234567|app', token_type: 'bearer' }) : Response.json({ error: { message: 'Error validating client secret.', type: 'OAuthException', code: 1 } }, { status: 400 });
        if (url.pathname === '/oauth/access_token') return form.code === 'good-code' ? Response.json({ access_token: 'short-th', user_id: 'th-1' }) : Response.json({ error: { message: 'bad code', code: 100 } }, { status: 400 });
        if (url.pathname === '/access_token') return Response.json({ access_token: 'long-th', token_type: 'bearer', expires_in: 5_184_000 });
        if (url.pathname === '/v1.0/debug_token') return form.access_token === `TH|1234567|${'s'.repeat(32)}` ? Response.json({ data: { type: 'USER', application: 'FERMA test', is_valid: form.input_token === 'long-th', scopes: THREADS_SCOPES, data_access_expires_at: Math.floor((NOW + 80 * 86_400_000) / 1000), user_id: 'th-1' } }) : Response.json({ error: { message: 'Invalid app token', code: 190 } }, { status: 400 });
        if (form.access_token !== 'long-th') return Response.json({ error: { message: 'Invalid OAuth access token', code: 190 } }, { status: 400 });
        if (url.pathname === '/v1.0/me') return Response.json({ id: 'th-1', username: 'news_daily' });
        if (url.pathname === '/v1.0/th-1/threads' && request.method === 'POST') {
          // Meta's throttling answer: Retry-After plus the usage header with the time to regain access (minutes).
          if (threadsLimitOnce) { threadsLimitOnce = false; return Response.json({ error: { message: 'Application request limit reached', code: 4 } }, { status: 429, headers: { 'retry-after': '1800', 'x-business-use-case-usage': JSON.stringify({ 'th-1': [{ type: 'threads', call_count: 100, estimated_time_to_regain_access: 45 }] }) } }); }
          return Response.json({ id: `thc-${++threadsContainer}` });
        }
        if (url.pathname === '/v1.0/th-1/threads_publish') {
          // A published container says so afterwards; a lost answer is a dropped connection after the post is out.
          publishedContainers.add(form.creation_id);
          if (threadsPublishLost) { threadsPublishLost = false; throw new Error('connection reset'); }
          return Response.json({ id: `thpost-${++threadsPosts}` });
        }
        if (url.pathname.startsWith('/v1.0/thc-')) return Response.json({ status: publishedContainers.has(url.pathname.slice('/v1.0/'.length)) ? 'PUBLISHED' : 'FINISHED' });
        if (/^\/v1\.0\/thpost-\d+$/.test(url.pathname)) return Response.json({ permalink: `https://www.threads.com/@news_daily/post/${url.pathname.split('-')[1]}`, timestamp: '2026-11-14T05:00:00+0000' });
        if (/^\/v1\.0\/thpost-\d+\/insights$/.test(url.pathname)) return Response.json({ data: [{ name: 'views', values: [{ value: 120 }] }, { name: 'likes', values: [{ value: 7 }] }] });
        if (/^\/v1\.0\/thpost-\d+\/replies$/.test(url.pathname)) {
          const n = url.pathname.split('-')[1].split('/')[0];
          return Response.json({ data: [{ id: `r${n}a`, text: 'А где источник?', username: 'reader', timestamp: '2026-11-14T07:00:00+0000', is_reply_owned_by_me: false }, { id: `r${n}b`, text: 'Источник в карточках', username: 'news_daily', timestamp: '2026-11-14T07:10:00+0000', is_reply_owned_by_me: true }] });
        }
        if (url.pathname === '/v1.0/th-1/threads_publishing_limit') return Response.json({ data: [{ quota_usage: 1, config: { quota_total: 250 } }] });
        if (url.pathname === '/v1.0/th-1/threads_insights') return Response.json({ data: [{ name: 'views', total_value: { value: 10 } }] });
      }
      if (url.hostname === 'api.instagram.com' && url.pathname === '/oauth/access_token') return Response.json({ data: [{ access_token: 'short-ig', user_id: 'ig-app-1', permissions: 'instagram_business_basic' }] });
      if (url.hostname === 'graph.instagram.com') {
        instagramCalls.push({ method: request.method, path: url.pathname, form });
        if (url.pathname === '/access_token') return Response.json({ access_token: 'long-ig', token_type: 'bearer', expires_in: 5_184_000 });
        if (url.pathname === '/v27.0/me') return Response.json({ user_id: 'ig-1', username: 'news_daily_ig', account_type: 'BUSINESS', followers_count: 12 });
        if (url.pathname === '/v27.0/ig-1/media' && request.method === 'POST') return Response.json({ id: `igc-${++igContainer}` });
        if (url.pathname === '/v27.0/ig-1/media_publish') {
          if (igPublishMode === 'lost') { igPublishMode = 'ok'; igContainerStatus = 'PUBLISHED'; igPublished = { id: 'igpost-1' }; throw new Error('connection reset'); }
          igPublished = { id: 'igpost-1' }; return Response.json({ id: 'igpost-1' });
        }
        if (url.pathname.startsWith('/v27.0/igc-')) return Response.json({ status_code: igContainerStatus });
        if (url.pathname === '/v27.0/ig-1/media' && request.method === 'GET') return Response.json({ data: igPublished ? [{ id: 'igpost-1', caption: instagramCalls.find(call => call.form.media_type === 'CAROUSEL')?.form.caption, permalink: 'https://www.instagram.com/p/abc/', timestamp: igPostAt }] : [] });
        if (url.pathname === '/v27.0/igpost-1') return Response.json({ permalink: 'https://www.instagram.com/p/abc/', timestamp: '2026-11-14T06:00:00+0000' });
        if (url.pathname === '/v27.0/igpost-1/comments') return Response.json({ data: [{ id: 'cm-1', text: 'Где почитать подробнее?', username: 'reader_ig', timestamp: '2026-11-14T07:30:00+0000' }, { id: 'cm-2', text: 'Ссылка в шапке', username: 'news_daily_ig', timestamp: '2026-11-14T07:40:00+0000' }] });
        if (url.pathname === '/v27.0/cm-1/replies' && request.method === 'POST') return Response.json({ id: 'cm-reply-1' });
        if (url.pathname === '/v27.0/ig-1/content_publishing_limit') return Response.json({ data: [{ quota_usage: 0, config: { quota_total: 50 } }] });
      }
      return Response.json({ error: { message: `unexpected ${request.method} ${url.hostname}${url.pathname}` } }, { status: 404 });
    },
  });
  t.after(() => mf.dispose());
  const db = await mf.getD1Database('DB');
  for (const file of (await readdir(path.join(root, 'drizzle'))).filter(file => file.endsWith('.sql')).sort()) {
    const sql = (await readFile(path.join(root, 'drizzle', file), 'utf8')).replaceAll('--> statement-breakpoint', '');
    for (const statement of sql.split(';').map(value => value.trim()).filter(Boolean)) await db.prepare(statement).run();
  }
  await db.prepare(`INSERT INTO profiles (id, owner, name, createdAt) VALUES ('${P}', '${OWNER}', 'Новости', '2026-01-01'), ('22222222-2222-4222-8222-222222222222', 'intruder', 'x', '2026-01-01')`).run();
  const call = async body => { const response = await mf.dispatchFetch('http://test', { method: 'POST', body: JSON.stringify({ owner: OWNER, now: NOW, ...body }) }); return { status: response.status, body: await response.json() }; };
  const ok = async body => { const result = await call(body); assert.ok(result.status < 300, `${body.action}: ${JSON.stringify(result.body)}`); return result.body; };
  const rows = async sql => (await db.prepare(sql).all()).results;

  // ---- 1. Gudini: connection is checked before saving; a wrong token is refused
  assert.equal((await call({ action: 'saveSource', baseUrl: 'http://gudini.test', token: 'wrong' })).status, 401);
  await ok({ action: 'saveSource', baseUrl: 'http://gudini.test/', token: 'good-token' });
  const [stored] = await rows('SELECT baseUrl, encryptedToken FROM content_sources');
  assert.equal(stored.baseUrl, 'http://gudini.test');
  assert.ok(!stored.encryptedToken.includes('good-token'), 'the token is encrypted');

  // ---- 2. Import: new materials once, a near copy is marked, a broken one is skipped and does not block the feed
  const first = await ok({ action: 'sync' });
  assert.deepEqual([first.new, first.duplicate, first.invalid, first.more], [2, 1, 1, false]);
  const imported = await rows('SELECT externalId, status, assetsTotal, duplicateOf FROM source_items ORDER BY externalId');
  assert.deepEqual(imported.map(row => [row.externalId, row.status]), [[CAROUSEL, 'importing'], [NEWS, 'importing'], [TWIN, 'duplicate']]);
  assert.equal(imported.find(row => row.externalId === NEWS).assetsTotal, 2, 'the video waits for stage 2');
  assert.match((await ok({ action: 'sourceView' })).source.lastError, /не по контракту: 1/);
  assert.deepEqual(await ok({ action: 'sync' }), { new: 0, updated: 0, same: 0, duplicate: 0, invalid: 0, more: false }, 'the cursor remembers where it stopped');
  assert.deepEqual((await ok({ action: 'watch' })).changed, false);

  // ---- 3. Original files byte for byte, under their SHA-256
  await ok({ action: 'assets' });
  const ready = await rows("SELECT externalId, status, assetsStored FROM source_items WHERE status = 'ready' ORDER BY externalId");
  assert.deepEqual(ready.map(row => [row.externalId, row.assetsStored]), [[CAROUSEL, 17], [NEWS, 2]]);
  const coverRow = (await rows(`SELECT sha256, storageKey FROM source_assets WHERE assetId = 'cover.jpg'`))[0];
  assert.equal(coverRow.sha256, createHash('sha256').update(files.get(`${NEWS}/cover.jpg`)).digest('hex'));
  const bucket = await mf.getR2Bucket('BUCKET');
  assert.deepEqual(Buffer.from(await (await bucket.get(coverRow.storageKey)).arrayBuffer()), files.get(`${NEWS}/cover.jpg`));
  assert.deepEqual((await rows(`SELECT status FROM source_assets WHERE assetId = 'out.mp4'`))[0].status, 'deferred');

  // ---- 4. Network trouble: retries later, nothing is lost
  gudiniDown = true;
  const down = await ok({ action: 'sync' });
  assert.ok(down.error && down.retryInMs >= 60_000);
  assert.equal((await rows('SELECT status FROM content_sources'))[0].status, 'error');
  // While the pause lasts, the long poll does not knock on Gudini at all.
  gudiniDown = false;
  const polls = gudiniRequests.length;
  assert.equal((await ok({ action: 'watch' })).waiting, true);
  assert.equal(gudiniRequests.length, polls, 'no request to Gudini during the pause');
  carouselItem = { ...carouselItem, revision: 'rev-0002-bbbb', updatedAt: '2026-11-13T13:00:00.000Z', caption: 'Новая подпись' };
  assert.equal((await ok({ action: 'sync' })).updated, 1, 'a changed material is updated, not duplicated');
  assert.equal((await rows('SELECT count(*) AS n FROM source_items'))[0].n, 3);
  await ok({ action: 'assets' });

  // ---- 4b. Topics: the owner's list, the AI classifier's answer, keywords when the answer misses a material
  assert.ok((await ok({ action: 'categories' })).some(category => category.name === 'Криптовалюты'), 'the starting list is created');
  const classifyJob = await ok({ action: 'classify' });
  assert.equal(classifyJob.ids.length, 2, 'ready materials only, the copy is not sorted');
  assert.match(classifyJob.user, /«Криптовалюты»/);
  const newsRow = (await rows(`SELECT id FROM source_items WHERE externalId = '${NEWS}'`))[0];
  const sorted = await ok({ action: 'classified', ids: classifyJob.ids, items: [{ id: newsRow.id, categories: ['Криптовалюты', 'Выдуманная тема'], urgent: true }] });
  assert.deepEqual([sorted.byAi, sorted.byKeywords], [1, 1]);
  const topicsOf = Object.fromEntries((await rows('SELECT externalId, categories, urgent FROM source_items WHERE classifiedAt IS NOT NULL')).map(row => [row.externalId, [JSON.parse(row.categories), row.urgent]]));
  assert.deepEqual(topicsOf[NEWS], [['Криптовалюты'], 1], 'a name outside the owner\'s list is dropped; urgent news is marked');
  assert.deepEqual(topicsOf[CAROUSEL], [['Криптовалюты'], 0], 'no answer for it: its words (USDT, Binance, Tether) decide');
  assert.equal(await ok({ action: 'classify' }), null, 'nothing left to sort');

  // ---- 4c. Perceptual hashes of the originals: the same picture alone does not make two stories one
  const covers = await rows(`SELECT a.id, i.externalId FROM source_assets a JOIN source_items i ON i.id = a.itemId AND i.revision = a.revision WHERE a.assetId IN ('cover.jpg', 'slides/s0.jpg')`);
  for (const cover of covers) assert.equal((await ok({ action: 'hash', assetId: cover.id, dhash: 'f0f0f0f0f0f0f0f0' })).related, null);
  assert.equal((await rows(`SELECT count(*) AS n FROM source_items WHERE relatedTo IS NOT NULL`))[0].n, 0);
  assert.equal((await rows(`SELECT count(*) AS n FROM source_assets WHERE dhash = 'f0f0f0f0f0f0f0f0'`))[0].n, 2);

  // ---- 5. Versions: 5 per material, one writer call checks every fact
  await ok({ action: 'settings', variantsPerItem: 5 });
  const newsId = (await rows(`SELECT id, revision FROM source_items WHERE externalId = '${NEWS}'`))[0];
  assert.equal((await ok({ action: 'ensure', itemId: newsId.id })).created, 5);
  assert.equal((await ok({ action: 'ensure', itemId: newsId.id })).created, 0, 'planned once per revision');
  const writer = await ok({ action: 'writer' });
  const job = writer.jobs.find(entry => entry.itemId === newsId.id);
  assert.match(job.user, /Максимум \$10 на одну сделку/, 'source notes are part of the facts');
  assert.match(job.system, /Только факты из материала/);
  assert.deepEqual((await ok({ action: 'claimWriting', itemId: newsId.id, revision: newsId.revision })).slots, [0, 1, 2, 3, 4]);
  assert.deepEqual((await ok({ action: 'claimWriting', itemId: newsId.id, revision: newsId.revision })).slots, [], 'one writer at a time');
  const good = [
    { slot: 0, text: 'Муху научили торговать биткоином: инженер Coinbase дал её мозгу 100 долларов, и в первый день она вышла в плюс на доллар.' },
    { slot: 1, headline: 'Мозг мухи в плюсе', text: 'Что произошло: мозг мухи подключили к графику биткоина. Он видит свечи, а за прибыль включаются 15 дофаминовых клеток.', caption: 'Инженер Coinbase подключил мозг мухи к графику биткоина и дал ему 100 долларов.\n\nМуха видит только свечи. За прибыль у неё срабатывают 15 дофаминовых клеток. В первый день результат вышел в плюс на доллар.' },
    { slot: 2, headline: 'Муха против рынка', text: 'Почему это важно? Это шуточный опыт, но он показывает, как простая нервная система реагирует на прибыль: 15 клеток дофамина.', caption: 'Мозг мухи получил 100 долларов и график биткоина. Максимум $10 на одну сделку и 24 сделки в день. За первый день плюс доллар.' },
    { slot: 3, text: 'Муха заработала 5000 долларов за неделю.' },
    { slot: 4, text: 'Муху научили торговать биткоином: инженер Coinbase дал её мозгу 100 долларов, и в первый день она вышла в плюс на доллар.' },
  ];
  const accepted = await ok({ action: 'accept', itemId: newsId.id, revision: newsId.revision, variants: good });
  const byslot = Object.fromEntries(accepted.results.map(entry => [entry.slot, entry]));
  assert.deepEqual([0, 1, 2].map(slot => byslot[slot].status), ['reviewing', 'reviewing', 'reviewing'], 'texts that pass the checks go to the AI editor');
  assert.equal(byslot[3].status, 'planned');
  assert.ok(byslot[3].problems.some(problem => problem.includes('5000')), 'an invented number sends the text back');
  assert.ok(byslot[4].problems.some(problem => problem.includes('похож на другой вариант')), 'a copy of a sibling is not accepted');
  const slot3 = (await rows(`SELECT id FROM content_variants WHERE itemId = '${newsId.id}' AND slot = 3`))[0].id;
  assert.equal((await call({ action: 'edit', variantId: slot3, text: 'Муха заработала миллион.' })).status, 400, 'a hand edit is checked too');
  assert.equal((await ok({ action: 'edit', variantId: slot3, text: 'Вопрос дня: может ли муха торговать? Мозг мухи с 100 долларами вышел в плюс в первый же день.' })).status, 'reviewing', 'the owner\'s text is read by the editor too');

  // ---- 5b. The AI editor: every claim against the sources, a rating, and the verdict rules
  const reviewJob = await ok({ action: 'reviewJob' });
  assert.equal(reviewJob.itemId, newsId.id);
  assert.deepEqual(reviewJob.slots, [0, 1, 2, 3]);
  assert.match(reviewJob.user, /ИСТОЧНИКИ:[\s\S]*Максимум \$10 на одну сделку/, 'the editor sees Gudini\'s sources');
  assert.match(reviewJob.system, /unsupported/);
  const reviewed = await ok({ action: 'review', itemId: newsId.id, revision: newsId.revision, reviews: [
    { slot: 0, score: 93, claims: [{ text: 'дал её мозгу 100 долларов', status: 'supported', refs: ['S1'] }], issues: [], summary: 'Точно и ясно.' },
    { slot: 1, score: 90, claims: [{ text: 'Муха видит только свечи', status: 'supported', refs: [] }, { text: 'это шуточный опыт', status: 'unsupported', refs: [] }], issues: [], summary: 'Есть оценка без источника.' },
    { slot: 2, score: 85, claims: [{ text: '24 сделки в день', status: 'contradicted', refs: ['S1'] }], issues: [], summary: 'Число не сходится.' },
    { slot: 3, score: 50, claims: [], issues: ['вопрос в начале не связан с выводом'], summary: 'Слабый текст.' },
  ] });
  const verdicts = Object.fromEntries(reviewed.results.map(entry => [entry.slot, [entry.status, entry.score]]));
  assert.deepEqual(verdicts[0], ['ready', 93], 'all claims supported, above the threshold: ready');
  assert.deepEqual(verdicts[1], ['review', 69], 'an unsupported claim goes to the owner, rated at most 69');
  assert.deepEqual(verdicts[2], ['planned', 40], 'a contradiction goes back to the writer, rated at most 40');
  assert.deepEqual(verdicts[3], ['review', 50], 'the owner\'s own text is never handed to the writer');
  const notes = JSON.parse((await rows(`SELECT review FROM content_variants WHERE itemId = '${newsId.id}' AND slot = 1`))[0].review);
  assert.deepEqual(notes.unverified, ['это шуточный опыт']);
  const slot1 = (await rows(`SELECT id FROM content_variants WHERE itemId = '${newsId.id}' AND slot = 1`))[0].id;
  assert.equal((await ok({ action: 'approveVariant', variantId: slot1 })).status, 'ready', 'the owner accepts it as it is');
  assert.equal((await call({ action: 'approveVariant', variantId: slot1 })).status, 409, 'only a version waiting for the owner');

  // ---- 6. Own Meta apps and OAuth: one token per account, encrypted
  await ok({ action: 'saveApp', provider: 'meta_threads', appId: '1234567', appSecret: 's'.repeat(32), redirectUri: 'https://pub.test/ferma/oauth/threads' });
  await ok({ action: 'saveApp', provider: 'meta_instagram', appId: '7654321', appSecret: 'i'.repeat(32), redirectUri: 'https://pub.test/ferma/oauth/instagram' });
  assert.equal((await call({ action: 'saveApp', provider: 'meta_threads', appId: '1', appSecret: 'x', redirectUri: 'http://x' })).status, 400);
  const threadsStart = await ok({ action: 'connect', provider: 'meta_threads', profileId: P });
  const threadsUrl = new URL(threadsStart.url);
  assert.equal(threadsUrl.origin + threadsUrl.pathname, 'https://threads.com/oauth/authorize');
  assert.equal(threadsUrl.searchParams.get('client_id'), '1234567');
  assert.equal((await call({ action: 'finish', state: 'th_unknown_state_000', code: 'good-code' })).status, 410);
  assert.equal((await ok({ action: 'finish', state: threadsUrl.searchParams.get('state'), code: 'good-code#_' })).username, 'news_daily');
  assert.equal((await call({ action: 'finish', state: threadsUrl.searchParams.get('state'), code: 'good-code' })).status, 410, 'a state works once');
  const igStart = new URL((await ok({ action: 'connect', provider: 'meta_instagram', profileId: P })).url);
  assert.equal(igStart.origin + igStart.pathname, 'https://www.instagram.com/oauth/authorize');
  await ok({ action: 'finish', state: igStart.searchParams.get('state'), code: 'any' });
  const accounts = await rows('SELECT platform, username, status, encryptedToken, tokenExpiresAt FROM social_accounts ORDER BY platform');
  assert.deepEqual(accounts.map(row => [row.platform, row.username, row.status]), [['instagram', 'news_daily_ig', 'connected'], ['threads', 'news_daily', 'connected']]);
  assert.ok(accounts.every(row => !row.encryptedToken.includes('long-')), 'tokens are encrypted');
  assert.equal((await call({ owner: 'intruder', action: 'connect', provider: 'meta_threads', profileId: P })).status, 404);

  // ---- 7a. Texts of the carousel versions: Gudini's fields, Gudini's limits, facts only from the material
  const carouselId = (await rows(`SELECT id, revision FROM source_items WHERE externalId = '${CAROUSEL}'`))[0];
  assert.equal((await ok({ action: 'ensure', itemId: carouselId.id })).created, 5);
  const carouselJob = (await ok({ action: 'writer' })).jobs.find(entry => entry.itemId === carouselId.id);
  assert.match(carouselJob.user, /Перерисовка карусели шаблоном Gudini/);
  assert.match(carouselJob.user, /до 12 знаков/, 'the writer gets Gudini\'s limits');
  await ok({ action: 'claimWriting', itemId: carouselId.id, revision: carouselId.revision });
  const step = (title, body, next) => ({ title, body, next });
  const carouselOutputs = [
    { slot: 0, text: 'He Yi предупредила: USDT со скидкой от друзей могут заморозить, а Binance такую заморозку не снимает.', caption: 'Сооснователь Binance He Yi советует не заводить на биржу USDT со скидкой. Tether уже заморозила 24,35 млн USDT. Листайте карточки.' },
    { slot: 1, text: 'Почему USDT со скидкой опасен: Binance не снимет заморозку, а Tether уже заблокировала 24,35 млн на пяти адресах.', caption: 'Разбираем предупреждение He Yi по шагам. Ты бы взял USDT со скидкой?', content: { cover: { title: ['BINANCE', 'НЕ ПОМОЖЕТ'], accentLine: '24,35 МЛН ЗАМОРОЖЕНО', hook: 'Откуда твои USDT? →' }, steps: [step('Скидка на USDT - риск.', '**8 ноября** He Yi попросила не заводить на биржу такие USDT.', 'кто в списке'), step('Заморожено 24,35 млн.', 'Tether заблокировала **24,35 млн USDT** на пяти адресах.', 'итог')], final: { black: ['ПРОВЕРЬ,', 'ОТКУДА USDT.'], accent: ['ВЗЯЛ СО СКИДКОЙ?'], body: 'А ты брал USDT со скидкой у знакомых?' } } },
    { slot: 2, text: 'Можно ли заводить на биржу USDT со скидкой? He Yi советует не делать этого: такие монеты могут заморозить.', caption: 'Вопрос дня: стоит ли брать USDT со скидкой? Как думаешь?', content: { cover: { title: ['ВЗЯЛ USDT', 'СО СКИДКОЙ?'], accentLine: 'TETHER: 24,35 МЛН', hook: 'Листай и проверь себя →' }, steps: [step('Кто предупредил.', 'Сооснователь Binance **He Yi**, пост **8 ноября**.', 'что заморозили'), step('Что заморозили.', 'Около **24,35 млн USDT**, пять адресов.', 'вывод')], final: { black: ['НЕ ЗАВОДИ', 'ЧУЖИЕ USDT.'], accent: ['ДЕРЖИШЬ ТАКИЕ?'], body: 'Держишь USDT со скидкой? Расскажи.' } } },
    { slot: 3, text: 'Это важно для всех, кто покупает USDT у знакомых: заморозку Binance не снимет.', caption: 'Почему это касается каждого держателя USDT? Делись мнением?', content: { cover: { title: ['ЭТО КАСАЕТСЯ', 'ТЕБЯ'], accentLine: '24,35 МЛН USDT', hook: 'Почему это важно →' }, steps: [step('Предупреждение He Yi.', 'He Yi попросила проверять, откуда **USDT**.', 'последствия'), step('Блокировка Tether.', 'Tether заморозила **24,35 млн USDT**.', 'итог')], final: { black: ['ТВОИ USDT', 'ЧИСТЫЕ?'], accent: ['ПРОВЕРЬ.'], body: 'Проверял, откуда твои USDT?' } } },
    { slot: 4, text: 'Коротко: USDT со скидкой от знакомых могут заморозить, Binance такую заморозку не снимет.' },
  ];
  const carouselAccepted = await ok({ action: 'accept', itemId: carouselId.id, revision: carouselId.revision, variants: carouselOutputs });
  assert.ok(carouselAccepted.results.every(entry => entry.status === 'reviewing'), JSON.stringify(carouselAccepted.results));
  // A rewritten card text with an invented number is caught field by field.
  const facts = (await rows(`SELECT cards FROM content_variants WHERE itemId = '${carouselId.id}' AND slot = 1`))[0];
  assert.equal(JSON.parse(facts.cards).steps[0].pills[0][1], '8 ноября', 'value pills stay Gudini\'s');
  const carouselReview = await ok({ action: 'reviewJob' });
  assert.equal(carouselReview.itemId, carouselId.id);
  assert.match(carouselReview.user, /Карточки: исходные карточки Gudini без изменений/);
  const ratedCarousel = await ok({ action: 'review', itemId: carouselId.id, revision: carouselId.revision, reviews: [90, 96, 86, 84, 88].map((score, slot) => ({ slot, score, claims: [{ text: 'Tether заморозила 24,35 млн USDT', status: 'supported', refs: ['S1'] }], issues: [], summary: 'Точно.' })) });
  assert.deepEqual(ratedCarousel.results.map(entry => entry.status), ['ready', 'written', 'written', 'written', 'ready'], 'a redraw waits for its account before Gudini draws it');

  // ---- 7. Campaign: topics decide, preview writes nothing; each account gets the best checked version at its own time
  await ok({ action: 'editorial', profileId: P, topics: ['муха', 'биткоин', 'usdt'], perDay: { threads: 4, instagram: 3 }, windows: [[0, 24]], minGapMinutes: 15, mode: 'auto' });
  const campaignInput = { action: 'campaign', name: 'Тест', mode: 'auto', kinds: ['news', 'carousel'], keywords: [], categories: ['Политика'], profileIds: [P], platforms: ['threads', 'instagram'], maxAccountsPerItem: 5, spreadMinutes: 60, since: '2026-11-01T00:00:00.000Z' };
  const { id: campaignId } = await ok(campaignInput);
  assert.equal((await ok({ action: 'preview', id: campaignId })).assignments.length, 0, 'no material in the campaign\'s topic');
  await ok({ ...campaignInput, id: campaignId, categories: ['Криптовалюты'] });
  const preview = await ok({ action: 'preview', id: campaignId });
  assert.ok(preview.assignments.length >= 2);
  assert.equal((await rows('SELECT count(*) AS n FROM publications'))[0].n, 0, 'preview creates nothing');
  assert.equal((await ok({ action: 'distribute' })).planned, 0, 'a paused campaign does nothing');
  await ok({ action: 'campaignStatus', id: campaignId, status: 'active' });
  await ok({ action: 'distribute' });
  const planned = await rows(`SELECT p.id, p.platform, p.status, p.scheduledFor, p.itemId, p.priority, v.format, v.style, v.layout, v.slot, v.profileId FROM publications p JOIN content_variants v ON v.id = p.variantId ORDER BY p.scheduledFor`);
  const forNews = planned.filter(row => row.itemId === newsId.id);
  assert.deepEqual(forNews.map(row => row.platform), ['threads'], 'a 9:16 news cover never goes to the Instagram feed');
  assert.deepEqual([forNews[0].format, forNews[0].slot], ['text', 0], 'Threads gets the text version the editor rated best');
  assert.equal(forNews[0].priority, 1, 'urgent news goes first in the queue');
  const forCarousel = planned.filter(row => row.itemId === carouselId.id);
  assert.ok(forCarousel.every(row => row.format === 'carousel'), JSON.stringify(forCarousel.map(row => [row.platform, row.format, row.style])));
  assert.deepEqual(forCarousel.map(row => [row.platform, row.layout, row.slot]).sort(), [['instagram', 'gudini', 1], ['threads', 'original', 0]], 'Instagram (carousels only) chooses first: the top rated redraw; Threads the next best');
  assert.ok(planned.every(row => row.status === 'scheduled' && row.profileId === P));
  const times = forCarousel.map(row => Date.parse(row.scheduledFor)).sort();
  assert.ok(times[1] - times[0] >= 60 * 60_000, 'the same material is spread in time');
  const before = (await rows('SELECT count(*) AS n FROM publications'))[0].n;
  await ok({ action: 'distribute' });
  assert.equal((await rows('SELECT count(*) AS n FROM publications'))[0].n, before, 'no second publication of a material to an account');

  // ---- 8. Nothing is published while automatic publishing is off
  const later = Date.parse(planned[planned.length - 1].scheduledFor) + 60_000;
  assert.equal((await ok({ action: 'tick', now: later })).off, true);
  assert.equal(threadsCalls.filter(entry => entry.path === '/v1.0/th-1/threads').length, 0);
  await ok({ action: 'settings', autopublish: true, publicBaseUrl: 'https://pub.test/ferma/' });

  // ---- 8b. Meta diagnostics: reads only, Meta's own reasons; nothing is published
  const appsDiag = await ok({ action: 'diagApps' });
  const appChecks = provider => Object.fromEntries(appsDiag.apps.find(entry => entry.provider === provider).checks.map(check => [check.key, check.state]));
  assert.deepEqual(appChecks('meta_threads'), { app: 'ok', reachable: 'ok', keys: 'ok' });
  assert.deepEqual(appChecks('meta_instagram'), { app: 'ok', reachable: 'ok', keys: 'skip' }, 'Meta has no key check for Instagram Login');
  assert.equal(appsDiag.media.state, 'ok', 'a signed picture link opens through the public address');
  await ok({ action: 'saveApp', provider: 'meta_threads', appId: '1234567', appSecret: 'w'.repeat(20), redirectUri: 'https://pub.test/ferma/oauth/threads' });
  const wrongKeys = (await ok({ action: 'diagApps' })).apps.find(entry => entry.provider === 'meta_threads').checks.find(check => check.key === 'keys');
  assert.equal(wrongKeys.state, 'fail');
  assert.match(wrongKeys.detail, /Error validating client secret/, 'Meta\'s own words');
  await ok({ action: 'saveApp', provider: 'meta_threads', appId: '1234567', appSecret: 's'.repeat(32), redirectUri: 'https://pub.test/ferma/oauth/threads' });
  const accountIds = Object.fromEntries((await rows('SELECT platform, id FROM social_accounts')).map(row => [row.platform, row.id]));
  const threadsDiag = await ok({ action: 'diagnose', accountId: accountIds.threads });
  assert.deepEqual(Object.fromEntries(threadsDiag.checks.map(check => [check.key, check.state])), { token: 'ok', profile: 'ok', scopes: 'ok', quota: 'ok', insights: 'ok' }, JSON.stringify(threadsDiag.checks));
  const igDiag = await ok({ action: 'diagnose', accountId: accountIds.instagram });
  assert.deepEqual(Object.fromEntries(igDiag.checks.map(check => [check.key, check.state])), { token: 'ok', profile: 'ok', scopes: 'warn', quota: 'ok', insights: 'fail' }, JSON.stringify(igDiag.checks));
  assert.match(igDiag.checks.find(check => check.key === 'scopes').detail, /instagram_business_content_publish/, 'the permissions not granted at login are named');
  assert.ok((await ok({ action: 'accounts' })).accounts.every(account => account.diagnostics?.checks.length), 'the result is kept for the screen');
  assert.equal((await ok({ action: 'mediaTest', accountId: accountIds.instagram })).state, 'pending');
  assert.equal((await ok({ action: 'mediaTestStatus', accountId: accountIds.instagram })).state, 'ok', 'Meta fetched a real picture into a hidden container');
  assert.equal(instagramCalls.filter(entry => entry.path.endsWith('/media_publish')).length, 0, 'the test container is never published');

  // ---- 9. Threads: Meta's wait is kept for the whole account, then container, processing, publish; one call each
  const threadsPub = forNews[0].id;
  const threadsCarousel = forCarousel.find(row => row.platform === 'threads').id;
  threadsLimitOnce = true;
  await ok({ action: 'tick', now: later });
  const limited = (await rows(`SELECT status, errorKind, nextAttemptAt FROM publications WHERE id = '${threadsPub}'`))[0];
  assert.deepEqual([limited.status, limited.errorKind], ['scheduled', 'rate_limit']);
  assert.equal(limited.nextAttemptAt, new Date(later + 45 * 60_000).toISOString(), 'the longer of Retry-After (30 min) and the usage header (45 min)');
  assert.equal((await rows(`SELECT pausedUntil FROM social_accounts WHERE id = '${accountIds.threads}'`))[0].pausedUntil, new Date(later + 45 * 60_000).toISOString());
  assert.match((await rows(`SELECT error FROM publications WHERE id = '${threadsCarousel}'`))[0].error, /на паузе/, 'the account\'s other post waits too');
  assert.equal(threadsCalls.filter(entry => entry.path === '/v1.0/th-1/threads' && entry.method === 'POST').length, 1, 'nothing more is sent during the pause');
  const resume = later + 46 * 60_000;
  await ok({ action: 'tick', now: resume });
  assert.equal((await rows(`SELECT status FROM publications WHERE id = '${threadsPub}'`))[0].status, 'processing');
  const container = threadsCalls.find(entry => entry.path === '/v1.0/th-1/threads' && entry.form.media_type === 'TEXT');
  assert.ok(container && container.form.text.length <= 480);
  await ok({ action: 'tick', now: resume + 120_000 });
  const done = (await rows(`SELECT status, remoteId, permalink FROM publications WHERE id = '${threadsPub}'`))[0];
  assert.equal(done.status, 'published');
  assert.match(done.remoteId, /^thpost-[12]$/);
  assert.equal(done.permalink, `https://www.threads.com/@news_daily/post/${done.remoteId.split('-')[1]}`, 'the post is read back from the API');
  assert.equal((await rows(`SELECT status FROM publications WHERE id = '${threadsCarousel}'`))[0].status, 'published');
  assert.equal(threadsCalls.filter(entry => entry.path === '/v1.0/th-1/threads_publish').length, 2, 'one publish call per publication');

  // ---- 10. Instagram carousel drawn by Gudini's templates: a refused layout is fixed, then published; a lost answer is settled
  const t10 = later + 60 * 60_000;
  const igPub = (await rows(`SELECT p.id, p.variantId, v.status, v.layout FROM publications p JOIN content_variants v ON v.id = p.variantId WHERE p.platform = 'instagram' AND p.itemId = '${carouselId.id}'`))[0];
  assert.deepEqual([igPub.status, igPub.layout], ['rendering', 'gudini'], 'a bound redrawn version is queued for Gudini');
  let renderJob = await ok({ action: 'claimRender', now: t10 });
  assert.equal(renderJob.variantId, igPub.variantId);
  const refused = await ok({ action: 'renderGudini', jobId: renderJob.jobId });
  assert.equal(refused.ok, false);
  assert.match(refused.fix.user, /не помещается крупным шрифтом/, 'the writer gets Gudini\'s own words about the layout');
  assert.ok(renders[0].palette !== 0 && renders[0].handle === 'news_daily_ig', `colour ${renders[0].palette}, handle ${renders[0].handle}`);
  await ok({ action: 'fixedContent', jobId: renderJob.jobId, content: { cover: { title: ['BINANCE', 'НЕ СПАСЁТ'] } }, caption: null });
  renderJob = await ok({ action: 'claimRender', now: t10 });
  const drawn = await ok({ action: 'renderGudini', jobId: renderJob.jobId });
  assert.equal(drawn.ok, true);
  assert.equal(drawn.slides.length, 4, 'cover, two steps, final');
  assert.deepEqual(renders[1].content.cover.title, ['BINANCE', 'НЕ СПАСЁТ']);
  const bucketFiles = [];
  for (const slide of drawn.slides) bucketFiles.push(Buffer.from(await (await bucket.get(slide.key)).arrayBuffer()));
  await ok({ action: 'completeRender', jobId: renderJob.jobId, files: drawn.slides.map((slide, index) => ({ index, contentType: 'image/jpeg', width: 1080, height: 1350, size: bucketFiles[index].length, sha256: createHash('sha256').update(bucketFiles[index]).digest('hex'), dhash: (index + 1).toString(16).padStart(16, '0') })) });
  assert.equal((await rows(`SELECT status FROM content_variants WHERE id = '${igPub.variantId}'`))[0].status, 'ready');
  const render = { cards: drawn.slides };
  igPublishMode = 'lost';
  igPostAt = new Date(t10 + 400_000).toISOString();
  await ok({ action: 'tick', now: t10 + 200_000 });
  const igContainers = instagramCalls.filter(entry => entry.path === '/v27.0/ig-1/media' && entry.method === 'POST' && (entry.form.is_carousel_item || entry.form.media_type === 'CAROUSEL'));
  assert.equal(igContainers.length, render.cards.length + 1, 'one container per card and one for the carousel');
  const childUrl = igContainers[0].form.image_url;
  assert.ok(childUrl.startsWith('https://pub.test/ferma/m/'));
  await ok({ action: 'tick', now: t10 + 400_000 });
  assert.equal((await rows(`SELECT status FROM publications WHERE id = '${igPub.id}'`))[0].status, 'uncertain', 'a lost answer is not treated as success or failure');
  await ok({ action: 'tick', now: t10 + 600_000 });
  const igDone = (await rows(`SELECT status, remoteId FROM publications WHERE id = '${igPub.id}'`))[0];
  assert.deepEqual([igDone.status, igDone.remoteId], ['published', 'igpost-1']);
  assert.equal(instagramCalls.filter(entry => entry.path === '/v27.0/ig-1/media_publish').length, 1, 'published once');
  assert.ok((await ok({ action: 'events', id: igPub.id })).some(event => event.message.includes('потерялся')));

  // ---- 11. Signed links: valid only as issued and only for their time
  const token = new URL(childUrl).pathname.split('/m/')[1];
  assert.equal((await ok({ action: 'open', token })).found, true);
  assert.equal((await ok({ action: 'open', token: token.replace(/^./, token[0] === 'a' ? 'b' : 'a') })).found, false, 'tampered link');
  assert.equal((await ok({ action: 'open', token, now: NOW + 3 * 86_400_000 })).found, false, 'expired link');

  // ---- 12. Statistics and the single queue
  await ok({ action: 'stats', now: later + 7 * 3600_000 });
  assert.deepEqual(JSON.parse((await rows(`SELECT stats FROM publications WHERE id = '${threadsPub}'`))[0].stats), { views: 120, likes: 7 });
  const queue = await ok({ action: 'queue' });
  assert.ok(queue.rows.some(row => row.source === 'ferma' && row.status === 'published' && row.permalink));
  assert.equal((await call({ owner: 'intruder', action: 'approve', id: threadsPub })).status, 404, 'owner only');

  // ---- 12b. «Активность»: comments under own posts, suggested answers, only approved answers go out
  const t12 = later + 7.5 * 3600_000;
  const fetched = await ok({ action: 'activityFetch', now: t12 });
  assert.equal(fetched.added, 3, 'a reader\'s reply under each Threads post and one Instagram comment; the accounts\' own answers skipped');
  assert.equal((await ok({ action: 'activityFetch', now: t12 + 60_000 })).posts, 0, 'a post is read again only after half an hour');
  const suggestJob = await ok({ action: 'suggest' });
  assert.equal(suggestJob.ids.length, 3);
  assert.match(suggestJob.system, /никаких новых фактов/);
  const taskIds = Object.fromEntries((await rows('SELECT id, remoteId FROM engagement_tasks')).map(row => [row.remoteId, row.id]));
  await ok({ action: 'suggested', ids: suggestJob.ids, replies: [{ id: taskIds.r1a, text: 'Источник в карточках поста.' }, { id: taskIds['cm-1'], text: 'Подробности в карусели.' }, { id: taskIds.r2a, text: '', skip: true }] });
  const activity = await ok({ action: 'activity', now: t12 });
  assert.equal(activity.waiting, 3);
  assert.equal(activity.tasks.find(task => task.id === taskIds.r2a).error, 'ИИ советует не отвечать.');
  assert.equal(threadsCalls.filter(entry => entry.form.reply_to_id).length + instagramCalls.filter(entry => entry.path.endsWith('/replies')).length, 0, 'a suggestion never goes out by itself');
  assert.equal((await ok({ action: 'sendReply', id: taskIds.r1a, text: 'Источник в карточках поста, спасибо за вопрос.', now: t12 })).status, 'sending');
  assert.equal((await call({ action: 'sendReply', id: taskIds.r1a, text: 'ещё раз', now: t12 })).status, 409, 'an answer never goes twice');
  assert.equal((await ok({ action: 'replyTick', now: t12 + 10_000 })).sent, 0, 'Threads wants half a minute between container and publication');
  assert.equal((await ok({ action: 'replyTick', now: t12 + 31_000 })).sent, 1);
  assert.equal(threadsCalls.find(entry => entry.form.reply_to_id === 'r1a').form.text, 'Источник в карточках поста, спасибо за вопрос.', 'exactly the owner\'s text');
  assert.equal((await ok({ action: 'sendReply', id: taskIds['cm-1'], text: 'Подробности в карусели.', now: t12 })).status, 'sent');
  assert.equal(instagramCalls.find(entry => entry.path === '/v27.0/cm-1/replies').form.message, 'Подробности в карусели.');
  await ok({ action: 'ignoreReply', id: taskIds.r2a });
  const answered = await ok({ action: 'activity', now: t12 + 60_000 });
  assert.deepEqual([answered.waiting, answered.answeredToday], [0, 2]);
  assert.ok((await ok({ action: 'activity', accountId: accountIds.threads, now: t12 })).history.length >= 2, 'history of one account');
  // A reply whose publish answer got lost: the container is asked, the reply is never posted twice.
  await db.prepare(`UPDATE engagement_tasks SET status = 'suggested', error = NULL WHERE id = '${taskIds.r2a}'`).run();
  assert.equal((await ok({ action: 'sendReply', id: taskIds.r2a, text: 'Спасибо, что читаете.', now: t12 })).status, 'sending');
  const { replyContainerId } = (await rows(`SELECT replyContainerId FROM engagement_tasks WHERE id = '${taskIds.r2a}'`))[0];
  threadsPublishLost = true;
  assert.equal((await ok({ action: 'replyTick', now: t12 + 31_000 })).sent, 0);
  assert.equal((await rows(`SELECT status FROM engagement_tasks WHERE id = '${taskIds.r2a}'`))[0].status, 'sending', 'a lost answer is not a failure: the reply may be out');
  assert.equal((await ok({ action: 'replyTick', now: t12 + 95_000 })).sent, 1, 'the container says the reply is out');
  assert.equal(threadsCalls.filter(entry => entry.path === '/v1.0/th-1/threads_publish' && entry.form.creation_id === replyContainerId).length, 1, 'the reply is published once');
  // «Отправить» pressed again on a failed task whose reply is out: nothing new is made.
  await db.prepare(`UPDATE engagement_tasks SET status = 'failed' WHERE id = '${taskIds.r2a}'`).run();
  const containersBefore = threadsContainer;
  assert.deepEqual(await ok({ action: 'sendReply', id: taskIds.r2a, text: 'Спасибо, что читаете.', now: t12 + 120_000 }), { status: 'sent', already: true });
  assert.equal(threadsContainer, containersBefore, 'no second reply container');

  // ---- 12c. Analytics: only the numbers the networks gave; no conclusion from three posts
  const analytics = await ok({ action: 'analytics', now: t12 });
  assert.deepEqual([analytics.total.posts, analytics.total.measured, analytics.total.medianViews], [3, 2, 120], 'Instagram gave no numbers: no data, not zero');
  assert.deepEqual(await ok({ action: 'computeRecs', now: t12 }), { proposed: 0, withdrawn: 0 });
  assert.deepEqual(analytics.recommendations, []);

  // ---- 13. Old news is never published as new
  withOld = true;
  assert.equal((await ok({ action: 'sync' })).new, 1);
  const oldId = (await rows(`SELECT id FROM source_items WHERE externalId = '${OLD}'`))[0].id;
  await ok({ action: 'classified', ids: [oldId], items: [{ id: oldId, categories: ['Финансы', 'Криптовалюты'], urgent: false }] });
  const night = later + 8 * 3600_000;
  await ok({ action: 'distribute', now: night });
  assert.equal((await rows(`SELECT count(*) AS n FROM publications WHERE itemId = '${oldId}'`))[0].n, 0, 'older than the age limit: not planned');
  // A publication planned earlier for it is withdrawn when its time comes, with the reason.
  await db.prepare(`INSERT INTO publications (id, owner, profileId, accountId, provider, platform, itemId, variantId, format, status, scheduledFor, idempotencyKey, createdAt, updatedAt) VALUES ('old-pub', '${OWNER}', '${P}', '${accountIds.threads}', 'meta_threads', 'threads', '${oldId}', 'none', 'text', 'scheduled', '${new Date(night - 60_000).toISOString()}', 'test:old', '2026-11-14', '2026-11-14')`).run();
  await ok({ action: 'tick', now: night });
  const oldPub = (await rows(`SELECT status, error FROM publications WHERE id = 'old-pub'`))[0];
  assert.equal(oldPub.status, 'cancelled');
  assert.match(oldPub.error, /старше 48 ч/);

  // ---- 14. A new time keeps the age limit too
  await db.prepare(`INSERT INTO publications (id, owner, profileId, accountId, provider, platform, itemId, variantId, format, status, scheduledFor, idempotencyKey, createdAt, updatedAt) VALUES ('move-pub', '${OWNER}', '${P}', '${accountIds.instagram}', 'meta_instagram', 'instagram', '${newsId.id}', 'none', 'carousel', 'awaiting_approval', '2026-11-14T09:00:00.000Z', 'test:move', '2026-11-14', '2026-11-14')`).run();
  const tooLate = await call({ action: 'reschedule', id: 'move-pub', at: new Date(NOW + 3 * 86_400_000).toISOString() });
  assert.equal(tooLate.status, 400);
  assert.match(tooLate.body.error, /старше 48 ч/);
  await ok({ action: 'reschedule', id: 'move-pub', at: new Date(NOW + 3600_000).toISOString() });
  assert.equal((await rows(`SELECT scheduledFor FROM publications WHERE id = 'move-pub'`))[0].scheduledFor, new Date(NOW + 3600_000).toISOString());

  // ---- 15. «Остановить всё»: automatic publishing off, campaigns paused, nothing goes out
  assert.deepEqual((await ok({ action: 'queue' })).running, { campaigns: 1, autopilots: 0, zernioWaiting: 0 });
  assert.deepEqual(await ok({ action: 'stopAll' }), { campaigns: 1, autopilots: 0, zernioWaiting: 0, zernioTakenBack: 0, errors: [] });
  const stopped = await ok({ action: 'queue' });
  assert.equal(stopped.autopublish, false);
  assert.deepEqual(stopped.running, { campaigns: 0, autopilots: 0, zernioWaiting: 0 });
  assert.equal((await ok({ action: 'tick', now: night + 3600_000 })).off, true);
  // A publication whose answer was lost is still settled, but a ready container is not published while stopped.
  await db.prepare(`INSERT INTO publications (id, owner, profileId, accountId, provider, platform, itemId, variantId, format, status, text, scheduledFor, parentContainerId, containerIds, idempotencyKey, createdAt, updatedAt) VALUES ('held-pub', '${OWNER}', '${P}', '${accountIds.threads}', 'meta_threads', 'threads', 'held-item', 'none', 'text', 'uncertain', 'held', '${new Date(night).toISOString()}', 'thc-held', '{"ids":[],"at":${night}}', 'test:held', '2026-11-14', '2026-11-14')`).run();
  const publishCalls = threadsCalls.filter(entry => entry.path === '/v1.0/th-1/threads_publish').length;
  await ok({ action: 'tick', now: night + 3600_000 + 60_000 });
  assert.equal((await rows(`SELECT status FROM publications WHERE id = 'held-pub'`))[0].status, 'processing', 'checked: not out, waits for publishing to be switched on');
  assert.equal(threadsCalls.filter(entry => entry.path === '/v1.0/th-1/threads_publish').length, publishCalls, 'nothing goes out after «Остановить всё»');
  // Approving a publication whose version waits for the owner approves the version too, so the quality check keeps it.
  const versionId = (await rows(`SELECT variantId FROM publications WHERE id = '${threadsPub}'`))[0].variantId;
  await db.prepare(`UPDATE content_variants SET status = 'review' WHERE id = '${versionId}'`).run();
  await db.prepare(`INSERT INTO publications (id, owner, profileId, accountId, provider, platform, itemId, variantId, format, status, scheduledFor, idempotencyKey, createdAt, updatedAt) VALUES ('approve-pub', '${OWNER}', '${P}', '${accountIds.threads}', 'meta_threads', 'threads', 'approve-item', '${versionId}', 'text', 'awaiting_approval', '${new Date(night + 7200_000).toISOString()}', 'test:approve', '2026-11-14', '2026-11-14')`).run();
  await ok({ action: 'approve', id: 'approve-pub' });
  await ok({ action: 'distribute', now: night + 3600_000 + 120_000 });
  assert.equal((await rows(`SELECT status FROM content_variants WHERE id = '${versionId}'`))[0].status, 'ready');
  assert.equal((await rows(`SELECT status FROM publications WHERE id = 'approve-pub'`))[0].status, 'scheduled', 'the approval stays');

  // ---- 16. «Состояние системы» and media retention: FERMA's drawn cards go after the period, Gudini's originals never
  const system = await ok({ action: 'system', now: night });
  assert.equal(system.counts.publications.published, 3);
  assert.ok(system.storage.originals.files > 0 && system.storage.drawn.files === 4, JSON.stringify(system.storage));
  assert.deepEqual(await ok({ action: 'cleanup', now: night }), { versions: 0, files: 0, bytes: 0, events: 0, retentionDays: 30 }, 'nothing within the period');
  const drawnKeys = (await rows(`SELECT storageKey FROM variant_assets WHERE variantId = '${igPub.variantId}'`)).map(row => row.storageKey);
  const cleaned = await ok({ action: 'cleanup', now: NOW + 40 * 86_400_000 });
  assert.ok(cleaned.files >= 4, JSON.stringify(cleaned));
  for (const key of drawnKeys) assert.equal(await bucket.get(key), null, 'drawn card removed');
  assert.ok(await bucket.get(coverRow.storageKey), 'Gudini\'s original stays');
  assert.equal((await rows(`SELECT status, assetsCount FROM content_variants WHERE id = '${igPub.variantId}'`))[0].status, 'archived');
  assert.equal((await rows(`SELECT status FROM publications WHERE id = '${igPub.id}'`))[0].status, 'published', 'the history stays');
});
