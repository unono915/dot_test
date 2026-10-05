import { canonicalJson, sha256Hex } from '../canonical.js';
import { fail } from '../errors.js';
import type { Db } from '../sqlite.js';
import { parseIp } from '../domain/ipv4.js';
import { addressEligibility, slotByIp } from '../domain/network-queries.js';
import { getAssetDetail, listLocations } from '../domain/queries.js';
import { interfaceKindOf, normalizeCell, type DateFormat, type NormValue, type RowMessage } from './normalize.js';
import { TARGETS, type ImportTarget } from './targets.js';
import { IMPORT_LIMITS, META_SHEET, type ParsedWorkbook } from './xlsx-read.js';

// Read-only preview. Nothing here writes to the database: mapping, validation, matching and the
// resulting plan are computed from a snapshot and later re-verified by import.apply.

export interface SheetMapping {
  sheet: string;
  target: ImportTarget;
  /** field key -> zero-based column index */
  columns: Record<string, number>;
  dateFormat: DateFormat;
}

export interface Decision {
  exclude?: string;
  create?: string;
  linkTo?: string;
  clearFields?: string[];
}

export interface ImportRequest {
  sourceNamespace: string;
  fileName: string;
  mappings: SheetMapping[];
  decisions: Record<string, Decision>;
}

export type RowStatus = 'new' | 'update' | 'unchanged' | 'conflict' | 'error' | 'excluded';

export interface Candidate {
  id: string;
  label: string;
}

/** A dependency on another entity: either an existing id or another row of the same import. */
export type EntityRef = { id: string } | { row: string } | null;

export type Op =
  | { op: 'person.create'; values: { displayName: string; department: string | null; title: string | null } }
  | { op: 'person.update'; id: string; expectedVersion: number; values: { displayName: string; department: string | null; title: string | null } }
  | { op: 'location.create'; segments: string[]; parent: EntityRef }
  | { op: 'network.create'; values: { name: string; cidr: string; gateway: string | null; ranges: { kind: string; first: string; last: string }[] } }
  | {
      op: 'asset.create';
      values: Record<string, string | null>;
      location: EntityRef;
      person: EntityRef;
      role: 'user' | 'custodian';
      iface: { kind: string; label: string; mac: string | null } | null;
      ip: { network: EntityRef; ip: string; state: 'reserved' | 'active' } | null;
    }
  | { op: 'asset.update'; id: string; expectedVersion: number; values: Record<string, string | null> | null; moveTo: EntityRef; assignTo: EntityRef; role: 'user' | 'custodian' }
  | { op: 'interface.add'; asset: EntityRef; iface: { kind: string; label: string; mac: string | null } | null; existingInterfaceId: string | null; ip: { network: EntityRef; ip: string; state: 'reserved' | 'active' } | null }
  | { op: 'assignment.set'; asset: EntityRef; person: EntityRef; role: 'user' | 'custodian' }
  | { op: 'observation.add'; network: EntityRef; ip: string; mac: string | null; asset: EntityRef; observedAt: string }
  | { op: 'none' };

export interface PlanRow {
  ref: string;
  sheet: string;
  rowNumber: number;
  target: ImportTarget;
  rowKey: string | null;
  status: RowStatus;
  entityType: string;
  entityId: string | null;
  values: Record<string, NormValue>;
  diff: { field: string; current: unknown; incoming: unknown }[];
  drift: { field: string; current: unknown; source: unknown }[];
  messages: RowMessage[];
  candidates: Candidate[];
  contentHash: string;
  deps: string[];
  op: Op;
}

export interface PreviewToken {
  datasetId: string;
  epoch: string;
  revision: number;
  fileHash: string;
  mappingHash: string;
  decisionsHash: string;
}

export interface Preview {
  token: PreviewToken;
  sourceNamespace: string;
  fileName: string;
  sameSourceAlreadyApplied: boolean;
  rows: PlanRow[];
  counts: Record<RowStatus, number> & { total: number };
  newEntities: { people: number; locations: number; networks: number; assets: number; interfaces: number; observations: number };
}

const ENTITY_OF: Record<ImportTarget, string> = {
  people: 'person', locations: 'location', networks: 'network', assets: 'asset', interfaces: 'interface', assignments: 'assignment', observations: 'observation',
};

const ORDER: ImportTarget[] = ['locations', 'people', 'networks', 'assets', 'interfaces', 'assignments', 'observations'];

