import type { Db } from '../sqlite.js';
import { blockSize, contains, formatIp, hostRange } from './ipv4.js';

export interface SubnetRow {
  id: string;
  networkId: string;
  base: number;
  prefix: number;
  last: number;
  gateway: number | null;
  dns: string[];
  version: number;
}

export interface RangeRow {
  id: string;
  subnetId: string;
  kind: 'static' | 'dhcp' | 'exclusion';
  first: number;
  last: number;
  note: string | null;
}

export interface SlotRow {
  id: string;
  networkId: string;
  ip: number;
  state: 'unassigned' | 'reserved' | 'active' | 'pending_release' | 'excluded';
  priorState: 'reserved' | 'active' | null;
  interfaceId: string | null;
  note: string | null;
  version: number;
}

const SUBNET_COLS = 'id, network_id AS networkId, base, prefix, last, gateway, dns_json AS dnsJson, version';
const SLOT_COLS = 'id, network_id AS networkId, ip, state, prior_state AS priorState, interface_id AS interfaceId, note, version';

const toSubnet = (r: Omit<SubnetRow, 'dns'> & { dnsJson: string }): SubnetRow => {
  const { dnsJson, ...rest } = r;
  return { ...rest, dns: JSON.parse(dnsJson) as string[] };
};

export function subnetById(db: Db, id: string): SubnetRow | null {
  const r = db.prepare(`SELECT ${SUBNET_COLS} FROM subnets WHERE id = ?`).get(id) as (Omit<SubnetRow, 'dns'> & { dnsJson: string }) | undefined;
  return r ? toSubnet(r) : null;
}

export function subnetForIp(db: Db, networkId: string, ip: number): SubnetRow | null {
  const r = db.prepare(`SELECT ${SUBNET_COLS} FROM subnets WHERE network_id = ? AND base <= ? AND last >= ?`).get(networkId, ip, ip) as
    | (Omit<SubnetRow, 'dns'> & { dnsJson: string })
    | undefined;
  return r ? toSubnet(r) : null;
}

export function rangesOf(db: Db, subnetId: string): RangeRow[] {
  return db.prepare('SELECT id, subnet_id AS subnetId, kind, first, last, note FROM address_ranges WHERE subnet_id = ? ORDER BY first').all(subnetId) as RangeRow[];
}

export function slotByIp(db: Db, networkId: string, ip: number): SlotRow | null {
  return (db.prepare(`SELECT ${SLOT_COLS} FROM address_slots WHERE network_id = ? AND ip = ?`).get(networkId, ip) as SlotRow | undefined) ?? null;
}

export function slotById(db: Db, id: string): SlotRow | null {
  return (db.prepare(`SELECT ${SLOT_COLS} FROM address_slots WHERE id = ?`).get(id) as SlotRow | undefined) ?? null;
}

export type IneligibleReason = 'outside_network' | 'not_host' | 'gateway' | 'dhcp' | 'exclusion' | 'not_static' | 'excluded' | 'network_inactive';

export interface SubnetPolicy {
  base: number;
  prefix: number;
  gateway: number | null;
  ranges: Pick<RangeRow, 'kind' | 'first' | 'last'>[];
}

/** Policy-only eligibility for user assignment of `ip` inside a subnet configuration. */
export function policyReasons(policy: SubnetPolicy, ip: number): IneligibleReason[] {
  const reasons: IneligibleReason[] = [];
  if (!contains(hostRange(policy), ip)) reasons.push('not_host');
  if (policy.gateway !== null && policy.gateway === ip) reasons.push('gateway');
  if (policy.ranges.some((r) => r.kind === 'dhcp' && contains(r, ip))) reasons.push('dhcp');
  if (policy.ranges.some((r) => r.kind === 'exclusion' && contains(r, ip))) reasons.push('exclusion');
  if (!policy.ranges.some((r) => r.kind === 'static' && contains(r, ip))) reasons.push('not_static');
  return reasons;
}

export function addressEligibility(db: Db, networkId: string, ip: number): { eligible: boolean; reasons: IneligibleReason[]; subnetId: string | null } {
  const network = db.prepare('SELECT status FROM networks WHERE id = ?').get(networkId) as { status: string } | undefined;
  const subnet = subnetForIp(db, networkId, ip);
  if (!subnet) return { eligible: false, reasons: ['outside_network'], subnetId: null };
  const reasons = policyReasons({ ...subnet, ranges: rangesOf(db, subnet.id) }, ip);
  if (network?.status !== 'active') reasons.push('network_inactive');
  if (slotByIp(db, networkId, ip)?.state === 'excluded') reasons.push('excluded');
  return { eligible: reasons.length === 0, reasons, subnetId: subnet.id };
}

