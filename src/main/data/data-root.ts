import fs from 'node:fs';
import { acquireDataRootLock, type DataRootLock } from '../data-root-lock.js';
import { Catalog } from './catalog.js';
import type { CommandRegistry } from './commands.js';
import { DatasetStore, createDatasetFile, type FaultInjector } from './dataset.js';
import { checkDatasetInvariants } from './domain/invariants.js';
import { newId } from './ids.js';
import { openDatabase } from './sqlite.js';

export interface DataRootOptions {
  registry: CommandRegistry;
  now?: () => string;
  faults?: FaultInjector;
}

const systemNow = () => new Date().toISOString();

/**
 * The opened local data directory: exclusive lock, generation catalog and the active dataset.
 * Startup recovery runs here, before any command is accepted.
 */
export class DataRoot {
  private constructor(
    readonly dir: string,
    readonly catalog: Catalog,
    private lock: DataRootLock,
    public store: DatasetStore,
    private readonly options: Required<Pick<DataRootOptions, 'registry' | 'now'>> & Pick<DataRootOptions, 'faults'>,
  ) {}

  static open(dir: string, options: DataRootOptions): DataRoot {
    const now = options.now ?? systemNow;
    const lock = acquireDataRootLock(dir);
    let catalog: Catalog | null = null;
    try {
      catalog = Catalog.open(dir, now);
      recoverInterruptedSwitches(catalog);
      recoverInterruptedGenerations(catalog);
      let active = catalog.active();
      if (!active) {
        const datasetId = newId();
        const gen = catalog.createGeneration({ datasetId, source: 'new' });
        createDatasetFile(catalog.datasetFile(gen.id), datasetId, now());
        catalog.setState(gen.id, 'ready');
        active = catalog.activate(gen.id);
        catalog.journal({ jobId: newId(), kind: 'init', step: 'activated', status: 'done', generationId: gen.id });
      }
      const store = DatasetStore.open(catalog.datasetFile(active.generationId), active.epoch, options.registry, now, options.faults);
      return new DataRoot(dir, catalog, lock, store, { registry: options.registry, now, faults: options.faults });
    } catch (error) {
      catalog?.close();
      lock.release();
      throw error;
    }
  }

  get now(): () => string {
    return this.options.now;
  }

  get registry(): CommandRegistry {
    return this.options.registry;
  }

  /** Re-opens the store for the catalog's current active generation (after a switch). */
  reopenActive(): void {
    const active = this.catalog.active();
    if (!active) throw new Error('no active generation');
    this.store.close();
    this.store = DatasetStore.open(this.catalog.datasetFile(active.generationId), active.epoch, this.options.registry, this.options.now, this.options.faults);
  }

  /** Test helper: issue a new epoch for the same generation (as a restore of identical data would). */
  reactivateForTest(): void {
    const active = this.catalog.active()!;
    this.store.close();
    this.catalog.activate(active.generationId);
    this.reopenActive();
  }

  close(): void {
    try {
      this.store.close();
      this.catalog.close();
    } finally {
      this.lock.release();
    }
  }
}

/** A generation that never became active (crash during creation/restore staging) is discarded. */
function recoverInterruptedGenerations(catalog: Catalog): void {
  for (const gen of catalog.generations()) {
    if (gen.state === 'staging' || gen.state === 'ready') {
      catalog.setState(gen.id, 'discarded');
      catalog.journal({ jobId: newId(), kind: 'recovery', step: 'discard-unfinished-generation', status: 'done', generationId: gen.id });
      fs.rmSync(catalog.generationDir(gen.id), { recursive: true, force: true });
    }
  }
}

/**
 * A restore/rollback that crashed after switching the pointer but before finishing: keep the new
 * generation if it opens and passes the checks, otherwise return to the previous generation.
 * Either way a fresh epoch is in force (the switch itself issued one; a revert issues another).
 */
function recoverInterruptedSwitches(catalog: Catalog): void {
  const byJob = new Map<string, { kind: string; steps: string[]; generationId: string | null; previous: string | null }>();
  for (const j of catalog.journalEntries()) {
    if (j.kind !== 'restore' && j.kind !== 'rollback') continue;
    const cur = byJob.get(j.jobId) ?? { kind: j.kind, steps: [], generationId: null, previous: null };
    cur.steps.push(j.step);
    if (j.step === 'switched') {
      cur.generationId = j.generationId;
      cur.previous = (j.detail.previous as string | undefined) ?? null;
    }
    byJob.set(j.jobId, cur);
  }
  for (const [jobId, job] of byJob) {
    if (!job.steps.includes('switched') || job.steps.includes('done') || job.steps.includes('reverted')) continue;
    const active = catalog.active();
    if (!active || active.generationId !== job.generationId || !job.previous) continue;
    let healthy = false;
    try {
      const db = openDatabase(catalog.datasetFile(active.generationId), { fileMustExist: true });
      try {
        healthy = checkDatasetInvariants(db).length === 0;
      } finally {
        db.close();
      }
    } catch {
      healthy = false;
    }
    if (healthy) {
      catalog.journal({ jobId, kind: job.kind, step: 'done', status: 'done', generationId: active.generationId, detail: { recovered: true } });
    } else {
      catalog.activate(job.previous);
      catalog.setState(active.generationId, 'discarded');
      catalog.journal({ jobId, kind: job.kind, step: 'reverted', status: 'failed', generationId: job.previous, detail: { reason: 'recovery_open_failed', failedGeneration: active.generationId } });
    }
  }
}
