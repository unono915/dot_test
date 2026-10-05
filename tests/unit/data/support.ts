import { mkdtempSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { DataRoot, type DataRootOptions } from '../../../src/main/data/data-root';
import { defineCommand, CommandRegistry } from '../../../src/main/data/commands';
import { fail } from '../../../src/main/data/errors';
import { newId } from '../../../src/main/data/ids';

export function tempDir(prefix = 'school-asset-data-'): { dir: string; cleanup(): void } {
  const dir = mkdtempSync(path.join(os.tmpdir(), prefix));
  return { dir, cleanup: () => rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }) };
}

/** A deterministic clock that advances one second per call. */
export function fixedClock(start = Date.parse('2026-03-02T00:00:00.000Z')) {
  let t = start;
  return () => new Date((t += 1000)).toISOString();
}

interface PutPayload {
  items: { key: string; value: string; expectedVersion: number | null }[];
}

/** Synthetic commands used only by storage-layer tests. */
export function testRegistry(): CommandRegistry {
  const registry = new CommandRegistry();
  registry.register(
    defineCommand<PutPayload, { versions: Record<string, number> }>({
      type: 'test.put',
      parse(payload) {
        const p = payload as PutPayload;
        if (!Array.isArray(p?.items) || p.items.length === 0) fail('VALIDATION', '항목이 없습니다.');
        return p;
      },
      run(ctx, p) {
        const versions: Record<string, number> = {};
        for (const item of p.items) {
          const row = ctx.db.prepare('SELECT value_json, version FROM settings WHERE key = ?').get(item.key) as
            | { value_json: string; version: number }
            | undefined;
          ctx.expectVersion('setting', item.key, row?.version ?? null, item.expectedVersion);
          const version = (row?.version ?? 0) + 1;
          ctx.db
            .prepare('INSERT INTO settings VALUES (?, ?, ?) ON CONFLICT(key) DO UPDATE SET value_json = excluded.value_json, version = excluded.version')
            .run(item.key, JSON.stringify(item.value), version);
          ctx.emit({
            eventType: 'setting.put',
            entityType: 'setting',
            entityId: item.key,
            before: row ? { value: JSON.parse(row.value_json), version: row.version } : null,
            after: { value: item.value, version },
          });
          versions[item.key] = version;
        }
        return { versions };
      },
    }),
  );
  return registry;
}

export function openRoot(dir: string, options: Partial<DataRootOptions> = {}) {
  return DataRoot.open(dir, { registry: testRegistry(), now: fixedClock(), ...options });
}

export function envelope(root: DataRoot, type: string, payload: unknown, commandId = newId()) {
  return { datasetId: root.store.datasetId, epoch: root.store.epoch, commandId, type, payload };
}

export const count = (root: DataRoot, table: string) =>
  (root.store.db.prepare(`SELECT COUNT(*) AS n FROM ${table}`).get() as { n: number }).n;
