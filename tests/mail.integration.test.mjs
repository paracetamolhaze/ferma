import test from 'node:test';
import assert from 'node:assert/strict';
import { build } from 'esbuild';
import { Miniflare } from 'miniflare';
import { readFile, readdir } from 'node:fs/promises';
import path from 'node:path';
import { isProfileReady } from '../lib/domain.ts';
import { mailDocument, MAIL_FRAME_SANDBOX } from '../lib/mail-document.ts';
import { extractCode } from '../lib/mail-codes.ts';

test('finds login codes in the wording services actually use and ignores the rest', () => {
  const cases = [
    ['123456 is your Instagram code', null, '123456'],
    ['123 456 is your Instagram code', null, '123456'],
    ['G-482913 is your Google verification code', null, 'G-482913'],
    ['Ваш код подтверждения', 'Введите код: 7741', '7741'],
    ['Код для входа в TikTok: 554433', null, '554433'],
    ['Verify your email', 'Your verification code is:\n\nAB12CD', 'AB12CD'],
    ['Verify your email', 'Your verification code is AB12CD. It expires soon.', 'AB12CD'],
    ['Confirm your account', 'Hello user1234,\nuse this code 918273 to continue', '918273'],
    ['Welcome', '\n445566\n', '445566'],
    ['Hello', 'Your invoice for 2026 is ready. Order total 1500 USD', null],
    ['Please confirm', 'Security check passed in 2026', null],
    ['privet', 'privet', null],
    [null, null, null],
  ];
  for (const [subject, text, expected] of cases) assert.equal(extractCode(subject, text), expected, `${subject} | ${text}`);
});

test('one connected network makes a profile ready', () => {
  assert.equal(isProfileReady(0), false);
  assert.equal(isProfileReady(1), true);
  assert.equal(isProfileReady(2), true);
});

test('mail HTML cannot run scripts, submit forms or load remote content', () => {
  const page = mailDocument('<script>alert(1)</script><img src="https://tracker.example/x.png">');
  assert.match(page, /default-src 'none'/);
  assert.match(page, /img-src data:/);
  assert.ok(page.indexOf('Content-Security-Policy') < page.indexOf('<script>'));
  assert.doesNotMatch(MAIL_FRAME_SANDBOX, /allow-scripts|allow-same-origin|allow-forms/);
});

