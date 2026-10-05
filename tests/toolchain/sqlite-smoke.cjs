// Dependency compatibility only. This is NOT a product storage/acceptance test.
const assert = require('node:assert/strict');
const { test } = require('node:test');
const { mkdtemp, rm } = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const Database = require('better-sqlite3');

test('native SQLite loads, rolls back a failed transaction, and backs up committed WAL data', async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'school-asset-sqlite-smoke-'));
  let db;
  let backup;
  try {
    db = new Database(path.join(root, 'source.sqlite'));
    const engine = db.prepare('SELECT sqlite_version() AS version, sqlite_source_id() AS source_id').get();
    const [major, minor, patch] = engine.version.split('.').map(Number);
    assert.ok(major > 3 || (major === 3 && (minor > 51 || (minor === 51 && patch >= 3))),
      `SQLite must include the required WAL fixes; found ${engine.version}`);
    assert.ok(engine.source_id.length > 40);
    db.pragma('foreign_keys = ON');
    db.pragma('trusted_schema = OFF');
    db.pragma('journal_mode = WAL');
    db.pragma('synchronous = FULL');
    assert.equal(db.pragma('foreign_keys', { simple: true }), 1);
    assert.equal(db.pragma('trusted_schema', { simple: true }), 0);
    assert.equal(db.pragma('journal_mode', { simple: true }), 'wal');
    assert.equal(db.pragma('synchronous', { simple: true }), 2);
    db.exec('CREATE TABLE smoke (id TEXT PRIMARY KEY, value TEXT NOT NULL)');
    db.prepare('INSERT INTO smoke VALUES (?, ?)').run('synthetic-001', '합성 자료');
    assert.throws(db.transaction(() => {
      db.prepare('INSERT INTO smoke VALUES (?, ?)').run('synthetic-002', '롤백 대상');
      throw new Error('controlled rollback');
    }), /controlled rollback/);
    assert.equal(db.prepare('SELECT COUNT(*) AS count FROM smoke').get().count, 1);
    await db.backup(path.join(root, 'backup.sqlite'));
    backup = new Database(path.join(root, 'backup.sqlite'), { readonly: true });
    assert.deepEqual(backup.prepare('SELECT id, value FROM smoke').all(), [
      { id: 'synthetic-001', value: '합성 자료' },
    ]);
    assert.equal(backup.pragma('integrity_check', { simple: true }), 'ok');
    t.diagnostic(JSON.stringify({
      platform: process.platform,
      arch: process.arch,
      node: process.versions.node,
      electron: process.versions.electron || null,
      sqlite: engine,
    }));
  } finally {
    if (backup) backup.close();
    if (db) db.close();
    await rm(root, { recursive: true, force: true });
  }
});
