/**
 * 时间与日历边界。
 *
 * 记忆里的"每天/每周"是**用户所在时区的日历日**，不是 UTC 日。
 * 所以所有分桶都走 Intl 拿到该时区的墙上时间，再换算回绝对时间戳。
 */

export const DEFAULT_TZ = process.env.WHALEFALL_TZ || 'Asia/Shanghai';

const WEEKDAYS = {
  Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6, Sun: 7,
};

const formatters = new Map();

function formatter(tz) {
  let f = formatters.get(tz);
  if (!f) {
    f = new Intl.DateTimeFormat('en-US', {
      timeZone: tz,
      hourCycle: 'h23',
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
      second: '2-digit',
      weekday: 'short',
    });
    formatters.set(tz, f);
  }
  return f;
}

/** 某个绝对时间在指定时区里的墙上时间。 */
export function wallParts(ts, tz = DEFAULT_TZ) {
  const parts = formatter(tz).formatToParts(new Date(ts));
  const raw = {};
  for (const p of parts) {
    if (p.type !== 'literal') raw[p.type] = p.value;
  }
  return {
    year: Number(raw.year),
    month: Number(raw.month),
    day: Number(raw.day),
    hour: Number(raw.hour) % 24,
    minute: Number(raw.minute),
    second: Number(raw.second),
    weekday: WEEKDAYS[raw.weekday] ?? 1,
  };
}

/** 该时刻的时区偏移（毫秒，东八区为 +8h）。 */
export function zoneOffsetMs(ts, tz = DEFAULT_TZ) {
  const p = wallParts(ts, tz);
  const wall = Date.UTC(p.year, p.month - 1, p.day, p.hour, p.minute, p.second);
  const truncated = ts - (((ts % 1000) + 1000) % 1000);
  return wall - truncated;
}

/**
 * 把某时区的墙上时间换算成绝对时间戳。
 * 迭代三次收敛，能正确处理夏令时切换附近的歧义。
 */
export function zonedEpoch(year, month, day, hour = 0, minute = 0, second = 0, tz = DEFAULT_TZ) {
  const target = Date.UTC(year, month - 1, day, hour, minute, second);
  let guess = target;
  for (let i = 0; i < 3; i += 1) {
    const next = target - zoneOffsetMs(guess, tz);
    if (next === guess) break;
    guess = next;
  }
  return guess;
}

const LEVELS = new Set(['day', 'week', 'month', 'year']);

export function assertLevel(level) {
  if (!LEVELS.has(level)) {
    throw new Error(`未知的层级：${level}（可选 ${[...LEVELS].join('/')}）`);
  }
  return level;
}

function pad2(n) {
  return String(n).padStart(2, '0');
}

/** ISO 8601 周号（周一起算）。 */
export function isoWeek(year, month, day) {
  const d = new Date(Date.UTC(year, month - 1, day));
  const dayNum = (d.getUTCDay() + 6) % 7; // 周一=0
  d.setUTCDate(d.getUTCDate() - dayNum + 3); // 到本周周四
  const isoYear = d.getUTCFullYear();
  const firstThursday = new Date(Date.UTC(isoYear, 0, 4));
  const firstDayNum = (firstThursday.getUTCDay() + 6) % 7;
  firstThursday.setUTCDate(firstThursday.getUTCDate() - firstDayNum + 3);
  const week = 1 + Math.round((d - firstThursday) / (7 * 86400000));
  return { year: isoYear, week };
}

/** 日历上加天数（按墙上日历，避免 DST 的 23/25 小时日）。 */
function addDays(year, month, day, delta) {
  const d = new Date(Date.UTC(year, month - 1, day + delta));
  return { year: d.getUTCFullYear(), month: d.getUTCMonth() + 1, day: d.getUTCDate() };
}

/** 某个时间戳所在桶的起点（绝对时间戳）。 */
export function startOf(ts, level, tz = DEFAULT_TZ) {
  assertLevel(level);
  const p = wallParts(ts, tz);
  if (level === 'day') {
    return zonedEpoch(p.year, p.month, p.day, 0, 0, 0, tz);
  }
  if (level === 'week') {
    const monday = addDays(p.year, p.month, p.day, -(p.weekday - 1));
    return zonedEpoch(monday.year, monday.month, monday.day, 0, 0, 0, tz);
  }
  if (level === 'month') {
    return zonedEpoch(p.year, p.month, 1, 0, 0, 0, tz);
  }
  return zonedEpoch(p.year, 1, 1, 0, 0, 0, tz);
}

/** 桶的结束点（下一个桶的起点，左闭右开）。 */
export function endOf(startTs, level, tz = DEFAULT_TZ) {
  assertLevel(level);
  const p = wallParts(startTs, tz);
  if (level === 'day') {
    const d = addDays(p.year, p.month, p.day, 1);
    return zonedEpoch(d.year, d.month, d.day, 0, 0, 0, tz);
  }
  if (level === 'week') {
    const d = addDays(p.year, p.month, p.day, 7);
    return zonedEpoch(d.year, d.month, d.day, 0, 0, 0, tz);
  }
  if (level === 'month') {
    const y = p.month === 12 ? p.year + 1 : p.year;
    const m = p.month === 12 ? 1 : p.month + 1;
    return zonedEpoch(y, m, 1, 0, 0, 0, tz);
  }
  return zonedEpoch(p.year + 1, 1, 1, 0, 0, 0, tz);
}

export function bucketKey(startTs, level, tz = DEFAULT_TZ) {
  const p = wallParts(startTs, tz);
  if (level === 'day') return `${p.year}-${pad2(p.month)}-${pad2(p.day)}`;
  if (level === 'month') return `${p.year}-${pad2(p.month)}`;
  if (level === 'year') return String(p.year);
  const { year, week } = isoWeek(p.year, p.month, p.day);
  return `${year}-W${String(week).padStart(2, '0')}`;
}

/** 时间戳落在哪个桶：{level, start, end, key, label} */
export function bucketOf(ts, level, tz = DEFAULT_TZ) {
  const start = startOf(ts, level, tz);
  return {
    level,
    start,
    end: endOf(start, level, tz),
    key: bucketKey(start, level, tz),
    label: bucketKey(start, level, tz),
  };
}

/** 中文可读：2026-11-01 13:29 */
export function formatLocal(ts, tz = DEFAULT_TZ) {
  const p = wallParts(ts, tz);
  return `${p.year}-${pad2(p.month)}-${pad2(p.day)} ${pad2(p.hour)}:${pad2(p.minute)}`;
}

/** 解析 'YYYY-MM-DD' / 'YYYY-MM-DD HH:mm' / ISO / 纯数字时间戳。 */
export function parseTime(input, tz = DEFAULT_TZ) {
  if (input == null || input === '') return null;
  if (typeof input === 'number' && Number.isFinite(input)) return input;
  const s = String(input).trim();
  if (/^\d{10,}$/.test(s)) return Number(s);
  const m = s.match(/^(\d{4})-(\d{2})-(\d{2})(?:[ T](\d{2}):(\d{2})(?::(\d{2}))?)?$/);
  if (m) {
    return zonedEpoch(
      Number(m[1]), Number(m[2]), Number(m[3]),
      Number(m[4] ?? 0), Number(m[5] ?? 0), Number(m[6] ?? 0), tz,
    );
  }
  const parsed = Date.parse(s);
  if (Number.isFinite(parsed)) return parsed;
  throw new Error(`无法解析时间：${input}`);
}