export function validateMappings(wb: ParsedWorkbook, mappings: SheetMapping[]): void {
  const seen = new Set<string>();
  for (const m of mappings) {
    const sheet = wb.sheets.find((s) => s.name === m.sheet);
    if (!sheet || m.sheet === META_SHEET) fail('VALIDATION', `시트 "${m.sheet}"을(를) 찾을 수 없습니다.`, { field: 'mappings' });
    if (seen.has(m.sheet)) fail('VALIDATION', '같은 시트를 두 번 매핑했습니다.', { field: 'mappings' });
    seen.add(m.sheet);
    const fields = TARGETS[m.target]?.fields ?? fail('VALIDATION', '지원하지 않는 대상입니다.', { field: 'target' });
    const cols = Object.entries(m.columns);
    if (cols.length > IMPORT_LIMITS.maxMappedColumnsPerSheet) fail('LIMIT_EXCEEDED', '매핑 열은 시트당 100개까지입니다.');
    const used = new Set<number>();
    for (const [key, col] of cols) {
      if (!fields!.some((f) => f.key === key)) fail('VALIDATION', `알 수 없는 항목 ${key}`, { field: key });
      if (!Number.isInteger(col) || col < 0 || col >= sheet!.headers.length) fail('VALIDATION', '열 위치가 올바르지 않습니다.', { field: key });
      if (used.has(col)) fail('VALIDATION', '한 열을 두 항목에 매핑했습니다.', { field: key });
      used.add(col);
    }
    for (const f of fields!) if (f.required && m.columns[f.key] === undefined) fail('VALIDATION', `필수 항목 "${f.label}"을(를) 매핑해 주세요.`, { field: f.key });
  }
}

export const mappingHash = (namespace: string, mappings: SheetMapping[]) => sha256Hex(canonicalJson({ namespace, mappings }));
export const decisionsHash = (decisions: Record<string, Decision>) => sha256Hex(canonicalJson(decisions));

interface Ctx {
  db: Db;
  datasetId: string;
  namespace: string;
  trustInternalIds: boolean;
  knownSource: boolean;
  rows: PlanRow[];
  byRef: Map<string, PlanRow>;
  decisions: Record<string, Decision>;
  locationsByPath: Map<string, string>;
  index: Map<string, PlanRow[]>;
}

/** Rows of this import indexed by lookup key (built once; avoids O(n^2) relation lookups). */
function indexRows(rows: PlanRow[]): Map<string, PlanRow[]> {
  const index = new Map<string, PlanRow[]>();
  const add = (k: string, r: PlanRow) => index.set(k, [...(index.get(k) ?? []), r]);
  for (const r of rows) {
    if (r.status === 'excluded') continue;
    if (r.target === 'people' && typeof r.values.displayName === 'string') add(`person|${r.values.displayName}`, r);
    if (r.target === 'networks' && typeof r.values.name === 'string') add(`network|${r.values.name}`, r);
    if (r.target === 'locations' && Array.isArray(r.values.path)) add(`location|${r.values.path.join(' > ')}`, r);
    if (r.target === 'assets') {
      const keys = new Set([r.rowKey, r.values.officialNo, r.values.internalId].filter((k): k is string => typeof k === 'string'));
      for (const k of keys) add(`asset|${k}`, r);
    }
    if ((r.target === 'assets' || r.target === 'interfaces') && typeof r.values.ip === 'string') add(`ip|${String(r.values.network)}|${r.values.ip}`, r);
  }
  return index;
}

const lookup = (ctx: Ctx, key: string) => (ctx.index.get(key) ?? []).filter((r) => r.status !== 'excluded');

const asText = (v: NormValue | undefined) => (typeof v === 'string' ? v : null);

function keyedEntity(ctx: Ctx, entityType: string, rowKey: string | null): string | null {
  if (!rowKey) return null;
  const r = ctx.db.prepare('SELECT entity_id AS id FROM import_row_keys WHERE source_namespace = ? AND row_key = ? AND entity_type = ?').get(ctx.namespace, rowKey, entityType) as
    | { id: string }
    | undefined;
  return r?.id ?? null;
}

function lastAppliedHash(ctx: Ctx, entityType: string, rowKey: string | null): string | null {
  if (!rowKey) return null;
  const r = ctx.db.prepare('SELECT content_hash AS h FROM import_row_keys WHERE source_namespace = ? AND row_key = ? AND entity_type = ?').get(ctx.namespace, rowKey, entityType) as
    | { h: string }
    | undefined;
  return r?.h ?? null;
}

const msg = (row: PlanRow, level: RowMessage['level'], code: string, message: string, field?: string) => row.messages.push({ level, code, message, ...(field ? { field } : {}) });

/** Resolves identity by internal id and stable key; reports conflicts between them. */
function identify(ctx: Ctx, row: PlanRow, table: string): string | null {
  const keyed = keyedEntity(ctx, row.entityType, row.rowKey);
  const internal = asText(row.values.internalId ?? null);
  let byInternal: string | null = null;
  if (internal) {
    if (!ctx.trustInternalIds) {
      msg(row, 'info', 'foreign_internal_id', '다른 데이터셋(또는 확인할 수 없는) 문서의 내부 ID라 현재 자산 식별에 쓰지 않습니다.', 'internalId');
    } else if (ctx.db.prepare(`SELECT 1 FROM ${table} WHERE id = ?`).get(internal)) byInternal = internal;
    else msg(row, 'error', 'unknown_internal_id', '내부 ID에 해당하는 기록이 없습니다.', 'internalId');
  }
  if (keyed && byInternal && keyed !== byInternal) {
    msg(row, 'error', 'key_conflict', '내부 ID와 행 안정키가 서로 다른 기록을 가리킵니다.', 'rowKey');
    return null;
  }
  const linked = ctx.decisions[row.ref]?.linkTo ?? null;
  if (linked && !(keyed || byInternal)) {
    if (!ctx.db.prepare(`SELECT 1 FROM ${table} WHERE id = ?`).get(linked)) {
      msg(row, 'error', 'invalid_link', '연결할 기록을 찾을 수 없습니다.');
      return null;
    }
    return linked;
  }
  return keyed ?? byInternal;
}

