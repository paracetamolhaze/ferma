import { mkdir, readdir, readFile, writeFile } from 'node:fs/promises';
import { spawn } from 'node:child_process';
import { createGateway, createPublicGateway, createRemoteGateway } from './gateway.mjs';
import { randomBytes } from 'node:crypto';
import { backupBeforeMigrations, rememberMigrations } from './backup.mjs';

// Every start is written down: «Состояние системы» shows how often FERMA had to start again.
try {
  const log = '/data/ferma-starts.log';
  const previous = (await readFile(log, 'utf8').catch(() => '')).split('\n').filter(Boolean).slice(-99);
  await writeFile(log, [...previous, new Date().toISOString()].join('\n') + '\n');
} catch (error) { console.error('starts log:', error.message); }

const runtimeDirectory = '/tmp/ferma-runtime';
await mkdir(runtimeDirectory, { recursive: true, mode: 0o700 });
const config = JSON.parse(await readFile('/app/dist/server/wrangler.json', 'utf8'));
config.main = '/app/dist/server/index.js';
config.assets.directory = '/app/dist/client';
config.d1_databases = config.d1_databases.map(database => ({ ...database, migrations_dir: '/app/drizzle' }));
await writeFile(`${runtimeDirectory}/wrangler.json`, JSON.stringify(config));
await mkdir('/data/secrets', { recursive: true, mode: 0o700 });
const encryptionFile = '/data/secrets/settings.key';
try { await writeFile(encryptionFile, randomBytes(32).toString('base64'), { flag: 'wx', mode: 0o600 }); }
catch (error) { if (error.code !== 'EEXIST') throw error; }
const encryptionKey = (await readFile(encryptionFile, 'utf8')).trim();
// Shared with ferma-media-worker through the small `internal` volume: the worker accepts jobs only with it.
try {
  await mkdir('/internal', { recursive: true });
  await writeFile('/internal/media.token', randomBytes(32).toString('base64url'), { flag: 'wx', mode: 0o600 });
} catch (error) { if (error.code !== 'EEXIST' && error.code !== 'EACCES') console.error('media token:', error.message); }
await writeFile(`${runtimeDirectory}/.dev.vars`, `SETTINGS_ENCRYPTION_KEY=${JSON.stringify(encryptionKey)}\n`, { mode: 0o600 });
const childEnvironment = {
  ...process.env,
  WRANGLER_SEND_METRICS: 'false', WRANGLER_WRITE_LOGS: 'false',
  WRANGLER_LOG_PATH: `${runtimeDirectory}/logs`,
  WRANGLER_REGISTRY_PATH: `${runtimeDirectory}/registry`,
  MINIFLARE_REGISTRY_PATH: `${runtimeDirectory}/miniflare`,
};
const common = ['--config', `${runtimeDirectory}/wrangler.json`, '--local', '--persist-to', '/data'];
const wrangler = '/app/node_modules/wrangler/bin/wrangler.js';
// A copy of the database before migrations it has not seen yet (checked by opening the copy); the newest 5 are kept.
const migrationFiles = (await readdir('/app/drizzle')).filter(file => file.endsWith('.sql')).sort();
await backupBeforeMigrations({ data: '/data', migrations: migrationFiles, log: message => console.log(`[backup] ${message}`) });
const migration = spawn(process.execPath, [wrangler, 'd1', 'migrations', 'apply', 'DB', ...common], { env: childEnvironment, stdio: ['ignore', 'inherit', 'inherit'] });
const migrationCode = await new Promise((resolve, reject) => { migration.once('exit', resolve); migration.once('error', reject); });
if (migrationCode !== 0) throw new Error(`Database migration failed (${migrationCode})`);
await rememberMigrations('/data', migrationFiles);

const worker = spawn(process.execPath, [wrangler, 'dev', ...common, '--ip', '127.0.0.1', '--port', '8787', '--inspector-port', '0'], { env: childEnvironment, stdio: ['ignore', 'inherit', 'inherit'] });
const gateway = createGateway();
// The autopilot engine runs beside the app; it restarts by itself if it ever stops.
let autopilot = null;
function startAutopilot() {
  if (stopping) return;
  autopilot = spawn(process.execPath, ['/app/docker/autopilot.mjs'], { env: process.env, stdio: ['ignore', 'inherit', 'inherit'] });
  autopilot.once('exit', () => { autopilot = null; setTimeout(startAutopilot, 10000); });
}
// AUTOPILOT=off only for an isolated copy (tests on a copy of real data): nothing may go out from there.
if ((process.env.AUTOPILOT || 'on') !== 'off') setTimeout(startAutopilot, 5000);
else console.log('[autopilot] выключен (AUTOPILOT=off)');
// The content engine (Gudini import, versions, drawing, the publication queue) runs the same way.
let content = null;
function startContent() {
  if (stopping) return;
  content = spawn(process.execPath, ['/app/docker/content.mjs'], { env: process.env, stdio: ['ignore', 'inherit', 'inherit'] });
  content.once('exit', () => { content = null; setTimeout(startContent, 10000); });
}
setTimeout(startContent, 6000);
// Public media port: only signed links to single pictures and the OAuth return. Published on 127.0.0.1:3102 for Caddy.
const publicGateway = createPublicGateway();
publicGateway.listen(3102, '0.0.0.0', () => console.log('FERMA public media: :3102'));
gateway.listen(3100, '0.0.0.0', () => console.log('FERMA Docker: http://localhost:3100'));
// The owner's own devices through the domain, like Gudini: only with a site password (FERMA_SITE_PASSWORD,
// docker.env). Published on 127.0.0.1:3104 for Caddy; without a password this port is not opened at all.
let remoteGateway = null;
try {
  if (process.env.FERMA_SITE_PASSWORD) {
    remoteGateway = createRemoteGateway();
    remoteGateway.listen(3104, '0.0.0.0', () => console.log('FERMA for own devices (password): :3104'));
  } else console.log('FERMA for own devices: off (no FERMA_SITE_PASSWORD)');
} catch (error) { console.error('FERMA for own devices: off,', error.message); }
let stopping = false;
function stop() {
  if (stopping) return;
  stopping = true;
  gateway.close();
  publicGateway.close();
  remoteGateway?.close();
  autopilot?.kill('SIGTERM');
  content?.kill('SIGTERM');
  worker.kill('SIGTERM');
  setTimeout(() => process.exit(1), 25000).unref();
}
for (const signal of ['SIGTERM', 'SIGINT']) process.on(signal, stop);
worker.once('error', error => { console.error(error.message); stop(); });
worker.once('exit', code => { gateway.close(); process.exit(stopping ? 0 : (code || 1)); });
