/**
 * 把自然语言问题翻译成检索计划。
 *
 * 这是评测暴露出来的真正瓶颈：检索本身没问题，问题是"不知道去哪找"。
 * 这一版先做不含模型的部分——时间词、停用词、多词召回、JS 重排；
 * 语义改写的缺口（"土特产"→"腊肠"）留给模型做查询扩展。
 */
import {
  DEFAULT_TZ, bucketOf, startOf, wallParts, zonedEpoch, addDaysTs,
} from './time.mjs';
import { searchEvents } from './search.mjs';
import { hydrate } from './events.mjs';

const WEEKDAY = { 一: 1, 二: 2, 三: 3, 四: 4, 五: 5, 六: 6, 日: 7, 天: 7 };

const STOPWORDS = [
  '我们', '你们', '他们', '这个', '那个', '这些', '那些', '什么', '怎么', '怎么样', '怎样',
  '哪个', '哪些', '哪里', '为什么', '觉得', '感觉', '记得', '说过', '时候', '那次', '上次',
  '之前', '以前', '最近', '今天', '昨天', '前天', '明天', '现在', '还有', '就是', '然后',
  '一下', '一个', '一点', '我', '你', '他', '她', '它', '的', '了', '着', '过', '是', '在',
  '有', '和', '跟', '与', '及', '吗', '呢', '吧', '啊', '呀', '哦', '嘛', '都', '也', '就',
];

function dayRange(ts, tz) {
  const start = startOf(ts, 'day', tz);
  return { from: start, to: bucketOf(start, 'day', tz).end };
}

/**
 * 从问题里认出时间范围。认不出返回 null。
 * @returns {{from:number, to:number}|null}
 */
export function parseTimeHints(text, now = Date.now(), tz = DEFAULT_TZ) {
  const s = String(text ?? '');

  let m = s.match(/(\d{4})-(\d{1,2})-(\d{1,2})/);
  if (m) {
    const start = zonedEpoch(Number(m[1]), Number(m[2]), Number(m[3]), 0, 0, 0, tz);
    return { from: start, to: bucketOf(start, 'day', tz).end };
  }

  m = s.match(/(\d{1,2})月(\d{1,2})[日号]/);
  if (m) {
    const p = wallParts(now, tz);
    const start = zonedEpoch(p.year, Number(m[1]), Number(m[2]), 0, 0, 0, tz);
    return { from: start, to: bucketOf(start, 'day', tz).end };
  }

  m = s.match(/(上|这|本)?周([一二三四五六日天])/);
  if (m) {
    const target = WEEKDAY[m[2]];
    const base = startOf(now, 'week', tz);
    const weekStart = m[1] === '上' ? addDaysTs(base, -7, tz) : base;
    const from = addDaysTs(weekStart, target - 1, tz);
    return { from, to: addDaysTs(from, 1, tz) };
  }

  if (/上周/.test(s)) {
    const from = addDaysTs(startOf(now, 'week', tz), -7, tz);
    return { from, to: addDaysTs(from, 7, tz) };
  }
  if (/(这周|本周)/.test(s)) {
    const from = startOf(now, 'week', tz);
    return { from, to: addDaysTs(from, 7, tz) };
  }
  if (/前天/.test(s)) return dayRange(addDaysTs(now, -2, tz), tz);
  if (/昨天/.test(s)) return dayRange(addDaysTs(now, -1, tz), tz);
  if (/今天/.test(s)) return dayRange(now, tz);

  if (/上个月/.test(s)) {
    const p = wallParts(now, tz);
    const y = p.month === 1 ? p.year - 1 : p.year;
    const mo = p.month === 1 ? 12 : p.month - 1;
    return { from: zonedEpoch(y, mo, 1, 0, 0, 0, tz), to: zonedEpoch(p.year, p.month, 1, 0, 0, 0, tz) };
  }
  if (/(这个月|本月)/.test(s)) {
    const p = wallParts(now, tz);
    const nextMonth = p.month === 12 ? 1 : p.month + 1;
    const nextYear = p.month === 12 ? p.year + 1 : p.year;
    return { from: zonedEpoch(p.year, p.month, 1, 0, 0, 0, tz), to: zonedEpoch(nextYear, nextMonth, 1, 0, 0, 0, tz) };
  }
  if (/去年/.test(s)) {
    const p = wallParts(now, tz);
    return { from: zonedEpoch(p.year - 1, 1, 1, 0, 0, 0, tz), to: zonedEpoch(p.year, 1, 1, 0, 0, 0, tz) };
  }
  if (/今年/.test(s)) {
    const p = wallParts(now, tz);
    return { from: zonedEpoch(p.year, 1, 1, 0, 0, 0, tz), to: zonedEpoch(p.year + 1, 1, 1, 0, 0, 0, tz) };
  }

  m = s.match(/最近\s*(\d+)\s*天/);
  if (m) {
    const n = Math.max(1, Number(m[1]));
    const today = startOf(now, 'day', tz);
    return { from: addDaysTs(today, -(n - 1), tz), to: bucketOf(today, 'day', tz).end };
  }

  return null;
}