function personRef(ctx: Ctx, row: PlanRow, name: string | null, field: string, forNewUse: boolean): EntityRef {
  if (!name) return null;
  const inImport = lookup(ctx, `person|${name}`);
  if (inImport.length === 1) {
    row.deps.push(inImport[0]!.ref);
    return inImport[0]!.entityId ? { id: inImport[0]!.entityId } : { row: inImport[0]!.ref };
  }
  const existing = ctx.db.prepare('SELECT id, status FROM people WHERE display_name = ?').all(name) as { id: string; status: string }[];
  if (inImport.length + existing.length > 1) msg(row, 'error', 'ambiguous_person', `"${name}" 이름의 사람이 여러 명입니다. 사람 시트에 행 안정키를 두거나 화면에서 직접 배정해 주세요.`, field);
  else if (existing.length === 0) msg(row, 'error', 'person_not_found', `"${name}" 사람이 없습니다. 사람 시트에 추가해 주세요.`, field);
  else if (forNewUse && existing[0]!.status !== 'active') msg(row, 'error', 'person_inactive', `"${name}"은(는) 비활성(퇴직 등) 상태라 새로 배정할 수 없습니다.`, field);
  else return { id: existing[0]!.id };
  return null;
}

function networkRef(ctx: Ctx, row: PlanRow, name: string | null): EntityRef {
  if (!name) return null;
  const inImport = lookup(ctx, `network|${name}`);
  if (inImport.length === 1) {
    row.deps.push(inImport[0]!.ref);
    return inImport[0]!.entityId ? { id: inImport[0]!.entityId } : { row: inImport[0]!.ref };
  }
  const existing = ctx.db
    .prepare('SELECT id FROM networks WHERE name = ? UNION SELECT network_id FROM network_aliases WHERE alias = ? COLLATE NOCASE')
    .all(name, name) as { id: string }[];
  if (existing.length === 1) return { id: existing[0]!.id };
  msg(row, 'error', existing.length ? 'ambiguous_network' : 'network_not_found', existing.length ? `"${name}" 망 이름이 여러 망에 해당합니다.` : `"${name}" 망이 없습니다. 망 시트에 추가해 주세요.`, 'network');
  return null;
}

function locationRef(ctx: Ctx, row: PlanRow, path: string[] | null): EntityRef {
  if (!path) return null;
  const key = path.join(' > ');
  const existing = ctx.locationsByPath.get(key);
  if (existing) return { id: existing };
  const inImport = lookup(ctx, `location|${key}`)[0];
  if (inImport) {
    row.deps.push(inImport.ref);
    return inImport.entityId ? { id: inImport.entityId } : { row: inImport.ref };
  }
  msg(row, 'error', 'location_not_found', `"${key}" 장소가 없습니다. 장소 시트에 추가해 주세요.`, 'location');
  return null;
}

function assetRef(ctx: Ctx, row: PlanRow, ref: string | null): EntityRef {
  if (!ref) return null;
  const inImport = lookup(ctx, `asset|${ref}`);
  if (inImport.length === 1) {
    row.deps.push(inImport[0]!.ref);
    return inImport[0]!.entityId ? { id: inImport[0]!.entityId } : { row: inImport[0]!.ref };
  }
  const keyed = keyedEntity(ctx, 'asset', ref);
  if (keyed) return { id: keyed };
  if (ctx.trustInternalIds && ctx.db.prepare('SELECT 1 FROM assets WHERE id = ?').get(ref)) return { id: ref };
  const byNo = ctx.db.prepare('SELECT id FROM assets WHERE official_no = ?').all(ref) as { id: string }[];
  if (byNo.length === 1 && inImport.length === 0) return { id: byNo[0]!.id };
  msg(row, 'error', byNo.length + inImport.length > 1 ? 'ambiguous_asset' : 'asset_not_found', byNo.length + inImport.length > 1 ? `"${ref}" 자산이 여러 개입니다.` : `"${ref}" 자산을 찾을 수 없습니다.`, 'asset');
  return null;
}

const DESCRIPTIVE = ['kind', 'manufacturer', 'model', 'serial', 'officialNo', 'ownership', 'acquiredOn', 'acquisitionSource', 'warrantyUntil', 'memo'] as const;

