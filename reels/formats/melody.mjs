// "Guess the song" — every bounce plays the next note of a public-domain melody; the ball grows each bounce
// until it fills the circle exactly on the last note.
import { createCanvas } from '@napi-rs/canvas';
import { rng as mkRng, clamp, THEMES, rgbStr, hsl } from '../engine/core.mjs';
import { Balls, Particles } from '../engine/phys.mjs';
import { Sfx, MELODIES, instrumentRange } from '../engine/audio.mjs';
import { W, H, background, text, pill, banner, dots, bigBall } from '../engine/draw.mjs';
import { simulate } from '../engine/run.mjs';

const CX = 540, CY = 1010, R = 420;

function makeScene(P, { headless = false } = {}) {
  const r = mkRng(P.seed ^ 0x3e1);
  const fx = mkRng(P.seed ^ 0xf00d);
  const sfx = new Sfx({ timbre: P.timbre, seed: P.seed });
  const b = new Balls(1), parts = new Particles(1500);
  const notes = P.notes, N = notes.length, r0 = P.r0, dr = (R * 0.94 - r0) / N;
  b.add(CX + r.range(-60, 60), CY - 200, r.range(-1, 1) * P.v0, P.v0 * 0.3, r0, [255, 255, 255]);
  const anchors = [];
  let trail = null, lastHue = P.hue0;
  const S = {
    sfx, substeps: 8, finished: false, hold: 3.0, played: 0, doneAt: null,
    update(dt, t) {
      if (S.doneAt !== null) { if (!headless) parts.step(dt, 500); return; }
      b.vy[0] += P.g * dt; b.x[0] += b.vx[0] * dt; b.y[0] += b.vy[0] * dt;
      const dx = b.x[0] - CX, dy = b.y[0] - CY, d = Math.hypot(dx, dy), lim = R - b.r[0];
      if (d > lim) {
        const nx = dx / d, ny = dy / d;
        b.x[0] = CX + nx * lim; b.y[0] = CY + ny * lim;
        let vn = b.vx[0] * nx + b.vy[0] * ny;
        if (vn > 0) {
          b.vx[0] -= 2 * vn * nx; b.vy[0] -= 2 * vn * ny;
          // keep it lively: never graze along the wall
          vn = -(b.vx[0] * nx + b.vy[0] * ny);
          if (vn < P.vmin) { b.vx[0] -= (P.vmin - vn) * nx; b.vy[0] -= (P.vmin - vn) * ny; }
          const a = Math.atan2(b.vy[0], b.vx[0]) + r.range(-0.08, 0.08), sp = Math.hypot(b.vx[0], b.vy[0]);
          b.vx[0] = Math.cos(a) * sp; b.vy[0] = Math.sin(a) * sp;
          const m = notes[S.played];
          if (!headless) {
            sfx.note(t, m, 0.6, nx * 0.5, P.timbre, 1.4);
            anchors.push({ x: CX + nx * R, y: CY + ny * R, hue: P.hue0 + S.played * P.hueStep });
            parts.burst(fx, CX + nx * R, CY + ny * R, 6, hsl(P.hue0 + S.played * P.hueStep, 90, 65), 260, 3, 0.5);
          }
          S.played++;
          b.r[0] = r0 + dr * S.played;
          if (S.played >= N) {
            S.doneAt = t; S.finished = true;
            if (!headless) {
              parts.burst(fx, b.x[0], b.y[0], 260, hsl(P.hue0 + N * P.hueStep, 90, 65), 900, 6, 1.6);
              sfx.shimmer(t + 0.15, 0.5);
              sfx.chord(t + 0.35, [notes[N - 1] - 12, notes[N - 1] - 8, notes[N - 1] - 5, notes[N - 1]], 0.45, P.timbre);
            }
          }
        }
      }
      if (!headless) parts.step(dt, 500);
    },
    forceEnd(t) { if (S.doneAt === null) { S.doneAt = t; S.finished = true; } },
    draw(ctx, canvas, t) {
      ctx.drawImage(background(P.theme, { grid: false }), 0, 0);
      text(ctx, P.title, W / 2, 285, { size: 84, stroke: 12, maxW: 1000 });
      pill(ctx, P.sub, W / 2, 378, { size: 32 });
      const hue = P.hue0 + S.played * P.hueStep;
      if (P.style === 'trail') {
        if (!trail) trail = createCanvas(W, H);
        const tc = trail.getContext('2d');
        if (S.doneAt === null) {
          tc.lineWidth = 3; tc.strokeStyle = rgbStr(hsl(lastHue + (hue - lastHue) * 0.5, 85, 60), 0.9);
          tc.beginPath(); tc.arc(b.x[0], b.y[0], b.r[0], 0, Math.PI * 2); tc.stroke();
          lastHue = hue;
        }
        ctx.drawImage(trail, 0, 0);
      }
      ctx.beginPath(); ctx.arc(CX, CY, R, 0, Math.PI * 2);
      ctx.lineWidth = 8; ctx.strokeStyle = rgbStr(hsl(hue, 80, 70)); ctx.shadowColor = rgbStr(hsl(hue, 90, 60)); ctx.shadowBlur = 26; ctx.stroke(); ctx.shadowBlur = 0;
      if (P.style === 'strings' && S.doneAt === null) {
        ctx.lineWidth = 2;
        for (const a of anchors) { ctx.strokeStyle = rgbStr(hsl(a.hue, 85, 62), 0.75); ctx.beginPath(); ctx.moveTo(a.x, a.y); ctx.lineTo(b.x[0], b.y[0]); ctx.stroke(); }
      }
      if (S.doneAt === null) bigBall(ctx, b.x[0], b.y[0], b.r[0], hsl(hue, 85, 60), { ring: '#fff' });
      dots(canvas.data(), parts.p, { gloss: false, alpha: i => Math.min(1, parts.p.aux[i] / 0.4) });
      text(ctx, `NOTE ${Math.min(S.played, N)}/${N}`, W / 2, 1500, { size: 44, family: 'Chakra', color: '#fff', stroke: 8 });
      if (S.doneAt !== null) banner(ctx, P.reveal ? 'IT WAS' : 'DID YOU GUESS IT?', P.reveal ? P.songName : 'COMMENT THE SONG', rgbStr(hsl(hue, 85, 65)), (t - S.doneAt - 0.5) / 0.35);
    },
  };
  return S;
}

