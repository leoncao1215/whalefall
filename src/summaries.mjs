/**
 * 摘要层：同一 (level, bucket, prompt_version) 唯一。
 *
 * 换 prompt 就是换一版；旧版保留而不是覆盖，因为"今年该记住什么"这个问题
 * 本身会演化，你要能对比两版摘要的差异，而不是被悄悄改掉。
 */
import crypto from 'node:crypto';
import { assertLevel, bucketOf, DEFAULT_TZ } from './time.mjs';

export function upsertSummary(db, input) {
  const level = assertLevel(input.level);
  const tz = input.tz || DEFAULT_TZ;
  const bucket = input.bucket
    ? { start: Number(input.bucket.start), end: Number(input.bucket.end) }
    : bucketOf(Number(input.ts), level, tz);
  const promptVersion = String(input.promptVersion ?? 'v1');
  const now = Date.now();
  const text = String(input.text ?? '');
  const status = String(input.status ?? 'ready');
  const model = input.model ? String(input.model) : null;
  const sourceCount = Number(input.sourceCount ?? 0);
  const coveredUntil = Number(input.coveredUntil ?? 0);

  const existing = db
    .prepare('SELECT id FROM summaries WHERE level = ? AND bucket_start = ? AND prompt_version = ?')
    .get(level, bucket.start, promptVersion);

  if (existing) {
    db.prepare(
      `UPDATE summaries
          SET bucket_end = ?, tz = ?, text = ?, status = ?, model = ?,
              source_count = ?, covered_until = ?, updated_at = ?
        WHERE id = ?`,
    ).run(bucket.end, tz, text, status, model, sourceCount, coveredUntil, now, existing.id);
    return getSummary(db, Number(existing.id));
  }

  const result = db.prepare(
    `INSERT INTO summaries
       (uid, level, bucket_start, bucket_end, tz, text, status, prompt_version,
        model, source_count, covered_until, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    crypto.randomUUID(), level, bucket.start, bucket.end, tz, text, status,
    promptVersion, model, sourceCount, coveredUntil, now, now,
  );
  return getSummary(db, Number(result.lastInsertRowid));
}

export function getSummary(db, id) {
  const row = db.prepare('SELECT * FROM summaries WHERE id = ?').get(Number(id));
  return row ? hydrateSummary(row) : null;
}

export function hydrateSummary(row) {
  return {
    id: Number(row.id),
    uid: row.uid,
    level: row.level,
    bucketStart: Number(row.bucket_start),
    bucketEnd: Number(row.bucket_end),
    tz: row.tz,
    text: row.text,
    status: row.status,
    promptVersion: row.prompt_version,
    model: row.model,
    sourceCount: Number(row.source_count),
    coveredUntil: Number(row.covered_until ?? 0),
    createdAt: Number(row.created_at),
    updatedAt: Number(row.updated_at),
  };
}

export function listSummaries(db, { level, from, to, promptVersion, status, limit = 100 } = {}) {
  const where = [];
  const params = [];
  if (level) {
    where.push('level = ?');
    params.push(assertLevel(level));
  }
  if (from != null) {
    where.push('bucket_start >= ?');
    params.push(Number(from));
  }
  if (to != null) {
    where.push('bucket_start < ?');
    params.push(Number(to));
  }
  if (promptVersion) {
    where.push('prompt_version = ?');
    params.push(String(promptVersion));
  }
  if (status) {
    where.push('status = ?');
    params.push(String(status));
  }
  const sql = `SELECT * FROM summaries
               ${where.length ? `WHERE ${where.join(' AND ')}` : ''}
               ORDER BY bucket_start DESC LIMIT ?`;
  params.push(Math.max(1, Math.min(5000, limit)));
  return db.prepare(sql).all(...params).map(hydrateSummary);
}

/** 某个时刻所在层级的摘要（用于"停在哪一层"的导航）。 */
export function summaryAt(db, ts, level, { promptVersion, tz = DEFAULT_TZ } = {}) {
  const bucket = bucketOf(Number(ts), level, tz);
  const row = promptVersion
    ? db.prepare("SELECT * FROM summaries WHERE level = ? AND bucket_start = ? AND prompt_version = ? AND status = 'ready'")
      .get(level, bucket.start, promptVersion)
    : db.prepare("SELECT * FROM summaries WHERE level = ? AND bucket_start = ? AND status = 'ready' ORDER BY updated_at DESC LIMIT 1")
      .get(level, bucket.start);
  return row ? hydrateSummary(row) : null;
}
