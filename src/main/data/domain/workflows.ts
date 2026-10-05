import { defineCommand, type TxContext } from '../commands.js';
import { fail } from '../errors.js';
import { newId } from '../ids.js';
import { formatIp } from './ipv4.js';
import { bumpAsset, getActiveLocation, getAsset, getPerson, occupiedSlotsOfAsset, violate, type AssetRow } from './repo.js';
import { date, instant, list, mustConfirm, oneOf, optInt, optStr, optUuid, parser, shape, str, uuid, version } from './validate.js';

// Asset business transitions. Responsibility (assignment), temporary possession (loan), location,
// operating state (lifecycle), loss and physical confirmation are independent facts.
// No transition here ever releases an IP address.

function loadForUpdate(ctx: TxContext, assetId: string, expectedVersion: number): AssetRow {
  const a = getAsset(ctx.db, assetId);
  ctx.expectVersion('asset', a.id, a.version, expectedVersion);
  return a;
}

const openAssignment = (ctx: TxContext, assetId: string) =>
  ctx.db.prepare('SELECT id, person_id AS personId, role FROM assignments WHERE asset_id = ? AND ended_at IS NULL').get(assetId) as
    | { id: string; personId: string; role: string }
    | undefined;

const openLoan = (ctx: TxContext, assetId: string) =>
  ctx.db.prepare('SELECT id, borrower_id AS borrowerId, from_location_id AS fromLocationId FROM loans WHERE asset_id = ? AND returned_at IS NULL').get(assetId) as
    | { id: string; borrowerId: string; fromLocationId: string }
    | undefined;

const openRepair = (ctx: TxContext, assetId: string) =>
  ctx.db.prepare('SELECT id FROM repairs WHERE asset_id = ? AND completed_on IS NULL').get(assetId) as { id: string } | undefined;

function assertNotDisposed(a: AssetRow) {
  if (a.lifecycle === 'disposed') violate('asset_disposed', '폐기된 자산입니다.');
}

/** Ready, not lost, not on loan: the conditions for a new assignment or loan. */
function assertAvailableForNewUse(ctx: TxContext, a: AssetRow, what: string) {
  if (a.lifecycle !== 'ready') violate('asset_not_ready', `${what}: 수리·퇴역·폐기 상태의 자산입니다.`, { lifecycle: a.lifecycle });
  if (a.lossStatus === 'confirmed') violate('asset_lost', `${what}: 분실 확정된 자산입니다.`);
  if (openLoan(ctx, a.id)) violate('loan_open', `${what}: 대여 중인 자산입니다. 먼저 대여를 반납해 주세요.`);
}

/**
 * A location change of an asset that holds addresses keeps the addresses and opens a
 * "망 확인 필요" task. Changing only the responsible person never does.
 */
function changeLocation(ctx: TxContext, a: AssetRow, toLocationId: string, cause: string): void {
  if (a.locationId === toLocationId) return;
  const held = occupiedSlotsOfAsset(ctx.db, a.id);
  if (held.length === 0) return;
  if (ctx.db.prepare("SELECT 1 FROM tasks WHERE asset_id = ? AND kind = 'network_check' AND status = 'open'").get(a.id)) return;
  const id = newId();
  const detail = { fromLocationId: a.locationId, toLocationId, cause, addresses: held.map((h) => ({ networkId: h.networkId, ip: formatIp(h.ip), state: h.state })) };
  const eventId = ctx.emit({ eventType: 'task.created', entityType: 'asset', entityId: a.id, after: { taskId: id, kind: 'network_check', ...detail } });
  ctx.db.prepare("INSERT INTO tasks VALUES (?, 'network_check', ?, 'open', ?, ?, ?, NULL, NULL, 1)").run(id, a.id, JSON.stringify(detail), ctx.now, eventId);
}

