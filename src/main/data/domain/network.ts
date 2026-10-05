import { defineCommand, type TxContext } from '../commands.js';
import { fail } from '../errors.js';
import { newId } from '../ids.js';
import type { Db } from '../sqlite.js';
import { contains, formatIp, hostRange, overlaps, parseCidr, parseIp, type Cidr } from './ipv4.js';
import { addressEligibility, policyReasons, rangesOf, slotById, slotByIp, subnetById, type SlotRow } from './network-queries.js';
import { getAsset, getInterface, violate } from './repo.js';
import { instant, list, mustConfirm, oneOf, optStr, parser, shape, str, uuid, version, type Validator } from './validate.js';

// Real networks, subnets, address policy and the address slot state machine.
// "장부상 미배정" never means "safe on the LAN"; release and transfer need recorded evidence.

const ipText: Validator<number> = (value, field) => parseIp(value, field);
const optIpText: Validator<number | null> = (value, field) => (value === null || value === undefined || value === '' ? null : parseIp(value, field));
const cidrText: Validator<Cidr> = (value, field) => parseCidr(value, field);
const dnsList: Validator<string[]> = (value, field) => {
  if (value === undefined || value === null) return [];
  if (!Array.isArray(value) || value.length > 4) return fail('VALIDATION', 'DNS는 4개까지 입력할 수 있습니다.', { field });
  return value.map((v, i) => formatIp(parseIp(v, `${field}[${i}]`)));
};
const rangeSpec = shape({ kind: oneOf(['static', 'dhcp', 'exclusion'] as const), first: ipText, last: ipText, note: optStr({ max: 200 }) });
const ranges: Validator<{ kind: 'static' | 'dhcp' | 'exclusion'; first: number; last: number; note: string | null }[]> = (value, field) => {
  if (value === undefined || value === null) return [];
  return list(rangeSpec, { min: 0, max: 64 })(value, field);
};

interface SubnetConfig {
  cidr: Cidr;
  gateway: number | null;
  dns: string[];
  ranges: { kind: 'static' | 'dhcp' | 'exclusion'; first: number; last: number; note: string | null }[];
}

function validateSubnetConfig(cfg: SubnetConfig): void {
  const block = { first: cfg.cidr.base, last: cfg.cidr.last };
  if (cfg.gateway !== null && !contains(hostRange(cfg.cidr), cfg.gateway)) {
    violate('gateway_outside', '게이트웨이는 해당 망의 호스트 주소여야 합니다.');
  }
  cfg.ranges.forEach((r, i) => {
    if (r.first > r.last) fail('VALIDATION', '범위의 시작이 끝보다 큽니다.', { field: `ranges[${i}]` });
    if (!contains(block, r.first) || !contains(block, r.last)) violate('range_outside', '범위가 망 밖에 있습니다.', { index: i });
  });
  const allocating = cfg.ranges.filter((r) => r.kind !== 'exclusion');
  for (let i = 0; i < allocating.length; i++) {
    for (let j = i + 1; j < allocating.length; j++) {
      if (overlaps(allocating[i]!, allocating[j]!)) violate('range_overlap', '고정 배정 범위와 DHCP 범위는 겹칠 수 없습니다.');
    }
  }
}

function assertNoOverlap(db: Db, cidr: Cidr): void {
  const hit = db
    .prepare('SELECT s.base, s.prefix, n.name FROM subnets s JOIN networks n ON n.id = s.network_id WHERE s.base <= ? AND s.last >= ? LIMIT 1')
    .get(cidr.last, cidr.base) as { base: number; prefix: number; name: string } | undefined;
  if (hit) {
    violate('network_overlap', `기존 망 '${hit.name}'(${formatIp(hit.base)}/${hit.prefix})과 주소가 겹칩니다. 같은 실제망이면 별칭으로 연결해 주세요.`, {
      existing: `${formatIp(hit.base)}/${hit.prefix}`,
    });
  }
}

