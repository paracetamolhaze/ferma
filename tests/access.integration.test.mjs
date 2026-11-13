import test from 'node:test';
import assert from 'node:assert/strict';
import { build } from 'esbuild';
import { Miniflare } from 'miniflare';
import { readFile, readdir } from 'node:fs/promises';
import path from 'node:path';
import { normalizeTotpSecret, parseBackupCodes, totpCode } from '../lib/totp.ts';

const root = path.resolve(import.meta.dirname, '..');
// RFC 6238 test secret "12345678901234567890" in base32.
const RFC_SECRET = 'GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ';

test('app codes match RFC 6238 and keys are read in every common form', async () => {
  assert.equal((await totpCode(RFC_SECRET, 59_000)).code, '287082');
  assert.equal((await totpCode(RFC_SECRET, 1_111_111_109_000)).code, '081804');
  assert.equal((await totpCode(RFC_SECRET, 1_234_567_890_000)).code, '005924');
  assert.equal((await totpCode(RFC_SECRET, 61_000)).remaining, 29);
  assert.equal(normalizeTotpSecret('gezd gnbv gy3t qojq gezd gnbv gy3t qojq'), RFC_SECRET);
  assert.equal(normalizeTotpSecret(`otpauth://totp/Instagram:me?secret=${RFC_SECRET}&issuer=Instagram`), RFC_SECRET);
  for (const bad of ['', 'short', 'ABCDEFGH01890189', 'otpauth://totp/x?issuer=y']) assert.throws(() => normalizeTotpSecret(bad), bad);
});

test('backup codes are taken from the text platforms give', () => {
  assert.deepEqual(parseBackupCodes('1. 1234 5678\n2. 8765 4321\n\n3. 1234 5678'), ['1234 5678', '8765 4321']);
  assert.deepEqual(parseBackupCodes('48291037\t59302847\n12345678  87654321'), ['48291037', '59302847', '12345678', '87654321']);
  assert.deepEqual(parseBackupCodes('Instagram backup codes'), []);
});

