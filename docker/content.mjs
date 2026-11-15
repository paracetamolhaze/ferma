// Content engine (FERMA 2.0): moves materials from Gudini to published posts.
// Runs beside the app like the autopilot and talks to it through its own API; the decisions and every state
// live in the database, so this process can stop at any moment and continue after a restart.
//   watch    — long poll on Gudini: a new material starts its import within seconds (no webhook needed)
//   import   — the feed and the original files
//   sort     — the owner's topics: one GPT bridge call sorts up to 20 materials (keywords when the bridge is away)
//   plan     — campaigns give materials to accounts and order versions
//   write    — one GPT bridge call per material writes all its versions; the app checks every fact
//   review   — the AI editor rates every version and checks each claim against Gudini's research
//   draw     — redrawn carousels go to Gudini's own templates; every card is checked by ferma-media-worker
//   publish  — the queue goes step by step (containers, processing, publish), only when switched on
import http from 'node:http';
import os from 'node:os';
import { readFileSync, statfsSync } from 'node:fs';
import { listBackups } from './backup.mjs';

const WORKER = 'http://127.0.0.1:8787';
const TEXT_URL = process.env.BRIDGE_TEXT_URL || 'http://host.docker.internal:43127';
const BRIDGE_TOKEN = process.env.CODEX_BRIDGE_TOKEN || '';
const MODEL = process.env.CODEX_MODEL || 'gpt-6-astra';
// The bridge accepts only the model and effort it is configured with (the autopilot's settings).
const EFFORT = process.env.CODEX_REASONING_EFFORT || 'high';
const MEDIA_URL = process.env.MEDIA_WORKER_URL || 'http://media:8700';
const MEDIA_TOKEN_FILE = process.env.MEDIA_TOKEN_FILE || '/internal/media.token';
const ENABLED = (process.env.CONTENT_ENGINE || 'on') !== 'off';
const IDENTITY = { 'oai-authenticated-user-id': 'ferma_docker_owner', 'oai-authenticated-user-email': 'owner@ferma.local', 'oai-authenticated-user-full-name': 'FERMA', 'oai-authenticated-user-full-name-encoding': 'percent-encoded-utf-8' };
const log = (...args) => console.log(`[content ${new Date().toISOString().slice(11, 19)}]`, ...args);
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));

async function app(path, body, { headers = {}, timeoutMs = 120_000, raw = false } = {}) {
  const init = { headers: { ...IDENTITY, origin: WORKER, ...headers }, signal: AbortSignal.timeout(timeoutMs) };
  if (body !== undefined) Object.assign(init, { method: 'POST', body: body instanceof Uint8Array || typeof body === 'string' ? body : JSON.stringify(body) });
  if (body !== undefined && !(body instanceof Uint8Array)) init.headers['content-type'] = 'application/json';
  const response = await fetch(WORKER + path, init);
  if (raw) { if (!response.ok) throw new Error(`FERMA не ответила (${response.status})`); return response; }
  const data = await response.json().catch(() => null);
  if (!response.ok) throw Object.assign(new Error(data?.error || `FERMA не ответила (${response.status})`), { status: response.status });
  return data;
}
const content = (body, options) => app('/api/content', body, options);

function bridge(payload, timeoutMs) {
  return new Promise((resolve, reject) => {
    const body = JSON.stringify(payload);
    const request = http.request(new URL('/complete', TEXT_URL), { method: 'POST', agent: false, headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body), Authorization: `Bearer ${BRIDGE_TOKEN}` } }, response => {
      const chunks = [];
      response.on('data', chunk => chunks.push(chunk));
      response.on('end', () => {
        clearTimeout(timer);
        let data; try { data = JSON.parse(Buffer.concat(chunks).toString('utf8')); } catch { return reject(new Error(`мост ответил не JSON (${response.statusCode})`)); }
        if (response.statusCode < 200 || response.statusCode >= 300) return reject(new Error(`мост: ${data?.error || response.statusCode}`));
        resolve(data);
      });
    });
    const timer = setTimeout(() => request.destroy(new Error('мост не ответил вовремя')), timeoutMs);
    request.on('error', reject);
    request.end(body);
  });
}
/** The JSON object of a bridge answer (models sometimes wrap it in a code block). */
export function parseJson(text) {
  const cleaned = String(text || '').replace(/^```(?:json)?\s*|\s*```$/g, '').trim();
  return JSON.parse(cleaned.slice(cleaned.indexOf('{'), cleaned.lastIndexOf('}') + 1));
}
export function parseVariants(text) {
  const parsed = parseJson(text);
  if (!Array.isArray(parsed.variants)) throw new Error('в ответе моста нет списка variants');
  // content: the card texts of a Gudini redraw; the app checks them against Gudini's limits and the sources.
  return parsed.variants.filter(entry => entry && Number.isInteger(entry.slot)).map(entry => ({
    slot: entry.slot, headline: typeof entry.headline === 'string' ? entry.headline : null, text: typeof entry.text === 'string' ? entry.text : null, caption: typeof entry.caption === 'string' ? entry.caption : null,
    ...(entry.content && typeof entry.content === 'object' && !Array.isArray(entry.content) ? { content: entry.content } : {}),
  }));
}