function planPerson(ctx: Ctx, row: PlanRow) {
  const id = identify(ctx, row, 'people');
  const values = { displayName: asText(row.values.displayName)!, department: asText(row.values.department ?? null), title: asText(row.values.title ?? null) };
  if (id) {
    const cur = ctx.db.prepare('SELECT display_name AS displayName, department, title, version FROM people WHERE id = ?').get(id) as typeof values & { version: number };
    row.entityId = id;
    const clear = new Set(ctx.decisions[row.ref]?.clearFields ?? []);
    const next = {
      displayName: values.displayName,
      department: clear.has('department') ? null : (values.department ?? cur.department),
      title: clear.has('title') ? null : (values.title ?? cur.title),
    };
    return finishUpdate(ctx, row, cur as unknown as Record<string, unknown>, next, () => ({ op: 'person.update', id, expectedVersion: cur.version, values: next }));
  }
  if (row.messages.some((m) => m.level === 'error')) return;
  const same = ctx.db.prepare('SELECT id, display_name AS name, department FROM people WHERE display_name = ?').all(values.displayName) as { id: string; name: string; department: string | null }[];
  if (same.length && !ctx.decisions[row.ref]?.create) {
    row.status = 'conflict';
    row.candidates = same.map((s) => ({ id: s.id, label: `${s.name}${s.department ? ` (${s.department})` : ''}` }));
    msg(row, 'warning', 'ambiguous_name', '같은 이름의 사람이 이미 있습니다. 기존 사람에 연결하거나 새로 등록하는 이유를 선택해 주세요.');
    return;
  }
  row.status = 'new';
  row.op = { op: 'person.create', values };
}

function finishUpdate(ctx: Ctx, row: PlanRow, current: Record<string, unknown>, next: Record<string, unknown>, op: () => Op) {
  row.diff = Object.keys(next).filter((k) => (next[k] ?? null) !== (current[k] ?? null)).map((k) => ({ field: k, current: current[k] ?? null, incoming: next[k] ?? null }));
  const last = lastAppliedHash(ctx, row.entityType, row.rowKey);
  if (last && last === row.contentHash) {
    row.status = 'unchanged';
    row.drift = row.diff.map((d) => ({ field: d.field, current: d.current, source: d.incoming }));
    row.diff = [];
    if (row.drift.length) msg(row, 'info', 'manual_change_kept', '이전에 적용한 원본과 같아 다시 적용하지 않습니다. 이후 수동으로 바뀐 값은 그대로 둡니다.');
    return;
  }
  if (row.diff.length === 0) {
    row.status = 'unchanged';
    return;
  }
  row.status = 'update';
  row.op = op();
}

function planLocation(ctx: Ctx, row: PlanRow) {
  const path = row.values.path as string[] | null;
  if (!path) return;
  const id = identify(ctx, row, 'locations');
  const key = path.join(' > ');
  const existingByPath = ctx.locationsByPath.get(key) ?? null;
  if (id) {
    row.entityId = id;
    row.status = 'unchanged';
    if (existingByPath !== id) msg(row, 'warning', 'location_path_changed', '장소 경로 변경은 가져오기로 하지 않습니다. 사람·장소 화면에서 수정해 주세요.');
    return;
  }
  if (row.messages.some((m) => m.level === 'error')) return;
  if (existingByPath) {
    // The full hierarchical path identifies the place; nothing new is created.
    row.entityId = existingByPath;
    row.status = 'unchanged';
    msg(row, 'info', 'existing_location', '같은 경로의 기존 장소를 사용합니다.');
    return;
  }
  let parent: EntityRef = null;
  if (path.length > 1) {
    const parentKey = path.slice(0, -1).join(' > ');
    const pid = ctx.locationsByPath.get(parentKey);
    const prow = lookup(ctx, `location|${parentKey}`).find((r) => r !== row);
    if (pid) parent = { id: pid };
    else if (prow) {
      parent = { row: prow.ref };
      row.deps.push(prow.ref);
    } else {
      msg(row, 'error', 'parent_not_found', `상위 장소 "${parentKey}"이(가) 없습니다. 상위 장소 행을 먼저 추가해 주세요.`, 'path');
      return;
    }
  }
  row.status = 'new';
  row.op = { op: 'location.create', segments: path, parent };
}

