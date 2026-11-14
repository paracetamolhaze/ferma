import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { once } from 'node:events';
import { createGateway } from './gateway.mjs';

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