let mediaToken = '';
function readMediaToken() { try { mediaToken = readFileSync(MEDIA_TOKEN_FILE, 'utf8').trim(); } catch { mediaToken = ''; } return mediaToken; }
async function media(path, body, timeoutMs = 150_000) {
  if (!mediaToken && !readMediaToken()) throw Object.assign(new Error('нет токена медиа-воркера'), { retryable: true });
  let response;
  try { response = await fetch(MEDIA_URL + path, { method: body ? 'POST' : 'GET', headers: { Authorization: `Bearer ${mediaToken}`, 'content-type': 'application/json' }, body: body ? JSON.stringify(body) : undefined, signal: AbortSignal.timeout(timeoutMs) }); }
  catch (error) { throw Object.assign(new Error(`медиа-воркер недоступен: ${error.message}`), { retryable: true }); }
  const data = await response.json().catch(() => null);
  if (!response.ok) throw Object.assign(new Error(data?.error || `медиа-воркер ${response.status}`), { retryable: response.status === 503 || response.status === 504 || response.status === 401, status: response.status });
  return data;
}

const readText = file => { try { return readFileSync(file, 'utf8').trim(); } catch { return null; } };
let lastCpu = null;
let wasDiskBusy = false;
/**
 * What is left: this container's CPU share (cgroup), and the Docker machine's load, free memory, disk space and
 * disk queue (the share of time tasks wait for the disk, /proc/pressure/io). The database writes to that disk: when
 * it is saturated every write stalls FERMA for seconds, so optional writers wait.
 * «busy»: optional work (drawing, picture hashes, statistics, diagnostics) waits; «disk_low»: no new files either.
 * Publishing, import of texts and the writer keep going in every mode.
 */
export function resources() {
  const [quota, period] = (readText('/sys/fs/cgroup/cpu.max') || 'max 100000').split(' ');
  const cpus = os.cpus().length;
  const cpuLimit = quota === 'max' ? cpus : Number(quota) / Number(period);
  const usage = Number(/usage_usec (\d+)/.exec(readText('/sys/fs/cgroup/cpu.stat') || '')?.[1] || 0);
  const at = Date.now();
  const ownCpu = lastCpu && usage && at > lastCpu.at ? Math.min(1, (usage - lastCpu.usage) / ((at - lastCpu.at) * 1000 * cpuLimit)) : null;
  lastCpu = { usage, at };
  const meminfo = readText('/proc/meminfo') || '';
  const megabytes = name => Math.round(Number(new RegExp(`^${name}:\\s+(\\d+)`, 'm').exec(meminfo)?.[1] || 0) / 1024);
  const memLimit = readText('/sys/fs/cgroup/memory.max');
  let diskFreeGb = null, diskTotalGb = null;
  try { const disk = statfsSync('/data'); diskFreeGb = Math.round(disk.bavail * disk.bsize / 1e8) / 10; diskTotalGb = Math.round(disk.blocks * disk.bsize / 1e8) / 10; } catch { /* no /data outside Docker */ }
  const machineLoad = Math.round(os.loadavg()[0] / cpus * 100) / 100;
  const memAvailableMb = megabytes('MemAvailable');
  const ioWaitPercent = Number(/some avg10=([\d.]+)/.exec(readText('/proc/pressure/io') || '')?.[1] ?? NaN);
  // A gap between the thresholds: near one line the mode would flip back and forth, and every flip is a write.
  const diskBusy = Number.isFinite(ioWaitPercent) && ioWaitPercent > (wasDiskBusy ? 10 : 20);
  wasDiskBusy = diskBusy;
  const busy = (ownCpu !== null && ownCpu > 0.85) || machineLoad > 0.9 || (memAvailableMb > 0 && memAvailableMb < 400) || diskBusy;
  const mode = diskFreeGb !== null && diskFreeGb < 2 ? 'disk_low' : busy ? 'busy' : 'normal';
  return {
    mode, cpuLimit, ownCpuPercent: ownCpu === null ? null : Math.round(ownCpu * 100), machineLoad, cpus, ioWaitPercent: Number.isFinite(ioWaitPercent) ? Math.round(ioWaitPercent) : null,
    memAvailableMb, memTotalMb: megabytes('MemTotal'), appMemoryMb: Math.round(Number(readText('/sys/fs/cgroup/memory.current') || 0) / 1048576),
    appMemoryLimitMb: memLimit && memLimit !== 'max' ? Math.round(Number(memLimit) / 1048576) : null, diskFreeGb, diskTotalGb,
  };
}
const PAUSED_WHEN = { busy: ['рисование карточек', 'хеши картинок', 'статистика', 'диагностика аккаунтов'], disk_low: ['загрузка файлов из Gudini', 'рисование карточек', 'хеши картинок'] };

