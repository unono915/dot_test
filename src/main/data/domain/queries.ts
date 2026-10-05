import type { Db } from '../sqlite.js';
import { formatIp } from './ipv4.js';
import { ASSET_COLS, INTERFACE_COLS, LOCATION_COLS, PERSON_COLS, type AssetRow, type InterfaceRow, type LocationRow, type PersonRow } from './repo.js';

// Read models. Callers run these inside DatasetStore.read so results share one revision.

export interface LocationView extends LocationRow {
  path: string;
  assetCount: number;
}

export function listLocations(db: Db): LocationView[] {
  const rows = (db.prepare(`SELECT ${LOCATION_COLS} FROM locations ORDER BY name`).all() as (Omit<LocationRow, 'isUnspecified'> & { isUnspecified: number })[]).map(
    (r) => ({ ...r, isUnspecified: r.isUnspecified === 1 }),
  );
  const counts = new Map(
    (db.prepare("SELECT location_id AS id, COUNT(*) AS n FROM assets WHERE lifecycle <> 'disposed' GROUP BY location_id").all() as { id: string; n: number }[]).map((r) => [r.id, r.n]),
  );
  const byId = new Map(rows.map((r) => [r.id, r]));
  const pathOf = (r: LocationRow): string => {
    const names: string[] = [];
    let cursor: LocationRow | undefined = r;
    let guard = 0;
    while (cursor && guard++ < 100) {
      names.unshift(cursor.name);
      cursor = cursor.parentId ? byId.get(cursor.parentId) : undefined;
    }
    return names.join(' > ');
  };
  return rows.map((r) => ({ ...r, path: pathOf(r), assetCount: counts.get(r.id) ?? 0 })).sort((a, b) => a.path.localeCompare(b.path, 'ko'));
}

export interface PersonView extends PersonRow {
  openAssignments: number;
  openLoans: number;
}

export function listPeople(db: Db, filter: { status?: 'active' | 'inactive'; query?: string }): PersonView[] {
  const where: string[] = [];
  const params: Record<string, unknown> = {};
  if (filter.status) {
    where.push('status = @status');
    params.status = filter.status;
  }
  if (filter.query) {
    where.push("(display_name LIKE @q ESCAPE '\\' OR department LIKE @q ESCAPE '\\')");
    params.q = likePattern(filter.query);
  }
  return db
    .prepare(
      `SELECT ${PERSON_COLS},
         (SELECT COUNT(*) FROM assignments a WHERE a.person_id = people.id AND a.ended_at IS NULL) AS openAssignments,
         (SELECT COUNT(*) FROM loans l WHERE l.borrower_id = people.id AND l.returned_at IS NULL) AS openLoans
       FROM people ${where.length ? `WHERE ${where.join(' AND ')}` : ''} ORDER BY display_name`,
    )
    .all(params) as PersonView[];
}

export function likePattern(text: string): string {
  return `%${text.replace(/[\\%_]/g, (c) => `\\${c}`)}%`;
}

export interface AssetFilter {
  query?: string;
  kind?: AssetRow['kind'];
  locationId?: string;
  lifecycle?: AssetRow['lifecycle'];
  personId?: string;
  includeDisposed?: boolean;
  limit?: number;
  offset?: number;
}

export interface AssetListItem extends AssetRow {
  locationName: string;
  personId: string | null;
  personName: string | null;
  borrowerName: string | null;
  loanDueOn: string | null;
  ips: string[];
}

