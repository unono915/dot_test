import ExcelJS from 'exceljs';
import { sha256Hex } from '../canonical.js';
import { fail } from '../errors.js';
import { inspectZip } from './zip-guard.js';

// Bounded, non-executing reader for .xlsx. Macros, external links, embedded objects and
// formulas are never evaluated; formula cells are surfaced so mapping can reject them.

export const IMPORT_LIMITS = {
  maxFileBytes: 25 * 1024 * 1024,
  maxUncompressed: 250 * 1024 * 1024,
  maxEntries: 10_000,
  maxSheets: 20,
  maxDataRows: 50_000,
  maxNonEmptyCells: 1_000_000,
  maxMappedColumnsPerSheet: 100,
} as const;

export type CellType = 'string' | 'number' | 'boolean' | 'date' | 'formula' | 'error' | 'empty';

export interface Cell {
  t: CellType;
  /** Text representation; for formulas the formula text (never evaluated). */
  v: string;
}

export interface ParsedSheet {
  name: string;
  headers: string[];
  rows: { rowNumber: number; cells: Cell[] }[];
}

export interface ParsedWorkbook {
  fileHash: string;
  byteLength: number;
  sheets: ParsedSheet[];
  /** Values of the hidden metadata sheet written by our own normalised export, if present. */
  meta: Record<string, string>;
}

export const META_SHEET = '_school_asset_meta';

