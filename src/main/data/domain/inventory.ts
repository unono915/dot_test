import { defineCommand } from '../commands.js';
import { fail } from '../errors.js';
import { newId } from '../ids.js';
import type { Db } from '../sqlite.js';
import { ASSET_KINDS } from './assets.js';
import { getActiveLocation, getAsset, getPerson, violate } from './repo.js';
import { instant, int, list, oneOf, optStr, optUuid, parser, shape, str, uuid, version, type Validator } from './validate.js';

// Inventory sessions freeze their base set (asset ids with the then location/person/version)
// at start. Results compare with that base; the live ledger is shown alongside, never overwritten.

const nullableList = <T>(inner: Validator<T[]>): Validator<T[] | null> => (v, f) => (v === null || v === undefined ? null : inner(v, f));

const scopeSpec = shape({
  kinds: nullableList(list(oneOf(ASSET_KINDS), { min: 1, max: 4 })),
  locationIds: nullableList(list(uuid, { min: 1, max: 300 })),
});

function getSession(db: Db, id: string) {
  const s = db.prepare('SELECT id, title, status, version, started_at AS startedAt, base_revision AS baseRevision FROM inventory_sessions WHERE id = ?').get(id) as
    | { id: string; title: string; status: 'open' | 'closed'; version: number; startedAt: string; baseRevision: number }
    | undefined;
  return s ?? fail('NOT_FOUND', '실사 세션을 찾을 수 없습니다.');
}

function getOpenSession(db: Db, id: string) {
  const s = getSession(db, id);
  if (s.status !== 'open') violate('inventory_closed', '종료된 실사는 수정할 수 없습니다. 보완 설명을 추가하거나 새 실사를 시작해 주세요.');
  return s;
}

function descendants(db: Db, roots: string[]): string[] {
  const all = db.prepare('SELECT id, parent_id AS parentId FROM locations').all() as { id: string; parentId: string | null }[];
  const out = new Set(roots);
  let grew = true;
  while (grew) {
    grew = false;
    for (const l of all) if (l.parentId && out.has(l.parentId) && !out.has(l.id)) (out.add(l.id), (grew = true));
  }
  return [...out];
}

export const inventoryStart = defineCommand('inventory.start', parser({ title: str({ max: 100 }), scope: scopeSpec }), (ctx, p) => {
  if (ctx.db.prepare("SELECT 1 FROM inventory_sessions WHERE status = 'open'").get()) violate('inventory_open', '진행 중인 실사가 있습니다. 한 번에 하나만 열 수 있습니다.');
  for (const id of p.scope.locationIds ?? []) getActiveLocation(ctx.db, id);
  const where = ["a.lifecycle <> 'disposed'"];
  const params: unknown[] = [];
  if (p.scope.kinds) {
    where.push(`a.kind IN (${p.scope.kinds.map(() => '?').join(',')})`);
    params.push(...p.scope.kinds);
  }
  if (p.scope.locationIds) {
    const locs = descendants(ctx.db, p.scope.locationIds);
    where.push(`a.location_id IN (${locs.map(() => '?').join(',')})`);
    params.push(...locs);
  }
  const assets = ctx.db
    .prepare(
      `SELECT a.id, a.location_id AS locationId, a.lifecycle, a.version, x.person_id AS personId
       FROM assets a LEFT JOIN assignments x ON x.asset_id = a.id AND x.ended_at IS NULL WHERE ${where.join(' AND ')}`,
    )
    .all(...params) as { id: string; locationId: string; lifecycle: string; version: number; personId: string | null }[];
  if (assets.length > 10_000) fail('LIMIT_EXCEEDED', '한 실사의 기준 자산은 10,000대까지입니다. 범위를 나누어 주세요.', { count: assets.length });
  if (assets.length === 0) violate('inventory_empty', '범위에 해당하는 자산이 없습니다.');
  const id = newId();
  ctx.db
    .prepare("INSERT INTO inventory_sessions VALUES (?, ?, ?, 'open', ?, ?, NULL, NULL, 1)")
    .run(id, p.title, JSON.stringify(p.scope), ctx.now, ctx.revision - 1);
  const ins = ctx.db.prepare('INSERT INTO inventory_items VALUES (?, ?, ?, ?, ?, ?)');
  for (const a of assets) ins.run(id, a.id, a.locationId, a.personId, a.lifecycle, a.version);
  ctx.emit({ eventType: 'inventory.started', entityType: 'inventory', entityId: id, after: { title: p.title, scope: p.scope, base: assets.length } });
  return { sessionId: id, base: assets.length };
});

