import { createHash } from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import { putBlob } from './attachments.js';
import { BACKUP_FORMAT, BACKUP_LIMITS, defaultFreeSpace, type BackupManifest } from './backup.js';
import type { DataRoot } from './data-root.js';
import { readMeta } from './dataset.js';
import { checkDatasetInvariants, hasUserData } from './domain/invariants.js';
import { fail } from './errors.js';
import { newId } from './ids.js';
import { inspectZip } from './import/zip-guard.js';
import { APP_ID, SCHEMA_VERSION } from './schema.js';
import { openDatabase, type Db } from './sqlite.js';

// Restore never overwrites the current data. A new generation is staged and fully validated,
// one restore event is appended to it, then the catalog's active pointer is switched atomically
// with a brand-new epoch. Every step is journaled so a crash resolves to exactly one generation.

export interface RestoreOptions {
  actor: string;
  freeSpace?: (dir: string) => Promise<number>;
  /** Test-only crash/failure injection at named steps. */
  faults?: { hit(step: string): void };
  /** Test-only narrower limits (production uses BACKUP_LIMITS). */
  limits?: Partial<typeof BACKUP_LIMITS>;
}

export interface RestorePreview {
  manifest: BackupManifest;
  currentDatasetId: string;
  currentRevision: number;
  currentHasData: boolean;
  sameDataset: boolean;
  /** Changes recorded after the backup's revision that the restore would remove from the active data. */
  lostChanges: { count: number; recent: { recordedAt: string; eventType: string; entityType: string }[] };
}

const isDomain = (e: unknown) => e instanceof Error && e.name === 'DomainError';

function counts(db: Db) {
  const n = (t: string) => (db.prepare(`SELECT COUNT(*) AS n FROM ${t}`).get() as { n: number }).n;
  return { assets: n('assets'), people: n('people'), auditEvents: n('audit_events'), attachments: n('attachments') };
}

/** Streams the bundle: checks structure, manifest, sizes and hashes; extracts what is asked for. */
async function readBundle(bundle: string, extract: { datasetTo?: string; blobsDir?: string }, limitsOverride: Partial<typeof BACKUP_LIMITS> = {}) {
  const limits = { ...BACKUP_LIMITS, ...limitsOverride };
  const st = await fs.stat(bundle).catch(() => fail('NOT_FOUND', '백업 파일을 찾을 수 없습니다.'));
  if (!st.isFile()) fail('VALIDATION', '백업 파일이 아닙니다.', { reason: 'not_file' });
  if (st.size > limits.maxBundleBytes) fail('LIMIT_EXCEEDED', '백업 파일이 15GB를 넘습니다.', { reason: 'bundle_size' });
  const { entries, kept } = await inspectZip(bundle, { maxEntries: limits.maxEntries, maxTotalUncompressed: limits.maxUncompressed }, {
    keep: (n) => n === 'manifest.json' || n === 'journal.json',
    extractTo: (n) => {
      if (n === 'dataset.sqlite' && extract.datasetTo) return extract.datasetTo;
      if (extract.blobsDir && /^blobs\/[0-9a-f]{64}$/.test(n)) return path.join(extract.blobsDir, n.slice(6));
      return null;
    },
  });
  let manifest: BackupManifest;
  try {
    manifest = JSON.parse(kept.get('manifest.json')?.toString('utf8') ?? '') as BackupManifest;
  } catch {
    return fail('VALIDATION', '이 프로그램의 백업 파일이 아닙니다(목록 정보 없음).', { reason: 'no_manifest' });
  }
  if (manifest.appId !== APP_ID || manifest.format !== BACKUP_FORMAT) fail('VALIDATION', '다른 프로그램의 백업이거나 지원하지 않는 형식입니다.', { reason: 'other_app' });
  if (manifest.schemaVersion !== SCHEMA_VERSION) fail('VALIDATION', '이 버전에서 복원할 수 없는 백업 형식입니다(데이터 구조 버전 불일치).', { reason: 'incompatible_schema' });
  if (!Array.isArray(manifest.files) || typeof manifest.datasetId !== 'string' || !Number.isInteger(manifest.revision)) fail('VALIDATION', '백업 목록 정보가 올바르지 않습니다.', { reason: 'bad_manifest' });
  const got = new Map(entries.map((e) => [e.name, e]));
  const allowed = new Set(['manifest.json', ...manifest.files.map((f) => f.path)]);
  for (const e of entries) if (!allowed.has(e.name)) fail('VALIDATION', '백업에 목록에 없는 항목이 있습니다.', { reason: 'unexpected_entry' });
  for (const f of manifest.files) {
    const e = got.get(f.path);
    if (!e) fail('VALIDATION', '백업에 필요한 파일이 빠져 있습니다.', { reason: 'missing_file', path: f.path });
    if (e!.size !== f.size || e!.sha256 !== f.sha256) fail('VALIDATION', '백업 파일이 손상되었습니다(해시 불일치).', { reason: 'hash_mismatch', path: f.path });
    if (f.path.startsWith('blobs/') && f.path.slice(6) !== f.sha256) fail('VALIDATION', '첨부 파일 이름과 해시가 다릅니다.', { reason: 'hash_mismatch', path: f.path });
  }
  if (!got.has('dataset.sqlite')) fail('VALIDATION', '백업에 데이터 파일이 없습니다.', { reason: 'missing_file' });
  return { manifest, journal: kept.get('journal.json') ?? Buffer.from('[]') };
}