function insertSubnet(ctx: TxContext, networkId: string, cfg: SubnetConfig): string {
  validateSubnetConfig(cfg);
  assertNoOverlap(ctx.db, cfg.cidr);
  const id = newId();
  ctx.db
    .prepare('INSERT INTO subnets VALUES (?, ?, ?, ?, ?, ?, ?, 1, ?)')
    .run(id, networkId, cfg.cidr.base, cfg.cidr.prefix, cfg.cidr.last, cfg.gateway, JSON.stringify(cfg.dns), ctx.now);
  const ins = ctx.db.prepare('INSERT INTO address_ranges VALUES (?, ?, ?, ?, ?, ?)');
  for (const r of cfg.ranges) ins.run(newId(), id, r.kind, r.first, r.last, r.note);
  ctx.emit({ eventType: 'subnet.created', entityType: 'network', entityId: networkId, after: describeConfig(cfg) });
  return id;
}

const describeConfig = (cfg: SubnetConfig) => ({
  cidr: `${formatIp(cfg.cidr.base)}/${cfg.cidr.prefix}`,
  gateway: cfg.gateway === null ? null : formatIp(cfg.gateway),
  dns: cfg.dns,
  ranges: cfg.ranges.map((r) => ({ kind: r.kind, first: formatIp(r.first), last: formatIp(r.last), note: r.note })),
});

function getNetwork(db: Db, id: string) {
  return (
    (db.prepare('SELECT id, name, status, version FROM networks WHERE id = ?').get(id) as { id: string; name: string; status: string; version: number } | undefined) ??
    fail('NOT_FOUND', '망을 찾을 수 없습니다.', { entityType: 'network', entityId: id })
  );
}

export const networkCreate = defineCommand(
  'network.create',
  parser({ name: str({ max: 100 }), cidr: cidrText, gateway: optIpText, dns: dnsList, ranges }),
  (ctx, p) => {
    const networkId = newId();
    ctx.db.prepare("INSERT INTO networks VALUES (?, ?, 'active', 1, ?)").run(networkId, p.name, ctx.now);
    ctx.emit({ eventType: 'network.created', entityType: 'network', entityId: networkId, after: { name: p.name } });
    const subnetId = insertSubnet(ctx, networkId, p);
    return { networkId, subnetId };
  },
);

export const networkAddSubnet = defineCommand(
  'network.addSubnet',
  parser({ networkId: uuid, expectedVersion: version, cidr: cidrText, gateway: optIpText, dns: dnsList, ranges }),
  (ctx, p) => {
    const n = getNetwork(ctx.db, p.networkId);
    ctx.expectVersion('network', n.id, n.version, p.expectedVersion);
    const subnetId = insertSubnet(ctx, n.id, p);
    ctx.db.prepare('UPDATE networks SET version = version + 1 WHERE id = ?').run(n.id);
    return { subnetId };
  },
);

export const networkRename = defineCommand(
  'network.rename',
  parser({ networkId: uuid, expectedVersion: version, name: str({ max: 100 }) }),
  (ctx, p) => {
    const n = getNetwork(ctx.db, p.networkId);
    ctx.expectVersion('network', n.id, n.version, p.expectedVersion);
    ctx.db.prepare('UPDATE networks SET name = ?, version = version + 1 WHERE id = ?').run(p.name, n.id);
    ctx.emit({ eventType: 'network.renamed', entityType: 'network', entityId: n.id, before: { name: n.name }, after: { name: p.name } });
    return { networkId: n.id };
  },
);

/** An alias is another name for an existing real network id; it never creates a network. */
export const networkAddAlias = defineCommand('network.addAlias', parser({ networkId: uuid, alias: str({ max: 100 }) }), (ctx, p) => {
  getNetwork(ctx.db, p.networkId);
  const taken = ctx.db.prepare('SELECT network_id AS networkId FROM network_aliases WHERE alias = ?').get(p.alias);
  if (taken) violate('alias_taken', '이미 다른 망에 쓰인 별칭입니다.');
  const id = newId();
  ctx.db.prepare('INSERT INTO network_aliases VALUES (?, ?, ?)').run(id, p.networkId, p.alias);
  ctx.emit({ eventType: 'network.aliasAdded', entityType: 'network', entityId: p.networkId, after: { alias: p.alias } });
  return { aliasId: id };
});

