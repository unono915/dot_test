import { describe, expect, it } from 'vitest';
import { DataRoot } from '../../../src/main/data/data-root';
import { createDomainRegistry } from '../../../src/main/data/domain/registry';
import { getAssetDetail, listAssets, listLocations, listPeople } from '../../../src/main/data/domain/queries';
import { DomainError } from '../../../src/main/data/errors';
import { newId } from '../../../src/main/data/ids';
import { applyPayloadFromPreview } from '../../../src/main/data/import/apply';
import { buildPreview, type Decision, type ImportRequest, type Preview, type SheetMapping } from '../../../src/main/data/import/plan';
import { suggestMapping, type ImportTarget } from '../../../src/main/data/import/targets';
import { readXlsx, type ParsedWorkbook } from '../../../src/main/data/import/xlsx-read';
import { fixedClock } from '../data/support';
import { useDomain } from '../domain/support';
import { asMacroEnabled, workbook, zipBomb, type Row } from './fixtures';

const ctx = useDomain();

const LEDGER: Record<string, Row[]> = {
  장소: [['장소경로'], ['본관'], ['본관 > 2층'], ['본관 > 2층 > 교무실'], ['별관'], ['별관 > 창고']],
  사람: [['행키', '이름', '부서'], ['T-001', '가상교사 김하나', '정보부'], ['T-002', '가상교사 이둘', '교무부']],
  망: [['망이름', '대역', '게이트웨이', '고정시작', '고정끝', 'DHCP시작', 'DHCP끝'], ['본관망', '10.20.0.0/24', '10.20.0.1', '10.20.0.10', '10.20.0.99', '10.20.0.100', '10.20.0.200']],
  자산: [
    ['행키', '종류', '모델', '물품번호', '제조번호', '장소', '담당자', 'MAC', '망', 'IP', 'IP상태', '비고'],
    ['A-001', '노트북', 'LT-100', '000123', 'SN-1', '본관 > 2층 > 교무실', '가상교사 김하나', 'AA:00:00:00:00:01', '본관망', '10.20.0.10', '사용', null],
    ['A-002', '데스크톱', 'DT-200', '000124', 'SN-2', '본관 > 2층 > 교무실', '가상교사 이둘', 'AA:00:00:00:00:02', '본관망', '10.20.0.11', '예약', null],
    ['A-003', '모니터', 'MN-24', '000125', null, '별관 > 창고', null, null, null, null, null, '메모'],
  ],
};

const TARGET_OF: Record<string, ImportTarget> = { 장소: 'locations', 사람: 'people', 망: 'networks', 자산: 'assets', 배정: 'assignments', 관측: 'observations', 인터페이스: 'interfaces' };

function mappings(wb: ParsedWorkbook): SheetMapping[] {
  return wb.sheets.map((s) => ({ sheet: s.name, target: TARGET_OF[s.name]!, columns: suggestMapping(TARGET_OF[s.name]!, s.headers), dateFormat: 'iso' as const }));
}

async function preview(buf: Buffer, decisions: Record<string, Decision> = {}, namespace = '2026 장비대장'): Promise<Preview> {
  const wb = await readXlsx(buf);
  const req: ImportRequest = { sourceNamespace: namespace, fileName: '장비대장.xlsx', mappings: mappings(wb), decisions };
  return ctx.root.store.read((db) => buildPreview(db, { datasetId: ctx.root.store.datasetId, epoch: ctx.root.store.epoch, revision: ctx.root.store.revision }, wb, req)).data;
}

function apply(p: Preview, root: DataRoot = ctx.root) {
  return root.store.execute(
    { datasetId: p.token.datasetId, epoch: p.token.epoch, commandId: newId(), type: 'import.apply', payload: applyPayloadFromPreview(p, newId()) },
    '정보부 관리자',
  ).result as { counts: Record<string, number>; created: Record<string, string> };
}

const n = (sql: string) => ctx.read((db) => (db.prepare(sql).get() as { n: number }).n);
const businessEvents = () => n("SELECT COUNT(*) AS n FROM audit_events WHERE event_type NOT LIKE 'import.%'");
const snapshot = () => ({ events: n('SELECT COUNT(*) AS n FROM audit_events'), assets: n('SELECT COUNT(*) AS n FROM assets'), people: n('SELECT COUNT(*) AS n FROM people'), revision: ctx.root.store.revision });

async function code(fn: () => unknown) {
  try {
    await fn();
  } catch (e) {
    if (e instanceof DomainError) return `${e.code}${e.details.reason ? `:${String(e.details.reason)}` : ''}${e.details.rule ? `:${String(e.details.rule)}` : ''}`;
    throw e;
  }
  return 'OK';
}