export function listAssets(db: Db, filter: AssetFilter): { total: number; items: AssetListItem[] } {
  const where: string[] = [];
  const params: Record<string, unknown> = {};
  if (!filter.includeDisposed && filter.lifecycle !== 'disposed') where.push("a.lifecycle <> 'disposed'");
  if (filter.kind) {
    where.push('a.kind = @kind');
    params.kind = filter.kind;
  }
  if (filter.lifecycle) {
    where.push('a.lifecycle = @lifecycle');
    params.lifecycle = filter.lifecycle;
  }
  if (filter.locationId) {
    where.push('a.location_id = @locationId');
    params.locationId = filter.locationId;
  }
  if (filter.personId) {
    where.push('asg.person_id = @personId');
    params.personId = filter.personId;
  }
  if (filter.query) {
    where.push(`(a.official_no LIKE @q ESCAPE '\\' OR a.serial LIKE @q ESCAPE '\\' OR a.model LIKE @q ESCAPE '\\' OR a.manufacturer LIKE @q ESCAPE '\\'
      OR a.memo LIKE @q ESCAPE '\\' OR p.display_name LIKE @q ESCAPE '\\' OR l.name LIKE @q ESCAPE '\\' OR a.id = @exact)`);
    params.q = likePattern(filter.query);
    params.exact = filter.query;
  }
  const from = `FROM assets a JOIN locations l ON l.id = a.location_id
    LEFT JOIN assignments asg ON asg.asset_id = a.id AND asg.ended_at IS NULL
    LEFT JOIN people p ON p.id = asg.person_id
    LEFT JOIN loans ln ON ln.asset_id = a.id AND ln.returned_at IS NULL
    LEFT JOIN people b ON b.id = ln.borrower_id
    ${where.length ? `WHERE ${where.join(' AND ')}` : ''}`;
  const total = (db.prepare(`SELECT COUNT(*) AS n ${from}`).get(params) as { n: number }).n;
  const limit = Math.min(Math.max(filter.limit ?? 100, 1), 500);
  const offset = Math.max(filter.offset ?? 0, 0);
  const rows = db
    .prepare(
      `SELECT ${ASSET_COLS.replace(/(^|,\s*)(\w+)/g, '$1a.$2')}, l.name AS locationName, asg.person_id AS personId, p.display_name AS personName,
         b.display_name AS borrowerName, ln.due_on AS loanDueOn
       ${from} ORDER BY a.official_no IS NULL, a.official_no, a.created_at, a.id LIMIT @limit OFFSET @offset`,
    )
    .all({ ...params, limit, offset }) as Omit<AssetListItem, 'ips'>[];
  const ipStmt = db.prepare(
    `SELECT s.ip FROM address_slots s JOIN interfaces i ON i.id = s.interface_id
     WHERE i.asset_id = ? AND s.state IN ('reserved','active','pending_release') ORDER BY s.ip`,
  );
  return { total, items: rows.map((r) => ({ ...r, ips: (ipStmt.all(r.id) as { ip: number }[]).map((s) => formatIp(s.ip)) })) };
}

export interface SlotView {
  id: string;
  networkId: string;
  networkName: string;
  ip: string;
  state: string;
  priorState: string | null;
  version: number;
  openRequest: { id: string; kind: string; status: string; version: number; toInterfaceId: string | null } | null;
}

export function slotsOfInterface(db: Db, interfaceId: string): SlotView[] {
  const rows = db
    .prepare(
      `SELECT s.id, s.network_id AS networkId, n.name AS networkName, s.ip, s.state, s.prior_state AS priorState, s.version,
         r.id AS rid, r.kind AS rkind, r.status AS rstatus, r.version AS rversion, r.to_interface_id AS rto
       FROM address_slots s JOIN networks n ON n.id = s.network_id
       LEFT JOIN release_requests r ON r.slot_id = s.id AND r.status IN ('requested','evidenced')
       WHERE s.interface_id = ? ORDER BY s.ip`,
    )
    .all(interfaceId) as (Omit<SlotView, 'ip' | 'openRequest'> & { ip: number; rid: string | null; rkind: string; rstatus: string; rversion: number; rto: string | null })[];
  return rows.map(({ rid, rkind, rstatus, rversion, rto, ...r }) => ({
    ...r,
    ip: formatIp(r.ip),
    openRequest: rid ? { id: rid, kind: rkind, status: rstatus, version: rversion, toInterfaceId: rto } : null,
  }));
}

