import { describe, expect, it } from 'vitest';
import { assetCounts, findDuplicateCandidates, getAssetDetail, listAssets, listLocations, listPeople } from '../../../src/main/data/domain/queries';
import { auditCount, codeOf, useDomain } from './support';

const ctx = useDomain();

function unspecified() {
  return ctx.read((db) => listLocations(db)).find((l) => l.isUnspecified)!;
}

function room(name: string, parentId: string | null = null): string {
  return ctx.exec('location.create', { name, parentId }).id;
}

describe('AC-01 batch registration', () => {
  it('creates five distinct ids, counts five, and stores a monitor without interfaces', () => {
    const loc = room('본관 2층 교무실');
    const res = ctx.exec('asset.registerBatch', {
      locationId: loc,
      items: [
        { kind: 'laptop', manufacturer: '합성전자', model: 'LT-100', quantity: 2, interfaces: [{ kind: 'wifi', label: '무선' }] },
        { kind: 'desktop', manufacturer: '합성전자', model: 'DT-200', serial: 'SYN-D-0001', interfaces: [{ kind: 'ethernet', label: '유선', mac: '00-11-22-33-44-55' }] },
        { kind: 'monitor', model: 'MN-24', quantity: 2 },
      ],
    });
    expect(res.assetIds).toHaveLength(5);
    expect(new Set(res.assetIds).size).toBe(5);
    const counts = ctx.read((db) => assetCounts(db));
    expect(counts).toMatchObject({ registeredTotal: 5, notDisposed: 5, byKind: { laptop: 2, desktop: 1, monitor: 2 } });
    const monitors = ctx.read((db) => listAssets(db, { kind: 'monitor' })).items;
    expect(monitors).toHaveLength(2);
    for (const m of monitors) expect(ctx.read((db) => getAssetDetail(db, m.id))!.interfaces).toEqual([]);
    const desktop = ctx.read((db) => listAssets(db, { kind: 'desktop' })).items[0]!;
    expect(ctx.read((db) => getAssetDetail(db, desktop.id))!.interfaces[0]).toMatchObject({ mac: '00:11:22:33:44:55', status: 'enabled' });
    // One audit event per created asset/interface, never one merged quantity row.
    expect(ctx.read((db) => (db.prepare("SELECT COUNT(*) AS n FROM audit_events WHERE event_type = 'asset.registered'").get() as { n: number }).n)).toBe(5);
  });

  it('rejects a serial on a multi-quantity line and an unknown location', () => {
    expect(codeOf(() => ctx.exec('asset.registerBatch', { locationId: unspecified().id, items: [{ kind: 'laptop', serial: 'X', quantity: 2 }] }))).toBe('VALIDATION');
    expect(codeOf(() => ctx.exec('asset.registerBatch', { locationId: '00000000-0000-4000-8000-000000000000', items: [{ kind: 'laptop' }] }))).toBe('NOT_FOUND');
  });
});

describe('AC-02 identifiers', () => {
  it('preserves leading zeros, empty serial and duplicate serials without merging', () => {
    const loc = unspecified().id;
    const a = ctx.exec('asset.registerBatch', { locationId: loc, items: [{ kind: 'laptop', officialNo: '000123', serial: '' }] }).assetIds[0];
    const b = ctx.exec('asset.registerBatch', { locationId: loc, items: [{ kind: 'laptop', serial: 'DUP-1' }] }).assetIds[0];
    const c = ctx.exec('asset.registerBatch', { locationId: loc, items: [{ kind: 'laptop', serial: 'DUP-1' }] }).assetIds[0];
    expect(ctx.read((db) => getAssetDetail(db, a))!.asset).toMatchObject({ officialNo: '000123', serial: null });
    expect(b).not.toBe(c);
    expect(ctx.read((db) => assetCounts(db)).registeredTotal).toBe(3);
    const dup = ctx.read((db) => findDuplicateCandidates(db, { serial: 'DUP-1' }));
    expect(dup.map((d) => d.id).sort()).toEqual([b, c].sort());
    expect(ctx.read((db) => listAssets(db, { query: '000123' })).items.map((i) => i.id)).toEqual([a]);
  });
});

