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
  let droppedSummaries = 0;
  db.exec('BEGIN IMMEDIATE');
  try {
    db.prepare('DELETE FROM events WHERE id = ?').run(event.id);

    for (const level of LEVELS) {
      const rows = db
        .prepare(
          `SELECT id, bucket_start, bucket_end FROM summaries
            WHERE level = ? AND bucket_start <= ? AND bucket_end > ?`,
        )
        .all(level, event.ts, event.ts);

      for (const row of rows) {
        // 派生数据不能比源数据活得久：桶里一条事件都不剩，摘要就该消失。
        const left = db
          .prepare('SELECT COUNT(*) AS n FROM events WHERE ts >= ? AND ts < ?')
          .get(Number(row.bucket_start), Number(row.bucket_end)).n;
        if (Number(left) === 0) {
          db.prepare('DELETE FROM summaries WHERE id = ?').run(row.id);
          droppedSummaries += 1;
        } else if (db.prepare("UPDATE summaries SET status = 'stale', updated_at = ? WHERE id = ? AND status = 'ready'").run(now, row.id).changes > 0) {
          staleSummaries += 1;
        }
      }
    }
    db.exec('COMMIT');
  } catch (error) {
    db.exec('ROLLBACK');
    throw error;
  }

  return { deleted: true, id: event.id, staleSummaries, droppedSummaries };
}
