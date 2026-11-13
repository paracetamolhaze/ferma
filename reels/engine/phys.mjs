// Tiny 2D physics for balls: struct-of-arrays storage plus collision helpers.
// Formats write their own step loop and call these helpers.

export class Balls {
  constructor(cap) {
    this.cap = cap;
    this.n = 0;
    this.x = new Float64Array(cap); this.y = new Float64Array(cap);
    this.vx = new Float64Array(cap); this.vy = new Float64Array(cap);
    this.r = new Float32Array(cap);
    this.col = new Uint8Array(cap * 3);
    this.tag = new Int32Array(cap);   // team / lane / zone, format-defined
    this.aux = new Float32Array(cap); // free slot (age, cooldown...), format-defined
  }

  add(x, y, vx, vy, r, rgb, tag = 0, aux = 0) {
    if (this.n >= this.cap) return -1;
    const i = this.n++;
    this.x[i] = x; this.y[i] = y; this.vx[i] = vx; this.vy[i] = vy; this.r[i] = r;
    this.col[i * 3] = rgb[0]; this.col[i * 3 + 1] = rgb[1]; this.col[i * 3 + 2] = rgb[2];
    this.tag[i] = tag; this.aux[i] = aux;
    return i;
  }

  /** Swap-remove: the last ball moves into slot i. Iterate backwards when removing. */
  remove(i) {
    const j = --this.n;
    if (i === j) return;
    this.x[i] = this.x[j]; this.y[i] = this.y[j]; this.vx[i] = this.vx[j]; this.vy[i] = this.vy[j];
    this.r[i] = this.r[j]; this.tag[i] = this.tag[j]; this.aux[i] = this.aux[j];
    this.col[i * 3] = this.col[j * 3]; this.col[i * 3 + 1] = this.col[j * 3 + 1]; this.col[i * 3 + 2] = this.col[j * 3 + 2];
  }
}

/** Keeps ball i inside a circle. Returns the outward normal angle if it bounced, else null. */
export function insideCircle(b, i, cx, cy, R, e = 1) {
  const dx = b.x[i] - cx, dy = b.y[i] - cy, d = Math.hypot(dx, dy), lim = R - b.r[i];
  if (d <= lim || d === 0) return null;
  const nx = dx / d, ny = dy / d;
  b.x[i] = cx + nx * lim; b.y[i] = cy + ny * lim;
  const vn = b.vx[i] * nx + b.vy[i] * ny;
  if (vn > 0) { b.vx[i] -= (1 + e) * vn * nx; b.vy[i] -= (1 + e) * vn * ny; }
  return Math.atan2(ny, nx);
}

/** Keeps ball i outside a static circle (bumper, core). Returns true on contact. */
export function outsideCircle(b, i, cx, cy, R, e = 1) {
  const dx = b.x[i] - cx, dy = b.y[i] - cy, d = Math.hypot(dx, dy), lim = R + b.r[i];
  if (d >= lim) return false;
  const nx = d ? dx / d : 0, ny = d ? dy / d : -1;
  b.x[i] = cx + nx * lim; b.y[i] = cy + ny * lim;
  const vn = b.vx[i] * nx + b.vy[i] * ny;
  if (vn < 0) { b.vx[i] -= (1 + e) * vn * nx; b.vy[i] -= (1 + e) * vn * ny; }
  return true;
}

/** Axis-aligned walls of a box the ball must stay inside. Returns bitmask of touched sides (1 L, 2 R, 4 T, 8 B). */
export function insideBox(b, i, x0, y0, x1, y1, e = 1) {
  const r = b.r[i];
  let hit = 0;
  if (b.x[i] < x0 + r) { b.x[i] = x0 + r; if (b.vx[i] < 0) b.vx[i] = -b.vx[i] * e; hit |= 1; }
  if (b.x[i] > x1 - r) { b.x[i] = x1 - r; if (b.vx[i] > 0) b.vx[i] = -b.vx[i] * e; hit |= 2; }
  if (b.y[i] < y0 + r) { b.y[i] = y0 + r; if (b.vy[i] < 0) b.vy[i] = -b.vy[i] * e; hit |= 4; }
  if (b.y[i] > y1 - r) { b.y[i] = y1 - r; if (b.vy[i] > 0) b.vy[i] = -b.vy[i] * e; hit |= 8; }
  return hit;
}

