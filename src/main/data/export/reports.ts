import type { Db } from '../sqlite.js';
import { formatIp } from '../domain/ipv4.js';
import { inventorySummary } from '../domain/inventory.js';
import { listNetworks } from '../domain/network-queries.js';
import { lastPhysicalCheck, listLocations } from '../domain/queries.js';
import { listUnresolved } from '../domain/unresolved.js';
import { APP_ID, SCHEMA_VERSION } from '../schema.js';

// Report data is collected inside ONE read transaction (DatasetStore.read) so every sheet of a
// file reflects the same revision; the workbook is written afterwards from these plain rows.

export type ReportKind = 'asset_ledger' | 'people_holdings' | 'location_status' | 'ip_ledger' | 'inventory' | 'unresolved' | 'handover' | 'normalized';

export interface ReportOptions {
  kind: ReportKind;
  includeDisposed?: boolean;
  includePersonNames?: boolean;
  inventorySessionId?: string | null;
  today: string;
}

export interface SheetData {
  name: string;
  headers: string[];
  rows: (string | number | null | undefined)[][];
  hidden?: boolean;
}

export interface ReportData {
  title: string;
  kind: ReportKind;
  datasetId: string;
  revision: number;
  generatedAt: string;
  basis: string;
  filters: Record<string, unknown>;
  excludedFields: string[];
  sheets: SheetData[];
}

const KIND_KO: Record<string, string> = { laptop: '노트북', desktop: '데스크톱', monitor: '모니터', other: '기타' };
const LIFECYCLE_KO: Record<string, string> = { ready: '사용 가능', in_repair: '수리 중', retired: '퇴역', disposed: '폐기' };
const SLOT_KO: Record<string, string> = { reserved: '예약', active: '사용 중', pending_release: '해제 대기', excluded: '제외', unassigned: '미배정' };
const RESULT_KO: Record<string, string> = { matched: '일치', mismatched: '불일치', not_found: '미발견', unchecked: '미확인' };
const ROLE_KO: Record<string, string> = { user: '사용자', custodian: '관리책임자' };

function personName(name: string | null, include: boolean): string | null {
  if (!name) return null;
  return include ? name : '(제외)';
}

function assetLedger(db: Db, o: ReportOptions): SheetData {
  const paths = new Map(listLocations(db).map((l) => [l.id, l.path]));
  const rows = db
    .prepare(
      `SELECT a.*, p.display_name AS personName, x.role, b.display_name AS borrowerName, l.due_on AS dueOn
       FROM assets a LEFT JOIN assignments x ON x.asset_id = a.id AND x.ended_at IS NULL LEFT JOIN people p ON p.id = x.person_id
       LEFT JOIN loans l ON l.asset_id = a.id AND l.returned_at IS NULL LEFT JOIN people b ON b.id = l.borrower_id
       ${o.includeDisposed ? '' : "WHERE a.lifecycle <> 'disposed'"} ORDER BY a.official_no IS NULL, a.official_no, a.created_at, a.id`,
    )
    .all() as Record<string, string | null>[];
  const ips = db.prepare(
    `SELECT n.name, s.ip, s.state FROM address_slots s JOIN interfaces i ON i.id = s.interface_id JOIN networks n ON n.id = s.network_id
     WHERE i.asset_id = ? AND s.state IN ('reserved','active','pending_release') ORDER BY s.ip`,
  );
  const include = o.includePersonNames !== false;
  return {
    name: '자산대장',
    headers: ['내부 ID', '물품번호', '제조번호', '종류', '제조사', '모델', '운영 상태', '분실', '장소', '담당자', '역할', '대여자', '반납 기한', 'IP', '최근 실물 확인', '취득일', '보증 만료', '메모'],
    rows: rows.map((a) => [
      a.id!, a.official_no, a.serial, KIND_KO[a.kind!] ?? a.kind!, a.manufacturer, a.model, LIFECYCLE_KO[a.lifecycle!]!, a.loss_status === 'confirmed' ? '분실 확정' : null,
      paths.get(a.location_id!) ?? null, personName(a.personName ?? null, include), a.role ? ROLE_KO[a.role]! : null, personName(a.borrowerName ?? null, include), a.dueOn ?? null,
      (ips.all(a.id) as { name: string; ip: number; state: string }[]).map((s) => `${s.name} ${formatIp(s.ip)}(${SLOT_KO[s.state]})`).join(', ') || null,
      lastPhysicalCheck(db, a.id!)?.checkedAt ?? null, a.acquired_on, a.warranty_until, a.memo,
    ]),
  };
}

