// Sound engine: plays real recorded samples (CC0) from ../sounds.
// Instruments: VCSL (Versilian Community Sample Library, CC0) — marimba, kalimba, glockenspiel, vibraphone,
// xylophone, concert harp, Kawai grand piano, hand chimes. Effects: VCSL percussion + Freesound CC0 recordings.
// Licences and sources per file: ../sounds/credits.json.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { rng as mkRng } from './core.mjs';

const SR = 48000;
const DIR = path.join(path.dirname(fileURLToPath(import.meta.url)), '../sounds');
const MANIFEST = JSON.parse(fs.readFileSync(path.join(DIR, 'manifest.json'), 'utf8'));
export const midiToFreq = m => 440 * 2 ** ((m - 69) / 12);

// Old timbre names used by the formats -> recorded instruments
const INSTRUMENT = { kalimba: 'kalimba', marimba: 'marimba', glass: 'vibes', vibes: 'vibes', bell: 'glock', glock: 'glock',
  piano: 'piano', pluck: 'harp', harp: 'harp', chimes: 'chimes', xylo: 'xylo' };

// Pentatonic scales sound good whatever order the notes come in.
export const SCALES = {
  majorPenta: [0, 2, 4, 7, 9],
  minorPenta: [0, 3, 5, 7, 10],
  lydian: [0, 2, 4, 6, 7, 9, 11],
  dorian: [0, 2, 3, 5, 7, 9, 10],
};

export function scaleNote(root, scale, step) {
  const s = SCALES[scale] || SCALES.majorPenta;
  const oct = Math.floor(step / s.length), idx = ((step % s.length) + s.length) % s.length;
  return root + oct * 12 + s[idx];
}

const wavCache = new Map();
function loadWav(rel) {
  if (wavCache.has(rel)) return wavCache.get(rel);
  const buf = fs.readFileSync(path.join(DIR, rel));
  let p = 12, data = null;
  while (p < buf.length - 8) {
    const id = buf.toString('ascii', p, p + 4), size = buf.readUInt32LE(p + 4);
    if (id === 'data') { data = buf.subarray(p + 8, p + 8 + size); break; }
    p += 8 + size + (size & 1);
  }
  const out = new Float32Array(data.length / 2);
  for (let i = 0; i < out.length; i++) out[i] = data.readInt16LE(i * 2) / 32767;
  wavCache.set(rel, out);
  return out;
}

/** Recorded range of an instrument (MIDI), for transposing whole melodies. */
export function instrumentRange(timbre) {
  const rows = MANIFEST.instruments[INSTRUMENT[timbre] || 'marimba'];
  return [rows[0].midi, rows[rows.length - 1].midi];
}

/** Keeps a note inside the instrument's recorded range by moving it whole octaves. */
function fitRange(inst, midi) {
  const rows = MANIFEST.instruments[inst], lo = rows[0].midi, hi = rows[rows.length - 1].midi;
  while (midi < lo - 2) midi += 12;
  while (midi > hi + 2) midi -= 12;
  return midi;
}

const noteCache = new Map();
/** Resampled instrument note (nearest recorded sample, pitch-shifted by playback rate). */
function instrumentNote(timbre, midi, maxLen = 2.5) {
  const inst = INSTRUMENT[timbre] || 'marimba';
  midi = fitRange(inst, Math.round(midi));
  const key = `${inst}:${midi}:${maxLen}`;
  if (noteCache.has(key)) return noteCache.get(key);
  const rows = MANIFEST.instruments[inst];
  let best = rows[0];
  for (const r of rows) if (Math.abs(r.midi - midi) < Math.abs(best.midi - midi)) best = r;
  const src = loadWav(best.file), rate = 2 ** ((midi - best.midi) / 12);
  const n = Math.min(Math.floor(src.length / rate), Math.floor(maxLen * SR)), out = new Float32Array(n);
  for (let i = 0; i < n; i++) {
    const x = i * rate, k = Math.floor(x), f = x - k;
    out[i] = (src[k] || 0) * (1 - f) + (src[k + 1] || 0) * f;
  }
  const fade = Math.min(n, Math.floor(0.08 * SR));
  for (let i = 0; i < fade; i++) out[n - 1 - i] *= i / fade;
  noteCache.set(key, out);
  return out;
}

const shotCache = new Map();
function oneShot(rel, rate = 1) {
  const key = `${rel}:${rate.toFixed(3)}`;
  if (shotCache.has(key)) return shotCache.get(key);
  const src = loadWav(rel);
  if (rate === 1) { shotCache.set(key, src); return src; }
  const n = Math.floor(src.length / rate), out = new Float32Array(n);
  for (let i = 0; i < n; i++) { const x = i * rate, k = Math.floor(x), f = x - k; out[i] = (src[k] || 0) * (1 - f) + (src[k + 1] || 0) * f; }
  shotCache.set(key, out);
  return out;
}

