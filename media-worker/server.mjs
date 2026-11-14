// ferma-media-worker: checks finished pictures for FERMA (format, size, hashes, signs of a bad render).
// The cards themselves are drawn by Gudini's own templates. Runs as its own small container on FERMA's internal
// Docker network; no port is published to the computer. One job at a time; the queue lives in FERMA's database.
import http from 'node:http';
import os from 'node:os';
import { statfs, readFile } from 'node:fs/promises';
import sharp from 'sharp';
import { probeImage } from './probe.mjs';

const PORT = Number(process.env.PORT || 8700);
const TOKEN_FILE = process.env.MEDIA_TOKEN_FILE || '/internal/media.token';
// One job at a time is enough for 5-10 accounts; a few may wait, the rest are told to come back later.
const MAX_CONCURRENT = Math.max(1, Number(process.env.MEDIA_CONCURRENCY || 1));
const MAX_WAITING = Math.max(0, Number(process.env.MEDIA_QUEUE || 4));
const MIN_FREE_MB = Number(process.env.MEDIA_MIN_FREE_MB || 150);
const MIN_DISK_MB = Number(process.env.MEDIA_MIN_DISK_MB || 500);
const JOB_TIMEOUT_MS = Number(process.env.MEDIA_JOB_TIMEOUT_MS || 120_000);
const MAX_BODY = 24 * 1024 * 1024;
const startedAt = Date.now();

// libvips: one thread per operation and a small cache keep the memory flat between jobs.
sharp.concurrency(Number(process.env.SHARP_THREADS || 1));
sharp.cache({ memory: 48, files: 0, items: 40 });

const log = (...args) => console.log(`[media ${new Date().toISOString().slice(11, 19)}]`, ...args);
let token = '';
async function readToken() {
  try { token = (await readFile(TOKEN_FILE, 'utf8')).trim(); } catch { token = ''; }
  return token;
}

/** Memory the container may still use: cgroup limit minus usage, or the machine's free memory. */
async function freeMemoryMb() {
  try {
    const [max, current] = await Promise.all([readFile('/sys/fs/cgroup/memory.max', 'utf8'), readFile('/sys/fs/cgroup/memory.current', 'utf8')]);
    if (max.trim() !== 'max') return Math.round((Number(max) - Number(current)) / 1048576);
  } catch { /* not cgroup v2 */ }
  return Math.round(os.freemem() / 1048576);
}
async function freeDiskMb() {
  try { const stats = await statfs('/tmp'); return Math.round((stats.bavail * stats.bsize) / 1048576); } catch { return null; }
}

let running = 0;
const waiting = [];
const counters = { done: 0, failed: 0, refused: 0, cpuMs: 0 };
function acquire() {
  if (running < MAX_CONCURRENT) { running++; return Promise.resolve(); }
  return new Promise(resolve => waiting.push(resolve));
}
function release() {
  const next = waiting.shift();
  if (next) next(); else running--;
}

async function admission() {
  if (running >= MAX_CONCURRENT && waiting.length >= MAX_WAITING) return 'очередь воркера заполнена';
  const memory = await freeMemoryMb();
  if (memory < MIN_FREE_MB) return `мало памяти (${memory} МБ свободно)`;
  const disk = await freeDiskMb();
  if (disk !== null && disk < MIN_DISK_MB) return `мало места на диске (${disk} МБ свободно)`;
  return null;
}

function readBody(request) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    request.on('data', chunk => {
      size += chunk.length;
      if (size > MAX_BODY) { reject(Object.assign(new Error('слишком большой запрос'), { status: 413 })); request.destroy(); return; }
      chunks.push(chunk);
    });
    request.on('end', () => resolve(Buffer.concat(chunks)));
    request.on('error', reject);
  });
}
const send = (response, status, data) => {
  const body = JSON.stringify(data);
  response.writeHead(status, { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body), 'Cache-Control': 'no-store' });
  response.end(body);
};
function withTimeout(promise, ms) {
  let timer;
  return Promise.race([promise, new Promise((_, reject) => { timer = setTimeout(() => reject(Object.assign(new Error('задание не уложилось во время'), { status: 504 })), ms); })]).finally(() => clearTimeout(timer));
}

async function health() {
  const usage = process.resourceUsage();
  return {
    ok: true, version: 1, uptimeS: Math.round((Date.now() - startedAt) / 1000), running, waiting: waiting.length,
    limits: { concurrency: MAX_CONCURRENT, queue: MAX_WAITING, minFreeMb: MIN_FREE_MB, minDiskMb: MIN_DISK_MB, timeoutMs: JOB_TIMEOUT_MS },
    freeMemoryMb: await freeMemoryMb(), freeDiskMb: await freeDiskMb(), rssMb: Math.round(process.memoryUsage().rss / 1048576),
    cpuSeconds: Math.round((usage.userCPUTime + usage.systemCPUTime) / 1e6), ...counters,
  };
}

const server = http.createServer(async (request, response) => {
  try {
    const url = new URL(request.url || '/', 'http://media');
    if (request.method === 'GET' && url.pathname === '/health') return send(response, 200, await health());
    if (!token) await readToken();
    if (!token || request.headers.authorization !== `Bearer ${token}`) return send(response, 401, { error: 'нет доступа' });
    if (request.method !== 'POST' || url.pathname !== '/probe') return send(response, 404, { error: 'нет такого действия' });
    const refused = await admission();
    if (refused) { counters.refused++; return send(response, 503, { error: refused, retryAfterS: 30 }); }
    const body = await readBody(request);
    let job;
    try { job = JSON.parse(body.toString('utf8')); } catch { return send(response, 400, { error: 'задание не в формате JSON' }); }
    await acquire();
    const began = process.cpuUsage();
    const startedJob = Date.now();
    try {
      const result = await withTimeout(probeImage(job), JOB_TIMEOUT_MS);
      const cpu = process.cpuUsage(began);
      counters.done++; counters.cpuMs += Math.round((cpu.user + cpu.system) / 1000);
      log(`${url.pathname} ${job.jobId || ''}: ${Date.now() - startedJob} мс, CPU ${Math.round((cpu.user + cpu.system) / 1000)} мс, RSS ${Math.round(process.memoryUsage().rss / 1048576)} МБ`);
      send(response, 200, { ...result, elapsedMs: Date.now() - startedJob, cpuMs: Math.round((cpu.user + cpu.system) / 1000) });
    } catch (error) {
      counters.failed++;
      log(`${url.pathname} ${job.jobId || ''}: ошибка ${error.message}`);
      send(response, error.status || 422, { error: error.message, code: error.code || 'RENDER_FAILED' });
    } finally { release(); }
  } catch (error) {
    if (!response.headersSent) send(response, error.status || 500, { error: error.message || 'внутренняя ошибка' });
  }
});
server.requestTimeout = JOB_TIMEOUT_MS + 30_000;
server.listen(PORT, '0.0.0.0', () => log(`слушаю :${PORT}, параллельно ${MAX_CONCURRENT}, ожидание ${MAX_WAITING}`));
for (const signal of ['SIGTERM', 'SIGINT']) process.on(signal, () => { server.close(); setTimeout(() => process.exit(0), 5000).unref(); });
