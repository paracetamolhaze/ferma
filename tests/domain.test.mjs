import test from 'node:test';
import assert from 'node:assert/strict';
import { validateSchedule, validateTargets } from '../lib/domain.ts';
test('never schedules an invalid or past time that the provider could publish immediately', () => {
  for (const value of ['', 'not a date', new Date(Date.now()-60000).toISOString()]) assert.throws(() => validateSchedule(value));
  const future = new Date(Date.now()+3600000).toISOString();
  assert.equal(validateSchedule(future), future);
});
test('accepts two supported destinations and enforces format requirements', () => {
  assert.doesNotThrow(() => validateTargets(['youtube','tiktok'], 'Caption', 'video'));
  assert.doesNotThrow(() => validateTargets(['threads','twitter'], 'Caption'));
  assert.throws(() => validateTargets(['youtube'], 'Caption', 'image'));
  assert.throws(() => validateTargets(['instagram'], 'Caption'));
  assert.throws(() => validateTargets(['threads','twitter','instagram'], 'Caption', 'image'));
  assert.throws(() => validateTargets(['twitter','twitter'], 'Caption'));
  assert.throws(() => validateTargets(['unknown'], 'Caption'));
});
test('rejects captions over the supported destination limits', () => {
  assert.throws(() => validateTargets(['twitter'], 'a'.repeat(281)));
  assert.throws(() => validateTargets(['threads'], 'a'.repeat(501)));
  assert.throws(() => validateTargets(['instagram'], 'a'.repeat(2201), 'image'));
});
