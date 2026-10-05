import { defineCommand } from '../commands.js';
import { fail } from '../errors.js';
import { newId } from '../ids.js';
import type { Db } from '../sqlite.js';
import { formatIp, normalizeMac, parseIp } from './ipv4.js';
import { slotByIp } from './network-queries.js';
import { getAsset, violate } from './repo.js';
import { instant, list, optStr, optUuid, parser, shape, str, uuid, type Validator } from './validate.js';

// Observations are evidence only. They are immutable, corrected by supersession, and never
// change the assignment ledger.

const mac: Validator<string | null> = (v, f) => normalizeMac(v, f);
const ip: Validator<number> = (v, f) => parseIp(v, f);

function getSession(db: Db, id: string) {
  return (
    (db.prepare('SELECT id, label, window_start AS windowStart, window_end AS windowEnd, source FROM observation_sessions WHERE id = ?').get(id) as
      | { id: string; label: string; windowStart: string; windowEnd: string; source: string }
      | undefined) ?? fail('NOT_FOUND', '관측 회차를 찾을 수 없습니다.')
  );
}

export const observationCreateSession = defineCommand(
  'observation.createSession',
  parser({ label: str({ max: 100 }), windowStart: instant, windowEnd: instant, source: str({ max: 100 }) }),
  (ctx, p) => {
    if (p.windowEnd < p.windowStart) fail('VALIDATION', '확인 구간의 끝이 시작보다 빠릅니다.', { field: 'windowEnd' });
    const id = newId();
    ctx.db.prepare('INSERT INTO observation_sessions VALUES (?, ?, ?, ?, ?, NULL, ?)').run(id, p.label, p.windowStart, p.windowEnd, p.source, ctx.now);
    ctx.emit({ eventType: 'observation.sessionCreated', entityType: 'observation_session', entityId: id, after: p });
    return { sessionId: id };
  },
);

const obsItem = shape({ networkId: uuid, ip, mac, assetId: optUuid, observedAt: instant, raw: optStr({ max: 1000 }) });

export function insertObservations(
  db: Db,
  now: string,
  sessionId: string,
  items: { networkId: string; ip: number; mac: string | null; assetId: string | null; observedAt: string; raw: string | null }[],
  source: string,
): string[] {
  const ins = db.prepare('INSERT INTO observations VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NULL)');
  return items.map((o) => {
    if (!db.prepare('SELECT 1 FROM networks WHERE id = ?').get(o.networkId)) fail('NOT_FOUND', '망을 찾을 수 없습니다.');
    if (o.assetId) getAsset(db, o.assetId);
    const id = newId();
    ins.run(id, sessionId, o.networkId, o.ip, o.mac, o.assetId, o.observedAt, now, source, o.raw);
    return id;
  });
}

export const observationRecord = defineCommand(
  'observation.record',
  parser({ sessionId: uuid, items: list(obsItem, { min: 1, max: 100_000 }) }),
  (ctx, p) => {
    const s = getSession(ctx.db, p.sessionId);
    const ids = insertObservations(ctx.db, ctx.now, s.id, p.items, s.source);
    ctx.emit({ eventType: 'observation.recorded', entityType: 'observation_session', entityId: s.id, after: { count: ids.length } });
    return { observationIds: ids };
  },
);

export const observationSupersede = defineCommand(
  'observation.supersede',
  parser({ observationId: uuid, mac, assetId: optUuid, reason: str({ max: 500 }) }),
  (ctx, p) => {
    const o = ctx.db.prepare('SELECT * FROM observations WHERE id = ?').get(p.observationId) as
      | { id: string; session_id: string; network_id: string; ip: number; observed_at: string; source: string; raw: string | null }
      | undefined;
    if (!o) fail('NOT_FOUND', '관측 기록을 찾을 수 없습니다.');
    if (ctx.db.prepare('SELECT 1 FROM observations WHERE supersedes_id = ?').get(o!.id)) violate('already_superseded', '이미 정정된 관측입니다. 최신 기록을 정정해 주세요.');
    if (p.assetId) getAsset(ctx.db, p.assetId);
    const id = newId();
    ctx.db
      .prepare('INSERT INTO observations VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)')
      .run(id, o!.session_id, o!.network_id, o!.ip, p.mac, p.assetId, o!.observed_at, ctx.now, o!.source, o!.raw, o!.id);
    ctx.emit({ eventType: 'observation.superseded', entityType: 'observation_session', entityId: o!.session_id, after: { observationId: id, supersedes: o!.id, mac: p.mac, assetId: p.assetId }, reason: p.reason });
    return { observationId: id };
  },
);

