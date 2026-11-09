import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { spawn } from 'node:child_process';
import { createGateway } from './gateway.mjs';
import { randomBytes } from 'node:crypto';

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
const migration = spawn(process.execPath, [wrangler, 'd1', 'migrations', 'apply', 'DB', ...common], { env: childEnvironment, stdio: ['ignore', 'inherit', 'inherit'] });
const migrationCode = await new Promise((resolve, reject) => { migration.once('exit', resolve); migration.once('error', reject); });
if (migrationCode !== 0) throw new Error(`Database migration failed (${migrationCode})`);

const worker = spawn(process.execPath, [wrangler, 'dev', ...common, '--ip', '127.0.0.1', '--port', '8787', '--inspector-port', '0'], { env: childEnvironment, stdio: ['ignore', 'inherit', 'inherit'] });
const gateway = createGateway();
gateway.listen(3100, '0.0.0.0', () => console.log('FERMA Docker: http://localhost:3100'));
let stopping = false;
function stop() {
  if (stopping) return;
  stopping = true;
  gateway.close();
  worker.kill('SIGTERM');
  setTimeout(() => process.exit(1), 25000).unref();
}
for (const signal of ['SIGTERM', 'SIGINT']) process.on(signal, stop);
worker.once('error', error => { console.error(error.message); stop(); });
worker.once('exit', code => { gateway.close(); process.exit(stopping ? 0 : (code || 1)); });