const state = { startedAt: new Date().toISOString(), lastSync: null, lastWrite: null, lastRender: null, lastPublish: null, lastCleanup: null, resources: null, paused: [], starts: null, backups: [], errors: [] };
let lastErrorAt = 0;
// The step names as the owner reads them on «Состояние системы».
const STEPS = { watch: 'ожидание Gudini', import: 'импорт', classify: 'темы', hash: 'хеши картинок', distribute: 'распределение', write: 'тексты', bridge: 'GPT-мост', review: 'ИИ-редактор', render: 'рисование', publish: 'публикация', stats: 'статистика', accounts: 'проверка аккаунтов', diagnostics: 'диагностика', cleanup: 'очистка', activity: 'активность', suggest: 'ответы на комментарии', reply: 'ответы на комментарии', analytics: 'аналитика', pass: 'проход движка' };
const remember = (where, error) => {
  lastErrorAt = Date.now();
  state.errors.unshift({ at: new Date().toISOString(), step: STEPS[where] || where, message: String(error?.message || error) });
  state.errors.length = Math.min(state.errors.length, 8);
};

/**
 * The main pass rests between rounds: 10 s while there is work, a minute when there is none. Every database query
 * of the local D1 is a write to the disk (even a read), so an idle engine must not ask every few seconds.
 * News from Gudini wakes it at once.
 */
let wake = null;
const nap = ms => new Promise(resolve => {
  const done = () => { clearTimeout(timer); wake = null; resolve(); };
  const timer = setTimeout(done, ms);
  wake = done;
});

/** Long poll: Gudini answers as soon as something new is ready, otherwise after 25 s. */
async function watchLoop() {
  for (;;) {
    const began = Date.now();
    try {
      const result = await content({ action: 'watch', wait: 25 }, { timeoutMs: 60_000 });
      if (result.changed) { log('Gudini: есть новые материалы'); if (!(await importNow())) await sleep(30_000); else wake?.(); }
      if (result.off || result.error || result.waiting) await sleep(30_000);
    } catch (error) { remember('watch', error); await sleep(30_000); }
    // Never a tight loop, whatever the answers are.
    if (Date.now() - began < 3_000) await sleep(3_000);
  }
}
let importing = false;
/** One import pass; false when it could not move on (an error, or the source is paused). */
async function importNow(force = false) {
  if (importing) return true;
  importing = true;
  let moved = true;
  try {
    const result = await content({ action: 'sync', force });
    if (result.error || result.skipped) moved = false;
    if (!result.skipped) { state.lastSync = { at: new Date().toISOString(), ...result }; if (result.new || result.updated || result.error) log('импорт:', JSON.stringify(result)); }
    // With little disk left, the texts still come in; the files wait until there is room.
    for (let round = 0; round < 6 && state.resources?.mode !== 'disk_low'; round++) {
      const { fetched } = await content({ action: 'fetchAssets', limit: 8 }, { timeoutMs: 300_000 });
      if (!fetched) break;
    }
  } catch (error) { remember('import', error); moved = false; }
  finally { importing = false; }
  return moved;
}

