// Drawing helpers: fonts, backgrounds, text, bars, and a fast software rasteriser for many balls.
import { createCanvas, GlobalFonts } from '@napi-rs/canvas';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { rgbStr, mix } from './core.mjs';

export const W = 1080, H = 1920;
const here = path.dirname(fileURLToPath(import.meta.url));
let fontsReady = false;
export function fonts() {
  if (fontsReady) return;
  GlobalFonts.registerFromPath(path.join(here, '../fonts/ArchivoBlack-Regular.ttf'), 'Archivo');
  GlobalFonts.registerFromPath(path.join(here, '../fonts/ChakraPetch-Bold.ttf'), 'Chakra');
  fontsReady = true;
}

export function stage() {
  fonts();
  const canvas = createCanvas(W, H);
  return { canvas, ctx: canvas.getContext('2d') };
}

/** Cached full-screen background: vertical gradient, vignette, faint dot grid. */
const bgCache = new Map();
export function background(theme, { grid = true, accent = null } = {}) {
  const key = `${theme.name}:${grid}:${accent}`;
  if (bgCache.has(key)) return bgCache.get(key);
  const c = createCanvas(W, H), x = c.getContext('2d');
  const g = x.createLinearGradient(0, 0, 0, H);
  g.addColorStop(0, rgbStr(theme.top)); g.addColorStop(1, rgbStr(theme.bottom));
  x.fillStyle = g; x.fillRect(0, 0, W, H);
  if (accent) {
    const rg = x.createRadialGradient(W / 2, H * 0.48, 50, W / 2, H * 0.48, 900);
    rg.addColorStop(0, rgbStr(accent, 0.10)); rg.addColorStop(1, rgbStr(accent, 0));
    x.fillStyle = rg; x.fillRect(0, 0, W, H);
  }
  if (grid) {
    x.fillStyle = 'rgba(255,255,255,0.035)';
    for (let yy = 30; yy < H; yy += 60) for (let xx = 30; xx < W; xx += 60) x.fillRect(xx - 1, yy - 1, 2, 2);
  }
  const v = x.createRadialGradient(W / 2, H / 2, 500, W / 2, H / 2, 1250);
  v.addColorStop(0, 'rgba(0,0,0,0)'); v.addColorStop(1, 'rgba(0,0,0,0.55)');
  x.fillStyle = v; x.fillRect(0, 0, W, H);
  bgCache.set(key, c);
  return c;
}

export function roundRect(ctx, x, y, w, h, r) {
  r = Math.min(r, w / 2, h / 2);
  ctx.beginPath();
  ctx.moveTo(x + r, y); ctx.lineTo(x + w - r, y); ctx.arcTo(x + w, y, x + w, y + r, r);
  ctx.lineTo(x + w, y + h - r); ctx.arcTo(x + w, y + h, x + w - r, y + h, r);
  ctx.lineTo(x + r, y + h); ctx.arcTo(x, y + h, x, y + h - r, r);
  ctx.lineTo(x, y + r); ctx.arcTo(x, y, x + r, y, r);
  ctx.closePath();
}

function setFont(ctx, size, family) { ctx.font = `${Math.round(size)}px ${family}`; }

/** Single-colour text with auto-shrink, optional outline and glow. */
export function text(ctx, str, x, y, o = {}) {
  const { size = 60, family = 'Archivo', color = '#fff', align = 'center', baseline = 'middle', maxW = 1000,
    stroke = 0, strokeColor = 'rgba(0,0,0,0.75)', glow = 0, glowColor = color, alpha = 1 } = o;
  let s = size;
  setFont(ctx, s, family);
  while (ctx.measureText(str).width > maxW && s > 14) { s -= 2; setFont(ctx, s, family); }
  ctx.save();
  ctx.globalAlpha = alpha;
  ctx.textAlign = align; ctx.textBaseline = baseline;
  if (stroke) { ctx.lineJoin = 'round'; ctx.lineWidth = stroke; ctx.strokeStyle = strokeColor; ctx.strokeText(str, x, y); }
  if (glow) { ctx.shadowColor = glowColor; ctx.shadowBlur = glow; }
  ctx.fillStyle = color; ctx.fillText(str, x, y);
  ctx.restore();
  return s;
}

