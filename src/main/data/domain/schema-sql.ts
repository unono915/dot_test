// Domain tables. Current-state rows carry `version` for optimistic locking; history lives in
// period tables (ended_at) and in audit_events. Nothing here is ever hard-deleted by commands.

export const PEOPLE_LOCATIONS_ASSETS = `
CREATE TABLE people (
  id TEXT PRIMARY KEY,
  display_name TEXT NOT NULL,
  department TEXT,
  title TEXT,
  status TEXT NOT NULL CHECK (status IN ('active','inactive')),
  version INTEGER NOT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
) STRICT;
CREATE INDEX people_by_name ON people(display_name);

CREATE TABLE locations (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  parent_id TEXT REFERENCES locations(id),
  is_unspecified INTEGER NOT NULL DEFAULT 0 CHECK (is_unspecified IN (0,1)),
  status TEXT NOT NULL CHECK (status IN ('active','inactive')),
  version INTEGER NOT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  CHECK (parent_id IS NULL OR parent_id <> id)
) STRICT;
CREATE UNIQUE INDEX one_unspecified_location ON locations(is_unspecified) WHERE is_unspecified = 1;

CREATE TABLE assets (
  id TEXT PRIMARY KEY,
  kind TEXT NOT NULL CHECK (kind IN ('laptop','desktop','monitor','other')),
  manufacturer TEXT,
  model TEXT,
  serial TEXT,
  official_no TEXT,
  ownership TEXT,
  acquired_on TEXT,
  acquisition_source TEXT,
  warranty_until TEXT,
  lifecycle TEXT NOT NULL CHECK (lifecycle IN ('ready','in_repair','retired','disposed')),
  loss_status TEXT NOT NULL CHECK (loss_status IN ('none','confirmed')),
  location_id TEXT NOT NULL REFERENCES locations(id),
  memo TEXT,
  version INTEGER NOT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
) STRICT;
CREATE INDEX assets_by_location ON assets(location_id);
CREATE INDEX assets_by_serial ON assets(serial) WHERE serial IS NOT NULL;
CREATE INDEX assets_by_official_no ON assets(official_no) WHERE official_no IS NOT NULL;

CREATE TABLE assignments (
  id TEXT PRIMARY KEY,
  asset_id TEXT NOT NULL REFERENCES assets(id),
  person_id TEXT NOT NULL REFERENCES people(id),
  role TEXT NOT NULL CHECK (role IN ('user','custodian')),
  started_at TEXT NOT NULL,
  ended_at TEXT,
  end_reason TEXT CHECK (end_reason IS NULL OR end_reason IN ('returned','reassigned','lost','disposed','other')),
  start_event_id TEXT NOT NULL,
  end_event_id TEXT
) STRICT;
CREATE UNIQUE INDEX one_open_assignment ON assignments(asset_id) WHERE ended_at IS NULL;
CREATE INDEX assignments_by_person ON assignments(person_id) WHERE ended_at IS NULL;

CREATE TABLE loans (
  id TEXT PRIMARY KEY,
  asset_id TEXT NOT NULL REFERENCES assets(id),
  borrower_id TEXT NOT NULL REFERENCES people(id),
  from_location_id TEXT NOT NULL REFERENCES locations(id),
  loaned_at TEXT NOT NULL,
  due_on TEXT NOT NULL,
  returned_at TEXT,
  return_location_id TEXT REFERENCES locations(id),
  end_reason TEXT CHECK (end_reason IS NULL OR end_reason IN ('returned','lost')),
  purpose TEXT,
  start_event_id TEXT NOT NULL,
  end_event_id TEXT
) STRICT;
CREATE UNIQUE INDEX one_open_loan ON loans(asset_id) WHERE returned_at IS NULL;

CREATE TABLE repairs (
  id TEXT PRIMARY KEY,
  asset_id TEXT NOT NULL REFERENCES assets(id),
  symptom TEXT NOT NULL,
  vendor TEXT,
  received_on TEXT NOT NULL,
  completed_on TEXT,
  result TEXT,
  cost INTEGER,
  start_event_id TEXT NOT NULL,
  end_event_id TEXT
) STRICT;
CREATE UNIQUE INDEX one_open_repair ON repairs(asset_id) WHERE completed_on IS NULL;

CREATE TABLE physical_checks (
  id TEXT PRIMARY KEY,
  asset_id TEXT NOT NULL REFERENCES assets(id),
  checked_at TEXT NOT NULL,
  location_id TEXT REFERENCES locations(id),
  source TEXT NOT NULL CHECK (source IN ('manual','inventory','loss_recovery')),
  source_id TEXT,
  voided_at TEXT,
  event_id TEXT NOT NULL
) STRICT;
CREATE INDEX physical_checks_by_asset ON physical_checks(asset_id, checked_at);

CREATE TABLE tasks (
  id TEXT PRIMARY KEY,
  kind TEXT NOT NULL CHECK (kind IN ('network_check')),
  asset_id TEXT NOT NULL REFERENCES assets(id),
  status TEXT NOT NULL CHECK (status IN ('open','resolved')),
  detail_json TEXT NOT NULL DEFAULT '{}',
  created_at TEXT NOT NULL,
  created_event_id TEXT NOT NULL,
  resolved_at TEXT,
  resolution TEXT,
  version INTEGER NOT NULL
) STRICT;
CREATE INDEX open_tasks ON tasks(asset_id) WHERE status = 'open';
`;

