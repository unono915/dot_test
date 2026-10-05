import { describe, expect, it } from 'vitest';
import { parseIp } from '../../../src/main/data/domain/ipv4';
import { slotByIp } from '../../../src/main/data/domain/network-queries';
import { compareObservationSession, listObservations } from '../../../src/main/data/domain/observations';
import { getAssetDetail, listLocations } from '../../../src/main/data/domain/queries';
import { codeOf, useDomain } from './support';

const ctx = useDomain();

function setup() {
  const loc = ctx.read((db) => listLocations(db))[0]!.id;
  const net = ctx.exec('network.create', { name: '관측망', cidr: '10.60.0.0/24', gateway: null, dns: [], ranges: [{ kind: 'static', first: '10.60.0.1', last: '10.60.0.254' }] }).networkId as string;
  const mk = (mac: string) => {
    const id = ctx.exec('asset.registerBatch', { locationId: loc, items: [{ kind: 'desktop', interfaces: [{ kind: 'ethernet', label: '유선', mac }] }] }).assetIds[0] as string;
    return { id, iface: ctx.read((db) => getAssetDetail(db, id))!.interfaces[0]!.id };
  };
  const oldPc = mk('AA:AA:AA:00:00:01');
  const newPc = mk('BB:BB:BB:00:00:02');
  const other = mk('CC:CC:CC:00:00:03');
  ctx.exec('address.reserve', { networkId: net, ip: '10.60.0.10', interfaceId: oldPc.iface, reason: '합성', expectedSlotVersion: null });
  return { net, oldPc, newPc, other };
}

const session = (label: string) =>
  ctx.exec('observation.createSession', { label, windowStart: '2026-03-02T00:00:00Z', windowEnd: '2026-03-02T01:00:00Z', source: '수동 기록' }).sessionId as string;

const record = (sessionId: string, networkId: string, items: { ip: string; mac?: string | null; assetId?: string | null }[]) =>
  ctx.exec('observation.record', {
    sessionId,
    items: items.map((i) => ({ networkId, ip: i.ip, mac: i.mac ?? null, assetId: i.assetId ?? null, observedAt: '2026-03-02T00:30:00Z', raw: null })),
  });

const judgment = (sessionId: string, ip: string) => ctx.read((db) => compareObservationSession(db, sessionId)).items.find((i) => i.ip === ip)!.judgment;

describe('AC-16 observation judgments', () => {
  it('flags two identifiers on one IP in one session as suspected conflict regardless of assignment', () => {
    const { net } = setup();
    const s = session('3월 점검');
    record(s, net, [{ ip: '10.60.0.10', mac: 'aa-aa-aa-00-00-01' }, { ip: '10.60.0.10', mac: 'CC:CC:CC:00:00:03' }, { ip: '10.60.0.99', mac: '11:11:11:11:11:11' }, { ip: '10.60.0.99', mac: '22:22:22:22:22:22' }]);
    expect(judgment(s, '10.60.0.10')).toBe('suspected_conflict');
    expect(judgment(s, '10.60.0.99')).toBe('suspected_conflict');
  });

  it('matching, mismatching, unknown; duplicates and equivalent spellings are not conflicts', () => {
    const { net, oldPc, other } = setup();
    const s = session('관측 1회차');
    record(s, net, [
      { ip: '10.60.0.10', mac: 'AA:AA:AA:00:00:01' },
      { ip: '10.60.0.10', mac: 'aa.aa.aa.00.00.01' },
      { ip: '10.60.0.10', assetId: oldPc.id },
      { ip: '10.60.0.20', mac: 'CC:CC:CC:00:00:03' },
      { ip: '10.60.0.30' },
    ]);
    expect(judgment(s, '10.60.0.10')).toBe('matching');
    expect(judgment(s, '10.60.0.20')).toBe('unknown');
    expect(judgment(s, '10.60.0.30')).toBe('unknown');
    const s2 = session('관측 2회차');
    record(s2, net, [{ ip: '10.60.0.10', assetId: other.id }]);
    expect(judgment(s2, '10.60.0.10')).toBe('mismatching');
  });

  it('keeps the old session after a normal replacement; the new session matches; observations never change assignments', () => {
    const { net, oldPc, newPc } = setup();
    const before = session('교체 전');
    record(before, net, [{ ip: '10.60.0.10', mac: 'AA:AA:AA:00:00:01' }]);
    let slot = ctx.read((db) => slotByIp(db, net, parseIp('10.60.0.10')))!;
    const { requestId } = ctx.exec('address.requestTransfer', { slotId: slot.id, expectedVersion: slot.version, toInterfaceId: newPc.iface, reason: 'PC 교체' });
    ctx.exec('address.recordEvidence', { requestId, expectedRequestVersion: 1, evidenceKind: 'never_configured', note: null, checkedAt: '2026-03-03T00:00:00Z' });
    slot = ctx.read((db) => slotByIp(db, net, parseIp('10.60.0.10')))!;
    const ver = (id: string) => (ctx.read((db) => db.prepare('SELECT version FROM interfaces WHERE id = ?').get(id)) as { version: number }).version;
    ctx.exec('address.finalizeTransfer', {
      requestId, expectedRequestVersion: 2, expectedSlotVersion: slot.version, expectedFromInterfaceVersion: ver(oldPc.iface), expectedToInterfaceVersion: ver(newPc.iface), finalConfirm: true,
    });
    const after = session('교체 후');
    record(after, net, [{ ip: '10.60.0.10', mac: 'BB:BB:BB:00:00:02' }]);
    expect(judgment(after, '10.60.0.10')).toBe('matching');
    expect(judgment(before, '10.60.0.10')).not.toBe('suspected_conflict');
    expect(ctx.read((db) => listObservations(db, before))).toHaveLength(1);
    const slotNow = ctx.read((db) => slotByIp(db, net, parseIp('10.60.0.10')))!;
    record(after, net, [{ ip: '10.60.0.10', mac: 'CC:CC:CC:00:00:03' }]);
    expect(ctx.read((db) => slotByIp(db, net, parseIp('10.60.0.10')))).toEqual(slotNow);
  });

  it('corrects an observation by supersession; the original stays immutable', () => {
    const { net } = setup();
    const s = session('정정 회차');
    record(s, net, [{ ip: '10.60.0.10', mac: 'CC:CC:CC:00:00:03' }]);
    expect(judgment(s, '10.60.0.10')).toBe('mismatching');
    const obs = ctx.read((db) => listObservations(db, s))[0]!;
    ctx.exec('observation.supersede', { observationId: obs.id, mac: 'AA:AA:AA:00:00:01', assetId: null, reason: '기록 실수' });
    expect(judgment(s, '10.60.0.10')).toBe('matching');
    const all = ctx.read((db) => listObservations(db, s, { includeSuperseded: true }));
    expect(all).toHaveLength(2);
    expect(all.find((o) => o.id === obs.id)!.mac).toBe('CC:CC:CC:00:00:03');
    expect(() => ctx.root.store.db.prepare('UPDATE observations SET mac = NULL').run()).toThrow(/append-only/);
    expect(codeOf(() => ctx.exec('observation.supersede', { observationId: obs.id, mac: null, assetId: null, reason: '두 번' }))).toBe('RULE_VIOLATION:already_superseded');
  });
});
