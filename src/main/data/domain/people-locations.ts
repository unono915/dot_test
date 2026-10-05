import { defineCommand } from '../commands.js';
import { newId } from '../ids.js';
import { getLocation, getPerson, violate } from './repo.js';
import { oneOf, optStr, optUuid, parser, str, uuid, version } from './validate.js';

export const personCreate = defineCommand('person.create', parser({ displayName: str({ max: 100 }), department: optStr({ max: 100 }), title: optStr({ max: 100 }) }), (ctx, p) => {
    const id = newId();
    ctx.db
      .prepare("INSERT INTO people VALUES (?, ?, ?, ?, 'active', 1, ?, ?)")
      .run(id, p.displayName, p.department, p.title, ctx.now, ctx.now);
    ctx.emit({ eventType: 'person.created', entityType: 'person', entityId: id, before: null, after: { ...p, status: 'active' } });
    return { id, version: 1 };
});

export const personUpdate = defineCommand('person.update', parser({ id: uuid, expectedVersion: version, displayName: str({ max: 100 }), department: optStr({ max: 100 }), title: optStr({ max: 100 }) }), (ctx, p) => {
    const before = getPerson(ctx.db, p.id);
    ctx.expectVersion('person', p.id, before.version, p.expectedVersion);
    ctx.db
      .prepare('UPDATE people SET display_name = ?, department = ?, title = ?, version = version + 1, updated_at = ? WHERE id = ?')
      .run(p.displayName, p.department, p.title, ctx.now, p.id);
    ctx.emit({
      eventType: 'person.updated', entityType: 'person', entityId: p.id,
      before: { displayName: before.displayName, department: before.department, title: before.title },
      after: { displayName: p.displayName, department: p.department, title: p.title },
    });
    return { id: p.id, version: before.version + 1 };
});

/**
 * Deactivation (retirement, transfer) keeps every assignment, loan and IP: they stay visible as
 * unresolved work. Inactive people cannot receive new assignments or loans.
 */
export const personSetStatus = defineCommand('person.setStatus', parser({ id: uuid, expectedVersion: version, status: oneOf(['active', 'inactive'] as const), reason: str({ max: 500 }) }), (ctx, p) => {
    const before = getPerson(ctx.db, p.id);
    ctx.expectVersion('person', p.id, before.version, p.expectedVersion);
    if (before.status === p.status) violate('no_change', '이미 같은 상태입니다.');
    ctx.db.prepare('UPDATE people SET status = ?, version = version + 1, updated_at = ? WHERE id = ?').run(p.status, ctx.now, p.id);
    ctx.emit({
      eventType: p.status === 'inactive' ? 'person.deactivated' : 'person.reactivated', entityType: 'person', entityId: p.id,
      before: { status: before.status }, after: { status: p.status }, reason: p.reason,
    });
    return { id: p.id, version: before.version + 1 };
});

function assertNoCycle(db: import('../sqlite.js').Db, id: string, parentId: string | null): void {
  let cursor = parentId;
  let guard = 0;
  while (cursor) {
    if (cursor === id) violate('location_cycle', '상위 장소가 자기 자신이나 하위 장소가 될 수 없습니다.');
    cursor = getLocation(db, cursor).parentId;
    if (++guard > 10_000) violate('location_cycle', '장소 계층이 올바르지 않습니다.');
  }
}

export const locationCreate = defineCommand('location.create', parser({ name: str({ max: 100 }), parentId: optUuid }), (ctx, p) => {
    if (p.parentId && getLocation(ctx.db, p.parentId).status !== 'active') violate('location_inactive', '비활성 장소 아래에는 만들 수 없습니다.');
    const id = newId();
    ctx.db.prepare("INSERT INTO locations VALUES (?, ?, ?, 0, 'active', 1, ?, ?)").run(id, p.name, p.parentId, ctx.now, ctx.now);
    ctx.emit({ eventType: 'location.created', entityType: 'location', entityId: id, before: null, after: p });
    return { id, version: 1 };
});

export const locationUpdate = defineCommand('location.update', parser({ id: uuid, expectedVersion: version, name: str({ max: 100 }), parentId: optUuid }), (ctx, p) => {
    const before = getLocation(ctx.db, p.id);
    ctx.expectVersion('location', p.id, before.version, p.expectedVersion);
    if (before.isUnspecified && p.parentId) violate('unspecified_location_fixed', '미지정 장소는 다른 장소 아래로 옮길 수 없습니다.');
    assertNoCycle(ctx.db, p.id, p.parentId);
    ctx.db.prepare('UPDATE locations SET name = ?, parent_id = ?, version = version + 1, updated_at = ? WHERE id = ?').run(p.name, p.parentId, ctx.now, p.id);
    ctx.emit({
      eventType: 'location.updated', entityType: 'location', entityId: p.id,
      before: { name: before.name, parentId: before.parentId }, after: { name: p.name, parentId: p.parentId },
    });
    return { id: p.id, version: before.version + 1 };
});

export const locationSetStatus = defineCommand('location.setStatus', parser({ id: uuid, expectedVersion: version, status: oneOf(['active', 'inactive'] as const), reason: str({ max: 500 }) }), (ctx, p) => {
    const before = getLocation(ctx.db, p.id);
    ctx.expectVersion('location', p.id, before.version, p.expectedVersion);
    if (before.status === p.status) violate('no_change', '이미 같은 상태입니다.');
    if (p.status === 'inactive') {
      if (before.isUnspecified) violate('unspecified_location_fixed', '미지정 장소는 비활성화할 수 없습니다.');
      const assets = (ctx.db.prepare("SELECT COUNT(*) AS n FROM assets WHERE location_id = ? AND lifecycle <> 'disposed'").get(p.id) as { n: number }).n;
      if (assets > 0) violate('location_has_assets', '현재 자산이 있는 장소입니다. 자산을 먼저 이동해 주세요.', { count: assets });
      const children = (ctx.db.prepare("SELECT COUNT(*) AS n FROM locations WHERE parent_id = ? AND status = 'active'").get(p.id) as { n: number }).n;
      if (children > 0) violate('location_has_children', '활성 하위 장소가 있습니다.', { count: children });
    } else if (before.parentId && getLocation(ctx.db, before.parentId).status !== 'active') {
      violate('location_inactive', '상위 장소가 비활성입니다.');
    }
    ctx.db.prepare('UPDATE locations SET status = ?, version = version + 1, updated_at = ? WHERE id = ?').run(p.status, ctx.now, p.id);
    ctx.emit({ eventType: 'location.statusChanged', entityType: 'location', entityId: p.id, before: { status: before.status }, after: { status: p.status }, reason: p.reason });
    return { id: p.id, version: before.version + 1 };
});

export const peopleLocationCommands = [personCreate, personUpdate, personSetStatus, locationCreate, locationUpdate, locationSetStatus];
