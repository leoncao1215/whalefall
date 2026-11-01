/**
 * 主动机制：决定"这次要不要开口"。
 *
 * 定时器只是触发器，真正难的是闸门。顺序即优先级：
 *   关闭 → 安静时段 → 今日上限 → 最小间隔 → 用户正在聊 → 有没有值得说的事
 *
 * 默认结论是"不说"。主动做不好就是骚扰，宁可漏掉一次。
 */
import { DEFAULT_TZ, wallParts } from './time.mjs';

function parseClock(text) {
  const m = /^(\d{1,2}):(\d{2})$/.exec(String(text ?? '').trim());
  if (!m) return null;
  const h = Number(m[1]);
  const min = Number(m[2]);
  if (h < 0 || h > 23 || min < 0 || min > 59) return null;
  return h * 60 + min;
}

/** 安静时段的判断，支持跨午夜（如 23:30-08:00）。 */
export function inQuietHours(now, ranges = [], tz = DEFAULT_TZ) {
  const p = wallParts(now, tz);
  const minuteOfDay = p.hour * 60 + p.minute;
  for (const range of ranges) {
    const [startText, endText] = String(range).split('-');
    const start = parseClock(startText);
    const end = parseClock(endText);
    if (start == null || end == null) continue;
    if (start === end) continue;
    if (start < end) {
      if (minuteOfDay >= start && minuteOfDay < end) return true;
    } else if (minuteOfDay >= start || minuteOfDay < end) {
      return true;
    }
  }
  return false;
}

/** 某个时刻所在本地日里已经发了几条。 */
export function countSendsOnDay(history, now, tz = DEFAULT_TZ) {
  const day = wallParts(now, tz);
  return history.filter((item) => {
    const p = wallParts(Number(item.ts), tz);
    return p.year === day.year && p.month === day.month && p.day === day.day;
  }).length;
}

/**
 * @param {object} input
 * @param {number} input.now
 * @param {object} input.policy persona.policy.proactive
 * @param {Array<{ts:number}>} [input.history] 已发记录
 * @param {number} [input.lastUserMessageAt] 用户最后一次说话
 * @param {number} [input.userActiveWindowMs] 用户刚说过话的静默窗口，默认 10 分钟
 * @param {boolean} [input.hasSubstance] 这次有没有值得说的事
 * @param {string} [input.tz]
 * @returns {{ok: boolean, code: string, reason: string}}
 */
export function evaluateProactive(input) {
  const {
    now,
    policy = {},
    history = [],
    lastUserMessageAt = null,
    userActiveWindowMs = 10 * 60 * 1000,
    hasSubstance = true,
    tz = DEFAULT_TZ,
  } = input;

  if (!policy.enabled) return { ok: false, code: 'disabled', reason: '主动已关闭' };

  if (inQuietHours(now, policy.quietHours ?? [], tz)) {
    return { ok: false, code: 'quiet', reason: '处在安静时段' };
  }

  const dailyMax = Number(policy.dailyMax);
  if (Number.isFinite(dailyMax) && dailyMax >= 0) {
    const today = countSendsOnDay(history, now, tz);
    if (today >= dailyMax) {
      return { ok: false, code: 'daily-cap', reason: `今天已经主动 ${today} 次，达到上限 ${dailyMax}` };
    }
  }

  const minGap = Number(policy.minGapMinutes);
  if (Number.isFinite(minGap) && minGap > 0 && history.length) {
    const last = Math.max(...history.map((h) => Number(h.ts)));
    const gap = now - last;
    if (gap < minGap * 60 * 1000) {
      const left = Math.ceil((minGap * 60 * 1000 - gap) / 60000);
      return { ok: false, code: 'min-gap', reason: `距上次主动才 ${Math.round(gap / 60000)} 分钟，再等 ${left} 分钟` };
    }
  }

  if (lastUserMessageAt != null && now - Number(lastUserMessageAt) < userActiveWindowMs) {
    return { ok: false, code: 'user-active', reason: '用户刚说过话，不插嘴' };
  }

  if (!hasSubstance) return { ok: false, code: 'nothing-to-say', reason: '没有值得主动说的事' };

  return { ok: true, code: 'ok', reason: '可以开口' };
}

export function recordProactiveSend(db, { ts = Date.now(), kind = 'ping', text = '', meta = {} } = {}) {
  const result = db
    .prepare('INSERT INTO proactive_log (ts, kind, text, meta) VALUES (?, ?, ?, ?)')
    .run(Number(ts), String(kind), String(text), JSON.stringify(meta));
  return Number(result.lastInsertRowid);
}

/** 增量读取：id 大于 afterId 的主动记录（SSE 用）。 */
export function proactiveSince(db, afterId = 0, limit = 100) {
  return db
    .prepare('SELECT * FROM proactive_log WHERE id > ? ORDER BY id ASC LIMIT ?')
    .all(Number(afterId), Math.max(1, Math.min(500, Number(limit) || 100)))
    .map((r) => ({
      id: Number(r.id),
      ts: Number(r.ts),
      kind: r.kind,
      text: r.text,
      meta: (() => { try { return JSON.parse(r.meta ?? '{}'); } catch { return {}; } })(),
    }));
}

export function proactiveHistory(db, { since } = {}) {
  const rows = since
    ? db.prepare('SELECT * FROM proactive_log WHERE ts >= ? ORDER BY ts ASC').all(Number(since))
    : db.prepare('SELECT * FROM proactive_log ORDER BY ts ASC').all();
  return rows.map((r) => ({
    id: Number(r.id),
    ts: Number(r.ts),
    kind: r.kind,
    text: r.text,
    meta: (() => { try { return JSON.parse(r.meta ?? '{}'); } catch { return {}; } })(),
  }));
}
