import fs from 'node:fs';
import { acquireDataRootLock, type DataRootLock } from '../data-root-lock.js';
import { Catalog } from './catalog.js';
import type { CommandRegistry } from './commands.js';
import { DatasetStore, createDatasetFile, type FaultInjector } from './dataset.js';
import { newId } from './ids.js';

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