function planNetwork(ctx: Ctx, row: PlanRow) {
  const name = asText(row.values.name)!;
  const cidr = asText(row.values.cidr);
  if (!cidr) return;
  const id = identify(ctx, row, 'networks');
  const [base, prefix] = cidr.split('/');
  const b = parseIp(base!);
  const last = b + 2 ** (32 - Number(prefix)) - 1;
  const overlap = ctx.db.prepare('SELECT network_id AS networkId, base, prefix FROM subnets WHERE base <= ? AND last >= ?').all(last, b) as { networkId: string; base: number; prefix: number }[];
  if (id) {
    row.entityId = id;
    const same = overlap.find((o) => o.networkId === id && o.base === b && o.prefix === Number(prefix));
    if (same) row.status = 'unchanged';
    else msg(row, 'error', 'network_change', '기존 망의 대역 변경·추가는 IP·망 화면에서 진행해 주세요.', 'cidr');
    return;
  }
  const exact = overlap.find((o) => o.base === b && o.prefix === Number(prefix));
  if (exact && overlap.length === 1) {
    const net = ctx.db.prepare('SELECT name FROM networks WHERE id = ?').get(exact.networkId) as { name: string };
    row.entityId = exact.networkId;
    if (net.name === name || ctx.db.prepare('SELECT 1 FROM network_aliases WHERE network_id = ? AND alias = ? COLLATE NOCASE').get(exact.networkId, name)) {
      row.status = 'unchanged';
      msg(row, 'info', 'existing_network', '같은 대역의 기존 망을 사용합니다.');
    } else msg(row, 'error', 'network_name_differs', `같은 대역이 다른 이름(${net.name})으로 등록되어 있습니다. 같은 실제망이면 망 화면에서 별칭을 추가해 주세요.`, 'name');
    return;
  }
  if (overlap.length) {
    msg(row, 'error', 'network_overlap', '기존 망과 주소가 겹칩니다. 같은 실제망이면 망 화면에서 별칭으로 연결해 주세요.', 'cidr');
    return;
  }
  const others = ctx.rows.filter((r) => r !== row && r.target === 'networks' && r.values.cidr && r.status !== 'excluded').filter((r) => {
    const [rb, rp] = (r.values.cidr as string).split('/');
    const rbase = parseIp(rb!);
    return rbase <= last && rbase + 2 ** (32 - Number(rp)) - 1 >= b;
  });
  if (others.length) {
    msg(row, 'error', 'network_overlap', '같은 파일의 다른 망 행과 주소가 겹칩니다.', 'cidr');
    return;
  }
  if (row.messages.some((m) => m.level === 'error')) return;
  const named = ctx.db.prepare('SELECT id FROM networks WHERE name = ? UNION SELECT network_id FROM network_aliases WHERE alias = ? COLLATE NOCASE').all(name, name) as { id: string }[];
  if (named.length && !ctx.decisions[row.ref]?.create) {
    row.status = 'conflict';
    row.candidates = named.map((n) => ({ id: n.id, label: name }));
    msg(row, 'warning', 'ambiguous_name', '같은 이름의 망이 있습니다. 새 망으로 만들 이유를 입력하거나 행을 제외해 주세요.');
    return;
  }
  const ranges: { kind: string; first: string; last: string }[] = [];
  const sf = asText(row.values.staticFirst ?? null);
  const sl = asText(row.values.staticLast ?? null);
  const df = asText(row.values.dhcpFirst ?? null);
  const dl = asText(row.values.dhcpLast ?? null);
  if ((sf === null) !== (sl === null) || (df === null) !== (dl === null)) {
    msg(row, 'error', 'range_incomplete', '범위의 시작과 끝을 모두 입력해 주세요.');
    return;
  }
  if (sf && sl) ranges.push({ kind: 'static', first: sf, last: sl });
  if (df && dl) ranges.push({ kind: 'dhcp', first: df, last: dl });
  if (!sf) msg(row, 'warning', 'no_static_range', '고정 배정 범위가 없어 이 망의 IP를 배정할 수 없습니다.');
  row.status = 'new';
  row.op = { op: 'network.create', values: { name, cidr, gateway: asText(row.values.gateway ?? null), ranges } };
}

function ipPlan(ctx: Ctx, row: PlanRow, assetEntity: string | null, interfaceId: string | null): { network: EntityRef; ip: string; state: 'reserved' | 'active' } | null {
  const ip = asText(row.values.ip ?? null);
  if (!ip) return null;
  const network = networkRef(ctx, row, asText(row.values.network ?? null));
  if (!row.values.network) msg(row, 'error', 'network_required', 'IP에는 망 이름이 필요합니다.', 'network');
  if (!network) return null;
  const state = (asText(row.values.ipState ?? null) as 'reserved' | 'active' | null) ?? 'active';
  if (!row.values.ipState) msg(row, 'info', 'ip_state_default', 'IP 상태가 비어 있어 "사용 중"으로 등록합니다.', 'ipState');
  if ('id' in network) {
    const slot = slotByIp(ctx.db, network.id, parseIp(ip));
    if (slot?.interfaceId) {
      const holder = ctx.db.prepare('SELECT asset_id AS a FROM interfaces WHERE id = ?').get(slot.interfaceId) as { a: string };
      if (assetEntity && holder.a === assetEntity && (!interfaceId || interfaceId === slot.interfaceId)) return null;
      msg(row, 'error', 'address_occupied', `${ip}은(는) 이미 다른 장비가 점유하고 있습니다(해제 대기 포함).`, 'ip');
      return null;
    }
    const elig = addressEligibility(ctx.db, network.id, parseIp(ip));
    if (!elig.eligible) {
      msg(row, 'error', 'address_not_eligible', `${ip}은(는) 배정할 수 없는 주소입니다(${elig.reasons.join(', ')}).`, 'ip');
      return null;
    }
  }
  const dupe = lookup(ctx, `ip|${String(row.values.network)}|${ip}`).find((r) => r !== row);
  if (dupe) msg(row, 'error', 'address_duplicated', `같은 파일의 ${dupe.ref} 행과 IP가 겹칩니다.`, 'ip');
  return { network, ip, state };
}