/** Checks a staged dataset file against its manifest, the schema and all business invariants. */
function validateStaged(file: string, manifest: BackupManifest, blobHashes: Set<string>) {
  let db: Db;
  try {
    db = openDatabase(file, { readonly: true, fileMustExist: true });
  } catch {
    return fail('VALIDATION', '백업의 데이터 파일을 열 수 없습니다.', { reason: 'sqlite_open' });
  }
  try {
    let meta: Record<string, string>;
    try {
      meta = readMeta(db);
    } catch {
      return fail('VALIDATION', '백업의 데이터 파일 형식이 올바르지 않습니다.', { reason: 'sqlite_meta' });
    }
    if (meta.app_id !== APP_ID || Number(meta.schema_version) !== SCHEMA_VERSION) fail('VALIDATION', '다른 프로그램 또는 다른 버전의 데이터입니다.', { reason: 'other_app' });
    if (meta.dataset_id !== manifest.datasetId || Number(meta.revision) !== manifest.revision) fail('VALIDATION', '백업 목록과 데이터 파일이 서로 다릅니다.', { reason: 'manifest_mismatch' });
    const problems = checkDatasetInvariants(db);
    if (problems.length) fail('VALIDATION', `백업 자료가 업무 규칙에 맞지 않아 복원할 수 없습니다: ${problems.map((p) => p.message).join(' / ')}`, { reason: 'invariants', problems: problems.map((p) => p.code) });
    const needed = (db.prepare('SELECT DISTINCT sha256 FROM attachments').all() as { sha256: string }[]).map((r) => r.sha256);
    const missing = needed.filter((h) => !blobHashes.has(h));
    if (missing.length) fail('VALIDATION', '백업에 첨부 파일이 빠져 있습니다.', { reason: 'missing_attachment', count: missing.length });
    return { meta, counts: counts(db) };
  } finally {
    db.close();
  }
}

function lostChanges(current: Db, sameDataset: boolean, backupRevision: number): RestorePreview['lostChanges'] {
  const floor = sameDataset ? backupRevision : -1;
  const count = (current.prepare('SELECT COUNT(*) AS n FROM audit_events WHERE revision > ?').get(floor) as { n: number }).n;
  const recent = current
    .prepare('SELECT recorded_at AS recordedAt, event_type AS eventType, entity_type AS entityType FROM audit_events WHERE revision > ? ORDER BY seq DESC LIMIT 20')
    .all(floor) as RestorePreview['lostChanges']['recent'];
  return { count, recent };
}

