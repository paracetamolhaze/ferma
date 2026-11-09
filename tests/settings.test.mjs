import test from 'node:test';
import assert from 'node:assert/strict';
import { encryptSecret, decryptSecret, profileKeyContext, secretFingerprint } from '../lib/secret-crypto.ts';
import { zernioClient } from '../lib/zernio-client.ts';
import { validateZernioKey } from '../lib/zernio-validation.ts';
import { colorText } from '../lib/profile-colors.ts';

test('provider outages preserve status and produce readable errors even for empty responses', async () => {
  for (const status of [401,429,503]) {
    const client = zernioClient('fixture', async () => new Response('', {status}));
    await assert.rejects(client('/accounts'), error => error.status === status && error.message.includes('Zernio'));
  }
  await assert.rejects(zernioClient('fixture', async () => {throw new TypeError('Failed to fetch');})('/accounts'), /Не удалось связаться с Zernio/);
});

test('stored credentials are encrypted with random nonces and bound to the owner', async () => {
  const key = Buffer.from(crypto.getRandomValues(new Uint8Array(32))).toString('base64');
  const token = 'test-only-not-a-real-secret';
  const encrypted = await encryptSecret(token, key, 'owner');
  assert.notEqual(encrypted, await encryptSecret(token, key, 'owner'));
  assert.ok(!encrypted.includes(token));
  assert.equal(await decryptSecret(encrypted, key, 'owner'), token);
  await assert.rejects(decryptSecret(encrypted, key, 'other-owner'));
  await assert.rejects(decryptSecret(encrypted, Buffer.alloc(32).toString('base64'), 'owner'));
});
test('key validation uses the fixed Zernio destination and sanitizes provider errors', async () => {
  await validateZernioKey('test-key', async (url, options) => {
    assert.equal(url, 'https://zernio.com/api/v1/profiles');
    assert.equal(options.headers.Authorization, 'Bearer test-key');
    assert.equal(options.redirect, 'manual');
    return Response.json({ profiles: [] });
  });
  for (const status of [302, 401, 403, 429, 500]) {
    await assert.rejects(validateZernioKey('test-key', async () => new Response('secret-in-provider-error', { status })), error => !error.message.includes('secret-in-provider-error'));
  }
  await assert.rejects(validateZernioKey('test-key', async () => Response.json({ message: 'wrong' })));
  await assert.rejects(validateZernioKey('test-key', async () => { throw new Error('secret-network-detail'); }), error => !error.message.includes('secret-network-detail'));
});
test('custom profile backgrounds keep dark and light initials readable', () => {
  assert.equal(colorText('#000000'), '#ffffff');
  assert.equal(colorText('#ffffff'), '#000000');
  assert.equal(colorText('#eab308'), '#000000');
});
test('credentials cannot be moved between profiles of the same owner', async () => {
  const key = Buffer.from(crypto.getRandomValues(new Uint8Array(32))).toString('base64');
  const ciphertext = await encryptSecret('profile-a-key', key, profileKeyContext('owner', 'a'));
  assert.equal(await decryptSecret(ciphertext, key, profileKeyContext('owner', 'a')), 'profile-a-key');
  await assert.rejects(decryptSecret(ciphertext, key, profileKeyContext('owner', 'b')));
  assert.equal(await secretFingerprint('same-key', key, 'owner'), await secretFingerprint('same-key', key, 'owner'));
  assert.notEqual(await secretFingerprint('first-key', key, 'owner'), await secretFingerprint('second-key', key, 'owner'));
});
test('interleaved requests always use the originating profile key', async () => {
  const calls = [];
  const request = async (url, options) => { calls.push({ url, key: options.headers.Authorization }); return Response.json({ ok: true }); };
  const a = zernioClient('key-a', request), b = zernioClient('key-b', request);
  await Promise.all([
    a('/connect/youtube?profileId=a'), b('/connect/tiktok?profileId=b'),
    a('/media/presign', { method: 'POST' }), b('/posts', { method: 'POST' }, 'post-b'),
    a('/posts/a'), b('/accounts?profileId=b'),
  ]);
  assert.deepEqual(calls.map(call => call.key), ['Bearer key-a', 'Bearer key-b', 'Bearer key-a', 'Bearer key-b', 'Bearer key-a', 'Bearer key-b']);
  assert.throws(() => zernioClient('', request), /API-ключ/);
});
test('a valid replacement key can belong to a different Zernio account', async () => {
  const ids = await validateZernioKey('new-key', async url => {
    assert.equal(url, 'https://zernio.com/api/v1/profiles');
    return Response.json({ profiles: [{ _id: 'remote-b' }] });
  });
  assert.deepEqual(ids, ['remote-b']);
  await assert.rejects(validateZernioKey('bad', async () => Response.json({profiles:[{}]})));
});