/**
 * 去停用词、去标点、切词（中文按 2~3 字滑窗，英文按单词）。
 * 不做分词器：没有词表也能召回，靠后面的重排把噪声压下去。
 */
export function extractTerms(text) {
  let s = String(text ?? '');
  for (const word of STOPWORDS) s = s.split(word).join(' ');
  s = s.replace(/[，。！？、；：""''（）()《》【】\s,.!?;:'"()[\]]+/g, ' ');

  const terms = new Set();
  for (const run of s.split(/\s+/).filter(Boolean)) {
    if (/^[a-zA-Z0-9._-]+$/.test(run)) {
      if (run.length >= 2) terms.add(run.toLowerCase());
      continue;
    }
    // 短词也要切：只留整词会让"吃火锅"匹配不到正文里的"火锅"
    const maxN = Math.min(3, run.length);
    for (let n = 2; n <= maxN; n += 1) {
      for (let i = 0; i + n <= run.length; i += 1) terms.add(run.slice(i, i + n));
    }
    terms.add(run);
  }
  return [...terms].slice(0, 24);
}

/**
 * @param {string} question
 * @param {{now?:number, tz?:string, entities?:string[]}} [opts]
 */
export function planQuery(question, opts = {}) {
  const tz = opts.tz || DEFAULT_TZ;
  const now = Number(opts.now) || Date.now();
  const text = String(question ?? '');
  const range = parseTimeHints(text, now, tz);
  const entity = (opts.entities ?? []).find((name) => name && text.includes(name)) ?? null;
  const terms = extractTerms(text);
  return {
    question: text,
    q: terms.join(' '),
    terms,
    from: range?.from,
    to: range?.to,
    entity,
    tz,
  };
}

/**
 * 按计划检索并重排：命中词越多越长越靠前，同分看新旧。
 */
export function searchByPlan(db, plan, { limit = 5, scan = 300 } = {}) {
  const terms = plan.terms ?? [];
  if (!terms.length) {
    return searchEvents(db, { entity: plan.entity, from: plan.from, to: plan.to, limit });
  }

  const where = [];
  const params = [];
  for (const term of terms) {
    where.push('(e.title LIKE ? OR e.body LIKE ?)');
    params.push(`%${term}%`, `%${term}%`);
  }
  let sql = `SELECT e.* FROM events e WHERE (${where.join(' OR ')})`;
  if (plan.from != null) { sql += ' AND e.ts >= ?'; params.push(plan.from); }
  if (plan.to != null) { sql += ' AND e.ts < ?'; params.push(plan.to); }
  if (plan.entity) {
    sql += ` AND EXISTS (SELECT 1 FROM event_entities ee JOIN entities en ON en.id = ee.entity_id
             WHERE ee.event_id = e.id AND (en.name = ? OR en.uid = ?))`;
    params.push(plan.entity, plan.entity);
  }
  sql += ' LIMIT ?';
  params.push(Math.max(1, Number(scan) || 300));

  const rows = db.prepare(sql).all(...params).map(hydrate);
  const scored = rows.map((event) => {
    const hay = `${event.title} ${event.body}`;
    let score = 0;
    for (const term of terms) {
      if (hay.includes(term)) score += term.length * term.length;
    }
    return { event, score };
  });
  scored.sort((a, b) => b.score - a.score || b.event.ts - a.event.ts);
  return scored.slice(0, limit).map((x) => x.event);
}