export const NETWORK = `
CREATE TABLE interfaces (
  id TEXT PRIMARY KEY,
  asset_id TEXT NOT NULL REFERENCES assets(id),
  kind TEXT NOT NULL CHECK (kind IN ('ethernet','wifi','other')),
  label TEXT NOT NULL,
  mac TEXT,
  status TEXT NOT NULL CHECK (status IN ('enabled','disabled')),
  version INTEGER NOT NULL,
  created_at TEXT NOT NULL
) STRICT;
CREATE INDEX interfaces_by_asset ON interfaces(asset_id);
CREATE INDEX interfaces_by_mac ON interfaces(mac) WHERE mac IS NOT NULL;

CREATE TABLE networks (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('active','inactive')),
  version INTEGER NOT NULL,
  created_at TEXT NOT NULL
) STRICT;

CREATE TABLE network_aliases (
  id TEXT PRIMARY KEY,
  network_id TEXT NOT NULL REFERENCES networks(id),
  alias TEXT NOT NULL UNIQUE COLLATE NOCASE
) STRICT;

CREATE TABLE subnets (
  id TEXT PRIMARY KEY,
  network_id TEXT NOT NULL REFERENCES networks(id),
  base INTEGER NOT NULL CHECK (base >= 0 AND base <= 4294967295),
  prefix INTEGER NOT NULL CHECK (prefix BETWEEN 0 AND 32),
  last INTEGER NOT NULL,
  gateway INTEGER,
  dns_json TEXT NOT NULL DEFAULT '[]',
  version INTEGER NOT NULL,
  created_at TEXT NOT NULL,
  CHECK (last >= base)
) STRICT;
CREATE INDEX subnets_by_range ON subnets(base, last);

CREATE TABLE address_ranges (
  id TEXT PRIMARY KEY,
  subnet_id TEXT NOT NULL REFERENCES subnets(id),
  kind TEXT NOT NULL CHECK (kind IN ('static','dhcp','exclusion')),
  first INTEGER NOT NULL,
  last INTEGER NOT NULL,
  note TEXT,
  CHECK (last >= first)
) STRICT;
CREATE INDEX ranges_by_subnet ON address_ranges(subnet_id);

CREATE TABLE address_slots (
  id TEXT PRIMARY KEY,
  network_id TEXT NOT NULL REFERENCES networks(id),
  ip INTEGER NOT NULL CHECK (ip >= 0 AND ip <= 4294967295),
  state TEXT NOT NULL CHECK (state IN ('unassigned','reserved','active','pending_release','excluded')),
  prior_state TEXT CHECK (prior_state IS NULL OR prior_state IN ('reserved','active')),
  interface_id TEXT REFERENCES interfaces(id),
  note TEXT,
  version INTEGER NOT NULL,
  UNIQUE (network_id, ip),
  CHECK ((state IN ('reserved','active','pending_release')) = (interface_id IS NOT NULL)),
  CHECK ((state = 'pending_release') = (prior_state IS NOT NULL))
) STRICT;
CREATE INDEX slots_by_interface ON address_slots(interface_id) WHERE interface_id IS NOT NULL;

CREATE TABLE slot_bindings (
  id TEXT PRIMARY KEY,
  slot_id TEXT NOT NULL REFERENCES address_slots(id),
  interface_id TEXT NOT NULL REFERENCES interfaces(id),
  started_at TEXT NOT NULL,
  ended_at TEXT,
  start_event_id TEXT NOT NULL,
  end_event_id TEXT
) STRICT;
CREATE UNIQUE INDEX one_open_binding ON slot_bindings(slot_id) WHERE ended_at IS NULL;

CREATE TABLE release_requests (
  id TEXT PRIMARY KEY,
  slot_id TEXT NOT NULL REFERENCES address_slots(id),
  kind TEXT NOT NULL CHECK (kind IN ('release','transfer')),
  from_interface_id TEXT NOT NULL REFERENCES interfaces(id),
  to_interface_id TEXT REFERENCES interfaces(id),
  reason TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('requested','evidenced','completed','cancelled')),
  requested_at TEXT NOT NULL,
  evidence_kind TEXT,
  evidence_note TEXT,
  evidence_checked_at TEXT,
  evidence_actor TEXT,
  closed_at TEXT,
  version INTEGER NOT NULL,
  CHECK ((kind = 'transfer') = (to_interface_id IS NOT NULL))
) STRICT;
CREATE UNIQUE INDEX one_open_request_per_slot ON release_requests(slot_id) WHERE status IN ('requested','evidenced');

CREATE TABLE observation_sessions (
  id TEXT PRIMARY KEY,
  label TEXT NOT NULL,
  window_start TEXT NOT NULL,
  window_end TEXT NOT NULL,
  source TEXT NOT NULL,
  import_run_id TEXT,
  created_at TEXT NOT NULL,
  CHECK (window_end >= window_start)
) STRICT;

CREATE TABLE observations (
  id TEXT PRIMARY KEY,
  session_id TEXT NOT NULL REFERENCES observation_sessions(id),
  network_id TEXT NOT NULL REFERENCES networks(id),
  ip INTEGER NOT NULL,
  mac TEXT,
  asset_id TEXT REFERENCES assets(id),
  observed_at TEXT NOT NULL,
  recorded_at TEXT NOT NULL,
  source TEXT NOT NULL,
  raw TEXT,
  supersedes_id TEXT REFERENCES observations(id)
) STRICT;
CREATE INDEX observations_by_session_ip ON observations(session_id, network_id, ip);
CREATE TRIGGER observations_immutable BEFORE UPDATE ON observations BEGIN SELECT RAISE(ABORT, 'append-only'); END;
CREATE TRIGGER observations_no_delete BEFORE DELETE ON observations BEGIN SELECT RAISE(ABORT, 'append-only'); END;
`;

