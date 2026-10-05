import { describe, expect, it } from 'vitest';
import { hostRange, formatIp, parseCidr, parseIp } from '../../../src/main/data/domain/ipv4';
import { slotByIp } from '../../../src/main/data/domain/network-queries';
import { assetCounts, getAssetDetail, getAssetHistory, listLocations } from '../../../src/main/data/domain/queries';
import { listUnresolved } from '../../../src/main/data/domain/unresolved';
import { auditCount, codeOf, useDomain } from './support';

const ctx = useDomain();

const unspecified = () => ctx.read((db) => listLocations(db)).find((l) => l.isUnspecified)!.id;
const room = (name: string) => ctx.exec('location.create', { name, parentId: null }).id as string;
const person = (name: string) => ctx.exec('person.create', { displayName: name }).id as string;
const v = (assetId: string) => ctx.read((db) => getAssetDetail(db, assetId))!.asset.version;
const detail = (assetId: string) => ctx.read((db) => getAssetDetail(db, assetId))!;

function assets(n: number, kind = 'laptop', locationId = unspecified(), withNic = true): string[] {
  return ctx.exec('asset.registerBatch', {
    locationId,
    items: [{ kind, quantity: n, interfaces: withNic ? [{ kind: 'ethernet', label: '유선' }] : [] }],
  }).assetIds;
}

function network(cidr = '10.50.0.0/24') {
  const { first, last } = hostRange(parseCidr(cidr));
  return ctx.exec('network.create', { name: `망 ${cidr}`, cidr, gateway: null, dns: [], ranges: [{ kind: 'static', first: formatIp(first), last: formatIp(last) }] }).networkId as string;
}

function giveIp(assetId: string, networkId: string, ip: string) {
  const iface = detail(assetId).interfaces[0]!.id;
  ctx.exec('address.reserve', { networkId, ip, interfaceId: iface, reason: '합성', expectedSlotVersion: null });
  const s = ctx.read((db) => slotByIp(db, networkId, parseIp(ip)))!;
  ctx.exec('address.activate', { slotId: s.id, expectedVersion: s.version });
}

const assign = (assetId: string, personId: string) => ctx.exec('asset.assign', { assetId, expectedVersion: v(assetId), personId, role: 'user', reason: null });

describe('AC-04 retirement of a person', () => {
  it('keeps both assignments and IPs, lists them as unresolved and blocks new assignments', () => {
    const kim = person('가상교사 김하나');
    const [a, b, c] = assets(3);
    const net = network();
    assign(a!, kim);
    assign(b!, kim);
    giveIp(a!, net, '10.50.0.10');
    giveIp(b!, net, '10.50.0.11');
    ctx.exec('person.setStatus', { id: kim, expectedVersion: 1, status: 'inactive', reason: '퇴직(합성)' });
    for (const id of [a!, b!]) {
      expect(detail(id).assignment).toMatchObject({ personId: kim, personStatus: 'inactive' });
      expect(detail(id).interfaces[0]!.slots[0]!.state).toBe('active');
    }
    const unresolved = ctx.read((db) => listUnresolved(db, { today: '2026-03-10' }));
    const held = unresolved.filter((u) => u.category === 'inactive_person_holding');
    expect(held.map((u) => u.assetId).sort()).toEqual([a!, b!].sort());
    expect(held.every((u) => u.personId === kim)).toBe(true);
    expect(codeOf(() => assign(c!, kim))).toBe('RULE_VIOLATION:person_inactive');
  });
});