/** Multi-colour line centred at cx: parts = [{t:'1 BALL', c:'#f0f'}, {t:' VS ', c:'#fff'}]. */
export function rich(ctx, parts, cx, y, o = {}) {
  const { size = 70, family = 'Archivo', maxW = 1000, stroke = 10, strokeColor = 'rgba(0,0,0,0.8)', glow = 0 } = o;
  let s = size;
  const width = () => parts.reduce((w, p) => w + ctx.measureText(p.t).width, 0);
  setFont(ctx, s, family);
  while (width() > maxW && s > 14) { s -= 2; setFont(ctx, s, family); }
  let x = cx - width() / 2;
  ctx.save();
  ctx.textAlign = 'left'; ctx.textBaseline = 'middle'; ctx.lineJoin = 'round';
  for (const p of parts) {
    if (stroke) { ctx.lineWidth = stroke; ctx.strokeStyle = strokeColor; ctx.strokeText(p.t, x, y); }
    if (glow) { ctx.shadowColor = p.c; ctx.shadowBlur = glow; }
    ctx.fillStyle = p.c; ctx.fillText(p.t, x, y);
    ctx.shadowBlur = 0;
    x += ctx.measureText(p.t).width;
  }
  ctx.restore();
  return s;
}

export function pill(ctx, str, cx, cy, o = {}) {
  const { size = 34, family = 'Archivo', fg = '#0b0b14', bg = '#fff', padX = 26, h = size * 1.6, alpha = 1 } = o;
  setFont(ctx, size, family);
  const w = ctx.measureText(str).width + padX * 2;
  ctx.save();
  ctx.globalAlpha = alpha;
  roundRect(ctx, cx - w / 2, cy - h / 2, w, h, h / 2);
  ctx.fillStyle = bg; ctx.fill();
  ctx.fillStyle = fg; ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
  ctx.fillText(str, cx, cy + 2);
  ctx.restore();
  return w;
}

/** Big centred end-screen banner. */
export function banner(ctx, title, sub, color, k = 1) {
  const a = Math.min(1, k);
  ctx.save();
  ctx.globalAlpha = 0.55 * a;
  ctx.fillStyle = '#000'; ctx.fillRect(0, 0, W, H);
  ctx.restore();
  const s = 0.85 + 0.15 * Math.min(1, k * 1.6);
  ctx.save();
  ctx.translate(W / 2, H * 0.46); ctx.scale(s, s);
  text(ctx, title, 0, 0, { size: 128, color, stroke: 16, glow: 40, glowColor: color, maxW: 980, alpha: a });
  if (sub) text(ctx, sub, 0, 120, { size: 52, color: '#fff', stroke: 10, maxW: 960, alpha: a });
  ctx.restore();
}

export function bar(ctx, x, y, w, h, frac, cA, cB) {
  ctx.save();
  roundRect(ctx, x, y, w, h, h / 2); ctx.fillStyle = 'rgba(255,255,255,0.08)'; ctx.fill();
  ctx.clip();
  ctx.fillStyle = cA; ctx.fillRect(x, y, w * frac, h);
  if (cB) { ctx.fillStyle = cB; ctx.fillRect(x + w * frac, y, w * (1 - frac), h); }
  ctx.restore();
}

/**
 * Software rasteriser: draws balls straight into the RGBA pixel buffer (much faster than canvas
 * calls for thousands of balls). Background must be opaque.
 */
