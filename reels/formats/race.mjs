// "Who breaks floor 10 first?" — lanes of balls smash through floors with HP.
// Each lane has a rule applied when a floor breaks (×100, ×5, +1,000 ...).
// The director tunes the floor HP so the finish is close and the leader changes.
import { rng as mkRng, fmt, nice, clamp, NEON, THEMES, rgbStr, mix, lerp } from '../engine/core.mjs';
import { Balls, Particles } from '../engine/phys.mjs';
import { Sfx, scaleNote } from '../engine/audio.mjs';
import { W, background, text, pill, banner, dots, roundRect } from '../engine/draw.mjs';
import { simulate } from '../engine/run.mjs';

const G = 2600, FT = 24;

const TEMPLATES = [
  [{ start: 1, op: 'mul', k: 100 }, { start: 1000, op: 'add', k: 1000 }],
  [{ start: 1, op: 'mul', k: 10 }, { start: 1000, op: 'add', k: 1000 }],
  [{ start: 1, op: 'mul', k: 10 }, { start: 2000, op: 'add', k: 0 }],
  [{ start: 1, op: 'mul', k: 3 }, { start: 100, op: 'add', k: 50 }],
  [{ start: 10, op: 'mul', k: 5 }, { start: 5000, op: 'add', k: 500 }],
  [{ start: 1, op: 'mul', k: 100 }, { start: 10, op: 'mul', k: 5 }, { start: 1000, op: 'add', k: 1000 }],
  [{ start: 1, op: 'mul', k: 10 }, { start: 100, op: 'mul', k: 2 }, { start: 1000, op: 'add', k: 100 }],
  [{ start: 1, op: 'mul', k: 20 }, { start: 50, op: 'mul', k: 3 }, { start: 2000, op: 'add', k: 2000 }],
];

const ruleText = l => (l.op === 'mul' ? `×${fmt(l.k)} PER FLOOR` : l.k ? `+${fmt(l.k)} PER FLOOR` : 'NEVER CHANGES');
const ballsText = n => `${fmt(n)} BALL${n === 1 ? '' : 'S'}`;
const applyRule = (l, n) => (l.op === 'mul' ? n * l.k : n + l.k);

function layout(L, F) {
  const margin = 34, gap = 20, laneW = (W - 2 * margin - gap * (L - 1)) / L;
  const yTop = 660, yBot = 1590, secH = (yBot - yTop - 44) / F;
  return { margin, gap, laneW, yTop, yBot, secH, yf: f => yTop + (f + 1) * secH, laneX: i => margin + i * (laneW + gap) };
}

