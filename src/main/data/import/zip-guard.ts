import yauzl from 'yauzl';
import { fail } from '../errors.js';

// Inspects a ZIP container before any library parses it. Sizes are verified by actually
// inflating each entry (not trusting header sizes), so a lying zip bomb is stopped at the limit.

export interface ZipLimits {
  maxEntries: number;
  maxTotalUncompressed: number;
  maxEntryUncompressed?: number;
}

export interface ZipEntryInfo {
  name: string;
  size: number;
}

const BAD_NAME = /(^|[\\/])\.\.([\\/]|$)|^[\\/]|^[a-zA-Z]:|\\|\0/;

export function isSafeEntryName(name: string): boolean {
  return name.length > 0 && name.length <= 400 && !BAD_NAME.test(name);
}

/**
 * Reads every entry, enforcing limits on the real inflated byte counts. Calls `onEntry` with the
 * inflated data of entries the caller wants to keep (`keep` returns true), others are discarded.
 */
export async function inspectZip(
  buffer: Buffer,
  limits: ZipLimits,
  keep: (name: string) => boolean = () => false,
): Promise<{ entries: ZipEntryInfo[]; kept: Map<string, Buffer> }> {
  const zip = await new Promise<yauzl.ZipFile>((resolve, reject) =>
    yauzl.fromBuffer(buffer, { lazyEntries: true, validateEntrySizes: true, strictFileNames: true }, (err, z) => (err || !z ? reject(err ?? new Error('zip')) : resolve(z))),
  ).catch(() => fail('VALIDATION', '파일 형식이 올바르지 않습니다(손상되었거나 ZIP 기반 파일이 아님).', { reason: 'not_zip' }));

  const entries: ZipEntryInfo[] = [];
  const kept = new Map<string, Buffer>();
  let total = 0;
  const seen = new Set<string>();

  await new Promise<void>((resolve, reject) => {
    const abort = (error: unknown) => {
      zip.close();
      reject(error);
    };
    zip.on('error', abort);
    zip.on('end', () => resolve());
    zip.on('entry', (entry: yauzl.Entry) => {
      try {
        if (entries.length >= limits.maxEntries) fail('LIMIT_EXCEEDED', '압축 항목 수가 한도를 넘었습니다.', { reason: 'entries', limit: limits.maxEntries });
        const name = entry.fileName;
        if (!isSafeEntryName(name)) fail('VALIDATION', '허용되지 않는 경로가 들어 있습니다.', { reason: 'unsafe_path' });
        const folded = name.toLowerCase();
        if (seen.has(folded)) fail('VALIDATION', '이름이 겹치는 항목이 있습니다.', { reason: 'duplicate_entry' });
        seen.add(folded);
        const mode = (entry.externalFileAttributes >>> 16) & 0o170000;
        if (mode === 0o120000) fail('VALIDATION', '링크 항목은 허용되지 않습니다.', { reason: 'symlink' });
        if (/\/$/.test(name)) {
          entries.push({ name, size: 0 });
          zip.readEntry();
          return;
        }
      } catch (error) {
        abort(error);
        return;
      }
      zip.openReadStream(entry, (err, stream) => {
        if (err || !stream) return abort(new Error('unreadable'));
        let size = 0;
        const chunks: Buffer[] = [];
        const wanted = keep(entry.fileName);
        stream.on('data', (chunk: Buffer) => {
          size += chunk.length;
          total += chunk.length;
          if (total > limits.maxTotalUncompressed || (limits.maxEntryUncompressed && size > limits.maxEntryUncompressed)) {
            stream.destroy();
            abort(new DomainLimit());
            return;
          }
          if (wanted) chunks.push(chunk);
        });
        stream.on('error', (e) => abort(e));
        stream.on('end', () => {
          entries.push({ name: entry.fileName, size });
          if (wanted) kept.set(entry.fileName, Buffer.concat(chunks));
          zip.readEntry();
        });
      });
    });
    zip.readEntry();
  }).catch((error: unknown) => {
    if (error instanceof DomainLimit) fail('LIMIT_EXCEEDED', '압축 해제 크기가 한도를 넘었습니다.', { reason: 'uncompressed_size', limit: limits.maxTotalUncompressed });
    if (error instanceof Error && error.name === 'DomainError') throw error;
    fail('VALIDATION', '파일이 손상되었습니다.', { reason: 'corrupt_zip' });
  });
  return { entries, kept };
}

class DomainLimit extends Error {}
