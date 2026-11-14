/** Encryption of tokens and app secrets of the content pipeline, tied to the owner and to the record. */
import { env } from 'cloudflare:workers';
import { decryptSecret, encryptSecret } from '../secret-crypto';

const key = () => {
  const value = (env as unknown as Record<string, string>).SETTINGS_ENCRYPTION_KEY;
  if (!value) throw new Error('Хранилище ключей не настроено на сервере.');
  return value;
};
const context = (owner: string, scope: string) => JSON.stringify([owner, scope]);
export const sealSecret = (owner: string, scope: string, value: string) => encryptSecret(value, key(), context(owner, scope));
export const openSecret = (owner: string, scope: string, value: string) => decryptSecret(value, key(), context(owner, scope));

/** HMAC-SHA256 for signed public media links. The key never leaves the server. */
export async function signValue(value: string) {
  const raw = Uint8Array.from(atob(key()), char => char.charCodeAt(0));
  const hmac = await crypto.subtle.importKey('raw', raw, { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  const signature = new Uint8Array(await crypto.subtle.sign('HMAC', hmac, new TextEncoder().encode(`public-media:${value}`)));
  return btoa(String.fromCharCode(...signature)).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '').slice(0, 32);
}
export async function sha256Hex(data: ArrayBuffer | Uint8Array) {
  const digest = await crypto.subtle.digest('SHA-256', data as unknown as ArrayBuffer);
  return [...new Uint8Array(digest)].map(byte => byte.toString(16).padStart(2, '0')).join('');
}
