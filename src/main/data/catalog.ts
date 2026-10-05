import fs from 'node:fs';
import path from 'node:path';
import { newId } from './ids.js';
import { openDatabase, type Db } from './sqlite.js';

export const CATALOG_FILE = 'catalog.sqlite';
export const GENERATIONS_DIR = 'generations';
export const DATASET_FILE = 'dataset.sqlite';

export type GenerationState = 'staging' | 'ready' | 'active' | 'retained' | 'discarded' | 'deleted';

export interface Generation {
  id: string;
  datasetId: string;
  state: GenerationState;
  createdAt: string;
  source: string;
  detail: Record<string, unknown>;
}

export interface ActivePointer {
  generationId: string;
  epoch: string;
  previousGenerationId: string | null;
  switchedAt: string;
}

export interface JournalEntry {
  seq: number;
  jobId: string;
  kind: string;
  step: string;
  status: string;
  generationId: string | null;
  detail: Record<string, unknown>;
  recordedAt: string;
}

const CATALOG_SCHEMA = `
CREATE TABLE IF NOT EXISTS catalog_meta (key TEXT PRIMARY KEY, value TEXT NOT NULL) STRICT;
CREATE TABLE IF NOT EXISTS generations (
  id TEXT PRIMARY KEY,
  dataset_id TEXT NOT NULL,
  state TEXT NOT NULL CHECK (state IN ('staging','ready','active','retained','discarded','deleted')),
  created_at TEXT NOT NULL,
  source TEXT NOT NULL,
  detail_json TEXT NOT NULL DEFAULT '{}'
) STRICT;
CREATE UNIQUE INDEX IF NOT EXISTS one_active_generation ON generations(state) WHERE state = 'active';
CREATE TABLE IF NOT EXISTS active_pointer (
  singleton INTEGER PRIMARY KEY CHECK (singleton = 1),
  generation_id TEXT NOT NULL REFERENCES generations(id),
  epoch TEXT NOT NULL,
  previous_generation_id TEXT REFERENCES generations(id),
  switched_at TEXT NOT NULL
) STRICT;
CREATE TABLE IF NOT EXISTS maintenance_journal (
  seq INTEGER PRIMARY KEY AUTOINCREMENT,
  job_id TEXT NOT NULL,
  kind TEXT NOT NULL,
  step TEXT NOT NULL,
  status TEXT NOT NULL,
  generation_id TEXT,
  detail_json TEXT NOT NULL DEFAULT '{}',
  recorded_at TEXT NOT NULL
) STRICT;
CREATE TRIGGER IF NOT EXISTS journal_append_only_u BEFORE UPDATE ON maintenance_journal BEGIN SELECT RAISE(ABORT, 'append-only'); END;
CREATE TRIGGER IF NOT EXISTS journal_append_only_d BEFORE DELETE ON maintenance_journal BEGIN SELECT RAISE(ABORT, 'append-only'); END;
CREATE TABLE IF NOT EXISTS local_settings (key TEXT PRIMARY KEY, value_json TEXT NOT NULL) STRICT;
`;

interface GenerationRow {
  id: string;
  dataset_id: string;
  state: GenerationState;
  created_at: string;
  source: string;
  detail_json: string;
}

const toGeneration = (r: GenerationRow): Generation => ({
  id: r.id,
  datasetId: r.dataset_id,
  state: r.state,
  createdAt: r.created_at,
  source: r.source,
  detail: JSON.parse(r.detail_json) as Record<string, unknown>,
});

/**
 * Independent catalog of data generations. The active pointer and epoch live here, not in any
 * dataset, so restoring an old backup can never bring back an old epoch.
 */
export class Catalog {
  private constructor(
    readonly root: string,
    readonly db: Db,
    private readonly now: () => string,
  ) {}

  static open(root: string, now: () => string): Catalog {
    fs.mkdirSync(path.join(root, GENERATIONS_DIR), { recursive: true });
    const db = openDatabase(path.join(root, CATALOG_FILE));
    db.exec(CATALOG_SCHEMA);
    db.prepare("INSERT OR IGNORE INTO catalog_meta VALUES ('format', 'school-asset-catalog/1')").run();
    return new Catalog(root, db, now);
  }

  close(): void {
    this.db.close();
  }

  generationDir(id: string): string {
    return path.join(this.root, GENERATIONS_DIR, id);
  }

  datasetFile(id: string): string {
    return path.join(this.generationDir(id), DATASET_FILE);
  }

