import { spawnSync } from 'node:child_process';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { DomainError } from '../../../src/main/data/errors';
import { newId } from '../../../src/main/data/ids';
import { pragmaSnapshot } from '../../../src/main/data/sqlite';
import { count, envelope, openRoot, tempDir } from './support';

const put = (key: string, value: string, expectedVersion: number | null = null) => ({ items: [{ key, value, expectedVersion }] });

function expectCode(fn: () => unknown, code: string) {
  try {
    fn();
  } catch (error) {
    expect(error).toBeInstanceOf(DomainError);
    expect((error as DomainError).code).toBe(code);
    return error as DomainError;
  }
  throw new Error(`expected ${code}`);
}

describe('data root and generation catalog', () => {
  let t: ReturnType<typeof tempDir>;
  beforeEach(() => (t = tempDir()));
  afterEach(() => t.cleanup());

  it('creates one active generation with an epoch and opens it with the required PRAGMAs', () => {
    const root = openRoot(t.dir);
    try {
      const gens = root.catalog.generations();
      expect(gens).toHaveLength(1);
      expect(gens[0]!.state).toBe('active');
      expect(root.catalog.active()).toMatchObject({ generationId: gens[0]!.id, epoch: root.store.epoch });
      expect(root.store.revision).toBe(0);
      expect(pragmaSnapshot(root.store.db)).toEqual({ foreign_keys: 1, trusted_schema: 0, journal_mode: 'wal', synchronous: 2 });
      expect(pragmaSnapshot(root.catalog.db)).toEqual({ foreign_keys: 1, trusted_schema: 0, journal_mode: 'wal', synchronous: 2 });
    } finally {
      root.close();
    }
  });

  it('keeps dataset id, epoch and data across a restart', () => {
    const first = openRoot(t.dir);
    const ids = { datasetId: first.store.datasetId, epoch: first.store.epoch };
    first.store.execute(envelope(first, 'test.put', put('a', '합성')), '관리자');
    first.close();
    const second = openRoot(t.dir);
    try {
      expect({ datasetId: second.store.datasetId, epoch: second.store.epoch }).toEqual(ids);
      expect(second.store.revision).toBe(1);
      expect(second.catalog.generations()).toHaveLength(1);
    } finally {
      second.close();
    }
  });

  it('discards a staging generation left by an interrupted first start', () => {
    const first = openRoot(t.dir);
    const orphan = first.catalog.createGeneration({ datasetId: newId(), source: 'restore' });
    first.close();
    const second = openRoot(t.dir);
    try {
      expect(second.catalog.generation(orphan.id)!.state).toBe('discarded');
      expect(second.catalog.generations().filter((g) => g.state === 'active')).toHaveLength(1);
    } finally {
      second.close();
    }
  });

  it('refuses to open the same data root twice', () => {
    const root = openRoot(t.dir);
    try {
      expect(() => openRoot(t.dir)).toThrow(/사용 중/);
    } finally {
      root.close();
    }
  });
});