export const subnetUpdate = defineCommand(
  'subnet.update',
  parser({ subnetId: uuid, expectedVersion: version, gateway: optIpText, dns: dnsList, ranges }),
  (ctx, p) => {
    const s = subnetById(ctx.db, p.subnetId) ?? fail('NOT_FOUND', '서브넷을 찾을 수 없습니다.');
    ctx.expectVersion('subnet', s.id, s.version, p.expectedVersion);
    const cfg: SubnetConfig = { cidr: { base: s.base, prefix: s.prefix, first: s.base, last: s.last }, gateway: p.gateway, dns: p.dns, ranges: p.ranges };
    validateSubnetConfig(cfg);
    const occupied = ctx.db
      .prepare("SELECT ip FROM address_slots WHERE network_id = ? AND ip BETWEEN ? AND ? AND state IN ('reserved','active','pending_release')")
      .all(s.networkId, s.base, s.last) as { ip: number }[];
    const blocked = occupied.filter((o) => policyReasons({ base: s.base, prefix: s.prefix, gateway: p.gateway, ranges: p.ranges }, o.ip).length > 0);
    if (blocked.length > 0) {
      violate('occupied_address_excluded', '점유 중인 주소가 새 설정에서 배정 불가가 됩니다. 해당 주소를 먼저 해제하거나 이전해 주세요.', {
        addresses: blocked.slice(0, 20).map((b) => formatIp(b.ip)),
        count: blocked.length,
      });
    }
    const before = { cidr: { base: s.base, prefix: s.prefix, first: s.base, last: s.last }, gateway: s.gateway, dns: s.dns, ranges: rangesOf(ctx.db, s.id) };
    ctx.db.prepare('DELETE FROM address_ranges WHERE subnet_id = ?').run(s.id);
    const ins = ctx.db.prepare('INSERT INTO address_ranges VALUES (?, ?, ?, ?, ?, ?)');
    for (const r of p.ranges) ins.run(newId(), s.id, r.kind, r.first, r.last, r.note);
    ctx.db.prepare('UPDATE subnets SET gateway = ?, dns_json = ?, version = version + 1 WHERE id = ?').run(p.gateway, JSON.stringify(p.dns), s.id);
    ctx.emit({ eventType: 'subnet.updated', entityType: 'network', entityId: s.networkId, before: describeConfig(before), after: describeConfig(cfg) });
    return { subnetId: s.id, version: s.version + 1 };
  },
);

export const networkSetStatus = defineCommand(
  'network.setStatus',
  parser({ id: uuid, expectedVersion: version, status: oneOf(['active', 'inactive'] as const), reason: str({ max: 500 }) }),
  (ctx, p) => {
    const n = getNetwork(ctx.db, p.id);
    ctx.expectVersion('network', n.id, n.version, p.expectedVersion);
    if (n.status === p.status) violate('no_change', '이미 같은 상태입니다.');
    if (p.status === 'inactive') {
      const held = (ctx.db.prepare("SELECT COUNT(*) AS n FROM address_slots WHERE network_id = ? AND state IN ('reserved','active','pending_release')").get(n.id) as { n: number }).n;
      if (held > 0) violate('network_has_addresses', '점유 중인 주소가 있는 망은 비활성화할 수 없습니다.', { count: held });
    }
    ctx.db.prepare('UPDATE networks SET status = ?, version = version + 1 WHERE id = ?').run(p.status, n.id);
    ctx.emit({ eventType: 'network.statusChanged', entityType: 'network', entityId: n.id, before: { status: n.status }, after: { status: p.status }, reason: p.reason });
    return { id: n.id };
  },
);

/** New reservation, activation and transfer receivers must be enabled interfaces of usable assets. */
function assertReceiver(db: Db, interfaceId: string) {
  const i = getInterface(db, interfaceId);
  const a = getAsset(db, i.assetId);
  const problems: string[] = [];
  if (i.status !== 'enabled') problems.push('interface_disabled');
  if (a.lifecycle !== 'ready') problems.push(`asset_${a.lifecycle}`);
  if (a.lossStatus === 'confirmed') problems.push('asset_lost');
  if (problems.length) violate('receiver_not_eligible', '이 장비는 지금 새 IP를 받을 수 없습니다(수리·퇴역·폐기·분실·비활성 인터페이스).', { problems });
  return { iface: i, asset: a };
}

function slotEvent(ctx: TxContext, slot: SlotRow, eventType: string, extra: { before?: unknown; after?: unknown; reason?: string | null } = {}) {
  const assetOf = (interfaceId: string | null) =>
    interfaceId ? ((ctx.db.prepare('SELECT asset_id AS a FROM interfaces WHERE id = ?').get(interfaceId) as { a: string } | undefined)?.a ?? null) : null;
  const current = slotById(ctx.db, slot.id)!;
  return ctx.emit({
    eventType,
    entityType: 'address',
    entityId: slot.id,
    before: extra.before ?? { state: slot.state, interfaceId: slot.interfaceId, assetId: assetOf(slot.interfaceId) },
    after: { networkId: current.networkId, ip: formatIp(current.ip), state: current.state, interfaceId: current.interfaceId, assetId: assetOf(current.interfaceId), ...(extra.after as object) },
    reason: extra.reason ?? null,
  });
}

