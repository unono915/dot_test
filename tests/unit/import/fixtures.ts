import ExcelJS from 'exceljs';
import yazl from 'yazl';

export type Row = (string | number | Date | null | { formula: string })[];

/** Builds an .xlsx buffer from plain sheets: first row of each sheet is the header. */
export async function workbook(sheets: Record<string, Row[]>, meta?: Record<string, string>): Promise<Buffer> {
  const wb = new ExcelJS.Workbook();
  for (const [name, rows] of Object.entries(sheets)) {
    const ws = wb.addWorksheet(name);
    for (const r of rows) ws.addRow(r.map((c) => (c && typeof c === 'object' && 'formula' in c ? { formula: c.formula, result: 0 } : c)));
  }
  if (meta) {
    const ws = wb.addWorksheet('_school_asset_meta', { state: 'veryHidden' });
    for (const [k, v] of Object.entries(meta)) ws.addRow([k, v]);
  }
  return Buffer.from(await wb.xlsx.writeBuffer());
}

/** A zip whose single entry inflates to `size` zero bytes (tiny when compressed). */
export function zipBomb(size: number): Promise<Buffer> {
  return new Promise((resolve) => {
    const zip = new yazl.ZipFile();
    zip.addBuffer(Buffer.from('<?xml version="1.0"?><Types><Override ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/></Types>'), '[Content_Types].xml');
    zip.addBuffer(Buffer.from('<workbook><sheets><sheet/></sheets></workbook>'), 'xl/workbook.xml');
    zip.addBuffer(Buffer.alloc(size), 'xl/worksheets/sheet1.xml');
    zip.end();
    const chunks: Buffer[] = [];
    zip.outputStream.on('data', (c: Buffer) => chunks.push(c));
    zip.outputStream.on('end', () => resolve(Buffer.concat(chunks)));
  });
}

/** Rewrites [Content_Types].xml of a real workbook to claim it is macro-enabled. */
export async function asMacroEnabled(xlsx: Buffer): Promise<Buffer> {
  const yauzl = await import('yauzl');
  const entries = await new Promise<{ name: string; data: Buffer }[]>((resolve, reject) => {
    yauzl.default.fromBuffer(xlsx, { lazyEntries: true }, (err, zip) => {
      if (err || !zip) return reject(err);
      const out: { name: string; data: Buffer }[] = [];
      zip.on('entry', (e: { fileName: string }) =>
        zip.openReadStream(e as never, (er, s) => {
          if (er || !s) return reject(er);
          const parts: Buffer[] = [];
          s.on('data', (c: Buffer) => parts.push(c));
          s.on('end', () => {
            out.push({ name: e.fileName, data: Buffer.concat(parts) });
            zip.readEntry();
          });
        }),
      );
      zip.on('end', () => resolve(out));
      zip.readEntry();
    });
  });
  return new Promise((resolve) => {
    const zip = new yazl.ZipFile();
    for (const e of entries) {
      if (e.name.endsWith('/')) continue;
      const data = e.name === '[Content_Types].xml' ? Buffer.from(e.data.toString('utf8').replace('sheet.main+xml', 'sheet.macroEnabled.main+xml')) : e.data;
      zip.addBuffer(data, e.name);
    }
    zip.end();
    const chunks: Buffer[] = [];
    zip.outputStream.on('data', (c: Buffer) => chunks.push(c));
    zip.outputStream.on('end', () => resolve(Buffer.concat(chunks)));
  });
}
