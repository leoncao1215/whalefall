#!/usr/bin/env node
/**
 * whalefall CLI —— 没有界面时的最小可用入口。
 *
 *   whalefall add --title "午饭" --body "猪脚饭，好吃"
 *   whalefall search 猪脚饭
 *   whalefall timeline 2026-11-01
 *   whalefall plan --level day --days 7
 *   whalefall stats
 */
import fs from 'node:fs';
import { openDb, closeDb } from './db.mjs';
import { addEvent, getEvent, hydrate } from './events.mjs';
import { searchEvents, timeline, stats } from './search.mjs';
import { planRollup, runRollup } from './rollup.mjs';
import { createCommandSummarizer, createMockSummarizer, summarizerPayload } from './summarizer.mjs';
import { buildContext } from './context.mjs';
import { listSummaries } from './summaries.mjs';
import { readJsonl, runQuestions, seedCorpus, writeReport } from './eval.mjs';
import { bucketOf, DEFAULT_TZ, formatLocal, parseTime, startOf } from './time.mjs';

const USAGE = `用法：
  whalefall add --title <标题> [--body <正文>] [--ts <时间>] [--source <来源>]
                [--kind <类型>] [--actor <名字>]... [--tz <时区>]
  whalefall search <关键词> [--from <时间>] [--to <时间>] [--entity <实体>]
                [--source <来源>] [--kind <类型>] [--limit <n>] [--json]
  whalefall timeline <YYYY-MM-DD> [--tz <时区>] [--json]
  whalefall plan [--level day|week|month] [--from <时间>] [--to <时间>] [--days <n>]
  whalefall rollup --summarizer <命令> | --mock [--level day|week|month]
                 [--from <时间>] [--to <时间>] [--days <n>] [--limit <n>] [--dry-run]
  whalefall context <关键词> [--budget <tokens>] [--hits <n>] [--json]
  whalefall summaries [--level <层级>] [--limit <n>] [--json]
  whalefall stats [--json]
  whalefall eval [--corpus eval/corpus.jsonl] [--questions eval/questions.jsonl]
                 [--hard eval/questions-hard.jsonl] [--k 5] [--out eval/report.md] [--json]
  whalefall export [--out <文件>]

全局：--db <路径>（默认 data/whalefall.db，或环境变量 WHALEFALL_DB）
`;

function parseArgs(argv) {
  const flags = {};
  const positional = [];
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (!arg.startsWith('--')) {
      positional.push(arg);
      continue;
    }
    const key = arg.slice(2);
    if (key.startsWith('no-')) {
      flags[key.slice(3)] = false;
      continue;
    }
    const next = argv[i + 1];
    if (next === undefined || next.startsWith('--')) {
      flags[key] = true;
      continue;
    }
    if (flags[key] === undefined) flags[key] = next;
    else if (Array.isArray(flags[key])) flags[key].push(next);
    else flags[key] = [flags[key], next];
    i += 1;
  }
  return { flags, positional };
}

function asList(value) {
  if (value === undefined || value === true) return undefined;
  return Array.isArray(value) ? value : [value];
}

function fmtEvent(e) {
  const when = formatLocal(e.ts, e.tz);
  const head = `${when}  [${e.source}/${e.kind}]  ${e.title || '(无标题)'}`;
  const body = e.body ? `\n    ${e.body.replace(/\n/g, '\n    ')}` : '';
  const actors = e.actors.length ? `\n    参与者：${e.actors.join('、')}` : '';
  return `${head}${body}${actors}`;
}

function printReport(title, report) {
  console.log(`\n【${title}】recall@${report.k}: ${(report.recall * 100).toFixed(1)}%  (${report.hits}/${report.total})  MRR ${report.mrr.toFixed(3)}  p95 ${report.latency.p95.toFixed(1)}ms`);
  for (const r of report.results) {
    const mark = r.hit ? '✅' : '❌';
    const rank = r.rank == null ? '' : `  第 ${r.rank + 1} 名 ${r.ms.toFixed(1)}ms`;
    console.log(`${mark} ${r.id}  ${r.question}${rank}`);
    if (!r.hit) {
      const top = r.top.map((t) => `#${t.id} ${t.title}`).join(' | ') || '空';
      console.log(`     期望 ${r.expected.join(', ') || '(无)'}；实际 ${top}`);
    }
  }
}

