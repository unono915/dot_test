import { createHash } from 'node:crypto';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import yazl from 'yazl';
import type { BackupManifest } from '../../../src/main/data/backup';
import { inspectZip } from '../../../src/main/data/import/zip-guard';
import { openDatabase, type Db } from '../../../src/main/data/sqlite';

// Builds hostile/variant backup bundles from a real one for restore rejection tests.

export interface Parts {
  manifest: BackupManifest;
  files: Map<string, Buffer>;
}

export async function unpack(bundle: string): Promise<Parts> {
  const { kept } = await inspectZip(bundle, { maxEntries: 1000, maxTotalUncompressed: 500 * 1024 * 1024 }, { keep: () => true });
  const manifest = JSON.parse(kept.get('manifest.json')!.toString('utf8')) as BackupManifest;
  kept.delete('manifest.json');
  return { manifest, files: kept };
}

export function zip(entries: [string, Buffer][]): Promise<Buffer> {
  return new Promise((resolve) => {
    const z = new yazl.ZipFile();
    for (const [name, data] of entries) z.addBuffer(data, name);
    z.end();
    const chunks: Buffer[] = [];
    z.outputStream.on('data', (c: Buffer) => chunks.push(c));
    z.outputStream.on('end', () => resolve(Buffer.concat(chunks)));
  });
}

/** Repacks with a recomputed manifest so hashes are valid (to reach deeper checks). */
export async function repack(parts: Parts, opts: { rehash?: boolean } = { rehash: true }): Promise<Buffer> {
  const manifest = structuredClone(parts.manifest);
  if (opts.rehash !== false) {
    manifest.files = [...parts.files.entries()].map(([p, data]) => ({ path: p, size: data.byteLength, sha256: createHash('sha256').update(data).digest('hex') }));
  }
  return zip([['manifest.json', Buffer.from(JSON.stringify(manifest))], ...parts.files.entries()]);
}

/** Applies SQL to the bundled dataset (as an attacker or a buggy tool could). */
export function mutateDataset(parts: Parts, work: string, fn: (db: Db) => void): void {
  mkdirSync(work, { recursive: true });
  const file = path.join(work, `mut-${Date.now()}-${Math.random()}.sqlite`);
  writeFileSync(file, parts.files.get('dataset.sqlite')!);
  const db = openDatabase(file);
  try {
    fn(db);
    db.pragma('wal_checkpoint(TRUNCATE)');
    db.pragma('journal_mode = DELETE');
  } finally {
    db.close();
  }
  parts.files.set('dataset.sqlite', readFileSync(file));
}

/** Rewrites an entry name in place inside zip bytes (same length), e.g. "xx/evil" -> "../evil". */
export function renameEntry(buf: Buffer, from: string, to: string): Buffer {
  if (from.length !== to.length) throw new Error('same length required');
  const a = Buffer.from(from);
  const b = Buffer.from(to);
  const out = Buffer.from(buf);
  let i = out.indexOf(a);
  while (i >= 0) {
    b.copy(out, i);
    i = out.indexOf(a, i + 1);
  }
  return out;
}
