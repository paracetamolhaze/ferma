// Copies of FERMA's database before migrations it has not seen yet. Local D1 keeps its data in SQLite files under
// /data/v3/d1; they are copied before the app starts (nothing has them open), the copy is opened and checked by
// SQLite itself, and only then do migrations run. The newest five good copies are kept; pictures (R2) are not
// copied: migrations never touch them.
//
// Restore (FERMA stopped): replace /data/v3/d1 with the d1 folder of a copy, then start FERMA again.
import { cp, mkdir, readdir, readFile, rm, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import path from 'node:path';

const KEEP = 5;

/** Opens every database file of a copy: SQLite's integrity check, the number of tables and of applied migrations. */
export async function checkCopy(directory) {
  const { DatabaseSync } = await import('node:sqlite');
  const objects = path.join(directory, 'miniflare-D1DatabaseObject');
  const files = (await readdir(objects)).filter(name => name.endsWith('.sqlite') && name !== 'metadata.sqlite');
  if (!files.length) return [{ file: null, ok: false, error: 'в копии нет файла базы' }];
  const result = [];
  for (const file of files) {
    const db = new DatabaseSync(path.join(objects, file));
    try {
      const integrity = Object.values(db.prepare('PRAGMA integrity_check').get())[0];
      const tables = db.prepare("SELECT count(*) AS n FROM sqlite_master WHERE type = 'table'").get().n;
      let migrations = null;
      try { migrations = db.prepare('SELECT count(*) AS n FROM d1_migrations').get().n; } catch { /* a database before its first migration */ }
      result.push({ file, ok: integrity === 'ok' && tables > 0, integrity, tables, migrations });
    } finally { db.close(); }
  }
  return result;
}

export async function backupBeforeMigrations({ data, migrations, log = () => {} }) {
  const source = path.join(data, 'v3', 'd1');
  // The very first start has no database yet: nothing to keep.
  if (!existsSync(path.join(source, 'miniflare-D1DatabaseObject'))) return null;
  const folder = path.join(data, 'backups');
  const known = JSON.parse(await readFile(path.join(folder, 'migrations.json'), 'utf8').catch(() => '[]'));
  const pending = migrations.filter(name => !known.includes(name));
  if (!pending.length) return null;
  const target = path.join(folder, `d1-${new Date().toISOString().replace(/[:.]/g, '-')}`);
  await mkdir(folder, { recursive: true });
  await cp(source, path.join(target, 'd1'), { recursive: true });
  let checks;
  try { checks = await checkCopy(path.join(target, 'd1')); } catch (error) { checks = [{ ok: false, error: error.message }]; }
  if (!checks.every(entry => entry.ok)) {
    // A bad copy is removed at once, so that it can never push a good one out of the five kept.
    await rm(target, { recursive: true, force: true });
    throw new Error(`Копия базы не прошла проверку (${JSON.stringify(checks)}): миграции не запущены, данные не тронуты.`);
  }
  await writeFile(path.join(target, 'backup.json'), JSON.stringify({ at: new Date().toISOString(), before: pending, checks }, null, 2));
  log(`копия базы сохранена и проверена: ${path.basename(target)} (новых миграций: ${pending.length})`);
  const copies = (await readdir(folder)).filter(name => name.startsWith('d1-')).sort();
  for (const old of copies.slice(0, Math.max(0, copies.length - KEEP))) await rm(path.join(folder, old), { recursive: true, force: true });
  return { target, pending, checks };
}

/** After migrations succeeded: these files are known, the next start makes no copy for them. */
export async function rememberMigrations(data, migrations) {
  await mkdir(path.join(data, 'backups'), { recursive: true });
  await writeFile(path.join(data, 'backups', 'migrations.json'), JSON.stringify(migrations));
}

/** The copies for «Состояние системы»: newest first. */
export async function listBackups(data) {
  const folder = path.join(data, 'backups');
  const names = (await readdir(folder).catch(() => [])).filter(name => name.startsWith('d1-')).sort().reverse();
  const result = [];
  for (const name of names.slice(0, KEEP)) {
    const info = JSON.parse(await readFile(path.join(folder, name, 'backup.json'), 'utf8').catch(() => '{}'));
    result.push({ name, at: info.at || null, before: info.before || [], ok: Array.isArray(info.checks) && info.checks.every(entry => entry.ok) });
  }
  return result;
}
