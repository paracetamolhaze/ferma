// "Last one inside wins" — big coloured balls bounce in a ring with a rotating gap; whoever falls out is eliminated.
import { rng as mkRng, clamp, THEMES, NEON, rgbStr, mix } from '../engine/core.mjs';
import { Balls, Particles, collideBalls, angDiff } from '../engine/phys.mjs';
import { Sfx, scaleNote } from '../engine/audio.mjs';
import { W, background, text, pill, banner, bigBall, roundRect, dots } from '../engine/draw.mjs';
import { simulate } from '../engine/run.mjs';

const CX = 540, CY = 960, R = 405, TH = 14, GRAV = 900;

function makeScene(P, { headless = false } = {}) {
  const r = mkRng(P.layoutSeed);
  const fx = mkRng(P.seed ^ 0xf00d); // visuals + sound only, never physics
  const sfx = new Sfx({ timbre: P.timbre, maxPerSec: 14, seed: P.seed });
  const b = new Balls(P.players.length), parts = new Particles(2000);
  const fallen = [];
  // after a winner is decided the gap closes so the winner can't fall out
  const gapAt = t => { const g = P.gap + P.gapGrow * t; return S.winner ? g * Math.max(0, 1 - (t - S.winAt) / 0.5) : g; };
  P.players.forEach((p, i) => {
    let x, y, ok = false;
    for (let k = 0; k < 200 && !ok; k++) {
      const a = r.range(0, Math.PI * 2), d = r.range(0, R - P.radius - 30);
      x = CX + Math.cos(a) * d; y = CY + Math.sin(a) * d;
      ok = true;
      for (let j = 0; j < b.n; j++) if (Math.hypot(b.x[j] - x, b.y[j] - y) < 2 * P.radius + 6) ok = false;
    }
    const a = r.range(0, Math.PI * 2), s = r.range(500, 800);
    b.add(x, y, Math.cos(a) * s, Math.sin(a) * s, P.radius, p.rgb, i);
  });
  const S = {
    sfx, substeps: 6, finished: false, hold: 3.0, out: [], winner: null, winAt: null,
    update(dt, t) {
      const half = gapAt(t), ph = P.phase + P.w * t;
      for (let i = 0; i < b.n; i++) { b.vy[i] += GRAV * dt; b.x[i] += b.vx[i] * dt; b.y[i] += b.vy[i] * dt; }
      collideBalls(b, P.radius * 2 + 2, 1.0, [CX - 520, CY - 520, CX + 520, CY + 520]);
      for (let i = b.n - 1; i >= 0; i--) {
        const dx = b.x[i] - CX, dy = b.y[i] - CY, d = Math.hypot(dx, dy) || 1e-6, rad = b.r[i];
        const nx = dx / d, ny = dy / d, a = Math.atan2(dy, dx);
        const inGap = !S.winner && Math.abs(angDiff(a, ph)) < half - Math.asin(Math.min(1, rad / R));
        if (b.aux[i] === 0 && d + rad > R - TH / 2) {
          if (inGap) { if (d - rad > R + TH / 2) b.aux[i] = 1; }
          else if (d < R) {
            b.x[i] = CX + nx * (R - TH / 2 - rad); b.y[i] = CY + ny * (R - TH / 2 - rad);
            const vn = b.vx[i] * nx + b.vy[i] * ny;
            if (vn > 0) {
              b.vx[i] -= 2 * vn * nx; b.vy[i] -= 2 * vn * ny;
              if (!headless && vn > 250) sfx.bounce(t, scaleNote(P.root, P.scale, b.tag[i] % 8), 0.3, nx * 0.6);
            }
          } else b.aux[i] = 1;
        }
        const sp = Math.hypot(b.vx[i], b.vy[i]);
        if (b.aux[i] === 0 && sp < 480) { b.vx[i] *= 480 / sp; b.vy[i] *= 480 / sp; }
        if (sp > 1500) { b.vx[i] *= 1500 / sp; b.vy[i] *= 1500 / sp; }
        if (b.aux[i] === 1) {
          // eliminated
          const id = b.tag[i];
          S.out.push({ id, t });
          fallen.push({ id, x: b.x[i], y: b.y[i], vx: b.vx[i], vy: b.vy[i] });
          if (!headless) {
            parts.burst(fx, b.x[i], b.y[i], 24, P.players[id].rgb, 500, 5, 1);
            sfx.pop(t, 0.5, 380, nx * 0.6);
            sfx.note(t + 0.04, P.root + 12 - S.out.length, 0.3, 0, 'xylo', 1.2);
          }
          b.remove(i);
        }
      }
      for (const f of fallen) { f.vy += GRAV * dt; f.x += f.vx * dt; f.y += f.vy * dt; }
      if (!headless) parts.step(dt);
      if (!S.winner && b.n === 1) {
        S.winner = P.players[b.tag[0]]; S.winAt = t; S.finished = true;
        if (!headless) { sfx.win(t + 0.1, P.root + 12, 0.5); sfx.crash(t, 0.2); }
      }
    },
    forceEnd(t) {
      if (S.winner) return;
      // the ball closest to the centre survives
      let best = 0, bd = 1e9;
      for (let i = 0; i < b.n; i++) { const d = Math.hypot(b.x[i] - CX, b.y[i] - CY); if (d < bd) { bd = d; best = i; } }
      S.winner = P.players[b.tag[best]]; S.winAt = t; S.finished = true;
    },
    draw(ctx, canvas, t) {
      ctx.drawImage(background(P.theme, { accent: [255, 255, 255] }), 0, 0);
      text(ctx, P.title, W / 2, 290, { size: 80, stroke: 12, maxW: 1000 });
      pill(ctx, P.sub, W / 2, 385, { size: 32 });
      const half = gapAt(t), ph = P.phase + P.w * t;
      ctx.save();
      ctx.beginPath(); ctx.arc(CX, CY, R, ph + half, ph - half + Math.PI * 2);
      ctx.lineWidth = TH; ctx.lineCap = 'round'; ctx.strokeStyle = rgbStr(P.ringRgb);
      ctx.shadowColor = rgbStr(P.ringRgb); ctx.shadowBlur = 30; ctx.stroke();
      ctx.restore();
      dots(canvas.data(), parts.p, { gloss: false, alpha: i => Math.min(1, parts.p.aux[i] / 0.4) });
      for (const f of fallen) if (f.y < 2100) bigBall(ctx, f.x, f.y, P.radius, mix(P.players[f.id].rgb, [40, 40, 40], 0.5), { face: P.style === 'face', label: P.style === 'number' ? String(f.id + 1) : null });
      for (let i = 0; i < b.n; i++) {
        const p = P.players[b.tag[i]];
        bigBall(ctx, b.x[i], b.y[i], b.r[i], p.rgb, { face: P.style === 'face', label: P.style === 'number' ? String(b.tag[i] + 1) : null, ring: S.winner === p ? '#fff' : null });
      }
      // roster
      const n = P.players.length, perRow = Math.ceil(n / 2), cw = 1000 / perRow;
      P.players.forEach((p, i) => {
        const row = i < perRow ? 0 : 1, col = row ? i - perRow : i;
        const x = 40 + cw * col + cw / 2, y = 1470 + row * 62;
        const o = S.out.find(e => e.id === i), place = o ? n - S.out.indexOf(o) : null;
        ctx.save();
        ctx.globalAlpha = o ? 0.35 : 1;
        roundRect(ctx, x - cw / 2 + 6, y - 24, cw - 12, 48, 24);
        ctx.fillStyle = rgbStr(p.rgb, 0.18); ctx.fill();
        ctx.beginPath(); ctx.arc(x - cw / 2 + 32, y, 14, 0, Math.PI * 2); ctx.fillStyle = rgbStr(p.rgb); ctx.fill();
        text(ctx, P.style === 'number' ? `${i + 1}` : p.name, x + 12, y + 2, { size: 24, maxW: cw - 64 });
        if (o) { ctx.strokeStyle = '#fff'; ctx.lineWidth = 3; ctx.beginPath(); ctx.moveTo(x - cw / 2 + 14, y); ctx.lineTo(x + cw / 2 - 14, y); ctx.stroke(); }
        ctx.restore();
        if (place) text(ctx, `#${place}`, x + cw / 2 - 30, y - 26, { size: 20, color: '#fff' });
      });
      text(ctx, `ALIVE ${b.n}/${n}`, W / 2, 1405, { size: 34, family: 'Chakra', color: 'rgba(255,255,255,0.85)' });
      if (S.winner) {
        const label = P.style === 'number' ? `#${P.players.indexOf(S.winner) + 1} WINS!` : `${S.winner.name} WINS!`;
        banner(ctx, label, P.endSub, rgbStr(S.winner.rgb), (t - S.winAt - 0.4) / 0.35);
      }
    },
  };
  if (!headless) sfx.pad(0, 70, P.root - 12, 0.06);
  return S;
}

