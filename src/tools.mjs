/**
 * 工具门面：模型能调的那几个动作。
 *
 * 为什么单独一层：检索/写入的实现会变（换向量库、加缓存），但"模型看到的工具"
 * 应该稳定。以后挂到 DSH 或 MCP 上时，只要把这层包成 tool 注册即可。
 */
import { addEvent, getEvent } from './events.mjs';
import { searchEvents, stats, timeline } from './search.mjs';
import { summaryAt } from './summaries.mjs';
import { forgetEvent } from './forget.mjs';
import { DEFAULT_TZ, parseTime, startOf, bucketOf } from './time.mjs';

export const TOOL_DEFINITIONS = [
  {
    name: 'memory_search',
    description: '按关键词/时间/实体检索记忆原文。返回带 id 的条目，可用于后续 memory_get。',
    inputSchema: {
      type: 'object',
      properties: {
        q: { type: 'string', description: '关键词；中文 3 字以上走全文索引，1-2 字走模糊匹配' },
        entity: { type: 'string', description: '人物/主题名' },
        kind: { type: 'string', description: '事件类型，如 meal/note/task/conversation' },
        source: { type: 'string', description: '来源，如 qq/web/agent/pet' },
        from: { type: 'string', description: '起始时间，YYYY-MM-DD 或 ISO' },
        to: { type: 'string', description: '结束时间（不含）' },
        limit: { type: 'number', description: '最多返回几条，默认 10' },
      },
    },
  },
  {
    name: 'memory_timeline',
    description: '某一天（或某段时间）按时间正序列出发生了什么。',
    inputSchema: {
      type: 'object',
      properties: {
        date: { type: 'string', description: 'YYYY-MM-DD；不给则用 from/to' },
        from: { type: 'string' },
        to: { type: 'string' },
        limit: { type: 'number' },
      },
    },
  },
  {
    name: 'memory_get',
    description: '按 id 取一条记忆的完整原文。',
    inputSchema: {
      type: 'object',
      properties: { id: { type: ['number', 'string'], description: 'memory_search 返回的 id' } },
      required: ['id'],
    },
  },
  {
    name: 'memory_summary',
    description: '取某个时刻所在层级（day/week/month/year）的摘要，用于"先看大意再决定要不要翻原文"。',
    inputSchema: {
      type: 'object',
      properties: {
        date: { type: 'string', description: 'YYYY-MM-DD 或 ISO 时间' },
        level: { type: 'string', enum: ['day', 'week', 'month', 'year'] },
        source: { type: 'string', description: '来源（qq/web/all），默认 all' },
      },
      required: ['level'],
    },
  },
  {
    name: 'memory_remember',
    description: '写入一条新记忆。原文不可变；修正旧记忆请新写一条并说明。',
    inputSchema: {
      type: 'object',
      properties: {
        title: { type: 'string' },
        body: { type: 'string' },
        kind: { type: 'string' },
        ts: { type: 'string', description: '发生时间，默认现在' },
        actors: { type: 'array', items: { type: 'string' } },
      },
      required: ['title'],
    },
  },
  {
    name: 'memory_forget',
    description: '彻底删除一条记忆（含派生摘要标脏）。不可恢复，调用前应和用户确认。',
    inputSchema: {
      type: 'object',
      properties: { id: { type: ['number', 'string'] } },
      required: ['id'],
    },
  },
  {
    name: 'memory_stats',
    description: '记忆库概览：条数、时间范围、来源分布。',
    inputSchema: { type: 'object', properties: {} },
  },
];

function fail(error) {
  return { ok: false, error: String(error?.message ?? error) };
}

function clip(text, max = 400) {
  const s = String(text ?? '');
  return s.length > max ? `${s.slice(0, max)}…` : s;
}

/**
 * @param {import('node:sqlite').DatabaseSync} db
 * @param {{tz?: string}} [opts]
 */
export function createMemoryTools(db, opts = {}) {
  const tz = opts.tz || DEFAULT_TZ;
  const time = (value) => (value == null || value === '' ? undefined : parseTime(value, tz));

  return {
    memory_search(args = {}) {
      try {
        const limit = Math.max(1, Math.min(50, Number(args.limit) || 10));
        const items = searchEvents(db, {
          q: args.q,
          entity: args.entity,
          kind: args.kind,
          source: args.source,
          from: time(args.from),
          to: time(args.to),
          limit,
        });
        return {
          ok: true,
          count: items.length,
          items: items.map((e) => ({
            id: e.id,
            ts: e.ts,
            kind: e.kind,
            title: e.title,
            snippet: clip(e.body),
            actors: e.actors,
          })),
        };
      } catch (error) { return fail(error); }
    },

    memory_timeline(args = {}) {
      try {
        let start;
        let end;
        if (args.date) {
          start = startOf(parseTime(args.date, tz), 'day', tz);
          end = bucketOf(start, 'day', tz).end;
        } else {
          start = time(args.from) ?? 0;
          end = time(args.to) ?? Date.now() + 86400000;
        }
        const rows = timeline(db, { start, end, limit: Math.min(500, Number(args.limit) || 100) });
        return {
          ok: true,
          count: rows.length,
          items: rows.map((e) => ({ id: e.id, ts: e.ts, kind: e.kind, title: e.title, body: clip(e.body, 200) })),
        };
      } catch (error) { return fail(error); }
    },

    memory_get(args = {}) {
      try {
        if (args.id == null) throw new Error('缺少 id');
        const event = getEvent(db, args.id);
        if (!event) return { ok: false, error: 'not-found' };
        return { ok: true, event };
      } catch (error) { return fail(error); }
    },

    memory_summary(args = {}) {
      try {
        const level = String(args.level ?? 'day');
        const ts = args.date ? parseTime(args.date, tz) : Date.now();
        const summary = summaryAt(db, ts, level, { tz, source: String(args.source || 'all') });
        if (!summary) return { ok: true, summary: null, hint: '这一层还没有摘要' };
        return { ok: true, summary };
      } catch (error) { return fail(error); }
    },

    memory_remember(args = {}) {
      try {
        const title = String(args.title ?? '').trim();
        if (!title && !args.body) throw new Error('至少要有 title 或 body');
        const result = addEvent(db, {
          title,
          body: args.body,
          kind: args.kind,
          ts: args.ts ? parseTime(args.ts, tz) : undefined,
          tz,
          actors: args.actors,
          source: args.source || 'agent',
        });
        return { ok: true, id: result.id, uid: result.uid, deduplicated: result.deduplicated, redacted: result.redacted };
      } catch (error) { return fail(error); }
    },

    memory_forget(args = {}) {
      try {
        if (args.id == null) throw new Error('缺少 id');
        const result = forgetEvent(db, args.id);
        return result.deleted ? { ok: true, ...result } : { ok: false, error: result.reason ?? 'not-found' };
      } catch (error) { return fail(error); }
    },

    memory_stats() {
      try {
        return { ok: true, stats: stats(db) };
      } catch (error) { return fail(error); }
    },
  };
}

/** 按名字调一个工具；未知工具直接抛错（这是开发错误，不该静默）。 */
export function callTool(db, name, args = {}, opts = {}) {
  const tools = createMemoryTools(db, opts);
  const fn = tools[name];
  if (!fn) throw new Error(`未知工具：${name}`);
  return fn(args);
}
