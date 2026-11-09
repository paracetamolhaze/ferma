import http from 'node:http';

// This gateway is only for the loopback-published, single-owner Docker project.
// Never trust incoming Sites identity headers or arbitrary Host/Origin values.
const allowedHosts = new Set(['localhost:3100', '127.0.0.1:3100']);
export function createGateway(upstreamPort = 8787) {
  return http.createServer((request, response) => {
    const host = request.headers.host;
    if (!allowedHosts.has(host) || !request.url?.startsWith('/') || request.url.startsWith('//')) {
      response.writeHead(403).end('Forbidden host');
      return;
    }
    if ((request.headers.origin && request.headers.origin !== `http://${host}`) || request.headers['sec-fetch-site'] === 'cross-site') {
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
