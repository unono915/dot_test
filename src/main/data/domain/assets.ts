import { defineCommand, type TxContext } from '../commands.js';
import { fail } from '../errors.js';
import { newId } from '../ids.js';
import { normalizeMac } from './ipv4.js';
import { bumpAsset, getActiveLocation, getAsset, getInterface, violate } from './repo.js';
import { instant, int, list, oneOf, optCode, optDate, optStr, optUuid, parser, shape, str, uuid, version, type Validator } from './validate.js';

export const ASSET_KINDS = ['laptop', 'desktop', 'monitor', 'other'] as const;
export const INTERFACE_KINDS = ['ethernet', 'wifi', 'other'] as const;

const mac: Validator<string | null> = (value, field) => normalizeMac(value, field);

const interfaceSpec = shape({ kind: oneOf(INTERFACE_KINDS), label: str({ max: 50 }), mac });

const descriptive = {
  manufacturer: optStr({ max: 100 }),
  model: optStr({ max: 100 }),
  serial: optCode({ max: 100 }),
  officialNo: optCode({ max: 100 }),
  ownership: optStr({ max: 100 }),
  acquiredOn: optDate,
  acquisitionSource: optStr({ max: 200 }),
  warrantyUntil: optDate,
  memo: optStr({ max: 2000 }),
};

const optionalList = <T>(inner: Validator<T[]>): Validator<T[]> => (value, field) => (value === undefined || value === null ? [] : inner(value, field));

const quantity: Validator<number> = (value, field) => (value === undefined ? 1 : int({ min: 1, max: 1000 })(value, field));

const itemSpec = shape({
  kind: oneOf(ASSET_KINDS),
  ...descriptive,
  quantity,
  interfaces: optionalList(list(interfaceSpec, { min: 0, max: 16 })),
});

export function insertInterface(ctx: TxContext, assetId: string, i: { kind: string; label: string; mac: string | null }): string {
  const id = newId();
  ctx.db.prepare("INSERT INTO interfaces VALUES (?, ?, ?, ?, ?, 'enabled', 1, ?)").run(id, assetId, i.kind, i.label, i.mac, ctx.now);
  ctx.emit({ eventType: 'interface.added', entityType: 'interface', entityId: id, before: null, after: { assetId, ...i, status: 'enabled' } });
  return id;
}

/**
 * Registers individual assets. A line with quantity N creates N assets with their own ids; a
 * purchased quantity is never stored on one row.
 */
export const assetRegisterBatch = defineCommand('asset.registerBatch', parser({ locationId: uuid, items: list(itemSpec, { min: 1, max: 1000 }) }), (ctx, p) => {
    getActiveLocation(ctx.db, p.locationId);
    const total = p.items.reduce((n, i) => n + i.quantity, 0);
    if (total > 5000) fail('LIMIT_EXCEEDED', '한 번에 5,000대까지 등록할 수 있습니다.', { total });
    const insert = ctx.db.prepare(
      `INSERT INTO assets VALUES (@id, @kind, @manufacturer, @model, @serial, @officialNo, @ownership, @acquiredOn, @acquisitionSource,
        @warrantyUntil, 'ready', 'none', @locationId, @memo, 1, @now, @now)`,
    );
    const assetIds: string[] = [];
    p.items.forEach((item, index) => {
      if (item.quantity > 1 && (item.serial || item.officialNo)) {
        fail('VALIDATION', '제조번호·물품번호가 있는 장비는 한 줄에 1대씩 등록해 주세요.', { field: `items[${index}].quantity` });
      }
      const { quantity, interfaces, ...attrs } = item;
      for (let n = 0; n < quantity; n++) {
        const id = newId();
        insert.run({ id, ...attrs, locationId: p.locationId, now: ctx.now });
        ctx.emit({ eventType: 'asset.registered', entityType: 'asset', entityId: id, before: null, after: { ...attrs, locationId: p.locationId, lifecycle: 'ready' } });
        for (const i of interfaces) insertInterface(ctx, id, i);
        assetIds.push(id);
      }
    });
    return { assetIds };
});

export const assetUpdate = defineCommand('asset.update', parser({ id: uuid, expectedVersion: version, ...descriptive }), (ctx, p) => {
    const before = getAsset(ctx.db, p.id);
    ctx.expectVersion('asset', p.id, before.version, p.expectedVersion);
    const { id, expectedVersion: _v, ...fields } = p;
    const cols: Record<string, unknown> = {
      manufacturer: fields.manufacturer, model: fields.model, serial: fields.serial, official_no: fields.officialNo,
      ownership: fields.ownership, acquired_on: fields.acquiredOn, acquisition_source: fields.acquisitionSource,
      warranty_until: fields.warrantyUntil, memo: fields.memo,
    };
    bumpAsset(ctx.db, id, ctx.now, cols);
    const prev = Object.fromEntries(Object.keys(fields).map((k) => [k, before[k as keyof typeof before]]));
    ctx.emit({ eventType: 'asset.updated', entityType: 'asset', entityId: id, before: prev, after: fields });
    return { id, version: before.version + 1 };
});

