import test from 'node:test';
import assert from 'node:assert/strict';
import { reelAllowed } from '../docker/autopilot.mjs';

const now = Date.parse('2026-11-12T15:00:00Z');
const profile = (items = []) => ({ profileId: 'p1', name: 'Diana', items });
const refused = updatedAt => ({ kind: 'reel', status: 'failed', updatedAt, error: 'Trial Reels require an Instagram account with 1,000+ followers. Publish as a regular Reel instead.' });

test('trial reels start by themselves at 1,000 Instagram followers, only where switched on', () => {
  assert.equal(reelAllowed(profile(), 999, { mode: 'on', now }), false, 'below the threshold');
  assert.equal(reelAllowed(profile(), null, { mode: 'on', now }), false, 'unknown count: wait');
  assert.equal(reelAllowed(profile(), 1000, { mode: 'on', now }), true);
  assert.equal(reelAllowed(profile(), 5000, { mode: 'off', now }), false, 'switched off for everyone');
  assert.equal(reelAllowed(profile(), 5000, { mode: 'katerina, diana', now }), true, 'named profiles, any case and spacing');
  assert.equal(reelAllowed(profile(), 5000, { mode: 'katerina', now }), false);
  assert.equal(reelAllowed(profile(), 50, { mode: 'on', min: 10, now }), true, 'the threshold can be changed');
});

test('after Instagram refuses a trial reel the profile waits a week, then tries again', () => {
  assert.equal(reelAllowed(profile([refused('2026-11-10T15:00:00Z')]), 1500, { mode: 'on', now }), false);
  assert.equal(reelAllowed(profile([refused('2026-11-04T15:00:00Z')]), 1500, { mode: 'on', now }), true);
  const other = { ...refused('2026-11-12T14:00:00Z'), error: 'Media rejected' };
  assert.equal(reelAllowed(profile([other]), 1500, { mode: 'on', now }), true, 'other failures do not pause reels');
});
