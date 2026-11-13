import test from 'node:test';
import assert from 'node:assert/strict';
import { build } from 'esbuild';
import { Miniflare } from 'miniflare';
import { readFile, readdir } from 'node:fs/promises';
import path from 'node:path';
import { DEFAULT_RHYTHM, MIN_LEAD_MS, planNext } from '../lib/rhythm.ts';

const root = path.resolve(import.meta.dirname, '..');
const DAY = 86_400_000, OFFSET = 300;
const localHour = ms => new Date(ms + OFFSET * 60_000).getUTCHours() + new Date(ms + OFFSET * 60_000).getUTCMinutes() / 60;
const localDay = ms => Math.floor((ms + OFFSET * 60_000) / DAY);
function seeded(seed) { return () => ((seed = (seed * 1103515245 + 12345) % 2 ** 31) / 2 ** 31); }

test('the rhythm looks like a person: gaps, local hours, weekends, never too soon', () => {
  const now = Date.parse('2026-11-10T06:00:00Z');
  for (let seed = 1; seed < 300; seed++) {
    const random = seeded(seed);
    const last = now - DAY;
    const threads = planNext(DEFAULT_RHYTHM.threads, last, now, OFFSET, random);
    const gap = localDay(threads) - localDay(last);
    assert.ok(gap >= 2 && gap <= 4, `threads gap ${gap}`);
    assert.ok(localHour(threads) >= 20 && localHour(threads) < 23, `threads hour ${localHour(threads)}`);
    const story = planNext(DEFAULT_RHYTHM.story, null, now, OFFSET, random);
    const hour = localHour(story);
    assert.ok((hour >= 9 && hour < 11) || (hour >= 18 && hour < 21), `story hour ${hour}`);
    assert.ok(story >= now + MIN_LEAD_MS, 'never sooner than it can be prepared');
    assert.ok(story - now < 4 * DAY);
    const post = planNext(DEFAULT_RHYTHM.post, now - 3 * DAY, now, OFFSET, random);
    assert.ok([0, 6].includes(new Date(post + OFFSET * 60_000).getUTCDay()), 'posts on weekends');
    assert.ok(localDay(post) - localDay(now - 3 * DAY) >= 25);
  }
  // Several times a day: spread over waking hours, never at night, about the asked number per day.
  for (const perDay of [1, 3, 6]) {
    const random = seeded(perDay * 11);
    let last = now, count = 0;
    const until = now + 10 * DAY;
    while (last < until) {
      const next = planNext({ ...DEFAULT_RHYTHM.threads, perDay }, last, last, OFFSET, random);
      assert.ok(next > last, 'time moves forward');
      assert.ok(localHour(next) >= 9 && localHour(next) < 23, `awake hours, got ${localHour(next)}`);
      last = next; count++;
    }
    assert.ok(count / 10 > perDay * 0.6 && count / 10 < perDay * 1.5, `${perDay} a day gave ${count / 10}`);
  }
  // A long silence does not produce a backlog in the past.
  assert.ok(planNext(DEFAULT_RHYTHM.threads, now - 30 * DAY, now, OFFSET, seeded(7)) >= now + MIN_LEAD_MS);
});

