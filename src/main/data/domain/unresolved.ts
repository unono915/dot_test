import type { Db } from '../sqlite.js';
import { formatIp } from './ipv4.js';
import { disposalBlockers } from './workflows.js';

export type UnresolvedCategory =
  | 'inactive_person_holding'
  | 'open_loan'
  | 'overdue_loan'
  | 'network_check'
  | 'pending_release'
  | 'open_transfer'
  | 'unspecified_location'
  | 'retired_cleanup'
  | 'lost_holding_address'
  | 'inventory_not_found'
  | 'inventory_mismatch'
  | 'inventory_unchecked';

/** One unresolved item, always pointing at the record that causes it. */
export interface UnresolvedItem {
  category: UnresolvedCategory;
  assetId: string | null;
  personId: string | null;
  slotId: string | null;
  taskId: string | null;
  loanId: string | null;
  sessionId: string | null;
  label: string;
  detail: Record<string, unknown>;
}

const item = (category: UnresolvedCategory, label: string, refs: Partial<UnresolvedItem>, detail: Record<string, unknown> = {}): UnresolvedItem => ({
  category, label, detail,
  assetId: refs.assetId ?? null, personId: refs.personId ?? null, slotId: refs.slotId ?? null, taskId: refs.taskId ?? null,
  loanId: refs.loanId ?? null, sessionId: refs.sessionId ?? null,
});

const assetLabel = (r: { kind: string; officialNo: string | null; model: string | null; id: string }) =>
  `${r.officialNo ?? r.model ?? r.id.slice(0, 8)}`;

/** `today` is the local calendar date (YYYY-MM-DD) used for overdue checks. */
export function listUnresolved(db: Db, opts: { today: string }): UnresolvedItem[] {
  const out: UnresolvedItem[] = [];
  const A = 'a.id, a.kind, a.official_no AS officialNo, a.model';

  for (const r of db
    .prepare(
      `SELECT ${A}, p.id AS personId, p.display_name AS personName, 'assignment' AS via FROM assignments x
         JOIN people p ON p.id = x.person_id JOIN assets a ON a.id = x.asset_id WHERE x.ended_at IS NULL AND p.status = 'inactive'
       UNION ALL
       SELECT ${A}, p.id, p.display_name, 'loan' FROM loans x
         JOIN people p ON p.id = x.borrower_id JOIN assets a ON a.id = x.asset_id WHERE x.returned_at IS NULL AND p.status = 'inactive'`,
    )
    .all() as { id: string; kind: string; officialNo: string | null; model: string | null; personId: string; personName: string; via: string }[]) {
    out.push(item('inactive_person_holding', `${r.personName} — ${assetLabel(r)}`, { assetId: r.id, personId: r.personId }, { via: r.via }));
  }

  for (const r of db
    .prepare(
      `SELECT ${A}, x.id AS loanId, x.due_on AS dueOn, p.id AS personId, p.display_name AS personName FROM loans x
       JOIN assets a ON a.id = x.asset_id JOIN people p ON p.id = x.borrower_id WHERE x.returned_at IS NULL ORDER BY x.due_on`,
    )
    .all() as { id: string; kind: string; officialNo: string | null; model: string | null; loanId: string; dueOn: string; personId: string; personName: string }[]) {
    const overdue = r.dueOn < opts.today;
    out.push(item(overdue ? 'overdue_loan' : 'open_loan', `${r.personName} — ${assetLabel(r)} (반납 기한 ${r.dueOn})`, { assetId: r.id, personId: r.personId, loanId: r.loanId }, { dueOn: r.dueOn }));
  }

  for (const r of db
    .prepare(`SELECT ${A}, t.id AS taskId, t.detail_json AS detailJson FROM tasks t JOIN assets a ON a.id = t.asset_id WHERE t.status = 'open' ORDER BY t.created_at`)
    .all() as { id: string; kind: string; officialNo: string | null; model: string | null; taskId: string; detailJson: string }[]) {
    out.push(item('network_check', `망 확인 필요 — ${assetLabel(r)}`, { assetId: r.id, taskId: r.taskId }, JSON.parse(r.detailJson) as Record<string, unknown>));
  }

  for (const r of db
    .prepare(
      `SELECT s.id AS slotId, s.ip, n.name AS networkName, i.asset_id AS assetId, r.kind AS requestKind, s.state FROM address_slots s
       JOIN networks n ON n.id = s.network_id JOIN interfaces i ON i.id = s.interface_id
       LEFT JOIN release_requests r ON r.slot_id = s.id AND r.status IN ('requested','evidenced')
       WHERE s.state = 'pending_release' OR r.kind = 'transfer' ORDER BY s.ip`,
    )
    .all() as { slotId: string; ip: number; networkName: string; assetId: string; requestKind: string | null; state: string }[]) {
    const transfer = r.requestKind === 'transfer';
    out.push(
      item(transfer ? 'open_transfer' : 'pending_release', `${r.networkName} ${formatIp(r.ip)} ${transfer ? '이전 진행 중' : '해제 대기(점유 중)'}`, { assetId: r.assetId, slotId: r.slotId }),
    );
  }

  for (const r of db
    .prepare(`SELECT ${A} FROM assets a JOIN locations l ON l.id = a.location_id WHERE l.is_unspecified = 1 AND a.lifecycle <> 'disposed'`)
    .all() as { id: string; kind: string; officialNo: string | null; model: string | null }[]) {
    out.push(item('unspecified_location', `위치 미지정 — ${assetLabel(r)}`, { assetId: r.id }));
  }

  for (const r of db.prepare(`SELECT ${A} FROM assets a WHERE a.lifecycle = 'retired'`).all() as { id: string; kind: string; officialNo: string | null; model: string | null }[]) {
    out.push(item('retired_cleanup', `퇴역 정리 대기 — ${assetLabel(r)}`, { assetId: r.id }, { blockers: disposalBlockers(db, r.id) }));
  }

  for (const r of db
    .prepare(
      `SELECT DISTINCT ${A} FROM assets a JOIN interfaces i ON i.asset_id = a.id JOIN address_slots s ON s.interface_id = i.id
       WHERE a.loss_status = 'confirmed' AND s.state IN ('reserved','active','pending_release')`,
    )
    .all() as { id: string; kind: string; officialNo: string | null; model: string | null }[]) {
    out.push(item('lost_holding_address', `분실 자산의 IP 점유 — ${assetLabel(r)}`, { assetId: r.id }));
  }

  out.push(...inventoryUnresolved(db));
  return out;
}