export const assetAssign = defineCommand(
  'asset.assign',
  parser({ assetId: uuid, expectedVersion: version, personId: uuid, role: oneOf(['user', 'custodian'] as const), reason: optStr({ max: 500 }) }),
  (ctx, p) => {
    const a = loadForUpdate(ctx, p.assetId, p.expectedVersion);
    assertAvailableForNewUse(ctx, a, '배정 불가');
    const person = getPerson(ctx.db, p.personId);
    if (person.status !== 'active') violate('person_inactive', '비활성(퇴직 등) 사람에게는 새로 배정할 수 없습니다.');
    const current = openAssignment(ctx, a.id);
    if (current && current.personId === p.personId && current.role === p.role) violate('no_change', '이미 같은 사람에게 배정되어 있습니다.');
    const eventId = ctx.emit({
      eventType: current ? 'asset.reassigned' : 'asset.assigned', entityType: 'asset', entityId: a.id,
      before: current ? { personId: current.personId, role: current.role } : null, after: { personId: p.personId, role: p.role }, reason: p.reason,
    });
    if (current) ctx.db.prepare("UPDATE assignments SET ended_at = ?, end_reason = 'reassigned', end_event_id = ? WHERE id = ?").run(ctx.now, eventId, current.id);
    const id = newId();
    ctx.db.prepare('INSERT INTO assignments VALUES (?, ?, ?, ?, ?, NULL, NULL, ?, NULL)').run(id, a.id, p.personId, p.role, ctx.now, eventId);
    bumpAsset(ctx.db, a.id, ctx.now);
    return { assignmentId: id };
  },
);

/** 일반 반납: ends the primary assignment and puts the asset in a chosen storage location. */
export const assetReturn = defineCommand(
  'asset.return',
  parser({ assetId: uuid, expectedVersion: version, locationId: optUuid, endReason: oneOf(['returned', 'lost', 'other'] as const), reason: optStr({ max: 500 }) }),
  (ctx, p) => {
    const a = loadForUpdate(ctx, p.assetId, p.expectedVersion);
    const current = openAssignment(ctx, a.id) ?? violate('no_assignment', '배정된 담당자가 없습니다.');
    if (openLoan(ctx, a.id)) violate('loan_open', '대여 중인 자산입니다. 먼저 대여를 반납해 주세요.');
    if (p.endReason !== 'lost' && !p.locationId) fail('VALIDATION', '반납 후 보관 장소를 선택해 주세요.', { field: 'locationId' });
    if (p.locationId) getActiveLocation(ctx.db, p.locationId);
    const eventId = ctx.emit({
      eventType: 'asset.returned', entityType: 'asset', entityId: a.id,
      before: { personId: current.personId, locationId: a.locationId }, after: { personId: null, locationId: p.locationId ?? a.locationId, endReason: p.endReason }, reason: p.reason,
    });
    ctx.db.prepare('UPDATE assignments SET ended_at = ?, end_reason = ?, end_event_id = ? WHERE id = ?').run(ctx.now, p.endReason, eventId, current.id);
    if (p.locationId && p.locationId !== a.locationId) {
      changeLocation(ctx, a, p.locationId, 'return');
      bumpAsset(ctx.db, a.id, ctx.now, { location_id: p.locationId });
    } else bumpAsset(ctx.db, a.id, ctx.now);
    return { assetId: a.id };
  },
);

/** Bulk move: every target is checked against its version; any conflict rolls back all. */
export const assetMove = defineCommand(
  'asset.move',
  parser({ items: list(shape({ assetId: uuid, expectedVersion: version }), { min: 1, max: 5000 }), locationId: uuid, reason: optStr({ max: 500 }) }),
  (ctx, p) => {
    getActiveLocation(ctx.db, p.locationId);
    const seen = new Set<string>();
    let moved = 0;
    p.items.forEach((item, i) => {
      if (seen.has(item.assetId)) fail('VALIDATION', '같은 자산이 두 번 선택되었습니다.', { field: `items[${i}]` });
      seen.add(item.assetId);
      ctx.checkCancelled();
      const a = loadForUpdate(ctx, item.assetId, item.expectedVersion);
      assertNotDisposed(a);
      if (openLoan(ctx, a.id)) violate('loan_open', '대여 중인 자산은 이동할 수 없습니다. 대여 반납 시 위치를 지정해 주세요.', { assetId: a.id });
      if (a.locationId === p.locationId) return;
      ctx.emit({ eventType: 'asset.moved', entityType: 'asset', entityId: a.id, before: { locationId: a.locationId }, after: { locationId: p.locationId }, reason: p.reason });
      changeLocation(ctx, a, p.locationId, 'move');
      bumpAsset(ctx.db, a.id, ctx.now, { location_id: p.locationId });
      moved++;
      ctx.progress(i + 1, p.items.length);
    });
    return { moved };
  },
);