function peopleHoldings(db: Db, o: ReportOptions): SheetData {
  const include = o.includePersonNames !== false;
  const rows = db
    .prepare(
      `SELECT p.display_name AS name, p.department, p.status, '배정' AS kind, a.id AS assetId, a.official_no AS officialNo, a.model, x.role, NULL AS dueOn
       FROM assignments x JOIN people p ON p.id = x.person_id JOIN assets a ON a.id = x.asset_id WHERE x.ended_at IS NULL
       UNION ALL
       SELECT p.display_name, p.department, p.status, '대여', a.id, a.official_no, a.model, NULL, l.due_on
       FROM loans l JOIN people p ON p.id = l.borrower_id JOIN assets a ON a.id = l.asset_id WHERE l.returned_at IS NULL
       ORDER BY 1, 4, 6`,
    )
    .all() as Record<string, string | null>[];
  return {
    name: '사람별 보유·대여',
    headers: ['사람', '부서', '사람 상태', '구분', '자산 내부 ID', '물품번호', '모델', '역할', '반납 기한', '기한 초과'],
    rows: rows.map((r) => [
      personName(r.name ?? null, include), include ? r.department : null, r.status === 'inactive' ? '비활성(퇴직 등)' : '활동', r.kind!, r.assetId!, r.officialNo, r.model,
      r.role ? ROLE_KO[r.role]! : null, r.dueOn, r.dueOn && r.dueOn < o.today ? '예' : null,
    ]),
  };
}

function locationStatus(db: Db): SheetData {
  const locs = listLocations(db);
  const counts = db
    .prepare("SELECT location_id AS id, kind, COUNT(*) AS n FROM assets WHERE lifecycle <> 'disposed' GROUP BY location_id, kind")
    .all() as { id: string; kind: string; n: number }[];
  const by = (id: string, kind: string) => counts.find((c) => c.id === id && c.kind === kind)?.n ?? 0;
  return {
    name: '위치별 현황',
    headers: ['장소', '상태', '노트북', '데스크톱', '모니터', '기타', '합계(미폐기)'],
    rows: locs.map((l) => [l.path, l.status === 'active' ? (l.isUnspecified ? '미지정(정리 필요)' : '사용') : '비활성', by(l.id, 'laptop'), by(l.id, 'desktop'), by(l.id, 'monitor'), by(l.id, 'other'), l.assetCount]),
  };
}

function ipLedger(db: Db, o: ReportOptions): SheetData {
  const include = o.includePersonNames !== false;
  const rows = db
    .prepare(
      `SELECT n.name AS network, s.ip, s.state, s.prior_state AS prior, a.id AS assetId, a.official_no AS officialNo, i.label, i.mac, p.display_name AS person,
         r.kind AS reqKind, r.status AS reqStatus, r.evidence_kind AS evidence, r.reason AS reqReason, s.note
       FROM address_slots s JOIN networks n ON n.id = s.network_id
       LEFT JOIN interfaces i ON i.id = s.interface_id LEFT JOIN assets a ON a.id = i.asset_id
       LEFT JOIN assignments x ON x.asset_id = a.id AND x.ended_at IS NULL LEFT JOIN people p ON p.id = x.person_id
       LEFT JOIN release_requests r ON r.slot_id = s.id AND r.status IN ('requested','evidenced')
       WHERE s.state <> 'unassigned' ORDER BY n.name, s.ip`,
    )
    .all() as Record<string, string | number | null>[];
  return {
    name: 'IP 배정·해제 대기',
    headers: ['망', 'IP', '배정 상태', '해제 전 상태', '자산 내부 ID', '물품번호', '인터페이스', 'MAC', '담당자', '진행 중 요청', '근거', '요청 사유/메모'],
    rows: rows.map((r) => [
      r.network as string, formatIp(r.ip as number), SLOT_KO[r.state as string]!, r.prior ? SLOT_KO[r.prior as string]! : null, r.assetId as string | null, r.officialNo as string | null,
      r.label as string | null, r.mac as string | null, personName((r.person as string | null) ?? null, include),
      r.reqKind ? `${r.reqKind === 'transfer' ? '이전' : '해제'}(${r.reqStatus === 'evidenced' ? '근거 기록됨' : '근거 대기'})` : null, r.evidence as string | null,
      (r.reqReason as string | null) ?? (r.note as string | null),
    ]),
  };
}