describe('AC-21 preview and cancel change nothing', () => {
  it('maps, validates and previews without writing; new people/places/networks only appear after apply', async () => {
    const before = snapshot();
    const p = await preview(await workbook(LEDGER));
    expect(p.counts).toMatchObject({ new: 11, error: 0, conflict: 0 });
    expect(p.newEntities).toMatchObject({ people: 2, locations: 5, networks: 1, assets: 3 });
    expect(snapshot()).toEqual(before);
    expect(ctx.read((db) => listPeople(db, {}))).toEqual([]);
    // Re-mapping (different decisions) invalidates the earlier token.
    const p2 = await preview(await workbook(LEDGER), { '자산!4': { exclude: '보류' } });
    expect(p2.token.decisionsHash).not.toBe(p.token.decisionsHash);
    expect(snapshot()).toEqual(before);
  });

  it('applies the confirmed plan through the domain rules', async () => {
    const p = await preview(await workbook(LEDGER));
    const res = apply(p);
    expect(res.counts).toMatchObject({ created: 11, noop: 0 });
    const laptop = ctx.read((db) => listAssets(db, { query: '000123' })).items[0]!;
    const d = ctx.read((db) => getAssetDetail(db, laptop.id))!;
    expect(d).toMatchObject({ asset: { officialNo: '000123', kind: 'laptop' }, location: { path: '본관 > 2층 > 교무실' }, assignment: { personName: '가상교사 김하나' } });
    expect(d.interfaces[0]!.slots[0]).toMatchObject({ ip: '10.20.0.10', state: 'active' });
    const desktop = ctx.read((db) => listAssets(db, { query: '000124' })).items[0]!;
    expect(ctx.read((db) => getAssetDetail(db, desktop.id))!.interfaces[0]!.slots[0]!.state).toBe('reserved');
  });
});

describe('AC-22 re-import', () => {
  it('re-importing the same file is a no-op for assets and business events', async () => {
    const buf = await workbook(LEDGER);
    apply(await preview(buf));
    const assets = n('SELECT COUNT(*) AS n FROM assets');
    const events = businessEvents();
    const again = await preview(buf);
    expect(again.sameSourceAlreadyApplied).toBe(true);
    expect(again.counts).toMatchObject({ unchanged: 11, new: 0, update: 0 });
    expect(apply(again).counts).toMatchObject({ noop: 11, created: 0, updated: 0 });
    expect(n('SELECT COUNT(*) AS n FROM assets')).toBe(assets);
    expect(businessEvents()).toBe(events);
    expect(n('SELECT COUNT(*) AS n FROM import_runs')).toBe(2);
  });

  it('a changed copy with stable keys does not revert manual edits; only the changed row updates', async () => {
    apply(await preview(await workbook(LEDGER)));
    const laptop = ctx.read((db) => listAssets(db, { query: '000123' })).items[0]!;
    const store = ctx.read((db) => listLocations(db)).find((l) => l.path === '별관 > 창고')!.id;
    ctx.exec('asset.move', { items: [{ assetId: laptop.id, expectedVersion: laptop.version }], locationId: store, reason: '수동 이동' });
    const edited = structuredClone(LEDGER);
    edited.자산![3]![11] = '메모 수정';
    const p = await preview(await workbook(edited));
    expect(p.sameSourceAlreadyApplied).toBe(false);
    const a1 = p.rows.find((r) => r.rowKey === 'A-001')!;
    expect(a1.status).toBe('unchanged');
    expect(a1.drift.map((d) => d.field)).toContain('location');
    const a3 = p.rows.find((r) => r.rowKey === 'A-003')!;
    expect(a3).toMatchObject({ status: 'update', diff: [{ field: 'memo', current: '메모', incoming: '메모 수정' }] });
    apply(p);
    expect(ctx.read((db) => getAssetDetail(db, laptop.id))!.asset.locationId).toBe(store);
    expect(n('SELECT COUNT(*) AS n FROM assets')).toBe(3);
  });

  it('a keyless edited copy reports ambiguous matches instead of merging or duplicating', async () => {
    const keyless = (rows: Row[]) => rows.map((r) => r.slice(1));
    const base = { ...LEDGER, 자산: keyless(LEDGER.자산!), 사람: keyless(LEDGER.사람!) };
    apply(await preview(await workbook(base)));
    const edited = structuredClone(base);
    edited.자산![3]![10] = '메모 변경';
    edited.자산!.push(['모니터', 'MN-27', null, null, '별관 > 창고', null, null, null, null, null, null]);
    const p = await preview(await workbook(edited));
    const byModel = (m: string) => p.rows.find((r) => r.values.model === m)!;
    expect(byModel('LT-100')).toMatchObject({ status: 'conflict', messages: [expect.objectContaining({ code: 'ambiguous_match' })] });
    expect(byModel('MN-27')).toMatchObject({ status: 'conflict', messages: [expect.objectContaining({ code: 'unkeyed_in_known_source' })] });
    expect(p.rows.filter((r) => r.target === 'people').every((r) => r.status === 'conflict')).toBe(true);
    expect(await code(() => apply(p))).toBe('RULE_VIOLATION:unresolved_rows');
  });

  it('does not trust internal ids from another dataset', async () => {
    apply(await preview(await workbook(LEDGER)));
    const laptop = ctx.read((db) => listAssets(db, { query: '000123' })).items[0]!;
    const sheet: Row[] = [['내부ID', '종류', '모델'], [laptop.id, '노트북', '변경 모델']];
    const p = await preview(await workbook({ 자산: sheet }, { dataset_id: newId() }), {}, '다른 장부');
    expect(p.rows[0]!.messages.map((m) => m.code)).toContain('foreign_internal_id');
    expect(p.rows[0]!.status).toBe('new');
    const same = await preview(await workbook({ 자산: sheet }, { dataset_id: ctx.root.store.datasetId }), {}, '정규화본');
    expect(same.rows[0]).toMatchObject({ status: 'update', entityId: laptop.id, diff: [{ field: 'model', current: 'LT-100', incoming: '변경 모델' }] });
  });
});