function makeScene(P, { headless = false, runAll = false } = {}) {
  const r = mkRng(P.seed ^ 0x5eed);
  const fx = mkRng(P.seed ^ 0xf00d); // visuals + sound only, never physics
  const L = P.lanes.length, F = P.floors, lay = layout(L, F), CAP = L === 2 ? 700 : 460;
  const sfx = new Sfx({ timbre: P.timbre, maxPerSec: 30, seed: P.seed });
  const parts = new Particles(3000);
  const radiusFor = vis => clamp(Math.sqrt((lay.laneW * lay.secH * 0.2) / (Math.PI * vis)), 3, 17);
  const lanes = P.lanes.map((d, i) => {
    const x0 = lay.laneX(i), x1 = x0 + lay.laneW, vis = Math.min(d.start, CAP);
    const lane = { ...d, i, x0, x1, count: d.start, shown: d.start, vis, weight: d.start / vis, floor: 0, hp: P.hp[0], hpMax: P.hp[0],
      finishedAt: null, flash: 0, rgb: d.rgb, balls: new Balls(CAP + 8) };
    const rad = radiusFor(vis);
    for (let k = 0; k < vis; k++) {
      const c = mix(d.rgb, k % 2 ? [255, 255, 255] : [0, 0, 0], r.range(0, 0.22));
      lane.balls.add(r.range(x0 + rad, x1 - rad), r.range(lay.yTop + rad, lay.yf(0) - FT), r.range(-260, 260), r.range(-200, 200), rad, c);
    }
    return lane;
  });
  const S = {
    sfx, substeps: 4, finished: false, hold: 2.8, lanes, winner: null, order: [], leaderLog: [], nextLog: 0,
    caption: P.caption,
    update(dt, t) {
      for (const lane of lanes) {
        const b = lane.balls, fy = lane.floor < F ? lay.yf(lane.floor) - FT / 2 : lay.yBot;
        const top = lay.yTop;
        for (let i = 0; i < b.n; i++) {
          const rad = b.r[i];
          b.vy[i] += G * dt; b.x[i] += b.vx[i] * dt; b.y[i] += b.vy[i] * dt;
          if (b.x[i] < lane.x0 + rad) { b.x[i] = lane.x0 + rad; b.vx[i] = Math.abs(b.vx[i]); }
          else if (b.x[i] > lane.x1 - rad) { b.x[i] = lane.x1 - rad; b.vx[i] = -Math.abs(b.vx[i]); }
          if (b.y[i] < top + rad) { b.y[i] = top + rad; b.vy[i] = Math.abs(b.vy[i]); }
          if (b.y[i] > fy - rad && b.vy[i] > 0) {
            b.y[i] = fy - rad;
            // bounce up the whole open lane; the strongest ones hit the ceiling and come back
            const room = Math.max(10, fy - top - 2 * rad);
            b.vy[i] = -Math.sqrt(2 * G * room * r.range(0.5, 1.2));
            b.vx[i] += r.range(-60, 60);
            if (Math.abs(b.vx[i]) > 420) b.vx[i] *= 0.9;
            if (lane.floor < F) {
              lane.hp -= lane.weight;
              lane.flash = 1;
              if (!headless && fx.next() < 0.35) sfx.bounce(t, scaleNote(P.root + 12 + lane.i * 5, P.scale, fx.int(0, 7)), 0.22, (lane.i / Math.max(1, L - 1)) * 1.2 - 0.6);
            }
          }
        }
        lane.flash = Math.max(0, lane.flash - dt * 6);
        lane.shown = lerp(lane.shown, lane.count, Math.min(1, dt * 10));
        if (lane.floor < F && lane.hp <= 0) breakFloor(lane, t);
      }
      if (!headless) parts.step(dt);
      if (t >= S.nextLog) {
        S.nextLog += 0.25;
        let best = null, bp = -1;
        for (const l of lanes) { const p = l.floor + (l.floor < F ? 1 - Math.max(0, l.hp) / l.hpMax : 0); if (p > bp) { bp = p; best = l.i; } }
        S.leaderLog.push(best);
      }
      if (runAll) S.finished = lanes.every(l => l.finishedAt !== null) || t > 75;
    },
    forceEnd() { S.finished = true; },
    draw(ctx, canvas, t) { draw(ctx, canvas, t, S, P, lay, parts); },
  };

  function breakFloor(lane, t) {
    const y = lay.yf(lane.floor);
    if (!headless) {
      parts.shatter(fx, lane.x0, y - FT / 2, lane.x1, y + FT / 2, 26, mix(lane.rgb, [255, 255, 255], 0.3), 5);
      sfx.shatter(t, 0.55);
      sfx.boom(t, 0.3);
      sfx.note(t, scaleNote(P.root + 12, P.scale, lane.floor + 2 + lane.i), 0.4, 0, 'chimes');
    }
    lane.floor++;
    lane.count = applyRule(lane, lane.count);
    const vis = Math.min(lane.count, CAP), b = lane.balls, rad = radiusFor(vis);
    lane.vis = vis; lane.weight = lane.count / vis;
    for (let i = 0; i < b.n; i++) b.r[i] = rad;
    while (b.n < vis) {
      const c = mix(lane.rgb, b.n % 2 ? [255, 255, 255] : [0, 0, 0], r.range(0, 0.22));
      b.add(r.range(lane.x0 + rad, lane.x1 - rad), y + r.range(-10, 10), r.range(-240, 240), r.range(-250, 50), rad, c);
    }
    if (lane.floor >= F) {
      lane.finishedAt = t;
      S.order.push(lane.i);
      if (!S.winner) {
        S.winner = lane;
        if (!headless) { sfx.win(t + 0.05, P.root + 24, 0.5); sfx.crash(t, 0.3); }
        if (!runAll) S.finished = true;
      }
    } else {
      lane.hp = P.hp[lane.floor]; lane.hpMax = lane.hp;
    }
  }
  if (!headless) sfx.pad(0, 70, P.root - 12, 0.05);
  return S;
}

