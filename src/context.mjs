/**
 * 装配层：把"库里有的"变成"这次对话用得上的"。
 *
 * 原则：
 *   · 默认注入要小；细节靠工具按需取。
 *   · 预算先给"相关命中"，再给"摘要导航"，最后才是"最近发生了什么"。
 *   · 每块都带 id 与时间，模型可以据此再发起精确查询（这张卡是入口，不是终点）。
 */
import { DEFAULT_TZ, formatLocal } from './time.mjs';
import { searchEvents } from './search.mjs';
import { listSummaries } from './summaries.mjs';
import { hydrate } from './events.mjs';

/**
 * 粗估 token：汉字 1 字≈1 token，其它字符约 3.2 字符≈1 token。
 * 不追求精确，只用来守预算；误差 20% 以内不影响决策。
 */
export function estimateTokens(text) {
  const s = String(text ?? '');
  let cjk = 0;
  let other = 0;
  for (const ch of s) {
    if (/[\u3400-\u9fff\uf900-\ufaff\u3000-\u303f\uff00-\uffef]/.test(ch)) cjk += 1;
    else other += 1;
  }
  return Math.ceil(cjk + other / 3.2);
}

function clip(text, max) {
  const s = String(text ?? '').replace(/\s+/g, ' ').trim();
  return s.length > max ? `${s.slice(0, max)}…` : s;
}

function eventLine(event, tz) {
  const when = formatLocal(event.ts, event.tz || tz);
  const body = event.body ? `：${clip(event.body, 160)}` : '';
  return `- ${when} [${event.kind}] ${event.title}${body}（#${event.id}）`;
}

/**
 * @param {import('node:sqlite').DatabaseSync} db
 * @param {object} [opts]
 * @param {string} [opts.q] 关键词
 * @param {string} [opts.entity]
 * @param {number} [opts.from]
 * @param {number} [opts.to]
 * @param {number} [opts.budget] 总 token 预算
 * @param {number} [opts.hits] 命中条数上限
 * @param {number} [opts.recent] 最近事件条数上限
 * @param {string} [opts.tz]
 */
export function buildContext(db, opts = {}) {
  const tz = opts.tz || DEFAULT_TZ;
  const budget = Math.max(80, Number(opts.budget) || 800);
  const blocks = [];
  let used = 0;

  function addBlock(kind, title, lines) {
    const header = `【${title}】`;
    const headerCost = estimateTokens(header);
    if (used + headerCost > budget) return;
    const taken = [];
    let cost = headerCost;
    for (const line of lines) {
      const lineCost = estimateTokens(line);
      if (used + cost + lineCost > budget) break;
      taken.push(line);
      cost += lineCost;
    }
    if (!taken.length) return;
    used += cost;
    blocks.push({ kind, title, lines: taken, tokens: cost });
  }

  if (opts.q || opts.entity) {
    const hits = searchEvents(db, {
      q: opts.q,
      entity: opts.entity,
      from: opts.from,
      to: opts.to,
      limit: Math.max(1, Number(opts.hits) || 5),
    });
    addBlock('hits', '相关记忆', hits.map((e) => eventLine(e, tz)));
  }

  const summaries = listSummaries(db, {
    level: 'day',
    from: opts.from,
    to: opts.to,
    status: 'ready',
    limit: 3,
  });
  addBlock(
    'summaries',
    '那几天的摘要',
    summaries.map((s) => `- ${formatLocal(s.bucketStart, tz)}：${clip(s.text, 200)}（${s.level}/${s.promptVersion}）`),
  );

  const recentLimit = Math.max(1, Number(opts.recent) || 5);
  const recentRows = db
    .prepare('SELECT * FROM events ORDER BY ts DESC LIMIT ?')
    .all(recentLimit)
    .map(hydrate);
  addBlock('recent', '最近发生的', recentRows.map((e) => eventLine(e, tz)));

  const text = blocks.map((b) => `【${b.title}】\n${b.lines.join('\n')}`).join('\n\n');
  return { text, blocks, used, budget, tz };
}
