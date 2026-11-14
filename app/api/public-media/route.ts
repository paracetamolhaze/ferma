import { openSignedMedia } from '@/lib/publish/public-media';

export const dynamic = 'force-dynamic';
/**
 * The only route reachable from outside (through the public media port): one stored file per signed,
 * short-lived link, for Threads and Instagram to fetch a post's pictures. No login, no listing, no other data.
 */
export async function GET(request: Request) {
  const token = new URL(request.url).searchParams.get('t') || '';
  const object = await openSignedMedia(token);
  if (!object) return new Response('Not found', { status: 404, headers: { 'Cache-Control': 'no-store' } });
  return new Response(object.body, {
    headers: {
      'Content-Type': object.httpMetadata?.contentType || 'image/jpeg', 'Content-Length': String(object.size),
      'Cache-Control': 'public, max-age=3600', 'X-Content-Type-Options': 'nosniff', 'Content-Disposition': 'inline',
    },
  });
}
