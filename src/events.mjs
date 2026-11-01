/**
 * 事件写入：规范化、脱敏、去重、实体关联。
 *
 * event 一旦写入就不再修改；"我改主意了"应该是一条新 event，
 * 用 refs 指回被修正的那条（这是后面做事实失效的基础）。
 */
import crypto from 'node:crypto';
import { redactSecrets } from './redact.mjs';
import { DEFAULT_TZ, parseTime } from './time.mjs';

const DEFAULT_SOURCE = 'manual';
const DEFAULT_KIND = 'note';

function asArray(value) {
  if (value == null || value === '') return [];
  if (Array.isArray(value)) return value;
  return [value];
}

function normalizeActors(value) {
  return asArray(value)
    .map((a) => (typeof a === 'string' ? a.trim() : String(a?.name ?? '').trim()))
    .filter(Boolean);
}

function normalizeRefs(value) {
  return asArray(value)
    .map((r) => (typeof r === 'string' ? { type: 'event', id: r } : r))
    .filter((r) => r && typeof r === 'object' && r.id != null)
    .map((r) => ({ type: String(r.type ?? 'event'), id: String(r.id) }));
}

function canonicalHash(payload) {
  return crypto.createHash('sha256').update(JSON.stringify(payload)).digest('hex');
}

/** 和 addEvent 用 dedupeKey 时算出来的哈希一致（verify 对账要用）。 */
export function dedupeHash(key) {
  return canonicalHash({ dedupeKey: String(key) });
}

/**
 * 写入一条事件。
 *
 * @param {import('node:sqlite').DatabaseSync} db
 * @param {object} input
 * @param {string} [input.title]
 * @param {string} [input.body]
 * @param {number|string} [input.ts] 默认 now
 * @param {string} [input.tz]
 * @param {string} [input.source]
 * @param {string} [input.kind]
 * @param {string[]|string} [input.actors]
 * @param {Array<{type:string,id:string}>|string[]} [input.refs]
 * @param {string} [input.dedupeKey] 显式指定后，相同 key 视为同一条
 */
export function addEvent(db, input = {}) {
  const now = Date.now();
  const ts = input.ts == null ? now : parseTime(input.ts, input.tz || DEFAULT_TZ);
  const tz = input.tz || DEFAULT_TZ;
  const source = String(input.source ?? DEFAULT_SOURCE).trim() || DEFAULT_SOURCE;
  const kind = String(input.kind ?? DEFAULT_KIND).trim() || DEFAULT_KIND;
  const title = String(input.title ?? '').trim();
  const actors = normalizeActors(input.actors);
  const refs = normalizeRefs(input.refs);
  const sessionId = input.sessionId ? String(input.sessionId) : null;

  const rawBody = String(input.body ?? input.text ?? '');
  const { text: body, hits } = redactSecrets(rawBody);

  const hash = input.dedupeKey
    ? canonicalHash({ dedupeKey: String(input.dedupeKey) })
    : canonicalHash({ source, kind, ts, title, body, actors, sessionId });

  const existing = db.prepare('SELECT id, uid FROM events WHERE hash = ?').get(hash);
  if (existing) {
    return { id: Number(existing.id), uid: String(existing.uid), deduplicated: true, redacted: hits };
  }

  const uid = crypto.randomUUID();
  const result = db
    .prepare(
      `INSERT INTO events (uid, ts, tz, source, kind, title, body, actors, refs, session_id, hash, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .run(
      uid, ts, tz, source, kind, title, body,
      JSON.stringify(actors), JSON.stringify(refs), sessionId, hash, now,
    );

  const id = Number(result.lastInsertRowid);
  for (const name of actors) {
    const entityId = ensureEntity(db, name, { kind: 'person' });
    linkEntity(db, id, entityId, 'actor');
  }
  for (const extra of asArray(input.entities)) {
    const name = typeof extra === 'string' ? extra : extra?.name;
    if (!name) continue;
    const entityId = ensureEntity(db, String(name), { kind: String(extra?.kind ?? 'thing') });
    linkEntity(db, id, entityId, String(extra?.role ?? ''));
  }

  return { id, uid, deduplicated: false, redacted: hits };
}

/** 按 uid 或数字 id 取事件。 */
export function getEvent(db, idOrUid) {
  const key = String(idOrUid);
  const row = /^\d+$/.test(key)
    ? db.prepare('SELECT * FROM events WHERE id = ?').get(Number(key))
    : db.prepare('SELECT * FROM events WHERE uid = ?').get(key);
  return row ? hydrate(row) : null;
}

export function hydrate(row) {
  let actors = [];
  let refs = [];
  try { actors = JSON.parse(row.actors ?? '[]'); } catch { /* 坏数据按空处理 */ }
  try { refs = JSON.parse(row.refs ?? '[]'); } catch { /* 同上 */ }
  return {
    id: Number(row.id),
    uid: row.uid,
    ts: Number(row.ts),
    tz: row.tz,
    source: row.source,
    kind: row.kind,
    title: row.title,
    body: row.body,
    actors,
    refs,
    sessionId: row.session_id,
    hash: row.hash,
    createdAt: Number(row.created_at),
  };
}

/** 实体：按 (name, kind) 唯一，别名合并。 */
export function ensureEntity(db, name, { kind = 'thing', aliases = [] } = {}) {
  const clean = String(name ?? '').trim();
  if (!clean) throw new Error('实体名不能为空');
  const row = db.prepare('SELECT id, aliases FROM entities WHERE name = ? AND kind = ?').get(clean, kind);
  if (row) {
    if (aliases.length) {
      const merged = new Set(JSON.parse(row.aliases ?? '[]'));
      for (const a of aliases) merged.add(String(a));
      db.prepare('UPDATE entities SET aliases = ? WHERE id = ?').run(JSON.stringify([...merged]), row.id);
    }
    return Number(row.id);
  }
  const result = db
    .prepare('INSERT INTO entities (uid, name, kind, aliases, created_at) VALUES (?, ?, ?, ?, ?)')
    .run(crypto.randomUUID(), clean, kind, JSON.stringify(aliases.map(String)), Date.now());
  return Number(result.lastInsertRowid);
}

export function linkEntity(db, eventId, entityId, role = '') {
  db.prepare('INSERT OR IGNORE INTO event_entities (event_id, entity_id, role) VALUES (?, ?, ?)')
    .run(eventId, entityId, role);
}

export function findEntity(db, nameOrUid) {
  const key = String(nameOrUid);
  const row =
    db.prepare('SELECT * FROM entities WHERE uid = ?').get(key) ??
    db.prepare('SELECT * FROM entities WHERE name = ? ORDER BY id LIMIT 1').get(key);
  if (!row) return null;
  return { id: Number(row.id), uid: row.uid, name: row.name, kind: row.kind, aliases: JSON.parse(row.aliases ?? '[]') };
}
