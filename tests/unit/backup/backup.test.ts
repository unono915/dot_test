import { existsSync, readdirSync } from 'node:fs';
import fs from 'node:fs/promises';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { blobPath } from '../../../src/main/data/attachments';
import { createBackup } from '../../../src/main/data/backup';
import { DomainError } from '../../../src/main/data/errors';
import { inspectZip } from '../../../src/main/data/import/zip-guard';
import { openDatabase } from '../../../src/main/data/sqlite';
import { tempDir } from '../data/support';
import { useDomain } from '../domain/support';
import { exec, seedLedger } from './support';

const ctx = useDomain();
let out: ReturnType<typeof tempDir>;
beforeEach(() => (out = tempDir('school-asset-backup-out-')));
afterEach(() => out.cleanup());

const opts = { appVersion: '0.1.0' };

async function failure(p: Promise<unknown>): Promise<string> {
  try {
    await p;
  } catch (e) {
    if (e instanceof DomainError) return `${e.code}:${String(e.details.reason ?? '')}`;
    return `Error:${(e as Error).message}`;
  }
  return 'OK';
}

describe('AC-32 consistent backup under a maintenance lock', () => {
  it('blocks writes while running and bundles DB, every referenced attachment and settings at one revision', async () => {
    const seeded = await seedLedger(ctx.root);
    const revision = ctx.root.store.revision;
    const target = path.join(out.dir, 'backup.sabackup');
    const running = createBackup(ctx.root, target, opts);
    expect(() => exec(ctx.root, 'person.create', { displayName: '백업 중 추가' })).toThrow(/관리 작업 중/);
    const { manifest } = await running;
    expect(manifest.revision).toBe(revision);
    expect(manifest.files.filter((f) => f.path.startsWith('blobs/')).map((f) => f.sha256).sort()).toEqual([...seeded.hashes].sort());
    // Writes are accepted again afterwards.
    exec(ctx.root, 'person.create', { displayName: '백업 후 추가' });
    const { entries } = await inspectZip(target, { maxEntries: 100, maxTotalUncompressed: 100 * 1024 * 1024 }, {
      extractTo: (n) => (n === 'dataset.sqlite' ? path.join(out.dir, 'check.sqlite') : null),
    });
    expect(entries.map((e) => e.name).sort()).toEqual(['blobs/' + [...seeded.hashes].sort()[0], 'blobs/' + [...seeded.hashes].sort()[1], 'dataset.sqlite', 'journal.json', 'manifest.json'].sort());
    const db = openDatabase(path.join(out.dir, 'check.sqlite'), { readonly: true, fileMustExist: true });
    try {
      expect((db.prepare("SELECT value FROM dataset_meta WHERE key = 'revision'").get() as { value: string }).value).toBe(String(revision));
      expect(db.prepare("SELECT value_json AS v FROM settings WHERE key = 'ledger.loanDefaultDays'").get()).toEqual({ v: '14' });
      expect((db.prepare("SELECT COUNT(*) AS n FROM people WHERE display_name LIKE '백업%'").get() as { n: number }).n).toBe(0);
    } finally {
      db.close();
    }
    expect(ctx.root.catalog.journalEntries().filter((j) => j.kind === 'backup').map((j) => j.step)).toEqual(['started', 'published']);
  });
});

describe('AC-33 failures keep the live data and publish nothing', () => {
  async function expectClean(target: string, revision: number) {
    expect(existsSync(target)).toBe(false);
    expect(readdirSync(out.dir)).toEqual([]);
    expect(ctx.root.store.revision).toBe(revision);
    expect(ctx.root.store.maintenance).toBeNull();
    exec(ctx.root, 'person.create', { displayName: '잠금 해제 확인' });
  }

  it('cancel', async () => {
    await seedLedger(ctx.root);
    const target = path.join(out.dir, 'cancel.sabackup');
    const rev = ctx.root.store.revision;
    let calls = 0;
    expect(await failure(createBackup(ctx.root, target, { ...opts, cancelled: () => ++calls > 3 }))).toBe('CANCELLED:');
    await expectClean(target, rev);
  });

  it('disk full', async () => {
    await seedLedger(ctx.root);
    const target = path.join(out.dir, 'full.sabackup');
    const rev = ctx.root.store.revision;
    expect(await failure(createBackup(ctx.root, target, { ...opts, freeSpace: async () => 1024 }))).toBe('LIMIT_EXCEEDED:disk_space');
    await expectClean(target, rev);
  });

  it('attachment hash failure', async () => {
    const { hashes } = await seedLedger(ctx.root);
    const p = blobPath(ctx.root.dir, hashes[0]!);
    await fs.chmod(p, 0o666);
    await fs.writeFile(p, Buffer.from('bit rot'));
    const target = path.join(out.dir, 'hash.sabackup');
    const rev = ctx.root.store.revision;
    expect(await failure(createBackup(ctx.root, target, opts))).toBe('INTEGRITY:');
    await expectClean(target, rev);
  });

  it('failure while writing or verifying the bundle', async () => {
    await seedLedger(ctx.root);
    for (const step of ['write', 'verify-bundle', 'publish']) {
      const target = path.join(out.dir, `${step}.sabackup`);
      const rev = ctx.root.store.revision;
      expect(await failure(createBackup(ctx.root, target, { ...opts, faults: { hit: (s) => { if (s === step) throw new Error(`injected ${s}`); } } }))).toBe(`Error:injected ${step}`);
      expect(existsSync(target)).toBe(false);
      expect(readdirSync(out.dir)).toEqual([]);
      expect(ctx.root.store.revision).toBe(rev);
      expect(ctx.root.store.maintenance).toBeNull();
    }
    expect(ctx.root.catalog.journalEntries().filter((j) => j.kind === 'backup' && j.step === 'failed')).toHaveLength(3);
  });
});