let writerPausedUntil = 0;
/** One material's texts; false when there was nothing to do or the bridge refused (then writing pauses 10 min). */
async function writeOne() {
  if (Date.now() < writerPausedUntil) return false;
  const { jobs, limitReached } = await app('/api/content?view=writer&limit=1');
  if (limitReached || !jobs?.length) return false;
  const job = jobs[0];
  const { slots } = await content({ action: 'claimWriting', itemId: job.itemId, revision: job.revision });
  if (!slots.length) return false;
  if (!BRIDGE_TOKEN) { writerPausedUntil = Date.now() + 10 * 60_000; await content({ action: 'writingFailed', itemId: job.itemId, revision: job.revision, error: 'не задан CODEX_BRIDGE_TOKEN (docker.env)', bridge: true }); return false; }
  const began = Date.now();
  let answer;
  try { answer = await bridge({ stage: 'Creative Director', model: MODEL, effort: EFFORT, system: job.system, user: job.user }, 20 * 60_000); }
  catch (error) {
    // The bridge itself failed (down, refused, misconfigured): not the texts' fault, no attempt is spent.
    remember('bridge', error);
    writerPausedUntil = Date.now() + 10 * 60_000;
    await content({ action: 'writingFailed', itemId: job.itemId, revision: job.revision, error: error.message, bridge: true }).catch(() => undefined);
    return false;
  }
  try {
    const variants = parseVariants(answer.text);
    const result = await content({ action: 'acceptTexts', itemId: job.itemId, revision: job.revision, variants });
    state.lastWrite = { at: new Date().toISOString(), seconds: Math.round((Date.now() - began) / 1000), results: result.results?.map(entry => `${entry.slot}:${entry.status}`) };
    log(`тексты материала ${job.itemId.slice(0, 8)}: ${state.lastWrite.results?.join(' ')} за ${state.lastWrite.seconds} с`);
  } catch (error) {
    remember('write', error);
    await content({ action: 'writingFailed', itemId: job.itemId, revision: job.revision, error: error.message }).catch(() => undefined);
  }
  return true;
}

/**
 * Up to 20 fresh materials sorted into the owner's topics by the AI. While the bridge is away they wait (nothing can
 * be written without it anyway); with no bridge configured, or an answer that cannot be read, keywords decide.
 */
async function classifyOne() {
  if (BRIDGE_TOKEN && Date.now() < writerPausedUntil) return false;
  // Old materials are sorted by their words right there; fresh ones come back as one task for the AI.
  const { job } = await content({ action: 'classifyJob' });
  if (!job) return false;
  let items = null;
  if (BRIDGE_TOKEN) {
    let answer;
    try { answer = await bridge({ stage: 'Creative Director', model: MODEL, effort: EFFORT, system: job.system, user: job.user }, 5 * 60_000); }
    catch (error) { remember('bridge', error); writerPausedUntil = Date.now() + 10 * 60_000; return false; }
    try { const parsed = parseJson(answer.text); items = Array.isArray(parsed.items) ? parsed.items.slice(0, 40) : null; } catch (error) { remember('classify', error); }
  }
  const result = await content({ action: 'acceptClassification', ids: job.ids, items });
  log(`темы: ${job.ids.length} материалов (ИИ: ${result.byAi}, по ключевым словам: ${result.byKeywords})`);
  return true;
}

/**
 * The AI editor reads every new version of one material. The bridge being away costs no attempt (the versions
 * wait); an answer that cannot be read sends the versions to the owner with that reason, never round in circles.
 */
async function reviewOne() {
  if (!BRIDGE_TOKEN || Date.now() < writerPausedUntil) return false;
  const { job } = await app('/api/content?view=review');
  if (!job) return false;
  const began = Date.now();
  let answer;
  try { answer = await bridge({ stage: 'Creative Director', model: MODEL, effort: EFFORT, system: job.system, user: job.user }, 15 * 60_000); }
  catch (error) {
    remember('bridge', error);
    writerPausedUntil = Date.now() + 10 * 60_000;
    await content({ action: 'reviewFailed', itemId: job.itemId, revision: job.revision }).catch(() => undefined);
    return false;
  }
  let reviews = [];
  try { const parsed = parseJson(answer.text); reviews = Array.isArray(parsed.reviews) ? parsed.reviews.slice(0, 20) : []; } catch (error) { remember('review', error); }
  const result = await content({ action: 'acceptReview', itemId: job.itemId, revision: job.revision, reviews });
  log(`редактор, материал ${job.itemId.slice(0, 8)}: ${(result.results || []).map(entry => `${entry.slot}:${entry.status} ${entry.score}`).join(' ')} за ${Math.round((Date.now() - began) / 1000)} с`);
  return true;
}

