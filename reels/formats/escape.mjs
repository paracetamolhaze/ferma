// "Each escape = 2 new balls, until my PC crashes" — balls bounce inside rotating rings with gaps.
// Every ball that escapes comes back as k new balls in the centre. At the target count the ring bursts.
import { rng as mkRng, fmt, clamp, THEMES, NEON, rgbStr, hsl, mix, lerp } from '../engine/core.mjs';
import { Balls, Particles, collideBalls, angDiff } from '../engine/phys.mjs';
import { Sfx, scaleNote } from '../engine/audio.mjs';
import { W, background, text, pill, banner, dots } from '../engine/draw.mjs';
import { simulate } from '../engine/run.mjs';

const CX = 540, CY = 1000, TH = 12, GRAV = 1300;

function makeScene(P, { headless = false } = {}) {
  const r = mkRng(P.seed ^ 0xe5c);
  const fx = mkRng(P.seed ^ 0xf00d); // visuals + sound only, never physics
  const sfx = new Sfx({ timbre: P.timbre, maxPerSec: 26, seed: P.seed });
  const b = new Balls(P.end + 64), out = new Balls(6000), parts = new Particles(3000);
  const NR = P.rings.length;
  const colorFor = k => (P.palette === 'rainbow' ? hsl(P.hue0 + k * 137.5, 85, 60) : mix(P.duo[k % 2], [255, 255, 255], (k * 0.37) % 0.25));
  let made = 0;
  const spawn = () => {
    const a = r.range(0, Math.PI * 2), s = r.range(450, 800);
    b.add(CX + r.range(-6, 6), CY + r.range(-6, 6), Math.cos(a) * s, Math.sin(a) * s, P.radius, colorFor(made++), 0);
  };
  spawn();
  const S = {
    sfx, substeps: 4, finished: false, hold: 3.0, escaped: 0, shown: 1, endAt: null, burst: false, maxCount: 1,
    update(dt, t) {
      const n0 = b.n;
      if (S.endAt === null) {
        for (let i = 0; i < b.n; i++) { b.vy[i] += GRAV * dt; b.x[i] += b.vx[i] * dt; b.y[i] += b.vy[i] * dt; }
        collideBalls(b, P.radius * 2 + 1, 0.97, [CX - 430, CY - 430, CX + 430, CY + 430]);
        for (let i = b.n - 1; i >= 0; i--) {
          const dx = b.x[i] - CX, dy = b.y[i] - CY, d = Math.hypot(dx, dy) || 1e-6, rad = b.r[i];
          const nx = dx / d, ny = dy / d, a = Math.atan2(dy, dx);
          let z = b.tag[i];
          let bounced = false;
          if (z < NR) {
            const ring = P.rings[z], ph = ring.phase + ring.w * t, half = P.gap - Math.asin(Math.min(1, rad / ring.R));
            const inGap = Math.abs(angDiff(a, ph)) < half;
            if (d + rad > ring.R - TH / 2) {
              if (inGap) { if (d - rad > ring.R + TH / 2) b.tag[i] = ++z; }
              else if (d < ring.R) { place(i, nx, ny, ring.R - TH / 2 - rad); bounced = reflect(i, nx, ny, 1); }
              else { b.tag[i] = ++z; place(i, nx, ny, ring.R + TH / 2 + rad); }
            }
          }
          if (z > 0 && z <= NR) {
            const ring = P.rings[z - 1], ph = ring.phase + ring.w * t, half = P.gap - Math.asin(Math.min(1, rad / ring.R));
            const inGap = Math.abs(angDiff(a, ph)) < half;
            if (d - rad < ring.R + TH / 2) {
              if (inGap) { if (d + rad < ring.R - TH / 2) b.tag[i] = --z; }
              else if (d > ring.R) { place(i, nx, ny, ring.R + TH / 2 + rad); bounced = reflect(i, nx, ny, -1); }
              else { b.tag[i] = --z; place(i, nx, ny, ring.R - TH / 2 - rad); }
            }
          }
          if (bounced && !headless) sfx.bounce(t, scaleNote(P.root, P.scale, Math.floor(((a + Math.PI) / (2 * Math.PI)) * 10)), 0.2, nx * 0.6);
          if (b.tag[i] >= NR) {
            // escaped: fall away, spawn k new balls in the centre
            const c = [b.col[i * 3], b.col[i * 3 + 1], b.col[i * 3 + 2]];
            out.add(b.x[i], b.y[i], b.vx[i], b.vy[i], b.r[i], c);
            b.remove(i);
            S.escaped++;
            for (let k = 0; k < P.k && b.n < b.cap; k++) spawn();
            if (!headless) sfx.pop(t, 0.28, 500 + Math.min(900, b.n * 0.6), 0);
          }
        }
        if (b.n >= P.end) { S.endAt = t; if (!headless) sfx.glitch(t, 0.6); }
      } else if (!S.burst && t - S.endAt > 0.75) {
        // ring bursts: everything flies outward
        S.burst = true; S.finished = true;
        for (let i = 0; i < b.n; i++) {
          const dx = b.x[i] - CX, dy = b.y[i] - CY, d = Math.hypot(dx, dy) || 1;
          const s = fx.range(500, 1300);
          b.vx[i] = dx / d * s + fx.range(-100, 100); b.vy[i] = dy / d * s - fx.range(0, 300);
        }
        if (!headless) {
          for (const ring of P.rings) for (let k = 0; k < 60; k++) {
            const a = (k / 60) * Math.PI * 2;
            parts.burst(fx, CX + Math.cos(a) * ring.R, CY + Math.sin(a) * ring.R, 2, ring.rgb, 700, 5, 1.6);
          }
          sfx.crash(t, 0.9); sfx.shatter(t, 0.5); sfx.boom(t + 0.05, 0.7);
          sfx.win(t + 0.3, P.root + 12, 0.4);
        }
      } else if (S.burst) {
        for (let i = 0; i < b.n; i++) { b.vy[i] += GRAV * dt; b.x[i] += b.vx[i] * dt; b.y[i] += b.vy[i] * dt; }
      } else if (!headless && Math.floor((t - dt) * 12) !== Math.floor(t * 12)) {
        sfx.tick(t, 0.3);
      }
      for (let i = out.n - 1; i >= 0; i--) {
        out.vy[i] += GRAV * dt; out.x[i] += out.vx[i] * dt; out.y[i] += out.vy[i] * dt;
        if (out.y[i] > 2000) out.remove(i);
      }
      if (!headless) parts.step(dt);
      S.maxCount = Math.max(S.maxCount, b.n);
      S.shown = lerp(S.shown, b.n, Math.min(1, dt * 12));
      if (b.n === 0 && n0 === 0) S.finished = true;
    },
    forceEnd(t) { if (S.endAt === null) S.endAt = t; },
    draw(ctx, canvas, t) {
      ctx.drawImage(background(P.theme, { accent: P.rings[0].rgb }), 0, 0);
      const glitch = S.endAt !== null && !S.burst ? (t - S.endAt) / 0.75 : 0;
      const shx = glitch ? fx.range(-1, 1) * 22 * glitch : 0, shy = glitch ? fx.range(-1, 1) * 22 * glitch : 0;
      text(ctx, P.title, W / 2, 300, { size: 72, stroke: 12, maxW: 1000 });
      pill(ctx, P.sub, W / 2, 395, { size: 32 });
      if (!S.burst) {
        ctx.save(); ctx.translate(shx, shy);
        for (const ring of P.rings) {
          const ph = ring.phase + ring.w * t;
          ctx.beginPath(); ctx.arc(CX, CY, ring.R, ph + P.gap, ph - P.gap + Math.PI * 2);
          ctx.lineWidth = TH; ctx.lineCap = 'round';
          ctx.strokeStyle = glitch && fx.chance(0.4) ? '#fff' : rgbStr(ring.rgb);
          ctx.shadowColor = rgbStr(ring.rgb); ctx.shadowBlur = 28; ctx.stroke(); ctx.shadowBlur = 0;
        }
        ctx.restore();
      }
      const px = canvas.data();
      dots(px, out, { gloss: true, alpha: i => clamp(1 - (out.y[i] - CY) / 900, 0.15, 0.8) });
      dots(px, b, { glow: b.n < 300 ? 0.5 : 0, ox: shx, oy: shy });
      dots(px, parts.p, { gloss: false, alpha: i => Math.min(1, parts.p.aux[i] / 0.4) });
      if (glitch) { ctx.fillStyle = `rgba(255,255,255,${0.12 * glitch * (fx.chance(0.5) ? 1 : 0)})`; ctx.fillRect(0, 0, W, 1920); }
      text(ctx, fmt(Math.round(S.burst ? S.maxCount : S.shown)), W / 2, 1495, { size: 104, family: 'Chakra', color: '#fff', stroke: 10, glow: 26, glowColor: rgbStr(P.rings[0].rgb) });
      text(ctx, `BALLS  ·  ${fmt(S.escaped)} ESCAPED`, W / 2, 1572, { size: 30, color: 'rgba(255,255,255,0.8)' });
      if (S.burst) banner(ctx, P.endTitle, `AT ${fmt(P.end)} BALLS`, '#fff', (t - S.endAt - 0.75) / 0.35);
    },
  };
  function place(i, nx, ny, dist) { b.x[i] = CX + nx * dist; b.y[i] = CY + ny * dist; }
  function reflect(i, nx, ny, sign) {
    const vn = (b.vx[i] * nx + b.vy[i] * ny) * sign;
    if (vn <= 0) return false;
    b.vx[i] -= 2 * vn * nx * sign; b.vy[i] -= 2 * vn * ny * sign;
    const sp = Math.hypot(b.vx[i], b.vy[i]);
    if (sp < 520) { b.vx[i] *= 520 / sp; b.vy[i] *= 520 / sp; }
    if (sp > 1700) { b.vx[i] *= 1700 / sp; b.vy[i] *= 1700 / sp; }
    return true;
  }
  if (!headless) sfx.pad(0, 70, P.root - 12, 0.05);
  return S;
}