function ifaceSpec(row: PlanRow): { kind: string; label: string; mac: string | null } | null {
  const label = asText(row.values.interfaceLabel ?? null);
  const kindText = asText(row.values.interfaceKind ?? null);
  const mac = asText(row.values.mac ?? null);
  if (!label && !kindText && !mac && !row.values.ip) return null;
  const kind = interfaceKindOf(kindText) ?? 'ethernet';
  if (kindText && !interfaceKindOf(kindText)) msg(row, 'error', 'invalid_interface_kind', '인터페이스 종류는 유선/무선/기타입니다.', 'interfaceKind');
  return { kind, label: label ?? (kind === 'wifi' ? '무선' : '유선'), mac };
}

function planAsset(ctx: Ctx, row: PlanRow) {
  const id = identify(ctx, row, 'assets');
  const values: Record<string, string | null> = {};
  for (const k of DESCRIPTIVE) values[k] = asText(row.values[k] ?? null);
  const role = (asText(row.values.role ?? null) as 'user' | 'custodian' | null) ?? 'user';
  if (id) {
    row.entityId = id;
    const detail = getAssetDetail(ctx.db, id)!;
    const cur = detail.asset as unknown as Record<string, string | null>;
    const clear = new Set(ctx.decisions[row.ref]?.clearFields ?? []);
    const next: Record<string, string | null> = {};
    for (const k of DESCRIPTIVE) next[k] = clear.has(k) ? null : (values[k] ?? (cur[k] as string | null));
    if (next.kind !== cur.kind) {
      msg(row, 'error', 'kind_change', '기존 자산의 종류는 바꿀 수 없습니다.', 'kind');
      return;
    }
    if (detail.asset.lifecycle === 'disposed') msg(row, 'warning', 'disposed', '폐기된 자산입니다. 설명 항목만 반영합니다.');
    const moveTo = row.values.location ? locationRef(ctx, row, row.values.location as string[]) : null;
    const assignTo = row.values.person ? personRef(ctx, row, asText(row.values.person), 'person', true) : null;
    const comparable = { ...Object.fromEntries(DESCRIPTIVE.map((k) => [k, cur[k] ?? null])), location: detail.asset.locationId, person: detail.assignment?.personId ?? null };
    const nextComparable = {
      ...next,
      location: moveTo && 'id' in moveTo ? moveTo.id : moveTo ? `(새 장소 ${(moveTo as { row: string }).row})` : detail.asset.locationId,
      person: assignTo && 'id' in assignTo ? assignTo.id : assignTo ? `(새 사람 ${(assignTo as { row: string }).row})` : (detail.assignment?.personId ?? null),
    };
    if (row.values.ip) {
      const held = detail.interfaces.some((i) => i.slots.some((s) => s.ip === row.values.ip));
      if (!held) msg(row, 'warning', 'ip_change_needs_workflow', 'IP 변경·추가는 가져오기로 하지 않습니다. 해제·이전·예약은 IP 화면에서 진행해 주세요.', 'ip');
    }
    if (row.messages.some((m) => m.level === 'error')) return;
    const changedDesc = DESCRIPTIVE.some((k) => (next[k] ?? null) !== (cur[k] ?? null));
    const realMove = moveTo && !('id' in moveTo && moveTo.id === detail.asset.locationId) ? moveTo : null;
    const realAssign = assignTo && !('id' in assignTo && assignTo.id === detail.assignment?.personId) ? assignTo : null;
    if (realAssign && detail.loan) msg(row, 'error', 'loan_open', '대여 중인 자산의 담당자는 가져오기로 바꿀 수 없습니다.', 'person');
    return finishUpdate(ctx, row, comparable, nextComparable, () => ({
      op: 'asset.update', id, expectedVersion: detail.asset.version, values: changedDesc ? next : null, moveTo: realMove, assignTo: realAssign, role,
    }));
  }
  if (row.messages.some((m) => m.level === 'error')) return;
  const decision = ctx.decisions[row.ref];
  const candidates = [
    ...(values.officialNo ? (ctx.db.prepare('SELECT id, official_no AS o, serial AS s, model FROM assets WHERE official_no = ?').all(values.officialNo) as { id: string; o: string | null; s: string | null; model: string | null }[]) : []),
    ...(values.serial ? (ctx.db.prepare('SELECT id, official_no AS o, serial AS s, model FROM assets WHERE serial = ?').all(values.serial) as { id: string; o: string | null; s: string | null; model: string | null }[]) : []),
  ];
  const unique = [...new Map(candidates.map((c) => [c.id, c])).values()];
  if (unique.length && !decision?.create) {
    row.status = 'conflict';
    row.candidates = unique.map((c) => ({ id: c.id, label: [c.o && `물품번호 ${c.o}`, c.s && `제조번호 ${c.s}`, c.model].filter(Boolean).join(' / ') }));
    msg(row, 'warning', 'ambiguous_match', '물품번호·제조번호가 같은 자산이 있습니다. 기존 자산에 연결하거나 새로 등록하는 이유를 선택해 주세요.');
    return;
  }
  if (!row.rowKey && ctx.knownSource && !values.officialNo && !values.serial && !decision?.create) {
    row.status = 'conflict';
    msg(row, 'warning', 'unkeyed_in_known_source', '이미 가져온 적 있는 자료인데 안정키·물품번호·제조번호가 없어 기존 자산과 맞출 수 없습니다. 새로 등록할 이유를 입력하거나 제외해 주세요.');
    return;
  }
  const location = row.values.location ? locationRef(ctx, row, row.values.location as string[]) : null;
  if (!row.values.location) msg(row, 'warning', 'location_unspecified', '장소가 없어 "미지정"으로 등록합니다.', 'location');
  const person = personRef(ctx, row, asText(row.values.person ?? null), 'person', true);
  const iface = ifaceSpec(row);
  const ip = ipPlan(ctx, row, null, null);
  if (row.messages.some((m) => m.level === 'error')) return;
  row.status = 'new';
  row.op = { op: 'asset.create', values, location, person, role, iface, ip };
}

