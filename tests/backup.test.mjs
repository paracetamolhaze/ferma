import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readdir, rm, writeFile, cp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { backupBeforeMigrations, checkCopy, listBackups, rememberMigrations } from '../docker/backup.mjs';

async function fakeData() {
  const data = await mkdtemp(path.join(tmpdir(), 'ferma-backup-'));
  const objects = path.join(data, 'v3', 'd1', 'miniflare-D1DatabaseObject');
  await mkdir(objects, { recursive: true });
  const db = new DatabaseSync(path.join(objects, 'abc.sqlite'));
  db.exec("PRAGMA journal_mode = WAL; CREATE TABLE d1_migrations (id INTEGER PRIMARY KEY, name TEXT); INSERT INTO d1_migrations (name) VALUES ('0000_a.sql'), ('0001_b.sql'); CREATE TABLE profiles (id TEXT); INSERT INTO profiles VALUES ('p1');");
  db.close();
  return data;
}

test('database copy before new migrations: made once, checked by SQLite, newest five kept, restorable', async t => {
  const data = await fakeData();
  t.after(() => rm(data, { recursive: true, force: true }));
  const files = ['0000_a.sql', '0001_b.sql'];
  // Nothing known yet: every file is new, so a copy is made and checked.
  const first = await backupBeforeMigrations({ data, migrations: files });
  assert.ok(first && first.checks.every(entry => entry.ok && entry.tables === 2 && entry.migrations === 2), JSON.stringify(first?.checks));
  await rememberMigrations(data, files);
  assert.equal(await backupBeforeMigrations({ data, migrations: files }), null, 'no copy without new migrations');
  // Six later releases with one new migration each: only the newest five copies stay.
  for (let index = 2; index < 8; index++) {
    const next = [...files, ...Array.from({ length: index - 1 }, (_, n) => `000${n + 2}_x.sql`)];
    await new Promise(resolve => setTimeout(resolve, 5));
    assert.ok(await backupBeforeMigrations({ data, migrations: next }));
    await rememberMigrations(data, next);
  }
  const kept = await listBackups(data);
  assert.equal(kept.length, 5);
  assert.ok(kept.every(entry => entry.ok && entry.at));
  // Restore: the copy's d1 folder replaces the live one and the data is there.
  const live = path.join(data, 'v3', 'd1');
  await rm(live, { recursive: true, force: true });
  await cp(path.join(data, 'backups', kept[0].name, 'd1'), live, { recursive: true });
  const restored = new DatabaseSync(path.join(live, 'miniflare-D1DatabaseObject', 'abc.sqlite'));
  assert.equal(restored.prepare('SELECT id FROM profiles').get().id, 'p1');
  restored.close();
});

test('a copy that does not open is removed and migrations are refused; good copies stay', async t => {
  const data = await fakeData();
  t.after(() => rm(data, { recursive: true, force: true }));
  await backupBeforeMigrations({ data, migrations: ['0000_a.sql'] });
  await rememberMigrations(data, ['0000_a.sql']);
  // The live database file is damaged: its copy cannot pass the check.
  await writeFile(path.join(data, 'v3', 'd1', 'miniflare-D1DatabaseObject', 'abc.sqlite'), 'not a database');
  await rm(path.join(data, 'v3', 'd1', 'miniflare-D1DatabaseObject', 'abc.sqlite-wal'), { force: true });
  await assert.rejects(backupBeforeMigrations({ data, migrations: ['0000_a.sql', '0001_b.sql'] }), /не прошла проверку/);
  const copies = (await readdir(path.join(data, 'backups'))).filter(name => name.startsWith('d1-'));
  assert.equal(copies.length, 1, 'the earlier good copy is still there');
  assert.ok((await checkCopy(path.join(data, 'backups', copies[0], 'd1'))).every(entry => entry.ok));
});