export function plan(seed) {
  const r = mkRng(seed);
  const multi = r.chance(0.4), k = r.pick([2, 2, 3]);
  const end = k === 2 ? r.pick([1024, 2048, 1500, 2000]) : r.pick([1500, 2000, 2500]);
  const radius = clamp(Math.sqrt((0.5 * 395 * 395) / end), 5, 12);
  const cols = r.shuffle(NEON);
  const dir = r.chance(0.5) ? 1 : -1;
  const rings = (multi ? [400, 305, 210] : [400]).map((R, i) => ({ R, w: dir * (i % 2 ? -1 : 1) * r.range(0.45, 1.1), phase: r.range(0, Math.PI * 2), rgb: cols[i].rgb }));
  const base = { seed, k, end, radius, rings, theme: r.pick(THEMES), timbre: r.pick(['kalimba', 'glass', 'marimba']), root: r.int(55, 62),
    scale: r.pick(['majorPenta', 'minorPenta', 'lydian']), palette: r.chance(0.65) ? 'rainbow' : 'duo', hue0: r.range(0, 360), duo: [cols[3].rgb, cols[4].rgb] };
  const target = r.range(38, 47);
  // bisection on the gap size: bigger gap -> faster growth
  let lo = 0.06, hi = 0.75, best = null;
  for (let it = 0; it < 9; it++) {
    const gap = (lo + hi) / 2, P = { ...base, gap }, S = makeScene(P, { headless: true });
    simulate(S, 70);
    const tEnd = S.endAt ?? 99;
    if (!best || Math.abs(tEnd - target) < Math.abs(best.tEnd - target)) best = { P, tEnd };
    if (tEnd > target) lo = gap; else hi = gap;
    if (Math.abs(tEnd - target) < 1) break;
  }
  const P = best.P;
  P.title = r.pick([`EACH ESCAPE = ${k} NEW BALLS`, `1 ESCAPE = ${k} MORE BALLS`, `EVERY ESCAPE SPAWNS ${k} BALLS`]);
  P.sub = r.pick(['UNTIL MY PC CRASHES', `CAN IT REACH ${fmt(end)}?`, 'WAIT FOR THE END']);
  P.endTitle = r.pick(['IT BROKE!', 'PC CRASHED', 'OVERLOAD!']);
  P.caption = r.pick([
    `Every ball that escapes comes back as ${k} 😳 What happens at ${fmt(end)}?`,
    `1 ball. ${multi ? '3 spinning rings' : '1 tiny exit'}. Every escape adds more. Wait for the end 💀`,
    `Ball ×${k} after each escape until my computer gives up 🤯`,
  ]) + ' ' + r.shuffle(['#satisfying', '#bouncingball', '#physics', '#simulation', '#adhd', '#oddlysatisfying']).slice(0, 5).join(' ');
  P.meta = { gap: +P.gap.toFixed(3), endAt: +best.tEnd.toFixed(2), multi };
  return P;
}

export const scene = P => makeScene(P);
export const id = 'escape';