export const loanOpen = defineCommand(
  'loan.open',
  parser({ assetId: uuid, expectedVersion: version, borrowerId: uuid, dueOn: date, locationId: uuid, purpose: optStr({ max: 500 }) }),
  (ctx, p) => {
    const a = loadForUpdate(ctx, p.assetId, p.expectedVersion);
    assertAvailableForNewUse(ctx, a, '대여 불가');
    const borrower = getPerson(ctx.db, p.borrowerId);
    if (borrower.status !== 'active') violate('person_inactive', '비활성(퇴직 등) 사람에게는 대여할 수 없습니다.');
    getActiveLocation(ctx.db, p.locationId);
    const eventId = ctx.emit({
      eventType: 'loan.opened', entityType: 'asset', entityId: a.id,
      before: { locationId: a.locationId }, after: { borrowerId: p.borrowerId, dueOn: p.dueOn, locationId: p.locationId, purpose: p.purpose },
    });
    const id = newId();
    ctx.db.prepare('INSERT INTO loans VALUES (?, ?, ?, ?, ?, ?, NULL, NULL, NULL, ?, ?, NULL)').run(id, a.id, p.borrowerId, a.locationId, ctx.now, p.dueOn, p.purpose, eventId);
    changeLocation(ctx, a, p.locationId, 'loan');
    bumpAsset(ctx.db, a.id, ctx.now, { location_id: p.locationId });
    return { loanId: id };
  },
);

/** 대여 반납 ends temporary possession only; the primary assignment stays. */
export const loanReturn = defineCommand(
  'loan.return',
  parser({ assetId: uuid, expectedVersion: version, returnLocationId: optUuid, endReason: oneOf(['returned', 'lost'] as const), reason: optStr({ max: 500 }) }),
  (ctx, p) => {
    const a = loadForUpdate(ctx, p.assetId, p.expectedVersion);
    const loan = openLoan(ctx, a.id) ?? violate('no_loan', '열린 대여가 없습니다.');
    if (p.endReason === 'returned' && !p.returnLocationId) fail('VALIDATION', '반납 위치를 선택해 주세요.', { field: 'returnLocationId' });
    if (p.returnLocationId) getActiveLocation(ctx.db, p.returnLocationId);
    const eventId = ctx.emit({
      eventType: 'loan.returned', entityType: 'asset', entityId: a.id,
      before: { borrowerId: loan.borrowerId, locationId: a.locationId }, after: { locationId: p.returnLocationId ?? a.locationId, endReason: p.endReason }, reason: p.reason,
    });
    ctx.db.prepare('UPDATE loans SET returned_at = ?, return_location_id = ?, end_reason = ?, end_event_id = ? WHERE id = ?').run(ctx.now, p.returnLocationId, p.endReason, eventId, loan.id);
    if (p.returnLocationId && p.returnLocationId !== a.locationId) {
      changeLocation(ctx, a, p.returnLocationId, 'loan_return');
      bumpAsset(ctx.db, a.id, ctx.now, { location_id: p.returnLocationId });
    } else bumpAsset(ctx.db, a.id, ctx.now);
    return { loanId: loan.id };
  },
);

export const repairOpen = defineCommand(
  'repair.open',
  parser({ assetId: uuid, expectedVersion: version, symptom: str({ max: 1000 }), vendor: optStr({ max: 200 }), receivedOn: date }),
  (ctx, p) => {
    const a = loadForUpdate(ctx, p.assetId, p.expectedVersion);
    if (a.lifecycle !== 'ready') violate('asset_not_ready', '사용 가능 상태의 자산만 수리 접수할 수 있습니다.', { lifecycle: a.lifecycle });
    if (openLoan(ctx, a.id)) violate('loan_open', '대여 중인 자산입니다. 먼저 대여를 반납해 주세요.');
    const eventId = ctx.emit({ eventType: 'repair.opened', entityType: 'asset', entityId: a.id, before: { lifecycle: 'ready' }, after: { lifecycle: 'in_repair', symptom: p.symptom, vendor: p.vendor }, occurredAt: p.receivedOn });
    const id = newId();
    ctx.db.prepare('INSERT INTO repairs VALUES (?, ?, ?, ?, ?, NULL, NULL, NULL, ?, NULL)').run(id, a.id, p.symptom, p.vendor, p.receivedOn, eventId);
    bumpAsset(ctx.db, a.id, ctx.now, { lifecycle: 'in_repair' });
    return { repairId: id };
  },
);