function getSlot(db: Db, id: string): SlotRow {
  return slotById(db, id) ?? fail('NOT_FOUND', '주소를 찾을 수 없습니다.', { entityType: 'address', entityId: id });
}

export const addressReserve = defineCommand(
  'address.reserve',
  parser({ networkId: uuid, ip: ipText, interfaceId: uuid, reason: str({ max: 500 }), expectedSlotVersion: (v, f) => (v === null || v === undefined ? null : version(v, f)) }),
  (ctx, p) => {
    const net = getNetwork(ctx.db, p.networkId);
    const existing = slotByIp(ctx.db, net.id, p.ip);
    if (existing && existing.interfaceId) violate('address_occupied', '이미 점유된 주소입니다(예약·사용·해제 대기 포함).', { state: existing.state });
    const elig = addressEligibility(ctx.db, net.id, p.ip);
    if (!elig.eligible) violate(`address_not_eligible`, '이 주소는 배정할 수 없습니다.', { reasons: elig.reasons });
    ctx.expectVersion('address', `${net.id}:${formatIp(p.ip)}`, existing?.version ?? null, p.expectedSlotVersion);
    assertReceiver(ctx.db, p.interfaceId);
    let slotId: string;
    if (existing) {
      slotId = existing.id;
      ctx.db.prepare("UPDATE address_slots SET state = 'reserved', interface_id = ?, version = version + 1 WHERE id = ?").run(p.interfaceId, slotId);
    } else {
      slotId = newId();
      ctx.db.prepare("INSERT INTO address_slots VALUES (?, ?, ?, 'reserved', NULL, ?, NULL, 1)").run(slotId, net.id, p.ip, p.interfaceId);
    }
    const before = existing ?? { id: slotId, networkId: net.id, ip: p.ip, state: 'unassigned', priorState: null, interfaceId: null, note: null, version: 0 };
    const eventId = slotEvent(ctx, before as SlotRow, 'address.reserved', { reason: p.reason });
    ctx.db.prepare('INSERT INTO slot_bindings VALUES (?, ?, ?, ?, NULL, ?, NULL)').run(newId(), slotId, p.interfaceId, ctx.now, eventId);
    return { slotId };
  },
);

export const addressActivate = defineCommand('address.activate', parser({ slotId: uuid, expectedVersion: version }), (ctx, p) => {
  const s = getSlot(ctx.db, p.slotId);
  ctx.expectVersion('address', s.id, s.version, p.expectedVersion);
  if (s.state !== 'reserved') violate('slot_state', '예약 상태의 주소만 사용 개시할 수 있습니다.', { state: s.state });
  assertReceiver(ctx.db, s.interfaceId!);
  ctx.db.prepare("UPDATE address_slots SET state = 'active', version = version + 1 WHERE id = ?").run(s.id);
  slotEvent(ctx, s, 'address.activated');
  return { slotId: s.id };
});

function openRequest(db: Db, requestId: string) {
  const r = db
    .prepare(
      `SELECT id, slot_id AS slotId, kind, from_interface_id AS fromInterfaceId, to_interface_id AS toInterfaceId, status, version, evidence_kind AS evidenceKind
       FROM release_requests WHERE id = ?`,
    )
    .get(requestId) as { id: string; slotId: string; kind: 'release' | 'transfer'; fromInterfaceId: string; toInterfaceId: string | null; status: string; version: number; evidenceKind: string | null } | undefined;
  if (!r) return fail('NOT_FOUND', '해제/이전 요청을 찾을 수 없습니다.');
  if (r.status !== 'requested' && r.status !== 'evidenced') violate('request_closed', '이미 끝난 요청입니다.', { status: r.status });
  return r;
}