function effectiveResult(db: Db, sessionId: string, assetId: string) {
  return db
    .prepare(
      `SELECT id, result FROM inventory_results r WHERE session_id = ? AND asset_id = ?
         AND NOT EXISTS (SELECT 1 FROM inventory_results x WHERE x.supersedes_id = r.id) ORDER BY recorded_at DESC, rowid DESC LIMIT 1`,
    )
    .get(sessionId, assetId) as { id: string; result: string } | undefined;
}

export const inventoryRecordResult = defineCommand(
  'inventory.recordResult',
  parser({
    sessionId: uuid,
    assetId: uuid,
    outcome: oneOf(['found', 'not_found'] as const),
    foundLocationId: optUuid,
    foundPersonId: optUuid,
    checkedAt: instant,
    note: optStr({ max: 1000 }),
  }),
  (ctx, p) => {
    const s = getOpenSession(ctx.db, p.sessionId);
    const item = ctx.db.prepare('SELECT base_location_id AS baseLocationId, base_person_id AS basePersonId FROM inventory_items WHERE session_id = ? AND asset_id = ?').get(s.id, p.assetId) as
      | { baseLocationId: string; basePersonId: string | null }
      | undefined;
    if (!item) violate('not_in_base', '이 실사의 기준 대상이 아닙니다. 기준 외 발견으로 기록해 주세요.');
    let result: 'matched' | 'mismatched' | 'not_found' = 'not_found';
    if (p.outcome === 'found') {
      if (!p.foundLocationId) fail('VALIDATION', '확인한 장소를 선택해 주세요.', { field: 'foundLocationId' });
      getActiveLocation(ctx.db, p.foundLocationId!);
      if (p.foundPersonId) getPerson(ctx.db, p.foundPersonId);
      const samePlace = p.foundLocationId === item!.baseLocationId;
      const samePerson = p.foundPersonId === null || p.foundPersonId === item!.basePersonId;
      result = samePlace && samePerson ? 'matched' : 'mismatched';
    } else if (p.foundLocationId || p.foundPersonId) {
      fail('VALIDATION', '미발견에는 확인 장소를 넣지 않습니다.', { field: 'foundLocationId' });
    }
    const prev = effectiveResult(ctx.db, s.id, p.assetId);
    const id = newId();
    const eventId = ctx.emit({
      eventType: prev ? 'inventory.resultCorrected' : 'inventory.resultRecorded', entityType: 'inventory', entityId: s.id, occurredAt: p.checkedAt,
      after: { assetId: p.assetId, result, foundLocationId: p.foundLocationId, foundPersonId: p.foundPersonId, supersedes: prev?.id ?? null }, reason: p.note,
    });
    ctx.db
      .prepare('INSERT INTO inventory_results VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)')
      .run(id, s.id, p.assetId, result, p.foundLocationId, p.foundPersonId, p.checkedAt, ctx.now, ctx.actor, p.note, prev?.id ?? null, eventId);
    if (prev) ctx.db.prepare("UPDATE physical_checks SET voided_at = ? WHERE source = 'inventory' AND source_id = ? AND voided_at IS NULL").run(ctx.now, prev.id);
    if (result !== 'not_found') {
      ctx.db.prepare("INSERT INTO physical_checks VALUES (?, ?, ?, ?, 'inventory', ?, NULL, ?)").run(newId(), p.assetId, p.checkedAt, p.foundLocationId, id, eventId);
    }
    ctx.db.prepare('UPDATE inventory_sessions SET version = version + 1 WHERE id = ?').run(s.id);
    return { resultId: id, result };
  },
);

export const inventoryRecordExtra = defineCommand(
  'inventory.recordExtra',
  parser({ sessionId: uuid, assetId: optUuid, description: str({ max: 1000 }), foundLocationId: optUuid, checkedAt: instant }),
  (ctx, p) => {
    const s = getOpenSession(ctx.db, p.sessionId);
    if (p.assetId) {
      getAsset(ctx.db, p.assetId);
      if (ctx.db.prepare('SELECT 1 FROM inventory_items WHERE session_id = ? AND asset_id = ?').get(s.id, p.assetId)) violate('in_base', '기준 대상 자산입니다. 결과로 기록해 주세요.');
    }
    if (p.foundLocationId) getActiveLocation(ctx.db, p.foundLocationId);
    const id = newId();
    const eventId = ctx.emit({ eventType: 'inventory.extraFound', entityType: 'inventory', entityId: s.id, occurredAt: p.checkedAt, after: p });
    ctx.db.prepare('INSERT INTO inventory_extras VALUES (?, ?, ?, ?, ?, ?, ?)').run(id, s.id, p.assetId, p.description, p.foundLocationId, p.checkedAt, eventId);
    return { extraId: id };
  },
);