test('each profile reads only its own address and the token stays on the server', { timeout: 60000 }, async t => {
  const root = path.resolve(import.meta.dirname, '..');
  const { outputFiles } = await build({
    stdin: { contents: `
      import { listProfileMail, listRecentMail, readMailSettings, readProfileMail, saveMailSettings, saveProfileAddress } from './lib/mail';
      export default { async fetch(request) {
        const i = await request.json();
        try {
          if (i.action === 'settings') return Response.json(await saveMailSettings(i.owner, i));
          if (i.action === 'readSettings') return Response.json(await readMailSettings(i.owner));
          if (i.action === 'address') return Response.json({ local: await saveProfileAddress(i.owner, i.profileId, i.local) });
          if (i.action === 'list') return Response.json(await listProfileMail(i.owner, i.profileId));
          if (i.action === 'recent') return Response.json({ emails: await listRecentMail(i.owner) });
          return Response.json(await readProfileMail(i.owner, i.profileId, i.id));
        } catch (error) { return Response.json({ error: error.message }, { status: error.status || 500 }); }
      }};`, resolveDir: root, loader: 'ts' },
    bundle: true, write: false, format: 'esm', platform: 'browser', target: 'es2022', external: ['cloudflare:workers'], tsconfig: path.join(root, 'tsconfig.json'),
  });
  const message = (id, to) => ({ id, from_address: 'noreply@service.example', to_address: to, subject: `Код ${id}`, received_at: 1794000000, html_content: '<b>123456</b>', text_content: '123456', has_attachments: false, attachment_count: 0 });
  const box = [message('msg-a', 'alpha@mail.example.com'), message('msg-b', 'beta@mail.example.com'), message('msg-other', 'stranger@mail.example.com')];
  const outbound = [];
  let mode = 'ok';
  const mf = new Miniflare({
    modules: true, script: outputFiles[0].text, compatibilityDate: '2026-05-15', d1Databases: ['DB'],
    bindings: { SETTINGS_ENCRYPTION_KEY: Buffer.alloc(32, 9).toString('base64') },
    outboundService: async request => {
      const url = new URL(request.url);
      outbound.push({ host: url.host, path: url.pathname + url.search, auth: request.headers.get('authorization') });
      if (mode === 'down') return new Response('secret upstream detail', { status: 500 });
      if (mode === 'redirect') return new Response(null, { status: 302, headers: { location: 'https://evil.example/' } });
      if (mode === 'stranger') return Response.json({ hello: 'world' });
      if (request.headers.get('authorization') !== 'Bearer right-token') return Response.json({ success: false }, { status: 401 });
      if (url.pathname === '/api/emails/export') {
        const to = url.searchParams.get('to');
        const emails = box.filter(item => !to || item.to_address === to);
        return Response.json({ success: true, data: { emails, total: emails.length, limit: 30, offset: 0 } });
      }
      const single = url.pathname.match(/^\/api\/emails\/([^/]+)$/);
      if (single) { const found = box.find(item => item.id === single[1]); return found ? Response.json({ success: true, data: found }) : Response.json({ success: false }, { status: 404 }); }
      const to = url.searchParams.get('to');
      const emails = box.filter(item => !to || item.to_address === to).map(item => ({ ...item, html_content: undefined, text_content: undefined }));
      return Response.json({ success: true, data: { emails, total: emails.length, limit: 50, offset: 0 } });
    },
  });
  t.after(() => mf.dispose());
  const db = await mf.getD1Database('DB');
  for (const file of (await readdir(path.join(root, 'drizzle'))).filter(file => file.endsWith('.sql')).sort()) {
    const sql = (await readFile(path.join(root, 'drizzle', file), 'utf8')).replaceAll('--> statement-breakpoint', '');
    for (const statement of sql.split(';').map(value => value.trim()).filter(Boolean)) await db.prepare(statement).run();
  }
  for (const id of ['a', 'b']) await db.prepare('INSERT INTO profiles (id, owner, name, createdAt) VALUES (?, ?, ?, ?)').bind(id, 'owner', id, '2026-01-01').run();
  await db.prepare('INSERT INTO profiles (id, owner, name, createdAt) VALUES (?, ?, ?, ?)').bind('foreign', 'intruder', 'x', '2026-01-01').run();
  async function call(body) {
    const response = await mf.dispatchFetch('http://test', { method: 'POST', body: JSON.stringify({ owner: 'owner', ...body }) });
    return { status: response.status, ...await response.json() };
  }
  const settings = { action: 'settings', baseUrl: 'https://mail.test/', domain: 'Mail.Example.com', apiToken: 'right-token' };

  // An address cannot exist before the service is connected.
  assert.equal((await call({ action: 'address', profileId: 'a', local: 'alpha' })).status, 400);

  // Only a verified https service with a valid token gets saved.
  assert.equal((await call({ ...settings, baseUrl: 'http://mail.test' })).status, 400);
  assert.equal((await call({ ...settings, baseUrl: 'https://user:pass@mail.test' })).status, 400);
  assert.equal((await call({ ...settings, domain: 'not a domain' })).status, 400);
  assert.equal(outbound.length, 0, 'invalid input never reaches the network');
  assert.match((await call({ ...settings, apiToken: 'wrong' })).error, /отклонил токен/);
  mode = 'stranger';
  assert.match((await call(settings)).error, /не MailClaw/);
  mode = 'redirect';
  assert.equal((await call(settings)).status, 502);
  assert.ok(!outbound.some(item => item.host === 'evil.example'), 'the token is not forwarded by a redirect');
  mode = 'ok';
  assert.equal(await db.prepare('SELECT count(*) AS n FROM mail_settings').first('n'), 0);
  const saved = await call(settings);
  assert.deepEqual([saved.baseUrl, saved.domain], ['https://mail.test', 'mail.example.com']);

  // The token is encrypted and absent from what the browser receives.
  const row = await db.prepare('SELECT encryptedToken FROM mail_settings').first();
  assert.ok(row.encryptedToken.startsWith('v1.') && !row.encryptedToken.includes('right-token'));
  const visible = await call({ action: 'readSettings' });
  assert.deepEqual(Object.keys(visible).sort(), ['baseUrl', 'domain', 'status']);

  // Changing only the domain or URL keeps the saved token.
  assert.equal((await call({ action: 'settings', baseUrl: 'https://mail.test', domain: 'mail.example.com' })).status, 200);
  assert.equal(outbound.at(-1).auth, 'Bearer right-token');

  // Addresses are normalized, validated and unique.
  assert.equal((await call({ action: 'address', profileId: 'a', local: ' Alpha ' })).local, 'alpha');
  for (const bad of ['a b', 'кир', '.a', 'a.', 'a..b', 'a@b', 'x'.repeat(65)]) assert.equal((await call({ action: 'address', profileId: 'b', local: bad })).status, 400, bad);
  assert.equal((await call({ action: 'address', profileId: 'b', local: 'alpha' })).status, 409);
  assert.equal((await call({ action: 'address', profileId: 'b', local: 'beta' })).local, 'beta');
  assert.equal((await call({ action: 'address', profileId: 'foreign', local: 'stolen' })).status, 404);
  assert.equal((await call({ owner: 'intruder', action: 'list', profileId: 'a' })).status, 404);

  // A list asks only for the profile's address.
  const listA = await call({ action: 'list', profileId: 'a' });
  assert.equal(listA.address, 'alpha@mail.example.com');
  assert.deepEqual(listA.emails.map(item => item.id), ['msg-a']);
  assert.ok(outbound.at(-1).path.includes('to=alpha%40mail.example.com'));
  assert.equal(listA.emails[0].text_content, undefined, 'a list carries no message bodies');

  // The shared view shows only the owner's profiles, each with its own profile id.
  const recent = await call({ action: 'recent' });
  assert.deepEqual(recent.emails.map(item => [item.id, item.profileId]).sort(), [['msg-a', 'a'], ['msg-b', 'b']]);
  assert.deepEqual((await call({ owner: 'intruder', action: 'recent' })).emails, []);
  assert.deepEqual((await call({ action: 'list', profileId: 'b' })).emails.map(item => item.id), ['msg-b']);

  // The shared token could open any message, so another profile's message is refused.
  assert.equal((await call({ action: 'read', profileId: 'a', id: 'msg-a' })).text_content, '123456');
  const crossed = await call({ action: 'read', profileId: 'a', id: 'msg-b' });
  assert.equal(crossed.status, 404);
  assert.equal(crossed.text_content, undefined);
  assert.equal((await call({ action: 'read', profileId: 'a', id: '../../api/emails' })).status, 404);

  // Upstream failures stay readable and reveal nothing.
  mode = 'down';
  const failed = await call({ action: 'list', profileId: 'a' });
  assert.equal(failed.status, 502);
  assert.doesNotMatch(failed.error, /secret upstream|right-token/);
  mode = 'ok';

  // Clearing keeps the name free for another profile, without touching the mail itself.
  assert.equal((await call({ action: 'address', profileId: 'a', local: '' })).local, null);
  assert.equal((await call({ action: 'list', profileId: 'a' })).status, 400);
  assert.equal((await call({ action: 'address', profileId: 'b', local: 'alpha' })).local, 'alpha');
});
