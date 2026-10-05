import { newId } from './ids.js';
import { ATTACHMENTS, IMPORTS, INVENTORY, NETWORK, PEOPLE_LOCATIONS_ASSETS } from './domain/schema-sql.js';
import type { Db } from './sqlite.js';

// Dataset schema. The product is unreleased, so schema version 1 is still being completed;
// every table belongs to exactly one dataset generation file.
export const APP_ID = 'school-asset-desktop';
export const SCHEMA_VERSION = 1;

const CORE = `
CREATE TABLE dataset_meta (key TEXT PRIMARY KEY, value TEXT NOT NULL) STRICT;

CREATE TABLE command_receipts (
  command_id TEXT PRIMARY KEY,
  request_hash TEXT NOT NULL,
  command_type TEXT NOT NULL,
  result_json TEXT NOT NULL,
  revision INTEGER NOT NULL,
  actor TEXT NOT NULL,
  committed_at TEXT NOT NULL
) STRICT;
CREATE TRIGGER receipts_append_only_u BEFORE UPDATE ON command_receipts BEGIN SELECT RAISE(ABORT, 'append-only'); END;
CREATE TRIGGER receipts_append_only_d BEFORE DELETE ON command_receipts BEGIN SELECT RAISE(ABORT, 'append-only'); END;

CREATE TABLE audit_events (
  seq INTEGER PRIMARY KEY AUTOINCREMENT,
  event_id TEXT NOT NULL UNIQUE,
  revision INTEGER NOT NULL,
  command_id TEXT NOT NULL,
  correlation_id TEXT NOT NULL,
  actor TEXT NOT NULL,
  recorded_at TEXT NOT NULL,
  occurred_at TEXT,
  event_type TEXT NOT NULL,
  entity_type TEXT NOT NULL,
  entity_id TEXT NOT NULL,
  before_json TEXT,
  after_json TEXT,
  reason TEXT,
  corrects_event_id TEXT REFERENCES audit_events(event_id)
) STRICT;
CREATE INDEX audit_by_entity ON audit_events(entity_type, entity_id, seq);
CREATE INDEX audit_by_revision ON audit_events(revision);
CREATE TRIGGER audit_append_only_u BEFORE UPDATE ON audit_events BEGIN SELECT RAISE(ABORT, 'append-only'); END;
CREATE TRIGGER audit_append_only_d BEFORE DELETE ON audit_events BEGIN SELECT RAISE(ABORT, 'append-only'); END;

CREATE TABLE settings (key TEXT PRIMARY KEY, value_json TEXT NOT NULL, version INTEGER NOT NULL) STRICT;
`;

/** Domain tables, added story by story. Order matters for foreign keys. */
const DOMAIN: string[] = [PEOPLE_LOCATIONS_ASSETS, NETWORK, INVENTORY, IMPORTS, ATTACHMENTS];

export function datasetSchemaSql(): string {
  return [CORE, ...DOMAIN].join('\n');
}

/** Rows every dataset starts with: the explicit '미지정' (unspecified) location. */
export function seedDataset(db: Db, now: string): void {
  db.prepare("INSERT INTO locations VALUES (?, '미지정', NULL, 1, 'active', 1, ?, ?)").run(newId(), now, now);
}