describe('AC-05 general return vs loan return', () => {
  it('general return ends only that assignment; loan return keeps the assignment', () => {
    const kim = person('가상교사 김');
    const lee = person('가상교사 이');
    const store = room('정보실 창고');
    const [a, b] = assets(2);
    const net = network();
    assign(a!, kim);
    assign(b!, kim);
    giveIp(a!, net, '10.50.0.20');
    const bBefore = detail(b!);
    ctx.exec('asset.return', { assetId: a!, expectedVersion: v(a!), locationId: store, endReason: 'returned', reason: null });
    expect(detail(a!).assignment).toBeNull();
    expect(detail(a!).asset.locationId).toBe(store);
    expect(detail(a!).interfaces[0]!.slots[0]!.state).toBe('active');
    expect(detail(b!)).toEqual(bBefore);

    ctx.exec('loan.open', { assetId: b!, expectedVersion: v(b!), borrowerId: lee, dueOn: '2026-03-20', locationId: store, purpose: '연수' });
    expect(codeOf(() => ctx.exec('asset.return', { assetId: b!, expectedVersion: v(b!), locationId: store, endReason: 'returned', reason: null }))).toBe('RULE_VIOLATION:loan_open');
    ctx.exec('loan.return', { assetId: b!, expectedVersion: v(b!), returnLocationId: unspecified(), endReason: 'returned', reason: null });
    expect(detail(b!).assignment).toMatchObject({ personId: kim });
    expect(detail(b!).loan).toBeNull();
  });
});

describe('AC-06 bulk move', () => {
  it('moves 100 assets with individual history, and one stale version leaves all 100 unchanged', () => {
    const from = room('본관 3층');
    const to = room('별관 창고');
    const ids = assets(100, 'monitor', from, false);
    const items = ids.map((assetId) => ({ assetId, expectedVersion: v(assetId) }));
    const before = auditCount(ctx);
    const stale = items.map((i, n) => (n === 57 ? { ...i, expectedVersion: i.expectedVersion + 9 } : i));
    expect(codeOf(() => ctx.exec('asset.move', { items: stale, locationId: to, reason: '이전' }))).toBe('VERSION_CONFLICT');
    expect(ids.every((id) => detail(id).asset.locationId === from)).toBe(true);
    expect(auditCount(ctx)).toBe(before);
    expect(ctx.exec('asset.move', { items, locationId: to, reason: '이전' })).toEqual({ moved: 100 });
    expect(ids.every((id) => detail(id).asset.locationId === to)).toBe(true);
    expect(ctx.read((db) => assetCounts(db)).registeredTotal).toBe(100);
    const h = ctx.read((db) => getAssetHistory(db, ids[42]!));
    expect(h.filter((e) => e.eventType === 'asset.moved')).toHaveLength(1);
    expect(h.find((e) => e.eventType === 'asset.moved')).toMatchObject({ before: { locationId: from }, after: { locationId: to } });
  });
});

describe('AC-07 loans and repairs', () => {
  it('runs loan -> overdue -> return and repair -> complete; blocks conflicting states', () => {
    const park = person('가상교사 박');
    const [a] = assets(1);
    ctx.exec('loan.open', { assetId: a!, expectedVersion: v(a!), borrowerId: park, dueOn: '2026-03-05', locationId: unspecified(), purpose: null });
    expect(codeOf(() => ctx.exec('loan.open', { assetId: a!, expectedVersion: v(a!), borrowerId: park, dueOn: '2026-03-09', locationId: unspecified(), purpose: null }))).toBe('RULE_VIOLATION:loan_open');
    expect(codeOf(() => ctx.exec('repair.open', { assetId: a!, expectedVersion: v(a!), symptom: '화면 깨짐', vendor: null, receivedOn: '2026-03-04' }))).toBe('RULE_VIOLATION:loan_open');
    expect(codeOf(() => assign(a!, park))).toBe('RULE_VIOLATION:loan_open');
    expect(ctx.read((db) => listUnresolved(db, { today: '2026-03-04' })).filter((u) => u.category === 'overdue_loan')).toHaveLength(0);
    expect(ctx.read((db) => listUnresolved(db, { today: '2026-03-06' })).filter((u) => u.category === 'overdue_loan').map((u) => u.assetId)).toEqual([a!]);
    // Overdue never returns automatically.
    expect(detail(a!).loan).not.toBeNull();
    ctx.exec('loan.return', { assetId: a!, expectedVersion: v(a!), returnLocationId: unspecified(), endReason: 'returned', reason: null });
    ctx.exec('repair.open', { assetId: a!, expectedVersion: v(a!), symptom: '화면 깨짐', vendor: '합성수리점', receivedOn: '2026-03-06' });
    expect(detail(a!).asset.lifecycle).toBe('in_repair');
    expect(codeOf(() => ctx.exec('repair.open', { assetId: a!, expectedVersion: v(a!), symptom: 'x', vendor: null, receivedOn: '2026-03-06' }))).toBe('RULE_VIOLATION:asset_not_ready');
    expect(codeOf(() => assign(a!, park))).toBe('RULE_VIOLATION:asset_not_ready');
    expect(codeOf(() => ctx.exec('loan.open', { assetId: a!, expectedVersion: v(a!), borrowerId: park, dueOn: '2026-03-09', locationId: unspecified(), purpose: null }))).toBe('RULE_VIOLATION:asset_not_ready');
    ctx.exec('repair.complete', { assetId: a!, expectedVersion: v(a!), completedOn: '2026-03-08', result: '패널 교체', cost: 120000 });
    expect(detail(a!).asset.lifecycle).toBe('ready');
  });
});