function assertCompatible(root: DataRoot, manifest: BackupManifest) {
  const currentHasData = hasUserData(root.store.db);
  const sameDataset = manifest.datasetId === root.store.datasetId;
  if (currentHasData && !sameDataset) {
    fail('VALIDATION', '현재 자료와 다른 데이터셋의 백업입니다. 비어 있는 새 PC에서만 다른 데이터셋을 복원할 수 있습니다.', { reason: 'different_dataset' });
  }
  return { currentHasData, sameDataset };
}

/** Full validation without changing anything: what would be restored and what would be lost. */
export async function previewRestore(root: DataRoot, bundle: string, opts: Pick<RestoreOptions, 'limits'> = {}): Promise<RestorePreview> {
  const work = path.join(root.dir, 'tmp', `restore-check-${newId()}`);
  await fs.mkdir(path.join(work, 'blobs'), { recursive: true });
  try {
    const { manifest } = await readBundle(bundle, { datasetTo: path.join(work, 'dataset.sqlite') }, opts.limits);
    const blobHashes = new Set(manifest.files.filter((f) => f.path.startsWith('blobs/')).map((f) => f.sha256));
    validateStaged(path.join(work, 'dataset.sqlite'), manifest, blobHashes);
    const { currentHasData, sameDataset } = assertCompatible(root, manifest);
    return {
      manifest, currentDatasetId: root.store.datasetId, currentRevision: root.store.revision, currentHasData, sameDataset,
      lostChanges: currentHasData ? lostChanges(root.store.db, sameDataset, manifest.revision) : { count: 0, recent: [] },
    };
  } finally {
    await fs.rm(work, { recursive: true, force: true });
  }
}

/** Appends exactly one restore/rollback event (keyed by the job id) and bumps the revision. */
function appendSwitchEvent(file: string, jobId: string, actor: string, now: string, eventType: string, after: Record<string, unknown>) {
  const db = openDatabase(file, { fileMustExist: true });
  try {
    db.transaction(() => {
      if (db.prepare('SELECT 1 FROM command_receipts WHERE command_id = ?').get(jobId)) return;
      const revision = Number(readMeta(db).revision) + 1;
      const meta = readMeta(db);
      db.prepare(
        `INSERT INTO audit_events (event_id, revision, command_id, correlation_id, actor, recorded_at, occurred_at, event_type, entity_type, entity_id, before_json, after_json, reason, corrects_event_id)
         VALUES (?, ?, ?, ?, ?, ?, NULL, ?, 'dataset', ?, NULL, ?, NULL, NULL)`,
      ).run(newId(), revision, jobId, jobId, actor, now, eventType, meta.dataset_id, JSON.stringify(after));
      db.prepare('INSERT INTO command_receipts VALUES (?, ?, ?, ?, ?, ?, ?)').run(jobId, createHash('sha256').update(jobId).digest('hex'), eventType, JSON.stringify(after), revision, actor, now);
      db.prepare("UPDATE dataset_meta SET value = ? WHERE key = 'revision'").run(String(revision));
    }).immediate();
    db.pragma('wal_checkpoint(TRUNCATE)');
  } finally {
    db.close();
  }
}

async function switchTo(root: DataRoot, jobId: string, kind: string, genId: string, faults?: RestoreOptions['faults']) {
  const previous = root.catalog.active()!.generationId;
  root.catalog.setState(genId, 'ready');
  root.catalog.journal({ jobId, kind, step: 'ready', status: 'running', generationId: genId, detail: { previous } });
  faults?.hit('before-switch');
  const pointer = root.catalog.activate(genId);
  root.catalog.journal({ jobId, kind, step: 'switched', status: 'running', generationId: genId, detail: { previous, epoch: pointer.epoch } });
  faults?.hit('after-switch');
  try {
    faults?.hit('open-new');
    root.reopenActive();
    const problems = checkDatasetInvariants(root.store.db);
    if (problems.length) throw new Error('invariants');
  } catch (error) {
    revertTo(root, jobId, kind, previous, 'open_failed');
    throw isDomain(error) ? error : fail('INTEGRITY', '새 자료를 열지 못해 이전 자료로 되돌렸습니다.', { reason: 'open_failed' });
  }
  root.catalog.journal({ jobId, kind, step: 'done', status: 'done', generationId: genId, detail: { previous, epoch: root.store.epoch, revision: root.store.revision } });
  return { generationId: genId, epoch: root.store.epoch, revision: root.store.revision, previousGenerationId: previous };
}