/** Suggested answers for up to 10 new comments. Only suggestions: the owner sends each answer by hand. */
async function suggestReplies() {
  if (!BRIDGE_TOKEN || Date.now() < writerPausedUntil) return false;
  const { job } = await app('/api/activity?view=suggest');
  if (!job) return false;
  let answer;
  try { answer = await bridge({ stage: 'Creative Director', model: MODEL, effort: EFFORT, system: job.system, user: job.user }, 5 * 60_000); }
  catch (error) { remember('bridge', error); writerPausedUntil = Date.now() + 10 * 60_000; return false; }
  let replies = null;
  try { const parsed = parseJson(answer.text); replies = Array.isArray(parsed.replies) ? parsed.replies.slice(0, 20).map(entry => ({ id: String(entry?.id || '').slice(0, 80), text: typeof entry?.text === 'string' ? entry.text.slice(0, 4000) : '', skip: entry?.skip === true })) : null; }
  catch (error) { remember('suggest', error); }
  const result = await app('/api/activity', { action: 'acceptSuggestions', ids: job.ids, replies });
  log(`активность: предложены ответы на ${result.suggested} комментариев`);
  return true;
}

/** Perceptual hashes of the original pictures, a few per pass: they find the same picture in another material. */
async function hashPictures() {
  const { assets } = await app('/api/content?view=unhashed');
  for (const asset of assets || []) {
    try {
      const response = await app(`/api/content?file=${encodeURIComponent(asset.key)}`, undefined, { raw: true });
      const probe = await media('/probe', { data: Buffer.from(await response.arrayBuffer()).toString('base64') }, 60_000);
      const stored = await content({ action: 'assetHash', assetId: asset.id, dhash: probe.dhash });
      if (stored.related) log(`картинка ${asset.id.slice(0, 8)}: та же история, что и в материале ${stored.related.slice(0, 8)}`);
    } catch (error) {
      // A file the worker refuses (not a picture, too large) gets no hash, once; the next pictures still get theirs.
      if (error.status >= 400 && error.status < 500 && ![401, 408, 429].includes(error.status)) { await content({ action: 'assetHash', assetId: asset.id, dhash: null }); log(`картинка ${asset.id.slice(0, 8)}: без хеша (${error.message})`); }
      else throw error;
    }
  }
  return (assets || []).length;
}

/**
 * One version drawn by Gudini's own templates. Gudini answers with cards, or with the fields that did not fit:
 * then the writer shortens exactly those fields and the version is drawn again. Every card is checked by
 * ferma-media-worker (format, size, perceptual hash) before the version is ready.
 */