function inventorySheets(db: Db, sessionId: string): SheetData[] {
  const s = inventorySummary(db, sessionId);
  const paths = new Map(listLocations(db).map((l) => [l.id, l.path]));
  return [
    {
      name: '실사 요약',
      headers: ['항목', '값'],
      rows: [
        ['실사', s.session.title], ['상태', s.session.status === 'open' ? '진행 중' : '종료'], ['시작(기준 시점)', s.session.startedAt], ['기준 revision', s.session.baseRevision],
        ['종료', s.session.closedAt], ['기준 대상 수', s.counts.base], ['일치', s.counts.matched], ['불일치', s.counts.mismatched], ['미발견', s.counts.notFound], ['미확인', s.counts.unchecked],
        ['실물 확인 수(일치+불일치)', s.counts.physicallyChecked], ['기준 이후 신규 등록', s.addedSinceBase.length], ['기준 외 발견', s.extras.length],
      ],
    },
    {
      name: '실사 결과',
      headers: ['자산 내부 ID', '물품번호', '종류', '기준 장소', '결과(기준 대비)', '확인 장소', '현재 장소', '현재 대장 대비', '기준 이후 변경', '확인 시각'],
      rows: s.items.map((i) => {
        const it = i as unknown as Record<string, string | null>;
        return [
          i.assetId, it.officialNo ?? null, KIND_KO[it.kind ?? ''] ?? null, paths.get(i.baseLocationId) ?? null, RESULT_KO[i.result]!, i.foundLocationId ? (paths.get(i.foundLocationId) ?? null) : null,
          paths.get(i.currentLocationId) ?? null, i.vsCurrent ? RESULT_KO[i.vsCurrent]! : null, i.changedSinceBase ? '예' : null, i.checkedAt,
        ];
      }),
    },
  ];
}

function unresolvedSheet(db: Db, o: ReportOptions): SheetData {
  const CAT: Record<string, string> = {
    inactive_person_holding: '퇴직·비활성자 보유', open_loan: '대여 중', overdue_loan: '대여 기한 초과', network_check: '망 확인 필요', pending_release: 'IP 해제 대기',
    open_transfer: 'IP 이전 진행 중', unspecified_location: '위치 미지정', retired_cleanup: '퇴역 정리 대기', lost_holding_address: '분실 자산의 IP 점유',
    inventory_not_found: '실사 미발견', inventory_mismatch: '실사 불일치', inventory_unchecked: '실사 미확인',
  };
  const include = o.includePersonNames !== false;
  return {
    name: '미해결',
    headers: ['구분', '내용', '자산 내부 ID', '사람 ID', '주소 ID', '과제 ID', '실사 ID'],
    rows: listUnresolved(db, { today: o.today }).map((u) => [CAT[u.category] ?? u.category, include ? u.label : u.label.replace(/^[^—]+—/, '(제외) —'), u.assetId, u.personId, u.slotId, u.taskId, u.sessionId]),
  };
}