describe('AC-23 blank cells, explicit clears, missing rows, key conflicts', () => {
  it('keeps values for blank cells, clears only on explicit choice and never deletes absent rows', async () => {
    apply(await preview(await workbook(LEDGER)));
    const edited = structuredClone(LEDGER);
    edited.자산 = [edited.자산![0]!, ['A-003', '모니터', null, '000125', null, null, null, null, null, null, null, null]];
    const p = await preview(await workbook(edited));
    expect(p.rows.find((r) => r.rowKey === 'A-003')!.status).toBe('unchanged');
    const cleared = await preview(await workbook(edited), { '자산!2': { clearFields: ['memo', 'model'] } });
    expect(cleared.rows.find((r) => r.rowKey === 'A-003')!.diff.map((d) => d.field).sort()).toEqual(['memo', 'model']);
    apply(cleared);
    const mon = ctx.read((db) => listAssets(db, { query: '000125' })).items[0]!;
    expect(mon).toMatchObject({ memo: null, model: null });
    expect(n('SELECT COUNT(*) AS n FROM assets')).toBe(3);
    expect(ctx.read((db) => listAssets(db, { query: '000123' })).items).toHaveLength(1);
  });

  it('rejects rows whose internal id and stable key point at different assets', async () => {
    apply(await preview(await workbook(LEDGER)));
    const desktop = ctx.read((db) => listAssets(db, { query: '000124' })).items[0]!;
    const sheet: Row[] = [['행키', '내부ID', '종류'], ['A-001', desktop.id, '노트북']];
    const p = await preview(await workbook({ 자산: sheet }, { dataset_id: ctx.root.store.datasetId }));
    expect(p.rows[0]).toMatchObject({ status: 'error', messages: [expect.objectContaining({ code: 'key_conflict' })] });
  });
});