/** Explicit positive physical sighting outside an inventory session. */
export const assetRecordPhysicalCheck = defineCommand('asset.recordPhysicalCheck', parser({ assetId: uuid, checkedAt: instant, locationId: optUuid, note: optStr({ max: 500 }) }), (ctx, p) => {
    const asset = getAsset(ctx.db, p.assetId);
    if (asset.lifecycle === 'disposed') violate('asset_disposed', '폐기된 자산입니다.');
    if (p.locationId) getActiveLocation(ctx.db, p.locationId);
    const id = newId();
    const eventId = ctx.emit({
      eventType: 'asset.physicallyChecked', entityType: 'asset', entityId: p.assetId, occurredAt: p.checkedAt,
      after: { checkedAt: p.checkedAt, locationId: p.locationId, note: p.note },
    });
    ctx.db.prepare("INSERT INTO physical_checks VALUES (?, ?, ?, ?, 'manual', NULL, NULL, ?)").run(id, p.assetId, p.checkedAt, p.locationId, eventId);
    return { id };
});

export const interfaceAdd = defineCommand('interface.add', parser({ assetId: uuid, expectedAssetVersion: version, kind: oneOf(INTERFACE_KINDS), label: str({ max: 50 }), mac }), (ctx, p) => {
    const asset = getAsset(ctx.db, p.assetId);
    ctx.expectVersion('asset', p.assetId, asset.version, p.expectedAssetVersion);
    if (asset.lifecycle === 'disposed') violate('asset_disposed', '폐기된 자산입니다.');
    const id = insertInterface(ctx, p.assetId, p);
    bumpAsset(ctx.db, p.assetId, ctx.now);
    return { id };
});

export const interfaceUpdate = defineCommand('interface.update', parser({ id: uuid, expectedVersion: version, label: str({ max: 50 }), mac, kind: oneOf(INTERFACE_KINDS) }), (ctx, p) => {
    const before = getInterface(ctx.db, p.id);
    ctx.expectVersion('interface', p.id, before.version, p.expectedVersion);
    ctx.db.prepare('UPDATE interfaces SET label = ?, mac = ?, kind = ?, version = version + 1 WHERE id = ?').run(p.label, p.mac, p.kind, p.id);
    ctx.emit({
      eventType: 'interface.updated', entityType: 'interface', entityId: p.id,
      before: { label: before.label, mac: before.mac, kind: before.kind }, after: { label: p.label, mac: p.mac, kind: p.kind },
    });
    return { id: p.id, version: before.version + 1 };
});

export const interfaceSetStatus = defineCommand('interface.setStatus', parser({ id: uuid, expectedVersion: version, status: oneOf(['enabled', 'disabled'] as const), reason: str({ max: 500 }) }), (ctx, p) => {
    const before = getInterface(ctx.db, p.id);
    ctx.expectVersion('interface', p.id, before.version, p.expectedVersion);
    if (before.status === p.status) violate('no_change', '이미 같은 상태입니다.');
    if (p.status === 'disabled') {
      const held = (ctx.db.prepare("SELECT COUNT(*) AS n FROM address_slots WHERE interface_id = ? AND state IN ('reserved','active','pending_release')").get(p.id) as { n: number }).n;
      if (held > 0) violate('interface_has_addresses', '점유 중인 IP가 있는 인터페이스는 비활성화할 수 없습니다. IP를 먼저 해제하거나 이전해 주세요.', { count: held });
    } else if (getAsset(ctx.db, before.assetId).lifecycle === 'disposed') {
      violate('asset_disposed', '폐기된 자산입니다.');
    }
    ctx.db.prepare('UPDATE interfaces SET status = ?, version = version + 1 WHERE id = ?').run(p.status, p.id);
    ctx.emit({ eventType: 'interface.statusChanged', entityType: 'interface', entityId: p.id, before: { status: before.status }, after: { status: p.status }, reason: p.reason });
    return { id: p.id, version: before.version + 1 };
});

export const assetCommands = [assetRegisterBatch, assetUpdate, assetRecordPhysicalCheck, interfaceAdd, interfaceUpdate, interfaceSetStatus];
