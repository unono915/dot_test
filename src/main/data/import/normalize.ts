import { isUuid } from '../ids.js';
import { formatIp, normalizeMac, parseCidr, parseIp } from '../domain/ipv4.js';
import type { Cell } from './xlsx-read.js';
import { ACTION_WORDS, parseInterfaceWord, parseIpStateWord, parseKindWord, parseRoleWord, type FieldDef } from './targets.js';

export type DateFormat = 'iso' | 'dot' | 'compact';

export interface RowMessage {
  level: 'error' | 'warning' | 'info';
  code: string;
  field?: string;
  column?: number;
  message: string;
}

export type NormValue = string | string[] | null;

const DATE_PATTERNS: Record<DateFormat, RegExp> = {
  iso: /^(\d{4})-(\d{1,2})-(\d{1,2})$/,
  dot: /^(\d{4})\.\s?(\d{1,2})\.\s?(\d{1,2})\.?$/,
  compact: /^(\d{4})(\d{2})(\d{2})$/,
};

function validDate(y: number, m: number, d: number): string | null {
  const dt = new Date(Date.UTC(y, m - 1, d));
  if (dt.getUTCFullYear() !== y || dt.getUTCMonth() !== m - 1 || dt.getUTCDate() !== d) return null;
  return `${y}-${String(m).padStart(2, '0')}-${String(d).padStart(2, '0')}`;
}

const SEOUL_OFFSET_MS = 9 * 3600 * 1000;

/**
 * Converts one mapped cell to a normalised value. Formulas are never evaluated; ambiguous
 * dates are not guessed; leading zeros in text cells are preserved.
 */
export function normalizeCell(field: FieldDef, cell: Cell | undefined, column: number, dateFormat: DateFormat, messages: RowMessage[]): NormValue {
  if (!cell || cell.t === 'empty') return null;
  const err = (code: string, message: string) => {
    messages.push({ level: 'error', code, field: field.key, column, message });
    return null;
  };
  if (cell.t === 'formula') return err('formula', '수식 셀은 가져오지 않습니다. 값으로 바꾼 뒤 다시 시도해 주세요.');
  if (cell.t === 'error') return err('cell_error', '셀에 오류 값이 있습니다.');
  const text = cell.v.trim();
  if (text === '') return null;
  if (cell.t === 'string' && /^[=@]/.test(text)) {
    messages.push({ level: 'warning', code: 'formula_like_text', field: field.key, column, message: '수식처럼 보이는 문자열입니다. 문자 그대로 저장합니다.' });
  }
  if (text.length > 2000) return err('too_long', '값이 너무 깁니다.');
  try {
    switch (field.kind) {
      case 'text':
        return text;
      case 'code':
        if (cell.t === 'number') {
          messages.push({ level: 'warning', code: 'numeric_code', field: field.key, column, message: '숫자 셀입니다. 엑셀에서 이미 앞자리 0이 사라졌을 수 있으니 원본을 확인해 주세요.' });
        }
        return text;
      case 'date': {
        if (cell.t === 'date') return text.slice(0, 10);
        if (cell.t === 'number') return err('ambiguous_date', '날짜가 숫자로 저장되어 있습니다. 날짜 형식 셀이나 YYYY-MM-DD 문자열로 바꿔 주세요.');
        const m = DATE_PATTERNS[dateFormat].exec(text) ?? DATE_PATTERNS.iso.exec(text);
        if (!m) return err('ambiguous_date', `날짜 형식을 알 수 없습니다(${dateFormat === 'iso' ? 'YYYY-MM-DD' : dateFormat === 'dot' ? 'YYYY.MM.DD' : 'YYYYMMDD'}만 허용).`);
        return validDate(Number(m[1]), Number(m[2]), Number(m[3])) ?? err('invalid_date', '존재하지 않는 날짜입니다.');
      }
      case 'instant': {
        if (cell.t === 'date') {
          // Spreadsheet date-times carry no zone; they are read as local time (Asia/Seoul).
          const wall = Date.parse(text.length === 10 ? `${text}T00:00:00Z` : text);
          return new Date(wall - SEOUL_OFFSET_MS).toISOString();
        }
        const withZone = /^(\d{4}-\d{2}-\d{2})[T ](\d{2}:\d{2}(:\d{2})?)(Z|[+-]\d{2}:\d{2})$/.exec(text);
        if (withZone) return new Date(`${withZone[1]}T${withZone[2]}${withZone[3] ? '' : ':00'}${withZone[4]}`).toISOString();
        const local = /^(\d{4}-\d{2}-\d{2})[T ](\d{2}:\d{2})(:\d{2})?$/.exec(text);
        if (local) return new Date(Date.parse(`${local[1]}T${local[2]}${local[3] ?? ':00'}Z`) - SEOUL_OFFSET_MS).toISOString();
        return err('ambiguous_date', '시각은 YYYY-MM-DD HH:mm(한국 시간) 또는 ISO 형식으로 입력해 주세요.');
      }
      case 'ip':
        return formatIp(parseIp(text, field.key));
      case 'mac':
        return normalizeMac(text, field.key);
      case 'cidr': {
        const c = parseCidr(text, field.key);
        return `${formatIp(c.base)}/${c.prefix}`;
      }
      case 'kind':
        return parseKindWord(text) ?? err('invalid_kind', '종류는 노트북/데스크톱/모니터/기타 중 하나여야 합니다.');
      case 'role':
        return parseRoleWord(text) ?? err('invalid_role', '역할은 사용자/관리책임자 중 하나여야 합니다.');
      case 'ipState':
        return parseIpStateWord(text) ?? err('invalid_ip_state', 'IP 상태는 예약/사용 중 하나여야 합니다. 해제·이전은 별도 업무로 진행합니다.');
      case 'id':
        return isUuid(text.toLowerCase()) ? text.toLowerCase() : err('invalid_id', '내부 ID 형식이 아닙니다.');
      case 'path': {
        const parts = text.split('>').map((s) => s.trim()).filter(Boolean);
        if (parts.length === 0 || parts.length > 10 || parts.some((p) => p.length > 100)) return err('invalid_path', '장소 경로는 "본관 > 2층 > 교무실" 형식입니다.');
        return parts;
      }
      case 'ref':
        return text;
      case 'action':
        if (ACTION_WORDS.test(text)) {
          messages.push({
            level: 'warning', code: 'business_action', field: field.key, column,
            message: `"${text}" 요청은 가져오기로 처리하지 않습니다. 적용 후 해당 업무(반납·IP 해제·이전·퇴역·폐기·실사 종료) 화면에서 진행해 주세요.`,
          });
        }
        return text;
    }
  } catch (e) {
    const message = e instanceof Error ? e.message : '값이 올바르지 않습니다.';
    return err(field.kind === 'ip' ? 'invalid_ip' : field.kind === 'mac' ? 'invalid_mac' : field.kind === 'cidr' ? 'invalid_cidr' : 'invalid_value', message);
  }
  return null;
}

export const interfaceKindOf = (text: string | null) => (text ? parseInterfaceWord(text) : null);