export const addressRequestRelease = defineCommand(
  'address.requestRelease',
  parser({ slotId: uuid, expectedVersion: version, reason: str({ max: 500 }) }),
  (ctx, p) => {
    const s = getSlot(ctx.db, p.slotId);
    ctx.expectVersion('address', s.id, s.version, p.expectedVersion);
    if (s.state !== 'reserved' && s.state !== 'active') violate('slot_state', '예약 또는 사용 중인 주소만 해제를 요청할 수 있습니다.', { state: s.state });
    if (ctx.db.prepare("SELECT 1 FROM release_requests WHERE slot_id = ? AND status IN ('requested','evidenced')").get(s.id)) {
      violate('request_open', '이미 진행 중인 해제/이전 요청이 있습니다.');
    }
    ctx.db.prepare("UPDATE address_slots SET state = 'pending_release', prior_state = ?, version = version + 1 WHERE id = ?").run(s.state, s.id);
    const requestId = newId();
    ctx.db
      .prepare("INSERT INTO release_requests (id, slot_id, kind, from_interface_id, to_interface_id, reason, status, requested_at, version) VALUES (?, ?, 'release', ?, NULL, ?, 'requested', ?, 1)")
      .run(requestId, s.id, s.interfaceId, p.reason, ctx.now);
    slotEvent(ctx, s, 'address.releaseRequested', { reason: p.reason, after: { requestId } });
    return { requestId };
  },
);

export const addressCancelRequest = defineCommand(
  'address.cancelRequest',
  parser({ requestId: uuid, expectedRequestVersion: version, reason: str({ max: 500 }) }),
  (ctx, p) => {
    const r = openRequest(ctx.db, p.requestId);
    ctx.expectVersion('request', r.id, r.version, p.expectedRequestVersion);
    const s = getSlot(ctx.db, r.slotId);
    if (r.kind === 'release') {
      ctx.db.prepare('UPDATE address_slots SET state = prior_state, prior_state = NULL, version = version + 1 WHERE id = ?').run(s.id);
    }
    ctx.db.prepare("UPDATE release_requests SET status = 'cancelled', closed_at = ?, version = version + 1 WHERE id = ?").run(ctx.now, r.id);
    slotEvent(ctx, s, r.kind === 'release' ? 'address.releaseCancelled' : 'address.transferCancelled', { reason: p.reason, after: { requestId: r.id } });
    return { requestId: r.id };
  },
);

// Kept for API clarity: cancelling a release restores the prior state and binding.
export const addressCancelRelease = defineCommand('address.cancelRelease', addressCancelRequest.parse, (ctx, p) => {
  const r = openRequest(ctx.db, p.requestId);
  if (r.kind !== 'release') violate('request_kind', '해제 요청이 아닙니다.');
  return addressCancelRequest.run(ctx, p);
});

/** Evidence that the old device no longer uses the address. Absence of a response is not evidence. */
export const EVIDENCE_KINDS = ['device_reconfigured', 'device_disconnected', 'device_wiped', 'never_configured'] as const;
const NOT_EVIDENCE = ['no_response', 'person_retired', 'powered_off', 'not_found'] as const;

export const addressRecordEvidence = defineCommand(
  'address.recordEvidence',
  parser({
    requestId: uuid,
    expectedRequestVersion: version,
    evidenceKind: (v, f) => {
      if ((NOT_EVIDENCE as readonly unknown[]).includes(v)) {
        return violate('evidence_not_sufficient', '응답 없음·퇴직·전원 꺼짐·실물 미발견은 해제 근거가 아닙니다. 기존 장비에서 IP를 제거했는지 직접 확인해 주세요.');
      }
      return oneOf(EVIDENCE_KINDS)(v, f);
    },
    note: optStr({ max: 1000 }),
    checkedAt: instant,
  }),
  (ctx, p) => {
    const r = openRequest(ctx.db, p.requestId);
    ctx.expectVersion('request', r.id, r.version, p.expectedRequestVersion);
    const s = getSlot(ctx.db, r.slotId);
    const wasOnlyReserved = r.kind === 'release' ? s.priorState === 'reserved' : s.state === 'reserved';
    if (p.evidenceKind === 'never_configured' && !wasOnlyReserved) {
      violate('evidence_not_sufficient', '사용 중이던 주소에는 "설정한 적 없음" 근거를 쓸 수 없습니다.');
    }
    ctx.db
      .prepare(
        "UPDATE release_requests SET status = 'evidenced', evidence_kind = ?, evidence_note = ?, evidence_checked_at = ?, evidence_actor = ?, version = version + 1 WHERE id = ?",
      )
      .run(p.evidenceKind, p.note, p.checkedAt, ctx.actor, r.id);
    slotEvent(ctx, s, 'address.evidenceRecorded', { after: { requestId: r.id, evidenceKind: p.evidenceKind, note: p.note, checkedAt: p.checkedAt } });
    return { requestId: r.id, version: r.version + 1 };
  },
);