function planInterface(ctx: Ctx, row: PlanRow) {
  const asset = assetRef(ctx, row, asText(row.values.asset ?? null));
  if (!asset) return;
  const iface = ifaceSpec(row)!;
  let existingInterfaceId: string | null = null;
  if ('id' in asset) {
    const ex = ctx.db.prepare('SELECT id, mac FROM interfaces WHERE asset_id = ? AND label = ?').all(asset.id, iface.label) as { id: string; mac: string | null }[];
    if (ex.length > 1) msg(row, 'error', 'ambiguous_interface', '같은 이름의 인터페이스가 여러 개입니다.', 'interfaceLabel');
    existingInterfaceId = ex[0]?.id ?? null;
    if (existingInterfaceId && iface.mac && ex[0]!.mac && ex[0]!.mac !== iface.mac) msg(row, 'warning', 'mac_differs', 'MAC이 기존 값과 다릅니다. 인터페이스 정보는 자산 화면에서 수정해 주세요.', 'mac');
  }
  const ip = ipPlan(ctx, row, 'id' in asset ? asset.id : null, existingInterfaceId);
  if (row.messages.some((m) => m.level === 'error')) return;
  if (existingInterfaceId && !ip) {
    row.status = 'unchanged';
    row.entityId = existingInterfaceId;
    return;
  }
  row.status = existingInterfaceId ? 'update' : 'new';
  row.entityId = existingInterfaceId;
  row.op = { op: 'interface.add', asset, iface: existingInterfaceId ? null : iface, existingInterfaceId, ip };
}

function planAssignment(ctx: Ctx, row: PlanRow) {
  const asset = assetRef(ctx, row, asText(row.values.asset ?? null));
  const person = personRef(ctx, row, asText(row.values.person ?? null), 'person', true);
  const role = (asText(row.values.role ?? null) as 'user' | 'custodian' | null) ?? 'user';
  if (!asset || !person || row.messages.some((m) => m.level === 'error')) return;
  if ('id' in asset && 'id' in person) {
    const cur = ctx.db.prepare('SELECT person_id AS p, role FROM assignments WHERE asset_id = ? AND ended_at IS NULL').get(asset.id) as { p: string; role: string } | undefined;
    if (cur && cur.p === person.id && cur.role === role) {
      row.status = 'unchanged';
      return;
    }
    if (ctx.db.prepare('SELECT 1 FROM loans WHERE asset_id = ? AND returned_at IS NULL').get(asset.id)) {
      msg(row, 'error', 'loan_open', '대여 중인 자산의 담당자는 가져오기로 바꿀 수 없습니다.', 'asset');
      return;
    }
  }
  row.status = 'new';
  row.op = { op: 'assignment.set', asset, person, role };
}

function planObservation(ctx: Ctx, row: PlanRow) {
  const network = networkRef(ctx, row, asText(row.values.network ?? null));
  const asset = row.values.asset ? assetRef(ctx, row, asText(row.values.asset)) : null;
  if (!network || row.messages.some((m) => m.level === 'error')) return;
  row.status = 'new';
  row.op = { op: 'observation.add', network, ip: asText(row.values.ip)!, mac: asText(row.values.mac ?? null), asset, observedAt: asText(row.values.observedAt)! };
}