/** Ball-ball collisions with a uniform grid (equal masses). */
export function collideBalls(b, cell, e = 0.98, bounds = [0, 0, 1080, 1920]) {
  const n = b.n;
  if (n < 2) return;
  const [bx0, by0, bx1, by1] = bounds;
  const gw = Math.max(1, Math.ceil((bx1 - bx0) / cell)), gh = Math.max(1, Math.ceil((by1 - by0) / cell));
  const size = gw * gh;
  if (!collideBalls.heads || collideBalls.heads.length < size) collideBalls.heads = new Int32Array(size);
  if (!collideBalls.next || collideBalls.next.length < b.cap) collideBalls.next = new Int32Array(b.cap);
  const heads = collideBalls.heads, next = collideBalls.next;
  heads.fill(-1, 0, size);
  const cx = new Int32Array(n), cy = new Int32Array(n);
  for (let i = 0; i < n; i++) {
    let gx = Math.floor((b.x[i] - bx0) / cell), gy = Math.floor((b.y[i] - by0) / cell);
    gx = gx < 0 ? 0 : gx >= gw ? gw - 1 : gx; gy = gy < 0 ? 0 : gy >= gh ? gh - 1 : gy;
    cx[i] = gx; cy[i] = gy;
    const k = gy * gw + gx; next[i] = heads[k]; heads[k] = i;
  }
  const X = b.x, Y = b.y, VX = b.vx, VY = b.vy, Rr = b.r;
  for (let i = 0; i < n; i++) {
    const gx = cx[i], gy = cy[i];
    for (let oy = -1; oy <= 1; oy++) {
      const yy = gy + oy;
      if (yy < 0 || yy >= gh) continue;
      for (let ox = -1; ox <= 1; ox++) {
        const xx = gx + ox;
        if (xx < 0 || xx >= gw) continue;
        let j = heads[yy * gw + xx];
        while (j !== -1) {
          if (j > i) {
            const dx = X[j] - X[i], dy = Y[j] - Y[i], rr = Rr[i] + Rr[j], d2 = dx * dx + dy * dy;
            if (d2 < rr * rr && d2 > 1e-9) {
              const d = Math.sqrt(d2), nx = dx / d, ny = dy / d, o = (rr - d) * 0.5;
              X[i] -= nx * o; Y[i] -= ny * o; X[j] += nx * o; Y[j] += ny * o;
              const rv = (VX[j] - VX[i]) * nx + (VY[j] - VY[i]) * ny;
              if (rv < 0) {
                const imp = rv * (1 + e) * 0.5;
                VX[i] += imp * nx; VY[i] += imp * ny; VX[j] -= imp * nx; VY[j] -= imp * ny;
              }
            }
          }
          j = next[j];
        }
      }
    }
  }
}

/** Angle difference wrapped to [-PI, PI]. */
export function angDiff(a, b) {
  let d = (a - b) % (2 * Math.PI);
  if (d > Math.PI) d -= 2 * Math.PI;
  if (d < -Math.PI) d += 2 * Math.PI;
  return d;
}

/** Simple particle system for debris and sparks. */
export class Particles {
  constructor(cap = 4000) { this.p = new Balls(cap); this.life = new Float32Array(cap); }
  burst(rng, x, y, count, rgb, speed = 600, r = 4, life = 1.2) {
    for (let k = 0; k < count; k++) {
      const a = rng.range(0, Math.PI * 2), s = speed * (0.3 + 0.7 * rng.next());
      const i = this.p.add(x, y, Math.cos(a) * s, Math.sin(a) * s, r * (0.5 + rng.next()), rgb);
      if (i >= 0) { this.life[i] = life * (0.6 + 0.4 * rng.next()); this.p.aux[i] = this.life[i]; }
    }
  }
  /** Debris from a rectangle (floor shatter). */
  shatter(rng, x0, y0, x1, y1, count, rgb, r = 5) {
    for (let k = 0; k < count; k++) {
      const i = this.p.add(rng.range(x0, x1), rng.range(y0, y1), rng.range(-350, 350), rng.range(-500, 100), r * (0.5 + rng.next()), rgb);
      if (i >= 0) { this.life[i] = 1.4 * (0.6 + 0.4 * rng.next()); this.p.aux[i] = this.life[i]; }
    }
  }
  step(dt, g = 1800) {
    const p = this.p;
    for (let i = p.n - 1; i >= 0; i--) {
      p.aux[i] -= dt;
      if (p.aux[i] <= 0) { p.remove(i); this.life[i] = this.life[p.n]; continue; }
      p.vy[i] += g * dt; p.x[i] += p.vx[i] * dt; p.y[i] += p.vy[i] * dt;
    }
  }
}
