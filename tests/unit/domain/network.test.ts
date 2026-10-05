import { describe, expect, it } from 'vitest';
import { formatIp, hostRange, parseCidr, parseIp } from '../../../src/main/data/domain/ipv4';
import { addressEligibility, listNetworks, listSubnetAddresses, slotByIp } from '../../../src/main/data/domain/network-queries';
import { getAssetDetail, listLocations } from '../../../src/main/data/domain/queries';
import { codeOf, useDomain, type Ctx } from './support';

const ctx = useDomain();

const S = (first: string, last: string, kind = 'static') => ({ kind, first, last });

function net(c: Ctx, name: string, cidr: string, extra: Record<string, unknown> = {}) {
  const { first, last } = hostRange(parseCidr(cidr));
  return c.exec('network.create', { name, cidr, gateway: null, dns: [], ranges: [S(formatIp(first), formatIp(last))], ...extra });
}

function pc(c: Ctx, kind = 'desktop') {
  const loc = c.read((db) => listLocations(db))[0]!.id;
  const assetId = c.exec('asset.registerBatch', { locationId: loc, items: [{ kind, interfaces: [{ kind: 'ethernet', label: '유선' }] }] }).assetIds[0] as string;
  const detail = c.read((db) => getAssetDetail(db, assetId))!;
  return { assetId, interfaceId: detail.interfaces[0]!.id, version: detail.asset.version };
}

const reserve = (c: Ctx, networkId: string, ip: string, interfaceId: string, opts: { commandId?: string } = {}) =>
  c.exec('address.reserve', { networkId, ip, interfaceId, reason: '합성 배정', expectedSlotVersion: null }, opts);

const slot = (c: Ctx, networkId: string, ip: string) => c.read((db) => slotByIp(db, networkId, parseIp(ip)))!;

describe('IPv4 primitives', () => {
  it('parses strictly and computes host ranges by policy', () => {
    expect(() => parseIp('010.0.0.1')).toThrow();
    expect(() => parseIp('256.0.0.1')).toThrow();
    expect(() => parseCidr('10.0.0.1/24')).toThrow(/망 주소/);
    expect(hostRange(parseCidr('10.0.0.0/23'))).toEqual({ first: parseIp('10.0.0.1'), last: parseIp('10.0.1.254') });
    expect(hostRange(parseCidr('10.0.0.0/31'))).toEqual({ first: parseIp('10.0.0.0'), last: parseIp('10.0.0.1') });
    expect(hostRange(parseCidr('10.0.0.7/32'))).toEqual({ first: parseIp('10.0.0.7'), last: parseIp('10.0.0.7') });
    expect(hostRange(parseCidr('0.0.0.0/0'))).toEqual({ first: 1, last: 2 ** 32 - 2 });
    expect(formatIp(2 ** 32 - 1)).toBe('255.255.255.255');
  });
});

describe('AC-09 non-overlapping real networks and aliases', () => {
  it('rejects an overlapping network, links aliases to the same id, allows a disjoint network', () => {
    const a = net(ctx, '본관 업무망', '10.20.0.0/16');
    expect(codeOf(() => net(ctx, '교무실', '10.20.5.0/24'))).toBe('RULE_VIOLATION:network_overlap');
    expect(codeOf(() => net(ctx, '중복', '10.20.0.0/16'))).toBe('RULE_VIOLATION:network_overlap');
    ctx.exec('network.addAlias', { networkId: a.networkId, alias: '교무실망(10.20.5.x)' });
    const b = net(ctx, '별관망', '10.30.0.0/24');
    const nets = ctx.read((db) => listNetworks(db));
    expect(nets).toHaveLength(2);
    expect(nets.find((n) => n.id === a.networkId)!.aliases).toEqual(['교무실망(10.20.5.x)']);
    expect(b.networkId).not.toBe(a.networkId);
    expect(codeOf(() => ctx.exec('network.addAlias', { networkId: b.networkId, alias: '교무실망(10.20.5.x)' }))).toBe('RULE_VIOLATION:alias_taken');
  });

  it('rejects overlapping subnets inside the same network', () => {
    const a = net(ctx, '본관', '10.40.0.0/24');
    const v = ctx.read((db) => listNetworks(db))[0]!.version;
    expect(codeOf(() => ctx.exec('network.addSubnet', { networkId: a.networkId, expectedVersion: v, cidr: '10.40.0.128/25', gateway: null, dns: [], ranges: [] }))).toBe(
      'RULE_VIOLATION:network_overlap',
    );
  });
});

