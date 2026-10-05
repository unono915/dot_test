import { defineCommand } from '../commands.js';
import { fail } from '../errors.js';
import { newId } from '../ids.js';
import type { Db } from '../sqlite.js';
import { violate } from './repo.js';
import { int, oneOf, parser, str, uuid } from './validate.js';

// Attachment records. Bytes live in the content-addressed blob store (see data/attachments.ts);
// records are immutable and removing an attachment only ends its link, keeping history.

export const ATTACHMENT_TYPES = {
  pdf: 'application/pdf',
  png: 'image/png',
  jpg: 'image/jpeg',
  xlsx: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
} as const;

export const ATTACHMENT_LIMITS = { maxFileBytes: 25 * 1024 * 1024, maxTotalBytes: 10 * 1024 ** 3 } as const;

const ENTITY_TABLE = { asset: 'assets', person: 'people', location: 'locations', inventory: 'inventory_sessions', network: 'networks' } as const;

export function attachmentTotalBytes(db: Db): number {
  return (db.prepare('SELECT COALESCE(SUM(size), 0) AS n FROM (SELECT DISTINCT sha256, size FROM attachments)').get() as { n: number }).n;
}

export const attachmentAdd = defineCommand(
  'attachment.add',
  parser({
    sha256: (v, f) => (typeof v === 'string' && /^[0-9a-f]{64}$/.test(v) ? v : fail('VALIDATION', '파일 해시가 올바르지 않습니다.', { field: f })),
    size: int({ min: 1, max: ATTACHMENT_LIMITS.maxFileBytes }),
    ext: oneOf(['pdf', 'png', 'jpg', 'xlsx'] as const),
    displayName: str({ max: 200 }),
    entityType: oneOf(['asset', 'person', 'location', 'inventory', 'network'] as const),
    entityId: uuid,
  }),
  (ctx, p) => {
    if (!ctx.db.prepare(`SELECT 1 FROM ${ENTITY_TABLE[p.entityType]} WHERE id = ?`).get(p.entityId)) fail('NOT_FOUND', '첨부할 대상을 찾을 수 없습니다.');
    const known = ctx.db.prepare('SELECT 1 FROM attachments WHERE sha256 = ?').get(p.sha256);
    if (!known && attachmentTotalBytes(ctx.db) + p.size > ATTACHMENT_LIMITS.maxTotalBytes) {
      fail('LIMIT_EXCEEDED', '첨부 누적 용량(10GB)을 넘습니다. 필요 없는 원본은 백업 후 별도로 보관해 주세요.');
    }
    const id = newId();
    const eventId = ctx.emit({
      eventType: 'attachment.added', entityType: p.entityType, entityId: p.entityId,
      after: { attachmentId: id, displayName: p.displayName, sha256: p.sha256, size: p.size, ext: p.ext },
    });
    ctx.db.prepare('INSERT INTO attachments VALUES (?, ?, ?, ?, ?, ?, ?, ?)').run(id, p.sha256, p.size, ATTACHMENT_TYPES[p.ext], p.ext, p.displayName, ctx.now, eventId);
    const linkId = newId();
    ctx.db.prepare('INSERT INTO attachment_links VALUES (?, ?, ?, ?, ?, ?, NULL, NULL, NULL)').run(linkId, id, p.entityType, p.entityId, ctx.now, eventId);
    return { attachmentId: id, linkId };
  },
);

export const attachmentUnlink = defineCommand('attachment.unlink', parser({ linkId: uuid, reason: str({ max: 500 }) }), (ctx, p) => {
  const link = ctx.db.prepare('SELECT id, attachment_id AS attachmentId, entity_type AS entityType, entity_id AS entityId, unlinked_at AS unlinkedAt FROM attachment_links WHERE id = ?').get(p.linkId) as
    | { id: string; attachmentId: string; entityType: string; entityId: string; unlinkedAt: string | null }
    | undefined;
  if (!link) fail('NOT_FOUND', '첨부 연결을 찾을 수 없습니다.');
  if (link!.unlinkedAt) violate('already_unlinked', '이미 연결을 해제한 첨부입니다.');
  const eventId = ctx.emit({ eventType: 'attachment.unlinked', entityType: link!.entityType, entityId: link!.entityId, after: { attachmentId: link!.attachmentId, linkId: link!.id }, reason: p.reason });
  ctx.db.prepare('UPDATE attachment_links SET unlinked_at = ?, unlink_event_id = ?, unlink_reason = ? WHERE id = ?').run(ctx.now, eventId, p.reason, link!.id);
  return { linkId: link!.id };
});

export const attachmentCommands = [attachmentAdd, attachmentUnlink];

export function listAttachments(db: Db, entityType: string, entityId: string) {
  return db
    .prepare(
      `SELECT l.id AS linkId, a.id AS attachmentId, a.display_name AS displayName, a.mime, a.ext, a.size, a.sha256, l.linked_at AS linkedAt,
         l.unlinked_at AS unlinkedAt, l.unlink_reason AS unlinkReason
       FROM attachment_links l JOIN attachments a ON a.id = l.attachment_id WHERE l.entity_type = ? AND l.entity_id = ? ORDER BY l.linked_at`,
    )
    .all(entityType, entityId) as {
    linkId: string; attachmentId: string; displayName: string; mime: string; ext: string; size: number; sha256: string; linkedAt: string; unlinkedAt: string | null; unlinkReason: string | null;
  }[];
}

/** Every blob hash a dataset references (current or historical links alike). */
export function referencedHashes(db: Db): Set<string> {
  return new Set((db.prepare('SELECT DISTINCT sha256 FROM attachments').all() as { sha256: string }[]).map((r) => r.sha256));
}
