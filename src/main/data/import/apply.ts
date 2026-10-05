import { defineCommand, type CommandDefinition, type TxContext } from '../commands.js';
import { fail } from '../errors.js';
import { newId } from '../ids.js';
import { assetRegisterBatch, interfaceAdd } from '../domain/assets.js';
import { insertObservations } from '../domain/observations.js';
import { addressActivate, addressReserve, networkCreate } from '../domain/network.js';
import { slotByIp } from '../domain/network-queries.js';
import { parseIp } from '../domain/ipv4.js';
import { locationCreate, personCreate, personUpdate } from '../domain/people-locations.js';
import { getAsset } from '../domain/repo.js';
import { assetAssign, assetMove } from '../domain/workflows.js';
import { assetUpdate } from '../domain/assets.js';
import type { EntityRef, Op, Preview, PreviewToken } from './plan.js';

// import.apply executes the confirmed preview in ONE transaction through the same domain
// commands as manual work. Any failure rolls back every created entity, state and event.

export interface ApplyRow {
  ref: string;
  rowKey: string | null;
  entityType: string;
  entityId: string | null;
  contentHash: string;
  op: Op;
}

export interface ApplyPayload {
  runId: string;
  sourceNamespace: string;
  fileName: string;
  token: PreviewToken;
  rows: ApplyRow[];
  /** Matched rows whose stable key should be remembered without a change. */
  keys: { rowKey: string; entityType: string; entityId: string; contentHash: string }[];
  excluded: { ref: string; reason: string }[];
  noop: number;
}

/** Builds the apply payload from a preview; refuses unresolved conflicts or errors. */
export function applyPayloadFromPreview(preview: Preview, runId: string): ApplyPayload {
  const blocking = preview.rows.filter((r) => r.status === 'error' || r.status === 'conflict');
  if (blocking.length) {
    fail('RULE_VIOLATION', `오류·충돌 ${blocking.length}행이 남아 있습니다. 해결하거나 제외해 주세요.`, { rule: 'unresolved_rows', refs: blocking.slice(0, 50).map((r) => r.ref) });
  }
  return {
    runId,
    sourceNamespace: preview.sourceNamespace,
    fileName: preview.fileName,
    token: preview.token,
    rows: preview.rows.filter((r) => r.status === 'new' || r.status === 'update').map((r) => ({ ref: r.ref, rowKey: r.rowKey, entityType: r.entityType, entityId: r.entityId, contentHash: r.contentHash, op: r.op })),
    keys: preview.rows
      .filter((r) => r.status === 'unchanged' && r.rowKey && r.entityId)
      .map((r) => ({ rowKey: r.rowKey!, entityType: r.entityType, entityId: r.entityId!, contentHash: r.contentHash })),
    excluded: preview.rows.filter((r) => r.status === 'excluded').map((r) => ({ ref: r.ref, reason: r.messages.find((m) => m.code === 'excluded')?.message ?? '' })),
    noop: preview.rows.filter((r) => r.status === 'unchanged').length,
  };
}

const call = <P, R>(ctx: TxContext, cmd: CommandDefinition<P, R>, raw: unknown): R => cmd.run(ctx, cmd.parse(raw));

function parsePayload(raw: unknown): ApplyPayload {
  const p = raw as ApplyPayload;
  if (!p || typeof p !== 'object' || typeof p.runId !== 'string' || !Array.isArray(p.rows) || !Array.isArray(p.keys) || !p.token) {
    fail('VALIDATION', '가져오기 적용 요청 형식이 올바르지 않습니다.');
  }
  return p;
}

