// "Break the wall?" — one ball in a closed arena; multiplier pads fire more balls (and grow +1 each touch);
// balls that hit the core deal damage. The director sets HP so the wall falls at ~40-47 s.
import { createCanvas } from '@napi-rs/canvas';
import { rng as mkRng, fmt, clamp, THEMES, NEON, rgbStr, hsl, mix, lerp } from '../engine/core.mjs';
import { Balls, Particles, insideCircle, outsideCircle } from '../engine/phys.mjs';
import { Sfx, scaleNote } from '../engine/audio.mjs';
import { W, H, background, text, pill, banner, dots, bar } from '../engine/draw.mjs';
import { simulate } from '../engine/run.mjs';

const CX = 540, CY = 1000, R = 430, CORE = 105, PAD = 40, SPEED = 720, CAP = 2200, PAD_CD = 0.7;

function makeScene(P, { headless = false } = {}) {
  const r = mkRng(P.seed ^ 0xa11);
  const fx = mkRng(P.seed ^ 0xf00d); // visuals + sound only, never physics
  const sfx = new Sfx({ timbre: P.timbre, maxPerSec: 22, seed: P.seed });
  const b = new Balls(CAP + 200), parts = new Particles(4000);
  const pads = P.pads.map(p => ({ ...p, v: p.v0, pulse: 0, cd: 0 }));
  let trail = null;
  const ballColor = () => (P.palette === 'rainbow' ? hsl(r.range(0, 360), 90, 62) : mix(P.ballRgb, [255, 255, 255], r.range(0, 0.3)));
  const launch = (x, y, ax, ay, rad, cd) => {
    const a = Math.atan2(ay, ax) + r.range(-1.2, 1.2);
    return b.add(x, y, Math.cos(a) * SPEED, Math.sin(a) * SPEED, rad, ballColor(), 0, cd);
  };
  b.add(CX + r.range(-200, 200), CY - 300, r.range(-1, 1) * SPEED * 0.6, SPEED * 0.8, 13, [255, 255, 255], 0, 0);
  const S = {
    sfx, substeps: 4, finished: false, hold: 3.0, hp: P.hp, damage: 0, power: 1, brokeAt: null, shake: 0, shownBalls: 1,
    dmgLog: [], nextLog: 0, cracks: [],
    update(dt, t) {
      for (const p of pads) { p.pulse = Math.max(0, p.pulse - dt * 5); p.cd -= dt; }
      S.shake = Math.max(0, S.shake - dt * 8);
      for (let i = b.n - 1; i >= 0; i--) {
        b.x[i] += b.vx[i] * dt; b.y[i] += b.vy[i] * dt;
        if (b.aux[i] > 0) b.aux[i] -= dt;
        insideCircle(b, i, CX, CY, R - 8, 1);
        for (const p of pads) {
          if (outsideCircle(b, i, p.x, p.y, PAD, 1) && b.aux[i] <= 0 && p.cd <= 0 && S.brokeAt === null) {
            b.aux[i] = 0.3;
            p.pulse = 1; p.cd = P.padCd ?? PAD_CD;
            const extra = p.op === 'mul' ? p.v - 1 : p.v;
            for (let k = 0; k < extra && b.n < CAP; k++) {
              const dx = b.x[i] - p.x, dy = b.y[i] - p.y;
              launch(p.x + dx * 1.15, p.y + dy * 1.15, dx, dy, P.small, 0.3);
            }
            p.v = Math.min(p.v + 1, 50);
            if (!headless) sfx.bounce(t, scaleNote(P.root, P.scale, Math.min(14, p.v)), 0.32, (p.x - CX) / 500);
          }
        }
        if (S.brokeAt === null && Math.hypot(b.x[i] - CX, b.y[i] - CY) < CORE + b.r[i]) {
          S.damage += 1;
          S.shake = Math.min(1, S.shake + 0.08);
          if (!headless) { if (fx.next() < 0.25) parts.burst(fx, b.x[i], b.y[i], 2, P.coreRgb, 250, 3, 0.4); sfx.hit(t, 'wood', 0.14, 0, 10); }
          b.remove(i);
          if (b.n === 0) launch(CX, CY - R + 40, 0, 1, 13, 0);
          if (S.damage >= S.hp) breakWall(t);
          continue;
        }
        if (S.brokeAt !== null) outsideCircle(b, i, CX, CY, -1, 1);
        const sp = Math.hypot(b.vx[i], b.vy[i]) || 1;
        b.vx[i] *= SPEED / sp; b.vy[i] *= SPEED / sp;
      }
      if (!headless) parts.step(dt, S.brokeAt === null ? 600 : 900);
      S.shownBalls = lerp(S.shownBalls, b.n, Math.min(1, dt * 10));
      if (t >= S.nextLog) { S.dmgLog.push([t, S.damage]); S.nextLog += 1 / 60; }
    },
    forceEnd(t) { breakWall(t); },
    draw(ctx, canvas, t) {
      if (!trail) { trail = createCanvas(W, H); const tc = trail.getContext('2d'); tc.fillStyle = '#000'; tc.fillRect(0, 0, W, H); }
      const tc = trail.getContext('2d');
      tc.fillStyle = 'rgba(0,0,0,0.2)'; tc.fillRect(0, 0, W, H);
      dots(trail.data(), b, { gloss: false, alpha: () => 0.55 });
      ctx.drawImage(background(P.theme, { accent: P.coreRgb }), 0, 0);
      ctx.save(); ctx.globalCompositeOperation = 'lighter'; ctx.drawImage(trail, 0, 0); ctx.restore();
      text(ctx, P.title, W / 2, 285, { size: 82, stroke: 12, maxW: 1000, color: '#fff' });
      pill(ctx, P.sub, W / 2, 378, { size: 31 });
      const frac = clamp(1 - S.damage / S.hp, 0, 1);
      bar(ctx, 140, 440, 800, 26, frac, rgbStr(P.coreRgb));
      text(ctx, `WALL HP ${Math.ceil(frac * 100)}%`, W / 2, 495, { size: 30, family: 'Chakra', color: 'rgba(255,255,255,0.85)' });
      // arena
      ctx.beginPath(); ctx.arc(CX, CY, R, 0, Math.PI * 2);
      ctx.lineWidth = 10; ctx.strokeStyle = rgbStr(P.ringRgb); ctx.shadowColor = rgbStr(P.ringRgb); ctx.shadowBlur = 26; ctx.stroke(); ctx.shadowBlur = 0;
      // pads
      for (const p of pads) {
        const s = 1 + 0.18 * p.pulse;
        ctx.beginPath(); ctx.arc(p.x, p.y, PAD * s, 0, Math.PI * 2);
        ctx.fillStyle = rgbStr(p.rgb, 0.22 + 0.3 * p.pulse); ctx.fill();
        ctx.lineWidth = 5; ctx.strokeStyle = rgbStr(p.rgb); ctx.shadowColor = rgbStr(p.rgb); ctx.shadowBlur = 18; ctx.stroke(); ctx.shadowBlur = 0;
        text(ctx, `${p.op === 'mul' ? '×' : '+'}${p.v}`, p.x, p.y + 2, { size: 34 * s, family: 'Chakra', color: '#fff', maxW: PAD * 1.8 * s });
      }
      // core
      if (S.brokeAt === null) {
        const sx = fx.range(-1, 1) * 6 * S.shake, sy = fx.range(-1, 1) * 6 * S.shake;
        const g = ctx.createRadialGradient(CX + sx - 30, CY + sy - 35, 10, CX + sx, CY + sy, CORE);
        g.addColorStop(0, rgbStr(mix(P.coreRgb, [255, 255, 255], 0.5))); g.addColorStop(1, rgbStr(mix(P.coreRgb, [0, 0, 0], 0.35)));
        ctx.beginPath(); ctx.arc(CX + sx, CY + sy, CORE, 0, Math.PI * 2); ctx.fillStyle = g; ctx.fill();
        ctx.lineWidth = 6; ctx.strokeStyle = '#fff'; ctx.stroke();
        const shown = Math.floor((1 - frac) * P.cracks.length);
        ctx.strokeStyle = 'rgba(10,10,20,0.85)'; ctx.lineWidth = 4; ctx.lineCap = 'round';
        for (let k = 0; k < shown; k++) {
          ctx.beginPath();
          P.cracks[k].forEach(([x, y], j) => (j ? ctx.lineTo(CX + sx + x, CY + sy + y) : ctx.moveTo(CX + sx + x, CY + sy + y)));
          ctx.stroke();
        }
        text(ctx, fmt(Math.max(0, Math.ceil(S.hp - S.damage))), CX + sx, CY + sy + 4, { size: 44, family: 'Chakra', color: '#fff', stroke: 8, maxW: CORE * 1.8 });
      }
      const px = canvas.data();
      dots(px, b, { glow: b.n < 400 ? 0.4 : 0 });
      dots(px, parts.p, { gloss: false, alpha: i => Math.min(1, parts.p.aux[i] / 0.3) });
      text(ctx, fmt(Math.round(S.shownBalls)), W / 2, 1500, { size: 92, family: 'Chakra', color: '#fff', stroke: 10, glow: 22, glowColor: rgbStr(P.ballRgb) });
      const secs = S.brokeAt ?? t;
      text(ctx, `BALLS  ·  ${Math.floor(secs / 60)}:${(secs % 60).toFixed(1).padStart(4, '0')}`, W / 2, 1572, { size: 30, color: 'rgba(255,255,255,0.8)' });
      if (S.brokeAt !== null) banner(ctx, P.endTitle, `IN ${Math.floor(S.brokeAt / 60)}:${(S.brokeAt % 60).toFixed(1).padStart(4, '0')}`, rgbStr(P.coreRgb), (t - S.brokeAt - 0.5) / 0.35);
    },
  };
  function breakWall(t) {
    if (S.brokeAt !== null) return;
    S.brokeAt = t; S.finished = true;
    if (!headless) {
      parts.burst(fx, CX, CY, 260, P.coreRgb, 1100, 7, 1.8);
      parts.burst(fx, CX, CY, 120, [255, 255, 255], 700, 4, 1.2);
      sfx.shatter(t, 0.7); sfx.crash(t, 0.9); sfx.boom(t, 0.8);
      sfx.win(t + 0.25, P.root + 12, 0.45);
    }
  }
  if (!headless) sfx.pad(0, 70, P.root - 12, 0.05);
  return S;
}