export function plan(seed) {
  const r = mkRng(seed);
  const name = r.pick(Object.keys(MELODIES));
  let notes = MELODIES[name].slice();
  while (notes.length < 46) notes = notes.concat(MELODIES[name]);
  notes = notes.slice(0, r.int(Math.min(46, notes.length), Math.min(80, notes.length)));
  const timbre = r.pick(['piano', 'bell', 'kalimba', 'marimba', 'pluck', 'glass']);
  // transpose the whole melody (keeps its shape) into the instrument's recorded range
  let shift = r.int(-3, 3);
  const [rLo, rHi] = instrumentRange(timbre);
  const center = (Math.min(...notes) + Math.max(...notes)) / 2 + shift;
  shift += Math.round((Math.min(Math.max(center, rLo + 8), rHi - 8) - center) / 12) * 12;
  notes = notes.map(n => n + shift);
  const base = { seed, notes, songName: name.toUpperCase(), timbre, theme: r.pick(THEMES), style: r.pick(['strings', 'trail', 'strings']),
    r0: r.range(14, 22), hue0: r.range(0, 360), hueStep: r.range(5, 11), reveal: r.chance(0.5) };
  const target = r.range(40, 50);
  // bisection on gravity: stronger gravity -> faster bounces -> shorter video
  let lo = 300, hi = 4000, best = null;
  for (let it = 0; it < 14; it++) {
    const g = Math.sqrt(lo * hi), P = { ...base, g, v0: Math.sqrt(g) * 18, vmin: Math.sqrt(g) * 10 };
    const S = makeScene(P, { headless: true });
    simulate(S, 80);
    const T = S.doneAt ?? 99;
    if (!best || Math.abs(T - target) < Math.abs(best.T - target)) best = { P, T };
    if (T > target) lo = g; else hi = g;
    if (Math.abs(T - target) < 0.8) break;
  }
  const P = best.P;
  P.title = r.pick(['GUESS THE SONG', 'CAN YOU HEAR IT?', 'NAME THIS SONG']);
  P.sub = r.pick(['EVERY BOUNCE = 1 NOTE', 'SOUND ON', 'WAIT FOR THE MELODY']);
  P.caption = r.pick([
    'Can you guess the music 🎵? Every bounce plays the next note 👇',
    'Comment the melody you can hear! 🎶 Sound on',
    `Every bounce = 1 note. ${notes.length} notes. Did you get it before the end? 👇🎧`,
  ]) + ' ' + r.shuffle(['#satisfying', '#bouncingball', '#melody', '#music', '#guessthesong', '#physics']).slice(0, 5).join(' ');
  P.meta = { song: name, notes: notes.length, endAt: +best.T.toFixed(2), g: Math.round(P.g), style: P.style };
  return P;
}

export const scene = P => makeScene(P);
export const id = 'melody';
