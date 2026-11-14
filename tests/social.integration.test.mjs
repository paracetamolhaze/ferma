import test from 'node:test';
import assert from 'node:assert/strict';
import { build } from 'esbuild';
import { Miniflare } from 'miniflare';
import { readFile, readdir } from 'node:fs/promises';
import path from 'node:path';
import { parseChannel, readChannel, skipReason } from '../docker/autopilot.mjs';

const root = path.resolve(import.meta.dirname, '..');

test('channel page is read into posts: text, photos, and what cannot be mirrored', () => {
  const wrap = body => `<div class="tgme_widget_message_wrap js-widget_message_wrap">${body}</div>`;
  const html = '<html>' + [
    wrap('<div class="tgme_widget_message" data-post="mychan/12"><div class="tgme_widget_message_text js-message_text" dir="auto">Привет &amp; пока<br/>вторая <b>строка</b> &#33;</div></div>'),
    wrap(`<div data-post="mychan/11"><a class="tgme_widget_message_photo_wrap x" style="width:800px;background-image:url('https://cdn.telegram.org/a.jpg')"></a><a class="tgme_widget_message_photo_wrap" style="background-image:url('https://cdn.telegram.org/b.jpg')"></a><div class="tgme_widget_message_text js-message_text">два фото</div></div>`),
    wrap('<div data-post="mychan/13"><div class="tgme_widget_message_video_wrap"></div><div class="tgme_widget_message_text js-message_text">видео</div></div>'),
    wrap('<div data-post="mychan/14"><div class="tgme_widget_message_forwarded_from">x</div><div class="tgme_widget_message_text js-message_text">пересылка</div></div>'),
  ].join('') + '</html>';
  const posts = parseChannel(html);
  assert.deepEqual(posts.map(post => post.id), [11, 12, 13, 14], 'oldest first');
  assert.deepEqual(posts[0].photos, ['https://cdn.telegram.org/a.jpg', 'https://cdn.telegram.org/b.jpg']);
  assert.equal(posts[1].text, 'Привет & пока\nвторая строка !');
  assert.deepEqual(posts.map(post => post.unsupported), [false, false, true, true]);
  assert.deepEqual(parseChannel('<html>nothing</html>'), []);
  // Ads, links (also hidden under a word) and foreign-language promos stay in the channel.
  const post = (text, extra = {}) => ({ text, photos: [], unsupported: false, hasLink: false, ...extra });
  assert.equal(skipReason(post('обычный пост про утро')), null);
  assert.equal(skipReason(post('', { photos: ['a'] })), null);
  for (const ad of ['Скидка 20% по промокоду ФЕРМА', 'текст #реклама', 'ООО Ромашка erid: 2Vtzq', 'Розыгрыш айфона, подписывайтесь на канал', 'заходите на site.com', 'пишите t.me/someone']) assert.ok(skipReason(post(ad)), ad);
  assert.ok(skipReason(post('слово', { hasLink: true })));
  assert.ok(skipReason(post('Join our community and explore the best trading tools available right now for everyone')));
  assert.ok(skipReason(post('видео', { unsupported: true })));
  assert.ok(skipReason(post('')));
  const linked = parseChannel(wrap('<div data-post="c/20"><div class="tgme_widget_message_text js-message_text">читайте <a href="https://example.com/x">тут</a></div></div>') + wrap('<div data-post="c/21"><div class="tgme_widget_message_text js-message_text">тема <a href="https://t.me/c?q=%23утро">#утро</a></div></div>'));
  assert.deepEqual(linked.map(item => item.hasLink), [true, false], 'a hashtag is not a link');
});

test('missed channel posts are read further back than the first page', async () => {
  const range = (from, to) => Array.from({ length: to - from + 1 }, (_, i) => ({ id: from + i }));
  const pages = { '': range(30, 49), 30: range(10, 29), 10: range(1, 9) };
  const asked = [];
  const load = async (channel, before) => { asked.push(before || ''); return pages[before || '']; };
  const ids = (await readChannel('c', 15, load)).map(post => post.id);
  assert.deepEqual(ids, range(10, 49).map(post => post.id), 'oldest first, no gaps, no repeats');
  assert.deepEqual(asked, ['', 30]);
  asked.length = 0;
  assert.equal((await readChannel('c', null, load)).length, 20, 'a new channel reads only its first page');
  assert.equal((await readChannel('c', 48, load)).length, 20);
  assert.deepEqual(asked, ['', '']);
});