export function listNetworks(db: Db) {
  const networks = db.prepare('SELECT id, name, status, version, created_at AS createdAt FROM networks ORDER BY name').all() as {
    id: string; name: string; status: string; version: number; createdAt: string;
  }[];
  const aliasStmt = db.prepare('SELECT alias FROM network_aliases WHERE network_id = ? ORDER BY alias');
  const subnetStmt = db.prepare(`SELECT ${SUBNET_COLS} FROM subnets WHERE network_id = ? ORDER BY base`);
  const countStmt = db.prepare('SELECT state, COUNT(*) AS n FROM address_slots WHERE network_id = ? GROUP BY state');
  return networks.map((n) => ({
    ...n,
    aliases: (aliasStmt.all(n.id) as { alias: string }[]).map((a) => a.alias),
    subnets: (subnetStmt.all(n.id) as (Omit<SubnetRow, 'dns'> & { dnsJson: string })[]).map(toSubnet).map((s) => ({
      ...s,
      cidr: `${formatIp(s.base)}/${s.prefix}`,
      gatewayText: s.gateway === null ? null : formatIp(s.gateway),
      ranges: rangesOf(db, s.id).map((r) => ({ ...r, firstText: formatIp(r.first), lastText: formatIp(r.last) })),
    })),
    slotCounts: Object.fromEntries((countStmt.all(n.id) as { state: string; n: number }[]).map((c) => [c.state, c.n])),
  }));
}

/**
 * One page of a subnet's addresses computed arithmetically; only existing slot rows are joined.
 * Works for any prefix including /0 without materialising the block.
 */
export function listSubnetAddresses(db: Db, subnetId: string, page: { offset: number; limit: number; onlyUsed?: boolean }) {
  const subnet = subnetById(db, subnetId);
  if (!subnet) return { total: 0, items: [] };
  const ranges = rangesOf(db, subnetId);
  const limit = Math.min(Math.max(page.limit, 1), 1000);
  const slotInfo = db.prepare(
    `SELECT s.id, s.ip, s.state, s.prior_state AS priorState, s.version, s.interface_id AS interfaceId, i.label AS interfaceLabel, i.asset_id AS assetId,
       a.official_no AS officialNo, a.model, a.kind
     FROM address_slots s LEFT JOIN interfaces i ON i.id = s.interface_id LEFT JOIN assets a ON a.id = i.asset_id
     WHERE s.network_id = @networkId AND s.ip BETWEEN @first AND @last ORDER BY s.ip`,
  );
  const policy = { ...subnet, ranges };
  type SlotInfo = { id: string; ip: number; state: string; priorState: string | null; version: number; interfaceId: string | null; interfaceLabel: string | null; assetId: string | null; officialNo: string | null; model: string | null; kind: string | null };
  const decorate = (ip: number, slot: SlotInfo | undefined) => {
    const reasons = policyReasons(policy, ip);
    if (slot?.state === 'excluded') reasons.push('excluded');
    return { ip: formatIp(ip), ipNumber: ip, state: slot?.state ?? 'unassigned', slot: slot ?? null, eligible: reasons.length === 0 && !slot?.interfaceId, reasons };
  };
  if (page.onlyUsed) {
    const all = slotInfo.all({ networkId: subnet.networkId, first: subnet.base, last: subnet.last }) as SlotInfo[];
    return { total: all.length, items: all.slice(page.offset, page.offset + limit).map((s) => decorate(s.ip, s)) };
  }
  const total = blockSize(subnet.prefix);
  const first = subnet.base + Math.max(page.offset, 0);
  const last = Math.min(first + limit - 1, subnet.last);
  if (first > subnet.last) return { total, items: [] };
  const slots = new Map((slotInfo.all({ networkId: subnet.networkId, first, last }) as SlotInfo[]).map((s) => [s.ip, s]));
  const items = [];
  for (let ip = first; ip <= last; ip++) items.push(decorate(ip, slots.get(ip)));
  return { total, items };
}

/** Suggests the next policy-eligible, unoccupied address of a subnet (ledger view only). */
export function nextFreeAddress(db: Db, subnetId: string): string | null {
  const subnet = subnetById(db, subnetId);
  if (!subnet) return null;
  const ranges = rangesOf(db, subnetId).filter((r) => r.kind === 'static');
  const policy = { ...subnet, ranges: rangesOf(db, subnetId) };
  const used = db.prepare("SELECT 1 FROM address_slots WHERE network_id = ? AND ip = ? AND state <> 'unassigned'");
  for (const r of ranges) {
    for (let ip = r.first, n = 0; ip <= r.last && n < 100_000; ip++, n++) {
      if (policyReasons(policy, ip).length === 0 && !used.get(subnet.networkId, ip)) return formatIp(ip);
    }
  }
  return null;
}
