import test from 'node:test';
import assert from 'node:assert/strict';
import { build } from 'esbuild';
import { Miniflare } from 'miniflare';
import { readFile, readdir } from 'node:fs/promises';
import path from 'node:path';

test('imports existing Zernio accounts without OAuth or remote writes and reconciles changes', { timeout: 90000 }, async t => {
  const root = path.resolve(import.meta.dirname, '..');
  const bundle = await build({ stdin: { contents: `
    import { saveZernioKey } from './lib/integration-settings';
    import { importSocialAccounts } from './lib/social-import';
    export default { async fetch(request) {
      const input = await request.json();
      try {
        if (input.action === 'save') { await saveZernioKey('owner', input.id, input.token); return Response.json({ok:true}); }
        return Response.json(await importSocialAccounts(input.owner || 'owner', input.id, input.selection));
      } catch(error) { return Response.json({error:error.message},{status:400}); }
    }};`, resolveDir: root, loader: 'ts' }, bundle: true, write: false, format: 'esm', platform: 'browser', target: 'es2022', external: ['cloudflare:workers'], tsconfig: path.join(root, 'tsconfig.json') });
  let remoteProfiles = [{ _id: 'remote-a', name: 'Existing Zernio profile' }];
  let remoteAccounts = [
    { _id: 'yt', platform: 'youtube', username: 'my-channel', profileId: { _id: 'remote-a' }, isActive: true },
    { _id: 'tt', platform: 'tiktok', username: 'my-tiktok', profileId: 'remote-a', isActive: true },
    { _id: 'foreign', platform: 'instagram', username: 'another-client', profileId: 'remote-b', isActive: true },
    { _id: 'unsupported', platform: 'linkedin', username: 'ignored', profileId: 'remote-a', isActive: true },
  ];
  let malformed = false;
  const requests = [];
  const mf = new Miniflare({ modules: true, script: bundle.outputFiles[0].text, compatibilityDate: '2026-05-15', d1Databases: ['DB'], bindings: { SETTINGS_ENCRYPTION_KEY: Buffer.alloc(32, 7).toString('base64') }, outboundService: async request => {
    requests.push({ method: request.method, url: request.url });
    const url = new URL(request.url);
    if (url.pathname === '/api/v1/profiles') return Response.json({ profiles: remoteProfiles });
    assert.equal(url.searchParams.get('profileId'), 'remote-a');
    return Response.json(malformed ? { invalid: [] } : { accounts: remoteAccounts });
  }});
  t.after(() => mf.dispose());
  const db = await mf.getD1Database('DB');
  for (const file of (await readdir(path.join(root, 'drizzle'))).filter(file => file.endsWith('.sql')).sort()) {
    const sql = (await readFile(path.join(root, 'drizzle', file), 'utf8')).replaceAll('--> statement-breakpoint', '');
    for (const statement of sql.split(';').map(value => value.trim()).filter(Boolean)) await db.prepare(statement).run();
  }
  for (const id of ['a', 'b']) await db.prepare('INSERT INTO profiles(id,owner,name,createdAt) VALUES(?,?,?,?)').bind(id,'owner',id,'2026-01-01').run();
  const call = async body => { const response = await mf.dispatchFetch('http://test', { method: 'POST', body: JSON.stringify({ id: 'a', ...body }) }); return { httpStatus: response.status, ...await response.json() }; };
  const channels = async () => (await db.prepare('SELECT * FROM channels WHERE profileId=? ORDER BY slot').bind('a').all()).results;
  await call({ action: 'save', token: 'test-a' });
  assert.equal((await call({})).imported, 2);
  const original = await channels();
  assert.deepEqual(original.map(row => row.accountId), ['yt','tt']);
  await call({});
  assert.deepEqual((await channels()).map(row => row.id), original.map(row => row.id));
  remoteAccounts = [{ _id:'yt', platform:'youtube', username:'renamed-channel', profileId:'remote-a', isActive:false }];
  await call({});
  assert.equal((await channels()).length, 1);
  assert.equal((await channels())[0].state, 'disconnected');
  assert.equal((await channels())[0].username, 'renamed-channel');
  malformed = true;
  assert.equal((await call({})).httpStatus, 400);
  assert.equal((await channels()).length, 1);
  malformed = false;
  remoteAccounts = ['youtube','tiktok','instagram'].map((platform,i) => ({ _id:`account-${i}`, platform, profileId:'remote-a', isActive:true }));
  assert.equal((await call({})).status, 'chooseAccounts');
  assert.equal((await call({ selection:{ accountIds:['account-0','account-2'] } })).imported, 2);
  await call({});
  assert.deepEqual((await channels()).map(row => row.platform), ['youtube','instagram']);
  assert.equal((await call({ owner:'intruder' })).httpStatus, 400);
  remoteAccounts=[];
  assert.equal((await call({})).imported, 0);
  assert.equal((await channels()).length, 0);
  await call({ action:'save', id:'b', token:'test-b' });
  remoteProfiles.push({_id:'remote-b',name:'Second profile'});
  assert.equal((await call({id:'b'})).status, 'chooseProfile');
  assert.equal((await call({id:'b',selection:{remoteProfileId:'remote-a'}})).httpStatus, 400);
  assert.ok(requests.length > 0);
  assert.ok(requests.every(request => request.method === 'GET' && !request.url.includes('/connect/')));
});
