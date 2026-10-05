import { fail } from '../errors.js';
import { isUuid } from '../ids.js';

// Minimal payload validation. Every validator receives an unknown value and either returns the
// normalised value or throws DomainError('VALIDATION') naming the field.

export type Validator<T> = (value: unknown, field: string) => T;

const invalid = (field: string, message: string): never => fail('VALIDATION', message, { field });

export function str(opts: { min?: number; max?: number; trim?: boolean } = {}): Validator<string> {
  const { min = 1, max = 200, trim = true } = opts;
  return (value, field) => {
    if (typeof value !== 'string') return invalid(field, '문자열을 입력해 주세요.');
    const v = trim ? value.trim() : value;
    if (v.length < min) return invalid(field, '필수 입력 항목입니다.');
    if (v.length > max) return invalid(field, `${max}자 이하로 입력해 주세요.`);
    if (/[\u0000-\u0008\u000b\u000c\u000e-\u001f]/.test(v)) return invalid(field, '사용할 수 없는 문자가 있습니다.');
    return v;
  };
}

/** Optional text: undefined, null or blank become null. */
export function optStr(opts: { max?: number } = {}): Validator<string | null> {
  const inner = str({ min: 1, max: opts.max ?? 200 });
  return (value, field) => {
    if (value === undefined || value === null) return null;
    if (typeof value === 'string' && value.trim() === '') return null;
    return inner(value, field);
  };
}

/** Text whose exact characters matter (official numbers, serials): never trimmed of inner content. */
export function optCode(opts: { max?: number } = {}): Validator<string | null> {
  return (value, field) => {
    if (value === undefined || value === null || value === '') return null;
    if (typeof value !== 'string') return invalid(field, '문자열로 입력해 주세요.');
    const v = value.trim();
    if (v === '') return null;
    if (v.length > (opts.max ?? 100)) return invalid(field, '너무 깁니다.');
    return v;
  };
}

export const uuid: Validator<string> = (value, field) => (isUuid(value) ? value : invalid(field, '식별자가 올바르지 않습니다.'));

export const optUuid: Validator<string | null> = (value, field) => (value === undefined || value === null ? null : uuid(value, field));

export function oneOf<T extends string>(values: readonly T[]): Validator<T> {
  return (value, field) => ((values as readonly unknown[]).includes(value) ? (value as T) : invalid(field, '허용되지 않는 값입니다.'));
}

export function int(opts: { min?: number; max?: number } = {}): Validator<number> {
  return (value, field) => {
    if (typeof value !== 'number' || !Number.isInteger(value)) return invalid(field, '정수를 입력해 주세요.');
    if (opts.min !== undefined && value < opts.min) return invalid(field, `${opts.min} 이상이어야 합니다.`);
    if (opts.max !== undefined && value > opts.max) return invalid(field, `${opts.max} 이하여야 합니다.`);
    return value;
  };
}

export const optInt = (opts: { min?: number; max?: number } = {}): Validator<number | null> => {
  const inner = int(opts);
  return (value, field) => (value === undefined || value === null ? null : inner(value, field));
};

/** Expected version for optimistic locking: a non-negative integer, or null for "must not exist". */
export const version: Validator<number> = int({ min: 0 });

export const bool: Validator<boolean> = (value, field) => (typeof value === 'boolean' ? value : invalid(field, '예/아니오 값이 필요합니다.'));

export const mustConfirm: Validator<true> = (value, field) =>
  value === true ? true : invalid(field, '최종 확인이 필요합니다.');

const DATE = /^(\d{4})-(\d{2})-(\d{2})$/;

/** Calendar date (YYYY-MM-DD) kept as a date, never shifted by time zones. */
export const date: Validator<string> = (value, field) => {
  if (typeof value !== 'string') return invalid(field, '날짜는 YYYY-MM-DD 형식으로 입력해 주세요.');
  const m = DATE.exec(value);
  if (!m) return invalid(field, '날짜는 YYYY-MM-DD 형식으로 입력해 주세요.');
  const d = new Date(Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3])));
  if (d.getUTCFullYear() !== Number(m[1]) || d.getUTCMonth() + 1 !== Number(m[2]) || d.getUTCDate() !== Number(m[3])) {
    return invalid(field, '존재하지 않는 날짜입니다.');
  }
  return value;
};

export const optDate: Validator<string | null> = (value, field) => (value === undefined || value === null || value === '' ? null : date(value, field));

/** UTC instant as ISO-8601 with Z. */
export const instant: Validator<string> = (value, field) => {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(:\d{2}(\.\d{1,3})?)?Z$/.test(value) || Number.isNaN(Date.parse(value))) {
    return invalid(field, '시각 형식이 올바르지 않습니다.');
  }
  return new Date(value).toISOString();
};

export const optInstant: Validator<string | null> = (value, field) => (value === undefined || value === null ? null : instant(value, field));

export function list<T>(item: Validator<T>, opts: { min?: number; max?: number } = {}): Validator<T[]> {
  const { min = 1, max = 10_000 } = opts;
  return (value, field) => {
    if (!Array.isArray(value)) return invalid(field, '목록이 필요합니다.');
    if (value.length < min) return invalid(field, '대상을 선택해 주세요.');
    if (value.length > max) return invalid(field, `한 번에 ${max}개까지 처리할 수 있습니다.`);
    return value.map((v, i) => item(v, `${field}[${i}]`));
  };
}

type Shape = Record<string, Validator<unknown>>;
type Parsed<S extends Shape> = { [K in keyof S]: ReturnType<S[K]> };

/** A plain object with exactly the declared keys (unknown keys are rejected). */
export function shape<S extends Shape>(spec: S): Validator<Parsed<S>> {
  return (value, field) => {
    if (typeof value !== 'object' || value === null || Array.isArray(value)) return invalid(field, '요청 형식이 올바르지 않습니다.');
    for (const key of Object.keys(value)) {
      if (!(key in spec)) return invalid(field ? `${field}.${key}` : key, '알 수 없는 항목입니다.');
    }
    const out: Record<string, unknown> = {};
    for (const [key, validator] of Object.entries(spec)) {
      out[key] = validator((value as Record<string, unknown>)[key], field ? `${field}.${key}` : key);
    }
    return out as Parsed<S>;
  };
}

export const parser = <S extends Shape>(spec: S) => {
  const v = shape(spec);
  return (payload: unknown) => v(payload, '');
};