test('mirrored posts are never duplicated and replies keep a human pace', { timeout: 90000 }, async t => {
  const { outputFiles } = await build({
    stdin: { contents: `
      import * as s from './lib/social';
      import * as a from './lib/autopilot';
      import { saveZernioKey } from './lib/integration-settings';
      export default { async fetch(request) {
        const i = await request.json();
        try {
          if (i.action === 'key') { await saveZernioKey(i.owner, i.profileId, i.token); return Response.json({ ok: true }); }
          if (i.action === 'save') return Response.json(await s.saveSource(i.owner, i.profileId, i));
          if (i.action === 'read') return Response.json(await s.readSource(i.owner, i.profileId));
          if (i.action === 'engine') return Response.json({ sources: await s.engineSources(i.owner, i.now) });
          if (i.action === 'kinds') return Response.json({ kinds: (await a.engineState(i.owner))[0]?.kinds });
          if (i.action === 'seen') return Response.json(await s.markSeen(i.owner, i.profileId, i.tgLastId));
          if (i.action === 'mirror') return Response.json(await s.mirrorBegin(i.owner, i.profileId, i.tgId, i.text, i.dueAt, i.now));
          if (i.action === 'comments') return Response.json(await s.pendingComments(i.owner, i.profileId, i.now));
          if (i.action === 'reply') return Response.json(await s.sendReply(i.owner, i.profileId, i.postId, i.commentId, i.message, i.now));
          if (i.action === 'skipComment') return Response.json(await s.skipComment(i.owner, i.profileId, i.postId, i.commentId));
          if (i.action === 'image') return Response.json(await a.storeImage(i.owner, i.id, 'image/jpeg', new Uint8Array(i.bytes).buffer, i.n || 0));
          if (i.action === 'complete') return Response.json(await a.complete(i.owner, i.id, {}));
          if (i.action === 'publish') return Response.json(await a.publish(i.owner, i.id, i.now));
          return Response.json({ parts: a.splitForThreads(i.text) });
        } catch (error) { return Response.json({ error: error.message }, { status: error.status || 500 }); }
      }};`, resolveDir: root, loader: 'ts' },
    bundle: true, write: false, format: 'esm', platform: 'browser', target: 'es2022', external: ['cloudflare:workers'], tsconfig: path.join(root, 'tsconfig.json'),
  });
  const posts = [], replies = [];
  const now = Date.parse('2026-11-12T10:00:00Z');
  const comments = [
    { id: 'c1', message: 'классное фото', createdTime: '2026-11-12T09:00:00Z', canReply: true, from: { username: 'anna', isOwner: false }, replies: [] },
    { id: 'c2', message: 'уже отвечала', createdTime: '2026-11-12T09:00:00Z', canReply: true, from: { username: 'ira', isOwner: false }, replies: [{ from: { isOwner: true } }] },
    { id: 'c3', message: 'мой коммент', createdTime: '2026-11-12T09:00:00Z', canReply: true, from: { username: 'me', isOwner: true }, replies: [] },
    { id: 'c4', message: 'старый', createdTime: '2026-11-01T09:00:00Z', canReply: true, from: { username: 'old', isOwner: false }, replies: [] },
    { id: 'c5', message: 'ещё один', createdTime: '2026-11-12T09:30:00Z', canReply: true, from: { username: 'olya', isOwner: false }, replies: [] },
  ];
  const mf = new Miniflare({
    modules: true, script: outputFiles[0].text, compatibilityDate: '2026-05-15', d1Databases: ['DB'], r2Buckets: ['BUCKET'],
    bindings: { SETTINGS_ENCRYPTION_KEY: Buffer.alloc(32, 9).toString('base64') },
    outboundService: async request => {
      const url = new URL(request.url);
      if (url.hostname === 'upload.test') return new Response(null, { status: 200 });
      if (url.pathname === '/api/v1/media/presign') return Response.json({ uploadUrl: 'https://upload.test/x', publicUrl: `https://cdn.test/${Math.random()}.jpg` });
      if (url.pathname === '/api/v1/posts') { posts.push(await request.json()); return Response.json({ post: { _id: `z${posts.length}` } }); }
      if (url.pathname === '/api/v1/inbox/comments') return Response.json({ data: [{ id: 'post1', content: 'мой пост', commentCount: 5 }] });
      if (url.pathname === '/api/v1/inbox/comments/post1' && request.method === 'GET') return Response.json({ comments });
      if (url.pathname === '/api/v1/inbox/comments/post1') { replies.push({ key: request.headers.get('idempotency-key'), body: await request.json() }); return Response.json({ success: true }); }
      return Response.json({ error: 'unexpected' }, { status: 404 });
    },
  });
  t.after(() => mf.dispose());
  const db = await mf.getD1Database('DB');
  for (const file of (await readdir(path.join(root, 'drizzle'))).filter(file => file.endsWith('.sql')).sort()) {
    const sql = (await readFile(path.join(root, 'drizzle', file), 'utf8')).replaceAll('--> statement-breakpoint', '');
    for (const statement of sql.split(';').map(value => value.trim()).filter(Boolean)) await db.prepare(statement).run();
  }
  const P = '11111111-1111-4111-8111-111111111111';
  await db.prepare(`INSERT INTO profiles (id, owner, name, createdAt) VALUES ('${P}', 'owner', 'Diana', 'x'), ('22222222-2222-4222-8222-222222222222', 'intruder', 'x', 'x')`).run();
  await db.prepare(`INSERT INTO channels (id, profileId, slot, platform, accountId, username, state, createdAt) VALUES ('c2', '${P}', 1, 'threads', 'th-acc', 'd', 'connected', 'x')`).run();
  const call = async body => { const r = await mf.dispatchFetch('http://test', { method: 'POST', body: JSON.stringify({ owner: 'owner', ...body }) }); return { status: r.status, ...await r.json() }; };
  await call({ action: 'key', profileId: P, token: 'key-a' });

  // Channel names in any usual form; nonsense refused; a foreign profile untouched.
  for (const bad of ['a b', 'x', 'https://evil.example/chan']) assert.equal((await call({ action: 'save', profileId: P, tgChannel: bad, replies: false })).status, 400, bad);
  assert.equal((await call({ owner: 'intruder', action: 'save', profileId: P, tgChannel: '@chan1', replies: true })).status, 404);
  assert.equal((await call({ action: 'save', profileId: P, tgChannel: 'https://t.me/s/My_Channel', replies: true })).tgChannel, 'My_Channel');
  assert.deepEqual((await call({ action: 'engine' })).sources.map(item => [item.name, item.tgChannel, item.tgLastId, item.replies]), [['Diana', 'My_Channel', null, true]]);
  // With a channel, Threads is no longer written by the autopilot, and her planned own posts are dropped.
  await db.prepare(`INSERT INTO personas (profileId, owner, persona, enabled, updatedAt) VALUES ('${P}', 'owner', '{"name":"D"}', 1, 'x')`).run();
  await db.prepare(`INSERT INTO autopilot_items (id, owner, profileId, kind, status, dueAt, attempts, extraImages, createdAt, updatedAt) VALUES ('own1', 'owner', '${P}', 'threads', 'planned', '2026-11-13T10:00:00Z', 0, 0, 'x', 'x')`).run();
  assert.deepEqual((await call({ action: 'kinds' })).kinds, []);
  await call({ action: 'save', profileId: P, tgChannel: '', replies: true });
  assert.deepEqual((await call({ action: 'kinds' })).kinds, ['threads'], 'without a channel she writes her own');
  await call({ action: 'save', profileId: P, tgChannel: '@My_Channel', replies: true });
  assert.equal((await db.prepare("SELECT status FROM autopilot_items WHERE id = 'own1'").first()).status, 'skipped');
  await call({ action: 'seen', profileId: P, tgLastId: 40 });
  assert.equal((await call({ action: 'save', profileId: P, tgChannel: '@My_Channel', replies: true })).tgLastId, 40, 'same channel keeps its place');

  // A post with two photos and no text goes to Threads at once, exactly once. Every call here runs on the test's
  // own clock: a copy begun on the real clock would be «in the future» for a publish on the fixed one.
  const begun = await call({ action: 'mirror', profileId: P, tgId: 41, text: '', now });
  assert.equal((await call({ action: 'mirror', profileId: P, tgId: 41, text: '', now })).skip, true, 'no second copy');
  await call({ action: 'image', id: begun.id, bytes: [1, 2] });
  await call({ action: 'image', id: begun.id, bytes: [3], n: 1 });
  assert.equal((await call({ action: 'complete', id: begun.id })).ok, true);
  assert.equal((await call({ action: 'publish', id: begun.id, now })).ok, true);
  assert.deepEqual([posts[0].publishNow, posts[0].mediaItems.length, posts[0].platforms[0].platform], [true, 2, 'threads']);
  // A long text becomes a chain, photos stay on the first part.
  const long = await call({ action: 'mirror', profileId: P, tgId: 42, text: 'Первое предложение. '.repeat(60), now });
  await call({ action: 'complete', id: long.id });
  await call({ action: 'publish', id: long.id, now });
  const chain = posts[1].platforms[0].platformSpecificData.threadItems;
  assert.ok(chain.length >= 3 && chain.every(part => part.content.length <= 500 && part.content.length > 0));
  assert.equal(chain.map(part => part.content).join(' ').replace(/\s+/g, ' ').trim(), 'Первое предложение. '.repeat(60).trim());
  assert.deepEqual((await call({ action: 'split', text: 'короткий' })).parts, ['короткий']);
  // An empty post without photos cannot be published.
  const empty = await call({ action: 'mirror', profileId: P, tgId: 43, text: '', now });
  assert.equal((await call({ action: 'complete', id: empty.id })).status, 400);

  // A post that piled up is scheduled for later, and the queue end is known so the next one goes after it.
  const later = await call({ action: 'mirror', profileId: P, tgId: 44, text: 'потом', dueAt: '2026-11-12T13:00:00Z', now });
  assert.equal(later.dueAt, '2026-11-12T13:00:00.000Z');
  await call({ action: 'complete', id: later.id });
  await call({ action: 'publish', id: later.id, now });
  assert.deepEqual([posts.at(-1).scheduledFor, posts.at(-1).publishNow], ['2026-11-12T13:00:00.000Z', undefined]);
  assert.equal((await call({ action: 'engine', now })).sources[0].queuedUntil, '2026-11-12T13:00:00.000Z');
  assert.equal((await call({ action: 'engine', now: Date.parse('2026-11-12T14:00:00Z') })).sources[0].queuedUntil, null, 'nothing waits after it went out');
  assert.equal((await call({ action: 'mirror', profileId: P, tgId: 49, text: 'x', dueAt: '2027-03-01T00:00:00Z', now })).status, 400, 'not months ahead');
  // A copy that broke off midway (photo did not download) is tried again, three times at most, and never doubled.
  const broken = await call({ action: 'mirror', profileId: P, tgId: 45, text: 'фото' });
  assert.deepEqual([(await call({ action: 'mirror', profileId: P, tgId: 45, text: 'фото' })).busy], [true], 'still being copied: wait');
  const stale = Date.now() + 10 * 60_000;
  const again = await call({ action: 'mirror', profileId: P, tgId: 45, text: 'фото', now: stale });
  assert.ok(again.id && again.id !== broken.id);
  assert.ok((await call({ action: 'mirror', profileId: P, tgId: 45, text: 'фото', now: stale })).id);
  assert.equal((await call({ action: 'mirror', profileId: P, tgId: 45, text: 'фото', now: stale })).skip, true);
  assert.deepEqual(Object.values(await db.prepare("SELECT count(*) AS n, max(status) AS s FROM autopilot_items WHERE imagePrompt = 'tg:My_Channel/45'").first()), [1, 'failed']);

  // Only fresh comments from other people that she has not answered yet.
  const pending = (await call({ action: 'comments', profileId: P, now })).comments;
  assert.deepEqual(pending.map(item => item.commentId), ['c1', 'c5']);
  assert.equal((await call({ owner: 'intruder', action: 'comments', profileId: P, now })).status, 404);
  // One reply per comment, a pause between replies, and limits.
  assert.equal((await call({ action: 'reply', profileId: P, postId: 'post1', commentId: 'c1', message: 'спасибо)', now })).sent, true);
  assert.deepEqual(replies[0], { key: 'reply-c1', body: { accountId: 'th-acc', message: 'спасибо)', commentId: 'c1' } });
  assert.deepEqual((await call({ action: 'reply', profileId: P, postId: 'post1', commentId: 'c1', message: 'ещё раз', now: now + 3600_000 })).reason, 'handled');
  assert.equal((await call({ action: 'reply', profileId: P, postId: 'post1', commentId: 'c5', message: 'ага', now: now + 60_000 })).reason, 'limit', 'five minutes between replies');
  assert.equal((await call({ action: 'reply', profileId: P, postId: 'post1', commentId: 'c5', message: 'ага', now: now + 6 * 60_000 })).sent, true);
  assert.equal(replies.length, 2);
  await call({ action: 'skipComment', profileId: P, postId: 'post1', commentId: 'c4' });
  assert.deepEqual((await call({ action: 'comments', profileId: P, now })).comments, []);
  assert.equal((await call({ action: 'read', profileId: P })).repliesSent, 2);
});