/** Automatic recovery to the previous safe generation (always with a new epoch). Not a user rollback. */
function revertTo(root: DataRoot, jobId: string, kind: string, previous: string, reason: string) {
  const failed = root.catalog.active()?.generationId ?? null;
  root.catalog.activate(previous);
  if (failed && failed !== previous) root.catalog.setState(failed, 'discarded');
  root.reopenActive();
  root.catalog.journal({ jobId, kind, step: 'reverted', status: 'failed', generationId: previous, detail: { reason, failedGeneration: failed } });
}

export async function restoreBackup(root: DataRoot, bundle: string, expected: { datasetId: string; revision: number }, opts: RestoreOptions) {
  const jobId = newId();
  const release = root.store.beginMaintenance('restore');
  const work = path.join(root.dir, 'tmp', `restore-${jobId}`);
  let genId: string | null = null;
  root.catalog.journal({ jobId, kind: 'restore', step: 'started', status: 'running', detail: { source: path.basename(bundle) } });
  try {
    const st = await fs.stat(bundle).catch(() => fail('NOT_FOUND', '백업 파일을 찾을 수 없습니다.'));
    const free = await (opts.freeSpace ?? defaultFreeSpace)(root.dir);
    if (free < st.size * 3) fail('LIMIT_EXCEEDED', '데이터 폴더의 여유 공간이 부족해 복원을 시작하지 않았습니다.', { reason: 'disk_space', needed: st.size * 3, free });
    await fs.mkdir(path.join(work, 'blobs'), { recursive: true });
    const copy = path.join(work, 'bundle.zip');
    await fs.copyFile(bundle, copy);
    const gen = root.catalog.createGeneration({ datasetId: expected.datasetId, source: 'restore', detail: { bundle: path.basename(bundle), jobId } });
    genId = gen.id;
    const datasetFile = root.catalog.datasetFile(gen.id);
    const { manifest, journal } = await readBundle(copy, { datasetTo: datasetFile, blobsDir: path.join(work, 'blobs') }, opts.limits);
    if (manifest.datasetId !== expected.datasetId || manifest.revision !== expected.revision) {
      fail('VALIDATION', '확인한 백업과 파일 내용이 다릅니다. 다시 확인해 주세요.', { reason: 'changed_since_preview' });
    }
    const blobHashes = new Set(manifest.files.filter((f) => f.path.startsWith('blobs/')).map((f) => f.sha256));
    validateStaged(datasetFile, manifest, blobHashes);
    const { sameDataset } = assertCompatible(root, manifest);
    for (const h of blobHashes) await putBlob(root.dir, h, await fs.readFile(path.join(work, 'blobs', h)));
    await fs.writeFile(path.join(root.catalog.generationDir(gen.id), 'imported-journal.json'), journal, { flag: 'wx' });
    root.catalog.journal({ jobId, kind: 'restore', step: 'staged', status: 'running', generationId: gen.id, detail: { revision: manifest.revision } });
    opts.faults?.hit('staged');
    appendSwitchEvent(datasetFile, jobId, opts.actor, root.now(), 'dataset.restored', {
      source: path.basename(bundle), backupRevision: manifest.revision, backupCreatedAt: manifest.createdAt,
      previousDatasetId: root.store.datasetId, previousRevision: root.store.revision, sameDataset, jobId,
    });
    return await switchTo(root, jobId, 'restore', gen.id, opts.faults);
  } catch (error) {
    if (genId && root.catalog.generation(genId)?.state !== 'active' && root.catalog.active()?.generationId !== genId) {
      root.catalog.setState(genId, 'discarded');
      await fs.rm(root.catalog.generationDir(genId), { recursive: true, force: true });
    }
    if (!root.catalog.journalEntries(jobId).some((j) => j.step === 'reverted')) {
      root.catalog.journal({ jobId, kind: 'restore', step: 'failed', status: 'failed', generationId: genId, detail: { reason: isDomain(error) ? String((error as { details?: { reason?: string } }).details?.reason ?? 'validation') : 'error' } });
    }
    throw error;
  } finally {
    await fs.rm(work, { recursive: true, force: true });
    release();
  }
}

