const ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';
export const TOTP_PERIOD = 30;

/** Accepts the key shown under "enter key manually", with spaces, or a whole otpauth:// link. */
export function normalizeTotpSecret(input: string) {
  let value = input.trim();
  if (/^otpauth:\/\//i.test(value)) {
    try { value = new URL(value).searchParams.get('secret') || ''; } catch { value = ''; }
  }
  value = value.replace(/[\s-]/g, '').replace(/=+$/, '').toUpperCase();
  if (value.length < 16 || value.length > 128 || [...value].some(char => !ALPHABET.includes(char))) {
    throw new Error('Ключ не похож на ключ приложения-аутентификатора. Скопируйте его из пункта «Ввести ключ вручную».');
  }
  return value;
}
function base32(secret: string) {
  let bits = 0, value = 0;
  const out: number[] = [];
  for (const char of secret) {
    value = (value << 5) | ALPHABET.indexOf(char);
    bits += 5;
    if (bits >= 8) { out.push((value >>> (bits - 8)) & 255); bits -= 8; }
  }
  return new Uint8Array(out);
}
/** RFC 6238 with the defaults every major platform uses: SHA-1, 6 digits, 30 seconds. */
export async function totpCode(secret: string, now = Date.now()) {
  const counter = Math.floor(now / 1000 / TOTP_PERIOD);
  const message = new Uint8Array(8);
  new DataView(message.buffer).setBigUint64(0, BigInt(counter));
  const key = await crypto.subtle.importKey('raw', base32(secret), { name: 'HMAC', hash: 'SHA-1' }, false, ['sign']);
  const hash = new Uint8Array(await crypto.subtle.sign('HMAC', key, message));
  const offset = hash[hash.length - 1] & 15;
  const binary = ((hash[offset] & 127) << 24) | (hash[offset + 1] << 16) | (hash[offset + 2] << 8) | hash[offset + 3];
  return { code: String(binary % 1_000_000).padStart(6, '0'), remaining: TOTP_PERIOD - (Math.floor(now / 1000) % TOTP_PERIOD) };
}
/** Pulls codes out of whatever the platform's backup page produced: numbered lists, spaces inside codes, both columns. */
export function parseBackupCodes(text: string) {
  const codes = text.split(/[\n,;]+|\s{2,}|\t/).map(line => line.replace(/^\s*\d{1,2}[.)]\s+/, '').trim().replace(/\s+/g, ' ')).filter(line => /^[A-Za-z0-9][A-Za-z0-9 -]{5,30}$/.test(line) && /\d/.test(line));
  return [...new Set(codes)].slice(0, 50);
}