export function sessionCounts(db: Db, sessionId: string) {
  const rows = db
    .prepare(
      `SELECT it.asset_id AS assetId,
         (SELECT r.result FROM inventory_results r WHERE r.session_id = it.session_id AND r.asset_id = it.asset_id
            AND NOT EXISTS (SELECT 1 FROM inventory_results x WHERE x.supersedes_id = r.id) ORDER BY r.recorded_at DESC, r.rowid DESC LIMIT 1) AS result
       FROM inventory_items it WHERE it.session_id = ?`,
    )
    .all(sessionId) as { assetId: string; result: string | null }[];
  const c = { base: rows.length, matched: 0, mismatched: 0, notFound: 0, unchecked: 0, physicallyChecked: 0 };
  for (const r of rows) {
    if (r.result === 'matched') c.matched++;
    else if (r.result === 'mismatched') c.mismatched++;
    else if (r.result === 'not_found') c.notFound++;
    else c.unchecked++;
  }
  c.physicallyChecked = c.matched + c.mismatched;
  return c;
}

/** Closing requires explicitly acknowledging the counts of unresolved items. */
export const inventoryClose = defineCommand(
  'inventory.close',
  parser({
    sessionId: uuid,
    expectedVersion: version,
    acknowledged: shape({ unchecked: int({ min: 0 }), notFound: int({ min: 0 }), mismatched: int({ min: 0 }) }),
    note: optStr({ max: 2000 }),
  }),
  (ctx, p) => {
    const s = getOpenSession(ctx.db, p.sessionId);
    ctx.expectVersion('inventory', s.id, s.version, p.expectedVersion);
    const c = sessionCounts(ctx.db, s.id);
    if (c.unchecked !== p.acknowledged.unchecked || c.notFound !== p.acknowledged.notFound || c.mismatched !== p.acknowledged.mismatched) {
      violate('acknowledgement_mismatch', '확인한 미해결 건수가 현재와 다릅니다. 최신 현황을 다시 확인해 주세요.', { actual: c });
    }
    const summary = { ...c, closedRevision: ctx.revision, note: p.note };
    ctx.db.prepare("UPDATE inventory_sessions SET status = 'closed', closed_at = ?, close_summary_json = ?, version = version + 1 WHERE id = ?").run(ctx.now, JSON.stringify(summary), s.id);
    ctx.emit({ eventType: 'inventory.closed', entityType: 'inventory', entityId: s.id, after: summary, reason: p.note });
    return { sessionId: s.id, summary };
  },
);

/** Post-close explanation; never changes results. */
export const inventoryAddNote = defineCommand('inventory.addNote', parser({ sessionId: uuid, note: str({ max: 2000 }) }), (ctx, p) => {
  const s = getSession(ctx.db, p.sessionId);
  const id = newId();
  const eventId = ctx.emit({ eventType: 'inventory.noteAdded', entityType: 'inventory', entityId: s.id, after: { note: p.note } });
  ctx.db.prepare('INSERT INTO inventory_notes VALUES (?, ?, ?, ?, ?)').run(id, s.id, p.note, ctx.now, eventId);
  return { noteId: id };
});

/** Links a separate ledger correction (move, correction, loss…) to an inventory finding. */
export const inventoryLinkFollowUp = defineCommand(
  'inventory.linkFollowUp',
  parser({ sessionId: uuid, assetId: uuid, eventId: uuid, note: optStr({ max: 1000 }) }),
  (ctx, p) => {
    const s = getSession(ctx.db, p.sessionId);
    if (!ctx.db.prepare('SELECT 1 FROM inventory_items WHERE session_id = ? AND asset_id = ?').get(s.id, p.assetId)) violate('not_in_base', '이 실사의 기준 대상이 아닙니다.');
    const ev = ctx.db.prepare("SELECT event_id FROM audit_events WHERE event_id = ? AND ((entity_type = 'asset' AND entity_id = ?) OR entity_type = 'event')").get(p.eventId, p.assetId);
    if (!ev) fail('NOT_FOUND', '연결할 후속 기록을 찾을 수 없습니다.');
    const result = effectiveResult(ctx.db, s.id, p.assetId);
    const id = newId();
    const eventId = ctx.emit({ eventType: 'inventory.followUpLinked', entityType: 'inventory', entityId: s.id, after: { assetId: p.assetId, followUpEventId: p.eventId, resultId: result?.id ?? null }, reason: p.note });
    ctx.db.prepare('INSERT INTO inventory_links VALUES (?, ?, ?, ?, ?, ?, ?)').run(id, s.id, p.assetId, result?.id ?? null, eventId, p.note, ctx.now);
    return { linkId: id };
  },
);

export const inventoryCommands = [inventoryStart, inventoryRecordResult, inventoryRecordExtra, inventoryClose, inventoryAddNote, inventoryLinkFollowUp];