describe('command pipeline', () => {
  let t: ReturnType<typeof tempDir>;
  beforeEach(() => (t = tempDir()));
  afterEach(() => t.cleanup());

  it('commits the change, the audit event, the receipt and the revision together', () => {
    const root = openRoot(t.dir);
    try {
      const res = root.store.execute(envelope(root, 'test.put', put('a', '합성')), '관리자');
      expect(res).toMatchObject({ replayed: false, revision: 1, result: { versions: { a: 1 } } });
      expect(count(root, 'settings')).toBe(1);
      expect(count(root, 'audit_events')).toBe(1);
      expect(count(root, 'command_receipts')).toBe(1);
      const ev = root.store.db.prepare('SELECT * FROM audit_events').get() as Record<string, unknown>;
      expect(ev).toMatchObject({ revision: 1, actor: '관리자', event_type: 'setting.put', entity_id: 'a' });
    } finally {
      root.close();
    }
  });

  it('AC-30: replays an identical command once and rejects the same id with different content', () => {
    const root = openRoot(t.dir);
    try {
      const env = envelope(root, 'test.put', put('a', '합성'));
      const first = root.store.execute(env, '관리자');
      const again = root.store.execute({ ...env, payload: JSON.parse(JSON.stringify(env.payload)) }, '관리자');
      expect(again).toEqual({ ...first, replayed: true });
      expect(root.store.revision).toBe(1);
      expect(count(root, 'audit_events')).toBe(1);
      expectCode(() => root.store.execute({ ...env, payload: put('a', '다른 값') }, '관리자'), 'COMMAND_ID_REUSED');
      expect(count(root, 'audit_events')).toBe(1);
    } finally {
      root.close();
    }
  });

  it('AC-30: rejects stale epochs and other datasets', () => {
    const root = openRoot(t.dir);
    try {
      expectCode(() => root.store.execute({ ...envelope(root, 'test.put', put('a', 'x')), epoch: newId() }, '관리자'), 'STALE_EPOCH');
      expectCode(() => root.store.execute({ ...envelope(root, 'test.put', put('a', 'x')), datasetId: newId() }, '관리자'), 'DATASET_MISMATCH');
      expect(count(root, 'settings')).toBe(0);
    } finally {
      root.close();
    }
  });

  it('rejects an old epoch even after re-activation reproduces the same revision', () => {
    const root = openRoot(t.dir);
    try {
      const oldEnv = envelope(root, 'test.put', put('a', 'x'));
      root.reactivateForTest();
      expect(root.store.revision).toBe(0);
      expectCode(() => root.store.execute(oldEnv, '관리자'), 'STALE_EPOCH');
    } finally {
      root.close();
    }
  });

  it('rejects unknown command types and malformed envelopes', () => {
    const root = openRoot(t.dir);
    try {
      expectCode(() => root.store.execute(envelope(root, 'db.exec', { sql: 'DROP TABLE settings' }), '관리자'), 'VALIDATION');
      expectCode(() => root.store.execute({ ...envelope(root, 'test.put', put('a', 'x')), commandId: 'not-a-uuid' }, '관리자'), 'VALIDATION');
      expectCode(() => root.store.execute(envelope(root, 'test.put', { items: [] }), '관리자'), 'VALIDATION');
    } finally {
      root.close();
    }
  });

  it('a stale expected version changes nothing; one conflict in a batch rolls back the whole batch', () => {
    const root = openRoot(t.dir);
    try {
      root.store.execute(envelope(root, 'test.put', put('a', '1')), '관리자');
      expectCode(() => root.store.execute(envelope(root, 'test.put', put('a', '2', 5)), '관리자'), 'VERSION_CONFLICT');
      const batch = { items: [{ key: 'b', value: 'new', expectedVersion: null }, { key: 'a', value: '3', expectedVersion: 0 }] };
      const err = expectCode(() => root.store.execute(envelope(root, 'test.put', batch), '관리자'), 'VERSION_CONFLICT');
      expect(err.details).toMatchObject({ entityType: 'setting', entityId: 'a', expected: 0, actual: 1 });
      expect(count(root, 'settings')).toBe(1);
      expect(count(root, 'audit_events')).toBe(1);
      expect(root.store.revision).toBe(1);
    } finally {
      root.close();
    }
  });

  it.each(['after-handler', 'after-audit', 'after-receipt', 'before-commit'] as const)(
    'a failure injected at %s rolls back change, audit, receipt and revision',
    (stage) => {
      const root = openRoot(t.dir, {
        faults: { hit: (s) => { if (s === stage) throw new Error(`injected ${s}`); } },
      });
      try {
        const env = envelope(root, 'test.put', put('a', '합성'));
        expect(() => root.store.execute(env, '관리자')).toThrow(/injected/);
        expect(count(root, 'settings')).toBe(0);
        expect(count(root, 'audit_events')).toBe(0);
        expect(count(root, 'command_receipts')).toBe(0);
        expect(root.store.revision).toBe(0);
      } finally {
        root.close();
      }
    },
  );

  it('keeps audit events and receipts append-only', () => {
    const root = openRoot(t.dir);
    try {
      root.store.execute(envelope(root, 'test.put', put('a', '합성')), '관리자');
      expect(() => root.store.db.prepare("UPDATE audit_events SET reason = 'x'").run()).toThrow(/append-only/);
      expect(() => root.store.db.prepare('DELETE FROM audit_events').run()).toThrow(/append-only/);
      expect(() => root.store.db.prepare('DELETE FROM command_receipts').run()).toThrow(/append-only/);
    } finally {
      root.close();
    }
  });

  it('blocks writes during maintenance', () => {
    const root = openRoot(t.dir);
    try {
      const release = root.store.beginMaintenance('backup');
      expectCode(() => root.store.execute(envelope(root, 'test.put', put('a', 'x')), '관리자'), 'MAINTENANCE_LOCKED');
      release();
      expect(root.store.execute(envelope(root, 'test.put', put('a', 'x')), '관리자').revision).toBe(1);
    } finally {
      root.close();
    }
  });

  it('reads return data with the revision and epoch of one snapshot', () => {
    const root = openRoot(t.dir);
    try {
      root.store.execute(envelope(root, 'test.put', put('a', '합성')), '관리자');
      const snap = root.store.read((db) => db.prepare('SELECT COUNT(*) AS n FROM settings').get());
      expect(snap).toEqual({ datasetId: root.store.datasetId, epoch: root.store.epoch, revision: 1, data: { n: 1 } });
    } finally {
      root.close();
    }
  });

  it('AC-31: a retry after the process died before answering returns the committed result', () => {
    const fixture = path.resolve('tests/unit/data/fixtures/commit-then-die.mjs');
    const commandId = newId();
    const child = spawnSync(process.execPath, [fixture, t.dir, commandId], { encoding: 'utf8', timeout: 30_000 });
    expect(child.stdout).toContain('committed');
    expect(child.stdout).not.toContain('responded');
    expect(child.status).not.toBe(0);
    const root = openRoot(t.dir);
    try {
      const retry = root.store.execute(envelope(root, 'test.put', put('crash', '합성'), commandId), '관리자');
      expect(retry).toMatchObject({ replayed: true, revision: 1, result: { versions: { crash: 1 } } });
      expect(count(root, 'audit_events')).toBe(1);
    } finally {
      root.close();
    }
  });
});