describe('AC-24 row/column errors and limits', () => {
  it('explains invalid IPs, broken relations, formulas, ambiguous dates and business requests per row and column', async () => {
    const sheet: Row[] = [
      ['종류', '물품번호', 'IP', '망', '담당자', '취득일', '요청사항', '모델'],
      ['노트북', '1001', '10.20.0.300', '본관망', null, null, null, null],
      ['노트북', '1002', null, null, '없는 사람', null, null, null],
      ['노트북', '1003', null, null, null, '03/04/2026', null, null],
      ['노트북', '1004', null, null, null, null, null, { formula: 'A1&"x"' }],
      ['노트북', '1005', null, null, null, null, '폐기 요청', null],
    ];
    const p = await preview(await workbook({ ...LEDGER, 자산: sheet }));
    const codes = (rowNumber: number) => p.rows.find((r) => r.sheet === '자산' && r.rowNumber === rowNumber)!.messages.map((m) => `${m.code}@${m.field}`);
    expect(codes(2)).toContain('invalid_ip@ip');
    expect(codes(3)).toContain('person_not_found@person');
    expect(codes(4)).toContain('ambiguous_date@acquiredOn');
    expect(codes(5)).toContain('formula@model');
    expect(codes(6)).toContain('business_action@requestedAction');
    expect(p.rows.find((r) => r.rowNumber === 6 && r.sheet === '자산')!.status).toBe('new');
    expect(p.rows.find((r) => r.rowNumber === 5 && r.sheet === '자산')!.messages.find((m) => m.code === 'formula')!.column).toBe(7);
  });

  it('rejects oversize, zip bombs, macro-enabled packages and too many sheets before parsing', async () => {
    expect(await code(() => readXlsx(Buffer.alloc(25 * 1024 * 1024 + 1)))).toBe('LIMIT_EXCEEDED:file_size');
    expect(await code(async () => readXlsx(await zipBomb(260 * 1024 * 1024)))).toBe('LIMIT_EXCEEDED:uncompressed_size');
    expect(await code(async () => readXlsx(await asMacroEnabled(await workbook(LEDGER))))).toBe('VALIDATION:macro_or_binary');
    const many: Record<string, Row[]> = {};
    for (let i = 0; i < 21; i++) many[`S${i}`] = [['a'], ['b']];
    expect(await code(async () => readXlsx(await workbook(many)))).toBe('LIMIT_EXCEEDED:sheets');
    expect(await code(() => readXlsx(Buffer.from('not a zip at all')))).toBe('VALIDATION:not_zip');
  });

  it('rejects more than 50,000 data rows', { timeout: 120_000 }, async () => {
    const rows: Row[] = [['종류']];
    for (let i = 0; i < 50_001; i++) rows.push(['모니터']);
    expect(await code(async () => readXlsx(await workbook({ 자산: rows })))).toBe('LIMIT_EXCEEDED:rows');
  });

  it('refuses network overlap and occupied addresses through import too', async () => {
    apply(await preview(await workbook(LEDGER)));
    const nets: Row[] = [['망이름', '대역'], ['교무실망', '10.20.0.128/25']];
    const p = await preview(await workbook({ 망: nets }), {}, '망 추가');
    expect(p.rows[0]!.messages.map((m) => m.code)).toContain('network_overlap');
    const assets: Row[] = [['종류', '물품번호', '망', 'IP'], ['노트북', '2001', '본관망', '10.20.0.10']];
    const q = await preview(await workbook({ 자산: assets }), {}, '추가 장비');
    expect(q.rows[0]!.messages.map((m) => m.code)).toContain('address_occupied');
  });
});

describe('AC-25 stale previews', () => {
  it('rejects applying after an unrelated change and after an epoch change with the same revision', async () => {
    const buf = await workbook(LEDGER);
    const loc = ctx.exec('location.create', { name: '임시', parentId: null }).id;
    const p = await preview(buf);
    ctx.exec('location.update', { id: loc, expectedVersion: 1, name: '임시(변경)', parentId: null });
    expect(await code(() => apply(p))).toBe('VERSION_CONFLICT:stale_preview');
    const fresh = await preview(buf);
    ctx.root.reactivateForTest();
    expect(ctx.root.store.revision).toBe(fresh.token.revision);
    expect(await code(() => apply(fresh))).toBe('STALE_EPOCH');
    expect(n('SELECT COUNT(*) AS n FROM assets')).toBe(0);
    apply(await preview(buf));
    expect(n('SELECT COUNT(*) AS n FROM assets')).toBe(3);
  });
});

describe('AC-26 all-or-nothing apply', () => {
  it('rolls back every entity, state and event when the database fails mid-apply', async () => {
    const p = await preview(await workbook(LEDGER));
    ctx.root.close();
    const root = DataRoot.open(ctx.dir, { registry: createDomainRegistry(), now: fixedClock(Date.parse('2026-04-01T00:00:00Z')), faults: { hit: (s) => { if (s === 'after-handler') throw new Error('injected disk failure'); } } });
    try {
      expect(() => apply(p, root)).toThrow(/injected/);
      const count = (t: string) => (root.store.db.prepare(`SELECT COUNT(*) AS n FROM ${t}`).get() as { n: number }).n;
      expect([count('assets'), count('people'), count('networks'), count('address_slots'), count('import_runs'), count('audit_events'), count('locations')]).toEqual([0, 0, 0, 0, 0, 0, 1]);
    } finally {
      root.close();
      ctx.reopen();
    }
  });

  it('reports excluded rows and their reasons in the result', async () => {
    const p = await preview(await workbook(LEDGER), { '자산!4': { exclude: '확인 필요' } });
    expect(p.counts.excluded).toBe(1);
    const res = apply(p);
    expect(res.counts).toMatchObject({ excluded: 1, created: 10 });
    const run = ctx.read((db) => db.prepare('SELECT excluded_json AS e FROM import_runs').get() as { e: string });
    expect(JSON.parse(run.e)).toEqual([{ ref: '자산!4', reason: '확인 필요' }]);
  });
});