describe('AC-10 full IPv4 handling without materialising ranges', () => {
  it('keeps /23, /31 and /32 addresses and distinguishes equal last octets across networks', () => {
    const a = net(ctx, 'A', '10.1.0.0/23');
    const b = net(ctx, 'B', '10.2.0.0/31');
    const c = net(ctx, 'C', '10.3.0.9/32');
    const one = pc(ctx);
    const two = pc(ctx);
    const three = pc(ctx);
    reserve(ctx, a.networkId, '10.1.1.10', one.interfaceId);
    reserve(ctx, b.networkId, '10.2.0.0', two.interfaceId);
    reserve(ctx, c.networkId, '10.3.0.9', three.interfaceId);
    reserve(ctx, a.networkId, '10.1.0.10', two.interfaceId);
    expect(slot(ctx, a.networkId, '10.1.1.10').interfaceId).toBe(one.interfaceId);
    expect(slot(ctx, a.networkId, '10.1.0.10').interfaceId).toBe(two.interfaceId);
    expect(ctx.read((db) => getAssetDetail(db, two.assetId))!.interfaces[0]!.slots.map((s) => s.ip)).toEqual(['10.1.0.10', '10.2.0.0']);
  });

  it('pages a /0 network near its end without creating rows', () => {
    const z = net(ctx, '전체', '0.0.0.0/0');
    const subnetId = ctx.read((db) => listNetworks(db))[0]!.subnets[0]!.id;
    const page = ctx.read((db) => listSubnetAddresses(db, subnetId, { offset: 2 ** 32 - 3, limit: 10 }));
    expect(page.total).toBe(2 ** 32);
    expect(page.items.map((i) => i.ip)).toEqual(['255.255.255.253', '255.255.255.254', '255.255.255.255']);
    expect(page.items.map((i) => i.eligible)).toEqual([true, true, false]);
    expect(ctx.read((db) => (db.prepare('SELECT COUNT(*) AS n FROM address_slots').get() as { n: number }).n)).toBe(0);
    expect(z.networkId).toBeTruthy();
  });
});

describe('AC-11 address policy and receiver eligibility', () => {
  function policyNet() {
    return ctx.exec('network.create', {
      name: '정책망',
      cidr: '192.168.10.0/24',
      gateway: '192.168.10.1',
      dns: ['8.8.8.8'],
      ranges: [S('192.168.10.1', '192.168.10.99'), S('192.168.10.100', '192.168.10.199', 'dhcp'), S('192.168.10.50', '192.168.10.59', 'exclusion')],
    });
  }

  it('rejects gateway, DHCP, exclusion and out-of-range addresses', () => {
    const n = policyNet();
    const p = pc(ctx);
    for (const ip of ['192.168.10.1', '192.168.10.150', '192.168.10.55', '192.168.10.0', '192.168.10.255', '192.168.10.230', '192.168.11.5']) {
      expect(codeOf(() => reserve(ctx, n.networkId, ip, p.interfaceId))).toMatch(/^RULE_VIOLATION:address_not_eligible/);
    }
    expect(ctx.read((db) => addressEligibility(db, n.networkId, parseIp('192.168.10.150'))).reasons).toContain('dhcp');
    reserve(ctx, n.networkId, '192.168.10.20', p.interfaceId);
  });

  it('rejects static/DHCP overlap and setting changes that would exclude an occupied address', () => {
    expect(
      codeOf(() =>
        ctx.exec('network.create', { name: '겹침', cidr: '192.168.20.0/24', gateway: null, dns: [], ranges: [S('192.168.20.1', '192.168.20.100'), S('192.168.20.90', '192.168.20.120', 'dhcp')] }),
      ),
    ).toBe('RULE_VIOLATION:range_overlap');
    const n = policyNet();
    const p = pc(ctx);
    reserve(ctx, n.networkId, '192.168.10.20', p.interfaceId);
    const sub = ctx.read((db) => listNetworks(db))[0]!.subnets[0]!;
    const shrink = [S('192.168.10.30', '192.168.10.99'), S('192.168.10.100', '192.168.10.199', 'dhcp')];
    expect(codeOf(() => ctx.exec('subnet.update', { subnetId: sub.id, expectedVersion: sub.version, gateway: '192.168.10.1', dns: [], ranges: shrink }))).toBe(
      'RULE_VIOLATION:occupied_address_excluded',
    );
    expect(codeOf(() => ctx.exec('subnet.update', { subnetId: sub.id, expectedVersion: sub.version, gateway: '192.168.10.20', dns: [], ranges: [S('192.168.10.1', '192.168.10.99')] }))).toBe(
      'RULE_VIOLATION:occupied_address_excluded',
    );
    expect(codeOf(() => ctx.exec('address.exclude', { networkId: n.networkId, ip: '192.168.10.20', expectedSlotVersion: 1, reason: '프린터 예비' }))).toBe('RULE_VIOLATION:address_occupied');
  });

  it('refuses new reservations to ineligible assets but still allows releasing their existing address', () => {
    const n = policyNet();
    const p = pc(ctx);
    reserve(ctx, n.networkId, '192.168.10.20', p.interfaceId);
    ctx.exec('repair.open', { assetId: p.assetId, expectedVersion: ctx.read((db) => getAssetDetail(db, p.assetId))!.asset.version, symptom: '부팅 불가', vendor: null, receivedOn: '2026-03-02' });
    expect(codeOf(() => reserve(ctx, n.networkId, '192.168.10.21', p.interfaceId))).toBe('RULE_VIOLATION:receiver_not_eligible');
    const s = slot(ctx, n.networkId, '192.168.10.20');
    const req = ctx.exec('address.requestRelease', { slotId: s.id, expectedVersion: s.version, reason: '수리 반출' });
    ctx.exec('address.recordEvidence', { requestId: req.requestId, expectedRequestVersion: 1, evidenceKind: 'never_configured', note: '예약만 함', checkedAt: '2026-03-02T01:00:00Z' });
    ctx.exec('address.finalizeRelease', { requestId: req.requestId, expectedRequestVersion: 2, finalConfirm: true });
    expect(slot(ctx, n.networkId, '192.168.10.20').state).toBe('unassigned');
  });
});

