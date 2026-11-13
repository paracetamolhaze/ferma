// "1 PINK vs 1,000 BLUE" territory war: each ball lives in its own colour and flips enemy cells it touches.
// Majority at the end of the clock wins. The director balances the teams so the result is razor close.
import { createCanvas } from '@napi-rs/canvas';
import { rng as mkRng, fmt, clamp, THEMES, NEON, rgbStr, mix } from '../engine/core.mjs';
import { Balls } from '../engine/phys.mjs';
import { Sfx, scaleNote } from '../engine/audio.mjs';
import { W, background, text, rich, pill, banner, dots, roundRect } from '../engine/draw.mjs';
import { simulate } from '../engine/run.mjs';

const CELL = 24, COLS = 42, ROWS = 45, GX = (W - COLS * CELL) / 2, GY = 500;

function makeScene(P, { headless = false } = {}) {
  const r = mkRng(P.seed ^ 0x7e7);
  const fx = mkRng(P.seed ^ 0xf00d); // visuals + sound only, never physics
  const sfx = new Sfx({ timbre: P.timbre, maxPerSec: 24, seed: P.seed });
  const cells = new Uint8Array(COLS * ROWS);
  for (let y = 0; y < ROWS; y++) for (let x = 0; x < COLS; x++) cells[y * COLS + x] = (P.split === 'v' ? x >= COLS / 2 : y >= ROWS / 2) ? 1 : 0;
  const counts = [0, 0];
  for (const c of cells) counts[c]++;
  const b = new Balls(P.armyN + 1100);
  const teamRgb = [P.a.rgb, P.b.rgb], ballRgb = teamRgb.map(c => mix(c, [255, 255, 255], 0.45)), cellRgb = teamRgb.map(c => mix(c, [0, 0, 0], 0.5));
  const speed = [P.speedA, P.speedB];
  const spawn = (team, x, y) => {
    const a = r.range(0, Math.PI * 2);
    return b.add(x, y, Math.cos(a) * speed[team], Math.sin(a) * speed[team], team === 0 ? P.radA : P.radB, ballRgb[team], team);
  };
  const randomCellOf = team => {
    for (let k = 0; k < 5000; k++) {
      const x = r.int(1, COLS - 2), y = r.int(1, ROWS - 2);
      if (cells[y * COLS + x] === team) return [GX + (x + 0.5) * CELL, GY + (y + 0.5) * CELL];
    }
    return [W / 2, GY + ROWS * CELL / 2];
  };
  for (let k = 0; k < P.startA; k++) spawn(0, ...randomCellOf(0));
  for (let k = 0; k < P.armyN; k++) spawn(1, ...randomCellOf(1));
  let grid = null;
  const dirty = [];
  const flip = (cx, cy, team, t) => {
    if (cx < 0 || cy < 0 || cx >= COLS || cy >= ROWS) return false;
    const k = cy * COLS + cx;
    if (cells[k] === team) return false;
    cells[k] = team; counts[team]++; counts[1 - team]--;
    if (!headless) {
      dirty.push(k);
      if (fx.next() < (team === 0 ? 0.5 : 0.08)) sfx.bounce(t, scaleNote(P.root + (team === 0 ? 12 : 0), P.scale, fx.int(0, 6)), team === 0 ? 0.25 : 0.14, (cx / COLS) * 1.2 - 0.6);
    }
    return true;
  };
  const S = {
    sfx, substeps: 4, finished: false, hold: 3.2, counts, endAt: null, nextSplit: P.splitEvery || Infinity, log: [], nextLog: 0, lastTick: -1,
    share: () => counts[0] / (COLS * ROWS),
    update(dt, t) {
      if (S.endAt !== null) return;
      if (t >= S.nextSplit && P.splitEvery) {
        S.nextSplit += P.splitEvery;
        const nA = b.tag.subarray(0, b.n).reduce((s, v) => s + (v === 0 ? 1 : 0), 0);
        if (nA < P.maxA) for (let i = b.n - 1; i >= 0; i--) if (b.tag[i] === 0) spawn(0, b.x[i], b.y[i]);
        if (!headless) sfx.note(t, P.root + 19, 0.3, 0, 'bell', 0.8);
      }
      for (let i = 0; i < b.n; i++) {
        const team = b.tag[i], rad = b.r[i];
        if (team === 0 && P.variant === 'one') { bulldoze(i, dt, t); continue; }
        // pong-wars rule: enemy cells are walls; a ball may flip at most one cell per cell it travels
        if (b.aux[i] > 0) b.aux[i] -= dt;
        const ready = b.aux[i] <= 0;
        b.x[i] += b.vx[i] * dt;
        let cx = Math.floor((b.x[i] + Math.sign(b.vx[i]) * rad - GX) / CELL), cy = Math.floor((b.y[i] - GY) / CELL);
        if (cx < 0 || cx >= COLS) { b.vx[i] = -b.vx[i]; b.x[i] = clamp(b.x[i], GX + rad, GX + COLS * CELL - rad); }
        else if (cy >= 0 && cy < ROWS && cells[cy * COLS + cx] !== team) {
          if (ready) { flip(cx, cy, team, t); b.aux[i] = cool(team); jitter(i); }
          b.vx[i] = -b.vx[i]; b.x[i] += b.vx[i] * dt;
        }
        b.y[i] += b.vy[i] * dt;
        cx = Math.floor((b.x[i] - GX) / CELL); cy = Math.floor((b.y[i] + Math.sign(b.vy[i]) * rad - GY) / CELL);
        if (cy < 0 || cy >= ROWS) { b.vy[i] = -b.vy[i]; b.y[i] = clamp(b.y[i], GY + rad, GY + ROWS * CELL - rad); }
        else if (cx >= 0 && cx < COLS && cells[cy * COLS + cx] !== team) {
          if (b.aux[i] <= 0) { flip(cx, cy, team, t); b.aux[i] = cool(team); jitter(i); }
          b.vy[i] = -b.vy[i]; b.y[i] += b.vy[i] * dt;
        }
        // painted over by the enemy while sitting there: take the cell back
        const mx = Math.floor((b.x[i] - GX) / CELL), my = Math.floor((b.y[i] - GY) / CELL);
        if (mx >= 0 && my >= 0 && mx < COLS && my < ROWS && cells[my * COLS + mx] !== team) flip(mx, my, team, t);
      }
      if (t >= S.nextLog) { S.log.push(S.share()); S.nextLog += 0.5; }
      const left = P.duration - t;
      if (!headless && left < 5.5 && Math.floor(left) !== S.lastTick && left > 0) { S.lastTick = Math.floor(left); sfx.tick(t, 0.5); }
      if (t >= P.duration) {
        S.endAt = t; S.finished = true;
        if (!headless) { const w = counts[0] > counts[1] ? 0 : 1; void w; sfx.win(t, P.root + 12, 0.5); sfx.gong(t, 0.35); }
      }
    },
    forceEnd(t) { if (S.endAt === null) { S.endAt = t; S.finished = true; } },
    draw(ctx, canvas, t) {
      if (!grid) {
        grid = createCanvas(COLS * CELL, ROWS * CELL);
        const g = grid.getContext('2d');
        g.fillStyle = '#05050a'; g.fillRect(0, 0, COLS * CELL, ROWS * CELL);
        for (let k = 0; k < cells.length; k++) paint(g, k);
      } else {
        const g = grid.getContext('2d');
        for (const k of dirty) paint(g, k);
      }
      dirty.length = 0;
      ctx.drawImage(background(P.theme), 0, 0);
      rich(ctx, [{ t: `${fmt(P.startA)} ${P.a.name}`, c: rgbStr(P.a.rgb) }, { t: ' vs ', c: '#fff' }, { t: `${fmt(P.armyN)} ${P.b.name}`, c: rgbStr(P.b.rgb) }], W / 2, 250, { size: 84, maxW: 1000, glow: 18 });
      pill(ctx, P.sub, W / 2, 335, { size: 30 });
      const sA = S.share();
      // score bar
      const bx = 60, bw = 960, by = 395, bh = 56;
      ctx.save(); roundRect(ctx, bx, by, bw, bh, 28); ctx.clip();
      ctx.fillStyle = rgbStr(P.a.rgb); ctx.fillRect(bx, by, bw * sA, bh);
      ctx.fillStyle = rgbStr(P.b.rgb); ctx.fillRect(bx + bw * sA, by, bw * (1 - sA), bh);
      ctx.restore();
      text(ctx, `${(sA * 100).toFixed(1)}%`, bx + 24, by + bh / 2 + 2, { size: 34, family: 'Chakra', align: 'left', color: '#fff', stroke: 6 });
      text(ctx, `${((1 - sA) * 100).toFixed(1)}%`, bx + bw - 24, by + bh / 2 + 2, { size: 34, family: 'Chakra', align: 'right', color: '#fff', stroke: 6 });
      ctx.drawImage(grid, GX, GY);
      const px = canvas.data();
      dots(px, b, { tagFilter: 1, gloss: P.radB >= 4 });
      dots(px, b, { tagFilter: 0, glow: 0.6 });
      const left = Math.max(0, P.duration - t);
      text(ctx, `0:${Math.ceil(left).toString().padStart(2, '0')}`, W / 2, GY + ROWS * CELL + 52, { size: 54, family: 'Chakra', color: left < 5.5 ? '#ff4d6d' : '#fff', stroke: 8 });
      if (S.endAt !== null) {
        const w = counts[0] > counts[1] ? P.a : P.b, ws = Math.max(sA, 1 - sA) * 100;
        banner(ctx, `${w.name} WINS!`, `${ws.toFixed(1)}% vs ${(100 - ws).toFixed(1)}%`, rgbStr(w.rgb), (t - S.endAt - 0.3) / 0.35);
      }
    },
  };
  // the lone ball paints every cell under it and only bounces off the walls
  function bulldoze(i, dt, t) {
    const rad = b.r[i];
    b.x[i] += b.vx[i] * dt; b.y[i] += b.vy[i] * dt;
    let hit = false;
    if (b.x[i] < GX + rad || b.x[i] > GX + COLS * CELL - rad) { b.vx[i] = -b.vx[i]; b.x[i] = clamp(b.x[i], GX + rad, GX + COLS * CELL - rad); hit = true; }
    if (b.y[i] < GY + rad || b.y[i] > GY + ROWS * CELL - rad) { b.vy[i] = -b.vy[i]; b.y[i] = clamp(b.y[i], GY + rad, GY + ROWS * CELL - rad); hit = true; }
    if (hit) { const a = Math.atan2(b.vy[i], b.vx[i]) + r.range(-0.35, 0.35); b.vx[i] = Math.cos(a) * speed[0]; b.vy[i] = Math.sin(a) * speed[0]; }
    // every so often steer toward the nearest of a few random enemy cells
    b.aux[i] -= dt;
    if (b.aux[i] <= 0) {
      b.aux[i] = P.steerEvery;
      let best = null, bd = Infinity;
      for (let k = 0; k < 24; k++) {
        const c = r.int(0, cells.length - 1);
        if (cells[c] === 0) continue;
        const ex = GX + ((c % COLS) + 0.5) * CELL, ey = GY + (Math.floor(c / COLS) + 0.5) * CELL, d = (ex - b.x[i]) ** 2 + (ey - b.y[i]) ** 2;
        if (d < bd) { bd = d; best = [ex, ey]; }
      }
      if (best) {
        const cur = Math.atan2(b.vy[i], b.vx[i]), want = Math.atan2(best[1] - b.y[i], best[0] - b.x[i]);
        let d = want - cur; while (d > Math.PI) d -= 2 * Math.PI; while (d < -Math.PI) d += 2 * Math.PI;
        const a = cur + d * P.steer;
        b.vx[i] = Math.cos(a) * speed[0]; b.vy[i] = Math.sin(a) * speed[0];
      }
    }
    const x0 = Math.floor((b.x[i] - rad - GX) / CELL), x1 = Math.floor((b.x[i] + rad - GX) / CELL);
    const y0 = Math.floor((b.y[i] - rad - GY) / CELL), y1 = Math.floor((b.y[i] + rad - GY) / CELL);
    for (let cy = y0; cy <= y1; cy++) for (let cx = x0; cx <= x1; cx++) {
      const dx = GX + (cx + 0.5) * CELL - b.x[i], dy = GY + (cy + 0.5) * CELL - b.y[i];
      if (dx * dx + dy * dy <= (rad + CELL * 0.35) ** 2) flip(cx, cy, 0, t);
    }
  }
  function cool(team) { return team === 1 && P.cdB ? P.cdB * r.range(0.7, 1.3) : CELL / speed[team]; }
  function walls(i) {
    const rad = b.r[i];
    if (b.x[i] < GX + rad || b.x[i] > GX + COLS * CELL - rad) { b.vx[i] = -b.vx[i]; b.x[i] = clamp(b.x[i], GX + rad, GX + COLS * CELL - rad); }
    if (b.y[i] < GY + rad || b.y[i] > GY + ROWS * CELL - rad) { b.vy[i] = -b.vy[i]; b.y[i] = clamp(b.y[i], GY + rad, GY + ROWS * CELL - rad); }
  }
  function jitter(i) {
    const a = Math.atan2(b.vy[i], b.vx[i]) + r.range(-0.06, 0.06), s = speed[b.tag[i]];
    b.vx[i] = Math.cos(a) * s; b.vy[i] = Math.sin(a) * s;
    if (Math.abs(b.vx[i]) < s * 0.15) b.vx[i] = Math.sign(b.vx[i] || 1) * s * 0.15;
    if (Math.abs(b.vy[i]) < s * 0.15) b.vy[i] = Math.sign(b.vy[i] || 1) * s * 0.15;
  }
  function paint(g, k) {
    const x = (k % COLS) * CELL, y = Math.floor(k / COLS) * CELL;
    g.fillStyle = '#05050a'; g.fillRect(x, y, CELL, CELL);
    g.fillStyle = rgbStr(cellRgb[cells[k]]); g.fillRect(x + 1, y + 1, CELL - 2, CELL - 2);
  }
  if (!headless) sfx.pad(0, 70, P.root - 12, 0.05);
  return S;
}

