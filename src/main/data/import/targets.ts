// Import targets and their mappable fields. `aliases` are header spellings used only to
// suggest a mapping; the administrator always confirms the mapping before preview.

export type ImportTarget = 'people' | 'locations' | 'networks' | 'assets' | 'interfaces' | 'assignments' | 'observations';

export type FieldKind = 'text' | 'code' | 'date' | 'instant' | 'ip' | 'mac' | 'cidr' | 'kind' | 'role' | 'ipState' | 'id' | 'path' | 'ref' | 'action';

export interface FieldDef {
  key: string;
  label: string;
  kind: FieldKind;
  required?: boolean;
  aliases: string[];
}

const ROW_KEY: FieldDef = { key: 'rowKey', label: '행 안정키', kind: 'code', aliases: ['행키', '안정키', 'row key', 'key', '관리키'] };
const INTERNAL_ID: FieldDef = { key: 'internalId', label: '내부 ID', kind: 'id', aliases: ['내부id', '내부 id', 'internal id', 'id'] };

export const TARGETS: Record<ImportTarget, { label: string; fields: FieldDef[] }> = {
  people: {
    label: '사람',
    fields: [
      ROW_KEY, INTERNAL_ID,
      { key: 'displayName', label: '이름', kind: 'text', required: true, aliases: ['이름', '성명', '표시명', '교사명', '담당자'] },
      { key: 'department', label: '부서', kind: 'text', aliases: ['부서', '소속'] },
      { key: 'title', label: '직책', kind: 'text', aliases: ['직책', '직위'] },
    ],
  },
  locations: {
    label: '장소',
    fields: [
      ROW_KEY, INTERNAL_ID,
      { key: 'path', label: '장소 경로(상위 > 하위)', kind: 'path', required: true, aliases: ['장소', '위치', '장소경로', '교실'] },
    ],
  },
  networks: {
    label: '망',
    fields: [
      ROW_KEY, INTERNAL_ID,
      { key: 'name', label: '망 이름', kind: 'text', required: true, aliases: ['망', '망이름', '네트워크', 'vlan'] },
      { key: 'cidr', label: 'CIDR', kind: 'cidr', required: true, aliases: ['cidr', '대역', '서브넷'] },
      { key: 'gateway', label: '게이트웨이', kind: 'ip', aliases: ['게이트웨이', 'gateway', 'gw'] },
      { key: 'staticFirst', label: '고정 시작', kind: 'ip', aliases: ['고정시작', '고정 시작'] },
      { key: 'staticLast', label: '고정 끝', kind: 'ip', aliases: ['고정끝', '고정 끝'] },
      { key: 'dhcpFirst', label: 'DHCP 시작', kind: 'ip', aliases: ['dhcp시작', 'dhcp 시작'] },
      { key: 'dhcpLast', label: 'DHCP 끝', kind: 'ip', aliases: ['dhcp끝', 'dhcp 끝'] },
    ],
  },
  assets: {
    label: '자산',
    fields: [
      ROW_KEY, INTERNAL_ID,
      { key: 'kind', label: '종류', kind: 'kind', required: true, aliases: ['종류', '구분', '품목', '분류'] },
      { key: 'manufacturer', label: '제조사', kind: 'text', aliases: ['제조사', '제조'] },
      { key: 'model', label: '모델', kind: 'text', aliases: ['모델', '모델명', '품명'] },
      { key: 'serial', label: '제조번호', kind: 'code', aliases: ['제조번호', 'serial', 's/n', '시리얼'] },
      { key: 'officialNo', label: '물품번호', kind: 'code', aliases: ['물품번호', '자산번호', '관리번호', '공식번호'] },
      { key: 'ownership', label: '소유구분', kind: 'text', aliases: ['소유', '소유구분'] },
      { key: 'acquiredOn', label: '취득일', kind: 'date', aliases: ['취득일', '구입일', '도입일'] },
      { key: 'acquisitionSource', label: '취득 출처', kind: 'text', aliases: ['출처', '구입처', '취득출처'] },
      { key: 'warrantyUntil', label: '보증 만료', kind: 'date', aliases: ['보증', '보증만료', '보증 만료'] },
      { key: 'memo', label: '메모', kind: 'text', aliases: ['메모', '비고'] },
      { key: 'location', label: '장소 경로', kind: 'path', aliases: ['장소', '위치', '설치장소'] },
      { key: 'person', label: '담당자 이름', kind: 'ref', aliases: ['담당자', '사용자', '교사'] },
      { key: 'role', label: '담당 역할', kind: 'role', aliases: ['역할'] },
      { key: 'interfaceKind', label: '인터페이스 종류', kind: 'text', aliases: ['인터페이스종류', '연결방식'] },
      { key: 'interfaceLabel', label: '인터페이스 이름', kind: 'text', aliases: ['인터페이스', '랜카드'] },
      { key: 'mac', label: 'MAC', kind: 'mac', aliases: ['mac', '맥주소', 'mac주소'] },
      { key: 'network', label: '망 이름/별칭', kind: 'ref', aliases: ['망', '네트워크'] },
      { key: 'ip', label: 'IP', kind: 'ip', aliases: ['ip', 'ip주소', '아이피'] },
      { key: 'ipState', label: 'IP 상태', kind: 'ipState', aliases: ['ip상태', '상태(ip)'] },
      { key: 'requestedAction', label: '요청 사항', kind: 'action', aliases: ['요청', '처리', '조치', '요청사항'] },
    ],
  },
  interfaces: {
    label: '인터페이스·IP',
    fields: [
      ROW_KEY,
      { key: 'asset', label: '자산(행키/물품번호/내부ID)', kind: 'ref', required: true, aliases: ['자산', '물품번호', '자산번호'] },
      { key: 'interfaceKind', label: '인터페이스 종류', kind: 'text', aliases: ['종류', '연결방식'] },
      { key: 'interfaceLabel', label: '인터페이스 이름', kind: 'text', required: true, aliases: ['인터페이스', '이름'] },
      { key: 'mac', label: 'MAC', kind: 'mac', aliases: ['mac', '맥주소'] },
      { key: 'network', label: '망 이름/별칭', kind: 'ref', aliases: ['망', '네트워크'] },
      { key: 'ip', label: 'IP', kind: 'ip', aliases: ['ip', 'ip주소'] },
      { key: 'ipState', label: 'IP 상태', kind: 'ipState', aliases: ['ip상태'] },
    ],
  },
  assignments: {
    label: '배정',
    fields: [
      ROW_KEY,
      { key: 'asset', label: '자산(행키/물품번호/내부ID)', kind: 'ref', required: true, aliases: ['자산', '물품번호', '자산번호'] },
      { key: 'person', label: '담당자 이름', kind: 'ref', required: true, aliases: ['담당자', '사용자', '교사'] },
      { key: 'role', label: '역할', kind: 'role', aliases: ['역할'] },
    ],
  },
  observations: {
    label: '관측',
    fields: [
      { key: 'network', label: '망 이름/별칭', kind: 'ref', required: true, aliases: ['망', '네트워크'] },
      { key: 'ip', label: 'IP', kind: 'ip', required: true, aliases: ['ip', 'ip주소'] },
      { key: 'mac', label: 'MAC', kind: 'mac', aliases: ['mac', '맥주소'] },
      { key: 'asset', label: '자산(물품번호/내부ID)', kind: 'ref', aliases: ['자산', '물품번호'] },
      { key: 'observedAt', label: '관측 시각', kind: 'instant', required: true, aliases: ['관측시각', '시각', '확인시각'] },
    ],
  },
};