function draw(ctx, canvas, t, S, P, lay, parts) {
  const F = P.floors;
  ctx.drawImage(background(P.theme, { accent: P.lanes[0].rgb }), 0, 0);
  text(ctx, P.title, W / 2, 285, { size: 74, stroke: 12, maxW: 1000 });
  pill(ctx, P.sub, W / 2, 380, { size: 32, bg: '#fff', fg: '#0b0b14' });
  const secs = S.winner ? S.winner.finishedAt : t;
  text(ctx, `${Math.floor(secs / 60)}:${(secs % 60).toFixed(1).padStart(4, '0')}`, W / 2, 452, { size: 40, family: 'Chakra', color: 'rgba(255,255,255,0.85)' });

  for (const lane of S.lanes) {
    const c = rgbStr(lane.rgb), cx = (lane.x0 + lane.x1) / 2;
    // header card
    roundRect(ctx, lane.x0, 492, lay.laneW, 150, 22);
    ctx.fillStyle = rgbStr(lane.rgb, 0.12); ctx.fill();
    ctx.lineWidth = 3; ctx.strokeStyle = rgbStr(lane.rgb, 0.75); ctx.stroke();
    text(ctx, fmt(Math.round(lane.shown)), cx, 545, { size: 66, family: 'Chakra', color: c, glow: 18, maxW: lay.laneW - 24 });
    text(ctx, ruleText(lane), cx, 600, { size: 27, maxW: lay.laneW - 24 });
    // lane body
    roundRect(ctx, lane.x0, lay.yTop, lay.laneW, lay.yBot - lay.yTop, 14);
    ctx.fillStyle = rgbStr(lane.rgb, 0.05); ctx.fill();
    ctx.lineWidth = 2; ctx.strokeStyle = rgbStr(lane.rgb, 0.35); ctx.stroke();
    // floors
    for (let f = lane.floor; f < F; f++) {
      const y = lay.yf(f), cur = f === lane.floor;
      const sh = cur ? (Math.sin(t * 90) * 3 * lane.flash) : 0;
      roundRect(ctx, lane.x0 + 6 + sh, y - FT / 2, lay.laneW - 12, FT, 6);
      ctx.fillStyle = cur ? rgbStr(mix(lane.rgb, [255, 255, 255], 0.15 + 0.3 * lane.flash), 0.95) : 'rgba(255,255,255,0.13)';
      ctx.fill();
      if (cur) {
        const frac = clamp(lane.hp / lane.hpMax, 0, 1);
        ctx.fillStyle = 'rgba(0,0,0,0.35)';
        ctx.fillRect(lane.x0 + 6 + (lay.laneW - 12) * frac + sh, y - FT / 2, (lay.laneW - 12) * (1 - frac), FT);
      }
      text(ctx, fmt(Math.max(0, Math.ceil(cur ? lane.hp : P.hp[f]))), cx + sh, y + 1, { size: 21, family: 'Chakra', color: cur ? '#0b0b14' : 'rgba(255,255,255,0.75)', maxW: lay.laneW - 30 });
    }
    // floor counter + finish strip
    text(ctx, `FLOOR ${Math.min(lane.floor + 1, F)}/${F}`, cx, lay.yBot + 34, { size: 26, color: rgbStr(lane.rgb), maxW: lay.laneW });
    const fy = lay.yBot - 12;
    for (let k = 0; k * 12 < lay.laneW - 12; k++) { ctx.fillStyle = k % 2 ? '#fff' : '#111'; ctx.fillRect(lane.x0 + 6 + k * 12, fy, 12, 6); ctx.fillStyle = k % 2 ? '#111' : '#fff'; ctx.fillRect(lane.x0 + 6 + k * 12, fy + 6, 12, 6); }
  }
  const px = canvas.data();
  for (const lane of S.lanes) dots(px, lane.balls, { glow: lane.vis < 200 ? 0.45 : 0 });
  dots(px, parts.p, { gloss: false, alpha: i => Math.min(1, parts.p.aux[i] / 0.4) });
  for (const lane of S.lanes) {
    if (lane.finishedAt !== null) {
      const place = S.order.indexOf(lane.i);
      text(ctx, place === 0 ? '1ST' : `${place + 1}${place === 1 ? 'ND' : 'RD'}`, (lane.x0 + lane.x1) / 2, lay.yTop + 60, { size: 64, color: place === 0 ? '#facc15' : '#fff', stroke: 10, glow: place === 0 ? 30 : 0 });
    }
  }
  if (S.winner) {
    const k = (t - S.winner.finishedAt) / 0.35;
    if (k > 0.6) banner(ctx, `${S.winner.name} WINS!`, `${ballsText(S.winner.start)} ${ruleText(S.winner)}`, rgbStr(S.winner.rgb), (k - 0.6));
  }
}