export function listInventorySessions(db: Db) {
  return (db
    .prepare('SELECT id, title, status, started_at AS startedAt, closed_at AS closedAt, base_revision AS baseRevision, version FROM inventory_sessions ORDER BY started_at DESC')
    .all() as { id: string; title: string; status: string; startedAt: string; closedAt: string | null; baseRevision: number; version: number }[]).map((s) => ({
    ...s,
    counts: sessionCounts(db, s.id),
  }));
}

export function inventorySummary(db: Db, sessionId: string) {
  const row = db.prepare('SELECT * FROM inventory_sessions WHERE id = ?').get(sessionId) as
    | { id: string; title: string; scope_json: string; status: string; started_at: string; base_revision: number; closed_at: string | null; close_summary_json: string | null; version: number }
    | undefined;
  if (!row) return fail('NOT_FOUND', '실사 세션을 찾을 수 없습니다.');
  const items = db
    .prepare(
      `SELECT it.asset_id AS assetId, it.base_location_id AS baseLocationId, it.base_person_id AS basePersonId, it.base_lifecycle AS baseLifecycle,
         it.base_version AS baseVersion, a.location_id AS currentLocationId, a.lifecycle AS currentLifecycle, a.version AS currentVersion,
         a.kind, a.official_no AS officialNo, a.model, a.serial, x.person_id AS currentPersonId,
         bl.name AS baseLocationName, cl.name AS currentLocationName
       FROM inventory_items it JOIN assets a ON a.id = it.asset_id
       LEFT JOIN assignments x ON x.asset_id = a.id AND x.ended_at IS NULL
       JOIN locations bl ON bl.id = it.base_location_id JOIN locations cl ON cl.id = a.location_id
       WHERE it.session_id = ? ORDER BY bl.name, a.official_no, a.id`,
    )
    .all(sessionId) as Record<string, unknown>[];
  const historyStmt = db.prepare(
    `SELECT id, result, found_location_id AS foundLocationId, found_person_id AS foundPersonId, checked_at AS checkedAt, recorded_at AS recordedAt, actor, note,
       supersedes_id AS supersedesId FROM inventory_results WHERE session_id = ? AND asset_id = ? ORDER BY recorded_at, rowid`,
  );
  const linkStmt = db.prepare('SELECT id, event_id AS eventId, note, recorded_at AS recordedAt FROM inventory_links WHERE session_id = ? AND asset_id = ?');
  const viewItems = items.map((it) => {
    const history = historyStmt.all(sessionId, it.assetId) as { id: string; result: string; foundLocationId: string | null; supersedesId: string | null; checkedAt: string }[];
    const superseded = new Set(history.map((h) => h.supersedesId).filter(Boolean));
    const effective = [...history].reverse().find((h) => !superseded.has(h.id)) ?? null;
    return {
      ...(it as { assetId: string; baseLocationId: string; currentLocationId: string; baseVersion: number; currentVersion: number }),
      result: (effective?.result ?? 'unchecked') as 'matched' | 'mismatched' | 'not_found' | 'unchecked',
      foundLocationId: effective?.foundLocationId ?? null,
      checkedAt: effective?.checkedAt ?? null,
      vsCurrent: effective?.foundLocationId ? (effective.foundLocationId === it.currentLocationId ? 'matched' : 'mismatched') : null,
      changedSinceBase: it.baseVersion !== it.currentVersion,
      history,
      followUps: linkStmt.all(sessionId, it.assetId),
    };
  });
  const addedSinceBase = db
    .prepare("SELECT id, kind, official_no AS officialNo, model FROM assets WHERE created_at > ? AND id NOT IN (SELECT asset_id FROM inventory_items WHERE session_id = ?) AND lifecycle <> 'disposed'")
    .all(row.started_at, sessionId);
  const extras = db.prepare('SELECT id, asset_id AS assetId, description, found_location_id AS foundLocationId, checked_at AS checkedAt FROM inventory_extras WHERE session_id = ?').all(sessionId);
  const notes = db.prepare('SELECT id, note, recorded_at AS recordedAt FROM inventory_notes WHERE session_id = ? ORDER BY recorded_at').all(sessionId);
  return {
    session: {
      id: row.id, title: row.title, scope: JSON.parse(row.scope_json) as unknown, status: row.status, startedAt: row.started_at, baseRevision: row.base_revision,
      closedAt: row.closed_at, closeSummary: row.close_summary_json ? (JSON.parse(row.close_summary_json) as Record<string, unknown>) : null, version: row.version,
    },
    counts: sessionCounts(db, sessionId),
    items: viewItems,
    addedSinceBase,
    extras,
    notes,
  };
}
