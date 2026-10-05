import { existsSync, readdirSync } from 'node:fs';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { collectReport, type ReportKind } from '../../../src/main/data/export/reports';
import { writeReportFile } from '../../../src/main/data/export/write-xlsx';
import { getAssetDetail, listLocations } from '../../../src/main/data/domain/queries';
import { buildPreview } from '../../../src/main/data/import/plan';
import { suggestMapping, type ImportTarget } from '../../../src/main/data/import/targets';
import { readXlsx } from '../../../src/main/data/import/xlsx-read';
import { tempDir } from '../data/support';
import { useDomain } from '../domain/support';
import { inspectZip } from '../../../src/main/data/import/zip-guard';

const ctx = useDomain();
let out: ReturnType<typeof tempDir>;
beforeEach(() => (out = tempDir('school-asset-export-')));
afterEach(() => out.cleanup());

function seed() {
  const room = ctx.exec('location.create', { name: '정보실', parentId: null }).id as string;
  const kim = ctx.exec('person.create', { displayName: '가상교사 김하나', department: '정보부' }).id as string;
  const net = ctx.exec('network.create', { name: '업무망', cidr: '10.80.0.0/24', gateway: '10.80.0.1', dns: [], ranges: [{ kind: 'static', first: '10.80.0.10', last: '10.80.0.99' }] }).networkId as string;
  const ids = ctx.exec('asset.registerBatch', {
    locationId: room,
    items: [
      { kind: 'laptop', officialNo: '000777', memo: '=HYPERLINK("http://example.invalid","x")', interfaces: [{ kind: 'ethernet', label: '유선', mac: '00:00:00:00:00:77' }] },
      { kind: 'desktop', officialNo: '000778', memo: '+82-10', model: '@SUM(A1)' },
      { kind: 'monitor', officialNo: '000779', memo: '-1+1' },
    ],
  }).assetIds as string[];
  const v = (id: string) => ctx.read((db) => getAssetDetail(db, id))!.asset.version;
  ctx.exec('asset.assign', { assetId: ids[0], expectedVersion: v(ids[0]!), personId: kim, role: 'user', reason: null });
  const iface = ctx.read((db) => getAssetDetail(db, ids[0]!))!.interfaces[0]!.id;
  ctx.exec('address.reserve', { networkId: net, ip: '10.80.0.10', interfaceId: iface, reason: '합성', expectedSlotVersion: null });
  ctx.exec('inventory.start', { title: '합성 실사', scope: { kinds: null, locationIds: null } });
  return { room, kim, net, ids };
}

const collect = (kind: ReportKind, extra: Record<string, unknown> = {}) =>
  ctx.root.store.read((db) => collectReport(db, { datasetId: ctx.root.store.datasetId, revision: ctx.root.store.revision, now: '2026-03-10T00:00:00.000Z' }, { kind, today: '2026-03-10', ...extra })).data;

