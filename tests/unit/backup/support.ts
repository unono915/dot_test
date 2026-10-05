import { mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { stageAttachment } from '../../../src/main/data/attachments';
import type { DataRoot } from '../../../src/main/data/data-root';
import { getAssetDetail } from '../../../src/main/data/domain/queries';
import { newId } from '../../../src/main/data/ids';

export const PDF = Buffer.from('%PDF-1.4\n% synthetic attachment\n%%EOF\n');
export const PNG = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.from('synthetic png')]);

export function exec(root: DataRoot, type: string, payload: unknown) {
  return root.store.execute({ datasetId: root.store.datasetId, epoch: root.store.epoch, commandId: newId(), type, payload }, '정보부 관리자').result as never as Record<string, never>;
}

/** A small but complete synthetic ledger: places, people, networks, IPs, loan, repair, inventory, observations, attachments. */
export async function seedLedger(root: DataRoot) {
  const v = (id: string) => root.store.read((db) => getAssetDetail(db, id)).data!.asset.version;
  const room = exec(root, 'location.create', { name: '본관 정보실', parentId: null }).id as unknown as string;
  const store = exec(root, 'location.create', { name: '창고', parentId: null }).id as unknown as string;
  const kim = exec(root, 'person.create', { displayName: '가상교사 김하나', department: '정보부' }).id as unknown as string;
  const lee = exec(root, 'person.create', { displayName: '가상교사 이둘', department: null }).id as unknown as string;
  const net = exec(root, 'network.create', { name: '업무망', cidr: '10.90.0.0/24', gateway: '10.90.0.1', dns: ['10.90.0.2'], ranges: [{ kind: 'static', first: '10.90.0.10', last: '10.90.0.99' }] })
    .networkId as unknown as string;
  const ids = exec(root, 'asset.registerBatch', {
    locationId: room,
    items: [
      { kind: 'laptop', officialNo: '000123', quantity: 1, interfaces: [{ kind: 'ethernet', label: '유선', mac: '00:00:00:00:01:01' }] },
      { kind: 'desktop', officialNo: '000124', interfaces: [{ kind: 'ethernet', label: '유선', mac: '00:00:00:00:01:02' }] },
      { kind: 'monitor', quantity: 2 },
    ],
  }).assetIds as unknown as string[];
  exec(root, 'asset.assign', { assetId: ids[0], expectedVersion: v(ids[0]!), personId: kim, role: 'user', reason: null });
  const iface = root.store.read((db) => getAssetDetail(db, ids[0]!)).data!.interfaces[0]!.id;
  exec(root, 'address.reserve', { networkId: net, ip: '10.90.0.10', interfaceId: iface, reason: '합성', expectedSlotVersion: null });
  exec(root, 'loan.open', { assetId: ids[2], expectedVersion: v(ids[2]!), borrowerId: lee, dueOn: '2026-04-01', locationId: store, purpose: '연수' });
  exec(root, 'repair.open', { assetId: ids[1], expectedVersion: v(ids[1]!), symptom: '전원 불량', vendor: null, receivedOn: '2026-03-02' });
  exec(root, 'inventory.start', { title: '합성 실사', scope: { kinds: null, locationIds: null } });
  const obs = exec(root, 'observation.createSession', { label: '관측', windowStart: '2026-03-02T00:00:00Z', windowEnd: '2026-03-02T01:00:00Z', source: '수동' }).sessionId;
  exec(root, 'observation.record', { sessionId: obs, items: [{ networkId: net, ip: '10.90.0.10', mac: '00:00:00:00:01:01', assetId: null, observedAt: '2026-03-02T00:10:00Z', raw: null }] });
  const dir = path.join(root.dir, `incoming-${newId()}`);
  mkdirSync(dir, { recursive: true });
  writeFileSync(path.join(dir, '수리확인서.pdf'), PDF);
  writeFileSync(path.join(dir, '사진.png'), PNG);
  const pdf = await stageAttachment(root.dir, path.join(dir, '수리확인서.pdf'));
  const png = await stageAttachment(root.dir, path.join(dir, '사진.png'));
  const link = exec(root, 'attachment.add', { ...pdf, entityType: 'asset', entityId: ids[1] }).linkId as unknown as string;
  exec(root, 'attachment.add', { ...png, entityType: 'asset', entityId: ids[0] });
  // Historical link: still referenced by history, so it must be in every backup.
  exec(root, 'attachment.unlink', { linkId: link, reason: '중복' });
  root.store.db.prepare("INSERT INTO settings VALUES ('ledger.loanDefaultDays', '14', 1)").run();
  return { room, store, kim, lee, net, ids, hashes: [pdf.sha256, png.sha256] };
}

/** Rows of every table except the ones a restore legitimately adds to. */
export function dumpTables(db: import('../../../src/main/data/sqlite').Db, opts: { excludeRestoreEvents?: boolean } = {}) {
  const tables = (db.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' ORDER BY name").all() as { name: string }[]).map((t) => t.name);
  const out: Record<string, unknown[]> = {};
  for (const t of tables) {
    if (t === 'dataset_meta') continue;
    let rows = db.prepare(`SELECT * FROM ${t} ORDER BY rowid`).all() as Record<string, unknown>[];
    if (opts.excludeRestoreEvents && t === 'audit_events') rows = rows.filter((r) => !String(r.event_type).startsWith('dataset.')).map(({ seq: _s, ...r }) => r);
    if (opts.excludeRestoreEvents && t === 'command_receipts') rows = rows.filter((r) => !String(r.command_type).startsWith('dataset.'));
    out[t] = rows;
  }
  return out;
}