export function plan(seed) {
  const r = mkRng(seed);
  const n = r.int(6, 10), style = r.pick(['face', 'face', 'number']);
  const players = r.shuffle(NEON.filter(c => c.name !== 'WHITE')).slice(0, n).map(c => ({ name: c.name, rgb: c.rgb }));
  const base = { seed, players, style, radius: n <= 7 ? 50 : 43, theme: r.pick(THEMES), timbre: r.pick(['marimba', 'kalimba', 'glass']),
    root: r.int(55, 62), scale: r.pick(['majorPenta', 'minorPenta']), ringRgb: r.pick([[241, 245, 249], [250, 204, 21], [34, 211, 238]]),
    w: (r.chance(0.5) ? 1 : -1) * r.range(0.45, 0.85), phase: r.range(0, Math.PI * 2) };
  const target = r.range(36, 48);
  let best = null;
  for (let k = 0; k < 40; k++) {
    const P = { ...base, layoutSeed: r.int(1, 2 ** 30), gap: r.range(0.1, 0.26), gapGrow: r.range(0.003, 0.012) };
    const S = makeScene(P, { headless: true });
    simulate(S, 62);
    if (!S.winner) continue;
    const outs = S.out.map(o => o.t), duel = outs.length >= 2 ? outs[outs.length - 1] - outs[outs.length - 2] : 0;
    const firstOut = outs[0] ?? 99;
    const tHalf = outs[Math.floor(outs.length / 2)] ?? 0;
    const score = Math.abs(S.winAt - target) * 0.3 + (duel < 4 ? 4 - duel : 0) + (duel > 12 ? (duel - 12) * 0.5 : 0) + (firstOut < 3 ? 2 : 0)
      + (firstOut > 10 ? (firstOut - 10) * 0.4 : 0) + Math.max(0, 0.45 * S.winAt - tHalf) * 0.3;
    if (!best || score < best.score) best = { score, P, winAt: S.winAt, duel };
    if (score < 0.5) break;
  }
  if (!best) throw new Error('royale: no playable parameters');
  const P = best.P;
  P.title = r.pick(['LAST ONE INSIDE WINS', 'LAST BALL STANDING WINS', 'WHO STAYS INSIDE?']);
  P.sub = r.pick(['PICK YOUR COLOR', 'PICK ONE BEFORE IT STARTS', 'CHOOSE YOUR FIGHTER']);
  if (style === 'number') P.sub = r.pick(['PICK A NUMBER', 'CHOOSE YOUR NUMBER']);
  P.endSub = r.pick(['DID YOU PICK RIGHT?', 'LAST ONE INSIDE', 'COMMENT YOUR PICK']);
  P.caption = r.pick([
    `${n} ${style === 'face' ? 'mochi' : 'balls'}, 1 rotating exit. Last one inside wins 🏆 Who did you pick? 👇`,
    `Last one standing wins! ${style === 'number' ? 'Pick a number' : 'Pick a color'} before it starts 👇`,
    `Battle royale but it's ${style === 'face' ? 'cute mochi' : 'bouncing balls'} 😳 Who wins? 👇`,
  ]) + ' ' + r.shuffle(['#satisfying', '#bouncingball', '#battleroyale', '#physics', '#simulation', '#oddlysatisfying']).slice(0, 5).join(' ');
  P.meta = { winAt: +best.winAt.toFixed(2), duel: +best.duel.toFixed(2) };
  return P;
}

export const scene = P => makeScene(P);
export const id = 'royale';