/** Builds the preview plan. Pure read: callers run it inside DatasetStore.read. */
export function buildPreview(db: Db, ids: { datasetId: string; epoch: string; revision: number }, wb: ParsedWorkbook, req: ImportRequest): Preview {
  validateMappings(wb, req.mappings);
  const namespace = req.sourceNamespace.trim();
  if (!namespace || namespace.length > 100) fail('VALIDATION', '원본 이름(출처)을 입력해 주세요.', { field: 'sourceNamespace' });
  const mHash = mappingHash(namespace, req.mappings);
  const sameSource = !!db.prepare('SELECT 1 FROM import_runs WHERE source_namespace = ? AND file_hash = ? AND mapping_hash = ?').get(namespace, wb.fileHash, mHash);
  const ctx: Ctx = {
    db,
    datasetId: ids.datasetId,
    namespace,
    trustInternalIds: wb.meta.dataset_id === ids.datasetId,
    knownSource: !!db.prepare('SELECT 1 FROM import_runs WHERE source_namespace = ?').get(namespace),
    rows: [],
    byRef: new Map(),
    decisions: req.decisions,
    locationsByPath: new Map(listLocations(db).map((l) => [l.path, l.id])),
    index: new Map(),
  };
  const mappings = [...req.mappings].sort((a, b) => ORDER.indexOf(a.target) - ORDER.indexOf(b.target));
  // Pass 1: normalise every row.
  for (const m of mappings) {
    const sheet = wb.sheets.find((s) => s.name === m.sheet)!;
    const fields = TARGETS[m.target].fields;
    for (const r of sheet.rows) {
      const messages: RowMessage[] = [];
      const values: Record<string, NormValue> = {};
      for (const f of fields) {
        const col = m.columns[f.key];
        if (col === undefined) continue;
        values[f.key] = normalizeCell(f, r.cells[col], col, m.dateFormat, messages);
        if (f.required && values[f.key] === null && !messages.some((x) => x.field === f.key)) {
          messages.push({ level: 'error', code: 'required', field: f.key, column: col, message: `"${f.label}" 값이 비어 있습니다.` });
        }
      }
      const rowKey = typeof values.rowKey === 'string' ? values.rowKey : null;
      const { rowKey: _rk, internalId: _id, requestedAction: _ra, ...content } = values;
      const row: PlanRow = {
        ref: `${m.sheet}!${r.rowNumber}`, sheet: m.sheet, rowNumber: r.rowNumber, target: m.target, rowKey, status: 'error',
        entityType: ENTITY_OF[m.target], entityId: null, values, diff: [], drift: [], messages, candidates: [],
        contentHash: sha256Hex(canonicalJson({ target: m.target, content })), deps: [], op: { op: 'none' },
      };
      const excludeReason = req.decisions[row.ref]?.exclude;
      if (excludeReason) {
        row.status = 'excluded';
        row.messages.push({ level: 'info', code: 'excluded', message: excludeReason });
      }
      ctx.rows.push(row);
      ctx.byRef.set(row.ref, row);
    }
  }
  ctx.index = indexRows(ctx.rows);
  const keys = new Map<string, string>();
  for (const row of ctx.rows) {
    if (!row.rowKey || row.status === 'excluded') continue;
    const k = `${row.entityType}|${row.rowKey}`;
    if (keys.has(k)) row.messages.push({ level: 'error', code: 'duplicate_row_key', field: 'rowKey', message: `행 안정키가 ${keys.get(k)} 행과 중복됩니다.` });
    else keys.set(k, row.ref);
  }
  // Pass 2: match and plan in dependency order.
  for (const row of ctx.rows) {
    if (row.status === 'excluded') continue;
    if (sameSource) {
      row.status = 'unchanged';
      row.messages.push({ level: 'info', code: 'same_source_already_applied', message: '같은 원본을 이미 적용했습니다. 다시 적용하지 않습니다.' });
      continue;
    }
    if (row.messages.some((m) => m.level === 'error')) continue;
    switch (row.target) {
      case 'people': planPerson(ctx, row); break;
      case 'locations': planLocation(ctx, row); break;
      case 'networks': planNetwork(ctx, row); break;
      case 'assets': planAsset(ctx, row); break;
      case 'interfaces': planInterface(ctx, row); break;
      case 'assignments': planAssignment(ctx, row); break;
      case 'observations': planObservation(ctx, row); break;
    }
    if (row.messages.some((m) => m.level === 'error')) row.status = 'error';
  }
  // Rows that depend on rows not being applied cannot be applied either.
  let changed = true;
  while (changed) {
    changed = false;
    for (const row of ctx.rows) {
      if (row.status !== 'new' && row.status !== 'update') continue;
      const blocked = row.deps.map((d) => ctx.byRef.get(d)!).find((d) => d.status === 'error' || d.status === 'conflict' || d.status === 'excluded');
      if (blocked) {
        row.status = 'error';
        row.op = { op: 'none' };
        row.messages.push({ level: 'error', code: 'dependency_blocked', message: `연결된 ${blocked.ref} 행이 적용되지 않아 이 행도 적용할 수 없습니다.` });
        changed = true;
      }
    }
  }
  const counts = { new: 0, update: 0, unchanged: 0, conflict: 0, error: 0, excluded: 0, total: ctx.rows.length };
  for (const r of ctx.rows) counts[r.status]++;
  const created = (t: string) => ctx.rows.filter((r) => r.status === 'new' && r.op.op === t).length;
  return {
    token: { datasetId: ids.datasetId, epoch: ids.epoch, revision: ids.revision, fileHash: wb.fileHash, mappingHash: mHash, decisionsHash: decisionsHash(req.decisions) },
    sourceNamespace: namespace,
    fileName: req.fileName,
    sameSourceAlreadyApplied: sameSource,
    rows: ctx.rows,
    counts,
    newEntities: {
      people: created('person.create'), locations: created('location.create'), networks: created('network.create'), assets: created('asset.create'),
      interfaces: ctx.rows.filter((r) => r.status === 'new' && r.op.op === 'interface.add').length + ctx.rows.filter((r) => r.op.op === 'asset.create' && (r.op as { iface: unknown }).iface).length,
      observations: created('observation.add'),
    },
  };
}