describe('AC-12 one winner for the same address', () => {
  it('lets only the first reservation win, replays its retry, and the DB constraint forbids duplicates', () => {
    const n = net(ctx, '경합망', '10.9.0.0/24');
    const a = pc(ctx);
    const b = pc(ctx);
    const first = reserve(ctx, n.networkId, '10.9.0.5', a.interfaceId, { commandId: '11111111-1111-4111-8111-111111111111' });
    expect(codeOf(() => reserve(ctx, n.networkId, '10.9.0.5', b.interfaceId))).toBe('RULE_VIOLATION:address_occupied');
    expect(reserve(ctx, n.networkId, '10.9.0.5', a.interfaceId, { commandId: '11111111-1111-4111-8111-111111111111' })).toEqual(first);
    expect(() =>
      ctx.root.store.db
        .prepare("INSERT INTO address_slots VALUES ('x', ?, ?, 'reserved', NULL, ?, NULL, 1)")
        .run(n.networkId, parseIp('10.9.0.5'), b.interfaceId),
    ).toThrow(/UNIQUE/);
    expect(slot(ctx, n.networkId, '10.9.0.5').interfaceId).toBe(a.interfaceId);
  });
});

describe('AC-13/AC-14 two-step release', () => {
  it('pending_release stays occupied across restart, cancel restores state and binding', () => {
    const n = net(ctx, '해제망', '10.8.0.0/24');
    const a = pc(ctx);
    const b = pc(ctx);
    reserve(ctx, n.networkId, '10.8.0.5', a.interfaceId);
    let s = slot(ctx, n.networkId, '10.8.0.5');
    ctx.exec('address.activate', { slotId: s.id, expectedVersion: s.version });
    s = slot(ctx, n.networkId, '10.8.0.5');
    const req = ctx.exec('address.requestRelease', { slotId: s.id, expectedVersion: s.version, reason: '교체 예정' });
    ctx.reopen();
    s = slot(ctx, n.networkId, '10.8.0.5');
    expect(s).toMatchObject({ state: 'pending_release', priorState: 'active', interfaceId: a.interfaceId });
    expect(codeOf(() => reserve(ctx, n.networkId, '10.8.0.5', b.interfaceId))).toBe('RULE_VIOLATION:address_occupied');
    ctx.exec('address.cancelRelease', { requestId: req.requestId, expectedRequestVersion: 1, reason: '교체 취소' });
    expect(slot(ctx, n.networkId, '10.8.0.5')).toMatchObject({ state: 'active', priorState: null, interfaceId: a.interfaceId });
  });

  it('refuses non-evidence and finalisation without evidence or final confirmation', () => {
    const n = net(ctx, '해제망2', '10.7.0.0/24');
    const a = pc(ctx);
    reserve(ctx, n.networkId, '10.7.0.5', a.interfaceId);
    let s = slot(ctx, n.networkId, '10.7.0.5');
    ctx.exec('address.activate', { slotId: s.id, expectedVersion: s.version });
    s = slot(ctx, n.networkId, '10.7.0.5');
    const { requestId } = ctx.exec('address.requestRelease', { slotId: s.id, expectedVersion: s.version, reason: '퇴직' });
    expect(codeOf(() => ctx.exec('address.finalizeRelease', { requestId, expectedRequestVersion: 1, finalConfirm: true }))).toBe('RULE_VIOLATION:evidence_required');
    for (const evidenceKind of ['no_response', 'person_retired', 'powered_off', 'not_found']) {
      expect(codeOf(() => ctx.exec('address.recordEvidence', { requestId, expectedRequestVersion: 1, evidenceKind, note: null, checkedAt: '2026-03-02T01:00:00Z' }))).toBe(
        'RULE_VIOLATION:evidence_not_sufficient',
      );
    }
    expect(codeOf(() => ctx.exec('address.recordEvidence', { requestId, expectedRequestVersion: 1, evidenceKind: 'never_configured', note: null, checkedAt: '2026-03-02T01:00:00Z' }))).toBe(
      'RULE_VIOLATION:evidence_not_sufficient',
    );
    ctx.exec('address.recordEvidence', { requestId, expectedRequestVersion: 1, evidenceKind: 'device_reconfigured', note: '구형 PC IP 제거 확인', checkedAt: '2026-03-02T01:00:00Z' });
    expect(codeOf(() => ctx.exec('address.finalizeRelease', { requestId, expectedRequestVersion: 2, finalConfirm: false }))).toBe('VALIDATION');
    expect(slot(ctx, n.networkId, '10.7.0.5').state).toBe('pending_release');
    ctx.exec('address.finalizeRelease', { requestId, expectedRequestVersion: 2, finalConfirm: true });
    expect(slot(ctx, n.networkId, '10.7.0.5')).toMatchObject({ state: 'unassigned', interfaceId: null });
  });
});

