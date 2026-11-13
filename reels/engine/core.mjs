// Seeded randomness, number formatting and colour helpers shared by all formats.

export function rng(seed) {
  let a = seed >>> 0 || 1;
  const next = () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
  const r = {
    next,
    range: (lo, hi) => lo + (hi - lo) * next(),
    int: (lo, hi) => lo + Math.floor(next() * (hi - lo + 1)),
    pick: arr => arr[Math.floor(next() * arr.length)],
    chance: p => next() < p,
    normal: () => {
      const u = Math.max(next(), 1e-9), v = next();
      return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v);
    },
    shuffle: arr => {
      const out = arr.slice();
      for (let i = out.length - 1; i > 0; i--) {
        const j = Math.floor(next() * (i + 1));
        [out[i], out[j]] = [out[j], out[i]];
      }
      return out;
    },
    fork: () => rng(Math.floor(next() * 2 ** 32)),
  };
  return r;
}

const SUFFIX = ['', 'K', 'M', 'B', 'T', 'Qa', 'Qi', 'Sx', 'Sp', 'Oc', 'No', 'Dc'];

/** 1234 -> "1,234"; above 10M -> "12.3M" style. */
export function fmt(n, { compactFrom = 1e7 } = {}) {
  if (!Number.isFinite(n)) return '∞';
  n = Math.max(0, n);
  if (n < compactFrom) return Math.round(n).toLocaleString('en-US');
  let i = 0;
  while (n >= 1000 && i < SUFFIX.length - 1) { n /= 1000; i++; }
  const s = n >= 100 ? n.toFixed(0) : n >= 10 ? n.toFixed(1) : n.toFixed(2);
  return s.replace(/\.0+$/, '').replace(/(\.\d)0$/, '$1') + SUFFIX[i];
}

/** Rounds to a "nice" number people like reading: 12,500 / 40,000 / 1,000,000. */
export function nice(n) {
  if (n <= 10) return Math.max(1, Math.round(n));
  const p = 10 ** Math.floor(Math.log10(n));
  const steps = [1, 1.2, 1.5, 2, 2.5, 3, 4, 5, 6, 7.5, 8, 10];
  let best = p, bestErr = Infinity;
  for (const s of steps) {
    const v = s * p, e = Math.abs(Math.log(v / n));
    if (e < bestErr) { best = v; bestErr = e; }
  }
  return Math.round(best);
}

export const clamp = (v, lo, hi) => (v < lo ? lo : v > hi ? hi : v);
export const lerp = (a, b, t) => a + (b - a) * t;
export const easeOut = t => 1 - (1 - t) ** 3;

export function hexToRgb(hex) {
  const h = hex.replace('#', '');
  return [parseInt(h.slice(0, 2), 16), parseInt(h.slice(2, 4), 16), parseInt(h.slice(4, 6), 16)];
}

export function hsl(h, s, l) {
  h = ((h % 360) + 360) % 360; s /= 100; l /= 100;
  const k = n => (n + h / 30) % 12, a = s * Math.min(l, 1 - l);
  const f = n => l - a * Math.max(-1, Math.min(k(n) - 3, Math.min(9 - k(n), 1)));
  return [Math.round(f(0) * 255), Math.round(f(8) * 255), Math.round(f(4) * 255)];
}

export const rgbStr = ([r, g, b], a = 1) => (a >= 1 ? `rgb(${r},${g},${b})` : `rgba(${r},${g},${b},${a})`);
export const mix = (c1, c2, t) => c1.map((v, i) => Math.round(v + (c2[i] - v) * t));

// Named neon colours used for teams / players. Names appear on screen.
export const NEON = [
  { name: 'PINK', hex: '#ff3d8b' }, { name: 'CYAN', hex: '#22d3ee' }, { name: 'LIME', hex: '#a3e635' },
  { name: 'YELLOW', hex: '#facc15' }, { name: 'ORANGE', hex: '#fb923c' }, { name: 'PURPLE', hex: '#a855f7' },
  { name: 'BLUE', hex: '#3b82f6' }, { name: 'RED', hex: '#ef4444' }, { name: 'GREEN', hex: '#22c55e' },
  { name: 'WHITE', hex: '#f1f5f9' }, { name: 'MINT', hex: '#5eead4' }, { name: 'GOLD', hex: '#f59e0b' },
].map(c => ({ ...c, rgb: hexToRgb(c.hex) }));

/** Background themes: base colour pairs for the vertical gradient. */
export const THEMES = [
  { name: 'night', top: [10, 10, 24], bottom: [4, 4, 12] },
  { name: 'violet', top: [22, 10, 38], bottom: [6, 4, 14] },
  { name: 'ocean', top: [6, 20, 34], bottom: [2, 6, 12] },
  { name: 'ember', top: [30, 12, 12], bottom: [8, 4, 6] },
  { name: 'forest', top: [8, 24, 18], bottom: [3, 8, 6] },
  { name: 'ink', top: [16, 16, 18], bottom: [6, 6, 8] },
];