export function plan(seed) {
  const r = mkRng(seed);
  const pairs = [['PINK', 'CYAN'], ['RED', 'BLUE'], ['YELLOW', 'PURPLE'], ['LIME', 'PINK'], ['ORANGE', 'BLUE'], ['PINK', 'GREEN'], ['CYAN', 'ORANGE'], ['PURPLE', 'LIME']];
  const [ca, cb] = r.shuffle(r.pick(pairs)).map(n => NEON.find(c => c.name === n));
  // same rules for both sides; the underdog starts with 1 ball and doubles on a timer (the 'one' bulldozer variant was
  // removed: to balance it the army had to reload for ~25 s and looked frozen)
  const variant = 'split';
  const armyN = r.pick([100, 200, 300, 500]);
  const base = { seed, variant, a: { name: ca.name, rgb: ca.rgb }, b: { name: cb.name, rgb: cb.rgb }, armyN, startA: 1, maxA: 512,
    split: r.pick(['v', 'h']), duration: Math.round(r.range(40, 48)), theme: r.pick(THEMES), timbre: r.pick(['kalimba', 'marimba', 'glass']),
    root: r.int(55, 62), scale: r.pick(['majorPenta', 'minorPenta']), radA: variant === 'one' ? 30 : 8, radB: armyN >= 1000 ? 3 : 4,
    brush: false, speedB: r.range(220, 320), steer: r.range(0.35, 0.6), steerEvery: r.range(0.3, 0.5) };
  const underdogWins = r.chance(0.6), want = (underdogWins ? 1 : -1) * r.range(0.002, 0.012);
  // knob: underdog speed ("one") or split interval ("split"); more knob = stronger underdog
  // 'one': knob = how long each army ball reloads between captures; 'split': knob = how often the underdog doubles
  const knobLo = variant === 'one' ? 0.1 : 1.2, knobHi = variant === 'one' ? 30 : 9;
  const apply = k => (variant === 'one' ? { ...base, speedA: 1100, cdB: k } : { ...base, speedA: 380, splitEvery: knobHi + knobLo - k });
  const finalShare = k => { const P = apply(k); const S = makeScene(P, { headless: true }); simulate(S, P.duration + 1); return { P, S, d: S.share() - 0.5 }; };
  let lo = knobLo, hi = knobHi, best = null;
  for (let it = 0; it < 12; it++) {
    const k = Math.sqrt(lo * hi), res = finalShare(k);
    const err = Math.abs(res.d - want);
    const mid = res.S.log[Math.floor(res.S.log.length * 0.55)] - 0.5;
    const comeback = Math.sign(mid) !== Math.sign(res.d);
    const score = err + (comeback ? 0 : 0.004) + (Math.sign(res.d) === Math.sign(want) ? 0 : 0.02);
    if (!best || score < best.score) best = { ...res, score, comeback };
    if (res.d < want) lo = k; else hi = k;
  }
  const P = best.P;
  P.sub = `${P.a.name} DOUBLES EVERY ${P.splitEvery.toFixed(1)}s`;
  P.title = `${fmt(P.startA)} ${P.a.name} vs ${fmt(P.armyN)} ${P.b.name}`;
  P.caption = r.pick([
    `Can 1 ${P.a.name.toLowerCase()} ball beat ${fmt(P.armyN)} ${P.b.name.toLowerCase()}? Pick a side before it ends 👇🎧`,
    `${P.a.name} or ${P.b.name}? Whoever owns more of the map at 0:00 wins 👇`,
    `${P.a.name} starts with 1 ball and doubles every ${P.splitEvery.toFixed(1)} s. ${P.b.name} has ${fmt(P.armyN)}. Who wins? 👇`,
  ]) + ' ' + r.shuffle(['#satisfying', '#oddlysatisfying', '#simulation', '#physics', '#asmr', '#pongwars']).slice(0, 5).join(' ');
  P.meta = { variant, finalShareA: +(best.d + 0.5).toFixed(4), comeback: best.comeback, knob: variant === 'one' ? +P.cdB.toFixed(2) : +P.splitEvery.toFixed(2) };
  return P;
}

export const scene = P => makeScene(P);
export const id = 'territory';
