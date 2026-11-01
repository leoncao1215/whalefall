/**
 * 对账与重建。
 *
 * verify：扫会话日志，算出每个 turn 应有的 dedupeKey，和 events 比对，
 *         告诉你"有哪些对话还没入库"。这是"没丢"的可验证证据。
 *
 * reindex：把派生数据（conversation 事件、摘要、采集游标）清掉，从会话重建。
 *          如果 SQLite 真的是"可重建的投影"，这一步之后应该和原来一致。
 */
import fs from 'node:fs';
import path from 'node:path';
import { dedupeHash } from './events.mjs';
import {
  findSessionFiles, readSessionFile, extractTurns, turnToEvent, harvestSessions, sessionSource,
} from './harvest.mjs';

function mtimeOf(file) {
  try { return fs.statSync(file).mtimeMs; } catch { return 0; }
}

/**
 * @param {object} opts
 * @param {string} opts.root 会话根目录
 * @param {number} [opts.since] 只看 mtime 不早于此的文件
 * @param {string[]} [opts.sources]
 * @returns {{files:number, turns:number, present:number, missing:Array, bySource:object}}
 */
export function verifyHarvest(db, { root, since = 0, sources = null } = {}) {
  const files = findSessionFiles(root).filter((file) => mtimeOf(file) >= since);
  const hashes = new Set(
    db.prepare("SELECT hash FROM events WHERE kind = 'conversation'").all().map((row) => row.hash),
  );

  const result = { files: 0, turns: 0, present: 0, missing: [], bySource: {} };

  for (const file of files) {
    let records;
    try { records = readSessionFile(file); } catch { continue; }
    const header = records.find((r) => r.type === 'session') ?? null;
    const sessionId = header?.id ?? path.basename(path.dirname(file));
    const source = sessionSource(header?.cwd);
    if (sources && !sources.includes(source)) continue;

    const turns = extractTurns(records, { createdAt: Number(header?.createdAt) || null });
    result.files += 1;
    result.bySource[source] = (result.bySource[source] ?? 0) + 1;

    for (const turn of turns) {
      const { body, title } = turnToEvent(turn);
      if (!body) continue;
      result.turns += 1;
      if (hashes.has(dedupeHash(`${sessionId}:turn:${turn.turn}`))) {
        result.present += 1;
      } else {
        result.missing.push({ sessionId, source, turn: turn.turn, title });
      }
    }
  }

  return result;
}

/**
 * 清掉派生数据并从会话重建。**会删除摘要**——它们是从事件派生的，事件重建后必须重算。
 * 手工记的 note 不受影响（只删 kind='conversation' 的事件）。
 */
export function rebuildFromSessions(db, { root, since = 0, sources = null, tz } = {}) {
  const before = {
    conversations: Number(db.prepare("SELECT COUNT(*) AS n FROM events WHERE kind = 'conversation'").get().n),
    summaries: Number(db.prepare('SELECT COUNT(*) AS n FROM summaries').get().n),
  };

  db.exec('BEGIN IMMEDIATE');
  try {
    db.prepare("DELETE FROM events WHERE kind = 'conversation'").run();
    db.prepare('DELETE FROM harvest_state').run();
    db.prepare('DELETE FROM summaries').run();
    db.exec('COMMIT');
  } catch (error) {
    db.exec('ROLLBACK');
    throw error;
  }

  const stats = harvestSessions(db, { root, since, sources, tz, incremental: false });
  return { before, after: { conversations: stats.added, files: stats.files }, stats };
}