function makeCracks(r) {
  return Array.from({ length: 14 }, () => {
    let a = r.range(0, Math.PI * 2), d = r.range(0, 25);
    const pts = [[Math.cos(a) * d, Math.sin(a) * d]];
    while (d < CORE - 8) { d += r.range(14, 26); a += r.range(-0.5, 0.5); pts.push([Math.cos(a) * Math.min(d, CORE - 6), Math.sin(a) * Math.min(d, CORE - 6)]); }
    return pts;
  });
}

export function plan(seed) {
  const r = mkRng(seed);
  const nPads = r.int(4, 6), cols = r.shuffle(NEON.filter(c => c.name !== 'WHITE'));
  const start = r.range(0, Math.PI * 2);
  const pads = Array.from({ length: nPads }, (_, i) => {
    const a = start + (i / nPads) * Math.PI * 2 + r.range(-0.2, 0.2), d = r.range(230, 300);
    const op = r.chance(0.75) ? 'mul' : 'add';
    return { x: CX + Math.cos(a) * d, y: CY + Math.sin(a) * d, op, v0: op === 'mul' ? r.int(2, 3) : r.int(2, 5), rgb: cols[i % cols.length].rgb };
  });
  const base = { seed, pads, padCd: r.range(0.6, 0.8), small: r.pick([5, 6, 7]), theme: r.pick(THEMES), timbre: r.pick(['kalimba', 'glass', 'bell']), root: r.int(55, 62),
    scale: r.pick(['majorPenta', 'lydian', 'minorPenta']), palette: r.chance(0.5) ? 'rainbow' : 'mono', ballRgb: cols[nPads].rgb,
    coreRgb: cols[nPads + 1].rgb, ringRgb: r.pick([[241, 245, 249], cols[nPads + 2].rgb]), cracks: makeCracks(r) };
  // run with an unbreakable wall and read off how much damage is done by the target time
  const S = makeScene({ ...base, hp: Infinity }, { headless: true });
  simulate(S, 60);
  const target = r.range(39, 47);
  const at = S.dmgLog.find(([t]) => t >= target) || S.dmgLog[S.dmgLog.length - 1];
  const P = { ...base, hp: Math.max(100, Number(at[1].toPrecision(2))) };
  P.title = r.pick(['BREAK THE WALL?', 'CAN 1 BALL BREAK IT?', 'HOW LONG UNTIL IT BREAKS?']);
  P.sub = r.pick(['GUESS THE TIME BEFORE THE END', 'EVERY PAD GOES +1', 'COMMENT YOUR GUESS']);
  P.endTitle = r.pick(['WALL BROKEN!', 'IT BROKE!', 'DESTROYED!']);
  P.caption = r.pick([
    `1 ball. ${nPads} multipliers that fire more balls and go +1 every hit. How long until the wall falls? Guess before the end 👇`,
    `Can 1 ball break a ${fmt(P.hp)} HP wall? Every multiplier it touches makes more balls 🤯 Guess the time 👇`,
    `The wall has ${fmt(P.hp)} HP. Every pad multiplies the balls. When does it break? 👇`,
  ]) + ' ' + r.shuffle(['#physics', '#simulation', '#satisfying', '#oddlysatisfying', '#neon', '#relaxing']).slice(0, 5).join(' ');
  P.meta = { hp: P.hp, target: +target.toFixed(1), damageAt60: Math.round(S.damage) };
  return P;
}

export const scene = P => makeScene(P);
export const id = 'wall';