  generations(): Generation[] {
    return (this.db.prepare('SELECT * FROM generations ORDER BY created_at, rowid').all() as GenerationRow[]).map(toGeneration);
  }

  generation(id: string): Generation | null {
    const row = this.db.prepare('SELECT * FROM generations WHERE id = ?').get(id) as GenerationRow | undefined;
    return row ? toGeneration(row) : null;
  }

  active(): ActivePointer | null {
    const row = this.db.prepare('SELECT * FROM active_pointer WHERE singleton = 1').get() as
      | { generation_id: string; epoch: string; previous_generation_id: string | null; switched_at: string }
      | undefined;
    return row
      ? { generationId: row.generation_id, epoch: row.epoch, previousGenerationId: row.previous_generation_id, switchedAt: row.switched_at }
      : null;
  }

  createGeneration(input: { datasetId: string; source: string; detail?: Record<string, unknown>; id?: string }): Generation {
    const id = input.id ?? newId();
    fs.mkdirSync(this.generationDir(id), { recursive: true });
    this.db
      .prepare("INSERT INTO generations VALUES (?, ?, 'staging', ?, ?, ?)")
      .run(id, input.datasetId, this.now(), input.source, JSON.stringify(input.detail ?? {}));
    return this.generation(id)!;
  }

  setState(id: string, state: Exclude<GenerationState, 'active'>): void {
    this.db.prepare('UPDATE generations SET state = ? WHERE id = ?').run(state, id);
  }

  /**
   * Atomically makes `id` the active generation with a brand-new epoch. The previously active
   * generation is kept as 'retained' and becomes the rollback target.
   */
  activate(id: string): ActivePointer {
    const epoch = newId();
    this.db
      .transaction(() => {
        const current = this.active();
        const previous = current && current.generationId !== id ? current.generationId : (current?.previousGenerationId ?? null);
        if (current && current.generationId !== id) {
          this.db.prepare("UPDATE generations SET state = 'retained' WHERE id = ?").run(current.generationId);
        }
        this.db.prepare("UPDATE generations SET state = 'active' WHERE id = ?").run(id);
        this.db
          .prepare(
            `INSERT INTO active_pointer VALUES (1, ?, ?, ?, ?)
             ON CONFLICT(singleton) DO UPDATE SET generation_id = excluded.generation_id, epoch = excluded.epoch,
               previous_generation_id = excluded.previous_generation_id, switched_at = excluded.switched_at`,
          )
          .run(id, epoch, previous, this.now());
      })
      .immediate();
    return this.active()!;
  }

  journal(entry: {
    jobId: string;
    kind: string;
    step: string;
    status: string;
    generationId?: string | null;
    detail?: Record<string, unknown>;
  }): void {
    this.db
      .prepare(
        'INSERT INTO maintenance_journal (job_id, kind, step, status, generation_id, detail_json, recorded_at) VALUES (?, ?, ?, ?, ?, ?, ?)',
      )
      .run(entry.jobId, entry.kind, entry.step, entry.status, entry.generationId ?? null, JSON.stringify(entry.detail ?? {}), this.now());
  }

  journalEntries(jobId?: string): JournalEntry[] {
    const rows = (
      jobId
        ? this.db.prepare('SELECT * FROM maintenance_journal WHERE job_id = ? ORDER BY seq').all(jobId)
        : this.db.prepare('SELECT * FROM maintenance_journal ORDER BY seq').all()
    ) as {
      seq: number;
      job_id: string;
      kind: string;
      step: string;
      status: string;
      generation_id: string | null;
      detail_json: string;
      recorded_at: string;
    }[];
    return rows.map((r) => ({
      seq: r.seq,
      jobId: r.job_id,
      kind: r.kind,
      step: r.step,
      status: r.status,
      generationId: r.generation_id,
      detail: JSON.parse(r.detail_json) as Record<string, unknown>,
      recordedAt: r.recorded_at,
    }));
  }

  getLocal<T>(key: string): T | null {
    const row = this.db.prepare('SELECT value_json FROM local_settings WHERE key = ?').get(key) as { value_json: string } | undefined;
    return row ? (JSON.parse(row.value_json) as T) : null;
  }

  setLocal(key: string, value: unknown): void {
    this.db
      .prepare('INSERT INTO local_settings VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value_json = excluded.value_json')
      .run(key, JSON.stringify(value));
  }
}
