import { createHash, createHmac, timingSafeEqual } from 'node:crypto';
import http from 'node:http';

// This gateway is only for the loopback-published, single-owner Docker project.
// Never trust incoming Sites identity headers or arbitrary Host/Origin values.
// FERMA_HOSTS is only for a second, isolated copy on other ports (tests); the normal project keeps these two.
const allowedHosts = new Set((process.env.FERMA_HOSTS || 'localhost:3100,127.0.0.1:3100').split(',').map(host => host.trim()).filter(Boolean));

/** Passes a request on to the app as the owner. Identity headers that came with the request are never trusted. */
function proxyAsOwner(request, response, upstreamPort, { dropCookie = null, responseHeaders = {}, origin = null } = {}) {
  const headers = { ...request.headers };
  for (const name of Object.keys(headers)) {
    if (name.startsWith('oai-') || name.startsWith('cf-') || name.startsWith('x-forwarded-') || name === 'forwarded') delete headers[name];
  }
  // The app is reached over plain HTTP and compares a write's Origin with its own address: an origin the gateway
  // has already checked is passed on in that form.
  if (origin && headers.origin) headers.origin = origin;
  if (dropCookie && headers.cookie) {
    const rest = headers.cookie.split(/;\s*/).filter(part => part && !part.startsWith(`${dropCookie}=`)).join('; ');
    if (rest) headers.cookie = rest; else delete headers.cookie;
  }
  headers['oai-authenticated-user-id'] = 'ferma_docker_owner';
  headers['oai-authenticated-user-email'] = 'owner@ferma.local';
  headers['oai-authenticated-user-full-name'] = 'FERMA';
  headers['oai-authenticated-user-full-name-encoding'] = 'percent-encoded-utf-8';
  const upstream = http.request({ hostname: '127.0.0.1', port: upstreamPort, path: request.url, method: request.method, headers }, (result) => {
    response.writeHead(result.statusCode, { ...result.headers, ...responseHeaders });
    result.pipe(response);
  });
  upstream.on('error', () => {
    if (!response.headersSent) response.writeHead(502);
    response.end('FERMA is starting. Please retry.');
  });
  request.on('aborted', () => upstream.destroy());
  response.on('close', () => { if (!response.writableEnded) upstream.destroy(); });
  request.pipe(upstream);
}

/**
 * A page visit from another site that is let in: the start page (and the login page) opened as a page. Meta's
 * login sends the owner back there through the public side; the code rides in the address fragment.
 */
const pageVisit = (request, paths) => request.method === 'GET' && request.headers['sec-fetch-mode'] === 'navigate' && !request.headers.origin && paths.includes(new URL(request.url, 'http://x').pathname);

export function createGateway(upstreamPort = 8787) {
  return http.createServer((request, response) => {
    const host = request.headers.host;
    if (!allowedHosts.has(host) || !request.url?.startsWith('/') || request.url.startsWith('//')) {
      response.writeHead(403).end('Forbidden host');
      return;
    }
    const returning = request.method === 'GET' && request.url === '/' && pageVisit(request, ['/']);
    if ((request.headers.origin && request.headers.origin !== `http://${host}`) || (request.headers['sec-fetch-site'] === 'cross-site' && !returning)) {
      response.writeHead(403).end('Forbidden origin');
      return;
    }
    proxyAsOwner(request, response, upstreamPort);
  });
}

