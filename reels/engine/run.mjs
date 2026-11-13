// Render loop: steps a scene, draws frames, pipes them to ffmpeg, then muxes the synthesised audio.
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { stage, W, H } from './draw.mjs';

const THREADS = String(process.env.REELS_THREADS || 3);
const FFMPEG = process.env.FFMPEG || 'ffmpeg';

// When OBS or Dota is running on the same Windows PC, drop to idle priority so they never lag.
let gentle = process.env.REELS_PRIORITY === 'idle';
if (!gentle && process.platform === 'win32') {
  try {
    const { execSync } = await import('node:child_process');
    const list = execSync('tasklist /FO CSV /NH', { encoding: 'utf8', windowsHide: true }).toLowerCase();
    gentle = /"(obs64|dota2)\.exe"/.test(list);
  } catch { /* ignore */ }
}
export function lowPriority(pid) {
  try {
    os.setPriority(pid, gentle ? os.constants.priority.PRIORITY_LOW : os.constants.priority.PRIORITY_BELOW_NORMAL);
  } catch { /* not fatal */ }
}
lowPriority(process.pid);

function run(args) {
  return new Promise((resolve, reject) => {
    const p = spawn(FFMPEG, args, { stdio: ['ignore', 'ignore', 'pipe'] });
    lowPriority(p.pid);
    let err = '';
    p.stderr.on('data', d => { err += d; });
    p.on('close', code => (code === 0 ? resolve() : reject(new Error(`ffmpeg ${code}: ${err.slice(-800)}`))));
  });
}

class Encoder {
  constructor(out, fps) {
    this.p = spawn(FFMPEG, ['-y', '-loglevel', 'error', '-f', 'rawvideo', '-pix_fmt', 'rgba', '-s', `${W}x${H}`, '-r', String(fps), '-i', '-',
      '-c:v', 'libx264', '-preset', 'fast', '-crf', '20', '-maxrate', '12M', '-bufsize', '24M', '-profile:v', 'high',
      '-pix_fmt', 'yuv420p', '-g', String(fps * 2), '-threads', THREADS, '-an', out], { stdio: ['pipe', 'ignore', 'pipe'] });
    lowPriority(this.p.pid);
    this.err = '';
    this.p.stderr.on('data', d => { this.err += d; });
    this.done = new Promise((resolve, reject) => this.p.on('close', c => (c === 0 ? resolve() : reject(new Error(`ffmpeg ${c}: ${this.err.slice(-800)}`)))));
    this.pool = [Buffer.alloc(W * H * 4), Buffer.alloc(W * H * 4), Buffer.alloc(W * H * 4)];
    this.busy = [false, false, false];
    this.k = 0;
  }
  async frame(view) {
    let i = this.k % 3;
    while (this.busy[i]) await new Promise(r => setTimeout(r, 1));
    this.k++;
    const buf = this.pool[i];
    buf.set(view);
    this.busy[i] = true;
    const ok = this.p.stdin.write(buf, () => { this.busy[i] = false; });
    if (!ok) await once(this.p.stdin, 'drain');
  }
  async close() { this.p.stdin.end(); await this.done; }
}

/** Runs a scene without drawing (for the "director" that picks dramatic parameters). */
export function simulate(scene, maxT = 60, fps = 60) {
  const sub = scene.substeps || 4, dt = 1 / (fps * sub);
  let t = 0;
  while (t < maxT && !scene.finished) {
    for (let s = 0; s < sub; s++) { scene.update(dt, t); t += dt; }
  }
  return t;
}

/** Full render to mp4 with audio. Returns { file, seconds, frames, ms }. */
export async function render(scene, out, { fps = 60, maxSeconds = 58, snapshots = [] } = {}) {
  lowPriority(process.pid);
  const t0 = Date.now();
  const { canvas, ctx } = stage();
  const tmpV = out.replace(/\.mp4$/, '.video.mp4'), tmpA = out.replace(/\.mp4$/, '.wav');
  const enc = new Encoder(tmpV, fps);
  const sub = scene.substeps || 4, dt = 1 / (fps * sub);
  let t = 0, frames = 0, endAt = null;
  const snaps = [...snapshots].sort((a, b) => a - b);
  for (;;) {
    for (let s = 0; s < sub; s++) { scene.update(dt, t); t += dt; }
    if (!scene.finished && t >= maxSeconds - (scene.hold || 2)) scene.forceEnd?.(t);
    if (endAt === null && scene.finished) endAt = t + (scene.hold ?? 2.2);
    scene.draw(ctx, canvas, t);
    await enc.frame(canvas.data());
    frames++;
    while (snaps.length && t >= (snaps[0] < 0 ? Infinity : snaps[0])) {
      const s = snaps.shift();
      fs.writeFileSync(out.replace(/\.mp4$/, `.t${s.toFixed(1)}.jpg`), canvas.toBuffer('image/jpeg', 85));
    }
    if (endAt !== null && t >= endAt) break;
  }
  if (snaps.length) fs.writeFileSync(out.replace(/\.mp4$/, '.end.jpg'), canvas.toBuffer('image/jpeg', 85));
  await enc.close();
  fs.writeFileSync(tmpA, scene.sfx.wav(t));
  await run(['-y', '-loglevel', 'error', '-i', tmpV, '-i', tmpA, '-c:v', 'copy', '-c:a', 'aac', '-b:a', '192k', '-shortest', '-movflags', '+faststart', out]);
  fs.rmSync(tmpV, { force: true }); fs.rmSync(tmpA, { force: true });
  return { file: out, seconds: +t.toFixed(2), frames, ms: Date.now() - t0 };
}

/** Draws single frames at given times to JPEG (quick look without encoding). */
export function stills(scene, outBase, times, fps = 60) {
  const { canvas, ctx } = stage();
  const sub = scene.substeps || 4, dt = 1 / (fps * sub);
  let t = 0;
  const want = [...times].sort((a, b) => a - b), files = [];
  let endAt = null;
  while (want.length) {
    for (let s = 0; s < sub; s++) { scene.update(dt, t); t += dt; }
    if (endAt === null && scene.finished) endAt = t + (scene.hold ?? 2.2);
    if (t >= want[0] || (endAt !== null && t >= endAt) || t > 70) {
      scene.draw(ctx, canvas, t);
      const f = `${outBase}.t${t.toFixed(1)}.jpg`;
      fs.writeFileSync(f, canvas.toBuffer('image/jpeg', 85));
      files.push(f);
      want.shift();
      if ((endAt !== null && t >= endAt) || t > 70) break;
    }
  }
  return files;
}

export { W, H, path };
