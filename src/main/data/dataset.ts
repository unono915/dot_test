import { hashRequest } from './canonical.js';
import type { CommandRegistry, EmittedEvent, TxContext } from './commands.js';
import { DomainError, fail } from './errors.js';
import { isUuid, newId } from './ids.js';
import { APP_ID, SCHEMA_VERSION, datasetSchemaSql, seedDataset } from './schema.js';
import { openDatabase, type Db } from './sqlite.js';

export interface CommandEnvelope {
  datasetId: string;
  epoch: string;
  commandId: string;
  type: string;
  payload: unknown;
  /** Groups the commands of one user workflow (e.g. an import run) in the audit log. */
  correlationId?: string;
}

export interface CommandOutcome<R = unknown> {
  replayed: boolean;
  revision: number;
  result: R;
}

export interface Snapshot<T> {
  datasetId: string;
  epoch: string;
  revision: number;
  data: T;
}

export type FaultStage = 'after-handler' | 'after-audit' | 'after-receipt' | 'before-commit';

/** Test-only failure injection; never reachable from IPC. */
export interface FaultInjector {
  hit(stage: FaultStage): void;
}

export interface ExecuteOptions {
  cancelled?: () => boolean;
  onProgress?: (done: number, total: number) => void;
}

export function createDatasetFile(file: string, datasetId: string, now: string): void {
  const db = openDatabase(file);
  try {
    db.transaction(() => {
      db.exec(datasetSchemaSql());
      const meta = db.prepare('INSERT INTO dataset_meta VALUES (?, ?)');
      meta.run('app_id', APP_ID);
      meta.run('schema_version', String(SCHEMA_VERSION));
      meta.run('dataset_id', datasetId);
      meta.run('revision', '0');
      meta.run('created_at', now);
      seedDataset(db, now);
    })();
  } finally {
    db.close();
  }
}

export function readMeta(db: Db): Record<string, string> {
  const rows = db.prepare('SELECT key, value FROM dataset_meta').all() as { key: string; value: string }[];
  return Object.fromEntries(rows.map((r) => [r.key, r.value]));
}

/**
 * The single writer for one dataset generation. Every write goes through `execute`, which commits
 * the domain change, its audit events, the command receipt and the new revision in one
 * transaction — or nothing at all.
 */
export class DatasetStore {
  readonly datasetId: string;
  #revision: number;
  #maintenance: string | null = null;

  constructor(
    readonly db: Db,
    readonly epoch: string,
    private readonly registry: CommandRegistry,
    private readonly now: () => string,
    private readonly faults?: FaultInjector,
  ) {
    const meta = readMeta(db);
    if (meta.app_id !== APP_ID || Number(meta.schema_version) !== SCHEMA_VERSION || !meta.dataset_id) {
      throw new DomainError('INTEGRITY', '지원하지 않는 데이터 형식입니다.');
    }
    this.datasetId = meta.dataset_id;
    this.#revision = Number(meta.revision);
  }

  static open(file: string, epoch: string, registry: CommandRegistry, now: () => string, faults?: FaultInjector): DatasetStore {
    const db = openDatabase(file, { fileMustExist: true });
    try {
      return new DatasetStore(db, epoch, registry, now, faults);
    } catch (error) {
      db.close();
      throw error;
    }
  }

  get revision(): number {
    return this.#revision;
  }

  get maintenance(): string | null {
    return this.#maintenance;
  }

  close(): void {
    this.db.close();
  }

