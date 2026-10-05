import { existsSync, mkdirSync, statSync, symlinkSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { blobPath, cleanupBlobs, readBlob, stageAttachment } from '../../../src/main/data/attachments';
import { listAttachments } from '../../../src/main/data/domain/attachments';
import { listLocations } from '../../../src/main/data/domain/queries';
import { DomainError } from '../../../src/main/data/errors';
import { workbook } from '../import/fixtures';
import { codeOf, useDomain } from '../domain/support';

const ctx = useDomain();

const PNG = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.from('synthetic png body')]);
const PDF = Buffer.from('%PDF-1.4\n% synthetic\n%%EOF\n');
const JPG = Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe0]), Buffer.from('synthetic jpeg')]);

function file(name: string, bytes: Buffer | string): string {
  const dir = path.join(ctx.dir, 'incoming');
  mkdirSync(dir, { recursive: true });
  const p = path.join(dir, name);
  writeFileSync(p, bytes);
  return p;
}

async function reason(fn: () => Promise<unknown>): Promise<string> {
  try {
    await fn();
  } catch (e) {
    if (e instanceof DomainError) return `${e.code}:${String(e.details.reason ?? '')}`;
    throw e;
  }
  return 'OK';
}

function asset() {
  const loc = ctx.read((db) => listLocations(db))[0]!.id;
  return ctx.exec('asset.registerBatch', { locationId: loc, items: [{ kind: 'laptop' }] }).assetIds[0] as string;
}

describe('attachment intake', () => {
  it('accepts verified PDF, PNG, JPEG and xlsx by content', async () => {
    const xlsx = await workbook({ 시트: [['a'], ['b']] });
    for (const [name, bytes, ext] of [['견적서.pdf', PDF, 'pdf'], ['사진.png', PNG, 'png'], ['사진.jpeg', JPG, 'jpg'], ['목록.xlsx', xlsx, 'xlsx']] as const) {
      const staged = await stageAttachment(ctx.dir, file(name, bytes));
      expect(staged.ext).toBe(ext);
      expect(existsSync(blobPath(ctx.dir, staged.sha256))).toBe(true);
    }
  });

  it('rejects executables, scripts, HTML/SVG, disguised content, links, folders and oversize files', async () => {
    expect(await reason(() => stageAttachment(ctx.dir, file('setup.exe', Buffer.from('MZ\x90\x00synthetic'))))).toBe('VALIDATION:extension');
    expect(await reason(() => stageAttachment(ctx.dir, file('run.js', 'alert(1)')))).toBe('VALIDATION:extension');
    expect(await reason(() => stageAttachment(ctx.dir, file('page.html', '<script>x</script>')))).toBe('VALIDATION:extension');
    expect(await reason(() => stageAttachment(ctx.dir, file('logo.svg', '<svg onload="x"/>')))).toBe('VALIDATION:extension');
    expect(await reason(() => stageAttachment(ctx.dir, file('fake.pdf', Buffer.from('MZ not a pdf'))))).toBe('VALIDATION:content_type');
    expect(await reason(() => stageAttachment(ctx.dir, file('png-as.pdf', PNG)))).toBe('VALIDATION:content_type');
    expect(await reason(() => stageAttachment(ctx.dir, file('macro.xlsx', Buffer.from('PK\x03\x04 broken'))))).toBe('VALIDATION:content_type');
    expect(await reason(() => stageAttachment(ctx.dir, file('big.pdf', Buffer.concat([PDF, Buffer.alloc(25 * 1024 * 1024)]))))).toBe('LIMIT_EXCEEDED:file_size');
    const folder = path.join(ctx.dir, 'incoming', 'folder.pdf');
    mkdirSync(folder);
    expect(await reason(() => stageAttachment(ctx.dir, folder))).toBe('VALIDATION:not_regular_file');
    const link = path.join(ctx.dir, 'incoming', 'link.pdf');
    try {
      symlinkSync(file('target.pdf', PDF), link, 'file');
    } catch {
      // Unprivileged Windows accounts cannot create file symlinks; a junction is the reachable link type.
      symlinkSync(path.join(ctx.dir, 'incoming'), link, 'junction');
    }
    expect(await reason(() => stageAttachment(ctx.dir, link))).toBe('VALIDATION:not_regular_file');
  });
});

describe('immutable attachment records', () => {
  it('stores identical bytes once, keeps the file read-only, and unlinking keeps history and bytes', async () => {
    const a = asset();
    const staged = await stageAttachment(ctx.dir, file('수리확인서.pdf', PDF));
    const again = await stageAttachment(ctx.dir, file('수리확인서-사본.pdf', PDF));
    expect(again.sha256).toBe(staged.sha256);
    const first = ctx.exec('attachment.add', { ...staged, entityType: 'asset', entityId: a });
    ctx.exec('attachment.add', { ...again, entityType: 'asset', entityId: a });
    expect(statSync(blobPath(ctx.dir, staged.sha256)).mode & 0o222).toBe(0);
    ctx.exec('attachment.unlink', { linkId: first.linkId, reason: '잘못 첨부' });
    const list = ctx.read((db) => listAttachments(db, 'asset', a));
    expect(list).toHaveLength(2);
    expect(list[0]).toMatchObject({ unlinkReason: '잘못 첨부' });
    expect(list[0]!.unlinkedAt).not.toBeNull();
    expect((await readBlob(ctx.dir, staged.sha256)).equals(PDF)).toBe(true);
    expect(codeOf(() => ctx.exec('attachment.unlink', { linkId: first.linkId, reason: '두 번' }))).toBe('RULE_VIOLATION:already_unlinked');
    expect(() => ctx.root.store.db.prepare('DELETE FROM attachments').run()).toThrow(/append-only/);
  });

  it('a failed link leaves only an unreferenced blob, which cleanup removes while keeping referenced ones', async () => {
    const a = asset();
    const kept = await stageAttachment(ctx.dir, file('keep.png', PNG));
    ctx.exec('attachment.add', { ...kept, entityType: 'asset', entityId: a });
    const orphan = await stageAttachment(ctx.dir, file('orphan.pdf', PDF));
    expect(codeOf(() => ctx.exec('attachment.add', { ...orphan, entityType: 'asset', entityId: '00000000-0000-4000-8000-000000000000' }))).toBe('NOT_FOUND');
    const { removed } = await cleanupBlobs(ctx.dir, ctx.root.catalog, { activeDb: ctx.root.store.db });
    expect(removed).toEqual([orphan.sha256]);
    expect(existsSync(blobPath(ctx.dir, kept.sha256))).toBe(true);
    expect(existsSync(blobPath(ctx.dir, orphan.sha256))).toBe(false);
  });

  it('detects a tampered blob on read', async () => {
    const staged = await stageAttachment(ctx.dir, file('scan.jpg', JPG));
    const p = blobPath(ctx.dir, staged.sha256);
    const fs = await import('node:fs/promises');
    await fs.chmod(p, 0o666);
    await fs.writeFile(p, Buffer.from('tampered'));
    expect(await reason(() => readBlob(ctx.dir, staged.sha256))).toBe('INTEGRITY:');
  });
});
