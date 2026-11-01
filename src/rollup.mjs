/**
 * rollup：把一堆原文压成一层摘要。
 *
 * 两个动作刻意分开：
 *   planRollup  只算"哪些桶还缺摘要"，不花钱、不调模型；
 *   applyRollup 才真的调 summarizer 写回。
 * 这样夜间批处理可以先 plan、再按预算逐个 apply，中途失败不影响已完成的部分。
 */
import { assertLevel, bucketOf, DEFAULT_TZ } from './time.mjs';
import { hydrate } from './events.mjs';
import { upsertSummary } from './summaries.mjs';

/**
 * @param {import('node:sqlite').DatabaseSync} db
 * @param {object} opts
 * @param {'day'|'week'|'month'|'year'} [opts.level]
 * @param {string} [opts.tz]
 * @param {number} opts.from
 * @param {number} opts.to 不含
 * @param {string} [opts.promptVersion]
 * @param {number} [opts.maxEventIds] 每个桶最多取多少条事件 id（防止大桶撑爆内存）
 */
export function planRollup(db, opts = {}) {
  const level = assertLevel(opts.level ?? 'day');
  const tz = opts.tz || DEFAULT_TZ;
  const from = Number(opts.from);
  const to = Number(opts.to);
  const promptVersion = String(opts.promptVersion ?? 'v1');
  const maxEventIds = Math.max(1, Number(opts.maxEventIds) || 500);

  const rows = db
    .prepare('SELECT id, ts FROM events WHERE ts >= ? AND ts < ? ORDER BY ts ASC')
    .all(from, to);

  const buckets = new Map();
  for (const row of rows) {
    const b = bucketOf(Number(row.ts), level, tz);
    let bucket = buckets.get(b.start);
    if (!bucket) {
      bucket = { level, start: b.start, end: b.end, key: b.key, count: 0, eventIds: [] };
      buckets.set(b.start, bucket);
    }
    bucket.count += 1;
    if (bucket.eventIds.length < maxEventIds) bucket.eventIds.push(Number(row.id));
  }

  const done = new Set(
    db
      .prepare(
        `SELECT bucket_start FROM summaries
          WHERE level = ? AND prompt_version = ? AND status = 'ready'
            AND bucket_start >= ? AND bucket_start < ?`,
      )
      .all(level, promptVersion, from, to)
      .map((r) => Number(r.bucket_start)),
  );

  return [...buckets.values()]
    .filter((b) => !done.has(b.start))
    .sort((a, b) => a.start - b.start);
}

/**
 * 对单个桶调用 summarizer 并写回。
 *
 * summarizer 契约：
 *   async ({ level, bucket, events }) => ({ text, model?, status? })
 * 事件里的 title/body 已经是脱敏后的文本。
 */
export async function applyRollup(db, bucket, summarize, opts = {}) {
  const promptVersion = String(opts.promptVersion ?? 'v1');
  const tz = opts.tz || DEFAULT_TZ;
  const events = bucket.eventIds
    .map((id) => db.prepare('SELECT * FROM events WHERE id = ?').get(id))
    .filter(Boolean)
    .map(hydrate);

  if (!events.length) {
    return upsertSummary(db, {
      level: bucket.level, bucket, tz, text: '', status: 'empty',
      promptVersion, sourceCount: 0,
    });
  }

  const result = await summarize({ level: bucket.level, bucket, events });
  const text = String(result?.text ?? '').trim();
  return upsertSummary(db, {
    level: bucket.level,
    bucket,
    tz,
    text,
    status: result?.status ?? (text ? 'ready' : 'empty'),
    promptVersion,
    model: result?.model ?? opts.model,
    sourceCount: events.length,
  });
}

/** 便利方法：plan 里的每个桶依次 apply，返回成功/失败。 */
export async function runRollup(db, plan, summarize, opts = {}) {
  const ok = [];
  const failed = [];
  for (const bucket of plan) {
    try {
      const summary = await applyRollup(db, bucket, summarize, opts);
      ok.push(summary);
    } catch (error) {
      failed.push({ bucket, error: String(error?.message ?? error) });
    }
  }
  return { ok, failed };
}