export const INVENTORY = `
CREATE TABLE inventory_sessions (
  id TEXT PRIMARY KEY,
  title TEXT NOT NULL,
  scope_json TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('open','closed')),
  started_at TEXT NOT NULL,
  base_revision INTEGER NOT NULL,
  closed_at TEXT,
  close_summary_json TEXT,
  version INTEGER NOT NULL
) STRICT;
CREATE UNIQUE INDEX one_open_inventory ON inventory_sessions(status) WHERE status = 'open';

CREATE TABLE inventory_items (
  session_id TEXT NOT NULL REFERENCES inventory_sessions(id),
  asset_id TEXT NOT NULL REFERENCES assets(id),
  base_location_id TEXT NOT NULL REFERENCES locations(id),
  base_person_id TEXT REFERENCES people(id),
  base_lifecycle TEXT NOT NULL,
  base_version INTEGER NOT NULL,
  PRIMARY KEY (session_id, asset_id)
) STRICT;

CREATE TABLE inventory_results (
  id TEXT PRIMARY KEY,
  session_id TEXT NOT NULL REFERENCES inventory_sessions(id),
  asset_id TEXT NOT NULL,
  result TEXT NOT NULL CHECK (result IN ('matched','mismatched','not_found')),
  found_location_id TEXT REFERENCES locations(id),
  found_person_id TEXT REFERENCES people(id),
  checked_at TEXT NOT NULL,
  recorded_at TEXT NOT NULL,
  actor TEXT NOT NULL,
  note TEXT,
  supersedes_id TEXT REFERENCES inventory_results(id),
  event_id TEXT NOT NULL,
  FOREIGN KEY (session_id, asset_id) REFERENCES inventory_items(session_id, asset_id)
) STRICT;
CREATE INDEX inventory_results_by_item ON inventory_results(session_id, asset_id);

CREATE TABLE inventory_extras (
  id TEXT PRIMARY KEY,
  session_id TEXT NOT NULL REFERENCES inventory_sessions(id),
  asset_id TEXT REFERENCES assets(id),
  description TEXT NOT NULL,
  found_location_id TEXT REFERENCES locations(id),
  checked_at TEXT NOT NULL,
  event_id TEXT NOT NULL
) STRICT;

CREATE TABLE inventory_notes (
  id TEXT PRIMARY KEY,
  session_id TEXT NOT NULL REFERENCES inventory_sessions(id),
  note TEXT NOT NULL,
  recorded_at TEXT NOT NULL,
  event_id TEXT NOT NULL
) STRICT;

CREATE TABLE inventory_links (
  id TEXT PRIMARY KEY,
  session_id TEXT NOT NULL REFERENCES inventory_sessions(id),
  asset_id TEXT NOT NULL,
  result_id TEXT REFERENCES inventory_results(id),
  event_id TEXT NOT NULL,
  note TEXT,
  recorded_at TEXT NOT NULL
) STRICT;
`;