describe('AC-08 retirement and disposal', () => {
  it('blocks loans after retirement, refuses disposal with open relations, corrects disposal only back to retired', () => {
    const choi = person('가상교사 최');
    const [a] = assets(1);
    const net = network();
    assign(a!, choi);
    giveIp(a!, net, '10.50.0.30');
    ctx.exec('asset.retire', { assetId: a!, expectedVersion: v(a!), reason: '노후' });
    expect(codeOf(() => ctx.exec('loan.open', { assetId: a!, expectedVersion: v(a!), borrowerId: choi, dueOn: '2026-03-09', locationId: unspecified(), purpose: null }))).toBe('RULE_VIOLATION:asset_not_ready');
    expect(ctx.read((db) => listUnresolved(db, { today: '2026-03-10' })).some((u) => u.category === 'retired_cleanup' && u.assetId === a)).toBe(true);
    const dispose = () =>
      ctx.exec('asset.dispose', { assetId: a!, expectedVersion: v(a!), disposedOn: '2026-03-10', reason: '불용 처리', evidence: '불용 결정 합성 문서', finalConfirm: true });
    expect(codeOf(dispose)).toBe('RULE_VIOLATION:disposal_blocked');
    ctx.exec('asset.return', { assetId: a!, expectedVersion: v(a!), locationId: unspecified(), endReason: 'returned', reason: null });
    expect(codeOf(dispose)).toBe('RULE_VIOLATION:disposal_blocked');
    const s = ctx.read((db) => slotByIp(db, net, parseIp('10.50.0.30')))!;
    const { requestId } = ctx.exec('address.requestRelease', { slotId: s.id, expectedVersion: s.version, reason: '폐기 준비' });
    ctx.exec('address.recordEvidence', { requestId, expectedRequestVersion: 1, evidenceKind: 'device_wiped', note: '디스크 초기화', checkedAt: '2026-03-09T00:00:00Z' });
    ctx.exec('address.finalizeRelease', { requestId, expectedRequestVersion: 2, finalConfirm: true });
    const { eventId } = dispose();
    expect(detail(a!).asset.lifecycle).toBe('disposed');
    expect(codeOf(() => ctx.exec('asset.cancelRetire', { assetId: a!, expectedVersion: v(a!), reason: '실수' }))).toBe('RULE_VIOLATION:asset_not_retired');
    ctx.exec('asset.correctDisposal', { assetId: a!, expectedVersion: v(a!), disposalEventId: eventId, reason: '다른 장비로 오기' });
    expect(detail(a!)).toMatchObject({ asset: { lifecycle: 'retired' }, assignment: null });
    expect(detail(a!).interfaces[0]!.slots).toEqual([]);
  });
});

