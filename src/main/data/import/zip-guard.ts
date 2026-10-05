import { createHash } from 'node:crypto';
import { createWriteStream } from 'node:fs';
import yauzl from 'yauzl';
import { fail } from '../errors.js';

// Inspects a ZIP container before anything else trusts it. Sizes are verified by actually
// inflating each entry (not trusting header sizes), so a lying zip bomb is stopped at the limit.
// Every entry is hashed while streaming; selected entries can be kept in memory or written out.

export interface ZipLimits {
  maxEntries: number;
  maxTotalUncompressed: number;
  maxEntryUncompressed?: number;
}

export interface ZipEntryInfo {
  name: string;
  size: number;
  sha256: string;
}

export interface InspectOptions {
  /** Keep this entry's bytes in memory (small metadata parts only). */
  keep?: (name: string) => boolean;
  /** Write this entry to the returned path while streaming (exclusive create). */
  extractTo?: (name: string) => string | null;
}

const BAD_NAME = /(^|[\\/])\.\.([\\/]|$)|^[\\/]|^[a-zA-Z]:|\\|\0|[<>:"|?*\u0000-\u001f]/;
const WINDOWS_RESERVED = /(^|\/)(con|prn|aux|nul|com[0-9]|lpt[0-9])(\.[^/]*)?(\/|$)/i;

export function isSafeEntryName(name: string): boolean {
  if (name.length === 0 || name.length > 400 || BAD_NAME.test(name) || WINDOWS_RESERVED.test(name)) return false;
  return name.split('/').every((seg, i, all) => (seg === '' ? i === all.length - 1 : !/[. ]$/.test(seg)));
}

class LimitHit extends Error {}

export async function inspectZip(
  source: Buffer | string,
  limits: ZipLimits,
  optsOrKeep: InspectOptions | ((name: string) => boolean) = {},
): Promise<{ entries: ZipEntryInfo[]; kept: Map<string, Buffer> }> {
  const opts: InspectOptions = typeof optsOrKeep === 'function' ? { keep: optsOrKeep } : optsOrKeep;
  const options = { lazyEntries: true, validateEntrySizes: true, strictFileNames: true, autoClose: true };
  const zip = await new Promise<yauzl.ZipFile>((resolve, reject) => {
    const cb = (err: Error | null, z?: yauzl.ZipFile) => (err || !z ? reject(err ?? new Error('zip')) : resolve(z));
    if (typeof source === 'string') yauzl.open(source, options, cb);
    else yauzl.fromBuffer(source, options, cb);
  }).catch(() => fail('VALIDATION', '파일 형식이 올바르지 않습니다(손상되었거나 ZIP 기반 파일이 아님).', { reason: 'not_zip' }));

  const entries: ZipEntryInfo[] = [];
  const kept = new Map<string, Buffer>();
  let total = 0;
  const seen = new Set<string>();

  await new Promise<void>((resolve, reject) => {
    let done = false;
    const abort = (error: unknown) => {
      if (done) return;
      done = true;
      zip.close();
      reject(error);
    };
    zip.on('error', abort);
    zip.on('end', () => {
      if (!done) {
        done = true;
        resolve();
      }
    });
    zip.on('entry', (entry: yauzl.Entry) => {
      const name = entry.fileName;
      try {
        if (entries.length >= limits.maxEntries) fail('LIMIT_EXCEEDED', '압축 항목 수가 한도를 넘었습니다.', { reason: 'entries', limit: limits.maxEntries });
        if (!isSafeEntryName(name)) fail('VALIDATION', '허용되지 않는 경로나 이름이 들어 있습니다.', { reason: 'unsafe_path' });
        const folded = name.toLowerCase();
        if (seen.has(folded)) fail('VALIDATION', '이름이 겹치는 항목이 있습니다(대소문자 포함).', { reason: 'duplicate_entry' });
        seen.add(folded);
        const type = (entry.externalFileAttributes >>> 16) & 0o170000;
        if (type === 0o120000) fail('VALIDATION', '링크 항목은 허용되지 않습니다.', { reason: 'symlink' });
        if (type !== 0 && type !== 0o100000 && type !== 0o040000) fail('VALIDATION', '장치 파일 등 특수 항목은 허용되지 않습니다.', { reason: 'special_file' });
        if (name.endsWith('/')) {
          entries.push({ name, size: 0, sha256: '' });
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
        const hash = createHash('sha256');
        const chunks: Buffer[] = [];
        const wanted = opts.keep?.(name) ?? false;
        const target = opts.extractTo?.(name) ?? null;
        const out = target ? createWriteStream(target, { flags: 'wx' }) : null;
        out?.on('error', abort);
        stream.on('data', (chunk: Buffer) => {
          size += chunk.length;
          total += chunk.length;
          if (total > limits.maxTotalUncompressed || (limits.maxEntryUncompressed !== undefined && size > limits.maxEntryUncompressed)) {
            stream.destroy();
            out?.destroy();
            abort(new LimitHit());
            return;
          }
          hash.update(chunk);
          if (wanted) chunks.push(chunk);
          if (out && !out.write(chunk)) {
            stream.pause();
            out.once('drain', () => stream.resume());
          }
        });
        stream.on('error', abort);
        stream.on('end', () => {
          const finish = () => {
            entries.push({ name, size, sha256: hash.digest('hex') });
            if (wanted) kept.set(name, Buffer.concat(chunks));
            zip.readEntry();
          };
          if (out) out.end(finish);
          else finish();
        });
      });
    });
    zip.readEntry();
  }).catch((error: unknown) => {
    if (error instanceof LimitHit) fail('LIMIT_EXCEEDED', '압축 해제 크기가 한도를 넘었습니다.', { reason: 'uncompressed_size', limit: limits.maxTotalUncompressed });
    if (error instanceof Error && error.name === 'DomainError') throw error;
    // yauzl itself refuses some unsafe names before our own check sees them.
    if (error instanceof Error && /relative path|absolute path|invalid characters/i.test(error.message)) {
      fail('VALIDATION', '허용되지 않는 경로나 이름이 들어 있습니다.', { reason: 'unsafe_path' });
    }
    fail('VALIDATION', '파일이 손상되었습니다.', { reason: 'corrupt_zip' });
  });
  return { entries, kept };
}