export const repairComplete = defineCommand(
  'repair.complete',
  parser({ assetId: uuid, expectedVersion: version, completedOn: date, result: str({ max: 1000 }), cost: optInt({ min: 0, max: 1_000_000_000 }) }),
  (ctx, p) => {
    const a = loadForUpdate(ctx, p.assetId, p.expectedVersion);
    const r = openRepair(ctx, a.id) ?? violate('no_repair', '진행 중인 수리가 없습니다.');
    const eventId = ctx.emit({ eventType: 'repair.completed', entityType: 'asset', entityId: a.id, before: { lifecycle: 'in_repair' }, after: { lifecycle: 'ready', result: p.result, cost: p.cost }, occurredAt: p.completedOn });
    ctx.db.prepare('UPDATE repairs SET completed_on = ?, result = ?, cost = ?, end_event_id = ? WHERE id = ?').run(p.completedOn, p.result, p.cost, eventId, r.id);
    bumpAsset(ctx.db, a.id, ctx.now, { lifecycle: 'ready' });
    return { repairId: r.id };
  },
);

export const assetRetire = defineCommand('asset.retire', parser({ assetId: uuid, expectedVersion: version, reason: str({ max: 500 }) }), (ctx, p) => {
  const a = loadForUpdate(ctx, p.assetId, p.expectedVersion);
  if (a.lifecycle !== 'ready') violate('asset_not_ready', '사용 가능 상태에서만 퇴역할 수 있습니다. 수리를 먼저 완료해 주세요.', { lifecycle: a.lifecycle });
  if (openLoan(ctx, a.id)) violate('loan_open', '대여 중인 자산입니다. 먼저 대여를 반납해 주세요.');
  ctx.emit({ eventType: 'asset.retired', entityType: 'asset', entityId: a.id, before: { lifecycle: 'ready' }, after: { lifecycle: 'retired' }, reason: p.reason });
  bumpAsset(ctx.db, a.id, ctx.now, { lifecycle: 'retired' });
  return { assetId: a.id };
});

export const assetCancelRetire = defineCommand('asset.cancelRetire', parser({ assetId: uuid, expectedVersion: version, reason: str({ max: 500 }) }), (ctx, p) => {
  const a = loadForUpdate(ctx, p.assetId, p.expectedVersion);
  if (a.lifecycle !== 'retired') violate('asset_not_retired', '퇴역 상태가 아닙니다.', { lifecycle: a.lifecycle });
  ctx.emit({ eventType: 'asset.retireCancelled', entityType: 'asset', entityId: a.id, before: { lifecycle: 'retired' }, after: { lifecycle: 'ready' }, reason: p.reason });
  bumpAsset(ctx.db, a.id, ctx.now, { lifecycle: 'ready' });
  return { assetId: a.id };
});

/** Loss is a separate administrative declaration; lifecycle, people and IPs do not change. */
export const assetConfirmLoss = defineCommand(
  'asset.confirmLoss',
  parser({ assetId: uuid, expectedVersion: version, reason: str({ max: 500 }), evidence: str({ max: 1000 }) }),
  (ctx, p) => {
    const a = loadForUpdate(ctx, p.assetId, p.expectedVersion);
    assertNotDisposed(a);
    if (a.lossStatus === 'confirmed') violate('no_change', '이미 분실 확정된 자산입니다.');
    ctx.emit({ eventType: 'asset.lossConfirmed', entityType: 'asset', entityId: a.id, before: { lossStatus: 'none' }, after: { lossStatus: 'confirmed', evidence: p.evidence }, reason: p.reason });
    bumpAsset(ctx.db, a.id, ctx.now, { loss_status: 'confirmed' });
    return { assetId: a.id };
  },
);

