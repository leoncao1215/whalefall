/**
 * 一次"做梦"的完整流程：归档会话 → 日摘要 → 周摘要 → 月摘要 → 年摘要。
 *
 * 层级是自底向上的：
 *   事件 → 日（按来源）→ 日（合并）→ 周（按来源）→ 周（合并）→ 月 …
 * 合并视图读的是同层各来源的摘要，不会把原文再读一遍。
 */
import { planRollup, runRollup, distinctEventSources } from './rollup.mjs';
import { planSummaryRollup, runSummaryRollup } from './hierarchy.mjs';

export const DEFAULT_LEVELS = ['day', 'week', 'month', 'year'];

const CHILD = { week: 'day', month: 'week', year: 'month' };

/**
 * 只跑摘要部分（不碰会话日志），方便测试与手动补摘。
 * @param {object} opts
 * @param {string[]} [opts.levels]
 * @param {(ctx: object) => Promise<{text: string, model?: string}>} opts.summarize
 */
export async function runDreamSummaries(db, opts) {
  const { summarize, tz, promptVersion = 'v1' } = opts;
  const from = Number(opts.from);
  const to = Number(opts.to);
  const levels = opts.levels?.length ? opts.levels : DEFAULT_LEVELS;
  const log = opts.log ?? (() => {});
  const sources = distinctEventSources(db, { from, to });

  const result = { levels: [], done: 0, failed: 0 };

  for (const level of levels) {
    // 1) 各来源：日级从事件，其它层从下一层摘要
    for (const source of sources) {
      const plan = level === 'day'
        ? planRollup(db, { level, tz, from, to, promptVersion, source })
        : planSummaryRollup(db, { level, tz, from, to, promptVersion, source });
      if (!plan.length) continue;
      const { ok, failed } = level === 'day'
        ? await runRollup(db, plan, summarize, { tz, promptVersion })
        : await runSummaryRollup(db, plan, summarize, { tz, promptVersion });
      result.done += ok.length;
      result.failed += failed.length;
      result.levels.push({ level, source, ok: ok.length, failed: failed.length });
      log(`${level}/${source}: 完成 ${ok.length}，失败 ${failed.length}`);
    }

    // 2) 合并视图：从各来源同层摘要聚合
    const allPlan = planSummaryRollup(db, {
      level, source: 'all', childLevel: level, childSource: null, tz, from, to, promptVersion,
    });
    if (allPlan.length) {
      const { ok, failed } = await runSummaryRollup(db, allPlan, summarize, { tz, promptVersion });
      result.done += ok.length;
      result.failed += failed.length;
      result.levels.push({ level, source: 'all', ok: ok.length, failed: failed.length });
      log(`${level}/all: 完成 ${ok.length}，失败 ${failed.length}`);
    }
  }

  return result;
}

export { CHILD };
