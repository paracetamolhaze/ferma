import test from 'node:test';
import assert from 'node:assert/strict';
import { build } from 'esbuild';
import { Miniflare } from 'miniflare';
import { readFile, readdir } from 'node:fs/promises';
import path from 'node:path';

test('Zernio data is read with the profile own key, for its own remote profile only', { timeout: 60000 }, async t => {
  const root = path.resolve(import.meta.dirname, '..');
  const { outputFiles } = await build({
    stdin: { contents: `
      import { saveZernioKey } from './lib/integration-settings';
      import { readConnectUrl, readQueue, readRemotePosts, readStats, saveQueue } from './lib/zernio-insights';
      export default { async fetch(request) {
        const i = await request.json();
        try {
          if (i.action === 'key') { await saveZernioKey(i.owner, i.profileId, i.token); return Response.json({ ok: true }); }
          if (i.action === 'posts') return Response.json(await readRemotePosts(i.owner, i.profileId, i.status));
          if (i.action === 'stats') return Response.json(await readStats(i.owner, i.profileId, i.days));
          if (i.action === 'queue') return Response.json(await readQueue(i.owner, i.profileId));
          if (i.action === 'connect') return Response.json(await readConnectUrl(i.owner, i.profileId, i.platform));
          return Response.json(await saveQueue(i.owner, i.profileId, i.input));
        } catch (error) { return Response.json({ error: error.message }, { status: error.status || 500 }); }
      }};`, resolveDir: root, loader: 'ts' },
    bundle: true, write: false, format: 'esm', platform: 'browser', target: 'es2022', external: ['cloudflare:workers'], tsconfig: path.join(root, 'tsconfig.json'),
  });
  const outbound = [];
  let saved = null, statsStatus = 200;
  const metrics = { impressions: 100, reach: 80, likes: 5, comments: 1, shares: 1, saves: 1, clicks: 0, views: 90 };
  const mf = new Miniflare({
    modules: true, script: outputFiles[0].text, compatibilityDate: '2026-05-15', d1Databases: ['DB'],
    bindings: { SETTINGS_ENCRYPTION_KEY: Buffer.alloc(32, 9).toString('base64') },
    outboundService: async request => {
      const url = new URL(request.url);
      outbound.push({ method: request.method, path: url.pathname + url.search, auth: request.headers.get('authorization') });
      if (url.pathname === '/api/v1/posts') return Response.json({ pagination: { total: 151 }, posts: [
        { _id: 'p1', title: 'Видео', content: 'x'.repeat(500), status: 'published', scheduledFor: '2026-08-26T22:53:00.000Z', mediaItems: [{ type: 'video' }], platforms: [{ platform: 'tiktok', status: 'published', publishedAt: '2026-08-26T22:55:00.000Z', platformPostUrl: 'https://www.tiktok.com/@a/video/1' }] },
        { _id: 'p2', status: 'failed', queuedFromProfile: 'remote-a', platforms: [{ platform: 'threads', errorMessage: 'Нет доступа', platformPostUrl: 'javascript:alert(1)' }] },
      ] });
      if (url.pathname === '/api/v1/analytics/dashboard') {
        if (statsStatus !== 200) return Response.json({ error: 'Analytics access required' }, { status: statsStatus });
        return Response.json({ totals: metrics, previousTotals: metrics, followers: { current: 2, gained: 1 }, daily: [{ date: '2026-11-09', impressions: 1, reach: 1, engagement: 1, views: 1, followersGained: 0 }], topPosts: [{ postId: 'p1', platform: 'tiktok', publishedAt: '2026-08-26T22:55:00.000Z', metrics }], recentPosts: [], dataAsOf: null });
      }
      if (url.pathname === '/api/v1/queue/slots' && request.method === 'PUT') { saved = await request.json(); return Response.json({ success: true }); }
      if (url.pathname === '/api/v1/queue/slots') return Response.json(saved ? { exists: true, schedule: { slots: saved.slots, active: saved.active, timezone: saved.timezone }, nextSlots: ['2026-11-10T12:00:00+05:00'] } : { exists: false, schedule: null, nextSlots: [] });
      if (url.pathname === '/api/v1/connect/instagram') return Response.json({ authUrl: 'https://zernio.com/oauth/start' });
      if (url.pathname === '/api/v1/connect/threads') return Response.json({ authUrl: 'http://evil.example/' });
      return Response.json({ error: 'unexpected' }, { status: 404 });
    },
  });
  t.after(() => mf.dispose());
  const db = await mf.getD1Database('DB');
  for (const file of (await readdir(path.join(root, 'drizzle'))).filter(file => file.endsWith('.sql')).sort()) {
    const sql = (await readFile(path.join(root, 'drizzle', file), 'utf8')).replaceAll('--> statement-breakpoint', '');
    for (const statement of sql.split(';').map(value => value.trim()).filter(Boolean)) await db.prepare(statement).run();
  }
  await db.prepare("INSERT INTO profiles (id, owner, name, zernioId, createdAt) VALUES ('a', 'owner', 'a', 'remote-a', '2026-01-01'), ('b', 'owner', 'b', 'remote-b', '2026-01-01'), ('nokey', 'owner', 'n', 'remote-n', '2026-01-01'), ('unbound', 'owner', 'u', NULL, '2026-01-01')").run();
  async function call(body) {
    const response = await mf.dispatchFetch('http://test', { method: 'POST', body: JSON.stringify({ owner: 'owner', ...body }) });
    return { status: response.status, ...await response.json() };
  }
  await call({ action: 'key', profileId: 'a', token: 'key-a' });
  await call({ action: 'key', profileId: 'b', token: 'key-b' });
  await call({ action: 'key', profileId: 'unbound', token: 'key-u' });
  outbound.length = 0;

  // Posts: trimmed text, the platform link, an unsafe link dropped, the error kept.
  const posts = await call({ action: 'posts', profileId: 'a' });
  assert.equal(posts.total, 151);
  assert.equal(posts.posts[0].content.length, 280);
  assert.equal(posts.posts[0].media, 'video');
  assert.equal(posts.posts[0].platforms[0].url, 'https://www.tiktok.com/@a/video/1');
  assert.equal(posts.posts[1].platforms[0].url, null);
  assert.equal(posts.posts[1].platforms[0].error, 'Нет доступа');
  assert.equal(posts.posts[1].queued, true);
  assert.equal(outbound.at(-1).auth, 'Bearer key-a');
  assert.match(outbound.at(-1).path, /profileId=remote-a/);

  // An unknown status never reaches the provider's query string.
  await call({ action: 'posts', profileId: 'b', status: 'published&x=1' });
  assert.equal(outbound.at(-1).auth, 'Bearer key-b');
  assert.doesNotMatch(outbound.at(-1).path, /status=/);
  await call({ action: 'posts', profileId: 'b', status: 'scheduled' });
  assert.match(outbound.at(-1).path, /status=scheduled/);

  // Stats: the window is limited to known periods.
  const stats = await call({ action: 'stats', profileId: 'a', days: 7 });
  assert.equal(stats.followers.current, 2);
  assert.equal(stats.topPosts[0].metrics.views, 90);
  const window = new URL('http://x' + outbound.at(-1).path).searchParams;
  assert.equal((Date.parse(window.get('toDate')) - Date.parse(window.get('fromDate'))) / 86400000, 6);
  await call({ action: 'stats', profileId: 'a', days: 100000 });
  const fallback = new URL('http://x' + outbound.at(-1).path).searchParams;
  assert.equal((Date.parse(fallback.get('toDate')) - Date.parse(fallback.get('fromDate'))) / 86400000, 29);
  statsStatus = 402;
  assert.equal((await call({ action: 'stats', profileId: 'a', days: 30 })).status, 402);
  statsStatus = 200;

  // Queue: empty, then saved under the profile's own remote id with duplicates removed.
  const empty = await call({ action: 'queue', profileId: 'a' });
  assert.deepEqual([empty.exists, empty.slots], [false, []]);
  const queue = await call({ action: 'save', profileId: 'a', input: { active: true, slots: [{ dayOfWeek: 1, time: '09:00' }, { dayOfWeek: 1, time: '09:00' }, { dayOfWeek: 3, time: '18:30' }] } });
  assert.equal(saved.profileId, 'remote-a');
  assert.equal(saved.timezone, 'Asia/Qyzylorda');
  assert.equal(saved.slots.length, 2);
  assert.deepEqual([queue.exists, queue.active, queue.nextSlots.length], [true, true, 1]);

  // Connecting: only the profile's own networks, only safe login links.
  assert.equal((await call({ action: 'connect', profileId: 'a', platform: 'instagram' })).authUrl, 'https://zernio.com/oauth/start');
  assert.match(outbound.at(-1).path, /profileId=remote-a/);
  assert.equal((await call({ action: 'connect', profileId: 'a', platform: 'threads' })).status, 503);
  assert.equal((await call({ action: 'connect', profileId: 'a', platform: 'slack' })).status, 400);

  // Nothing leaves without a key, a binding or ownership.
  outbound.length = 0;
  assert.equal((await call({ action: 'posts', profileId: 'nokey' })).status, 503);
  assert.equal((await call({ action: 'posts', profileId: 'unbound' })).status, 400);
  assert.equal((await call({ owner: 'intruder', action: 'posts', profileId: 'a' })).status, 404);
  assert.equal(outbound.length, 0);
});