function endBinding(ctx: TxContext, slotId: string, eventId: string) {
  ctx.db.prepare('UPDATE slot_bindings SET ended_at = ?, end_event_id = ? WHERE slot_id = ? AND ended_at IS NULL').run(ctx.now, eventId, slotId);
}

export const addressFinalizeRelease = defineCommand(
  'address.finalizeRelease',
  parser({ requestId: uuid, expectedRequestVersion: version, finalConfirm: mustConfirm }),
  (ctx, p) => {
    const r = openRequest(ctx.db, p.requestId);
    ctx.expectVersion('request', r.id, r.version, p.expectedRequestVersion);
    if (r.kind !== 'release') violate('request_kind', '해제 요청이 아닙니다.');
    if (r.status !== 'evidenced') violate('evidence_required', '해제 근거를 먼저 기록해 주세요.');
    const s = getSlot(ctx.db, r.slotId);
    ctx.db.prepare("UPDATE address_slots SET state = 'unassigned', prior_state = NULL, interface_id = NULL, version = version + 1 WHERE id = ?").run(s.id);
    ctx.db.prepare("UPDATE release_requests SET status = 'completed', closed_at = ?, version = version + 1 WHERE id = ?").run(ctx.now, r.id);
    const eventId = slotEvent(ctx, s, 'address.released', { after: { requestId: r.id, evidenceKind: r.evidenceKind } });
    endBinding(ctx, s.id, eventId);
    return { slotId: s.id };
  },
);

export const addressRequestTransfer = defineCommand(
  'address.requestTransfer',
  parser({ slotId: uuid, expectedVersion: version, toInterfaceId: uuid, reason: str({ max: 500 }) }),
  (ctx, p) => {
    const s = getSlot(ctx.db, p.slotId);
    ctx.expectVersion('address', s.id, s.version, p.expectedVersion);
    if (s.state !== 'reserved' && s.state !== 'active') violate('slot_state', '해제 대기 중인 주소는 바로 이전할 수 없습니다. 해제를 끝내거나 요청을 취소해 주세요.', { state: s.state });
    if (s.interfaceId === p.toInterfaceId) violate('same_interface', '같은 인터페이스로는 이전할 수 없습니다.');
    if (ctx.db.prepare("SELECT 1 FROM release_requests WHERE slot_id = ? AND status IN ('requested','evidenced')").get(s.id)) {
      violate('request_open', '이미 진행 중인 해제/이전 요청이 있습니다.');
    }
    assertReceiver(ctx.db, p.toInterfaceId);
    const requestId = newId();
    ctx.db
      .prepare("INSERT INTO release_requests (id, slot_id, kind, from_interface_id, to_interface_id, reason, status, requested_at, version) VALUES (?, ?, 'transfer', ?, ?, ?, 'requested', ?, 1)")
      .run(requestId, s.id, s.interfaceId, p.toInterfaceId, p.reason, ctx.now);
    const toAssetId = getInterface(ctx.db, p.toInterfaceId).assetId;
    slotEvent(ctx, s, 'address.transferRequested', { reason: p.reason, after: { requestId, toInterfaceId: p.toInterfaceId, toAssetId } });
    return { requestId };
  },
);