/** Latest effective results of the most recent inventory session that still need follow-up. */
function inventoryUnresolved(db: Db): UnresolvedItem[] {
  const session = db.prepare('SELECT id, title FROM inventory_sessions ORDER BY started_at DESC, rowid DESC LIMIT 1').get() as { id: string; title: string } | undefined;
  if (!session) return [];
  const rows = db
    .prepare(
      `SELECT it.asset_id AS assetId, a.kind, a.official_no AS officialNo, a.model,
         (SELECT r.result FROM inventory_results r WHERE r.session_id = it.session_id AND r.asset_id = it.asset_id
            AND NOT EXISTS (SELECT 1 FROM inventory_results r2 WHERE r2.supersedes_id = r.id) ORDER BY r.recorded_at DESC, r.rowid DESC LIMIT 1) AS result,
         (SELECT COUNT(*) FROM inventory_links l WHERE l.session_id = it.session_id AND l.asset_id = it.asset_id) AS links
       FROM inventory_items it JOIN assets a ON a.id = it.asset_id WHERE it.session_id = ?`,
    )
    .all(session.id) as { assetId: string; kind: string; officialNo: string | null; model: string | null; result: string | null; links: number }[];
  const out: UnresolvedItem[] = [];
  for (const r of rows) {
    if (r.links > 0) continue;
    const label = `${session.title} — ${assetLabel({ ...r, id: r.assetId })}`;
    if (r.result === 'not_found') out.push(item('inventory_not_found', `실사 미발견: ${label}`, { assetId: r.assetId, sessionId: session.id }));
    else if (r.result === 'mismatched') out.push(item('inventory_mismatch', `실사 불일치: ${label}`, { assetId: r.assetId, sessionId: session.id }));
    else if (r.result === null) out.push(item('inventory_unchecked', `실사 미확인: ${label}`, { assetId: r.assetId, sessionId: session.id }));
  }
  return out;
}
