import { createHash, randomBytes } from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import { fail } from './errors.js';
import { ATTACHMENT_LIMITS, referencedHashes } from './domain/attachments.js';
import { readXlsx } from './import/xlsx-read.js';
import { openDatabase } from './sqlite.js';
import type { Catalog } from './catalog.js';

// Content-addressed, immutable blob store shared by all generations of a data root:
//   <root>/blobs/<first two hex>/<sha256>
// Bytes are verified (magic numbers, extension, size) before they are stored, and stored
// before any record points at them, so a valid reference always names an existing file.

export const BLOBS_DIR = 'blobs';
const STAGING = '.staging';

export type AttachmentExt = 'pdf' | 'png' | 'jpg' | 'xlsx';

export interface StagedBlob {
  sha256: string;
  size: number;
  ext: AttachmentExt;
  displayName: string;
}

export const blobPath = (root: string, sha256: string) => path.join(root, BLOBS_DIR, sha256.slice(0, 2), sha256);

const EXT_OF: Record<string, AttachmentExt> = { '.pdf': 'pdf', '.png': 'png', '.jpg': 'jpg', '.jpeg': 'jpg', '.xlsx': 'xlsx' };

/** Detects the real type from content; returns null for anything not allowed. */
export async function sniffType(bytes: Buffer): Promise<AttachmentExt | null> {
  if (bytes.subarray(0, 5).toString('latin1') === '%PDF-') return 'pdf';
  if (bytes.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) return 'png';
  if (bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) return 'jpg';
  if (bytes[0] === 0x50 && bytes[1] === 0x4b) {
    try {
      await readXlsx(bytes);
      return 'xlsx';
    } catch {
      return null;
    }
  }
  return null;
}

/** Reads a user-chosen file, verifies it, and stores it immutably. Does not touch any dataset. */
export async function stageAttachment(root: string, sourcePath: string): Promise<StagedBlob> {
  const st = await fs.lstat(sourcePath).catch(() => fail('NOT_FOUND', '파일을 찾을 수 없습니다.'));
  if (st.isSymbolicLink() || !st.isFile()) fail('VALIDATION', '일반 파일만 첨부할 수 있습니다(바로가기·링크·폴더 불가).', { reason: 'not_regular_file' });
  if (st.size === 0) fail('VALIDATION', '빈 파일입니다.', { reason: 'empty' });
  if (st.size > ATTACHMENT_LIMITS.maxFileBytes) fail('LIMIT_EXCEEDED', '첨부 파일은 25MB까지입니다.', { reason: 'file_size' });
  const declared = EXT_OF[path.extname(sourcePath).toLowerCase()];
  if (!declared) fail('VALIDATION', 'PDF·JPEG·PNG·엑셀(.xlsx)만 첨부할 수 있습니다.', { reason: 'extension' });
  const bytes = await fs.readFile(sourcePath);
  if (bytes.byteLength !== st.size) fail('VALIDATION', '파일을 읽는 중 내용이 바뀌었습니다. 다시 시도해 주세요.', { reason: 'changed' });
  const actual = await sniffType(bytes);
  if (actual !== declared) fail('VALIDATION', '파일 내용이 확장자와 다르거나 허용되지 않는 형식입니다.', { reason: 'content_type' });
  const sha256 = createHash('sha256').update(bytes).digest('hex');
  await putBlob(root, sha256, bytes);
  return { sha256, size: bytes.byteLength, ext: actual!, displayName: path.basename(sourcePath).slice(0, 200) };
}

/** Writes bytes under their hash if absent (staging file + rename), read-only afterwards. */
export async function putBlob(root: string, sha256: string, bytes: Buffer): Promise<void> {
  const final = blobPath(root, sha256);
  if (await fs.stat(final).then((s) => s.size === bytes.byteLength, () => false)) return;
  const staging = path.join(root, BLOBS_DIR, STAGING);
  await fs.mkdir(staging, { recursive: true });
  await fs.mkdir(path.dirname(final), { recursive: true });
  const tmp = path.join(staging, `${sha256}.${randomBytes(4).toString('hex')}`);
  await fs.writeFile(tmp, bytes, { flag: 'wx' });
  const h = await fs.open(tmp, 'r+');
  await h.sync();
  await h.close();
  await fs.chmod(tmp, 0o444);
  await fs.rename(tmp, final).catch(async (error: unknown) => {
    await fs.rm(tmp, { force: true });
    if (!(await fs.stat(final).then(() => true, () => false))) throw error;
  });
}

export async function readBlob(root: string, sha256: string): Promise<Buffer> {
  const bytes = await fs.readFile(blobPath(root, sha256)).catch(() => fail('INTEGRITY', '첨부 파일이 없습니다. 백업에서 복원해 주세요.', { sha256 }));
  if (createHash('sha256').update(bytes).digest('hex') !== sha256) fail('INTEGRITY', '첨부 파일이 손상되었습니다.', { sha256 });
  return bytes;
}

/**
 * Removes interrupted staging files and blobs that no retained generation references.
 * Referenced blobs are never removed.
 */
export async function cleanupBlobs(root: string, catalog: Catalog, opts: { activeDb?: import('./sqlite.js').Db } = {}): Promise<{ removed: string[] }> {
  await fs.rm(path.join(root, BLOBS_DIR, STAGING), { recursive: true, force: true });
  const keep = new Set<string>();
  for (const g of catalog.generations()) {
    if (g.state === 'deleted' || g.state === 'discarded') continue;
    if (opts.activeDb && catalog.active()?.generationId === g.id) {
      for (const h of referencedHashes(opts.activeDb)) keep.add(h);
      continue;
    }
    const file = catalog.datasetFile(g.id);
    if (!(await fs.stat(file).then(() => true, () => false))) continue;
    const db = openDatabase(file, { readonly: true, fileMustExist: true });
    try {
      for (const h of referencedHashes(db)) keep.add(h);
    } finally {
      db.close();
    }
  }
  const removed: string[] = [];
  const base = path.join(root, BLOBS_DIR);
  for (const dir of await fs.readdir(base).catch(() => [] as string[])) {
    if (!/^[0-9a-f]{2}$/.test(dir)) continue;
    for (const name of await fs.readdir(path.join(base, dir))) {
      if (!keep.has(name)) {
        const p = path.join(base, dir, name);
        await fs.chmod(p, 0o666).catch(() => undefined);
        await fs.rm(p, { force: true });
        removed.push(name);
      }
    }
  }
  return { removed };
}
