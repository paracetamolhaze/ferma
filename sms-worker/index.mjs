// Receives SMS webhooks from "SMS Gateway for Android" and keeps them for FERMA to read.
const KEEP_SECONDS = 90 * 86400;
const MAX_BODY = 64 * 1024;
const TIMESTAMP_TOLERANCE = 300;
const encoder = new TextEncoder();
const json = (data, status = 200) => Response.json(data, { status, headers: { 'Cache-Control': 'no-store' } });

function hexToBytes(hex) {
  if (!/^(?:[0-9a-f]{2})+$/i.test(hex)) return null;
  return Uint8Array.from(hex.match(/../g), pair => parseInt(pair, 16));
}
async function validSignature(secret, body, timestamp, signature) {
  const bytes = hexToBytes(signature || '');
  if (!bytes || !secret) return false;
  const key = await crypto.subtle.importKey('raw', encoder.encode(secret), { name: 'HMAC', hash: 'SHA-256' }, false, ['verify']);
  // subtle.verify compares in constant time.
  return crypto.subtle.verify('HMAC', key, bytes, encoder.encode(body + timestamp));
}
async function sameSecret(a, b) {
  const digest = value => crypto.subtle.digest('SHA-256', encoder.encode(value));
  const [left, right] = await Promise.all([digest(a), digest(b)]);
  return crypto.subtle.timingSafeEqual ? crypto.subtle.timingSafeEqual(left, right) : new Uint8Array(left).every((byte, index) => byte === new Uint8Array(right)[index]);
}
async function receive(request, env) {
  const length = Number(request.headers.get('content-length') || 0);
  if (length > MAX_BODY) return json({ error: 'too large' }, 413);
  const body = await request.text();
  if (body.length > MAX_BODY) return json({ error: 'too large' }, 413);
  const timestamp = request.headers.get('x-timestamp') || '';
  const now = Math.floor(Date.now() / 1000);
  if (!/^\d+$/.test(timestamp) || Math.abs(now - Number(timestamp)) > TIMESTAMP_TOLERANCE) return json({ error: 'bad timestamp' }, 401);
  if (!await validSignature(env.SIGNING_KEY, body, timestamp, request.headers.get('x-signature'))) return json({ error: 'bad signature' }, 401);
  let event;
  try { event = JSON.parse(body); } catch { return json({ error: 'bad json' }, 400); }
  // Pings and other events are acknowledged so the phone does not keep retrying them.
  if (event?.event !== 'sms:received') return json({ ok: true, ignored: true });
  const sms = event.payload;
  if (typeof event.id !== 'string' || typeof sms?.message !== 'string') return json({ error: 'bad payload' }, 400);
  const parsed = Date.parse(sms.receivedAt);
  const receivedAt = Number.isFinite(parsed) ? Math.floor(parsed / 1000) : now;
  // The phone retries on any failure, so the event id makes a repeated delivery harmless.
  await env.DB.batch([
    env.DB.prepare('INSERT OR IGNORE INTO messages (id, device_id, sender, recipient, sim_number, message, received_at) VALUES (?, ?, ?, ?, ?, ?, ?)')
      .bind(event.id, String(event.deviceId || ''), sms.sender ?? null, sms.recipient ?? null, Number.isInteger(sms.simNumber) ? sms.simNumber : null, sms.message, receivedAt),
    env.DB.prepare('DELETE FROM messages WHERE received_at < ?').bind(now - KEEP_SECONDS),
  ]);
  return json({ ok: true });
}
async function list(request, env) {
  const token = (request.headers.get('authorization') || '').replace(/^Bearer /, '');
  if (!token || !env.API_TOKEN || !await sameSecret(token, env.API_TOKEN)) return json({ error: 'unauthorized' }, 401);
  const limit = Math.min(Math.max(Number(new URL(request.url).searchParams.get('limit')) || 100, 1), 200);
  const { results } = await env.DB.prepare('SELECT id, device_id, sender, recipient, sim_number, message, received_at FROM messages ORDER BY received_at DESC, id LIMIT ?').bind(limit).all();
  return json({ messages: results });
}
export default {
  async fetch(request, env) {
    const { pathname } = new URL(request.url);
    if (pathname === '/webhook' && request.method === 'POST') return receive(request, env);
    if (pathname === '/api/messages' && request.method === 'GET') return list(request, env);
    if (pathname === '/api/health') return json({ ok: true });
    return json({ error: 'not found' }, 404);
  },
};