  /** Blocks new writes until the returned release function is called. */
  beginMaintenance(kind: string): () => void {
    if (this.#maintenance) fail('MAINTENANCE_LOCKED', '다른 관리 작업이 진행 중입니다.', { kind: this.#maintenance });
    this.#maintenance = kind;
    return () => {
      if (this.#maintenance === kind) this.#maintenance = null;
    };
  }

  /** Runs `fn` inside one read transaction so the data and revision come from one snapshot. */
  read<T>(fn: (db: Db) => T): Snapshot<T> {
    return this.db.transaction(() => {
      const revision = Number((this.db.prepare("SELECT value FROM dataset_meta WHERE key = 'revision'").get() as { value: string }).value);
      return { datasetId: this.datasetId, epoch: this.epoch, revision, data: fn(this.db) };
    }).deferred();
  }

  execute<R = unknown>(envelope: CommandEnvelope, actor: string, options: ExecuteOptions = {}): CommandOutcome<R> {
    if (!envelope || typeof envelope !== 'object' || !isUuid(envelope.commandId) || typeof envelope.type !== 'string') {
      fail('VALIDATION', '요청 형식이 올바르지 않습니다.');
    }
    if (this.#maintenance) fail('MAINTENANCE_LOCKED', '백업·복원 등 관리 작업 중에는 변경할 수 없습니다.', { kind: this.#maintenance });
    if (envelope.datasetId !== this.datasetId) fail('DATASET_MISMATCH', '다른 데이터셋의 요청입니다.');
    if (envelope.epoch !== this.epoch) {
      fail('STALE_EPOCH', '데이터가 복원 또는 전환되어 이전 화면의 요청을 적용할 수 없습니다. 새로 불러온 뒤 다시 확인해 주세요.');
    }
    const def = this.registry.get(envelope.type);
    const payload = def.parse(envelope.payload);
    const requestHash = hashRequest(envelope.type, payload);

    const run = this.db.transaction((): CommandOutcome<R> => {
      const receipt = this.db
        .prepare('SELECT request_hash, result_json, revision FROM command_receipts WHERE command_id = ?')
        .get(envelope.commandId) as { request_hash: string; result_json: string; revision: number } | undefined;
      if (receipt) {
        if (receipt.request_hash !== requestHash) fail('COMMAND_ID_REUSED', '같은 작업 번호로 다른 내용을 요청했습니다.');
        return { replayed: true, revision: receipt.revision, result: JSON.parse(receipt.result_json) as R };
      }

      const now = this.now();
      const revision = this.#revision + 1;
      const correlationId = envelope.correlationId ?? envelope.commandId;
      let events = 0;
      const insertEvent = this.db.prepare(
        `INSERT INTO audit_events (event_id, revision, command_id, correlation_id, actor, recorded_at, occurred_at, event_type,
           entity_type, entity_id, before_json, after_json, reason, corrects_event_id)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      );
      const ctx: TxContext = {
        db: this.db,
        now,
        actor,
        commandId: envelope.commandId,
        correlationId,
        revision,
        emit: (e: EmittedEvent) => {
          const id = newId();
          insertEvent.run(
            id, revision, envelope.commandId, correlationId, actor, now, e.occurredAt ?? null, e.eventType, e.entityType, e.entityId,
            e.before === undefined ? null : JSON.stringify(e.before), e.after === undefined ? null : JSON.stringify(e.after),
            e.reason ?? null, e.correctsEventId ?? null,
          );
          events += 1;
          return id;
        },
        expectVersion: (entityType, entityId, actual, expected) => {
          if (actual !== expected) {
            fail('VERSION_CONFLICT', '다른 곳에서 먼저 변경되었습니다. 최신 내용을 확인한 뒤 다시 시도해 주세요.', {
              entityType, entityId, expected, actual,
            });
          }
        },
        checkCancelled: () => {
          if (options.cancelled?.()) fail('CANCELLED', '작업을 취소했습니다. 변경된 내용은 없습니다.');
        },
        progress: (done, total) => options.onProgress?.(done, total),
      };

      const result = def.run(ctx, payload) as R;
      this.faults?.hit('after-handler');
      this.faults?.hit('after-audit');
      const committedRevision = events > 0 ? revision : this.#revision;
      this.db
        .prepare('INSERT INTO command_receipts VALUES (?, ?, ?, ?, ?, ?, ?)')
        .run(envelope.commandId, requestHash, envelope.type, JSON.stringify(result ?? null), committedRevision, actor, now);
      this.faults?.hit('after-receipt');
      if (events > 0) this.db.prepare("UPDATE dataset_meta SET value = ? WHERE key = 'revision'").run(String(revision));
      ctx.checkCancelled();
      this.faults?.hit('before-commit');
      return { replayed: false, revision: committedRevision, result: JSON.parse(JSON.stringify(result ?? null)) as R };
    });

    const outcome = run.immediate();
    this.#revision = outcome.replayed ? this.#revision : outcome.revision;
    return outcome;
  }
}