export function lastPhysicalCheck(db: Db, assetId: string): { checkedAt: string; source: string; locationId: string | null } | null {
  return (
    (db
      .prepare(
        `SELECT checked_at AS checkedAt, source, location_id AS locationId FROM physical_checks
         WHERE asset_id = ? AND voided_at IS NULL ORDER BY checked_at DESC, rowid DESC LIMIT 1`,
      )
      .get(assetId) as { checkedAt: string; source: string; locationId: string | null } | undefined) ?? null
  );
}

export function getAssetDetail(db: Db, id: string) {
  const asset = db.prepare(`SELECT ${ASSET_COLS} FROM assets WHERE id = ?`).get(id) as AssetRow | undefined;
  if (!asset) return null;
  const location = listLocations(db).find((l) => l.id === asset.locationId)!;
  const assignment = db
    .prepare(
      `SELECT a.id, a.person_id AS personId, p.display_name AS personName, p.status AS personStatus, a.role, a.started_at AS startedAt
       FROM assignments a JOIN people p ON p.id = a.person_id WHERE a.asset_id = ? AND a.ended_at IS NULL`,
    )
    .get(id) as { id: string; personId: string; personName: string; personStatus: string; role: string; startedAt: string } | undefined;
  const loan = db
    .prepare(
      `SELECT l.id, l.borrower_id AS borrowerId, p.display_name AS borrowerName, l.loaned_at AS loanedAt, l.due_on AS dueOn,
         l.from_location_id AS fromLocationId, l.purpose
       FROM loans l JOIN people p ON p.id = l.borrower_id WHERE l.asset_id = ? AND l.returned_at IS NULL`,
    )
    .get(id) as Record<string, unknown> | undefined;
  const repair = db
    .prepare('SELECT id, symptom, vendor, received_on AS receivedOn FROM repairs WHERE asset_id = ? AND completed_on IS NULL')
    .get(id) as Record<string, unknown> | undefined;
  const interfaces = (db.prepare(`SELECT ${INTERFACE_COLS} FROM interfaces WHERE asset_id = ? ORDER BY created_at, id`).all(id) as InterfaceRow[]).map((i) => ({
    ...i,
    slots: slotsOfInterface(db, i.id),
  }));
  const tasks = db
    .prepare("SELECT id, kind, detail_json AS detailJson, created_at AS createdAt, version FROM tasks WHERE asset_id = ? AND status = 'open' ORDER BY created_at")
    .all(id) as { id: string; kind: string; detailJson: string; createdAt: string; version: number }[];
  return {
    asset,
    location: { id: location.id, name: location.name, path: location.path, isUnspecified: location.isUnspecified },
    assignment: assignment ?? null,
    loan: loan ?? null,
    repair: repair ?? null,
    interfaces,
    lastPhysicalCheck: lastPhysicalCheck(db, id),
    openTasks: tasks.map(({ detailJson, ...t }) => ({ ...t, detail: JSON.parse(detailJson) as Record<string, unknown> })),
  };
}

export interface HistoryEntry {
  eventId: string;
  revision: number;
  recordedAt: string;
  occurredAt: string | null;
  actor: string;
  eventType: string;
  entityType: string;
  entityId: string;
  before: unknown;
  after: unknown;
  reason: string | null;
  correctsEventId: string | null;
  correctedBy: string[];
}