async function renderOne() {
  const { job } = await content({ action: 'claimRender' });
  if (!job) return false;
  const began = Date.now();
  try {
    const drawn = await content({ action: 'renderGudini', jobId: job.jobId }, { timeoutMs: 330_000 });
    if (drawn.skipped) return true;
    if (!drawn.ok) {
      if (drawn.fix && BRIDGE_TOKEN && Date.now() >= writerPausedUntil) {
        const answer = await bridge({ stage: 'Creative Director', model: MODEL, effort: EFFORT, system: drawn.fix.system, user: drawn.fix.user }, 10 * 60_000);
        const cleaned = String(answer.text || '').replace(/^```(?:json)?\s*|\s*```$/g, '').trim();
        const fixed = JSON.parse(cleaned.slice(cleaned.indexOf('{'), cleaned.lastIndexOf('}') + 1));
        await content({ action: 'fixedContent', jobId: job.jobId, content: fixed.content, caption: typeof fixed.caption === 'string' ? fixed.caption : null });
        log(`вариант ${job.variantId.slice(0, 8)}: Gudini не сверстал (${drawn.problems.length}), тексты поправлены`);
      } else if (drawn.fix) await content({ action: 'fixedContent', jobId: job.jobId, content: null, caption: null });
      else log(`вариант ${job.variantId.slice(0, 8)}: ${drawn.restored ? 'в несвёрстанные поля возвращён текст Gudini' : `не свёрстан: ${drawn.problems.slice(0, 2).join('; ')}`}`);
      return true;
    }
    const files = [];
    for (const slide of drawn.slides) {
      const response = await app(`/api/content?file=${encodeURIComponent(slide.key)}`, undefined, { raw: true });
      const probe = await media('/probe', { data: Buffer.from(await response.arrayBuffer()).toString('base64'), platform: 'instagram' }, 60_000);
      if (probe.problems.length) throw Object.assign(new Error(`карточка ${slide.index + 1}: ${probe.problems.join('; ')}`), { retryable: false });
      files.push({ index: slide.index, contentType: 'image/jpeg', width: probe.width, height: probe.height, size: probe.size, sha256: probe.sha256, dhash: probe.dhash });
    }
    const done = await content({ action: 'renderComplete', jobId: job.jobId, files, elapsedMs: Date.now() - began });
    state.lastRender = { at: new Date().toISOString(), cards: files.length, seconds: Math.round((Date.now() - began) / 1000), review: done.review };
    log(`вариант ${job.variantId.slice(0, 8)}: Gudini нарисовал ${files.length} карточек за ${state.lastRender.seconds} с${done.review ? ' (на проверку: обложка похожа на другой вариант)' : ''}`);
  } catch (error) {
    remember('render', error);
    await content({ action: 'renderFailed', jobId: job.jobId, error: error.message, retryable: error.retryable !== false && (error.status === undefined || error.status >= 500) }).catch(() => undefined);
  }
  return true;
}

let lastDistribute = 0, lastStats = 0, lastAccounts = 0, lastMediaHealth = 0, lastPublish = 0, lastDiagnose = 0, lastCleanup = 0, lastHousekeeping = 0, lastEngagement = 0, lastRecommend = 0, lastReplyTick = 0;
let lastBeat = { at: 0, ok: null, mode: null };
// The queue is looked at every 20 s while publishing is on (or something waits to be settled), every 2 min when off.
let publishEvery = 20_000;
/** One round of the content work. True when it found something to do, so the next round comes soon. */
async function pass() {
  const now = Date.now();
  let worked = false;
  state.resources = resources();
  const light = state.resources.mode === 'normal';
  const paused = PAUSED_WHEN[state.resources.mode] || [];
  if (paused.join() !== state.paused.join()) log(paused.length ? `мало ресурсов (${state.resources.mode}): ждут ${paused.join(', ')}` : 'ресурсов снова хватает');
  state.paused = paused;
  await importNow();
  try { if (await classifyOne()) worked = true; } catch (error) { remember('classify', error); }
  if (light) { try { if (await hashPictures()) worked = true; } catch (error) { remember('hash', error); } }
  if (now - lastDistribute > 60_000) { lastDistribute = now; try { const result = await content({ action: 'distribute' }); if (result.planned) { worked = true; log(`распределено публикаций: ${result.planned}`); } } catch (error) { remember('distribute', error); } }
  try { for (let index = 0; index < 2 && await writeOne(); index++) worked = true; } catch (error) { remember('write', error); }
  try { for (let index = 0; index < 2 && await reviewOne(); index++) worked = true; } catch (error) { remember('review', error); }
  if (light) { try { for (let index = 0; index < 3 && await renderOne(); index++) worked = true; } catch (error) { remember('render', error); } }
  if (light && now - lastStats > 30 * 60_000) { lastStats = now; app('/api/publications', { action: 'stats' }).catch(error => remember('stats', error)); }
  // Media retention: FERMA's own drawn cards that nobody can use any more (Gudini's originals are never removed).
  if (now - lastCleanup > 6 * 3600_000) {
    lastCleanup = now;
    try { const result = await content({ action: 'cleanup' }, { timeoutMs: 300_000 }); state.lastCleanup = { at: new Date().toISOString(), ...result }; if (result.files) log(`очистка: удалено карточек ${result.files} (${Math.round(result.bytes / 1048576)} МБ), срок хранения ${result.retentionDays} дн.`); }
    catch (error) { remember('cleanup', error); }
  }
  // «Активность»: new replies and comments under own posts every half hour, suggestions, then approved answers out.
  if (light && now - lastEngagement > 30 * 60_000) {
    lastEngagement = now;
    try { const result = await app('/api/activity', { action: 'fetch' }, { timeoutMs: 300_000 }); if (result.added) log(`активность: новых комментариев ${result.added}`); } catch (error) { remember('activity', error); }
    try { await suggestReplies(); } catch (error) { remember('suggest', error); }
  }
  // Recommendations from the numbers, once a day; nothing is applied without the owner.
  if (now - lastRecommend > 24 * 3600_000) { lastRecommend = now; app('/api/analytics', { action: 'compute' }).catch(error => remember('analytics', error)); }
  // Starts of FERMA and the database copies, for «Состояние системы».
  if (now - lastHousekeeping > 10 * 60_000) {
    lastHousekeeping = now;
    const starts = (readText('/data/ferma-starts.log') || '').split('\n').filter(Boolean);
    state.starts = { last: starts.at(-1) || null, day: starts.filter(at => Date.parse(at) > now - 86_400_000).length };
    state.backups = await listBackups('/data').catch(() => []);
  }
  if (now - lastAccounts > 6 * 3600_000) { lastAccounts = now; app('/api/publications', { action: 'checkAccounts' }).catch(error => remember('accounts', error)); }
  // Full diagnostics of every account once a day (reads only: token, permissions, quota, insights).
  if (light && now - lastDiagnose > 3600_000) { lastDiagnose = now; app('/api/accounts', { action: 'diagnoseAll', staleHours: 24 }, { timeoutMs: 300_000 }).catch(error => remember('diagnostics', error)); }
  return worked;
}

