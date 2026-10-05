import { createHash, randomBytes } from 'node:crypto';
import { createReadStream, createWriteStream } from 'node:fs';
import fs from 'node:fs/promises';
import path from 'node:path';
import yazl from 'yazl';
import { blobPath, readBlob } from './attachments.js';
import type { DataRoot } from './data-root.js';
import { readMeta } from './dataset.js';
import { fail } from './errors.js';
import { newId } from './ids.js';
import { inspectZip } from './import/zip-guard.js';
import { APP_ID, SCHEMA_VERSION } from './schema.js';
import { openDatabase } from './sqlite.js';

// Consistent backup bundle: the dataset (SQLite Online Backup), every attachment the dataset
// references (including historical links), and the maintenance journal, all at one revision.
// Writes are blocked by a maintenance lock for the whole duration; the bundle is verified
// before it is published under its final name.

export const BACKUP_FORMAT = 'school-asset-backup/1';
export const BACKUP_LIMITS = { maxBundleBytes: 15 * 1024 ** 3, maxUncompressed: 15 * 1024 ** 3, maxEntries: 100_000 } as const;

export interface BackupManifest {
  format: string;
  appId: string;
  appVersion: string;
  schemaVersion: number;
  datasetId: string;
  revision: number;
  createdAt: string;
  counts: Record<string, number>;
  files: { path: string; size: number; sha256: string }[];
}

export interface BackupOptions {
  appVersion: string;
  cancelled?: () => boolean;
  onProgress?: (step: string, done: number, total: number) => void;
  /** Bytes free at the destination; defaults to fs.statfs. Injectable for tests. */
  freeSpace?: (dir: string) => Promise<number>;
  /** Test-only failure injection between steps. */
  faults?: { hit(step: string): void };
}

const sha256File = (file: string) =>
  new Promise<string>((resolve, reject) => {
    const h = createHash('sha256');
    createReadStream(file).on('data', (c) => h.update(c)).on('error', reject).on('end', () => resolve(h.digest('hex')));
  });

export async function defaultFreeSpace(dir: string): Promise<number> {
  const s = await fs.statfs(dir);
  return Number(s.bavail) * Number(s.bsize);
}

function countsOf(db: import('./sqlite.js').Db): Record<string, number> {
  const n = (t: string) => (db.prepare(`SELECT COUNT(*) AS n FROM ${t}`).get() as { n: number }).n;
  return {
    assets: n('assets'), people: n('people'), locations: n('locations'), networks: n('networks'), interfaces: n('interfaces'), addressSlots: n('address_slots'),
    observations: n('observations'), inventorySessions: n('inventory_sessions'), auditEvents: n('audit_events'), attachments: n('attachments'),
  };
}