export function dots(px, b, o = {}) {
  const { from = 0, to = b.n, glow = 0, gloss = true, alpha = null, color = null, tagFilter = null, ox = 0, oy = 0 } = o;
  const X = b.x, Y = b.y, Rr = b.r, C = b.col;
  for (let i = from; i < to; i++) {
    if (tagFilter !== null && b.tag[i] !== tagFilter) continue;
    const cx = X[i] + ox, cy = Y[i] + oy, r = Rr[i];
    if (cx < -3 * r || cx > W + 3 * r || cy < -3 * r || cy > H + 3 * r) continue;
    const cr = color ? color[0] : C[i * 3], cg = color ? color[1] : C[i * 3 + 1], cb = color ? color[2] : C[i * 3 + 2];
    const al = alpha ? alpha(i) : 1;
    if (al <= 0) continue;
    if (glow > 0) {
      const gr = r * 2.4, x0 = Math.max(0, (cx - gr) | 0), x1 = Math.min(W - 1, (cx + gr + 1) | 0), y0 = Math.max(0, (cy - gr) | 0), y1 = Math.min(H - 1, (cy + gr + 1) | 0);
      for (let yy = y0; yy <= y1; yy++) {
        const dy = yy + 0.5 - cy;
        let o4 = (yy * W + x0) * 4;
        for (let xx = x0; xx <= x1; xx++, o4 += 4) {
          const dx = xx + 0.5 - cx, d = Math.sqrt(dx * dx + dy * dy);
          if (d >= gr) continue;
          let g = 1 - d / gr; g = g * g * glow * al;
          let v = px[o4] + cr * g; px[o4] = v > 255 ? 255 : v;
          v = px[o4 + 1] + cg * g; px[o4 + 1] = v > 255 ? 255 : v;
          v = px[o4 + 2] + cb * g; px[o4 + 2] = v > 255 ? 255 : v;
        }
      }
    }
    const x0 = Math.max(0, (cx - r - 1) | 0), x1 = Math.min(W - 1, (cx + r + 1) | 0), y0 = Math.max(0, (cy - r - 1) | 0), y1 = Math.min(H - 1, (cy + r + 1) | 0);
    const big = gloss && r >= 4, hx = cx - 0.35 * r, hy = cy - 0.4 * r, hr = 0.6 * r;
    for (let yy = y0; yy <= y1; yy++) {
      const dy = yy + 0.5 - cy;
      let o4 = (yy * W + x0) * 4;
      for (let xx = x0; xx <= x1; xx++, o4 += 4) {
        const dx = xx + 0.5 - cx, d = Math.sqrt(dx * dx + dy * dy), cov = r + 0.5 - d;
        if (cov <= 0) continue;
        const a = (cov >= 1 ? 1 : cov) * al;
        let R = cr, G = cg, B = cb;
        if (big) {
          const q = d / r, shade = 1 - 0.32 * q * q * q;
          const hd = Math.sqrt((xx + 0.5 - hx) ** 2 + (yy + 0.5 - hy) ** 2), h = hd < hr ? (1 - hd / hr) * 0.55 : 0;
          R = R * shade; G = G * shade; B = B * shade;
          R += (255 - R) * h; G += (255 - G) * h; B += (255 - B) * h;
        }
        px[o4] += (R - px[o4]) * a; px[o4 + 1] += (G - px[o4 + 1]) * a; px[o4 + 2] += (B - px[o4 + 2]) * a;
      }
    }
  }
}

/** Big ball drawn with canvas (for few large balls with faces/labels). */
export function bigBall(ctx, x, y, r, rgb, o = {}) {
  const { face = false, label = null, ring = null, labelColor = '#fff' } = o;
  ctx.save();
  const g = ctx.createRadialGradient(x - r * 0.35, y - r * 0.4, r * 0.1, x, y, r);
  g.addColorStop(0, rgbStr(mix(rgb, [255, 255, 255], 0.55)));
  g.addColorStop(0.55, rgbStr(rgb));
  g.addColorStop(1, rgbStr(mix(rgb, [0, 0, 0], 0.35)));
  ctx.beginPath(); ctx.arc(x, y, r, 0, Math.PI * 2); ctx.fillStyle = g; ctx.fill();
  if (ring) { ctx.lineWidth = Math.min(6, Math.max(2, r * 0.12)); ctx.strokeStyle = ring; ctx.stroke(); }
  if (face) {
    const e = r * 0.13, ex = r * 0.32, ey = -r * 0.08;
    ctx.fillStyle = '#1b1020';
    ctx.beginPath(); ctx.ellipse(x - ex, y + ey, e * 0.8, e, 0, 0, Math.PI * 2); ctx.fill();
    ctx.beginPath(); ctx.ellipse(x + ex, y + ey, e * 0.8, e, 0, 0, Math.PI * 2); ctx.fill();
    ctx.fillStyle = 'rgba(255,255,255,0.9)';
    ctx.beginPath(); ctx.arc(x - ex + e * 0.25, y + ey - e * 0.35, e * 0.3, 0, Math.PI * 2); ctx.fill();
    ctx.beginPath(); ctx.arc(x + ex + e * 0.25, y + ey - e * 0.35, e * 0.3, 0, Math.PI * 2); ctx.fill();
    ctx.strokeStyle = '#1b1020'; ctx.lineWidth = Math.max(1.5, r * 0.07); ctx.lineCap = 'round';
    ctx.beginPath(); ctx.arc(x, y + r * 0.12, r * 0.16, 0.15 * Math.PI, 0.85 * Math.PI); ctx.stroke();
    ctx.fillStyle = 'rgba(255,120,150,0.45)';
    ctx.beginPath(); ctx.ellipse(x - r * 0.55, y + r * 0.18, r * 0.14, r * 0.08, 0, 0, Math.PI * 2); ctx.fill();
    ctx.beginPath(); ctx.ellipse(x + r * 0.55, y + r * 0.18, r * 0.14, r * 0.08, 0, 0, Math.PI * 2); ctx.fill();
  }
  if (label) text(ctx, label, x, y + 2, { size: r * 0.95, color: labelColor, stroke: Math.max(3, r * 0.14), maxW: r * 1.7 });
  ctx.restore();
}
