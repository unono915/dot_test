import { describe, expect, it } from 'vitest';
import { inventorySummary } from '../../../src/main/data/domain/inventory';
import { getAssetDetail, getAssetHistory, listLocations } from '../../../src/main/data/domain/queries';
import { listUnresolved } from '../../../src/main/data/domain/unresolved';
import { codeOf, useDomain } from './support';

const ctx = useDomain();

const room = (name: string) => ctx.exec('location.create', { name, parentId: null }).id as string;
const v = (id: string) => ctx.read((db) => getAssetDetail(db, id))!.asset.version;
const register = (n: number, locationId: string, kind = 'laptop') =>
  ctx.exec('asset.registerBatch', { locationId, items: [{ kind, quantity: n }] }).assetIds as string[];
const start = (title = '2026 상반기 실사', scope: Record<string, unknown> = {}) =>
  ctx.exec('inventory.start', { title, scope: { kinds: null, locationIds: null, ...scope } }).sessionId as string;
const found = (sessionId: string, assetId: string, foundLocationId: string, checkedAt = '2026-03-05T01:00:00Z', foundPersonId: string | null = null) =>
  ctx.exec('inventory.recordResult', { sessionId, assetId, outcome: 'found', foundLocationId, foundPersonId, checkedAt, note: null });
const notFound = (sessionId: string, assetId: string) =>
  ctx.exec('inventory.recordResult', { sessionId, assetId, outcome: 'not_found', foundLocationId: null, foundPersonId: null, checkedAt: '2026-03-05T02:00:00Z', note: '교실 전체 확인' });
const summary = (sessionId: string) => ctx.read((db) => inventorySummary(db, sessionId));

describe('AC-18 four results always sum to the frozen base', () => {
  it('80/10/5/5 -> total 100, physically checked 90, not-found assets are not lost or disposed', () => {
    const lab = room('컴퓨터실');
    const other = room('교무실');
    const ids = register(100, lab);
    const s = start();
    ids.slice(0, 80).forEach((id) => found(s, id, lab));
    ids.slice(80, 90).forEach((id) => found(s, id, other));
    ids.slice(90, 95).forEach((id) => notFound(s, id));
    const sum = summary(s);
    expect(sum.counts).toEqual({ base: 100, matched: 80, mismatched: 10, notFound: 5, unchecked: 5, physicallyChecked: 90 });
    expect(sum.counts.matched + sum.counts.mismatched + sum.counts.notFound + sum.counts.unchecked).toBe(sum.counts.base);
    for (const id of ids.slice(90, 95)) expect(ctx.read((db) => getAssetDetail(db, id))!.asset).toMatchObject({ lifecycle: 'ready', lossStatus: 'none', locationId: lab });
  });

  it('allows only one open session', () => {
    register(1, room('A'));
    start();
    expect(codeOf(() => start('두 번째'))).toBe('RULE_VIOLATION:inventory_open');
  });
});

describe('AC-19 frozen base vs current ledger', () => {
  it('keeps base 100 despite new registrations and moves; base-mismatch/current-match shown; dates not refreshed by not-found or observations', () => {
    const a = room('A동');
    const b = room('B동');
    const ids = register(100, a);
    const s = start();
    register(2, a);
    const moved = ids[0]!;
    ctx.exec('asset.move', { items: [{ assetId: moved, expectedVersion: v(moved) }], locationId: b, reason: '정상 이동' });
    found(s, moved, b, '2026-03-05T05:00:00Z');
    const sum = summary(s);
    expect(sum.counts.base).toBe(100);
    expect(sum.addedSinceBase).toHaveLength(2);
    const item = sum.items.find((i) => i.assetId === moved)!;
    expect(item).toMatchObject({ result: 'mismatched', vsCurrent: 'matched', baseLocationId: a, currentLocationId: b, changedSinceBase: true });
    expect(ctx.read((db) => getAssetDetail(db, moved))!.asset.locationId).toBe(b);
    expect(ctx.read((db) => getAssetDetail(db, moved))!.lastPhysicalCheck!.checkedAt).toBe('2026-03-05T05:00:00.000Z');

    ctx.exec('inventory.close', { sessionId: s, expectedVersion: sum.session.version, acknowledged: { unchecked: 99, notFound: 0, mismatched: 1 }, note: '1차 종료' });
    const s2 = start('재조사');
    notFound(s2, moved);
    const netId = ctx.exec('network.create', { name: '관측', cidr: '10.70.0.0/24', gateway: null, dns: [], ranges: [] }).networkId;
    const obs = ctx.exec('observation.createSession', { label: '관측', windowStart: '2026-03-06T00:00:00Z', windowEnd: '2026-03-06T01:00:00Z', source: '수동' }).sessionId;
    ctx.exec('observation.record', { sessionId: obs, items: [{ networkId: netId, ip: '10.70.0.5', mac: null, assetId: moved, observedAt: '2026-03-06T00:10:00Z', raw: null }] });
    expect(ctx.read((db) => getAssetDetail(db, moved))!.lastPhysicalCheck!.checkedAt).toBe('2026-03-05T05:00:00.000Z');
  });

  it('a corrected positive result no longer counts as a physical confirmation', () => {
    const a = room('C동');
    const [x] = register(1, a);
    const s = start();
    found(s, x!, a, '2026-03-05T01:00:00Z');
    notFound(s, x!);
    expect(summary(s).counts).toMatchObject({ matched: 0, notFound: 1 });
    expect(ctx.read((db) => getAssetDetail(db, x!))!.lastPhysicalCheck).toBeNull();
    expect(summary(s).items[0]!.history).toHaveLength(2);
  });
});

