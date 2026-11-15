import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { once } from 'node:events';
import { createGateway, createPublicGateway, createRemoteGateway } from './gateway.mjs';

const WAIT_MINUTES = 15;

test('Docker boundary restricts hosts and origins and replaces forged identity', async t => {
  const upstream = http.createServer((request, response) => {
    let body = '';
    request.on('data', chunk => { body += chunk; });
    request.on('end', () => response.end(JSON.stringify({ headers: request.headers, body, url: request.url })));
  }).listen(0, '127.0.0.1');
  await once(upstream, 'listening');
  const gateway = createGateway(upstream.address().port).listen(0, '127.0.0.1');
  await once(gateway, 'listening');
  t.after(() => { gateway.close(); upstream.close(); });
  function request(headers = {}, method = 'GET', body = '', path = '/api/workspace') {
    return new Promise((resolve, reject) => {
      const req = http.request({ hostname: '127.0.0.1', port: gateway.address().port, path, method, headers }, res => {
        let text = '';
        res.on('data', chunk => { text += chunk; });
        res.on('end', () => resolve({ status: res.statusCode, text }));
      });
      req.on('error', reject);
      req.end(body);
    });
  }
  assert.equal((await request({ host: 'attacker.example:3100' })).status, 403);
  assert.equal((await request({ host: 'localhost:3100', origin: 'https://attacker.example' }, 'POST')).status, 403);
  assert.equal((await request({ host: 'localhost:3100', 'sec-fetch-site': 'cross-site' })).status, 403);
  // The return from Meta's login: a page visit of the start page only.
  const page = { host: 'localhost:3100', 'sec-fetch-site': 'cross-site', 'sec-fetch-mode': 'navigate' };
  assert.equal((await request(page, 'GET', '', '/')).status, 200);
  assert.equal((await request(page, 'GET', '', '/api/workspace')).status, 403);
  assert.equal((await request(page, 'POST', '', '/')).status, 403);
  assert.equal((await request({ ...page, 'sec-fetch-mode': 'cors' }, 'GET', '', '/')).status, 403);
  const allowed = await request({ host: 'localhost:3100', origin: 'http://localhost:3100', 'oai-authenticated-user-id': 'forged', 'x-forwarded-host': 'attacker.example', 'content-type': 'application/json' }, 'POST', '{"action":"profile"}');
  assert.equal(allowed.status, 200);
  const proxied = JSON.parse(allowed.text);
  assert.equal(proxied.headers['oai-authenticated-user-id'], 'ferma_docker_owner');
  assert.equal(proxied.headers['x-forwarded-host'], undefined);
  assert.equal(proxied.headers.origin, 'http://localhost:3100');
  assert.equal(proxied.headers.host, 'localhost:3100');
  assert.equal(proxied.body, '{"action":"profile"}');
  assert.equal((await request({ host: '127.0.0.1:3100' })).status, 200);
});