test('secrets stay encrypted and per owner; 5SIM numbers are bought cheaply but reliably', { timeout: 90000 }, async t => {
  const { outputFiles } = await build({
    stdin: { contents: `
      import * as fivesim from './lib/fivesim';
      import * as security from './lib/security';
      export default { async fetch(request) {
        const i = await request.json();
        try {
          if (i.action === 'key') return Response.json(await fivesim.saveFivesimKey(i.owner, i.apiKey));
          if (i.action === 'offer') return Response.json({ offer: await fivesim.bestOffer(i.product) });
          if (i.action === 'buy') return Response.json(await fivesim.buyNumber(i.owner, i.profileId, i.product));
          if (i.action === 'update') return Response.json(await fivesim.updateOrder(i.owner, i.id, i.kind));
          if (i.action === 'orders') return Response.json({ orders: await fivesim.listOrders(i.owner, i.profileId) });
          if (i.action === 'totp') return Response.json(await security.saveTotp(i.owner, i.profileId, i.platform, i.secret));
          if (i.action === 'backup') return Response.json(await security.saveBackupCodes(i.owner, i.profileId, i.platform, i.text));
          if (i.action === 'reveal') return Response.json({ codes: await security.revealBackupCodes(i.owner, i.profileId, i.platform) });
          if (i.action === 'mark') return Response.json({ codes: await security.markBackupCode(i.owner, i.profileId, i.platform, i.code, i.used) });
          if (i.action === 'remove') return Response.json(await security.removeSecurity(i.owner, i.profileId, i.platform));
          return Response.json({ entries: await security.readSecurity(i.owner, i.profileId) });
        } catch (error) { return Response.json({ error: error.message }, { status: error.status || 500 }); }
      }};`, resolveDir: root, loader: 'ts' },
    bundle: true, write: false, format: 'esm', platform: 'browser', target: 'es2022', external: ['cloudflare:workers'], tsconfig: path.join(root, 'tsconfig.json'),
  });
  const calls = [];
  let buyMode = 'ok', sms = [];
  const mf = new Miniflare({
    modules: true, script: outputFiles[0].text, compatibilityDate: '2026-05-15', d1Databases: ['DB'],
    bindings: { SETTINGS_ENCRYPTION_KEY: Buffer.alloc(32, 9).toString('base64') },
    outboundService: async request => {
      const url = new URL(request.url);
      calls.push({ path: url.pathname + url.search, auth: request.headers.get('authorization') });
      if (url.pathname === '/v1/guest/prices') return Response.json({ instagram: {
        cheapbad: { virtual1: { cost: 0.01, count: 500, rate: 10 }, virtual2: { cost: 0.02, count: 9, rate: undefined } },
        philippines: { virtual4: { cost: 0.2, count: 25000, rate: 72.7 } },
        usa: { virtual51: { cost: 0.3, count: 10, rate: 75.6 }, empty: { cost: 0.1, count: 0, rate: 99 } },
      } });
      if (request.headers.get('authorization') !== 'Bearer good-key-123') return new Response('Unauthorized', { status: 401 });
      if (url.pathname === '/v1/user/profile') return Response.json({ id: 1, email: 'x', balance: 3.5, rating: 96 });
      const order = (status, list = []) => ({ id: 777, phone: '+639171234567', operator: 'virtual4', product: 'instagram', price: 0.2, status, expires: new Date(Date.now() + 900000).toISOString(), sms: list, created_at: new Date().toISOString(), country: 'philippines' });
      if (url.pathname.startsWith('/v1/user/buy/activation/')) {
        if (buyMode === 'nophones') return new Response('no free phones', { status: 200 });
        return Response.json(order('PENDING'));
      }
      if (url.pathname === '/v1/user/check/777') return Response.json(order(sms.length ? 'RECEIVED' : 'PENDING', sms));
      if (url.pathname === '/v1/user/finish/777') return Response.json(order('FINISHED', sms));
      if (url.pathname === '/v1/user/cancel/777') return sms.length ? new Response('order has sms', { status: 400 }) : Response.json(order('CANCELED'));
      return new Response('unexpected', { status: 404 });
    },
  });
  t.after(() => mf.dispose());
  const db = await mf.getD1Database('DB');
  for (const file of (await readdir(path.join(root, 'drizzle'))).filter(file => file.endsWith('.sql')).sort()) {
    const sql = (await readFile(path.join(root, 'drizzle', file), 'utf8')).replaceAll('--> statement-breakpoint', '');
    for (const statement of sql.split(';').map(value => value.trim()).filter(Boolean)) await db.prepare(statement).run();
  }
  await db.prepare("INSERT INTO profiles (id, owner, name, createdAt) VALUES ('a', 'owner', 'a', '2026-01-01'), ('b', 'owner', 'b', '2026-01-01'), ('foreign', 'intruder', 'x', '2026-01-01')").run();
  const call = async body => { const r = await mf.dispatchFetch('http://test', { method: 'POST', body: JSON.stringify({ owner: 'owner', ...body }) }); return { status: r.status, ...await r.json() }; };

  // Two-factor: the key is stored encrypted, the code is shown, nothing crosses owners or profiles.
  const saved = await call({ action: 'totp', profileId: 'a', platform: 'instagram', secret: RFC_SECRET });
  assert.match(saved.code, /^\d{6}$/);
  assert.equal((await call({ action: 'totp', profileId: 'a', platform: 'instagram', secret: 'nonsense' })).status, 400);
  assert.equal((await call({ action: 'totp', profileId: 'a', platform: 'myspace', secret: RFC_SECRET })).status, 400);
  assert.equal((await call({ action: 'totp', profileId: 'foreign', platform: 'instagram', secret: RFC_SECRET })).status, 404);
  assert.equal((await call({ owner: 'intruder', action: 'read', profileId: 'a' })).status, 404);
  assert.equal((await call({ action: 'backup', profileId: 'a', platform: 'instagram', text: '1. 1111 2222\n2. 3333 4444' })).saved, 2);
  assert.equal((await call({ action: 'backup', profileId: 'a', platform: 'instagram', text: 'nothing' })).status, 400);
  const stored = JSON.stringify(await db.prepare('SELECT * FROM profile_secrets').all());
  assert.ok(!stored.includes(RFC_SECRET) && !stored.includes('1111 2222'));
  // A row copied to another profile does not decrypt there.
  await db.prepare("INSERT INTO profile_secrets (id, owner, profileId, platform, encryptedTotp, updatedAt) SELECT 'copy', owner, 'b', platform, encryptedTotp, updatedAt FROM profile_secrets WHERE profileId = 'a'").run();
  assert.equal((await call({ action: 'read', profileId: 'b' })).status, 500);
  await db.prepare("DELETE FROM profile_secrets WHERE id = 'copy'").run();
  const [entry] = (await call({ action: 'read', profileId: 'a' })).entries;
  assert.deepEqual([entry.platform, entry.backupTotal, entry.backupLeft, Object.keys(entry).includes('encryptedTotp')], ['instagram', 2, 2, false]);
  assert.equal(entry.totp.code, (await totpCode(RFC_SECRET)).code);
  assert.deepEqual((await call({ action: 'mark', profileId: 'a', platform: 'instagram', code: '1111 2222', used: true })).codes.map(item => item.used), [true, false]);
  assert.equal((await call({ action: 'read', profileId: 'a' })).entries[0].backupLeft, 1);
  assert.equal((await call({ action: 'remove', profileId: 'a', platform: 'instagram' })).ok, true);
  assert.deepEqual((await call({ action: 'read', profileId: 'a' })).entries, []);

  // 5SIM: cheapest offer that still delivers, never the unreliable or empty ones.
  assert.deepEqual((await call({ action: 'offer', product: 'instagram' })).offer, { country: 'philippines', operator: 'virtual4', cost: 0.2, rate: 72.7 });
  assert.equal((await call({ action: 'offer', product: 'myspace' })).status, 400);
  assert.equal((await call({ action: 'buy', profileId: 'a', product: 'instagram' })).status, 400, 'no key yet');
  assert.match((await call({ action: 'key', apiKey: 'bad-key-123' })).error, /не принял ключ/);
  assert.equal((await call({ action: 'key', apiKey: 'good-key-123' })).balance, 3.5);
  assert.ok(!JSON.stringify(await db.prepare('SELECT * FROM fivesim_settings').all()).includes('good-key-123'));

  buyMode = 'nophones';
  assert.match((await call({ action: 'buy', profileId: 'a', product: 'instagram' })).error, /нет свободных номеров/);
  buyMode = 'ok';
  assert.equal((await call({ action: 'buy', profileId: 'foreign', product: 'instagram' })).status, 404);
  const bought = await call({ action: 'buy', profileId: 'a', product: 'instagram' });
  assert.deepEqual([bought.phone, bought.status, bought.code], ['+639171234567', 'PENDING', null]);
  assert.ok(calls.at(-1).path.endsWith('/user/buy/activation/philippines/virtual4/instagram'));
  assert.equal((await call({ action: 'update', id: '777', kind: 'check' })).code, null);
  sms = [{ created_at: 'x', date: 'x', sender: 'Instagram', text: '482913 is your Instagram code', code: null }];
  assert.equal((await call({ action: 'update', id: '777', kind: 'check' })).code, '482913', 'code found in the text when 5SIM gives none');
  assert.match((await call({ action: 'update', id: '777', kind: 'cancel' })).error, /уже пришла СМС/);
  assert.equal((await call({ action: 'update', id: '777', kind: 'finish' })).status, 'FINISHED');
  assert.equal((await call({ owner: 'intruder', action: 'update', id: '777', kind: 'check' })).status, 404);
  const orders = (await call({ action: 'orders', profileId: 'a' })).orders;
  assert.deepEqual([orders.length, orders[0].code, orders[0].status], [1, '482913', 'FINISHED']);
  assert.deepEqual((await call({ action: 'orders', profileId: 'b' })).orders, []);
});