function hpSchedule(H0, g, F) { return Array.from({ length: F }, (_, f) => nice(H0 * g ** f)); }

/** Picks rules, colours and floor HP so the race is close and ends at ~40-50 s. */
export function plan(seed) {
  for (let k = 0; k < 4; k++) {
    const P = planOnce(seed, k, k < 3);
    if (P) return P;
  }
  throw new Error('race: no playable parameters');
}

function planOnce(seed, attempt, strict) {
  const r = mkRng(seed + attempt * 7919);
  const tpl = r.pick(TEMPLATES), colors = r.shuffle(NEON.filter(c => c.name !== 'WHITE')).slice(0, tpl.length);
  const lanes = tpl.map((l, i) => ({ ...l, name: colors[i].name, rgb: colors[i].rgb }));
  const F = r.pick([10, 10, 10, 8, 12]);
  const base = { seed, lanes, floors: F, theme: r.pick(THEMES), timbre: r.pick(['kalimba', 'marimba', 'glass']),
    root: r.int(50, 57), scale: r.pick(['majorPenta', 'minorPenta']) };
  const target = r.range(40, 47);
  const run = P => { const S = makeScene(P, { headless: true, runAll: true }); simulate(S, 80); return S; };
  // X = the "exponential underdog" lane (biggest multiplier); it should come from behind.
  const X = lanes.reduce((a, l, i) => (l.op === 'mul' && (a < 0 || l.k > lanes[a].k) ? i : a), -1);
  // Stage 1: pick the floor growth g where X is behind at half-time and the race lasts ~target.
  const cands = [];
  for (let g = 1.25; g <= 9; g *= 1.12) {
    let H0 = 50, S = null, P = null;
    for (let it = 0; it < 4; it++) {
      P = { ...base, hp: hpSchedule(H0, g, F) };
      S = run(P);
      const first = Math.min(...S.lanes.map(l => l.finishedAt ?? 999));
      if (first > 900) { H0 *= 0.3; continue; }
      H0 *= clamp((target - 1) / Math.max(1, first - 1), 0.2, 5);
    }
    const times = S.lanes.map(l => l.finishedAt ?? 999);
    const sorted = [...times].sort((a, b) => a - b);
    if (sorted[0] < 28 || sorted[0] > 58 || sorted[1] > 900) continue;
    const half = S.leaderLog[Math.floor(S.leaderLog.length * 0.5)];
    const behind = X >= 0 && half !== X;
    cands.push({ P, times, score: (behind ? 0 : 2) + Math.abs(Math.log(clamp(sorted[1] - sorted[0], 0.05, 40) / 0.8)) * 0.5 });
  }
  if (!cands.length) return null;
  cands.sort((a, b) => a.score - b.score);
  // Stage 2: tune the LAST floor's HP so X wins (or just misses) by a fraction of a second.
  const xWins = r.chance(0.65), wantMargin = r.range(0.12, 0.7);
  let best = null;
  for (const c of cands.slice(0, 4)) {
    const Y = c.times.map((t, i) => [t, i]).filter(([, i]) => i !== X).sort((a, b) => a[0] - b[0])[0]?.[1];
    if (X < 0 || Y === undefined) { best = { P: c.P }; break; }
    const sAt = h => {
      const P = { ...c.P, hp: [...c.P.hp.slice(0, F - 1), h] };
      const S = run(P);
      return { P, S, s: (S.lanes[X].finishedAt ?? 999) - (S.lanes[Y].finishedAt ?? 999) };
    };
    const want = xWins ? -wantMargin : wantMargin;
    let lo = Math.log(c.P.hp[F - 2] * 0.9), hi = Math.log(c.P.hp[F - 1] * 60);
    let a = sAt(Math.exp(lo)), b = sAt(Math.exp(hi));
    if ((a.s - want) * (b.s - want) > 0) continue;
    let mid = null;
    for (let k = 0; k < 14; k++) {
      const m = (lo + hi) / 2;
      mid = sAt(Number(Math.exp(m).toPrecision(2)));
      if ((mid.s - want) * (a.s - want) > 0) { lo = m; a = mid; } else hi = m;
      if (Math.abs(mid.s - want) < 0.08) break;
    }
    const tFirst = Math.min(...mid.S.lanes.map(l => l.finishedAt ?? 999));
    if (tFirst < 26 || tFirst > 57) continue;
    best = { P: mid.P, margin: Math.abs(mid.s), xWon: mid.s < 0, times: mid.S.lanes.map(l => +(l.finishedAt ?? 0).toFixed(2)) };
    break;
  }
  if (!best && strict) return null;
  if (!best) best = { P: cands[0].P, times: cands[0].times };
  const P = best.P;
  const anyMul = P.lanes.some(l => l.op === 'mul');
  P.title = r.pick([`WHO BREAKS FLOOR ${F} FIRST?`, 'WHO REACHES THE BOTTOM FIRST?', `WHICH LANE BREAKS ALL ${F} FLOORS?`]);
  P.sub = r.pick(['PICK A SIDE BEFORE IT ENDS', 'PICK YOUR COLOR NOW', 'CHOOSE BEFORE YOU WATCH']);
  const vs = P.lanes.map(l => `${ballsText(l.start)} ${l.op === 'mul' ? `×${fmt(l.k)}` : l.k ? `+${fmt(l.k)}` : ''}`.trim()).join(' vs ');
  P.caption = r.pick([
    `${vs}. Who breaks floor ${F} first? Pick a side 👇`,
    `${vs} — same ${F} floors, different rules. Which one wins? 👇`,
    `${anyMul ? 'Never underestimate exponential growth… ' : ''}${vs}. Pick before you watch 👇`,
  ]) + ' ' + r.shuffle(['#physics', '#simulation', '#satisfying', '#oddlysatisfying', '#math', '#relaxing']).slice(0, 5).join(' ');
  P.meta = { margin: best.margin ? +best.margin.toFixed(2) : null, underdogWon: best.xWon ?? null, finish: best.times };
  return P;
}

export const scene = P => makeScene(P);
export const id = 'race';
