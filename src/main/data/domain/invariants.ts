import type { Db } from '../sqlite.js';
import { datasetSchemaSql } from '../schema.js';
import { openDatabase } from '../sqlite.js';
import { formatIp } from './ipv4.js';

// Whole-dataset checks used before activating a restored generation and at startup. Hash and
// SQLite integrity are not enough: a well-formed file can still violate business rules.

export interface InvariantProblem {
  code: string;
  message: string;
  detail?: Record<string, unknown>;
}

let expectedSchemaCache: Map<string, string> | null = null;

/** The exact schema objects (tables, indexes, triggers) of the current version. */
export function expectedSchema(): Map<string, string> {
  if (expectedSchemaCache) return expectedSchemaCache;
  const db = openDatabase(':memory:');
  try {
    db.exec(datasetSchemaSql());
    expectedSchemaCache = schemaObjects(db);
    return expectedSchemaCache;
  } finally {
    db.close();
  }
}

function schemaObjects(db: Db): Map<string, string> {
  const rows = db.prepare("SELECT type, name, sql FROM sqlite_master WHERE name NOT LIKE 'sqlite_%' AND sql IS NOT NULL").all() as { type: string; name: string; sql: string }[];
  return new Map(rows.map((r) => [`${r.type}:${r.name}`, r.sql.replace(/\s+/g, ' ').trim()]));
}

export function checkDatasetInvariants(db: Db): InvariantProblem[] {
  const problems: InvariantProblem[] = [];
  const add = (code: string, message: string, detail?: Record<string, unknown>) => problems.push({ code, message, ...(detail ? { detail } : {}) });

  const integrity = db.pragma('integrity_check', { simple: true });
  if (integrity !== 'ok') add('sqlite_integrity', 'SQLite 무결성 검사에 실패했습니다.');
  const fk = db.pragma('foreign_key_check') as unknown[];
  if (fk.length) add('foreign_keys', '연결이 끊긴 기록이 있습니다.', { count: fk.length });

  const actual = schemaObjects(db);
  const expected = expectedSchema();
  const missing = [...expected.keys()].filter((k) => actual.get(k) !== expected.get(k));
  const extra = [...actual.keys()].filter((k) => !expected.has(k));
  if (missing.length || extra.length) add('schema_mismatch', '데이터 구조가 이 프로그램의 형식과 다릅니다.', { missing: missing.slice(0, 10), extra: extra.slice(0, 10) });
  if (problems.length) return problems;

  const subnets = db.prepare('SELECT id, network_id AS networkId, base, prefix, last FROM subnets ORDER BY base').all() as { id: string; networkId: string; base: number; prefix: number; last: number }[];
  for (let i = 1; i < subnets.length; i++) {
    const prev = subnets[i - 1]!;
    const cur = subnets[i]!;
    if (cur.base <= prev.last) add('network_overlap', '서로 겹치는 망이 있습니다.', { a: `${formatIp(prev.base)}/${prev.prefix}`, b: `${formatIp(cur.base)}/${cur.prefix}` });
    if (cur.last !== cur.base + 2 ** (32 - cur.prefix) - 1 || cur.base % 2 ** (32 - cur.prefix) !== 0) add('subnet_shape', '서브넷 범위가 올바르지 않습니다.', { id: cur.id });
  }
  const badBinding = db
    .prepare(
      `SELECT s.id, s.state FROM address_slots s LEFT JOIN interfaces i ON i.id = s.interface_id
       WHERE s.state IN ('reserved','active','pending_release') AND (i.id IS NULL OR i.status <> 'enabled')`,
    )
    .all() as { id: string; state: string }[];
  if (badBinding.length) add('slot_binding', '점유 주소가 사용할 수 없는 인터페이스에 묶여 있습니다.', { count: badBinding.length });
  const pendingWithoutRequest = db
    .prepare(
      `SELECT s.id FROM address_slots s WHERE s.state = 'pending_release'
       AND NOT EXISTS (SELECT 1 FROM release_requests r WHERE r.slot_id = s.id AND r.kind = 'release' AND r.status IN ('requested','evidenced') AND r.from_interface_id = s.interface_id)`,
    )
    .all();
  if (pendingWithoutRequest.length) add('pending_release_request', '해제 대기 주소에 진행 중인 해제 요청이 없습니다.', { count: pendingWithoutRequest.length });
  const openBindings = db
    .prepare(
      `SELECT s.id FROM address_slots s WHERE s.interface_id IS NOT NULL AND NOT EXISTS
         (SELECT 1 FROM slot_bindings b WHERE b.slot_id = s.id AND b.ended_at IS NULL AND b.interface_id = s.interface_id)`,
    )
    .all();
  if (openBindings.length) add('slot_binding_history', '주소 점유 기간 기록이 현재 배정과 맞지 않습니다.', { count: openBindings.length });
  const openInventories = (db.prepare("SELECT COUNT(*) AS n FROM inventory_sessions WHERE status = 'open'").get() as { n: number }).n;
  if (openInventories > 1) add('multiple_open_inventories', '진행 중인 실사가 둘 이상입니다.', { count: openInventories });
  const repairState = db
    .prepare(
      `SELECT a.id FROM assets a WHERE (a.lifecycle = 'in_repair') <> EXISTS (SELECT 1 FROM repairs r WHERE r.asset_id = a.id AND r.completed_on IS NULL)`,
    )
    .all();
  if (repairState.length) add('repair_state', '수리 상태와 수리 기록이 맞지 않습니다.', { count: repairState.length });
  const disposedWithRelations = db
    .prepare(
      `SELECT a.id FROM assets a WHERE a.lifecycle = 'disposed' AND (
         EXISTS (SELECT 1 FROM assignments x WHERE x.asset_id = a.id AND x.ended_at IS NULL) OR
         EXISTS (SELECT 1 FROM loans l WHERE l.asset_id = a.id AND l.returned_at IS NULL))`,
    )
    .all();
  if (disposedWithRelations.length) add('disposed_relations', '폐기 자산에 열린 배정·대여가 있습니다.', { count: disposedWithRelations.length });
  const unspecified = (db.prepare('SELECT COUNT(*) AS n FROM locations WHERE is_unspecified = 1').get() as { n: number }).n;
  if (unspecified !== 1) add('unspecified_location', '미지정 장소 기록이 올바르지 않습니다.');
  const meta = Object.fromEntries((db.prepare('SELECT key, value FROM dataset_meta').all() as { key: string; value: string }[]).map((r) => [r.key, r.value]));
  const maxRevision = (db.prepare('SELECT COALESCE(MAX(revision), 0) AS n FROM audit_events').get() as { n: number }).n;
  if (Number(meta.revision) < maxRevision) add('revision', '데이터 revision이 이력보다 작습니다.');
  return problems;
}

/** True when the dataset holds any user data (used to refuse foreign-dataset restores). */
export function hasUserData(db: Db): boolean {
  const n = (sql: string) => (db.prepare(sql).get() as { n: number }).n;
  return n('SELECT COUNT(*) AS n FROM audit_events') > 0 || n('SELECT COUNT(*) AS n FROM assets') > 0 || n('SELECT COUNT(*) AS n FROM locations WHERE is_unspecified = 0') > 0;
}
