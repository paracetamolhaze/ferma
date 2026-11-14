/**
 * Threads and Instagram fetch a post's pictures from a public HTTPS address. FERMA itself stays on this
 * computer: a separate public port (3102) answers only signed, short-lived links to single files, through the
 * owner's existing Caddy. A link names one stored file and dies after its time; nothing else is reachable.
 */
import { env } from 'cloudflare:workers';
import { signValue } from '../content/secrets';

const encode = (value: string) => btoa(unescape(encodeURIComponent(value))).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
const decode = (value: string) => decodeURIComponent(escape(atob(value.replace(/-/g, '+').replace(/_/g, '/'))));
/** Meta keeps containers for 24 hours; links live a little longer so a slow check never meets a dead link. */
export const LINK_TTL_S = 26 * 3600;

export async function signedMediaUrl(publicBaseUrl: string, storageKey: string, contentType: string, nowMs = Date.now(), ttlSeconds = LINK_TTL_S) {
  const payload = encode(JSON.stringify({ k: storageKey, e: Math.floor(nowMs / 1000) + ttlSeconds }));
  const signature = await signValue(payload);
  const extension = contentType === 'image/png' ? 'png' : contentType === 'video/mp4' ? 'mp4' : 'jpg';
  return `${publicBaseUrl.replace(/\/+$/, '')}/m/${payload}.${signature}.${extension}`;
}

/** Checks a link and returns the stored file, or null for anything wrong (unknown, expired, tampered). */
export async function openSignedMedia(token: string, nowMs = Date.now()) {
  const match = /^([A-Za-z0-9_-]{10,600})\.([A-Za-z0-9_-]{20,64})(?:\.(jpg|png|mp4))?$/.exec(token);
  if (!match) return null;
  const expected = await signValue(match[1]);
  if (expected.length !== match[2].length) return null;
  let difference = 0;
  for (let index = 0; index < expected.length; index++) difference |= expected.charCodeAt(index) ^ match[2].charCodeAt(index);
  if (difference) return null;
  let claim: { k?: unknown; e?: unknown };
  try { claim = JSON.parse(decode(match[1])); } catch { return null; }
  if (typeof claim.k !== 'string' || typeof claim.e !== 'number' || claim.e * 1000 < nowMs) return null;
  return env.BUCKET!.get(claim.k);
}