const SESSION_COOKIE = 'ferma_session';
const SESSION_MS = 90 * 86_400_000;
const FAILURES_PER_ADDRESS = 5;
const FAILURES_PER_HOUR = 100;
const WAIT_MS = 15 * 60_000;
const escapeHtml = text => String(text).replace(/[&<>"']/g, char => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[char]);
/** Only a path on this site: never another site (//host, /\host). The fragment may come along (Meta's code). */
const safeNext = value => typeof value === 'string' && value.startsWith('/') && !value.startsWith('//') && !value.startsWith('/\\') && value.length <= 4000 ? value : '/';
function cookieOf(request, name) {
  for (const part of String(request.headers.cookie || '').split(/;\s*/)) if (part.startsWith(`${name}=`)) return part.slice(name.length + 1);
  return null;
}
function loginPage(response, { next, error = '', status = 200 }) {
  const html = `<!doctype html>
<html lang="ru"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>FERMA</title>
<style>
:root{color-scheme:light dark;--bg:#f5f6f8;--card:#fff;--text:#16181d;--line:#d9dde3;--accent:#2563eb;--bad:#b42318}
@media (prefers-color-scheme:dark){:root{--bg:#111318;--card:#1a1d24;--text:#e8eaee;--line:#2c313b;--accent:#5b8def;--bad:#f97066}}
body{margin:0;min-height:100vh;display:grid;place-items:center;background:var(--bg);color:var(--text);font:16px/1.4 system-ui,-apple-system,"Segoe UI",Roboto,sans-serif}
form{width:min(340px,calc(100vw - 32px));box-sizing:border-box;background:var(--card);border:1px solid var(--line);border-radius:12px;padding:24px;display:grid;gap:14px}
h1{margin:0;font-size:20px}label{display:grid;gap:6px;font-size:14px}
input,button{font:inherit;padding:10px 12px;border-radius:8px;border:1px solid var(--line);background:var(--bg);color:var(--text)}
button{background:var(--accent);border-color:var(--accent);color:#fff;cursor:pointer}p{margin:0;color:var(--bad);font-size:14px}
</style></head><body>
<form method="post" action="/login"><h1>FERMA</h1>${error ? `<p role="alert">${escapeHtml(error)}</p>` : ''}
<label>Пароль<input type="password" name="password" autocomplete="current-password" required autofocus></label>
<input type="hidden" name="next" value="${escapeHtml(next)}"><button>Войти</button></form>
<script>document.forms[0].addEventListener('submit',function(){var n=this.elements.next;if(location.hash&&n.value.indexOf('#')<0)n.value+=location.hash;});</script>
</body></html>`;
  response.writeHead(status, {
    'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store', 'X-Frame-Options': 'DENY', 'Referrer-Policy': 'same-origin',
    'Content-Security-Policy': "default-src 'none'; style-src 'unsafe-inline'; script-src 'unsafe-inline'; form-action 'self'; frame-ancestors 'none'; base-uri 'none'",
  });
  response.end(html);
}

/**
 * FERMA from the owner's own devices (phone, laptop) through the domain, the way Gudini works: one site password,
 * then a cookie on that device. Caddy forwards HTTPS here; the port is published on 127.0.0.1 only. Everything
 * needs the cookie except the login page. The cookie holds a signed time of login, never the password: it lasts
 * 90 days, and a new password signs every device out. Wrong passwords: 5 per address, then 15 minutes of waiting;
 * 100 an hour in all, then everyone waits.
 */
export function createRemoteGateway(upstreamPort = 8787, { password = process.env.FERMA_SITE_PASSWORD || '', now = Date.now } = {}) {
  if (String(password).length < 8) throw new Error('FERMA_SITE_PASSWORD must have at least 8 characters');
  const key = createHash('sha256').update(`ferma-remote:${password}`).digest();
  const sign = issued => createHmac('sha256', key).update(`session:${issued}`).digest('base64url');
  const passwordDigest = createHash('sha256').update(String(password)).digest();
  const rightPassword = given => timingSafeEqual(createHash('sha256').update(String(given)).digest(), passwordDigest);
  const signedIn = request => {
    const [issued, mac] = String(cookieOf(request, SESSION_COOKIE) || '').split('.');
    const at = Number(issued);
    if (!mac || !Number.isInteger(at) || at > now() + 60_000 || now() - at >= SESSION_MS) return false;
    const expected = Buffer.from(sign(issued));
    const given = Buffer.from(mac);
    return given.length === expected.length && timingSafeEqual(given, expected);
  };
  const failures = new Map();
  let hourly = [];
  const addressOf = request => String(request.headers['x-forwarded-for'] || '').split(',')[0].trim() || request.socket.remoteAddress || 'unknown';
  const waiting = address => {
    const at = now();
    hourly = hourly.filter(time => at - time < 3600_000);
    const entry = failures.get(address);
    return hourly.length >= FAILURES_PER_HOUR || Boolean(entry && entry.count >= FAILURES_PER_ADDRESS && at - entry.first < WAIT_MS);
  };
  const failed = address => {
    const at = now();
    hourly.push(at);
    const entry = failures.get(address);
    failures.set(address, entry && at - entry.first < WAIT_MS ? { first: entry.first, count: entry.count + 1 } : { first: at, count: 1 });
    if (failures.size > 5000) for (const [key, value] of failures) if (at - value.first >= WAIT_MS) failures.delete(key);
  };

  function login(request, response, url) {
    if (request.method === 'GET') { loginPage(response, { next: safeNext(url.searchParams.get('next')) }); return; }
    if (request.method !== 'POST') { response.writeHead(405).end(); return; }
    const address = addressOf(request);
    let body = '';
    request.setEncoding('utf8');
    request.on('data', chunk => { body += chunk; if (body.length > 8192) request.destroy(); });
    request.on('end', () => {
      const fields = new URLSearchParams(body);
      const next = safeNext(fields.get('next'));
      if (waiting(address)) { loginPage(response, { next, error: 'Слишком много попыток. Попробуйте через 15 минут.', status: 429 }); return; }
      if (!rightPassword(fields.get('password') || '')) { failed(address); loginPage(response, { next, error: 'Неверный пароль.', status: 401 }); return; }
      failures.delete(address);
      const issued = String(now());
      response.writeHead(303, {
        Location: next, 'Cache-Control': 'no-store',
        'Set-Cookie': `${SESSION_COOKIE}=${issued}.${sign(issued)}; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=${SESSION_MS / 1000}`,
      });
      response.end();
    });
  }

  return http.createServer((request, response) => {
    if (!request.url?.startsWith('/') || request.url.startsWith('//')) { response.writeHead(400).end(); return; }
    const url = new URL(request.url, 'https://remote');
    const host = String(request.headers.host || '');
    // Writes come only from this site itself; another site may only open the start or the login page.
    if ((request.headers.origin && request.headers.origin !== `https://${host}`) || (request.headers['sec-fetch-site'] === 'cross-site' && !pageVisit(request, ['/', '/login']))) {
      response.writeHead(403).end('Forbidden origin');
      return;
    }
    if (url.pathname === '/login') { login(request, response, url); return; }
    if (url.pathname === '/logout') {
      response.writeHead(303, { Location: '/login', 'Cache-Control': 'no-store', 'Set-Cookie': `${SESSION_COOKIE}=; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=0` });
      response.end();
      return;
    }
    if (!signedIn(request)) {
      if (request.method === 'GET' && !url.pathname.startsWith('/api/')) {
        response.writeHead(302, { Location: `/login?next=${encodeURIComponent(url.pathname + url.search)}`, 'Cache-Control': 'no-store' });
        response.end();
      } else {
        response.writeHead(401, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
        response.end(JSON.stringify({ error: 'Нужен вход: откройте FERMA заново.' }));
      }
      return;
    }
    proxyAsOwner(request, response, upstreamPort, { dropCookie: SESSION_COOKIE, responseHeaders: { 'X-Frame-Options': 'DENY' }, origin: `http://${host}` });
  });
}

/**
 * The public side, reached only through the owner's Caddy (HTTPS). Two things, nothing else:
 *   GET /m/<signed token>          one picture for Threads/Instagram to fetch, checked by the app
 *   GET /oauth/<threads|instagram|youtube> the network's return after login: sent on to the owner's FERMA page
 *                                  (FERMA_OWNER_URL: the domain with the password login, or this computer)
 * No identity is attached: the app answers /api/public-media without a user and only for valid signatures.
 */
export function createPublicGateway(upstreamPort = 8787, localOrigin = process.env.FERMA_OWNER_URL || 'http://localhost:3100') {
  const owner = localOrigin.replace(/\/+$/, '');
  return http.createServer((request, response) => {
    const url = new URL(request.url || '/', 'http://public');
    if (request.method !== 'GET' && request.method !== 'HEAD') { response.writeHead(405).end(); return; }
    const oauth = /^\/oauth\/(threads|instagram|youtube)$/.exec(url.pathname);
    if (oauth) {
      // The code goes into the address fragment: it is read by the owner's page, not logged by servers.
      const fields = new URLSearchParams({ provider: oauth[1] });
      for (const name of ['code', 'state', 'error', 'error_description']) if (url.searchParams.get(name)) fields.set(name, url.searchParams.get(name).slice(0, 2000));
      response.writeHead(302, { Location: `${owner}/#accounts/oauth?${fields}`, 'Cache-Control': 'no-store', 'Referrer-Policy': 'no-referrer' });
      response.end();
      return;
    }
    const media = /^\/m\/([A-Za-z0-9_.-]{20,800})$/.exec(url.pathname);
    if (!media) { response.writeHead(404, { 'Cache-Control': 'no-store' }).end('Not found'); return; }
    const upstream = http.request({ hostname: '127.0.0.1', port: upstreamPort, path: `/api/public-media?t=${encodeURIComponent(media[1])}`, method: request.method, headers: { host: `127.0.0.1:${upstreamPort}`, accept: 'image/*' } }, result => {
      const headers = { 'Content-Type': result.headers['content-type'] || 'application/octet-stream', 'Cache-Control': result.headers['cache-control'] || 'no-store', 'X-Content-Type-Options': 'nosniff' };
      if (result.headers['content-length']) headers['Content-Length'] = result.headers['content-length'];
      response.writeHead(result.statusCode === 200 ? 200 : 404, headers);
      if (result.statusCode === 200) result.pipe(response); else { result.resume(); response.end(); }
    });
    upstream.on('error', () => { if (!response.headersSent) response.writeHead(503); response.end(); });
    upstream.end();
  });
}
