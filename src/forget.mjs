/**
 * 删除与派生层失效。
 *
 * 记忆系统的"删除"必须是真的删除：用户让你忘掉的东西，不能只是从查询里藏起来。
 * 但摘要层是派生的——删掉原文后，覆盖那个时间点的摘要已经失真，必须标脏而不是留着。
 */
import { getEvent } from './events.mjs';

const LEVELS = ['day', 'week', 'month', 'year'];

/**
 * @param {import('node:sqlite').DatabaseSync} db
 * @param {number|string} idOrUid
 * @returns {{deleted: boolean, id?: number, staleSummaries?: number, reason?: string}}
 */
export function forgetEvent(db, idOrUid, { now = Date.now() } = {}) {
  const event = getEvent(db, idOrUid);
  if (!event) return { deleted: false, reason: 'not-found' };

  let staleSummaries = 0;
  db.exec('BEGIN IMMEDIATE');
  try {
    for (const level of LEVELS) {
      const result = db
        .prepare(
          `UPDATE summaries
              SET status = 'stale', updated_at = ?
            WHERE level = ? AND bucket_start <= ? AND bucket_end > ? AND status = 'ready'`,
        )
        .run(now, level, event.ts, event.ts);
      staleSummaries += Number(result.changes);
    }
    db.prepare('DELETE FROM events WHERE id = ?').run(event.id);
    db.exec('COMMIT');
  } catch (error) {
    db.exec('ROLLBACK');
    throw error;
  }

  return { deleted: true, id: event.id, staleSummaries };
}