describe('people and locations', () => {
  it('rejects location cycles and keeps hierarchy paths', () => {
    const building = room('본관');
    const floor = room('2층', building);
    const office = room('교무실', floor);
    const floorRow = ctx.read((db) => listLocations(db)).find((l) => l.id === floor)!;
    expect(codeOf(() => ctx.exec('location.update', { id: building, expectedVersion: 1, name: '본관', parentId: office }))).toBe('RULE_VIOLATION:location_cycle');
    expect(codeOf(() => ctx.exec('location.update', { id: floor, expectedVersion: floorRow.version, name: '2층', parentId: floor }))).toBe('RULE_VIOLATION:location_cycle');
    expect(ctx.read((db) => listLocations(db)).find((l) => l.id === office)!.path).toBe('본관 > 2층 > 교무실');
  });

  it('blocks deactivating a location that still holds assets or active children', () => {
    const building = room('별관');
    const lab = room('컴퓨터실', building);
    ctx.exec('asset.registerBatch', { locationId: lab, items: [{ kind: 'desktop' }] });
    expect(codeOf(() => ctx.exec('location.setStatus', { id: lab, expectedVersion: 1, status: 'inactive', reason: '폐실' }))).toBe('RULE_VIOLATION:location_has_assets');
    expect(codeOf(() => ctx.exec('location.setStatus', { id: building, expectedVersion: 1, status: 'inactive', reason: '폐쇄' }))).toBe('RULE_VIOLATION:location_has_children');
  });

  it('marks inactive people and excludes them from active lists', () => {
    const p = ctx.exec('person.create', { displayName: '가상교사 김하나', department: '정보부' });
    ctx.exec('person.setStatus', { id: p.id, expectedVersion: p.version, status: 'inactive', reason: '전보(합성)' });
    expect(ctx.read((db) => listPeople(db, { status: 'active' }))).toEqual([]);
    expect(ctx.read((db) => listPeople(db, {}))[0]).toMatchObject({ id: p.id, status: 'inactive' });
  });

  it('rejects stale person edits', () => {
    const p = ctx.exec('person.create', { displayName: '가상교사 이둘' });
    ctx.exec('person.update', { id: p.id, expectedVersion: 1, displayName: '가상교사 이둘(수정)', department: null, title: null });
    expect(codeOf(() => ctx.exec('person.update', { id: p.id, expectedVersion: 1, displayName: '덮어쓰기', department: null, title: null }))).toBe('VERSION_CONFLICT');
  });
});

describe('snapshot queries', () => {
  it('returns relation ids with versions from one revision and survives a restart', () => {
    const loc = room('도서실');
    const id = ctx.exec('asset.registerBatch', { locationId: loc, items: [{ kind: 'laptop', officialNo: '0042' }] }).assetIds[0];
    const before = ctx.root.store.read((db) => getAssetDetail(db, id));
    expect(before.data!.asset).toMatchObject({ id, locationId: loc, version: 1, lifecycle: 'ready', lossStatus: 'none' });
    expect(before.data!.location).toMatchObject({ id: loc, name: '도서실' });
    const events = auditCount(ctx);
    ctx.reopen();
    const after = ctx.root.store.read((db) => getAssetDetail(db, id));
    expect(after.revision).toBe(before.revision);
    expect(after.data).toEqual(before.data);
    expect(auditCount(ctx)).toBe(events);
  });

  it('pages and filters the asset list with a total count', () => {
    const loc = room('창고');
    ctx.exec('asset.registerBatch', { locationId: loc, items: [{ kind: 'monitor', quantity: 30 }] });
    const page = ctx.read((db) => listAssets(db, { locationId: loc, limit: 10, offset: 20 }));
    expect(page.total).toBe(30);
    expect(page.items).toHaveLength(10);
  });
});