export const importApply = defineCommand('import.apply', parsePayload, (ctx, p) => {
  if (ctx.revision - 1 !== p.token.revision) {
    fail('VERSION_CONFLICT', '미리보기 이후 자료가 바뀌었습니다. 새 미리보기에서 다시 확인해 주세요.', { rule: 'stale_preview', previewRevision: p.token.revision, currentRevision: ctx.revision - 1 });
  }
  if (ctx.db.prepare('SELECT 1 FROM import_runs WHERE id = ?').get(p.runId)) fail('VALIDATION', '이미 적용한 가져오기입니다.');
  const created = new Map<string, string>();
  const resolve = (ref: EntityRef, what: string): string | null => {
    if (!ref) return null;
    if ('id' in ref) return ref.id;
    return created.get(ref.row) ?? fail('INTEGRITY', `${what} 연결 대상이 먼저 적용되지 않았습니다.`, { ref: ref.row });
  };
  let observationSessionId: string | null = null;
  const giveIp = (interfaceId: string, ip: { network: EntityRef; ip: string; state: 'reserved' | 'active' }) => {
    const networkId = resolve(ip.network, '망')!;
    call(ctx, addressReserve, { networkId, ip: ip.ip, interfaceId, reason: `가져오기 ${p.fileName}`, expectedSlotVersion: slotByIp(ctx.db, networkId, parseIp(ip.ip))?.version ?? null });
    if (ip.state === 'active') {
      const s = slotByIp(ctx.db, networkId, parseIp(ip.ip))!;
      call(ctx, addressActivate, { slotId: s.id, expectedVersion: s.version });
    }
  };
  const unspecified = () => (ctx.db.prepare('SELECT id FROM locations WHERE is_unspecified = 1').get() as { id: string }).id;
  const counts = { created: 0, updated: 0 };

  p.rows.forEach((row, index) => {
    ctx.checkCancelled();
    const op = row.op;
    let entityId = row.entityId;
    switch (op.op) {
      case 'person.create':
        entityId = call(ctx, personCreate, op.values).id;
        break;
      case 'person.update':
        call(ctx, personUpdate, { id: op.id, expectedVersion: op.expectedVersion, ...op.values });
        break;
      case 'location.create':
        entityId = call(ctx, locationCreate, { name: op.segments[op.segments.length - 1], parentId: resolve(op.parent, '상위 장소') }).id;
        break;
      case 'network.create':
        entityId = call(ctx, networkCreate, { name: op.values.name, cidr: op.values.cidr, gateway: op.values.gateway, dns: [], ranges: op.values.ranges.map((r) => ({ ...r, note: null })) }).networkId;
        break;
      case 'asset.create': {
        const values = Object.fromEntries(Object.entries(op.values).filter(([, v]) => v !== null));
        entityId = call(ctx, assetRegisterBatch, {
          locationId: resolve(op.location, '장소') ?? unspecified(),
          items: [{ ...values, interfaces: op.iface ? [op.iface] : [] }],
        }).assetIds[0]!;
        const personId = resolve(op.person, '담당자');
        if (personId) call(ctx, assetAssign, { assetId: entityId, expectedVersion: getAsset(ctx.db, entityId).version, personId, role: op.role, reason: `가져오기 ${p.fileName}` });
        if (op.ip) {
          const iface = ctx.db.prepare('SELECT id FROM interfaces WHERE asset_id = ? ORDER BY created_at, rowid LIMIT 1').get(entityId) as { id: string };
          giveIp(iface.id, op.ip);
        }
        break;
      }
      case 'asset.update': {
        const a = getAsset(ctx.db, op.id);
        ctx.expectVersion('asset', a.id, a.version, op.expectedVersion);
        if (op.values) {
          const { kind: _kind, ...descriptive } = op.values;
          call(ctx, assetUpdate, { id: op.id, expectedVersion: getAsset(ctx.db, op.id).version, ...descriptive });
        }
        const moveTo = resolve(op.moveTo, '장소');
        if (moveTo) call(ctx, assetMove, { items: [{ assetId: op.id, expectedVersion: getAsset(ctx.db, op.id).version }], locationId: moveTo, reason: `가져오기 ${p.fileName}` });
        const personId = resolve(op.assignTo, '담당자');
        if (personId) call(ctx, assetAssign, { assetId: op.id, expectedVersion: getAsset(ctx.db, op.id).version, personId, role: op.role, reason: `가져오기 ${p.fileName}` });
        break;
      }
      case 'interface.add': {
        const assetId = resolve(op.asset, '자산')!;
        let interfaceId = op.existingInterfaceId;
        if (op.iface) interfaceId = call(ctx, interfaceAdd, { assetId, expectedAssetVersion: getAsset(ctx.db, assetId).version, ...op.iface }).id;
        entityId = interfaceId;
        if (op.ip) giveIp(interfaceId!, op.ip);
        break;
      }
      case 'assignment.set': {
        const assetId = resolve(op.asset, '자산')!;
        call(ctx, assetAssign, { assetId, expectedVersion: getAsset(ctx.db, assetId).version, personId: resolve(op.person, '담당자'), role: op.role, reason: `가져오기 ${p.fileName}` });
        entityId = assetId;
        break;
      }
      case 'observation.add': {
        if (!observationSessionId) {
          observationSessionId = newId();
          ctx.db
            .prepare('INSERT INTO observation_sessions VALUES (?, ?, ?, ?, ?, ?, ?)')
            .run(observationSessionId, `가져오기: ${p.fileName}`, op.observedAt, op.observedAt, `파일 ${p.fileName}`, p.runId, ctx.now);
        }
        ctx.db
          .prepare('UPDATE observation_sessions SET window_start = MIN(window_start, ?), window_end = MAX(window_end, ?) WHERE id = ?')
          .run(op.observedAt, op.observedAt, observationSessionId);
        entityId = insertObservations(ctx.db, ctx.now, observationSessionId, [
          { networkId: resolve(op.network, '망')!, ip: parseIp(op.ip), mac: op.mac, assetId: resolve(op.asset, '자산'), observedAt: op.observedAt, raw: null },
        ], `파일 ${p.fileName}`)[0]!;
        break;
      }
      case 'none':
        fail('INTEGRITY', '적용할 작업이 없는 행입니다.', { ref: row.ref });
    }
    if (op.op.endsWith('.create') || op.op === 'observation.add' || (op.op === 'interface.add' && op.iface)) counts.created++;
    else counts.updated++;
    if (entityId) created.set(row.ref, entityId);
    ctx.progress(index + 1, p.rows.length);
  });

  const runCounts = { ...counts, noop: p.noop, excluded: p.excluded.length, total: p.rows.length + p.noop + p.excluded.length };
  ctx.db
    .prepare('INSERT INTO import_runs VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)')
    .run(p.runId, p.sourceNamespace, p.token.fileHash, p.fileName, p.token.mappingHash, p.token.decisionsHash, p.token.revision, ctx.now, JSON.stringify(runCounts), JSON.stringify(p.excluded), observationSessionId);
  const upsertKey = ctx.db.prepare(
    `INSERT INTO import_row_keys VALUES (?, ?, ?, ?, ?, ?)
     ON CONFLICT(source_namespace, row_key, entity_type) DO UPDATE SET entity_id = excluded.entity_id, content_hash = excluded.content_hash, run_id = excluded.run_id`,
  );
  for (const row of p.rows) {
    const id = created.get(row.ref) ?? row.entityId;
    if (row.rowKey && id) upsertKey.run(p.sourceNamespace, row.rowKey, row.entityType, id, row.contentHash, p.runId);
  }
  for (const k of p.keys) upsertKey.run(p.sourceNamespace, k.rowKey, k.entityType, k.entityId, k.contentHash, p.runId);
  ctx.emit({ eventType: 'import.applied', entityType: 'import', entityId: p.runId, after: { fileName: p.fileName, sourceNamespace: p.sourceNamespace, fileHash: p.token.fileHash, counts: runCounts, excluded: p.excluded } });
  return { runId: p.runId, counts: runCounts, created: Object.fromEntries(created) };
});