export class Sfx {
  constructor({ timbre = 'kalimba', maxPerSec = 40, master = 0.8, seed = 1 } = {}) {
    this.timbre = timbre;
    this.events = [];
    this.maxPerSec = maxPerSec;
    this.master = master;
    this.buckets = new Map();
    this.rng = mkRng(seed ^ 0x50d);
    // one fixed variant per video for the "signature" sounds, random per event for small ones
    this.fixed = {};
    for (const [g, files] of Object.entries(MANIFEST.groups)) this.fixed[g] = files[Math.floor(this.rng.next() * files.length)];
  }

  limited(t, key, perSec) {
    const b = `${key}:${Math.floor(t * 20)}`, lim = Math.max(1, Math.round(perSec / 20)), c = this.buckets.get(b) || 0;
    if (c >= lim) return false;
    this.buckets.set(b, c + 1);
    return true;
  }

  push(t, buf, vol, pan) { this.events.push({ t, buf, vol, pan }); }
  shot(group, { perEvent = false, rate = 1 } = {}) {
    const files = MANIFEST.groups[group];
    const f = perEvent ? files[Math.floor(this.rng.next() * files.length)] : this.fixed[group];
    return oneShot(f, rate);
  }

  /** Rate-limited instrument note: wall / floor / pad bounces. */
  bounce(t, midi, vol = 0.35, pan = 0, timbre = this.timbre) {
    if (!this.limited(t, 'b', this.maxPerSec)) return false;
    this.push(t, instrumentNote(timbre, midi, 1.6), vol, pan);
    return true;
  }

  /** Always plays (melody notes, key moments). */
  note(t, midi, vol = 0.5, pan = 0, timbre = this.timbre, len = 2.5) { this.push(t, instrumentNote(timbre, midi, len), vol, pan); }

  chord(t, midis, vol = 0.35, timbre = 'chimes', spread = 0.07) {
    midis.forEach((m, i) => this.note(t + i * spread, m, vol, (i / Math.max(1, midis.length - 1)) * 0.8 - 0.4, timbre, 3));
  }

  /** Short percussive hit from a sample group (woodblock, bongo...), rate-limited. */
  hit(t, group, vol = 0.3, pan = 0, perSec = 12, rate = 1) {
    if (!this.limited(t, group, perSec)) return;
    this.push(t, this.shot(group, { perEvent: true, rate }), vol, pan);
  }

  boom(t, vol = 0.8) { this.push(t, this.shot('timpani'), vol * 0.9, 0); this.push(t, this.shot('bassdrum'), vol * 0.6, 0); }
  pop(t, vol = 0.3, freq = 700, pan = 0) {
    if (!this.limited(t, 'pop', 30)) return;
    const rate = Math.min(1.6, Math.max(0.7, freq / 700)) * (0.95 + 0.1 * this.rng.next());
    this.push(t, this.shot('pop', { perEvent: true, rate }), vol, pan);
  }
  shatter(t, vol = 0.6) { this.push(t, this.shot('glass'), vol, 0); }
  crash(t, vol = 0.9) { this.push(t, this.shot('cymbal'), vol * 0.8, 0); this.push(t, this.shot('explosion'), vol * 0.7, 0); }
  glitch(t, vol = 0.5) { this.push(t, this.shot('glitch'), vol, 0); }
  whoosh(t, vol = 0.4) { this.push(t, this.shot('whoosh'), vol, 0); }
  gong(t, vol = 0.6) { this.push(t, this.shot('gong'), vol, 0); }
  shimmer(t, vol = 0.45) { this.push(t, this.shot('marktree'), vol, 0); }
  tick(t, vol = 0.35) { this.push(t, this.shot('wood', { perEvent: true }), vol, 0); }

  /** Win moment: wind chimes + bright chord. */
  win(t, root = 60, vol = 0.45) {
    this.shimmer(t, vol);
    this.chord(t + 0.05, [root, root + 4, root + 7, root + 12], vol * 0.8, 'chimes');
  }

  /** Background pad was synthesised; removed — real samples only. Kept as a no-op for old callers. */
  pad() {}

  render(seconds) {
    const n = Math.ceil(seconds * SR), L = new Float32Array(n), R = new Float32Array(n);
    for (const e of this.events) {
      const i0 = Math.floor(e.t * SR);
      if (i0 >= n || i0 < 0) continue;
      const gl = e.vol * Math.min(1, 1 - e.pan), gr = e.vol * Math.min(1, 1 + e.pan), buf = e.buf;
      const m = Math.min(buf.length, n - i0);
      for (let k = 0; k < m; k++) { L[i0 + k] += buf[k] * gl; R[i0 + k] += buf[k] * gr; }
    }
    // loudness: RMS over the busiest second decides the gain, then a soft limiter catches peaks
    let sum = 0;
    for (let i = 0; i < n; i++) sum += L[i] * L[i] + R[i] * R[i];
    const rms = Math.sqrt(sum / (2 * n)) || 1e-6, gain = Math.min(8, 0.17 / rms) * this.master;
    // peak limiter: instant attack, 150 ms release, ceiling 0.84 (-1.5 dBFS, room for AAC overshoot)
    const ceil = 0.84, rel = Math.exp(-1 / (0.15 * SR));
    let env = 0;
    for (let i = 0; i < n; i++) {
      const l = L[i] * gain, r = R[i] * gain, a = Math.max(Math.abs(l), Math.abs(r));
      env = a > env ? a : env * rel + a * (1 - rel);
      const g = env > ceil ? ceil / env : 1;
      L[i] = l * g; R[i] = r * g;
    }
    const fade = Math.floor(0.3 * SR);
    for (let i = 0; i < fade && i < n; i++) { const g = i / fade; L[n - 1 - i] *= g; R[n - 1 - i] *= g; }
    return { L, R, n };
  }