test('autopilot moves an item from plan to published, safely and only for its owner', { timeout: 90000 }, async t => {
  const { outputFiles } = await build({
    stdin: { contents: `
      import * as a from './lib/autopilot';
      import { saveZernioKey } from './lib/integration-settings';
      export default { async fetch(request) {
        const i = await request.json();
        try {
          if (i.action === 'key') { await saveZernioKey(i.owner, i.profileId, i.token); return Response.json({ ok: true }); }
          if (i.action === 'persona') return Response.json(await a.savePersona(i.owner, i.profileId, i.persona));
          if (i.action === 'enabled') return Response.json(await a.setEnabled(i.owner, i.profileId, i.enabled));
          if (i.action === 'plan') return Response.json(await a.plan(i.owner, i.profileId, i.kind, i.now, () => 0.5));
          if (i.action === 'claim') return Response.json(await a.claim(i.owner, i.id));
          if (i.action === 'image') return Response.json(await a.storeImage(i.owner, i.id, i.type, new Uint8Array(i.bytes).buffer, i.n || 0));
          if (i.action === 'complete') return Response.json(await a.complete(i.owner, i.id, i));
          if (i.action === 'fail') return Response.json(await a.fail(i.owner, i.id, i.error));
          if (i.action === 'skip') return Response.json(await a.skip(i.owner, i.id));
          if (i.action === 'publish') return Response.json(await a.publish(i.owner, i.id, i.now));
          if (i.action === 'sync') return Response.json(await a.sync(i.owner, i.now));
          if (i.action === 'stock') return Response.json(await a.addStock(i.owner, i.profileId, i.kind, i.text));
          if (i.action === 'takeStock') return Response.json(await a.takeStock(i.owner, i.id));
          if (i.action === 'rhythm') return Response.json(await a.setRhythm(i.owner, i.profileId, i.rhythm));
          if (i.action === 'onboard') return Response.json({ profiles: await a.onboardList(i.owner) });
          if (i.action === 'engine') return Response.json({ profiles: await a.engineState(i.owner) });
          if (i.action === 'reels') return Response.json({ profiles: await a.reelReach(i.owner) });
          return Response.json(await a.readProfileAutopilot(i.owner, i.profileId));
        } catch (error) { return Response.json({ error: error.message }, { status: error.status || 500 }); }
      }};`, resolveDir: root, loader: 'ts' },
    bundle: true, write: false, format: 'esm', platform: 'browser', target: 'es2022', external: ['cloudflare:workers'], tsconfig: path.join(root, 'tsconfig.json'),
  });
  const posts = [], uploads = [];
  let postStatus = 'scheduled', postMode = 'ok', igActive = true;
  const mf = new Miniflare({
    modules: true, script: outputFiles[0].text, compatibilityDate: '2026-05-15', d1Databases: ['DB'], r2Buckets: ['BUCKET'],
    bindings: { SETTINGS_ENCRYPTION_KEY: Buffer.alloc(32, 9).toString('base64') },
    outboundService: async request => {
      const url = new URL(request.url);
      if (url.hostname === 'upload.test') { uploads.push((await request.arrayBuffer()).byteLength); return new Response(null, { status: 200 }); }
      if (request.headers.get('authorization') !== 'Bearer key-a') return Response.json({ error: 'bad key' }, { status: 401 });
      if (url.pathname === '/api/v1/media/presign') return Response.json({ uploadUrl: 'https://upload.test/x', publicUrl: 'https://cdn.test/x.png' });
      if (url.pathname === '/api/v1/posts' && request.method === 'POST') {
        posts.push({ key: request.headers.get('idempotency-key'), body: await request.json() });
        if (postMode === 'refused') return Response.json({ error: 'Media rejected' }, { status: 422 });
        if (postMode === 'down') return Response.json({ error: 'busy' }, { status: 503 });
        return Response.json({ post: { _id: `z-${posts.length}` } });
      }
      if (url.pathname.startsWith('/api/v1/posts/')) return Response.json({ post: { status: postStatus, platforms: [] } });
      if (url.pathname === '/api/v1/analytics/dashboard' && url.searchParams.get('profileId') === 'zp') return Response.json({ followers: { current: 1240, gained: 3, byAccount: [{ accountId: 'th-acc', platform: 'threads', current: 240 }, { accountId: 'ig-acc', platform: 'instagram', current: 1000 }] } });
      if (url.pathname === '/api/v1/accounts' && url.searchParams.get('profileId') === 'zp') return Response.json({ accounts: [{ _id: 'ig-acc', platform: 'instagram', isActive: igActive }, { _id: 'th-acc', platform: 'threads', isActive: true }] });
      return Response.json({ error: 'unexpected' }, { status: 404 });
    },
  });
  t.after(() => mf.dispose());
  const db = await mf.getD1Database('DB');
  for (const file of (await readdir(path.join(root, 'drizzle'))).filter(file => file.endsWith('.sql')).sort()) {
    const sql = (await readFile(path.join(root, 'drizzle', file), 'utf8')).replaceAll('--> statement-breakpoint', '');
    for (const statement of sql.split(';').map(value => value.trim()).filter(Boolean)) await db.prepare(statement).run();
  }
  await db.prepare("INSERT INTO profiles (id, owner, name, createdAt) VALUES ('11111111-1111-4111-8111-111111111111', 'owner', 'Alice', '2026-01-01'), ('22222222-2222-4222-8222-222222222222', 'intruder', 'x', '2026-01-01')").run();
  const P = '11111111-1111-4111-8111-111111111111';
  await db.prepare(`INSERT INTO channels (id, profileId, slot, platform, accountId, username, state, createdAt) VALUES ('c1', '${P}', 0, 'instagram', 'ig-acc', 'alice', 'connected', 'x'), ('c2', '${P}', 1, 'threads', 'th-acc', 'alice', 'connected', 'x')`).run();
  const call = async body => { const r = await mf.dispatchFetch('http://test', { method: 'POST', body: JSON.stringify({ owner: 'owner', ...body }) }); return { status: r.status, ...await r.json() }; };
  await call({ action: 'key', profileId: P, token: 'key-a' });
  const now = Date.parse('2026-11-10T06:00:00Z');

  // A connected profile with a key and no persona is waiting to be set up.
  assert.deepEqual((await call({ action: 'onboard' })).profiles.map(item => [item.name, item.city]), [['Alice', null]]);
  assert.deepEqual((await call({ owner: 'intruder', action: 'onboard' })).profiles, []);
  // Nothing runs without a persona and an explicit switch.
  assert.equal((await call({ action: 'plan', profileId: P, kind: 'threads', now })).status, 400);
  assert.equal((await call({ action: 'persona', profileId: P, persona: '{"no":"name"}' })).status, 400);
  assert.equal((await call({ action: 'persona', profileId: P, persona: JSON.stringify({ name: 'Алиса', age: 24, style: 'iphone' }) })).ok, true);
  assert.equal((await call({ action: 'plan', profileId: P, kind: 'threads', now })).status, 400, 'still off');
  assert.equal((await call({ owner: 'intruder', action: 'enabled', profileId: P, enabled: true })).status, 404);
  assert.equal((await call({ action: 'enabled', profileId: P, enabled: true })).enabled, true);
  const engine = (await call({ action: 'engine' })).profiles;
  assert.deepEqual(engine[0].kinds, ['threads', 'story', 'post', 'reel']);

  // Planning: one active item per kind.
  const threads = await call({ action: 'plan', profileId: P, kind: 'threads', now });
  assert.equal((await call({ action: 'plan', profileId: P, kind: 'threads', now })).id, threads.id, 'no duplicate plan');
  const story = await call({ action: 'plan', profileId: P, kind: 'story', now });
  assert.ok(Date.parse(story.dueAt) > now && Date.parse(story.dueAt) <= now + 2 * 60_000, 'the first one of a kind goes out right away');
  // Regularity is set per profile and used for everything after the first.
  assert.equal((await call({ action: 'rhythm', profileId: P, rhythm: { threads: { minDays: 3, maxDays: 2 }, story: { minDays: 1, maxDays: 1 }, post: { minDays: 5, maxDays: 8 } } })).status, 400);
  assert.equal((await call({ owner: 'intruder', action: 'rhythm', profileId: P, rhythm: {} })).status, 404);
  const set = await call({ action: 'rhythm', profileId: P, rhythm: { threads: { minDays: 1, maxDays: 2 }, story: { minDays: 1, maxDays: 1 }, post: { minDays: 5, maxDays: 8 } } });
  assert.deepEqual([set.rhythm.post.minDays, set.rhythm.post.maxDays, set.rhythm.post.weekend, set.rhythm.post.windows.length], [5, 8, false, 1]);
  assert.equal((await call({ action: 'rhythm', profileId: P, rhythm: { threads: { perDay: 13 }, story: { perDay: 1 }, post: { perDay: 1 } } })).status, 400);
  const daily = await call({ action: 'rhythm', profileId: P, rhythm: { threads: { perDay: 3 }, story: { minDays: 1, maxDays: 1 }, post: { minDays: 5, maxDays: 8 } } });
  assert.deepEqual([daily.rhythm.threads.perDay, daily.rhythm.story.perDay], [3, null]);
  assert.equal(daily.rhythm.reel.perDay, 5, 'a kind left out of the form keeps its rhythm: 5 trial reels a day');
  const reels = await call({ action: 'rhythm', profileId: P, rhythm: { threads: { perDay: 3 }, story: { minDays: 1, maxDays: 1 }, post: { minDays: 5, maxDays: 8 }, reel: { perDay: 7 } } });
  assert.equal(reels.rhythm.reel.perDay, 7);
  assert.deepEqual((await call({ action: 'onboard' })).profiles, [], 'a profile with a persona is not onboarded again');

  // Generation lock: one claim wins; a story cannot be finished without its picture.
  assert.equal((await call({ action: 'claim', id: story.id })).claimed, true);
  assert.equal((await call({ action: 'claim', id: story.id })).claimed, false);
  assert.equal((await call({ action: 'complete', id: story.id, text: null })).status, 400);
  assert.equal((await call({ action: 'image', id: story.id, type: 'image/svg+xml', bytes: [1, 2] })).status, 400);
  assert.equal((await call({ owner: 'intruder', action: 'image', id: story.id, type: 'image/png', bytes: [1, 2] })).status, 404);
  assert.equal((await call({ action: 'image', id: story.id, type: 'image/png', bytes: [137, 80, 78, 71, 1, 2, 3] })).ok, true);
  assert.equal((await call({ action: 'complete', id: story.id, imagePrompt: 'a bowl' })).ok, true);

  // Publishing a story: picture uploaded to Zernio, story flag set, planned time kept, idempotent key.
  assert.equal((await call({ action: 'publish', id: story.id, now })).ok, true);
  const storyPost = posts.at(-1);
  assert.equal(storyPost.key, `autopilot-${story.id}`);
  assert.deepEqual(storyPost.body.platforms, [{ platform: 'instagram', accountId: 'ig-acc', platformSpecificData: { contentType: 'story' } }]);
  assert.equal(storyPost.body.mediaItems[0].url, 'https://cdn.test/x.png');
  assert.deepEqual([storyPost.body.publishNow, storyPost.body.scheduledFor], [true, undefined], 'a first post is published immediately');
  assert.equal(storyPost.body.isAiGenerated, undefined);
  assert.equal(uploads.at(-1), 7);
  assert.equal((await call({ action: 'publish', id: story.id, now })).status, 409, 'not sent twice');

  // Threads: text only; an uncertain Zernio answer is retried, a refusal ends the item.
  await call({ action: 'claim', id: threads.id });
  assert.equal((await call({ action: 'complete', id: threads.id, text: '' })).status, 400);
  assert.equal((await call({ action: 'complete', id: threads.id, text: 'постирала постельное' })).ok, true);
  postMode = 'down';
  assert.equal((await call({ action: 'publish', id: threads.id, now })).status, 502);
  assert.equal((await call({ action: 'read', profileId: P })).items.find(item => item.id === threads.id).status, 'ready', 'kept for a retry');
  postMode = 'ok';
  assert.equal((await call({ action: 'publish', id: threads.id, now })).ok, true);
  assert.equal(posts.at(-1).key, posts.at(-2).key, 'retry reuses the idempotency key');
  assert.deepEqual(posts.at(-1).body.platforms, [{ platform: 'threads', accountId: 'th-acc' }]);
  assert.equal(posts.at(-1).body.content, 'постирала постельное');
  assert.equal(posts.at(-1).body.mediaItems, undefined);

  // A late item is never scheduled in the past.
  const post = await call({ action: 'plan', profileId: P, kind: 'post', now });
  await call({ action: 'claim', id: post.id });
  await call({ action: 'image', id: post.id, type: 'image/png', bytes: [1] });
  await call({ action: 'complete', id: post.id, text: 'первые мандарины' });
  const late = Date.parse(post.dueAt) + 3600_000;
  postMode = 'refused';
  assert.equal((await call({ action: 'publish', id: post.id, now: late })).status, 502);
  assert.equal((await call({ action: 'read', profileId: P })).items.find(item => item.id === post.id).status, 'failed');
  assert.equal(posts.at(-1).body.publishNow, true, 'a post the computer slept through goes out at once');
  postMode = 'ok';

  // Failures: retried up to three attempts, then given up.
  const next = await call({ action: 'plan', profileId: P, kind: 'post', now: late });
  for (let attempt = 1; attempt <= 3; attempt++) {
    await db.prepare("UPDATE autopilot_items SET status = 'planned' WHERE id = ?").bind(next.id).run();
    await call({ action: 'claim', id: next.id });
    const result = await call({ action: 'fail', id: next.id, error: 'bridge down' });
    assert.equal(result.finished, attempt === 3);
  }

  // Stock: a prepared post is used instead of generating, oldest first, and never shows up as the plan.
  assert.equal((await call({ owner: 'intruder', action: 'stock', profileId: P, kind: 'post', text: 'x' })).status, 404);
  const stocked = await call({ action: 'stock', profileId: P, kind: 'post', text: 'двор' });
  await call({ action: 'image', id: stocked.id, type: 'image/png', bytes: [9, 9] });
  // A carousel: more pictures beside the first, within the limit, posts only.
  assert.equal((await call({ action: 'image', id: stocked.id, type: 'image/png', bytes: [8, 8, 8], n: 1 })).ok, true);
  assert.equal((await call({ action: 'image', id: stocked.id, type: 'image/png', bytes: [7], n: 2 })).ok, true);
  assert.equal((await call({ action: 'image', id: stocked.id, type: 'image/png', bytes: [7], n: 10 })).status, 400);
  const due = await call({ action: 'plan', profileId: P, kind: 'post', now: late + 60 * 86_400_000 });
  assert.notEqual(due.id, stocked.id, 'stock is not the plan');
  await call({ action: 'claim', id: due.id });
  assert.equal((await call({ action: 'takeStock', id: due.id })).used, true);
  const taken = (await call({ action: 'read', profileId: P })).items;
  assert.deepEqual([taken.find(item => item.id === due.id).status, taken.find(item => item.id === due.id).text, taken.some(item => item.id === stocked.id)], ['ready', 'двор', false]);
  uploads.length = 0;
  assert.equal((await call({ action: 'publish', id: due.id, now: late + 60 * 86_400_000 })).ok, true);
  assert.deepEqual(uploads, [2, 3, 1], 'every slide is uploaded in order');
  assert.equal(posts.at(-1).body.mediaItems.length, 3);
  assert.equal(posts.at(-1).body.content, 'двор');
  const empty = await call({ action: 'plan', profileId: P, kind: 'threads', now: late });
  assert.equal(empty.id, threads.id);

  // Trial reel: one MP4, sent as a trial reel that never moves to the followers' feed by itself.
  const reel = await call({ action: 'plan', profileId: P, kind: 'reel', now });
  await call({ action: 'claim', id: reel.id });
  assert.equal((await call({ action: 'image', id: reel.id, type: 'image/png', bytes: [1] })).status, 400, 'a reel needs a video');
  assert.equal((await call({ action: 'complete', id: reel.id, text: 'x' })).status, 400, 'not finished without the video');
  assert.equal((await call({ action: 'image', id: reel.id, type: 'video/mp4', bytes: [0, 0, 0, 24, 102, 116, 121, 112] })).ok, true);
  assert.equal((await call({ action: 'complete', id: reel.id, text: '1 ball vs 1,000 👇 #physics', imagePrompt: 'reel:race:42' })).ok, true);
  uploads.length = 0;
  assert.equal((await call({ action: 'publish', id: reel.id, now })).ok, true);
  const reelPost = posts.at(-1);
  assert.deepEqual(reelPost.body.platforms, [{ platform: 'instagram', accountId: 'ig-acc', platformSpecificData: { trialParams: { graduationStrategy: 'MANUAL' } } }]);
  assert.deepEqual(reelPost.body.mediaItems, [{ type: 'video', url: 'https://cdn.test/x.png' }]);
  assert.equal(reelPost.body.content, '1 ball vs 1,000 👇 #physics');
  assert.deepEqual(uploads, [8], 'the video file itself is uploaded');

  // Sync marks what Zernio published; skipping works only before Zernio has it.
  postStatus = 'published';
  assert.ok((await call({ action: 'sync', now: Date.parse(story.dueAt) + 3600_000 })).updated >= 1);
  const items = (await call({ action: 'read', profileId: P })).items;
  assert.equal(items.find(item => item.id === story.id).status, 'published');
  assert.equal(items.find(item => item.id === story.id).hasImage, true);
  assert.deepEqual([items.find(item => item.id === reel.id).status, items.find(item => item.id === reel.id).hasImage], ['published', false], 'a published reel video is removed from storage');
  assert.equal((await call({ action: 'skip', id: threads.id })).status, 400);
  assert.equal((await call({ owner: 'intruder', action: 'read', profileId: P })).status, 404);

  // An account Zernio switched off is paused by itself and comes back after a reconnect.
  await db.prepare(`UPDATE profiles SET zernioId = 'zp' WHERE id = '${P}'`).run();
  const state = async () => (await db.prepare("SELECT state FROM channels WHERE id = 'c1'").first()).state;
  igActive = false;
  assert.deepEqual((await call({ action: 'sync' })).accounts, [{ profileId: P, platform: 'instagram', state: 'inactive' }]);
  assert.equal(await state(), 'inactive');
  assert.deepEqual((await call({ action: 'sync' })).accounts, [], 'reported once');
  await db.prepare("UPDATE channels SET state = 'disconnected' WHERE id = 'c2'").run();
  igActive = true;
  assert.deepEqual((await call({ action: 'sync' })).accounts, [{ profileId: P, platform: 'instagram', state: 'connected' }]);
  assert.equal((await db.prepare("SELECT state FROM channels WHERE id = 'c2'").first()).state, 'disconnected', 'an unresolved choice stays off');

  // Trial reels need 1,000 Instagram followers: the count is the Instagram account's own, not Threads or the total.
  assert.deepEqual((await call({ action: 'reels' })).profiles, [{ profileId: P, followers: 1000 }]);
  assert.deepEqual((await call({ owner: 'intruder', action: 'reels' })).profiles, []);
});