/**
 * Publishing, Threads answers and the heartbeats keep their own clock: a long writer, editor or drawing call in
 * the main pass never holds up a due post or makes a working engine look silent.
 */
async function timeLoop() {
  for (;;) {
    const now = Date.now();
    try {
      if (now - lastPublish > publishEvery) {
        lastPublish = now;
        try {
          const result = await app('/api/publications', { action: 'tick' }, { timeoutMs: 300_000 });
          const moved = Object.keys(result.results || {}).length > 0;
          publishEvery = result.off && !moved ? 120_000 : 20_000;
          if (moved) { state.lastPublish = { at: new Date().toISOString(), ...result }; log('очередь:', JSON.stringify(result.results)); }
        } catch (error) { remember('publish', error); }
      }
      // Threads answers wait half a minute anyway; once a minute is enough and spares the disk.
      if (now - lastReplyTick > 60_000) { lastReplyTick = now; try { await app('/api/activity', { action: 'replyTick' }); } catch (error) { remember('reply', error); } }
      if (now - lastMediaHealth > 60_000) {
        lastMediaHealth = now;
        try { const health = await media('/health', undefined, 5_000); await content({ action: 'heartbeat', name: 'media', ok: true, note: `занят: ${health.running}, ждут: ${health.waiting}, свободно памяти ${health.freeMemoryMb} МБ`, details: health }); }
        catch (error) { await content({ action: 'heartbeat', name: 'media', ok: false, note: String(error.message).slice(0, 500), details: null }).catch(() => undefined); }
      }
      // Healthy = no error during the last five minutes; the latest error stays visible for a while either way.
      // Every heartbeat is a database write: once a minute, or at once when health or the resource mode changes.
      state.resources = resources();
      const healthy = Date.now() - lastErrorAt > 5 * 60_000;
      if (now - lastBeat.at > 60_000 || healthy !== lastBeat.ok || state.resources.mode !== lastBeat.mode) {
        lastBeat = { at: now, ok: healthy, mode: state.resources.mode };
        await content({ action: 'heartbeat', name: 'engine', ok: healthy, note: healthy ? null : state.errors[0] ? `${state.errors[0].step}: ${state.errors[0].message}`.slice(0, 500) : null, details: state }).catch(() => undefined);
      }
    } catch (error) { remember('pass', error); }
    await sleep(5_000);
  }
}

if (process.argv[1]?.endsWith('content.mjs') && ENABLED) {
  log('запущен');
  await sleep(8_000);
  readMediaToken();
  void watchLoop();
  void timeLoop();
  for (;;) {
    let worked = false;
    try { worked = await pass(); } catch (error) { remember('pass', error); }
    await nap(worked ? 10_000 : 60_000);
  }
} else if (process.argv[1]?.endsWith('content.mjs')) log('выключен (CONTENT_ENGINE=off)');