const FORBIDDEN_PARTS = [/vbaProject\.bin$/i, /^xl\/externalLinks\//i, /^xl\/embeddings\//i, /^xl\/activeX\//i, /^xl\/macrosheets\//i, /^xl\/dialogsheets\//i];

function pad(n: number) {
  return String(n).padStart(2, '0');
}

function dateText(d: Date): string {
  const day = `${d.getUTCFullYear()}-${pad(d.getUTCMonth() + 1)}-${pad(d.getUTCDate())}`;
  if (d.getUTCHours() || d.getUTCMinutes() || d.getUTCSeconds()) return `${day}T${pad(d.getUTCHours())}:${pad(d.getUTCMinutes())}:${pad(d.getUTCSeconds())}Z`;
  return day;
}

function numberText(n: number): string {
  if (Number.isInteger(n) && Math.abs(n) < 1e21) return n.toFixed(0);
  return String(n);
}

export function toCell(value: ExcelJS.CellValue): Cell {
  if (value === null || value === undefined) return { t: 'empty', v: '' };
  if (typeof value === 'string') return value === '' ? { t: 'empty', v: '' } : { t: 'string', v: value };
  if (typeof value === 'number') return { t: 'number', v: numberText(value) };
  if (typeof value === 'boolean') return { t: 'boolean', v: value ? 'TRUE' : 'FALSE' };
  if (value instanceof Date) return { t: 'date', v: dateText(value) };
  if (typeof value === 'object') {
    if ('formula' in value || 'sharedFormula' in value) {
      const f = (value as { formula?: string; sharedFormula?: string }).formula ?? (value as { sharedFormula?: string }).sharedFormula ?? '';
      return { t: 'formula', v: `=${f}` };
    }
    if ('error' in value) return { t: 'error', v: String((value as { error: unknown }).error) };
    if ('richText' in value) return { t: 'string', v: (value as ExcelJS.CellRichTextValue).richText.map((r) => r.text).join('') };
    if ('text' in value) return { t: 'string', v: String((value as { text: unknown }).text) };
  }
  return { t: 'string', v: String(value) };
}

/** Validates the container, then extracts sheets as plain cell text with hard limits. */
export async function readXlsx(buffer: Buffer): Promise<ParsedWorkbook> {
  if (buffer.byteLength > IMPORT_LIMITS.maxFileBytes) fail('LIMIT_EXCEEDED', '파일 크기가 25MB를 넘습니다.', { reason: 'file_size', limit: IMPORT_LIMITS.maxFileBytes });
  const { entries, kept } = await inspectZip(buffer, { maxEntries: IMPORT_LIMITS.maxEntries, maxTotalUncompressed: IMPORT_LIMITS.maxUncompressed }, (n) =>
    n === '[Content_Types].xml' || n === 'xl/workbook.xml',
  );
  const names = entries.map((e) => e.name);
  const types = kept.get('[Content_Types].xml')?.toString('utf8') ?? '';
  if (!types || !kept.has('xl/workbook.xml')) fail('VALIDATION', '엑셀 통합 문서(.xlsx)가 아닙니다.', { reason: 'not_xlsx' });
  if (/macroEnabled|vnd\.ms-excel\.sheet\.binary|template\.main/i.test(types)) fail('VALIDATION', '매크로 포함 문서(.xlsm)나 바이너리/서식 파일은 지원하지 않습니다.', { reason: 'macro_or_binary' });
  if (!/spreadsheetml\.sheet\.main\+xml/.test(types)) fail('VALIDATION', '엑셀 통합 문서(.xlsx)가 아닙니다.', { reason: 'not_xlsx' });
  const forbidden = names.find((n) => FORBIDDEN_PARTS.some((re) => re.test(n)));
  if (forbidden) fail('VALIDATION', '매크로·외부 링크·포함 개체가 있는 문서는 가져올 수 없습니다. 값만 남긴 사본을 저장해 주세요.', { reason: 'active_content' });
  const sheetCount = (kept.get('xl/workbook.xml')!.toString('utf8').match(/<sheet\b/g) ?? []).length;
  if (sheetCount > IMPORT_LIMITS.maxSheets) fail('LIMIT_EXCEEDED', `시트는 ${IMPORT_LIMITS.maxSheets}개까지 가져올 수 있습니다.`, { reason: 'sheets', count: sheetCount });

  const wb = new ExcelJS.Workbook();
  try {
    await wb.xlsx.load(buffer as unknown as ArrayBuffer);
  } catch {
    fail('VALIDATION', '엑셀 파일을 읽을 수 없습니다(손상 또는 지원하지 않는 형식).', { reason: 'parse_failed' });
  }
  let dataRows = 0;
  let cells = 0;
  const sheets: ParsedSheet[] = [];
  const meta: Record<string, string> = {};
  for (const ws of wb.worksheets) {
    if (ws.name === META_SHEET) {
      ws.eachRow((row) => {
        const k = toCell(row.getCell(1).value).v;
        const v = toCell(row.getCell(2).value).v;
        if (k) meta[k] = v;
      });
      continue;
    }
    const headerRow = ws.getRow(1);
    const width = Math.max(headerRow.cellCount, ws.columnCount);
    const headers: string[] = [];
    for (let c = 1; c <= width; c++) headers.push(toCell(headerRow.getCell(c).value).v.trim());
    const rows: ParsedSheet['rows'] = [];
    ws.eachRow({ includeEmpty: false }, (row, rowNumber) => {
      if (rowNumber === 1) return;
      const rowCells: Cell[] = [];
      let nonEmpty = 0;
      for (let c = 1; c <= width; c++) {
        const cell = toCell(row.getCell(c).value);
        if (cell.t !== 'empty') nonEmpty++;
        rowCells.push(cell);
      }
      if (nonEmpty === 0) return;
      cells += nonEmpty;
      dataRows++;
      if (dataRows > IMPORT_LIMITS.maxDataRows) fail('LIMIT_EXCEEDED', `데이터 행은 ${IMPORT_LIMITS.maxDataRows.toLocaleString()}행까지 가져올 수 있습니다.`, { reason: 'rows' });
      if (cells > IMPORT_LIMITS.maxNonEmptyCells) fail('LIMIT_EXCEEDED', '값이 있는 셀이 1,000,000개를 넘습니다.', { reason: 'cells' });
      rows.push({ rowNumber, cells: rowCells });
    });
    sheets.push({ name: ws.name, headers, rows });
  }
  return { fileHash: sha256Hex(buffer), byteLength: buffer.byteLength, sheets, meta };
}