const KIND_WORDS: Record<string, 'laptop' | 'desktop' | 'monitor' | 'other'> = {
  laptop: 'laptop', 노트북: 'laptop', 랩탑: 'laptop',
  desktop: 'desktop', 데스크톱: 'desktop', 데스크탑: 'desktop', pc: 'desktop', 본체: 'desktop',
  monitor: 'monitor', 모니터: 'monitor',
  other: 'other', 기타: 'other',
};

export const parseKindWord = (text: string) => KIND_WORDS[text.trim().toLowerCase()] ?? null;

const ROLE_WORDS: Record<string, 'user' | 'custodian'> = { user: 'user', 사용자: 'user', 사용: 'user', custodian: 'custodian', 관리책임자: 'custodian', 관리자: 'custodian', 책임자: 'custodian' };
export const parseRoleWord = (text: string) => ROLE_WORDS[text.trim().toLowerCase()] ?? null;

const IP_STATE_WORDS: Record<string, 'reserved' | 'active'> = { reserved: 'reserved', 예약: 'reserved', active: 'active', 사용: 'active', 사용중: 'active', '사용 중': 'active' };
export const parseIpStateWord = (text: string) => IP_STATE_WORDS[text.trim().toLowerCase()] ?? null;

const IFACE_WORDS: Record<string, 'ethernet' | 'wifi' | 'other'> = { ethernet: 'ethernet', 유선: 'ethernet', lan: 'ethernet', wifi: 'wifi', 무선: 'wifi', 'wi-fi': 'wifi', other: 'other', 기타: 'other' };
export const parseInterfaceWord = (text: string) => IFACE_WORDS[text.trim().toLowerCase()] ?? null;

/** Business requests that must never be executed by an import (release, transfer, disposal…). */
export const ACTION_WORDS = /(해제|반납|폐기|불용|이전|퇴역|분실|실사\s*종료|release|dispose|retire)/i;

export function suggestMapping(target: ImportTarget, headers: string[]): Record<string, number> {
  const out: Record<string, number> = {};
  const norm = (s: string) => s.replace(/\s+/g, '').toLowerCase();
  const used = new Set<number>();
  for (const f of TARGETS[target].fields) {
    const idx = headers.findIndex((h, i) => !used.has(i) && f.aliases.some((a) => norm(a) === norm(h)));
    if (idx >= 0) {
      out[f.key] = idx;
      used.add(idx);
    }
  }
  return out;
}