describe('loss', () => {
  it('confirmation keeps lifecycle, people and IPs; blocks new use; recovery records a physical check', () => {
    const jung = person('가상교사 정');
    const [a] = assets(1);
    const net = network();
    assign(a!, jung);
    giveIp(a!, net, '10.50.0.40');
    ctx.exec('asset.confirmLoss', { assetId: a!, expectedVersion: v(a!), reason: '분실 신고', evidence: '합성 신고서' });
    expect(detail(a!)).toMatchObject({ asset: { lifecycle: 'ready', lossStatus: 'confirmed' }, assignment: { personId: jung } });
    expect(detail(a!).interfaces[0]!.slots[0]!.state).toBe('active');
    expect(codeOf(() => ctx.exec('loan.open', { assetId: a!, expectedVersion: v(a!), borrowerId: jung, dueOn: '2026-03-09', locationId: unspecified(), purpose: null }))).toBe('RULE_VIOLATION:asset_lost');
    ctx.exec('asset.recoverLoss', { assetId: a!, expectedVersion: v(a!), checkedAt: '2026-03-12T03:00:00Z', locationId: unspecified(), reason: '교실에서 발견' });
    expect(detail(a!)).toMatchObject({ asset: { lossStatus: 'none' }, lastPhysicalCheck: { checkedAt: '2026-03-12T03:00:00.000Z', source: 'loss_recovery' } });
  });
});

describe('AC-17 network check tasks', () => {
  it('owner change keeps IP with no task; classroom -> storage keeps IP and opens a task; resolving keeps IP', () => {
    const classroom = room('3-1 교실');
    const storage = room('창고');
    const kim = person('가상교사 김');
    const lee = person('가상교사 이');
    const [a] = assets(1, 'desktop', classroom);
    const net = network();
    giveIp(a!, net, '10.50.0.50');
    assign(a!, kim);
    assign(a!, lee);
    expect(detail(a!).openTasks).toEqual([]);
    ctx.exec('asset.move', { items: [{ assetId: a!, expectedVersion: v(a!) }], locationId: storage, reason: '교체 보관' });
    const tasks = detail(a!).openTasks;
    expect(tasks).toHaveLength(1);
    expect(tasks[0]).toMatchObject({ kind: 'network_check', detail: { fromLocationId: classroom, toLocationId: storage, addresses: [{ ip: '10.50.0.50' }] } });
    expect(detail(a!).interfaces[0]!.slots[0]!.state).toBe('active');
    ctx.exec('task.resolve', { taskId: tasks[0]!.id, expectedVersion: tasks[0]!.version, resolution: 'confirmed_same_network', reason: '창고도 같은 망 확인' });
    expect(detail(a!).openTasks).toEqual([]);
    expect(detail(a!).interfaces[0]!.slots[0]!.state).toBe('active');
    // An asset without addresses never gets a network task.
    const [m] = assets(1, 'monitor', classroom, false);
    ctx.exec('asset.move', { items: [{ assetId: m!, expectedVersion: v(m!) }], locationId: storage, reason: null });
    expect(detail(m!).openTasks).toEqual([]);
  });
});

describe('AC-29 corrections', () => {
  it('correcting an old mistyped move keeps the later regular move; original, correction and new event are visible', () => {
    const a1 = room('1층 교무실');
    const b2 = room('2층 교무실');
    const c3 = room('3층 교무실');
    const [x] = assets(1, 'laptop', a1, false);
    ctx.exec('asset.move', { items: [{ assetId: x!, expectedVersion: v(x!) }], locationId: b2, reason: '이동(오기: 실제는 3층)' });
    const wrong = ctx.read((db) => getAssetHistory(db, x!)).find((e) => e.eventType === 'asset.moved')!;
    ctx.exec('asset.move', { items: [{ assetId: x!, expectedVersion: v(x!) }], locationId: a1, reason: '정상 이동' });
    ctx.exec('event.correct', { eventId: wrong.eventId, reason: '당시 실제 위치는 3층', corrected: { locationId: c3 } });
    expect(detail(x!).asset.locationId).toBe(a1);
    const h = ctx.read((db) => getAssetHistory(db, x!));
    const original = h.find((e) => e.eventId === wrong.eventId)!;
    expect(original.correctedBy).toHaveLength(1);
    const correction = h.find((e) => e.correctsEventId === wrong.eventId)!;
    expect(correction).toMatchObject({ eventType: 'event.corrected', reason: '당시 실제 위치는 3층', after: { locationId: c3 } });
    expect(h.filter((e) => e.eventType === 'asset.moved')).toHaveLength(2);
  });
});
