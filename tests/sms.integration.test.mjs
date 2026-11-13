import test from 'node:test';
import assert from 'node:assert/strict';
import { createHmac } from 'node:crypto';
import { build } from 'esbuild';
import { Miniflare } from 'miniflare';
import { readFile, readdir } from 'node:fs/promises';
import path from 'node:path';

const root = path.resolve(import.meta.dirname, '..');
const SIGNING_KEY = 'test-signing-key';
const API_TOKEN = 'test-api-token';

test('a signed SMS reaches only the profile of its number, through the real receiver', { timeout: 90000 }, async t => {
  const receiver = new Miniflare({
    modules: true, script: await readFile(path.join(root, 'sms-worker/index.mjs'), 'utf8'), compatibilityDate: '2025-07-15',
    d1Databases: ['DB'], bindings: { SIGNING_KEY, API_TOKEN },
  });
  t.after(() => receiver.dispose());
  const receiverDb = await receiver.getD1Database('DB');
  for (const statement of (await readFile(path.join(root, 'sms-worker/schema.sql'), 'utf8')).split(';').map(value => value.trim()).filter(Boolean)) await receiverDb.prepare(statement).run();

  const event = (id, payload, name = 'sms:received') => JSON.stringify({ deviceId: 'device-1', event: name, id, payload, webhookId: 'w1' });
  const send = (body, { key = SIGNING_KEY, timestamp = Math.floor(Date.now() / 1000), signature } = {}) => receiver.dispatchFetch('https://sms.test/webhook', {
    method: 'POST', body,
    headers: { 'content-type': 'application/json', 'x-timestamp': String(timestamp), 'x-signature': signature ?? createHmac('sha256', key).update(body + timestamp).digest('hex') },
  });
  const sms = (message, recipient, simNumber = 1, sender = 'Instagram') => ({ messageId: 'm', message, sender, recipient, simNumber, receivedAt: '2026-11-09T15:46:11.000+05:00' });

  // Forged, stale or malformed deliveries leave nothing behind.
  const body = event('e1', sms('123456 is your Instagram code', '+77001112233'));
  assert.equal((await send(body, { key: 'wrong' })).status, 401);
  assert.equal((await send(body, { signature: 'zz' })).status, 401);
  assert.equal((await send(body, { signature: '' })).status, 401);
  assert.equal((await send(body, { timestamp: Math.floor(Date.now() / 1000) - 3600 })).status, 401);
  assert.equal((await receiver.dispatchFetch('https://sms.test/webhook', { method: 'POST', body })).status, 401);
  assert.equal((await send('{not json')).status, 400);
  assert.equal(await receiverDb.prepare('SELECT count(*) AS n FROM messages').first('n'), 0);

  // Retried delivery is stored once; other events are acknowledged and skipped.
  assert.equal((await send(body)).status, 200);
  assert.equal((await send(body)).status, 200);
  assert.equal(await receiverDb.prepare('SELECT count(*) AS n FROM messages').first('n'), 1);
  assert.equal((await send(event('p1', {}, 'system:ping'))).status, 200);
  assert.equal(await receiverDb.prepare('SELECT count(*) AS n FROM messages').first('n'), 1);
  assert.equal((await send(event('e2', sms('Код для входа: 7741', '87005556677', 2, 'TikTok')))).status, 200);
  assert.equal((await send(event('e3', sms('Your Google code is G-482913', null, 3, 'Google')))).status, 200);

  // Reading needs the token.
  assert.equal((await receiver.dispatchFetch('https://sms.test/api/messages')).status, 401);
  assert.equal((await receiver.dispatchFetch('https://sms.test/api/messages', { headers: { authorization: 'Bearer wrong' } })).status, 401);

  const { outputFiles } = await build({
    stdin: { contents: `
      import { bindSmsLine, listSms, normalizePhone, readSmsSettings, registerWebhook, revealSigningKey, saveProfilePhone, saveSmsSettings } from './lib/sms';
      export default { async fetch(request) {
        const i = await request.json();
        try {
          if (i.action === 'settings') return Response.json(await saveSmsSettings(i.owner, i));
          if (i.action === 'read') return Response.json({ value: await readSmsSettings(i.owner) });
          if (i.action === 'reveal') return Response.json({ key: await revealSigningKey(i.owner) });
          if (i.action === 'register') return Response.json(await registerWebhook(i.owner, i.username, i.password));
          if (i.action === 'phone') return Response.json({ phone: await saveProfilePhone(i.owner, i.profileId, i.phone) });
          if (i.action === 'bind') return Response.json({ line: await bindSmsLine(i.owner, i.profileId, i.line) });
          return Response.json({ messages: await listSms(i.owner) });
        } catch (error) { return Response.json({ error: error.message }, { status: error.status || 500 }); }
      }};`, resolveDir: root, loader: 'ts' },
    bundle: true, write: false, format: 'esm', platform: 'browser', target: 'es2022', external: ['cloudflare:workers'], tsconfig: path.join(root, 'tsconfig.json'),
  });
  const gateway = [];
  const ferma = new Miniflare({
    modules: true, script: outputFiles[0].text, compatibilityDate: '2026-05-15', d1Databases: ['DB'],
    bindings: { SETTINGS_ENCRYPTION_KEY: Buffer.alloc(32, 9).toString('base64') },
    outboundService: async request => {
      const url = new URL(request.url);
      if (url.hostname === 'api.sms-gate.app') {
        gateway.push({ auth: request.headers.get('authorization'), body: await request.json() });
        return request.headers.get('authorization') === `Basic ${btoa('user:pass')}` ? Response.json({ id: 'hook' }, { status: 201 }) : new Response(null, { status: 401 });
      }
      const answer = await receiver.dispatchFetch(request.url, { headers: { authorization: request.headers.get('authorization') } });
      return new Response(await answer.text(), { status: answer.status, headers: { 'content-type': 'application/json' } });
    },
  });
  t.after(() => ferma.dispose());
  const db = await ferma.getD1Database('DB');
  for (const file of (await readdir(path.join(root, 'drizzle'))).filter(file => file.endsWith('.sql')).sort()) {
    const sql = (await readFile(path.join(root, 'drizzle', file), 'utf8')).replaceAll('--> statement-breakpoint', '');
    for (const statement of sql.split(';').map(value => value.trim()).filter(Boolean)) await db.prepare(statement).run();
  }
  await db.prepare("INSERT INTO profiles (id, owner, name, createdAt) VALUES ('a', 'owner', 'a', '2026-01-01'), ('b', 'owner', 'b', '2026-01-01'), ('c', 'owner', 'c', '2026-01-01'), ('foreign', 'intruder', 'x', '2026-01-01')").run();
  async function call(body) {
    const response = await ferma.dispatchFetch('http://test', { method: 'POST', body: JSON.stringify({ owner: 'owner', ...body }) });
    return { status: response.status, ...await response.json() };
  }
  const settings = { action: 'settings', baseUrl: 'https://sms.test/', apiToken: API_TOKEN, signingKey: SIGNING_KEY };

  // Nothing is saved until the token works, and secrets stay encrypted.
  assert.equal((await call({ action: 'list' })).messages.length, 0);
  assert.equal((await call({ action: 'reveal' })).status, 400);
  assert.equal((await call({ action: 'register', username: 'user', password: 'pass' })).status, 400);
  assert.equal((await call({ ...settings, baseUrl: 'http://sms.test' })).status, 400);
  assert.match((await call({ ...settings, apiToken: 'wrong' })).error, /отклонил токен/);
  assert.equal(await db.prepare('SELECT count(*) AS n FROM sms_settings').first('n'), 0);
  assert.equal((await call(settings)).webhookUrl, 'https://sms.test/webhook');
  const row = await db.prepare('SELECT encryptedToken, encryptedSigningKey FROM sms_settings').first();
  assert.ok(!row.encryptedToken.includes(API_TOKEN) && !row.encryptedSigningKey.includes(SIGNING_KEY));
  const visible = (await call({ action: 'read' })).value;
  assert.deepEqual(Object.keys(visible).sort(), ['baseUrl', 'webhookUrl']);
  assert.equal((await call({ action: 'reveal' })).key, SIGNING_KEY);
  assert.equal((await call({ owner: 'intruder', action: 'reveal' })).status, 400);

  // The phone credentials are used once and never stored.
  assert.match((await call({ action: 'register', username: 'user', password: 'bad' })).error, /логин или пароль/);
  assert.equal((await call({ action: 'register', username: 'user', password: 'pass' })).ok, true);
  assert.deepEqual(gateway.at(-1).body, { url: 'https://sms.test/webhook', event: 'sms:received' });

  // Numbers are validated, normalized, unique and owner-bound.
  for (const bad of ['123', 'abc', '+7700', '+7700111223344556']) assert.equal((await call({ action: 'phone', profileId: 'a', phone: bad })).status, 400, bad);
  assert.equal((await call({ action: 'phone', profileId: 'a', phone: '+7 (700) 111-22-33' })).phone, '+77001112233');
  assert.equal((await call({ action: 'phone', profileId: 'b', phone: '+77001112233' })).status, 409);
  assert.equal((await call({ action: 'phone', profileId: 'b', phone: '+77005556677' })).phone, '+77005556677');
  assert.equal((await call({ action: 'phone', profileId: 'foreign', phone: '+77009998877' })).status, 404);

  // Each message goes to its number, a local form included; an unknown number stays unassigned.
  const first = (await call({ action: 'list' })).messages;
  const byId = Object.fromEntries(first.map(item => [item.id, item]));
  assert.deepEqual([byId.e1.profileId, byId.e1.code], ['a', '123456']);
  assert.deepEqual([byId.e2.profileId, byId.e2.code], ['b', '7741']);
  assert.deepEqual([byId.e3.profileId, byId.e3.code, byId.e3.line], [null, 'G-482913', 'device-1:3']);

  // A SIM without a known number is bound once, and the binding is exclusive.
  assert.equal((await call({ action: 'bind', profileId: 'c', line: 'device-1:3' })).line, 'device-1:3');
  assert.equal((await call({ action: 'list' })).messages.find(item => item.id === 'e3').profileId, 'c');
  assert.equal((await call({ action: 'bind', profileId: 'a', line: 'device-1:3' })).status, 409);
  assert.equal((await call({ action: 'bind', profileId: 'a', line: "x' OR 1=1" })).status, 400);
});