/** Manual rollback to a retained generation: itself a restore (current kept, new epoch). */
export async function rollbackToGeneration(root: DataRoot, sourceGenerationId: string, opts: RestoreOptions) {
  const source = root.catalog.generation(sourceGenerationId);
  if (!source || source.state !== 'retained') fail('VALIDATION', '되돌릴 수 있는 보존 세대가 아닙니다.', { reason: 'not_retained' });
  const jobId = newId();
  const release = root.store.beginMaintenance('rollback');
  root.catalog.journal({ jobId, kind: 'rollback', step: 'started', status: 'running', detail: { source: sourceGenerationId } });
  let genId: string | null = null;
  try {
    const src = openDatabase(root.catalog.datasetFile(sourceGenerationId), { readonly: true, fileMustExist: true });
    const gen = root.catalog.createGeneration({ datasetId: source!.datasetId, source: 'rollback', detail: { from: sourceGenerationId, jobId } });
    genId = gen.id;
    try {
      await src.backup(root.catalog.datasetFile(gen.id));
    } finally {
      src.close();
    }
    const staged = openDatabase(root.catalog.datasetFile(gen.id), { readonly: true, fileMustExist: true });
    try {
      const problems = checkDatasetInvariants(staged);
      if (problems.length) fail('VALIDATION', '보존 세대가 업무 규칙에 맞지 않습니다.', { reason: 'invariants' });
    } finally {
      staged.close();
    }
    root.catalog.journal({ jobId, kind: 'rollback', step: 'staged', status: 'running', generationId: gen.id });
    appendSwitchEvent(root.catalog.datasetFile(gen.id), jobId, opts.actor, root.now(), 'dataset.rolledBack', {
      fromGeneration: sourceGenerationId, previousRevision: root.store.revision, jobId,
    });
    return await switchTo(root, jobId, 'rollback', gen.id, opts.faults);
  } catch (error) {
    if (genId && root.catalog.active()?.generationId !== genId) {
      root.catalog.setState(genId, 'discarded');
      await fs.rm(root.catalog.generationDir(genId), { recursive: true, force: true });
    }
    throw error;
  } finally {
    release();
  }
}

/** Generation housekeeping: never the active one, never the immediate rollback target. */
export async function deleteGeneration(root: DataRoot, generationId: string, reason: string) {
  const g = root.catalog.generation(generationId);
  const active = root.catalog.active()!;
  if (!g || g.state !== 'retained') fail('VALIDATION', '정리할 수 있는 보존 세대가 아닙니다.', { reason: 'not_retained' });
  if (generationId === active.generationId || generationId === active.previousGenerationId) {
    fail('RULE_VIOLATION', '사용 중인 세대와 바로 이전 세대는 삭제할 수 없습니다.', { rule: 'protected_generation' });
  }
  const dir = root.catalog.generationDir(generationId);
  let bytes = 0;
  for (const f of await fs.readdir(dir).catch(() => [] as string[])) bytes += (await fs.stat(path.join(dir, f))).size;
  root.catalog.journal({ jobId: newId(), kind: 'cleanup', step: 'delete-generation', status: 'done', generationId, detail: { reason, bytes } });
  root.catalog.setState(generationId, 'deleted');
  await fs.rm(dir, { recursive: true, force: true });
  return { generationId, bytes };
}

/** Read-only access to a retained generation for viewing or exporting its history. */
export function openGenerationReadonly(root: DataRoot, generationId: string): Db {
  const g = root.catalog.generation(generationId);
  if (!g || (g.state !== 'retained' && g.state !== 'active')) fail('NOT_FOUND', '열 수 있는 세대가 아닙니다.');
  return openDatabase(root.catalog.datasetFile(generationId), { readonly: true, fileMustExist: true });
}
