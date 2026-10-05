import { afterEach, beforeEach } from 'vitest';
import { DataRoot } from '../../../src/main/data/data-root';
import { createDomainRegistry } from '../../../src/main/data/domain/registry';
import { DomainError } from '../../../src/main/data/errors';
import { newId } from '../../../src/main/data/ids';
import type { Db } from '../../../src/main/data/sqlite';
import { fixedClock, tempDir } from '../data/support';

export interface Ctx {
  root: DataRoot;
  dir: string;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  exec<R = any>(type: string, payload: unknown, opts?: { commandId?: string; actor?: string }): R;
  read<T>(fn: (db: Db) => T): T;
  reopen(): void;
}

/** Opens a fresh synthetic data root per test with the production domain registry. */
export function useDomain(): Ctx {
  const ctx = {} as Ctx;
  let t: ReturnType<typeof tempDir>;
  beforeEach(() => {
    t = tempDir('school-asset-domain-');
    const clock = fixedClock();
    ctx.dir = t.dir;
    ctx.root = DataRoot.open(t.dir, { registry: createDomainRegistry(), now: clock });
    ctx.exec = (type, payload, opts = {}) =>
      ctx.root.store.execute(
        { datasetId: ctx.root.store.datasetId, epoch: ctx.root.store.epoch, commandId: opts.commandId ?? newId(), type, payload },
        opts.actor ?? '정보부 관리자',
      ).result as never;
    ctx.read = (fn) => ctx.root.store.read(fn).data;
    ctx.reopen = () => {
      ctx.root.close();
      ctx.root = DataRoot.open(t.dir, { registry: createDomainRegistry(), now: clock });
    };
  });
  afterEach(() => {
    ctx.root.close();
    t.cleanup();
  });
  return ctx;
}

export function codeOf(fn: () => unknown): string {
  try {
    fn();
  } catch (error) {
    if (error instanceof DomainError) return error.code + (error.details.rule ? `:${String(error.details.rule)}` : '');
    throw error;
  }
  return 'OK';
}

export const auditCount = (ctx: Ctx) => ctx.read((db) => (db.prepare('SELECT COUNT(*) AS n FROM audit_events').get() as { n: number }).n);
