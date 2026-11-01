/**
 * 层级摘要（自底向上）：上层不是重读原文，而是读下层的摘要。
 *
 * 日 ← 事件；周 ← 日；月 ← 周；年 ← 月。
 * 好处有两个：越远的记忆越便宜（读的是几百字的摘要，不是几万字的原文），
 * 以及更接近人的回忆方式——先想起"那个月大概在忙什么"，再往下钻到某一天。
 *
 * 'all' 视图也走这条线：合并摘要读的是各来源**同一层级**的摘要，
 * 而不是把原文再读一遍。
 */
import { bucketOf, startOf } from './time.mjs';
import { upsertSummary } from './summaries.mjs';

export const CHILD_LEVEL = { week: 'day', month: 'week', year: 'month' };

/**
 * 规划一层摘要：按父桶聚合子摘要，父桶的 covered_until 用"子摘要最大 updated_at"，
 * 子摘要一更新，父摘要就变脏，下次会重摘。
 *
 * @param {object} opts
 * @param {'week'|'month'|'year'} opts.level
 * @param {'all'|string} [opts.source]
 * @param {number} opts.from
 * @param {number} opts.to
 */
export function planSummaryRollup(db, opts = {}) {
  const level = opts.level;
  const source = String(opts.source ?? 'all');
  // 合并视图（all）的父层读的是"同层各来源"的摘要；单来源读的是"下一层"的摘要。
  const childLevel = opts.childLevel ?? (source === 'all' ? level : CHILD_LEVEL[level]);
  if (!childLevel) throw new Error(`不能从更细的层级聚合出 ${level}`);
  const childSource = opts.childSource !== undefined
    ? opts.childSource
    : (source === 'all' ? null : source);
  const tz = opts.tz;
  const promptVersion = String(opts.promptVersion ?? 'v1');
  const from = Number(opts.from);
  const to = Number(opts.to);

  // 子桶的起点也可能早于 from（11-02 起的一周从 10-26 开始），
  // 所以窗口要对齐到**父层**桶的边界：父桶是这一周，就要把这一周里的天全捞进来。
  const childFrom = startOf(from, level, tz);
  const children = childSource
    ? db
      .prepare(
        `SELECT * FROM summaries
          WHERE level = ? AND source = ? AND status = 'ready'
            AND bucket_start >= ? AND bucket_start < ?
          ORDER BY bucket_start ASC`,
      )
      .all(childLevel, childSource, childFrom, to)
    : db
      .prepare(
        `SELECT * FROM summaries
          WHERE level = ? AND source != 'all' AND status = 'ready'
            AND bucket_start >= ? AND bucket_start < ?
          ORDER BY bucket_start ASC`,
      )
      .all(childLevel, childFrom, to);

  const groups = new Map();
  for (const child of children) {
    const b = bucketOf(Number(child.bucket_start), level, tz);
    let group = groups.get(b.start);
    if (!group) {
      group = {
        level, start: b.start, end: b.end, key: b.key, source,
        children: [], maxUpdated: 0,
      };
      groups.set(b.start, group);
    }
    group.children.push(child);
    group.maxUpdated = Math.max(group.maxUpdated, Number(child.updated_at));
  }

  // 父桶的起点可能早于 from（比如 11-02 起的一周属于 11 月），
  // 所以查已有父摘要时要把窗口对齐到父层桶的边界，否则会误判成"还没摘过"。
  const parentFrom = startOf(from, level, tz);
  const parents = new Map(
    db
      .prepare(
        `SELECT bucket_start, covered_until FROM summaries
          WHERE level = ? AND source = ? AND prompt_version = ? AND status = 'ready'
            AND bucket_start >= ? AND bucket_start < ?`,
      )
      .all(level, source, promptVersion, parentFrom, to)
      .map((row) => [Number(row.bucket_start), Number(row.covered_until ?? 0)]),
  );

  return [...groups.values()]
    .filter((group) => (parents.get(group.start) ?? -1) < group.maxUpdated)
    .sort((a, b) => a.start - b.start);
}

/** 把子摘要当"事件"喂给摘要器：正文就是子摘要。 */
export function childrenAsEvents(bucket) {
  return bucket.children.map((child) => ({
    id: `summary:${child.id}`,
    ts: Number(child.bucket_start),
    kind: 'summary',
    title: `${child.level} ${child.bucket_key ?? ''}`.trim(),
    body: child.text,
    actors: [],
  }));
}

export async function applySummaryRollup(db, bucket, summarize, opts = {}) {
  const tz = opts.tz;
  const promptVersion = String(opts.promptVersion ?? 'v1');
  const events = childrenAsEvents(bucket);
  const result = await summarize({ level: bucket.level, bucket, events });
  const text = String(result?.text ?? '').trim();
  return upsertSummary(db, {
    level: bucket.level,
    bucket,
    tz,
    text,
    status: result?.status ?? (text ? 'ready' : 'empty'),
    promptVersion,
    source: bucket.source,
    model: result?.model,
    sourceCount: bucket.children.length,
    coveredUntil: bucket.maxUpdated,
  });
}

/** 依次跑一批规划好的桶，返回成功/失败。 */
export async function runSummaryRollup(db, plan, summarize, opts = {}) {
  const ok = [];
  const failed = [];
  for (const bucket of plan) {
    try {
      ok.push(await applySummaryRollup(db, bucket, summarize, opts));
    } catch (error) {
      failed.push({ bucket, error: String(error?.message ?? error) });
    }
  }
  return { ok, failed };
}