/** Re-importable normalised workbook: stable internal ids plus dataset id and schema version. */
function normalizedSheets(db: Db, datasetId: string): SheetData[] {
  const locs = listLocations(db);
  const paths = new Map(locs.map((l) => [l.id, l.path]));
  const people = db.prepare('SELECT id, display_name, department, title FROM people ORDER BY display_name, id').all() as Record<string, string | null>[];
  const assets = db
    .prepare(
      `SELECT a.*, p.display_name AS person, x.role FROM assets a LEFT JOIN assignments x ON x.asset_id = a.id AND x.ended_at IS NULL LEFT JOIN people p ON p.id = x.person_id
       ORDER BY a.created_at, a.id`,
    )
    .all() as Record<string, string | null>[];
  const ifaces = db
    .prepare(
      `SELECT i.asset_id, i.kind, i.label, i.mac, n.name AS network, s.ip, s.state FROM interfaces i
       LEFT JOIN address_slots s ON s.interface_id = i.id AND s.state IN ('reserved','active')
       LEFT JOIN networks n ON n.id = s.network_id ORDER BY i.asset_id, i.created_at, s.ip`,
    )
    .all() as Record<string, string | number | null>[];
  const nets = listNetworks(db);
  return [
    { name: '_school_asset_meta', headers: ['key', 'value'], rows: [['app_id', APP_ID], ['dataset_id', datasetId], ['schema_version', String(SCHEMA_VERSION)], ['document', 'normalized']], hidden: true },
    { name: '장소', headers: ['내부 ID', '장소 경로(상위 > 하위)'], rows: locs.filter((l) => !l.isUnspecified).map((l) => [l.id, l.path]) },
    { name: '사람', headers: ['내부 ID', '이름', '부서', '직책'], rows: people.map((p) => [p.id!, p.display_name, p.department, p.title]) },
    {
      name: '망',
      headers: ['내부 ID', '망 이름', 'CIDR', '게이트웨이', '고정 시작', '고정 끝', 'DHCP 시작', 'DHCP 끝'],
      rows: nets.flatMap((n) =>
        n.subnets.slice(0, 1).map((s) => {
          const st = s.ranges.find((r) => r.kind === 'static');
          const dh = s.ranges.find((r) => r.kind === 'dhcp');
          return [n.id, n.name, s.cidr, s.gatewayText, st?.firstText ?? null, st?.lastText ?? null, dh?.firstText ?? null, dh?.lastText ?? null];
        }),
      ),
    },
    {
      name: '자산',
      headers: ['내부 ID', '종류', '제조사', '모델', '제조번호', '물품번호', '소유구분', '취득일', '취득 출처', '보증 만료', '메모', '장소 경로', '담당자 이름', '담당 역할'],
      rows: assets.map((a) => [
        a.id!, KIND_KO[a.kind!]!, a.manufacturer, a.model, a.serial, a.official_no, a.ownership, a.acquired_on, a.acquisition_source, a.warranty_until, a.memo,
        a.location_id ? (paths.get(a.location_id) === '미지정' ? null : (paths.get(a.location_id) ?? null)) : null, a.person, a.role ? ROLE_KO[a.role]! : null,
      ]),
    },
    {
      name: '인터페이스',
      headers: ['자산(행키/물품번호/내부ID)', '인터페이스 종류', '인터페이스 이름', 'MAC', '망 이름/별칭', 'IP', 'IP 상태'],
      rows: ifaces.map((i) => [
        i.asset_id as string, i.kind === 'wifi' ? '무선' : i.kind === 'other' ? '기타' : '유선', i.label as string, i.mac as string | null, i.network as string | null,
        i.ip === null ? null : formatIp(i.ip as number), i.state ? SLOT_KO[i.state as string]! : null,
      ]),
    },
  ];
}

const TITLES: Record<ReportKind, string> = {
  asset_ledger: '자산대장', people_holdings: '사람별 보유·대여', location_status: '위치별 현황', ip_ledger: 'IP 배정·해제 대기', inventory: '실사 결과',
  unresolved: '미해결 목록', handover: '인계 묶음', normalized: '재가져오기용 정규화 문서',
};

export function collectReport(db: Db, ids: { datasetId: string; revision: number; now: string }, o: ReportOptions): ReportData {
  const latestInventory = () =>
    (db.prepare('SELECT id FROM inventory_sessions ORDER BY started_at DESC, rowid DESC LIMIT 1').get() as { id: string } | undefined)?.id ?? null;
  let sheets: SheetData[];
  let basis = '현재 대장';
  switch (o.kind) {
    case 'asset_ledger': sheets = [assetLedger(db, o)]; break;
    case 'people_holdings': sheets = [peopleHoldings(db, o)]; break;
    case 'location_status': sheets = [locationStatus(db)]; break;
    case 'ip_ledger': sheets = [ipLedger(db, o)]; basis = '현재 배정 대장(관측 자료는 포함하지 않음)'; break;
    case 'inventory': {
      const id = o.inventorySessionId ?? latestInventory();
      if (!id) throw new Error('no inventory');
      sheets = inventorySheets(db, id);
      basis = '실사 시작 시점 기준(현재 대장 비교 포함)';
      break;
    }
    case 'unresolved': sheets = [unresolvedSheet(db, o)]; break;
    case 'handover': {
      const inv = latestInventory();
      sheets = [assetLedger(db, o), peopleHoldings(db, o), locationStatus(db), ipLedger(db, o), unresolvedSheet(db, o), ...(inv ? inventorySheets(db, inv) : [])];
      break;
    }
    case 'normalized': sheets = normalizedSheets(db, ids.datasetId); basis = '현재 대장(재가져오기용)'; break;
  }
  const excludedFields = o.includePersonNames === false ? ['사람 이름', '부서'] : [];
  return {
    title: TITLES[o.kind], kind: o.kind, datasetId: ids.datasetId, revision: ids.revision, generatedAt: ids.now, basis,
    filters: { includeDisposed: !!o.includeDisposed, inventorySessionId: o.inventorySessionId ?? null }, excludedFields, sheets,
  };
}