async function main() {
  const { flags, positional } = parseArgs(process.argv.slice(2));
  const command = positional[0];
  if (!command || command === 'help' || flags.help) {
    process.stdout.write(USAGE);
    return 0;
  }

  const tz = String(flags.tz || DEFAULT_TZ);
  // 评测默认用内存库，避免把测试语料写进真实记忆
  const dbPath = flags.db ? String(flags.db) : (command === 'eval' ? ':memory:' : undefined);
  const db = openDb(dbPath);

  try {
    if (command === 'add') {
      let body = flags.body;
      if (body === true) body = '';
      if (!body && !process.stdin.isTTY) {
        try { body = fs.readFileSync(0, 'utf8').trim(); } catch { body = ''; }
      }
      const result = addEvent(db, {
        title: flags.title === true ? '' : flags.title,
        body,
        ts: flags.ts,
        tz,
        source: flags.source,
        kind: flags.kind,
        actors: asList(flags.actor),
        sessionId: flags.session,
      });
      const event = getEvent(db, result.id);
      if (result.deduplicated) console.log(`已存在（去重）：#${event.id} ${fmtEvent(event)}`);
      else console.log(`已记录 #${event.id}\n${fmtEvent(event)}`);
      if (result.redacted?.length) console.log(`⚠ 已脱敏：${result.redacted.join(', ')}`);
      return 0;
    }

    if (command === 'search') {
      const q = positional.slice(1).join(' ');
      if (!q) throw new Error('search 需要一个关键词');
      const rows = searchEvents(db, {
        q,
        from: flags.from ? parseTime(flags.from, tz) : undefined,
        to: flags.to ? parseTime(flags.to, tz) : undefined,
        entity: flags.entity,
        source: flags.source,
        kind: flags.kind,
        limit: Number(flags.limit) || 20,
      });
      if (flags.json) { console.log(JSON.stringify(rows, null, 2)); return 0; }
      if (!rows.length) { console.log('没找到。'); return 0; }
      console.log(`找到 ${rows.length} 条：\n`);
      for (const row of rows) console.log(fmtEvent(row), '\n');
      return 0;
    }

    if (command === 'timeline') {
      const day = positional[1];
      if (!day) throw new Error('timeline 需要一个日期，如 2026-11-01');
      const start = startOf(parseTime(day, tz), 'day', tz);
      const end = bucketOf(start, 'day', tz).end;
      const rows = timeline(db, { start, end });
      if (flags.json) { console.log(JSON.stringify(rows, null, 2)); return 0; }
      console.log(`${day} 共 ${rows.length} 条：\n`);
      for (const row of rows) console.log(fmtEvent(row), '\n');
      return 0;
    }

    if (command === 'plan') {
      const level = String(flags.level || 'day');
      const to = flags.to ? parseTime(flags.to, tz) : Date.now();
      const days = Number(flags.days) || 7;
      const from = flags.from ? parseTime(flags.from, tz) : to - days * 86400000;
      const plan = planRollup(db, { level, tz, from, to });
      if (flags.json) { console.log(JSON.stringify(plan, null, 2)); return 0; }
      if (!plan.length) { console.log('没有待摘要的桶。'); return 0; }
      console.log(`待摘要 ${plan.length} 个 ${level} 桶：`);
      for (const bucket of plan) {
        console.log(`  ${bucket.key}  ${bucket.count} 条  ${formatLocal(bucket.start, tz)} → ${formatLocal(bucket.end, tz)}`);
      }
      return 0;
    }

    if (command === 'rollup') {
      const level = String(flags.level || 'day');
      const to = flags.to ? parseTime(flags.to, tz) : Date.now();
      const days = Number(flags.days) || 7;
      const from = flags.from ? parseTime(flags.from, tz) : to - days * 86400000;
      const promptVersion = String(flags['prompt-version'] || 'v1');
      const plan = planRollup(db, { level, tz, from, to, promptVersion });
      if (!plan.length) { console.log('没有待摘要的桶。'); return 0; }

      const limit = Number(flags.limit) || plan.length;
      const batch = plan.slice(0, limit);
      console.log(`待摘要 ${batch.length} 个 ${level} 桶（共 ${plan.length} 个）`);

      let summarize;
      if (flags.mock) summarize = createMockSummarizer();
      else if (typeof flags.summarizer === 'string') {
        summarize = createCommandSummarizer(String(flags.summarizer), {
          timeoutMs: Number(flags.timeout) || 60000,
        });
      } else {
        throw new Error('rollup 需要 --summarizer "<命令>" 或 --mock');
      }

      if (flags['dry-run']) {
        const first = batch[0];
        const events = first.eventIds
          .map((id) => db.prepare('SELECT * FROM events WHERE id = ?').get(id))
          .filter(Boolean)
          .map(hydrate);
        console.log(JSON.stringify(summarizerPayload({ level, bucket: first, tz, events }), null, 2));
        return 0;
      }

      const { ok, failed } = await runRollup(db, batch, summarize, { promptVersion, tz });
      console.log(`完成 ${ok.length} 个，失败 ${failed.length} 个`);
      for (const f of failed) console.error(`  ✗ ${f.bucket.key}: ${f.error}`);
      return failed.length ? 1 : 0;
    }

    if (command === 'context') {
      const q = positional.slice(1).join(' ');
      if (!q) throw new Error('context 需要一个关键词（或用 --entity）');
      const ctx = buildContext(db, {
        q,
        entity: flags.entity,
        budget: Number(flags.budget) || 800,
        hits: Number(flags.hits) || 5,
      });
      if (flags.json) { console.log(JSON.stringify(ctx, null, 2)); return 0; }
      console.log(ctx.text || '(没有可注入的记忆)');
      console.log(`\n-- ${ctx.used}/${ctx.budget} tokens`);
      return 0;
    }

    if (command === 'summaries') {
      const rows = listSummaries(db, { level: flags.level, limit: Number(flags.limit) || 20 });
      if (flags.json) { console.log(JSON.stringify(rows, null, 2)); return 0; }
      if (!rows.length) { console.log('还没有摘要。'); return 0; }
      for (const row of rows) {
        console.log(`${formatLocal(row.bucketStart, tz)}  ${row.level}/${row.promptVersion}  ${row.sourceCount} 条`);
        console.log(`    ${row.text || '(空)'}\n`);
      }
      return 0;
    }

    if (command === 'stats') {
      const data = stats(db);
      if (flags.json) { console.log(JSON.stringify(data, null, 2)); return 0; }
      console.log(`事件：${data.events}  实体：${data.entities}  摘要：${data.summaries}`);
      if (data.firstTs) {
        console.log(`范围：${formatLocal(data.firstTs, tz)} → ${formatLocal(data.lastTs, tz)}`);
      }
      if (data.bySource.length) console.log(`来源：${data.bySource.map((x) => `${x.source}(${x.count})`).join('  ')}`);
      if (data.byKind.length) console.log(`类型：${data.byKind.map((x) => `${x.kind}(${x.count})`).join('  ')}`);
      return 0;
    }

    if (command === 'eval') {
      const corpusFile = String(flags.corpus || 'eval/corpus.jsonl');
      const easyFile = String(flags.questions || 'eval/questions.jsonl');
      const hardFile = flags.hard === false ? null : String(flags.hard || 'eval/questions-hard.jsonl');
      const corpus = readJsonl(corpusFile);
      const easy = readJsonl(easyFile);
      const hard = hardFile && fs.existsSync(hardFile) ? readJsonl(hardFile) : null;
      const map = seedCorpus(db, corpus, { tz });
      const k = Number(flags.k) || 5;
      const suite = {
        easy: runQuestions(db, map, easy, { k, tz }),
        hard: hard ? runQuestions(db, map, hard, { k, tz }) : null,
      };
      if (flags.json) { console.log(JSON.stringify(suite, null, 2)); return 0; }
      printReport('关键词基线', suite.easy);
      if (suite.hard) printReport('换句话问（考语义）', suite.hard);
      if (flags.out) {
        writeReport(String(flags.out), suite, { generatedAt: new Date().toISOString() });
        console.log(`报告已写入 ${flags.out}`);
      }
      return 0;
    }

    if (command === 'export') {
      const rows = db.prepare('SELECT * FROM events ORDER BY ts ASC').all();
      const lines = rows.map((r) => JSON.stringify(r)).join('\n') + '\n';
      if (flags.out && flags.out !== true) {
        fs.writeFileSync(String(flags.out), lines, 'utf8');
        console.log(`已导出 ${rows.length} 条到 ${flags.out}`);
      } else {
        process.stdout.write(lines);
      }
      return 0;
    }

    throw new Error(`未知命令：${command}\n\n${USAGE}`);
  } finally {
    closeDb(db);
  }
}

main()
  .then((code) => { process.exitCode = code; })
  .catch((error) => {
    console.error(`错误：${error?.message ?? error}`);
    process.exitCode = 1;
  });
