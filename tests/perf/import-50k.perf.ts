import { expect, it } from 'vitest';
import { formatIp } from '../../src/main/data/domain/ipv4';
import { newId } from '../../src/main/data/ids';
import { applyPayloadFromPreview } from '../../src/main/data/import/apply';
import { buildPreview } from '../../src/main/data/import/plan';
import { suggestMapping, type ImportTarget } from '../../src/main/data/import/targets';
import { readXlsx } from '../../src/main/data/import/xlsx-read';
import { useDomain } from '../unit/domain/support';
import { workbook, type Row } from '../unit/import/fixtures';
import { record, timed } from './support';

const ctx = useDomain();

it('reviews 50,000 rows within 60 s and applies them within 120 s', async () => {
  const locations: Row[] = [['장소경로']];
  for (let b = 1; b <= 10; b++) {
    locations.push([`건물${b}`]);
    for (let r = 1; r <= 29; r++) locations.push([`건물${b} > 실${r}`]);
  }
  const people: Row[] = [['행키', '이름', '부서']];
  for (let i = 1; i <= 2000; i++) people.push([`P-${i}`, `가상직원 ${String(i).padStart(4, '0')}`, `부서${i % 20}`]);
  const networks: Row[] = [['망이름', '대역', '고정시작', '고정끝'], ['합성망', '10.0.0.0/16', '10.0.0.1', '10.0.255.254']];
  const assets: Row[] = [['행키', '종류', '모델', '물품번호', '제조번호', '장소', '담당자', '망', 'IP']];
  for (let i = 1; i <= 50_000 - locations.length - people.length - networks.length + 3; i++) {
    const withIp = i <= 30_000;
    assets.push([
      `A-${i}`, i % 3 === 0 ? '모니터' : i % 3 === 1 ? '노트북' : '데스크톱', `MODEL-${i % 50}`, String(i).padStart(7, '0'), `SN-${i}`,
      `건물${(i % 10) + 1} > 실${(i % 29) + 1}`, i % 4 === 0 ? `가상직원 ${String((i % 2000) + 1).padStart(4, '0')}` : null,
      withIp ? '합성망' : null, withIp ? formatIp(167772160 + i) : null,
    ]);
  }
  const sheets = { 장소: locations, 사람: people, 망: networks, 자산: assets };
  const buf = await workbook(sheets);
  const dataRows = Object.values(sheets).reduce((n, s) => n + s.length - 1, 0);
  expect(dataRows).toBe(50_000);

  const target: Record<string, ImportTarget> = { 장소: 'locations', 사람: 'people', 망: 'networks', 자산: 'assets' };
  const review = await timed(async () => {
    const wb = await readXlsx(buf);
    const mappings = wb.sheets.map((s) => ({ sheet: s.name, target: target[s.name]!, columns: suggestMapping(target[s.name]!, s.headers), dateFormat: 'iso' as const }));
    return ctx.root.store.read((db) =>
      buildPreview(db, { datasetId: ctx.root.store.datasetId, epoch: ctx.root.store.epoch, revision: ctx.root.store.revision }, wb, { sourceNamespace: '규모 시험', fileName: 'scale.xlsx', mappings, decisions: {} }),
    ).data;
  });
  expect(review.value.counts).toMatchObject({ error: 0, conflict: 0, new: 50_000 });
  const applied = await timed(() =>
    ctx.root.store.execute(
      { datasetId: review.value.token.datasetId, epoch: review.value.token.epoch, commandId: newId(), type: 'import.apply', payload: applyPayloadFromPreview(review.value, newId()) },
      '규모 시험',
    ),
  );
  const assetsCount = ctx.read((db) => (db.prepare('SELECT COUNT(*) AS n FROM assets').get() as { n: number }).n);
  const slots = ctx.read((db) => (db.prepare('SELECT COUNT(*) AS n FROM address_slots').get() as { n: number }).n);
  record('import-50k', { fileBytes: buf.byteLength, dataRows, reviewMs: review.ms, applyMs: applied.ms, assets: assetsCount, addressSlots: slots, targets: { reviewMs: 60_000, applyMs: 120_000 } });
  expect(review.ms).toBeLessThanOrEqual(60_000);
  expect(applied.ms).toBeLessThanOrEqual(120_000);
});
