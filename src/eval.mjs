/**
 * 评测：把"记忆好不好用"变成可回归的数字。
 *
 * 这一版只评**检索层**：题目里给出显式的查询计划（关键词 / 时间窗 / 实体），
 * 不评自然语言理解。原因很实际——先把记忆层量出来，NLU（让模型把问题翻译成
 * 查询）才有可对比的基线；否则两层混在一起，退化了都不知道是谁的锅。
 */
import fs from 'node:fs';
import { addEvent } from './events.mjs';
import { searchEvents } from './search.mjs';
import { DEFAULT_TZ, parseTime } from './time.mjs';
import { searchByPlan } from './query.mjs';

export function readJsonl(file) {
  const text = fs.readFileSync(file, 'utf8');
  return text
    .split('\n')
    .map((line) => line.trim())
    .filter(Boolean)
    .map((line, index) => {
      try {
        return JSON.parse(line);
      } catch (error) {
        throw new Error(`${file} 第 ${index + 1} 行不是合法 JSON：${error.message}`);
      }
    });
}

/**
 * 把语料写进库，返回 fixture key -> event id 的映射。
 * 用 dedupeKey=key，重复 seed 不会产生重复事件。
 */
export function seedCorpus(db, events, { tz = DEFAULT_TZ } = {}) {
  const map = new Map();
  for (const item of events) {
    if (!item.key) throw new Error('语料缺少 key 字段');
    const result = addEvent(db, {
      title: item.title,
      body: item.body,
      ts: item.ts,
      tz: item.tz || tz,
      kind: item.kind,
      source: item.source || 'fixture',
      actors: item.actors,
      dedupeKey: `fixture:${item.key}`,
    });
    map.set(item.key, result.id);
  }
  return map;
}

function percentile(values, p) {
  if (!values.length) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  const idx = Math.min(sorted.length - 1, Math.ceil((p / 100) * sorted.length) - 1);
  return sorted[Math.max(0, idx)];
}

/**
 * @param {import('node:sqlite').DatabaseSync} db
 * @param {Map<string, number>} keyToId
 * @param {Array<object>} questions
 * @param {{k?: number, tz?: string}} [opts]
 */
export function runQuestions(db, keyToId, questions, opts = {}) {
  const k = Math.max(1, Number(opts.k) || 5);
  const tz = opts.tz || DEFAULT_TZ;

  const results = questions.map((q) => {
    const expected = (q.expected ?? [])
      .map((key) => keyToId.get(key))
      .filter((id) => id != null);

    const started = performance.now();
    const rows = opts.planner
      ? searchByPlan(db, opts.planner(q), { limit: k })
      : searchEvents(db, {
        q: q.query,
        entity: q.entity,
        kind: q.kind,
        from: q.from ? parseTime(q.from, tz) : undefined,
        to: q.to ? parseTime(q.to, tz) : undefined,
        limit: k,
      });
    const ms = performance.now() - started;

    const ids = rows.map((r) => r.id);
    const ranks = expected.map((id) => ids.indexOf(id)).filter((i) => i >= 0);
    const rank = ranks.length ? Math.min(...ranks) : null;

    return {
      id: q.id,
      question: q.question,
      query: q.query,
      expected,
      rank,
      hit: rank != null,
      ms,
      top: rows.map((r) => ({ id: r.id, title: r.title, ts: r.ts })),
    };
  });

  const hits = results.filter((r) => r.hit);
  const recall = results.length ? hits.length / results.length : 0;
  const mrr = results.length
    ? hits.reduce((sum, r) => sum + 1 / (r.rank + 1), 0) / results.length
    : 0;
  const latencies = results.map((r) => r.ms);

  return {
    k,
    total: results.length,
    hits: hits.length,
    recall,
    mrr,
    latency: { p50: percentile(latencies, 50), p95: percentile(latencies, 95) },
    results,
  };
}

export function toMarkdown(report, meta = {}) {
  const lines = [];
  lines.push(`# ${meta.title ? `${meta.title} · ` : ''}检索评测报告`);
  lines.push('');
  if (meta.generatedAt) lines.push(`- 生成时间：${meta.generatedAt}`);
  lines.push(`- 题数：${report.total}  命中：${report.hits}  recall@${report.k}：${(report.recall * 100).toFixed(1)}%  MRR：${report.mrr.toFixed(3)}`);
  lines.push(`- 检索耗时：p50 ${report.latency.p50.toFixed(2)}ms · p95 ${report.latency.p95.toFixed(2)}ms`);
  lines.push('');
  lines.push('| # | 问题 | 命中 | 名次 | 耗时 | 命中的是 |');
  lines.push('| --- | --- | --- | --- | --- | --- |');
  for (const r of report.results) {
    const top = r.top[0];
    const hitText = r.hit ? '✅' : '❌';
    const rankText = r.rank == null ? '-' : String(r.rank + 1);
    const found = top ? `#${top.id} ${top.title}` : '（空）';
    lines.push(`| ${r.id} | ${r.question} | ${hitText} | ${rankText} | ${r.ms.toFixed(1)}ms | ${found} |`);
  }
  lines.push('');
  lines.push('> 说明：这一版只评检索层，题目自带查询计划（关键词/时间窗/实体）；自然语言理解在 P3 之后单独评。');
  lines.push('');
  return `${lines.join('\n')}\n`;
}

export function toMarkdownSuite(suite, meta = {}) {
  const blocks = [toMarkdown(suite.easy, { ...meta, title: '关键词基线' })];
  if (suite.hard) blocks.push(toMarkdown(suite.hard, { ...meta, title: '换句话问（考语义）' }));
  return blocks.join('\n');
}

/** 兼容单套与双套。 */
export function writeReport(file, reportOrSuite, meta = {}) {
  const text = reportOrSuite?.easy ? toMarkdownSuite(reportOrSuite, meta) : toMarkdown(reportOrSuite, meta);
  fs.writeFileSync(file, text, 'utf8');
  return file;
}