describe('AC-15 PC replacement transfer', () => {
  function setup() {
    const n = net(ctx, '이전망', '10.6.0.0/24');
    const oldPc = pc(ctx);
    const newPc = pc(ctx);
    reserve(ctx, n.networkId, '10.6.0.5', oldPc.interfaceId);
    let s = slot(ctx, n.networkId, '10.6.0.5');
    ctx.exec('address.activate', { slotId: s.id, expectedVersion: s.version });
    s = slot(ctx, n.networkId, '10.6.0.5');
    return { n, oldPc, newPc, s };
  }

  const ifVersion = (id: string) => ctx.read((db) => db.prepare('SELECT version FROM interfaces WHERE id = ?').get(id) as { version: number }).version;

  it('refuses a transfer without evidence and keeps the old binding', () => {
    const { n, oldPc, newPc, s } = setup();
    const { requestId } = ctx.exec('address.requestTransfer', { slotId: s.id, expectedVersion: s.version, toInterfaceId: newPc.interfaceId, reason: 'PC 교체' });
    expect(slot(ctx, n.networkId, '10.6.0.5')).toMatchObject({ state: 'active', interfaceId: oldPc.interfaceId });
    const after = slot(ctx, n.networkId, '10.6.0.5');
    expect(
      codeOf(() =>
        ctx.exec('address.finalizeTransfer', {
          requestId, expectedRequestVersion: 1, expectedSlotVersion: after.version, expectedFromInterfaceVersion: ifVersion(oldPc.interfaceId),
          expectedToInterfaceVersion: ifVersion(newPc.interfaceId), finalConfirm: true,
        }),
      ),
    ).toBe('RULE_VIOLATION:evidence_required');
    expect(slot(ctx, n.networkId, '10.6.0.5').interfaceId).toBe(oldPc.interfaceId);
  });

  it('moves slot, both interface relations and history atomically', () => {
    const { n, oldPc, newPc, s } = setup();
    const { requestId } = ctx.exec('address.requestTransfer', { slotId: s.id, expectedVersion: s.version, toInterfaceId: newPc.interfaceId, reason: 'PC 교체' });
    ctx.exec('address.recordEvidence', { requestId, expectedRequestVersion: 1, evidenceKind: 'device_disconnected', note: '구형 PC 랜선 분리', checkedAt: '2026-03-02T02:00:00Z' });
    const cur = slot(ctx, n.networkId, '10.6.0.5');
    ctx.exec('address.finalizeTransfer', {
      requestId, expectedRequestVersion: 2, expectedSlotVersion: cur.version, expectedFromInterfaceVersion: ifVersion(oldPc.interfaceId),
      expectedToInterfaceVersion: ifVersion(newPc.interfaceId), finalConfirm: true,
    });
    expect(slot(ctx, n.networkId, '10.6.0.5')).toMatchObject({ state: 'active', interfaceId: newPc.interfaceId });
    const bindings = ctx.read((db) => db.prepare('SELECT interface_id AS i, ended_at AS e FROM slot_bindings WHERE slot_id = ? ORDER BY started_at, rowid').all(s.id)) as { i: string; e: string | null }[];
    expect(bindings.map((b) => [b.i, b.e === null])).toEqual([[oldPc.interfaceId, false], [newPc.interfaceId, true]]);
    expect(ctx.read((db) => getAssetDetail(db, oldPc.assetId))!.interfaces[0]!.slots).toEqual([]);
  });

  it('a failure while finalising keeps the old binding (receiver became ineligible)', () => {
    const { n, oldPc, newPc, s } = setup();
    const { requestId } = ctx.exec('address.requestTransfer', { slotId: s.id, expectedVersion: s.version, toInterfaceId: newPc.interfaceId, reason: 'PC 교체' });
    ctx.exec('address.recordEvidence', { requestId, expectedRequestVersion: 1, evidenceKind: 'device_disconnected', note: null, checkedAt: '2026-03-02T02:00:00Z' });
    const v = ifVersion(newPc.interfaceId);
    ctx.exec('interface.setStatus', { id: newPc.interfaceId, expectedVersion: v, status: 'disabled', reason: '포트 고장' });
    const cur = slot(ctx, n.networkId, '10.6.0.5');
    expect(
      codeOf(() =>
        ctx.exec('address.finalizeTransfer', {
          requestId, expectedRequestVersion: 2, expectedSlotVersion: cur.version, expectedFromInterfaceVersion: ifVersion(oldPc.interfaceId),
          expectedToInterfaceVersion: ifVersion(newPc.interfaceId), finalConfirm: true,
        }),
      ),
    ).toBe('RULE_VIOLATION:receiver_not_eligible');
    expect(slot(ctx, n.networkId, '10.6.0.5')).toMatchObject({ state: 'active', interfaceId: oldPc.interfaceId });
  });

  it('does not transfer directly from pending_release', () => {
    const { n, newPc, s } = setup();
    ctx.exec('address.requestRelease', { slotId: s.id, expectedVersion: s.version, reason: '해제' });
    const cur = slot(ctx, n.networkId, '10.6.0.5');
    expect(codeOf(() => ctx.exec('address.requestTransfer', { slotId: cur.id, expectedVersion: cur.version, toInterfaceId: newPc.interfaceId, reason: '이전' }))).toBe(
      'RULE_VIOLATION:slot_state',
    );
  });
});

describe('deactivation guards', () => {
  it('refuses to disable an interface or network that holds addresses', () => {
    const n = net(ctx, '가드망', '10.5.0.0/24');
    const a = pc(ctx);
    reserve(ctx, n.networkId, '10.5.0.5', a.interfaceId);
    const v = ctx.read((db) => db.prepare('SELECT version FROM interfaces WHERE id = ?').get(a.interfaceId) as { version: number }).version;
    expect(codeOf(() => ctx.exec('interface.setStatus', { id: a.interfaceId, expectedVersion: v, status: 'disabled', reason: '교체' }))).toBe('RULE_VIOLATION:interface_has_addresses');
    const nv = ctx.read((db) => listNetworks(db))[0]!.version;
    expect(codeOf(() => ctx.exec('network.setStatus', { id: n.networkId, expectedVersion: nv, status: 'inactive', reason: '폐지' }))).toBe('RULE_VIOLATION:network_has_addresses');
  });
});
