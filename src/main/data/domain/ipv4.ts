import { fail } from '../errors.js';

// IPv4 as unsigned 32-bit integers (stored in SQLite INTEGER). Ranges are computed, never
// enumerated, so even /0 is handled without materialising addresses.

export function parseIp(text: unknown, field = 'ip'): number {
  if (typeof text !== 'string') return fail('VALIDATION', 'IPv4 주소를 입력해 주세요.', { field });
  const parts = text.trim().split('.');
  if (parts.length !== 4) return fail('VALIDATION', 'IPv4 주소 형식이 올바르지 않습니다.', { field });
  let n = 0;
  for (const part of parts) {
    // Leading zeros are rejected: "010" is ambiguous (octal vs decimal) in many tools.
    if (!/^(0|[1-9]\d{0,2})$/.test(part) || Number(part) > 255) {
      return fail('VALIDATION', 'IPv4 주소 형식이 올바르지 않습니다.', { field });
    }
    n = n * 256 + Number(part);
  }
  return n;
}

export function formatIp(n: number): string {
  return [n >>> 24, (n >>> 16) & 255, (n >>> 8) & 255, n & 255].join('.');
}

export interface Cidr {
  base: number;
  prefix: number;
  /** first and last address of the block */
  first: number;
  last: number;
}

export function blockSize(prefix: number): number {
  return 2 ** (32 - prefix);
}

export function parseCidr(text: unknown, field = 'cidr'): Cidr {
  if (typeof text !== 'string' || !text.includes('/')) return fail('VALIDATION', 'CIDR은 10.0.0.0/24 형식으로 입력해 주세요.', { field });
  const [ipText, prefixText] = text.trim().split('/');
  if (!/^(\d|[12]\d|3[0-2])$/.test(prefixText ?? '')) return fail('VALIDATION', '접두 길이는 0~32입니다.', { field });
  const prefix = Number(prefixText);
  const ip = parseIp(ipText, field);
  const size = blockSize(prefix);
  if (ip % size !== 0) return fail('VALIDATION', `망 주소가 아닙니다. ${formatIp(ip - (ip % size))}/${prefix}을(를) 입력해 주세요.`, { field });
  return { base: ip, prefix, first: ip, last: ip + size - 1 };
}

export const formatCidr = (c: Pick<Cidr, 'base' | 'prefix'>) => `${formatIp(c.base)}/${c.prefix}`;

/** Product policy for host candidates: /≤30 excludes network & broadcast, /31 both, /32 single. */
export function hostRange(c: Pick<Cidr, 'base' | 'prefix'>): { first: number; last: number } {
  const last = c.base + blockSize(c.prefix) - 1;
  if (c.prefix >= 31) return { first: c.base, last };
  return { first: c.base + 1, last: last - 1 };
}

export const overlaps = (a: { first: number; last: number }, b: { first: number; last: number }) => a.first <= b.last && b.first <= a.last;

export const contains = (r: { first: number; last: number }, ip: number) => ip >= r.first && ip <= r.last;

export function normalizeMac(text: unknown, field = 'mac'): string | null {
  if (text === undefined || text === null || text === '') return null;
  if (typeof text !== 'string') return fail('VALIDATION', 'MAC 주소 형식이 올바르지 않습니다.', { field });
  const hex = text.trim().replace(/[:\-.\s]/g, '').toUpperCase();
  if (!/^[0-9A-F]{12}$/.test(hex)) return fail('VALIDATION', 'MAC 주소 형식이 올바르지 않습니다.', { field });
  return hex.match(/.{2}/g)!.join(':');
}