export const observationCommands = [observationCreateSession, observationRecord, observationSupersede];

export interface ObservationView {
  id: string;
  networkId: string;
  ip: string;
  mac: string | null;
  assetId: string | null;
  observedAt: string;
  recordedAt: string;
  source: string;
  raw: string | null;
  supersedesId: string | null;
  superseded: boolean;
}

export function listObservations(db: Db, sessionId: string, opts: { includeSuperseded?: boolean } = {}): ObservationView[] {
  const rows = db
    .prepare(
      `SELECT o.id, o.network_id AS networkId, o.ip, o.mac, o.asset_id AS assetId, o.observed_at AS observedAt, o.recorded_at AS recordedAt, o.source, o.raw,
         o.supersedes_id AS supersedesId, EXISTS (SELECT 1 FROM observations x WHERE x.supersedes_id = o.id) AS superseded
       FROM observations o WHERE o.session_id = ? ORDER BY o.ip, o.observed_at, o.rowid`,
    )
    .all(sessionId) as (Omit<ObservationView, 'ip' | 'superseded'> & { ip: number; superseded: number })[];
  return rows
    .map((r) => ({ ...r, ip: formatIp(r.ip), superseded: r.superseded === 1 }))
    .filter((r) => opts.includeSuperseded || !r.superseded);
}

export type Judgment = 'unknown' | 'matching' | 'mismatching' | 'suspected_conflict';

/**
 * Compares one observation session with the current assignment ledger. Within the session, two
 * different identities on one IP are a suspected conflict (not a proven simultaneous clash).
 */
export function compareObservationSession(db: Db, sessionId: string) {
  const session = getSession(db, sessionId);
  const revision = Number((db.prepare("SELECT value FROM dataset_meta WHERE key = 'revision'").get() as { value: string }).value);
  const obs = listObservations(db, sessionId);
  const assetByMac = db.prepare('SELECT asset_id AS assetId FROM interfaces WHERE mac = ?');
  const identity = (o: ObservationView): string | null => {
    if (o.assetId) return `asset:${o.assetId}`;
    if (o.mac) {
      const owners = assetByMac.all(o.mac) as { assetId: string }[];
      return owners.length === 1 ? `asset:${owners[0]!.assetId}` : `mac:${o.mac}`;
    }
    return null;
  };
  const groups = new Map<string, ObservationView[]>();
  for (const o of obs) {
    const key = `${o.networkId}|${o.ip}`;
    groups.set(key, [...(groups.get(key) ?? []), o]);
  }
  const ifaceOwner = db.prepare('SELECT asset_id AS assetId, mac FROM interfaces WHERE id = ?');
  const items = [...groups.entries()].map(([key, list]) => {
    const [networkId, ipText] = key.split('|') as [string, string];
    const identities = [...new Set(list.map(identity).filter((x): x is string => x !== null))];
    const slot = slotByIp(db, networkId, parseIp(ipText));
    const occupied = slot && slot.interfaceId ? (ifaceOwner.get(slot.interfaceId) as { assetId: string; mac: string | null }) : null;
    let judgment: Judgment;
    if (identities.length >= 2) judgment = 'suspected_conflict';
    else if (identities.length === 0 || !occupied) judgment = 'unknown';
    else {
      const id = identities[0]!;
      const expected = [`asset:${occupied.assetId}`, occupied.mac ? `mac:${occupied.mac}` : null];
      judgment = expected.includes(id) ? 'matching' : 'mismatching';
    }
    return {
      networkId, ip: ipText, judgment, identities,
      assignedAssetId: occupied?.assetId ?? null, slotState: slot?.state ?? 'unassigned',
      observations: list.map((o) => ({ id: o.id, mac: o.mac, assetId: o.assetId, observedAt: o.observedAt, recordedAt: o.recordedAt, source: o.source })),
    };
  });
  return { session, comparedRevision: revision, items };
}

export function listObservationSessions(db: Db) {
  return db
    .prepare(
      `SELECT s.id, s.label, s.window_start AS windowStart, s.window_end AS windowEnd, s.source, s.import_run_id AS importRunId, s.created_at AS createdAt,
         (SELECT COUNT(*) FROM observations o WHERE o.session_id = s.id) AS observationCount
       FROM observation_sessions s ORDER BY s.window_start DESC`,
    )
    .all();
}