describe('AC-27 one revision, exact row counts, stable ids', () => {
  it('every report states its revision and row counts and matches the ledger', async () => {
    seed();
    for (const kind of ['asset_ledger', 'people_holdings', 'location_status', 'ip_ledger', 'inventory', 'unresolved', 'handover', 'normalized'] as ReportKind[]) {
      const data = collect(kind);
      expect(data.revision).toBe(ctx.root.store.revision);
      const file = path.join(out.dir, `${kind}.xlsx`);
      await writeReportFile(data, file);
      const wb = await readXlsx(await import('node:fs/promises').then((f) => f.readFile(file)));
      const cover = wb.sheets.find((s) => s.name === '출력 정보')!;
      const coverMap = new Map(cover.rows.map((r) => [r.cells[0]!.v, r.cells[1]!.v]));
      coverMap.set(cover.headers[0]!, cover.headers[1]!);
      expect(coverMap.get('기준 revision')).toBe(String(data.revision));
      for (const s of data.sheets.filter((x) => !x.hidden)) {
        expect(wb.sheets.find((x) => x.name === s.name)!.rows).toHaveLength(s.rows.length);
        expect(coverMap.get(`행 수: ${s.name}`)).toBe(String(s.rows.length));
      }
    }
    expect(collect('asset_ledger').sheets[0]!.rows).toHaveLength(3);
    expect(collect('ip_ledger').sheets[0]!.rows).toHaveLength(1);
  });

  it('a change after collection does not leak into the file (single snapshot)', async () => {
    const { ids, room } = seed();
    const data = collect('asset_ledger');
    ctx.exec('asset.registerBatch', { locationId: room, items: [{ kind: 'monitor', quantity: 5 }] });
    ctx.exec('asset.retire', { assetId: ids[1], expectedVersion: ctx.read((db) => getAssetDetail(db, ids[1]!))!.asset.version, reason: '노후' });
    const file = path.join(out.dir, 'ledger.xlsx');
    await writeReportFile(data, file);
    const wb = await readXlsx(await import('node:fs/promises').then((f) => f.readFile(file)));
    const sheet = wb.sheets.find((s) => s.name === '자산대장')!;
    expect(sheet.rows).toHaveLength(3);
    expect(sheet.rows.find((r) => r.cells[0]!.v === ids[1])!.cells[6]!.v).toBe('사용 가능');
  });

  it('the normalised document re-imports as unchanged rows matched by internal id', async () => {
    seed();
    const file = path.join(out.dir, 'normalized.xlsx');
    await writeReportFile(collect('normalized'), file);
    const wb = await readXlsx(await import('node:fs/promises').then((f) => f.readFile(file)));
    expect(wb.meta.dataset_id).toBe(ctx.root.store.datasetId);
    const target: Record<string, ImportTarget> = { 장소: 'locations', 사람: 'people', 망: 'networks', 자산: 'assets', 인터페이스: 'interfaces' };
    const mappings = wb.sheets.filter((s) => target[s.name]).map((s) => ({ sheet: s.name, target: target[s.name]!, columns: suggestMapping(target[s.name]!, s.headers), dateFormat: 'iso' as const }));
    expect(mappings.find((m) => m.target === 'assets')!.columns.internalId).toBe(0);
    const p = ctx.root.store.read((db) =>
      buildPreview(db, { datasetId: ctx.root.store.datasetId, epoch: ctx.root.store.epoch, revision: ctx.root.store.revision }, wb, { sourceNamespace: '정규화본', fileName: 'normalized.xlsx', mappings, decisions: {} }),
    ).data;
    const notUnchanged = p.rows.filter((r) => r.status !== 'unchanged');
    expect(notUnchanged.map((r) => `${r.ref}:${r.status}:${r.messages.map((m) => m.code).join(',')}`)).toEqual([]);
    expect(p.rows.filter((r) => r.target === 'assets').map((r) => r.entityId).sort()).toEqual(
      ctx.read((db) => (db.prepare('SELECT id FROM assets').all() as { id: string }[]).map((a) => a.id)).sort(),
    );
  });

  it('can leave out personal names and says so on the cover', () => {
    seed();
    const data = collect('asset_ledger', { includePersonNames: false });
    expect(data.excludedFields).toContain('사람 이름');
    expect(JSON.stringify(data.sheets)).not.toContain('김하나');
  });
});

describe('AC-28 safe cells and atomic publication', () => {
  it('writes formula-looking text as plain string cells', async () => {
    seed();
    const file = path.join(out.dir, 'ledger.xlsx');
    await writeReportFile(collect('asset_ledger'), file);
    const buf = await import('node:fs/promises').then((f) => f.readFile(file));
    const { kept } = await inspectZip(buf, { maxEntries: 100, maxTotalUncompressed: 50 * 1024 * 1024 }, (n) => n.startsWith('xl/worksheets/'));
    const xml = [...kept.values()].map((b) => b.toString('utf8')).join('');
    expect(xml).not.toMatch(/<f>|<f /);
    const wb = await readXlsx(buf);
    const cells = wb.sheets.find((s) => s.name === '자산대장')!.rows.flatMap((r) => r.cells);
    for (const text of ['=HYPERLINK("http://example.invalid","x")', '+82-10', '@SUM(A1)', '-1+1']) {
      expect(cells.find((c) => c.v === text)).toMatchObject({ t: 'string' });
    }
  });

  it('never publishes a final file on failure or cancel', async () => {
    seed();
    const data = collect('handover');
    const file = path.join(out.dir, 'handover.xlsx');
    await expect(writeReportFile(data, file, { beforeRename: () => { throw new Error('disk full (injected)'); } })).rejects.toThrow(/injected/);
    expect(existsSync(file)).toBe(false);
    await expect(writeReportFile(data, file, { cancelled: () => true })).rejects.toThrow(/취소/);
    expect(existsSync(file)).toBe(false);
    expect(readdirSync(out.dir)).toEqual([]);
    await writeReportFile(data, file);
    expect(readdirSync(out.dir)).toEqual(['handover.xlsx']);
  });

  it('keeps the location of the unspecified place out of the normalised import columns', () => {
    seed();
    const unspecified = ctx.read((db) => listLocations(db)).find((l) => l.isUnspecified)!;
    const sheet = collect('normalized').sheets.find((s) => s.name === '장소')!;
    expect(sheet.rows.map((r) => r[0])).not.toContain(unspecified.id);
  });
});
