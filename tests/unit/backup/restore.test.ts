import { spawnSync } from 'node:child_process';
import { existsSync, rmSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { blobPath, readBlob } from '../../../src/main/data/attachments';
import { createBackup } from '../../../src/main/data/backup';
import { DataRoot } from '../../../src/main/data/data-root';
import { createDomainRegistry } from '../../../src/main/data/domain/registry';
import { DomainError } from '../../../src/main/data/errors';
import { collectReport } from '../../../src/main/data/export/reports';
import { newId } from '../../../src/main/data/ids';
import { deleteGeneration, openGenerationReadonly, previewRestore, restoreBackup, rollbackToGeneration } from '../../../src/main/data/restore';
import { fixedClock, tempDir } from '../data/support';
import { mutateDataset, renameEntry, repack, unpack } from './craft';
import { dumpTables, exec, seedLedger } from './support';

let dirs: ReturnType<typeof tempDir>[] = [];
const roots: DataRoot[] = [];
const fresh = (prefix = 'school-asset-restore-') => {
  const t = tempDir(prefix);
  dirs.push(t);
  return t.dir;
};
const open = (dir: string) => {
  const r = DataRoot.open(dir, { registry: createDomainRegistry(), now: fixedClock(Date.parse('2026-05-01T00:00:00Z')) });
  roots.push(r);
  return r;
};
const close = (r: DataRoot) => {
  roots.splice(roots.indexOf(r), 1);
  r.close();
};
beforeEach(() => {
  dirs = [];
});
afterEach(() => {
  for (const r of roots.splice(0)) r.close();
  for (const d of dirs) d.cleanup();
});

async function backupOf(root: DataRoot) {
  const file = path.join(fresh('school-asset-bundle-'), 'backup.sabackup');
  await createBackup(root, file, { appVersion: '0.1.0' });
  return file;
}

async function reason(p: Promise<unknown>): Promise<string> {
  try {
    await p;
  } catch (e) {
    if (e instanceof DomainError) return `${e.code}:${String(e.details.reason ?? e.details.rule ?? '')}`;
    throw e;
  }
  return 'OK';
}

const restore = async (root: DataRoot, bundle: string) => {
  const p = await previewRestore(root, bundle);
  return restoreBackup(root, bundle, { datasetId: p.manifest.datasetId, revision: p.manifest.revision }, { actor: '정보부 관리자' });
};

function pointer(root: DataRoot) {
  return { active: root.catalog.active(), generations: root.catalog.generations().map((g) => `${g.id}:${g.state}`) };
}

describe('AC-34 hostile or invalid backups change nothing', () => {
  it('rejects corrupt, foreign, incompatible, traversal, oversize, missing-file and rule-breaking bundles', async () => {
    const src = open(fresh());
    await seedLedger(src);
    const good = await backupOf(src);
    const target = open(fresh());
    exec(target, 'person.create', { displayName: '기존 자료' });
    const work = fresh('school-asset-craft-');
    const before = { pointer: pointer(target), dump: dumpTables(target.store.db) };
    const file = (name: string, buf: Buffer) => {
      const p = path.join(work, name);
      writeFileSync(p, buf);
      return p;
    };
    const cases: [string, Promise<string>][] = [];
    cases.push(['corrupt', reason(previewRestore(target, file('corrupt.bin', Buffer.from('PK\x03\x04garbage'))))]);
    let parts = await unpack(good);
    parts.manifest.appId = 'other-app';
    cases.push(['other app', reason(previewRestore(target, file('other.sabackup', await repack(parts))))]);
    parts = await unpack(good);
    parts.manifest.schemaVersion = 999;
    cases.push(['schema', reason(previewRestore(target, file('schema.sabackup', await repack(parts))))]);
    parts = await unpack(good);
    parts.files.set('xx/evil', Buffer.from('x'));
    cases.push(['traversal', reason(previewRestore(target, file('evil.sabackup', renameEntry(await repack(parts), 'xx/evil', '../evil'))))]);
    parts = await unpack(good);
    parts.files.set('xxx.txt', Buffer.from('y'));
    cases.push(['absolute/reserved', reason(previewRestore(target, file('con.sabackup', renameEntry(await repack(parts), 'xxx.txt', 'CON.txt'))))]);
    cases.push(['oversize', reason(previewRestore(target, good, { limits: { maxUncompressed: 1024 } }))]);
    parts = await unpack(good);
    const blob = [...parts.files.keys()].find((k) => k.startsWith('blobs/'))!;
    parts.files.delete(blob);
    cases.push(['missing attachment', reason(previewRestore(target, file('missing.sabackup', await repack(parts))))]);
    parts = await unpack(good);
    parts.files.delete(blob);
    cases.push(['missing listed file', reason(previewRestore(target, file('missing-listed.sabackup', await repack(parts, { rehash: false }))))]);
    parts = await unpack(good);
    parts.files.set(blob, Buffer.from('tampered'));
    cases.push(['hash mismatch', reason(previewRestore(target, file('hash.sabackup', await repack(parts, { rehash: false }))))]);
    parts = await unpack(good);
    mutateDataset(parts, work, (db) => {
      const n = (db.prepare('SELECT network_id AS id FROM subnets').get() as { id: string }).id;
      db.prepare('INSERT INTO subnets VALUES (?, ?, ?, 25, ?, NULL, ?, 1, ?)').run(newId(), n, 0x0a5a0000 + 128, 0x0a5a0000 + 255, '[]', '2026-01-01');
    });
    cases.push(['overlapping network', reason(previewRestore(target, file('overlap.sabackup', await repack(parts))))]);
    parts = await unpack(good);
    mutateDataset(parts, work, (db) => db.prepare("UPDATE address_slots SET state = 'pending_release', prior_state = 'reserved'").run());
    cases.push(['pending_release without request', reason(previewRestore(target, file('pending.sabackup', await repack(parts))))]);
    parts = await unpack(good);
    mutateDataset(parts, work, (db) => {
      db.exec('DROP INDEX one_open_inventory');
      db.prepare("INSERT INTO inventory_sessions VALUES (?, '두 번째', '{}', 'open', '2026-01-01', 0, NULL, NULL, 1)").run(newId());
    });
    cases.push(['two open inventories', reason(previewRestore(target, file('two.sabackup', await repack(parts))))]);

    const results = Object.fromEntries(await Promise.all(cases.map(async ([k, p]) => [k, await p])));
    expect(results).toEqual({
      corrupt: 'VALIDATION:not_zip',
      'other app': 'VALIDATION:other_app',
      schema: 'VALIDATION:incompatible_schema',
      traversal: 'VALIDATION:unsafe_path',
      'absolute/reserved': 'VALIDATION:unsafe_path',
      oversize: 'LIMIT_EXCEEDED:uncompressed_size',
      'missing attachment': 'VALIDATION:missing_attachment',
      'missing listed file': 'VALIDATION:missing_file',
      'hash mismatch': 'VALIDATION:hash_mismatch',
      'overlapping network': 'VALIDATION:invariants',
      'pending_release without request': 'VALIDATION:invariants',
      'two open inventories': 'VALIDATION:invariants',
    });
    // The real restore path rejects the same bundles and leaves pointer and data untouched.
    expect(await reason(restoreBackup(target, path.join(work, 'overlap.sabackup'), { datasetId: src.store.datasetId, revision: src.store.revision }, { actor: 'x' }))).toBe('VALIDATION:invariants');
    expect({ pointer: pointer(target).active, dump: dumpTables(target.store.db) }).toEqual({ pointer: before.pointer.active, dump: before.dump });
    expect(target.catalog.generations().filter((g) => g.state === 'active')).toHaveLength(1);
  });
});

describe('AC-35 dataset identity', () => {
  it('refuses another dataset over existing data but accepts it on an empty new PC', async () => {
    const src = open(fresh());
    await seedLedger(src);
    const bundle = await backupOf(src);
    const busy = open(fresh());
    exec(busy, 'person.create', { displayName: '다른 학교 자료' });
    expect(await reason(previewRestore(busy, bundle))).toBe('VALIDATION:different_dataset');
    const empty = open(fresh());
    const p = await previewRestore(empty, bundle);
    expect(p).toMatchObject({ currentHasData: false, sameDataset: false, manifest: { datasetId: src.store.datasetId } });
    await restoreBackup(empty, bundle, { datasetId: p.manifest.datasetId, revision: p.manifest.revision }, { actor: '관리자' });
    expect(empty.store.datasetId).toBe(src.store.datasetId);
  });
});

describe('AC-36 forced termination during restore', () => {
  for (const step of ['staged', 'before-switch', 'after-switch', 'open-new']) {
    it(`killed at ${step}: exactly one consistent generation opens afterwards`, async () => {
      const src = open(fresh());
      await seedLedger(src);
      const bundle = await backupOf(src);
      // Restore once (same dataset afterwards), add new work, then crash a second restore.
      const empty = fresh();
      const r0 = open(empty);
      await restore(r0, bundle);
      exec(r0, 'person.create', { displayName: '복원 후 새 업무' });
      const oldEnvelope = { datasetId: r0.store.datasetId, epoch: r0.store.epoch, commandId: newId(), type: 'person.create', payload: { displayName: '구 epoch 요청' } };
      const epochBefore = r0.store.epoch;
      const genBefore = r0.catalog.active()!.generationId;
      close(r0);
      const child = spawnSync(process.execPath, [path.resolve('tests/unit/data/fixtures/restore-crash.mjs'), empty, bundle, step], { encoding: 'utf8', timeout: 60_000 });
      expect(child.stdout).toContain(`crash at ${step}`);
      expect(child.stdout).not.toContain('finished');
      const after = open(empty);
      const active = after.catalog.generations().filter((g) => g.state === 'active');
      expect(active).toHaveLength(1);
      const switched = step === 'after-switch' || step === 'open-new';
      expect(active[0]!.id === genBefore).toBe(!switched);
      expect(after.store.epoch === epochBefore).toBe(!switched);
      const names = after.store.read((db) => (db.prepare('SELECT display_name AS n FROM people').all() as { n: string }[]).map((p) => p.n)).data;
      expect(names.includes('복원 후 새 업무')).toBe(!switched);
      if (switched) {
        expect(() => after.store.execute(oldEnvelope, '관리자')).toThrow(/복원 또는 전환/);
        expect(after.store.read((db) => (db.prepare("SELECT COUNT(*) AS n FROM audit_events WHERE event_type = 'dataset.restored'").get() as { n: number }).n).data).toBe(1);
      }
      expect(after.store.read((db) => db.pragma('integrity_check', { simple: true })).data).toBe('ok');
    });
  }

  it('a new generation that cannot be opened after the switch is reverted with another new epoch', async () => {
    const src = open(fresh());
    await seedLedger(src);
    const bundle = await backupOf(src);
    const empty = fresh();
    const r0 = open(empty);
    await restore(r0, bundle);
    exec(r0, 'person.create', { displayName: '보존되어야 할 업무' });
    const { generationId: before, epoch } = r0.catalog.active()!;
    close(r0);
    const child = spawnSync(process.execPath, [path.resolve('tests/unit/data/fixtures/restore-crash.mjs'), empty, bundle, 'after-switch', 'corrupt-new'], { encoding: 'utf8', timeout: 60_000 });
    expect(child.stdout).toContain('crash at after-switch');
    const after = open(empty);
    expect(after.catalog.active()!.generationId).toBe(before);
    expect(after.store.epoch).not.toBe(epoch);
    expect(after.catalog.journalEntries().map((j) => j.step)).toContain('reverted');
    expect(after.store.read((db) => db.prepare("SELECT 1 AS ok FROM people WHERE display_name = '보존되어야 할 업무'").get()).data).toEqual({ ok: 1 });
  });
});

describe('AC-37 rollback, retained generations and cleanup', () => {
  it('warns about changes that will disappear, keeps the previous generation readable, rolls back, and protects active/previous', async () => {
    const root = open(fresh());
    await seedLedger(root);
    const bundle = await backupOf(root);
    exec(root, 'person.create', { displayName: '백업 후 추가 1' });
    exec(root, 'person.create', { displayName: '백업 후 추가 2' });
    const p = await previewRestore(root, bundle);
    expect(p).toMatchObject({ sameDataset: true, lostChanges: { count: 2 } });
    const g1 = root.catalog.active()!.generationId;
    await restoreBackup(root, bundle, { datasetId: p.manifest.datasetId, revision: p.manifest.revision }, { actor: '관리자' });
    expect(root.catalog.generation(g1)!.state).toBe('retained');
    const old = openGenerationReadonly(root, g1);
    try {
      const names = (old.prepare('SELECT display_name AS n FROM people').all() as { n: string }[]).map((r) => r.n);
      expect(names).toContain('백업 후 추가 2');
      const report = collectReport(old, { datasetId: root.store.datasetId, revision: 0, now: '2026-05-01T00:00:00Z' }, { kind: 'people_holdings', today: '2026-05-01' });
      expect(report.sheets[0]!.name).toBe('사람별 보유·대여');
    } finally {
      old.close();
    }
    exec(root, 'person.create', { displayName: '복원 후 새 업무' });
    const g2 = root.catalog.active()!.generationId;
    const epoch2 = root.store.epoch;
    await rollbackToGeneration(root, g1, { actor: '관리자' });
    const g3 = root.catalog.active()!.generationId;
    expect([g3 !== g1, g3 !== g2, root.store.epoch !== epoch2]).toEqual([true, true, true]);
    expect(root.catalog.generation(g2)!.state).toBe('retained');
    const names = root.store.read((db) => (db.prepare('SELECT display_name AS n FROM people').all() as { n: string }[]).map((r) => r.n)).data;
    expect(names).toContain('백업 후 추가 2');
    expect(names).not.toContain('복원 후 새 업무');
    expect(await reason(deleteGeneration(root, g3, '정리'))).toBe('VALIDATION:not_retained');
    expect(await reason(deleteGeneration(root, g2, '정리'))).toBe('RULE_VIOLATION:protected_generation');
    const removed = await deleteGeneration(root, g1, '오래된 세대 정리');
    expect(removed.bytes).toBeGreaterThan(0);
    expect(root.catalog.generation(g1)!.state).toBe('deleted');
    expect(existsSync(root.catalog.generationDir(g1))).toBe(false);
    expect(root.catalog.journalEntries().find((j) => j.kind === 'cleanup')).toMatchObject({ generationId: g1, detail: { reason: '오래된 세대 정리' } });
  });
});

describe('AC-38 new-PC restore fidelity', () => {
  it('restores identical data and attachments, with exactly one restore event, a new epoch and an incremented revision', async () => {
    const srcDir = fresh();
    const src = open(srcDir);
    const seeded = await seedLedger(src);
    const expected = dumpTables(src.store.db);
    const sourceEpoch = src.store.epoch;
    const sourceRevision = src.store.revision;
    const bundle = await backupOf(src);
    close(src);
    rmSync(srcDir, { recursive: true, force: true });
    const pc = open(fresh());
    await restore(pc, bundle);
    expect(dumpTables(pc.store.db, { excludeRestoreEvents: true })).toEqual(
      Object.fromEntries(Object.entries(expected).map(([t, rows]) => [t, t === 'audit_events' ? (rows as Record<string, unknown>[]).map(({ seq: _s, ...r }) => r) : rows])),
    );
    const restoreEvents = pc.store.read((db) => db.prepare("SELECT revision, after_json AS a FROM audit_events WHERE event_type = 'dataset.restored'").all()).data as { revision: number; a: string }[];
    expect(restoreEvents).toHaveLength(1);
    expect(restoreEvents[0]!.revision).toBe(sourceRevision + 1);
    expect(pc.store.revision).toBe(sourceRevision + 1);
    expect(pc.store.epoch).not.toBe(sourceEpoch);
    for (const h of seeded.hashes) {
      expect(existsSync(blobPath(pc.dir, h))).toBe(true);
      expect((await readBlob(pc.dir, h)).byteLength).toBeGreaterThan(0);
    }
    // Repeating the same restore adds its own single event; never duplicates within one job.
    expect(pc.catalog.journalEntries().filter((j) => j.kind === 'restore' && j.step === 'done')).toHaveLength(1);
    expect(existsSync(path.join(pc.catalog.generationDir(pc.catalog.active()!.generationId), 'imported-journal.json'))).toBe(true);
  });
});
