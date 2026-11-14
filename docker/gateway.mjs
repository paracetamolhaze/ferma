import http from 'node:http';

// This gateway is only for the loopback-published, single-owner Docker project.
// Never trust incoming Sites identity headers or arbitrary Host/Origin values.
// FERMA_HOSTS is only for a second, isolated copy on other ports (tests); the normal project keeps these two.
const allowedHosts = new Set((process.env.FERMA_HOSTS || 'localhost:3100,127.0.0.1:3100').split(',').map(host => host.trim()).filter(Boolean));
export function createGateway(upstreamPort = 8787) {
  return http.createServer((request, response) => {
    const host = request.headers.host;
    if (!allowedHosts.has(host) || !request.url?.startsWith('/') || request.url.startsWith('//')) {
      response.writeHead(403).end('Forbidden host');
      return;
    }
    // One visit from another site is let in: the start page opened as a page. Meta's login sends the owner back
    // there through the public side (the code rides in the address fragment, read by the page itself).
    const returning = request.method === 'GET' && request.url === '/' && request.headers['sec-fetch-mode'] === 'navigate' && !request.headers.origin;
    if ((request.headers.origin && request.headers.origin !== `http://${host}`) || (request.headers['sec-fetch-site'] === 'cross-site' && !returning)) {
      response.writeHead(403).end('Forbidden origin');
      return;
    }
    const headers = { ...request.headers };
    for (const name of Object.keys(headers)) {
      if (name.startsWith('oai-') || name.startsWith('cf-') || name.startsWith('x-forwarded-') || name === 'forwarded') delete headers[name];
    }
    headers['oai-authenticated-user-id'] = 'ferma_docker_owner';
    headers['oai-authenticated-user-email'] = 'owner@ferma.local';
    headers['oai-authenticated-user-full-name'] = 'FERMA';
    headers['oai-authenticated-user-full-name-encoding'] = 'percent-encoded-utf-8';
    const upstream = http.request({ hostname: '127.0.0.1', port: upstreamPort, path: request.url, method: request.method, headers }, (result) => {
      response.writeHead(result.statusCode, result.headers);
      result.pipe(response);
    });
    upstream.on('error', () => {
      if (!response.headersSent) response.writeHead(502);
      response.end('FERMA is starting. Please retry.');
    });
    request.on('aborted', () => upstream.destroy());
    response.on('close', () => { if (!response.writableEnded) upstream.destroy(); });
    request.pipe(upstream);
  });
}

/**
 * The public side, reached only through the owner's Caddy (HTTPS). Two things, nothing else:
 *   GET /m/<signed token>          one picture for Threads/Instagram to fetch, checked by the app
 *   GET /oauth/<threads|instagram> the network's return after login: sent on to this computer's FERMA page
 * No identity is attached: the app answers /api/public-media without a user and only for valid signatures.
 */
export function createPublicGateway(upstreamPort = 8787, localOrigin = 'http://localhost:3100') {
  return http.createServer((request, response) => {
    const url = new URL(request.url || '/', 'http://public');
    if (request.method !== 'GET' && request.method !== 'HEAD') { response.writeHead(405).end(); return; }
    const oauth = /^\/oauth\/(threads|instagram)$/.exec(url.pathname);
    if (oauth) {
      // The code goes into the address fragment: it is read by the page on this computer, not logged by servers.
      const fields = new URLSearchParams({ provider: oauth[1] });
      for (const name of ['code', 'state', 'error', 'error_description']) if (url.searchParams.get(name)) fields.set(name, url.searchParams.get(name).slice(0, 2000));
      response.writeHead(302, { Location: `${localOrigin}/#accounts/oauth?${fields}`, 'Cache-Control': 'no-store', 'Referrer-Policy': 'no-referrer' });
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