export const addressFinalizeTransfer = defineCommand(
  'address.finalizeTransfer',
  parser({
    requestId: uuid,
    expectedRequestVersion: version,
    expectedSlotVersion: version,
    expectedFromInterfaceVersion: version,
    expectedToInterfaceVersion: version,
    finalConfirm: mustConfirm,
  }),
  (ctx, p) => {
    const r = openRequest(ctx.db, p.requestId);
    ctx.expectVersion('request', r.id, r.version, p.expectedRequestVersion);
    if (r.kind !== 'transfer') violate('request_kind', '이전 요청이 아닙니다.');
    if (r.status !== 'evidenced') violate('evidence_required', '기존 장비의 연결 해제 근거를 먼저 기록해 주세요.');
    const s = getSlot(ctx.db, r.slotId);
    ctx.expectVersion('address', s.id, s.version, p.expectedSlotVersion);
    const from = getInterface(ctx.db, r.fromInterfaceId);
    ctx.expectVersion('interface', from.id, from.version, p.expectedFromInterfaceVersion);
    const to = getInterface(ctx.db, r.toInterfaceId!);
    ctx.expectVersion('interface', to.id, to.version, p.expectedToInterfaceVersion);
    if (s.interfaceId !== from.id || (s.state !== 'reserved' && s.state !== 'active')) violate('slot_state', '요청 이후 주소 상태가 바뀌었습니다.');
    assertReceiver(ctx.db, to.id);
    ctx.db.prepare('UPDATE address_slots SET interface_id = ?, version = version + 1 WHERE id = ?').run(to.id, s.id);
    ctx.db.prepare("UPDATE release_requests SET status = 'completed', closed_at = ?, version = version + 1 WHERE id = ?").run(ctx.now, r.id);
    ctx.db.prepare('UPDATE interfaces SET version = version + 1 WHERE id IN (?, ?)').run(from.id, to.id);
    const eventId = slotEvent(ctx, s, 'address.transferred', { after: { requestId: r.id, fromAssetId: from.assetId, toAssetId: to.assetId } });
    endBinding(ctx, s.id, eventId);
    ctx.db.prepare('INSERT INTO slot_bindings VALUES (?, ?, ?, ?, NULL, ?, NULL)').run(newId(), s.id, to.id, ctx.now, eventId);
    return { slotId: s.id };
  },
);

export const addressExclude = defineCommand(
  'address.exclude',
  parser({ networkId: uuid, ip: ipText, expectedSlotVersion: (v, f) => (v === null || v === undefined ? null : version(v, f)), reason: str({ max: 500 }) }),
  (ctx, p) => {
    const net = getNetwork(ctx.db, p.networkId);
    const existing = slotByIp(ctx.db, net.id, p.ip);
    if (existing?.interfaceId) violate('address_occupied', '점유 중인 주소는 제외할 수 없습니다.');
    if (existing?.state === 'excluded') violate('no_change', '이미 제외된 주소입니다.');
    ctx.expectVersion('address', `${net.id}:${formatIp(p.ip)}`, existing?.version ?? null, p.expectedSlotVersion);
    if (!ctx.db.prepare('SELECT 1 FROM subnets WHERE network_id = ? AND base <= ? AND last >= ?').get(net.id, p.ip, p.ip)) {
      violate('address_not_eligible', '망 밖의 주소입니다.', { reasons: ['outside_network'] });
    }
    let slotId = existing?.id;
    if (existing) ctx.db.prepare("UPDATE address_slots SET state = 'excluded', note = ?, version = version + 1 WHERE id = ?").run(p.reason, existing.id);
    else {
      slotId = newId();
      ctx.db.prepare("INSERT INTO address_slots VALUES (?, ?, ?, 'excluded', NULL, NULL, ?, 1)").run(slotId, net.id, p.ip, p.reason);
    }
    slotEvent(ctx, existing ?? ({ id: slotId!, networkId: net.id, ip: p.ip, state: 'unassigned', priorState: null, interfaceId: null, note: null, version: 0 } as SlotRow), 'address.excluded', { reason: p.reason });
    return { slotId: slotId! };
  },
);

export const addressUnexclude = defineCommand('address.unexclude', parser({ slotId: uuid, expectedVersion: version, reason: str({ max: 500 }) }), (ctx, p) => {
  const s = getSlot(ctx.db, p.slotId);
  ctx.expectVersion('address', s.id, s.version, p.expectedVersion);
  if (s.state !== 'excluded') violate('slot_state', '제외된 주소가 아닙니다.');
  ctx.db.prepare("UPDATE address_slots SET state = 'unassigned', note = NULL, version = version + 1 WHERE id = ?").run(s.id);
  slotEvent(ctx, s, 'address.unexcluded', { reason: p.reason });
  return { slotId: s.id };
});

export const networkCommands = [
  networkCreate, networkAddSubnet, networkRename, networkAddAlias, subnetUpdate, networkSetStatus,
  addressReserve, addressActivate, addressRequestRelease, addressCancelRequest, addressCancelRelease, addressRecordEvidence,
  addressFinalizeRelease, addressRequestTransfer, addressFinalizeTransfer, addressExclude, addressUnexclude,
];