describe('AC-20 closed sessions are immutable', () => {
  it('requires acknowledging unresolved counts, refuses later edits, and keeps follow-ups as new events', () => {
    const a = room('D동');
    const b = room('E동');
    const ids = register(3, a);
    const s = start();
    found(s, ids[0]!, b);
    notFound(s, ids[1]!);
    const version = summary(s).session.version;
    expect(codeOf(() => ctx.exec('inventory.close', { sessionId: s, expectedVersion: version, acknowledged: { unchecked: 0, notFound: 1, mismatched: 1 }, note: null }))).toBe(
      'RULE_VIOLATION:acknowledgement_mismatch',
    );
    ctx.exec('inventory.close', { sessionId: s, expectedVersion: version, acknowledged: { unchecked: 1, notFound: 1, mismatched: 1 }, note: '미확인 1건 다음 학기' });
    const closed = summary(s);
    expect(closed.session).toMatchObject({ status: 'closed', closeSummary: { base: 3, matched: 0, mismatched: 1, notFound: 1, unchecked: 1 } });
    expect(codeOf(() => found(s, ids[2]!, a))).toBe('RULE_VIOLATION:inventory_closed');

    const unresolved = ctx.read((db) => listUnresolved(db, { today: '2026-03-10' }));
    expect(unresolved.filter((u) => u.sessionId === s).map((u) => u.category).sort()).toEqual(['inventory_mismatch', 'inventory_not_found', 'inventory_unchecked']);

    // Follow-up: move the mismatched asset to where it was found, then link it to the result.
    ctx.exec('asset.move', { items: [{ assetId: ids[0]!, expectedVersion: v(ids[0]!) }], locationId: b, reason: '실사 결과 반영' });
    const moveEvent = ctx.read((db) => getAssetHistory(db, ids[0]!)).filter((e) => e.eventType === 'asset.moved').pop()!;
    ctx.exec('inventory.linkFollowUp', { sessionId: s, assetId: ids[0]!, eventId: moveEvent.eventId, note: '위치 정정' });
    ctx.exec('inventory.addNote', { sessionId: s, note: '보완 설명(합성)' });
    const after = summary(s);
    expect(after.session.closeSummary).toEqual(closed.session.closeSummary);
    expect(after.items.find((i) => i.assetId === ids[0])!.result).toBe('mismatched');
    expect(after.notes).toHaveLength(1);
    expect(ctx.read((db) => listUnresolved(db, { today: '2026-03-10' })).filter((u) => u.sessionId === s).map((u) => u.category).sort()).toEqual([
      'inventory_not_found',
      'inventory_unchecked',
    ]);
  });

  it('records out-of-base findings separately without growing the denominator', () => {
    const a = room('F동');
    register(2, a);
    const s = start('범위 한정', { locationIds: [a] });
    const elsewhere = register(1, room('G동'))[0]!;
    ctx.exec('inventory.recordExtra', { sessionId: s, assetId: elsewhere, description: '기준 외 장소에서 발견', foundLocationId: a, checkedAt: '2026-03-05T03:00:00Z' });
    const sum = summary(s);
    expect(sum.counts.base).toBe(2);
    expect(sum.extras).toHaveLength(1);
  });
});
