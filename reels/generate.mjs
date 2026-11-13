// CLI: node generate.mjs <format|random> [seed] [--out DIR] [--stills 2,15,30]
// Writes <format>-<seed>.mp4 and .json (caption + parameters) into the output dir.
import fs from 'node:fs';
import path from 'node:path';
import { render, stills } from './engine/run.mjs';

const FORMATS = ['race', 'escape', 'royale', 'wall', 'territory', 'melody'];

const args = process.argv.slice(2);
const opt = (name, def) => { const i = args.indexOf(`--${name}`); return i >= 0 ? args[i + 1] : def; };
const pos = args.filter((a, i) => !a.startsWith('--') && !(i > 0 && args[i - 1].startsWith('--')));
let fmtName = pos[0] || 'random';
const seed = Number(pos[1] ?? Math.floor(Math.random() * 2 ** 31));
if (fmtName === 'random') fmtName = FORMATS[seed % FORMATS.length];
const outDir = opt('out', process.env.REELS_OUT || 'out');
fs.mkdirSync(outDir, { recursive: true });

const mod = await import(`./formats/${fmtName}.mjs`);
const t0 = Date.now();
const P = mod.plan(seed);
const planMs = Date.now() - t0;
const base = path.join(outDir, `${fmtName}-${seed}`);
const stillsArg = opt('stills', null);
const meta = { format: fmtName, seed, caption: P.caption, title: P.title, planMs, ...P.meta };
if (stillsArg) {
  const files = stills(mod.scene(P), base, stillsArg.split(',').map(Number));
  console.log(JSON.stringify({ ...meta, files }, null, 1));
} else {
  const res = await render(mod.scene(P), `${base}.mp4`);
  Object.assign(meta, { seconds: res.seconds, renderMs: res.ms, sizeMB: +(fs.statSync(res.file).size / 1e6).toFixed(1) });
  fs.writeFileSync(`${base}.json`, JSON.stringify(meta, (k, v) => (k === 'rgb' ? undefined : v), 1));
  console.log(JSON.stringify(meta));
}
