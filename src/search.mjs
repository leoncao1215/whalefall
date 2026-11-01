/**
 * 检索层：时间 ∧ 实体 ∧ 文本。
 *
 * 为什么不用纯向量：这一版要的是**可解释、可评测、零依赖**。
 * 中文用 FTS5 trigram，>=3 字直接命中；1~2 字（"火锅"）trigram 建不出索引，
 * 退化成 LIKE。数据量到十万级再引入向量，接口不变。
 */
import { hydrate } from './events.mjs';

function ftsPhrase(term) {
  return `"${term.replace(/"/g, '""')}"`;
}

/**
 * 把用户输入转成 FTS5 查询：按空白拆词，每个词做短语匹配，词间 AND。
 * 任一 token 短于 3 字就整体退化为 LIKE —— trigram 对 <3 字无法建索引。
 */
export function buildFtsQuery(text) {
  const tokens = String(text ?? '').trim().split(/\s+/).filter(Boolean);
  if (!tokens.length) return null;
  if (tokens.some((t) => t.length < 3)) return null;
  return tokens.map(ftsPhrase).join(' AND ');
}

/**
 * @param {import('node:sqlite').DatabaseSync} db
 * @param {object} opts
 * @param {string} [opts.q]
 * @param {number} [opts.from] 含
 * @param {number} [opts.to] 不含
 * @param {string} [opts.entity] 实体 name 或 uid
 * @param {string} [opts.source]
 * @param {string} [opts.kind]
 * @param {number} [opts.limit]
 * @param {number} [opts.offset]
 * @param {'relevance'|'time'} [opts.order]
 */
export function searchEvents(db, opts = {}) {
  const limit = Math.max(1, Math.min(200, Number(opts.limit) || 20));
  const offset = Math.max(0, Number(opts.offset) || 0);
  const text = String(opts.q ?? '').trim();
  const fts = buildFtsQuery(text);

  const where = [];
  const params = [];
  let sql = 'SELECT e.* FROM events e';

  if (fts) {
    sql += ' JOIN events_fts f ON f.rowid = e.id';
    where.push('events_fts MATCH ?');
    params.push(fts);
  } else if (text) {
    for (const token of text.split(/\s+/).filter(Boolean)) {
      where.push('(e.title LIKE ? OR e.body LIKE ?)');
      params.push(`%${token}%`, `%${token}%`);
    }
  }

  if (opts.from != null) {
    where.push('e.ts >= ?');
    params.push(Number(opts.from));
  }
  if (opts.to != null) {
    where.push('e.ts < ?');
    params.push(Number(opts.to));
  }
  if (opts.source) {
    where.push('e.source = ?');
    params.push(String(opts.source));
  }
  if (opts.kind) {
    where.push('e.kind = ?');
    params.push(String(opts.kind));
  }
  if (opts.entity) {
    where.push(
      `EXISTS (SELECT 1 FROM event_entities ee JOIN entities en ON en.id = ee.entity_id
               WHERE ee.event_id = e.id AND (en.name = ? OR en.uid = ?))`,
    );
    params.push(String(opts.entity), String(opts.entity));
  }

  if (where.length) sql += ` WHERE ${where.join(' AND ')}`;

  const byRelevance = Boolean(fts) && opts.order !== 'time';
  sql += byRelevance ? ' ORDER BY rank' : ' ORDER BY e.ts DESC';
  sql += ' LIMIT ? OFFSET ?';
  params.push(limit, offset);

  const rows = db.prepare(sql).all(...params);
  return rows.map(hydrate);
}

/** 时间线：一个区间内的原文，按时间正序。 */
export function timeline(db, { start, end, limit = 200 } = {}) {
  const rows = db
    .prepare('SELECT * FROM events WHERE ts >= ? AND ts < ? ORDER BY ts ASC LIMIT ?')
    .all(Number(start), Number(end), Math.max(1, Math.min(5000, limit)));
  return rows.map(hydrate);
}

/** 一段时间的统计，给 CLI / 诊断用。 */
export function stats(db) {
  const total = db.prepare('SELECT COUNT(*) AS n FROM events').get().n;
  const entities = db.prepare('SELECT COUNT(*) AS n FROM entities').get().n;
  const summaries = db.prepare('SELECT COUNT(*) AS n FROM summaries').get().n;
  const range = db.prepare('SELECT MIN(ts) AS min, MAX(ts) AS max FROM events').get();
  const bySource = db.prepare('SELECT source, COUNT(*) AS n FROM events GROUP BY source ORDER BY n DESC').all();
  const byKind = db.prepare('SELECT kind, COUNT(*) AS n FROM events GROUP BY kind ORDER BY n DESC').all();
  const byLevel = db.prepare('SELECT level, COUNT(*) AS n FROM summaries GROUP BY level').all();
  return {
    events: Number(total),
    entities: Number(entities),
    summaries: Number(summaries),
    firstTs: range?.min == null ? null : Number(range.min),
    lastTs: range?.max == null ? null : Number(range.max),
    bySource: bySource.map((r) => ({ source: r.source, count: Number(r.n) })),
    byKind: byKind.map((r) => ({ kind: r.kind, count: Number(r.n) })),
    byLevel: byLevel.map((r) => ({ level: r.level, count: Number(r.n) })),
  };
}