  wav(seconds) {
    const { L, R, n } = this.render(seconds);
    const buf = Buffer.alloc(44 + n * 4);
    buf.write('RIFF', 0); buf.writeUInt32LE(36 + n * 4, 4); buf.write('WAVE', 8); buf.write('fmt ', 12);
    buf.writeUInt32LE(16, 16); buf.writeUInt16LE(1, 20); buf.writeUInt16LE(2, 22); buf.writeUInt32LE(SR, 24);
    buf.writeUInt32LE(SR * 4, 28); buf.writeUInt16LE(4, 32); buf.writeUInt16LE(16, 34); buf.write('data', 36); buf.writeUInt32LE(n * 4, 40);
    for (let i = 0; i < n; i++) {
      buf.writeInt16LE(Math.round(Math.max(-1, Math.min(1, L[i])) * 32767), 44 + i * 4);
      buf.writeInt16LE(Math.round(Math.max(-1, Math.min(1, R[i])) * 32767), 46 + i * 4);
    }
    return buf;
  }
}

// Public-domain melodies (folk songs and composers who died long ago), MIDI note numbers.
export const MELODIES = {
  'Ode to Joy': [64, 64, 65, 67, 67, 65, 64, 62, 60, 60, 62, 64, 64, 62, 62, 64, 64, 65, 67, 67, 65, 64, 62, 60, 60, 62, 64, 62, 60, 60,
    62, 62, 64, 60, 62, 64, 65, 64, 60, 62, 64, 65, 64, 62, 60, 62, 55, 64, 64, 65, 67, 67, 65, 64, 62, 60, 60, 62, 64, 62, 60, 60],
  'Fur Elise': [76, 75, 76, 75, 76, 71, 74, 72, 69, 60, 64, 69, 71, 64, 68, 71, 72, 64, 76, 75, 76, 75, 76, 71, 74, 72, 69, 60, 64, 69, 71, 64, 72, 71, 69,
    76, 75, 76, 75, 76, 71, 74, 72, 69, 60, 64, 69, 71, 64, 68, 71, 72, 64, 76, 75, 76, 75, 76, 71, 74, 72, 69, 60, 64, 69, 71, 64, 72, 71, 69],
  'Twinkle Twinkle': [60, 60, 67, 67, 69, 69, 67, 65, 65, 64, 64, 62, 62, 60, 67, 67, 65, 65, 64, 64, 62, 67, 67, 65, 65, 64, 64, 62,
    60, 60, 67, 67, 69, 69, 67, 65, 65, 64, 64, 62, 62, 60],
  'Hall of the Mountain King': [59, 61, 62, 64, 66, 62, 66, 65, 61, 65, 64, 60, 64, 59, 61, 62, 64, 66, 62, 66, 71, 69, 66, 62, 66, 69,
    66, 68, 69, 71, 73, 69, 73, 72, 68, 72, 71, 67, 71, 66, 68, 69, 71, 73, 69, 73, 78, 76, 73, 69, 73, 76],
  Korobeiniki: [76, 71, 72, 74, 72, 71, 69, 69, 72, 76, 74, 72, 71, 72, 74, 76, 72, 69, 69, 74, 77, 81, 79, 77, 76, 72, 76, 74, 72, 71, 71, 72, 74, 76, 72, 69, 69,
    76, 71, 72, 74, 72, 71, 69, 69, 72, 76, 74, 72, 71, 72, 74, 76, 72, 69, 69],
  'Jingle Bells': [64, 64, 64, 64, 64, 64, 64, 67, 60, 62, 64, 65, 65, 65, 65, 65, 64, 64, 64, 64, 62, 62, 64, 62, 67,
    64, 64, 64, 64, 64, 64, 64, 67, 60, 62, 64, 65, 65, 65, 65, 65, 64, 64, 64, 67, 67, 65, 62, 60],
  'Happy Birthday': [67, 67, 69, 67, 72, 71, 67, 67, 69, 67, 74, 72, 67, 67, 79, 76, 72, 71, 69, 77, 77, 76, 72, 74, 72],
};
