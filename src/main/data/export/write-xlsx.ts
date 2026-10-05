import ExcelJS from 'exceljs';
import { randomBytes } from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import { fail } from '../errors.js';
import type { ReportData } from './reports.js';

// Writes report data as .xlsx. Every text is a plain string cell (never a formula); text that
// looks like a formula is additionally given the Text number format. The file is written to a
// partial name and only renamed to the requested name after a complete, successful write.

const FORMULA_LIKE = /^[=+\-@\t\r]/;

export function buildWorkbook(data: ReportData): ExcelJS.Workbook {
  const wb = new ExcelJS.Workbook();
  wb.creator = '학교 정보자산 관리';
  wb.created = new Date(data.generatedAt);
  const cover = wb.addWorksheet('출력 정보');
  const visible = data.sheets.filter((s) => !s.hidden);
  const info: [string, string | number][] = [
    ['문서', data.title],
    ['출력 시각(UTC)', data.generatedAt],
    ['기준', data.basis],
    ['기준 revision', data.revision],
    ['데이터셋 ID', data.datasetId],
    ['필터', JSON.stringify(data.filters)],
    ['제외한 항목', data.excludedFields.length ? data.excludedFields.join(', ') : '없음'],
    ...visible.map((s): [string, number] => [`행 수: ${s.name}`, s.rows.length]),
    ['안내', '이 파일에는 교직원 이름 등 개인정보가 들어 있을 수 있습니다. 외부 매체에 보관할 때 주의하고 필요 없으면 삭제해 주세요.'],
    ['안내', '관측 자료는 배정으로 출력하지 않습니다. "장부상 미배정"은 실제 망에서 안전하다는 뜻이 아닙니다.'],
  ];
  for (const [k, v] of info) setRow(cover.addRow([]), [k, v]);
  cover.getColumn(1).width = 22;
  cover.getColumn(2).width = 80;
  for (const s of data.sheets) {
    const ws = wb.addWorksheet(s.name, s.hidden ? { state: 'veryHidden' } : {});
    const header = ws.addRow([]);
    setRow(header, s.headers);
    header.font = { bold: true };
    for (const r of s.rows) setRow(ws.addRow([]), r);
    s.headers.forEach((h, i) => (ws.getColumn(i + 1).width = Math.min(Math.max(h.length * 2 + 2, 10), 40)));
    if (!s.hidden) ws.views = [{ state: 'frozen', ySplit: 1 }];
  }
  return wb;
}

function setRow(row: ExcelJS.Row, values: (string | number | null | undefined)[]): void {
  values.forEach((v, i) => {
    const cell = row.getCell(i + 1);
    if (v === null || v === undefined) return;
    if (typeof v === 'number') {
      cell.value = v;
      return;
    }
    cell.value = String(v);
    if (FORMULA_LIKE.test(String(v))) cell.numFmt = '@';
  });
}

/** Writes atomically: partial file, then rename. A failure or cancel leaves no final file. */
export async function writeReportFile(data: ReportData, finalPath: string, opts: { cancelled?: () => boolean; beforeRename?: () => void } = {}): Promise<{ path: string; bytes: number }> {
  if (path.extname(finalPath).toLowerCase() !== '.xlsx') fail('VALIDATION', '저장 파일은 .xlsx여야 합니다.');
  const partial = `${finalPath}.partial-${randomBytes(4).toString('hex')}`;
  try {
    const buffer = Buffer.from(await buildWorkbook(data).xlsx.writeBuffer());
    if (opts.cancelled?.()) fail('CANCELLED', '내보내기를 취소했습니다. 파일을 만들지 않았습니다.');
    await fs.writeFile(partial, buffer, { flag: 'wx' });
    const handle = await fs.open(partial, 'r+');
    await handle.sync();
    await handle.close();
    opts.beforeRename?.();
    if (opts.cancelled?.()) fail('CANCELLED', '내보내기를 취소했습니다. 파일을 만들지 않았습니다.');
    await fs.rename(partial, finalPath);
    return { path: finalPath, bytes: buffer.byteLength };
  } catch (error) {
    await fs.rm(partial, { force: true });
    throw error;
  }
}
