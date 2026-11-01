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
  // source 为空 = 合并视图（'all'）；否则只统计这个来源的事件
  const source = opts.source && opts.source !== 'all' ? String(opts.source) : null;
  const scope = source ?? 'all';

  const rows = source
    ? db.prepare('SELECT id, ts FROM events WHERE ts >= ? AND ts < ? AND source = ? ORDER BY ts ASC').all(from, to, source)
    : db.prepare('SELECT id, ts FROM events WHERE ts >= ? AND ts < ? ORDER BY ts ASC').all(from, to);

  const buckets = new Map();
  for (const row of rows) {
    const b = bucketOf(Number(row.ts), level, tz);
    let bucket = buckets.get(b.start);
    if (!bucket) {
      bucket = { level, start: b.start, end: b.end, key: b.key, count: 0, eventIds: [], maxId: 0, source: scope };
      buckets.set(b.start, bucket);
    }
    bucket.count += 1;
    bucket.maxId = Math.max(bucket.maxId, Number(row.id));
    if (bucket.eventIds.length < maxEventIds) bucket.eventIds.push(Number(row.id));
  }

  // 已摘过的桶，只有在"覆盖到的事件 id >= 桶里最新事件 id"时才算完成；
  // 否则说明又归档了新对话，需要重摘。
  const covered = new Map(
    db
      .prepare(
        `SELECT bucket_start, covered_until FROM summaries
          WHERE level = ? AND prompt_version = ? AND source = ? AND status = 'ready'
            AND bucket_start >= ? AND bucket_start < ?`,
      )
      .all(level, promptVersion, scope, from, to)
      .map((r) => [Number(r.bucket_start), Number(r.covered_until ?? 0)]),
  );

  return [...buckets.values()]
    .filter((b) => (covered.get(b.start) ?? -1) < b.maxId)
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
    source: bucket.source ?? 'all',
    model: result?.model ?? opts.model,
    sourceCount: events.length,
    coveredUntil: Math.max(0, ...events.map((e) => Number(e.id) || 0)),
  });
}

/** 一段时间里出现过的来源（用于"每个来源各摘一份"）。 */
export function distinctEventSources(db, { from, to }) {
  return db
    .prepare('SELECT DISTINCT source FROM events WHERE ts >= ? AND ts < ? ORDER BY source')
    .all(Number(from), Number(to))
    .map((r) => r.source);
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
