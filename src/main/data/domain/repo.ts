import { fail } from '../errors.js';
import type { Db } from '../sqlite.js';

// Row loaders shared by command handlers. Rows are returned in camelCase.

export const violate = (rule: string, message: string, details: Record<string, unknown> = {}): never =>
  fail('RULE_VIOLATION', message, { rule, ...details });

export interface PersonRow {
  id: string;
  displayName: string;
  department: string | null;
  title: string | null;
  status: 'active' | 'inactive';
  version: number;
}

export interface LocationRow {
  id: string;
  name: string;
  parentId: string | null;
  isUnspecified: boolean;
  status: 'active' | 'inactive';
  version: number;
}

export type Lifecycle = 'ready' | 'in_repair' | 'retired' | 'disposed';

export interface AssetRow {
  id: string;
  kind: 'laptop' | 'desktop' | 'monitor' | 'other';
  manufacturer: string | null;
  model: string | null;
  serial: string | null;
  officialNo: string | null;
  ownership: string | null;
  acquiredOn: string | null;
  acquisitionSource: string | null;
  warrantyUntil: string | null;
  lifecycle: Lifecycle;
  lossStatus: 'none' | 'confirmed';
  locationId: string;
  memo: string | null;
  version: number;
  createdAt: string;
  updatedAt: string;
}

export interface InterfaceRow {
  id: string;
  assetId: string;
  kind: 'ethernet' | 'wifi' | 'other';
  label: string;
  mac: string | null;
  status: 'enabled' | 'disabled';
  version: number;
}

export const PERSON_COLS = 'id, display_name AS displayName, department, title, status, version';
export const LOCATION_COLS = 'id, name, parent_id AS parentId, is_unspecified AS isUnspecified, status, version';
export const ASSET_COLS = `id, kind, manufacturer, model, serial, official_no AS officialNo, ownership, acquired_on AS acquiredOn,
  acquisition_source AS acquisitionSource, warranty_until AS warrantyUntil, lifecycle, loss_status AS lossStatus,
  location_id AS locationId, memo, version, created_at AS createdAt, updated_at AS updatedAt`;
export const INTERFACE_COLS = 'id, asset_id AS assetId, kind, label, mac, status, version';

export function findPerson(db: Db, id: string): PersonRow | null {
  return (db.prepare(`SELECT ${PERSON_COLS} FROM people WHERE id = ?`).get(id) as PersonRow | undefined) ?? null;
}

export function getPerson(db: Db, id: string): PersonRow {
  return findPerson(db, id) ?? fail('NOT_FOUND', '사람을 찾을 수 없습니다.', { entityType: 'person', entityId: id });
}

export function findLocation(db: Db, id: string): LocationRow | null {
  const row = db.prepare(`SELECT ${LOCATION_COLS} FROM locations WHERE id = ?`).get(id) as (Omit<LocationRow, 'isUnspecified'> & { isUnspecified: number }) | undefined;
  return row ? { ...row, isUnspecified: row.isUnspecified === 1 } : null;
}

export function getLocation(db: Db, id: string): LocationRow {
  return findLocation(db, id) ?? fail('NOT_FOUND', '장소를 찾을 수 없습니다.', { entityType: 'location', entityId: id });
}

export function getActiveLocation(db: Db, id: string): LocationRow {
  const loc = getLocation(db, id);
  if (loc.status !== 'active') violate('location_inactive', '비활성 장소에는 둘 수 없습니다.', { locationId: id });
  return loc;
}

export function findAsset(db: Db, id: string): AssetRow | null {
  return (db.prepare(`SELECT ${ASSET_COLS} FROM assets WHERE id = ?`).get(id) as AssetRow | undefined) ?? null;
}

export function getAsset(db: Db, id: string): AssetRow {
  return findAsset(db, id) ?? fail('NOT_FOUND', '자산을 찾을 수 없습니다.', { entityType: 'asset', entityId: id });
}

export function getInterface(db: Db, id: string): InterfaceRow {
  return (
    (db.prepare(`SELECT ${INTERFACE_COLS} FROM interfaces WHERE id = ?`).get(id) as InterfaceRow | undefined) ??
    fail('NOT_FOUND', '인터페이스를 찾을 수 없습니다.', { entityType: 'interface', entityId: id })
  );
}

/** Increments an aggregate's version and updated_at (when the table has it). */
export function bumpAsset(db: Db, id: string, now: string, set: Record<string, unknown> = {}): void {
  const cols = Object.keys(set);
  const assignments = cols.map((c) => `${c} = @${c}`).join(', ');
  db.prepare(`UPDATE assets SET ${assignments}${cols.length ? ', ' : ''}version = version + 1, updated_at = @now WHERE id = @id`).run({ ...set, now, id });
}

export const OCCUPIED_STATES = ['reserved', 'active', 'pending_release'] as const;

/** Address slots currently occupied by any interface of the asset. */
export function occupiedSlotsOfAsset(db: Db, assetId: string): { id: string; ip: number; networkId: string; state: string }[] {
  return db
    .prepare(
      `SELECT s.id, s.ip, s.network_id AS networkId, s.state FROM address_slots s JOIN interfaces i ON i.id = s.interface_id
       WHERE i.asset_id = ? AND s.state IN ('reserved','active','pending_release') ORDER BY s.ip`,
    )
    .all(assetId) as { id: string; ip: number; networkId: string; state: string }[];
}