export const assetRecoverLoss = defineCommand(
  'asset.recoverLoss',
  parser({ assetId: uuid, expectedVersion: version, checkedAt: instant, locationId: uuid, reason: str({ max: 500 }) }),
  (ctx, p) => {
    const a = loadForUpdate(ctx, p.assetId, p.expectedVersion);
    if (a.lossStatus !== 'confirmed') violate('not_lost', '분실 확정 상태가 아닙니다.');
    getActiveLocation(ctx.db, p.locationId);
    const eventId = ctx.emit({
      eventType: 'asset.lossRecovered', entityType: 'asset', entityId: a.id, occurredAt: p.checkedAt,
      before: { lossStatus: 'confirmed', locationId: a.locationId }, after: { lossStatus: 'none', locationId: p.locationId, checkedAt: p.checkedAt }, reason: p.reason,
    });
    ctx.db.prepare("INSERT INTO physical_checks VALUES (?, ?, ?, ?, 'loss_recovery', NULL, NULL, ?)").run(newId(), a.id, p.checkedAt, p.locationId, eventId);
    if (p.locationId !== a.locationId) changeLocation(ctx, a, p.locationId, 'loss_recovery');
    bumpAsset(ctx.db, a.id, ctx.now, { loss_status: 'none', location_id: p.locationId });
    return { assetId: a.id };
  },
);

/** Everything that must be settled before disposal. Returned for display and enforced on dispose. */
export function disposalBlockers(db: TxContext['db'], assetId: string): string[] {
  const blockers: string[] = [];
  const has = (sql: string) => db.prepare(sql).get(assetId) !== undefined;
  if (has('SELECT 1 FROM assignments WHERE asset_id = ? AND ended_at IS NULL')) blockers.push('open_assignment');
  if (has('SELECT 1 FROM loans WHERE asset_id = ? AND returned_at IS NULL')) blockers.push('open_loan');
  if (has('SELECT 1 FROM repairs WHERE asset_id = ? AND completed_on IS NULL')) blockers.push('open_repair');
  if (occupiedSlotsOfAsset(db, assetId).length > 0) blockers.push('occupied_address');
  if (has("SELECT 1 FROM tasks WHERE asset_id = ? AND status = 'open'")) blockers.push('open_task');
  if (has("SELECT 1 FROM release_requests r JOIN interfaces i ON i.id = r.to_interface_id WHERE i.asset_id = ? AND r.status IN ('requested','evidenced')")) blockers.push('incoming_transfer');
  return blockers;
}

export const assetDispose = defineCommand(
  'asset.dispose',
  parser({ assetId: uuid, expectedVersion: version, disposedOn: date, reason: str({ max: 500 }), evidence: str({ max: 1000 }), finalConfirm: mustConfirm }),
  (ctx, p) => {
    const a = loadForUpdate(ctx, p.assetId, p.expectedVersion);
    if (a.lifecycle !== 'retired') violate('asset_not_retired', '퇴역한 자산만 폐기할 수 있습니다.', { lifecycle: a.lifecycle });
    const blockers = disposalBlockers(ctx.db, a.id);
    if (blockers.length) violate('disposal_blocked', '정리되지 않은 배정·대여·수리·IP·과제가 있어 폐기할 수 없습니다.', { blockers });
    const eventId = ctx.emit({
      eventType: 'asset.disposed', entityType: 'asset', entityId: a.id, occurredAt: p.disposedOn,
      before: { lifecycle: 'retired' }, after: { lifecycle: 'disposed', disposedOn: p.disposedOn, evidence: p.evidence }, reason: p.reason,
    });
    ctx.db.prepare("UPDATE interfaces SET status = 'disabled', version = version + 1 WHERE asset_id = ? AND status = 'enabled'").run(a.id);
    bumpAsset(ctx.db, a.id, ctx.now, { lifecycle: 'disposed' });
    return { assetId: a.id, eventId };
  },
);