/** Chronological history of an asset including its interfaces' and addresses' events. */
export function getAssetHistory(db: Db, assetId: string): HistoryEntry[] {
  const rows = db
    .prepare(
      `SELECT e.event_id AS eventId, e.revision, e.recorded_at AS recordedAt, e.occurred_at AS occurredAt, e.actor, e.event_type AS eventType,
         e.entity_type AS entityType, e.entity_id AS entityId, e.before_json AS beforeJson, e.after_json AS afterJson, e.reason,
         e.corrects_event_id AS correctsEventId
       FROM audit_events e
       WHERE (e.entity_type = 'asset' AND e.entity_id = @id)
          OR (e.entity_type = 'interface' AND e.entity_id IN (SELECT id FROM interfaces WHERE asset_id = @id))
          OR (e.entity_type = 'address' AND json_extract(e.after_json, '$.assetId') = @id)
          OR (e.entity_type = 'address' AND json_extract(e.before_json, '$.assetId') = @id)
          OR (e.entity_type = 'address' AND json_extract(e.after_json, '$.toAssetId') = @id)
          OR (e.entity_type = 'event' AND e.corrects_event_id IN (SELECT event_id FROM audit_events WHERE entity_type = 'asset' AND entity_id = @id))
       ORDER BY e.seq`,
    )
    .all({ id: assetId }) as (Omit<HistoryEntry, 'before' | 'after' | 'correctedBy'> & { beforeJson: string | null; afterJson: string | null })[];
  const corrections = new Map<string, string[]>();
  for (const r of rows) if (r.correctsEventId) corrections.set(r.correctsEventId, [...(corrections.get(r.correctsEventId) ?? []), r.eventId]);
  return rows.map(({ beforeJson, afterJson, ...r }) => ({
    ...r,
    before: beforeJson ? JSON.parse(beforeJson) : null,
    after: afterJson ? JSON.parse(afterJson) : null,
    correctedBy: corrections.get(r.eventId) ?? [],
  }));
}

export function assetCounts(db: Db) {
  const total = (db.prepare('SELECT COUNT(*) AS n FROM assets').get() as { n: number }).n;
  const notDisposed = (db.prepare("SELECT COUNT(*) AS n FROM assets WHERE lifecycle <> 'disposed'").get() as { n: number }).n;
  const usable = (db.prepare("SELECT COUNT(*) AS n FROM assets WHERE lifecycle = 'ready' AND loss_status = 'none'").get() as { n: number }).n;
  const byKind = Object.fromEntries(
    (db.prepare("SELECT kind, COUNT(*) AS n FROM assets WHERE lifecycle <> 'disposed' GROUP BY kind").all() as { kind: string; n: number }[]).map((r) => [r.kind, r.n]),
  );
  const byLifecycle = Object.fromEntries(
    (db.prepare('SELECT lifecycle, COUNT(*) AS n FROM assets GROUP BY lifecycle').all() as { lifecycle: string; n: number }[]).map((r) => [r.lifecycle, r.n]),
  );
  return { registeredTotal: total, notDisposed, usable, byKind, byLifecycle };
}

/** Candidates that share an official number or serial. Shown for review; never merged automatically. */
export function findDuplicateCandidates(db: Db, key: { serial?: string | null; officialNo?: string | null }): { id: string; serial: string | null; officialNo: string | null }[] {
  const out = new Map<string, { id: string; serial: string | null; officialNo: string | null }>();
  if (key.serial) for (const r of db.prepare('SELECT id, serial, official_no AS officialNo FROM assets WHERE serial = ?').all(key.serial) as { id: string; serial: string | null; officialNo: string | null }[]) out.set(r.id, r);
  if (key.officialNo) for (const r of db.prepare('SELECT id, serial, official_no AS officialNo FROM assets WHERE official_no = ?').all(key.officialNo) as { id: string; serial: string | null; officialNo: string | null }[]) out.set(r.id, r);
  return [...out.values()];
}

export function personDetail(db: Db, id: string) {
  const person = db.prepare(`SELECT ${PERSON_COLS} FROM people WHERE id = ?`).get(id) as PersonRow | undefined;
  if (!person) return null;
  const assignments = db
    .prepare(
      `SELECT a.id, a.asset_id AS assetId, a.role, a.started_at AS startedAt, a.ended_at AS endedAt, a.end_reason AS endReason,
         s.kind, s.model, s.official_no AS officialNo
       FROM assignments a JOIN assets s ON s.id = a.asset_id WHERE a.person_id = ? ORDER BY a.started_at DESC`,
    )
    .all(id);
  const loans = db
    .prepare(
      `SELECT l.id, l.asset_id AS assetId, l.loaned_at AS loanedAt, l.due_on AS dueOn, l.returned_at AS returnedAt, s.kind, s.model, s.official_no AS officialNo
       FROM loans l JOIN assets s ON s.id = l.asset_id WHERE l.borrower_id = ? ORDER BY l.loaned_at DESC`,
    )
    .all(id);
  return { person, assignments, loans };
}