export async function createBackup(root: DataRoot, destPath: string, opts: BackupOptions): Promise<{ path: string; manifest: BackupManifest; bytes: number }> {
  const jobId = newId();
  const release = root.store.beginMaintenance('backup');
  const work = path.join(root.dir, 'tmp', `backup-${jobId}`);
  const partial = `${destPath}.partial-${randomBytes(4).toString('hex')}`;
  const step = (name: string) => {
    if (opts.cancelled?.()) fail('CANCELLED', '백업을 취소했습니다. 운영 자료는 바뀌지 않았습니다.');
    opts.faults?.hit(name);
  };
  root.catalog.journal({ jobId, kind: 'backup', step: 'started', status: 'running', detail: { target: path.basename(destPath) } });
  try {
    await fs.mkdir(work, { recursive: true });
    step('snapshot');
    const snapshotFile = path.join(work, 'dataset.sqlite');
    await root.store.db.backup(snapshotFile);
    const snap = openDatabase(snapshotFile, { readonly: true, fileMustExist: true });
    let meta: Record<string, string>;
    let counts: Record<string, number>;
    let hashes: { sha256: string; size: number }[];
    try {
      meta = readMeta(snap);
      counts = countsOf(snap);
      hashes = snap.prepare('SELECT DISTINCT sha256, size FROM attachments ORDER BY sha256').all() as { sha256: string; size: number }[];
      if (snap.pragma('integrity_check', { simple: true }) !== 'ok') fail('INTEGRITY', '데이터 무결성 검사에 실패해 백업할 수 없습니다.');
    } finally {
      snap.close();
    }
    if (Number(meta.revision) !== root.store.revision) fail('INTEGRITY', '백업 중 데이터가 바뀌었습니다.');

    step('verify-attachments');
    for (const [i, h] of hashes.entries()) {
      await readBlob(root.dir, h.sha256);
      opts.onProgress?.('verify-attachments', i + 1, hashes.length);
    }
    const journal = root.catalog.journalEntries();
    const journalBuf = Buffer.from(JSON.stringify(journal));
    const dbSize = (await fs.stat(snapshotFile)).size;
    const estimate = dbSize + hashes.reduce((n, h) => n + h.size, 0) + journalBuf.byteLength + 1024 * 1024;
    if (estimate > BACKUP_LIMITS.maxBundleBytes) fail('LIMIT_EXCEEDED', '백업 크기가 15GB를 넘습니다.', { reason: 'bundle_size' });
    const free = await (opts.freeSpace ?? defaultFreeSpace)(path.dirname(destPath));
    if (free < estimate * 1.1) fail('LIMIT_EXCEEDED', '저장 위치의 여유 공간이 부족합니다.', { reason: 'disk_space', needed: estimate, free });

    step('manifest');
    const files: BackupManifest['files'] = [
      { path: 'dataset.sqlite', size: dbSize, sha256: await sha256File(snapshotFile) },
      { path: 'journal.json', size: journalBuf.byteLength, sha256: createHash('sha256').update(journalBuf).digest('hex') },
      ...hashes.map((h) => ({ path: `blobs/${h.sha256}`, size: h.size, sha256: h.sha256 })),
    ];
    const manifest: BackupManifest = {
      format: BACKUP_FORMAT, appId: APP_ID, appVersion: opts.appVersion, schemaVersion: SCHEMA_VERSION, datasetId: meta.dataset_id!,
      revision: Number(meta.revision), createdAt: root.now(), counts, files,
    };

    step('write');
    await new Promise<void>((resolve, reject) => {
      const zip = new yazl.ZipFile();
      zip.addBuffer(Buffer.from(JSON.stringify(manifest, null, 2)), 'manifest.json');
      zip.addFile(snapshotFile, 'dataset.sqlite');
      zip.addBuffer(journalBuf, 'journal.json');
      for (const h of hashes) zip.addFile(blobPath(root.dir, h.sha256), `blobs/${h.sha256}`, { compress: false });
      zip.end();
      const out = createWriteStream(partial, { flags: 'wx' });
      zip.outputStream.pipe(out).on('close', () => resolve()).on('error', reject);
      zip.outputStream.on('error', reject);
    });
    const h = await fs.open(partial, 'r+');
    await h.sync();
    await h.close();

    step('verify-bundle');
    await verifyBundleFile(partial, manifest);
    step('publish');
    await fs.rename(partial, destPath);
    const bytes = (await fs.stat(destPath)).size;
    root.catalog.journal({ jobId, kind: 'backup', step: 'published', status: 'done', detail: { target: path.basename(destPath), revision: manifest.revision, bytes } });
    return { path: destPath, manifest, bytes };
  } catch (error) {
    await fs.rm(partial, { force: true });
    root.catalog.journal({ jobId, kind: 'backup', step: 'failed', status: 'failed', detail: { reason: error instanceof Error ? error.name : 'unknown' } });
    throw error;
  } finally {
    await fs.rm(work, { recursive: true, force: true });
    release();
  }
}

/** Re-reads a written bundle from disk (streaming) and checks every manifest entry by size and hash. */
export async function verifyBundleFile(file: string, manifest: BackupManifest): Promise<void> {
  const { entries } = await inspectZip(file, { maxEntries: BACKUP_LIMITS.maxEntries, maxTotalUncompressed: BACKUP_LIMITS.maxUncompressed });
  const got = new Map(entries.map((e) => [e.name, e]));
  for (const f of manifest.files) {
    const e = got.get(f.path);
    if (!e || e.size !== f.size || e.sha256 !== f.sha256) fail('INTEGRITY', '백업 파일 검증에 실패했습니다.', { reason: 'hash_mismatch', path: f.path });
  }
  if (!got.has('manifest.json') || got.size !== manifest.files.length + 1) fail('INTEGRITY', '백업 파일 구성이 올바르지 않습니다.', { reason: 'entries' });
}