/** 폐기 오기 정정: disposed → retired only. People and IPs are not restored. */
export const assetCorrectDisposal = defineCommand(
  'asset.correctDisposal',
  parser({ assetId: uuid, expectedVersion: version, disposalEventId: uuid, reason: str({ max: 500 }) }),
  (ctx, p) => {
    const a = loadForUpdate(ctx, p.assetId, p.expectedVersion);
    if (a.lifecycle !== 'disposed') violate('asset_not_disposed', '폐기 상태가 아닙니다.');
    const ev = ctx.db.prepare("SELECT event_id FROM audit_events WHERE event_id = ? AND entity_id = ? AND event_type = 'asset.disposed'").get(p.disposalEventId, a.id);
    if (!ev) fail('NOT_FOUND', '정정할 폐기 기록을 찾을 수 없습니다.');
    ctx.emit({
      eventType: 'asset.disposalCorrected', entityType: 'asset', entityId: a.id, correctsEventId: p.disposalEventId,
      before: { lifecycle: 'disposed' }, after: { lifecycle: 'retired' }, reason: p.reason,
    });
    bumpAsset(ctx.db, a.id, ctx.now, { lifecycle: 'retired' });
    return { assetId: a.id };
  },
);

/**
 * Corrects a past record's content (e.g. a mistyped location) as a new linked event. The
 * current state is not touched; later regular events stay in force.
 */
export const eventCorrect = defineCommand(
  'event.correct',
  parser({ eventId: uuid, reason: str({ max: 500 }), corrected: (v, f) => {
    if (typeof v !== 'object' || v === null || Array.isArray(v) || JSON.stringify(v).length > 4000) return fail('VALIDATION', '정정 내용을 입력해 주세요.', { field: f });
    return v as Record<string, unknown>;
  } }),
  (ctx, p) => {
    const target = ctx.db.prepare('SELECT event_id AS id, entity_type AS entityType, entity_id AS entityId, after_json AS afterJson FROM audit_events WHERE event_id = ?').get(p.eventId) as
      | { id: string; entityType: string; entityId: string; afterJson: string | null }
      | undefined;
    if (!target) fail('NOT_FOUND', '정정할 기록을 찾을 수 없습니다.');
    if (target!.entityType === 'event') violate('correct_correction', '정정 기록은 다시 원 기록을 기준으로 정정해 주세요.');
    const id = ctx.emit({
      eventType: 'event.corrected', entityType: 'event', entityId: p.eventId, correctsEventId: p.eventId,
      before: target!.afterJson ? JSON.parse(target!.afterJson) : null, after: p.corrected, reason: p.reason,
    });
    return { correctionEventId: id };
  },
);

export const taskResolve = defineCommand(
  'task.resolve',
  parser({ taskId: uuid, expectedVersion: version, resolution: oneOf(['confirmed_same_network', 'confirmed_changed_handled', 'other'] as const), reason: str({ max: 1000 }) }),
  (ctx, p) => {
    const t = ctx.db.prepare('SELECT id, asset_id AS assetId, status, version FROM tasks WHERE id = ?').get(p.taskId) as
      | { id: string; assetId: string; status: string; version: number }
      | undefined;
    if (!t) fail('NOT_FOUND', '과제를 찾을 수 없습니다.');
    ctx.expectVersion('task', t!.id, t!.version, p.expectedVersion);
    if (t!.status !== 'open') violate('task_closed', '이미 해소된 과제입니다.');
    ctx.db.prepare("UPDATE tasks SET status = 'resolved', resolved_at = ?, resolution = ?, version = version + 1 WHERE id = ?").run(ctx.now, `${p.resolution}: ${p.reason}`, t!.id);
    ctx.emit({ eventType: 'task.resolved', entityType: 'asset', entityId: t!.assetId, after: { taskId: t!.id, resolution: p.resolution }, reason: p.reason });
    return { taskId: t!.id };
  },
);

export const workflowCommands = [
  assetAssign, assetReturn, assetMove, loanOpen, loanReturn, repairOpen, repairComplete, assetRetire, assetCancelRetire,
  assetConfirmLoss, assetRecoverLoss, assetDispose, assetCorrectDisposal, eventCorrect, taskResolve,
];
