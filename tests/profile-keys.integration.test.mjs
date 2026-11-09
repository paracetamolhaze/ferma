import test from 'node:test';
import assert from 'node:assert/strict';
import { build } from 'esbuild';
import { Miniflare } from 'miniflare';
import { readFile, readdir, mkdir } from 'node:fs/promises';
import path from 'node:path';

test('D1 isolates profile credentials, rejects duplicates and never falls back to a global key', { timeout: 60000 }, async t => {
  const root = path.resolve(import.meta.dirname, '..');
  await mkdir(path.join(root, 'work'), { recursive: true });
  const { outputFiles } = await build({
    stdin: { contents: `
      import { readZernioKey, saveZernioKey } from './lib/integration-settings';
      import { createZernioClient } from './lib/zernio';
      export default { async fetch(request) {
        const input = await request.json();
        try {
          if (input.action === 'save') { await saveZernioKey(input.owner, input.profileId, input.token, input.resetBinding); return Response.json({ ok: true }); }
          if (input.action === 'call') { const client = await createZernioClient(input.owner, input.profileId); return Response.json(await client(input.path)); }
          return Response.json({ token: await readZernioKey(input.owner, input.profileId) });
        } catch (error) { return Response.json({ error: error.message }, { status: 400 }); }
      }};`, resolveDir: root, loader: 'ts' },
    bundle: true, write: false, format: 'esm', platform: 'browser', target: 'es2022', external: ['cloudflare:workers'], tsconfig: path.join(root, 'tsconfig.json'),
  });
  const outbound = [];
  const mf = new Miniflare({
    modules: true, script: outputFiles[0].text, compatibilityDate: '2026-05-15',
    d1Databases: ['DB'], bindings: { SETTINGS_ENCRYPTION_KEY: Buffer.alloc(32, 9).toString('base64'), ZERNIO_API_KEY: 'legacy-global-key' },
    outboundService: async request => { outbound.push({ path: new URL(request.url).pathname, token: request.headers.get('authorization') }); return Response.json({ ok: true }); },
  });
  t.after(() => mf.dispose());
  const db = await mf.getD1Database('DB');
  for (const file of (await readdir(path.join(root, 'drizzle'))).filter(file => file.endsWith('.sql')).sort()) {
    const sql = (await readFile(path.join(root, 'drizzle', file), 'utf8')).replaceAll('--> statement-breakpoint', '');
    for (const statement of sql.split(';').map(value => value.trim()).filter(Boolean)) await db.prepare(statement).run();
  }
  for (const id of ['a', 'b', 'empty']) await db.prepare('INSERT INTO profiles (id, owner, name, createdAt) VALUES (?, ?, ?, ?)').bind(id, 'owner', id, '2026-01-01').run();
  async function call(body) {
    const response = await mf.dispatchFetch('http://test', { method: 'POST', body: JSON.stringify({ owner: 'owner', ...body }) });
    return { status: response.status, ...await response.json() };
  }
  assert.equal((await call({ action: 'read', profileId: 'empty' })).token, '');
  assert.equal((await call({ action: 'save', profileId: 'a', token: 'key-a' })).status, 200);
  assert.equal((await call({ action: 'save', profileId: 'b', token: 'key-a' })).status, 400);
  assert.equal((await call({ action: 'save', profileId: 'b', token: 'key-b' })).status, 200);
  assert.equal((await call({ action: 'read', owner: 'intruder', profileId: 'a' })).token, '');
  assert.equal((await call({ action: 'save', owner: 'intruder', profileId: 'a', token: 'stolen' })).status, 400);
  assert.equal((await call({ action: 'call', profileId: 'empty', path: '/posts' })).status, 400);
  assert.equal(outbound.length, 0);
  await call({ action: 'call', profileId: 'a', path: '/connect/youtube' });
  await call({ action: 'call', profileId: 'b', path: '/media/presign' });
  assert.deepEqual(outbound.map(item => item.token), ['Bearer key-a', 'Bearer key-b']);
  await db.prepare("INSERT INTO posts (id,owner,profileId,title,status,createdAt) VALUES ('in-flight','owner','a','test','sending','2026-01-01')").run();
  await db.prepare("UPDATE profiles SET zernioId='remote-a' WHERE id='a'").run();
  assert.equal((await call({ action:'save', profileId:'a', token:'blocked-key', resetBinding:true })).status,400);
  assert.equal((await call({ action:'read', profileId:'a' })).token,'key-a');
  assert.equal((await db.prepare("SELECT zernioId FROM profiles WHERE id='a'").first()).zernioId,'remote-a');
  await db.prepare("UPDATE posts SET status='scheduled' WHERE id='in-flight'").run();
  assert.equal((await call({ action: 'save', profileId: 'a', token: 'replacement-a' })).status, 200);
  assert.equal((await call({ action: 'read', profileId: 'a' })).token, 'replacement-a');
  assert.equal((await call({ action: 'read', profileId: 'b' })).token, 'key-b');
  const rows = await db.prepare('SELECT encryptedKey FROM profile_integrations').all();
  assert.equal(rows.results.length, 2);
  assert.ok(rows.results.every(row => row.encryptedKey.startsWith('v1.') && !row.encryptedKey.includes('key-')));
});