test('Own devices through the domain: one password, a signed cookie, no way around it', async t => {
  const upstream = http.createServer((request, response) => {
    let body = '';
    request.on('data', chunk => { body += chunk; });
    request.on('end', () => response.end(JSON.stringify({ headers: request.headers, body, url: request.url })));
  }).listen(0, '127.0.0.1');
  await once(upstream, 'listening');
  let clock = Date.parse('2026-11-15T00:00:00Z');
  assert.throws(() => createRemoteGateway(upstream.address().port, { password: 'short' }), /at least 8/);
  const gateway = createRemoteGateway(upstream.address().port, { password: 'correct-horse-battery', now: () => clock }).listen(0, '127.0.0.1');
  await once(gateway, 'listening');
  t.after(() => { gateway.close(); upstream.close(); });
  const HOST = 'ferma.example.org';
  function request(path, { method = 'GET', headers = {}, body = '', port = gateway.address().port } = {}) {
    return new Promise((resolve, reject) => {
      const req = http.request({ hostname: '127.0.0.1', port, path, method, headers: { host: HOST, ...headers } }, res => {
        let text = '';
        res.on('data', chunk => { text += chunk; });
        res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, text }));
      });
      req.on('error', reject);
      req.end(body);
    });
  }
  const form = fields => ({ method: 'POST', headers: { origin: `https://${HOST}`, 'content-type': 'application/x-www-form-urlencoded', 'x-forwarded-for': fields.from || '203.0.113.7' }, body: new URLSearchParams({ password: fields.password, next: fields.next || '/' }).toString() });

  // Nothing without the login: a page goes to the login, the API answers 401.
  const page = await request('/?x=1');
  assert.equal(page.status, 302);
  assert.equal(page.headers.location, '/login?next=%2F%3Fx%3D1');
  assert.equal((await request('/api/workspace')).status, 401);
  const loginForm = await request('/login?next=%2F%23posts');
  assert.equal(loginForm.status, 200);
  assert.match(loginForm.text, /name="password"/);
  assert.match(loginForm.headers['content-security-policy'], /frame-ancestors 'none'/);

  // Wrong passwords: five per address, then a wait even with the right one; another address is not blocked.
  for (let index = 0; index < 5; index++) assert.equal((await request('/login', form({ password: `wrong-${index}` }))).status, 401);
  assert.equal((await request('/login', form({ password: 'correct-horse-battery' }))).status, 429);
  const signed = await request('/login', form({ password: 'correct-horse-battery', from: '198.51.100.9', next: '//evil.example/x' }));
  assert.equal(signed.status, 303);
  assert.equal(signed.headers.location, '/', 'never another site');
  const cookie = signed.headers['set-cookie'][0];
  assert.match(cookie, /^ferma_session=\d+\.[\w-]+; Path=\/; HttpOnly; Secure; SameSite=Lax; Max-Age=7776000$/);
  assert.ok(!cookie.includes('correct-horse-battery'), 'the cookie never holds the password');
  const session = cookie.split(';')[0];
  clock += WAIT_MINUTES * 60_000;
  assert.equal((await request('/login', form({ password: 'correct-horse-battery' }))).status, 303, 'the wait ends');

  // With the cookie: passed on as the owner; forged identity and the session cookie never reach the app.
  const inside = await request('/api/workspace', { method: 'POST', headers: { cookie: `${session}; theme=dark`, origin: `https://${HOST}`, 'oai-authenticated-user-id': 'forged', 'x-forwarded-host': 'attacker.example' }, body: '{"a":1}' });
  assert.equal(inside.status, 200);
  assert.equal(inside.headers['x-frame-options'], 'DENY');
  const seen = JSON.parse(inside.text);
  assert.equal(seen.headers['oai-authenticated-user-id'], 'ferma_docker_owner');
  assert.equal(seen.headers['x-forwarded-host'], undefined);
  assert.equal(seen.headers.cookie, 'theme=dark');
  assert.equal(seen.headers.origin, `http://${HOST}`, 'the checked origin reaches the app as its own address');
  assert.equal(seen.body, '{"a":1}');

  // Another site: no writes even with the cookie; only the start page may be opened as a page (Meta's return).
  assert.equal((await request('/api/workspace', { method: 'POST', headers: { cookie: session, origin: 'https://evil.example' } })).status, 403);
  assert.equal((await request('/api/workspace', { headers: { cookie: session, 'sec-fetch-site': 'cross-site', 'sec-fetch-mode': 'cors' } })).status, 403);
  assert.equal((await request('/', { headers: { cookie: session, 'sec-fetch-site': 'cross-site', 'sec-fetch-mode': 'navigate' } })).status, 200);

  // A changed, foreign or old cookie is no cookie.
  const [issued, mac] = session.split('=')[1].split('.');
  assert.equal((await request('/api/workspace', { headers: { cookie: `ferma_session=${Number(issued) - 1}.${mac}` } })).status, 401);
  const renewed = createRemoteGateway(upstream.address().port, { password: 'another-password-123', now: () => clock }).listen(0, '127.0.0.1');
  await once(renewed, 'listening');
  t.after(() => renewed.close());
  assert.equal((await request('/api/workspace', { headers: { cookie: session }, port: renewed.address().port })).status, 401, 'a new password signs every device out');
  clock += 91 * 86_400_000;
  assert.equal((await request('/api/workspace', { headers: { cookie: session } })).status, 401, 'after 90 days the device logs in again');
  const out = await request('/logout');
  assert.equal(out.status, 303);
  assert.match(out.headers['set-cookie'][0], /Max-Age=0/);
});

test('Meta\'s return goes to the owner page set for this computer or the domain', async t => {
  const gateway = createPublicGateway(1, 'https://ferma.example.org/').listen(0, '127.0.0.1');
  await once(gateway, 'listening');
  t.after(() => gateway.close());
  const back = path => new Promise((resolve, reject) => {
    http.get({ hostname: '127.0.0.1', port: gateway.address().port, path }, response => { response.resume(); resolve(response); }).on('error', reject);
  });
  const response = await back('/oauth/instagram?code=abc&state=ig_1&extra=x');
  assert.equal(response.statusCode, 302);
  assert.equal(response.headers.location, 'https://ferma.example.org/#accounts/oauth?provider=instagram&code=abc&state=ig_1');
  assert.equal((await back('/oauth/youtube?code=g&state=yt_1&scope=x')).headers.location, 'https://ferma.example.org/#accounts/oauth?provider=youtube&code=g&state=yt_1', 'Google returns the same way');
  assert.equal((await back('/oauth/tiktok?code=x')).statusCode, 404);
});