export const IMPORTS = `
CREATE TABLE import_runs (
  id TEXT PRIMARY KEY,
  source_namespace TEXT NOT NULL,
  file_hash TEXT NOT NULL,
  file_name TEXT NOT NULL,
  mapping_hash TEXT NOT NULL,
  decisions_hash TEXT NOT NULL,
  preview_revision INTEGER NOT NULL,
  applied_at TEXT NOT NULL,
  counts_json TEXT NOT NULL,
  excluded_json TEXT NOT NULL,
  observation_session_id TEXT REFERENCES observation_sessions(id)
) STRICT;
CREATE INDEX import_runs_by_source ON import_runs(source_namespace, file_hash);

CREATE TABLE import_row_keys (
  source_namespace TEXT NOT NULL,
  row_key TEXT NOT NULL,
  entity_type TEXT NOT NULL,
  entity_id TEXT NOT NULL,
  content_hash TEXT NOT NULL,
  run_id TEXT NOT NULL REFERENCES import_runs(id),
  PRIMARY KEY (source_namespace, row_key, entity_type)
) STRICT;
`;

export const ATTACHMENTS = `
CREATE TABLE attachments (
  id TEXT PRIMARY KEY,
  sha256 TEXT NOT NULL CHECK (length(sha256) = 64),
  size INTEGER NOT NULL CHECK (size > 0),
  mime TEXT NOT NULL CHECK (mime IN ('application/pdf','image/png','image/jpeg','application/vnd.openxmlformats-officedocument.spreadsheetml.sheet')),
  ext TEXT NOT NULL CHECK (ext IN ('pdf','png','jpg','xlsx')),
  display_name TEXT NOT NULL,
  created_at TEXT NOT NULL,
  event_id TEXT NOT NULL
) STRICT;
CREATE INDEX attachments_by_hash ON attachments(sha256);
CREATE TRIGGER attachments_immutable BEFORE UPDATE ON attachments BEGIN SELECT RAISE(ABORT, 'append-only'); END;
CREATE TRIGGER attachments_no_delete BEFORE DELETE ON attachments BEGIN SELECT RAISE(ABORT, 'append-only'); END;

CREATE TABLE attachment_links (
  id TEXT PRIMARY KEY,
  attachment_id TEXT NOT NULL REFERENCES attachments(id),
  entity_type TEXT NOT NULL CHECK (entity_type IN ('asset','person','location','inventory','network')),
  entity_id TEXT NOT NULL,
  linked_at TEXT NOT NULL,
  link_event_id TEXT NOT NULL,
  unlinked_at TEXT,
  unlink_event_id TEXT,
  unlink_reason TEXT
) STRICT;
CREATE INDEX attachment_links_by_entity ON attachment_links(entity_type, entity_id);
`;
