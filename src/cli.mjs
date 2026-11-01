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
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { openDb, closeDb } from './db.mjs';
import { initInstance, listInstances, resolveInstance, whalefallHome } from './instance.mjs';
import { addEvent, getEvent, hydrate } from './events.mjs';
import { searchEvents, timeline, stats } from './search.mjs';
import { distinctEventSources, planRollup, runRollup } from './rollup.mjs';
import { runDreamSummaries } from './dream.mjs';
import { sendProactive } from './qq-send.mjs';
import { createCommandSummarizer, createMockSummarizer, summarizerPayload } from './summarizer.mjs';
import { buildContext } from './context.mjs';
import { harvestSessions } from './harvest.mjs';
import { rebuildFromSessions, verifyHarvest } from './verify.mjs';
import { readQqConfig } from './qq-send.mjs';
import { listPersonas, loadPersona, renderPersona } from './persona.mjs';
import { assembleSystemPrompt } from './assemble.mjs';
import { evaluateProactive, proactiveHistory, recordProactiveSend } from './proactive.mjs';
import { callTool, TOOL_DEFINITIONS } from './tools.mjs';
import { buildProactivePrompt, createCommandComposer, proactiveTick } from './tick.mjs';
import { heartbeatStatus, recordHeartbeat } from './heartbeat.mjs';
import { planQuery, searchByPlan } from './query.mjs';
import { deleteSecret, listSecrets, setSecret } from './secrets.mjs';
import { createCommandResponder, createGateway } from './gateway.mjs';
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
  whalefall ask <问题> [--limit <n>] [--json]
  whalefall context <关键词> [--budget <tokens>] [--hits <n>] [--json]
  whalefall init <id> [--name <名字>] [--force]
  whalefall instances
  whalefall persona [--instance <id>] [--dir <人格包>] [--json]
  whalefall personas [--dir personas] [--json]
  whalefall prompt <关键词> [--budget <tokens>] [--persona <目录>] [--json]
  whalefall proactive check [--persona <目录>] [--now <时间>] [--user-last <时间>] [--no-substance]
  whalefall proactive log [--json]
  whalefall heartbeat [--json] [--now <时间>] [--persona <目录>]
  whalefall heartbeat record --text "<说过的话>" [--kind proactive|followup] [--thread <id>]
  whalefall qq whoami | qq send <文本> --yes [--group]
  whalefall verify [--hours <n>] [--source qq,web]
  whalefall reindex --yes [--hours <n>]
  whalefall harvest [--hours 24] [--source qq,web] [--dry-run] [--full]
  whalefall dream [--hours 24] [--source qq,web] [--summarizer <命令>] [--dry-run]
                 [--include-today] [--levels day,week,month,year]
  whalefall secret set <键名> [--value <值> | --prompt]   # 不给就从 stdin 读
  whalefall secret list [--json]
  whalefall secret rm <键名>
  whalefall serve [--port 8787] [--host 127.0.0.1] [--token <令牌>] [--responder <命令>] [--echo]
  whalefall tick [--text <内容> | --command <命令>] [--now <时间>] [--memory <文本>] [--send]
                 [--q <关键词> | --recent] [--dry-run]
  whalefall tool <工具名> [--args '<json>'] [--json]
  whalefall tools [--json]
  whalefall summaries [--level <层级>] [--limit <n>] [--json]
  whalefall stats [--json]
  whalefall eval [--nl] [--corpus eval/corpus.jsonl] [--questions eval/questions.jsonl]
                 [--hard eval/questions-hard.jsonl] [--k 5] [--out eval/report.md] [--json]
  whalefall export [--out <文件>]

全局：--db <路径>（默认当前个体的 memory.db，或 WHALEFALL_DB）
      --instance <id>（默认 dafeiyu，或 WHALEFALL_INSTANCE）
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

/**
 * 在 TTY 上读一段不回显的输入（跨 shell 都能用）。
 * 为什么不用 shell 的 read -s：zsh 的 read -p 是"读协进程"，会直接报错。
 */
function promptSecret(label) {
  const stdin = process.stdin;
  if (!stdin.isTTY) throw new Error('--prompt 需要交互终端');
  process.stderr.write(label);
  stdin.setRawMode(true);
  stdin.resume();
  stdin.setEncoding('utf8');

  return new Promise((resolve, reject) => {
    let value = '';
    const cleanup = () => {
      stdin.removeListener('data', onData);
      try { stdin.setRawMode(false); } catch { /* ignore */ }
      stdin.pause();
    };
    const onData = (chunk) => {
      for (const ch of chunk) {
        if (ch === '\r' || ch === '\n') {
          cleanup();
          process.stderr.write('\n');
          resolve(value);
          return;
        }
        if (ch === '\u0003') { cleanup(); process.stderr.write('\n'); process.exit(130); }
        if (ch === '\u007f' || ch === '\b') { value = value.slice(0, -1); continue; }
        value += ch;
      }
    };
    stdin.on('data', onData);
    stdin.on('error', reject);
  });
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
  const inMemory = command === 'eval' || command === 'persona' || command === 'personas' || command === 'secret';
  const instance = resolveInstance(flags.instance ? String(flags.instance) : undefined);
  const personaDirOf = (value) => (value && value !== true ? String(value) : instance.personaDir);
  const dbPath = flags.db ? String(flags.db) : (inMemory ? ':memory:' : instance.db);
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

      let summarize;
      if (flags.mock) summarize = createMockSummarizer();
      else if (typeof flags.summarizer === 'string') {
        summarize = createCommandSummarizer(String(flags.summarizer), {
          timeoutMs: Number(flags.timeout) || 180000,
        });
      } else {
        throw new Error('rollup 需要 --summarizer "<命令>" 或 --mock');
      }

      // 默认只摘合并视图；--source qq 只摘 qq；--per-source 每个来源 + 合并各摘一份
      const scopes = flags['per-source']
        ? [null, ...distinctEventSources(db, { from, to })]
        : [typeof flags.source === 'string' && flags.source !== 'all' ? String(flags.source) : null];

      if (flags['dry-run']) {
        const plan = planRollup(db, { level, tz, from, to, promptVersion, source: scopes[0] });
        if (!plan.length) { console.log('没有待摘要的桶。'); return 0; }
        const first = plan[0];
        const events = first.eventIds
          .map((id) => db.prepare('SELECT * FROM events WHERE id = ?').get(id))
          .filter(Boolean)
          .map(hydrate);
        console.log(JSON.stringify(summarizerPayload({ level, bucket: first, tz, events }), null, 2));
        return 0;
      }

      let done = 0;
      let failedCount = 0;
      let any = false;
      for (const scope of scopes) {
        const plan = planRollup(db, { level, tz, from, to, promptVersion, source: scope });
        if (!plan.length) continue;
        any = true;
        const limit = Number(flags.limit) || plan.length;
        const batch = plan.slice(0, limit);
        const { ok, failed } = await runRollup(db, batch, summarize, { promptVersion, tz });
        done += ok.length;
        failedCount += failed.length;
        console.log(`${scope ?? 'all'}: 完成 ${ok.length}，失败 ${failed.length}`);
        for (const f of failed) console.error(`  ✗ ${f.bucket.key}: ${f.error}`);
      }
      if (!any) console.log('没有待摘要的桶。');
      return failedCount ? 1 : 0;
    }

    if (command === 'prompt') {
      const q = positional.slice(1).join(' ');
      if (!q && !flags.entity) throw new Error('prompt 需要一个关键词（或用 --entity）');
      const persona = flags.persona === false ? null : loadPersona(personaDirOf(flags.persona));
      const out = assembleSystemPrompt(db, {
        persona,
        q,
        entity: flags.entity,
        budget: Number(flags.budget) || 1500,
        tz,
      });
      if (flags.json) { console.log(JSON.stringify(out, null, 2)); return 0; }
      console.log(out.system);
      console.log(`\n-- ${out.tokens}/${out.budget} tokens${out.overBudget ? '（超预算）' : ''}`);
      return 0;
    }

    if (command === 'init') {
      const id = positional[1];
      if (!id) throw new Error('用法：whalefall init <id> [--name <名字>]');
      const created = initInstance(id, {
        name: flags.name && flags.name !== true ? String(flags.name) : undefined,
        force: Boolean(flags.force),
      });
      console.log(`已创建个体 ${created.id}：${created.dir}`);
      console.log(`人格：${created.personaDir}`);
      console.log(`数据根目录：${whalefallHome()}`);
      return 0;
    }

    if (command === 'instances') {
      const ids = listInstances();
      if (!ids.length) { console.log('还没有任何个体。用 whalefall init <id> 建一个。'); return 0; }
      for (const id of ids) {
        const inst = resolveInstance(id);
        const tag = inst.legacy.persona || inst.legacy.db ? '（旧位置）' : '';
        console.log(`${id}${tag}  ${inst.dir}`);
      }
      return 0;
    }

    if (command === 'qq') {
      const sub = positional[1];
      if (sub === 'whoami') {
        const cfg = readQqConfig(flags.profile ? String(flags.profile) : undefined);
        const mask = (v) => (v ? `${String(v).slice(0, 4)}…${String(v).slice(-4)}` : '(空)');
        console.log(`appId: ${cfg.appId}`);
        console.log(`appSecret: ${mask(cfg.appSecret)}（长度 ${cfg.appSecret.length}）`);
        console.log(`c2c: ${cfg.c2cAllow.map(mask).join(', ') || '(空)'}`);
        console.log(`group: ${cfg.groupAllow.map(mask).join(', ') || '(空)'}`);
        return 0;
      }
      if (sub === 'send') {
        const text = positional.slice(2).join(' ');
        if (!text) throw new Error('用法：whalefall qq send <文本> --yes [--group]');
        if (!flags.yes) throw new Error('这会真的发出消息；确认请加 --yes');
        const out = await sendProactive(text, {
          toGroup: Boolean(flags.group),
          groupOpenid: typeof flags.group === 'string' ? String(flags.group) : undefined,
        });
        console.log(out.ok ? `已发送：${out.id}` : `发送失败：HTTP ${out.status} code=${out.code} ${out.message}`);
        return out.ok ? 0 : 1;
      }
      throw new Error('用法：whalefall qq whoami | qq send <文本> --yes [--group]');
    }

    if (command === 'verify') {
      const hours = Number(flags.hours) || 0;
      const since = hours > 0 ? Date.now() - hours * 3600000 : 0;
      const root = String(flags.root || path.join(
        process.env.DSH_HOME || path.join(os.homedir(), '.dsh'), 'sessions',
      ));
      const sources = typeof flags.source === 'string' && flags.source !== 'all'
        ? String(flags.source).split(',').map((x) => x.trim()).filter(Boolean)
        : null;

      const out = verifyHarvest(db, { root, since, sources });
      console.log(`扫描 ${out.files} 个会话，预期 ${out.turns} 个 turn，已入库 ${out.present} 个，缺失 ${out.missing.length} 个`);
      for (const miss of out.missing.slice(0, 10)) {
        console.log(`  ✗ ${miss.source} ${miss.sessionId.slice(0, 20)} turn ${miss.turn}：${miss.title}`);
      }
      if (out.missing.length > 10) console.log(`  …还有 ${out.missing.length - 10} 个`);
      return out.missing.length ? 1 : 0;
    }

    if (command === 'reindex') {
      if (!flags.yes) {
        throw new Error('reindex 会删除并重建派生的对话事件与全部摘要；确认请加 --yes');
      }
      const hours = Number(flags.hours) || 0;
      const since = hours > 0 ? Date.now() - hours * 3600000 : 0;
      const root = String(flags.root || path.join(
        process.env.DSH_HOME || path.join(os.homedir(), '.dsh'), 'sessions',
      ));
      const out = rebuildFromSessions(db, { root, since, tz });
      console.log(`重建前：对话 ${out.before.conversations} 条、摘要 ${out.before.summaries} 条`);
      console.log(`重建后：扫描 ${out.after.files} 个会话，恢复对话 ${out.after.conversations} 条`);
      console.log('摘要已清空，需要重跑 dream（或等凌晨的 cron）。');
      return 0;
    }

    if (command === 'harvest') {
      const hours = Number(flags.hours) || 24;
      const since = Date.now() - hours * 3600000;
      const root = String(flags.root || path.join(
        process.env.DSH_HOME || path.join(os.homedir(), '.dsh'), 'sessions',
      ));
      const sources = typeof flags.source === 'string' && flags.source !== 'all'
        ? String(flags.source).split(',').map((x) => x.trim()).filter(Boolean)
        : null;

      const stats = harvestSessions(db, {
        root, since, sources, tz,
        dryRun: Boolean(flags['dry-run']),
        incremental: !flags.full,
      });
      console.log(`会话 ${stats.files} 个，新增事件 ${stats.added} 条，跳过 ${stats.skipped} 条`);
      for (const item of stats.sessions.filter((x) => x.added > 0)) {
        console.log(`  ${item.source.padEnd(4)} ${item.sessionId.slice(0, 24)}  +${item.added}`);
      }
      return 0;
    }

    if (command === 'dream') {
      const hours = Number(flags.hours) || 24;
      const since = Date.now() - hours * 3600000;
      const root = String(flags.root || path.join(
        process.env.DSH_HOME || path.join(os.homedir(), '.dsh'), 'sessions',
      ));
      const sources = typeof flags.source === 'string' && flags.source !== 'all'
        ? String(flags.source).split(',').map((x) => x.trim()).filter(Boolean)
        : null;

      const stats = harvestSessions(db, { root, since, sources, tz, dryRun: Boolean(flags['dry-run']) });
      const verb = flags['dry-run'] ? '可归档' : '新增';
      console.log(`会话文件 ${stats.files} 个，${verb}事件 ${stats.added} 条，跳过 ${stats.skipped} 条`);
      for (const item of stats.sessions.filter((x) => x.added > 0)) {
        console.log(`  ${item.source.padEnd(4)} ${item.sessionId.slice(0, 24)}  +${item.added}`);
      }

      if (typeof flags.summarizer === 'string') {
        const from = startOf(since, 'day', tz);
        // 默认只摘"已经过完的日子"：凌晨跑批时，今天的桶还只有几个小时，
        // 现在摘一遍、明天再摘一遍，纯属浪费调用。--include-today 可以强制包含今天。
        const to = flags['include-today'] ? Date.now() : startOf(Date.now(), 'day', tz);
        const summarize = createCommandSummarizer(String(flags.summarizer), {
          timeoutMs: Number(flags.timeout) || 180000,
        });
        const levels = typeof flags.levels === 'string'
          ? String(flags.levels).split(',').map((x) => x.trim()).filter(Boolean)
          : undefined;

        const out = await runDreamSummaries(db, {
          summarize, tz, from, to, levels,
          log: (line) => console.log(`  ${line}`),
        });
        console.log(out.done || out.failed
          ? `摘要：完成 ${out.done} 个，失败 ${out.failed} 个`
          : '没有待摘要的桶。');
        return out.failed ? 1 : 0;
      }
      return 0;
    }

    if (command === 'secret') {
      const sub = positional[1];
      if (sub === 'list') {
        const rows = listSecrets();
        if (flags.json) { console.log(JSON.stringify(rows, null, 2)); return 0; }
        if (!rows.length) { console.log('还没有存任何密钥。'); return 0; }
        for (const row of rows) console.log(`${row.key}  =  ${row.masked}`);
        return 0;
      }
      if (sub === 'set') {
        const key = positional[2];
        if (!key) throw new Error('用法：whalefall secret set <键名> [--value <值>]');
        let value = typeof flags.value === 'string' ? flags.value : '';
        if (!value && flags.prompt) value = await promptSecret('密钥值（输入不回显）: ');
        if (!value) {
          if (process.stdin.isTTY) {
            throw new Error('没有 --value，且 stdin 是终端；用 --prompt 交互输入，或用管道');
          }
          value = fs.readFileSync(0, 'utf8').trim();
        }
        const out = setSecret(key, value);
        console.log(`已写入 ${out.key}（${out.masked}）→ ${out.file}（权限 600）`);
        return 0;
      }
      if (sub === 'rm' || sub === 'delete') {
        const key = positional[2];
        if (!key) throw new Error('用法：whalefall secret rm <键名>');
        const out = deleteSecret(key);
        console.log(out.deleted ? `已删除 ${out.key}` : `没有 ${out.key}`);
        return 0;
      }
      throw new Error('用法：whalefall secret set|list|rm');
    }

    if (command === 'serve') {
      const persona = loadPersona(personaDirOf(flags.persona));
      const token = typeof flags.token === 'string' && flags.token.length >= 16
        ? String(flags.token)
        : crypto.randomBytes(24).toString('hex');
      const responder = typeof flags.responder === 'string'
        ? createCommandResponder(String(flags.responder), { timeoutMs: Number(flags.timeout) || 60000 })
        : async ({ text }) => `（还没接模型）我听到你说：${text}`;

      const server = createGateway({ db, token, persona, responder, tz, pollMs: 1000 });
      const host = String(flags.host || '127.0.0.1');
      const port = Number(flags.port) || 8787;
      await new Promise((resolve, reject) => {
        server.once('error', reject);
        server.listen(port, host, resolve);
      });
      console.log(`whalefall gateway 已启动：http://${host}:${port}`);
      console.log(`token: ${token}`);
      if (host === '0.0.0.0') console.log('⚠ 正在监听所有网卡：请确保这个端口只在可信局域网内可达');
      console.log('Ctrl+C 退出');
      await new Promise(() => {});
      return 0;
    }

    if (command === 'heartbeat') {
      const persona = loadPersona(personaDirOf(flags.persona));
      const now = flags.now ? parseTime(flags.now, tz) : Date.now();
      if (positional[1] === 'record') {
        const text = String(flags.text || positional.slice(2).join(' ') || '').trim();
        if (!text) throw new Error('heartbeat record 需要 --text "<说过的话>"');
        const out = recordHeartbeat(db, {
          text,
          kind: String(flags.kind || 'proactive'),
          thread: flags.thread != null ? Number(flags.thread) : null,
          now,
          policy: persona?.policy ?? null,
        });
        console.log(`已记录 #${out.id}`);
        console.log(
          out.nextFollowUpAt == null
            ? '这条线不追了（到上限）'
            : `下一次最早：${formatLocal(out.nextFollowUpAt, tz)}`,
        );
        if (out.nextFollowUpAt != null) console.log(`nextCheckAt: ${new Date(out.nextFollowUpAt).toISOString()}`);
        return 0;
      }
      const status = heartbeatStatus(db, { persona, now, tz });
      if (flags.json) { console.log(JSON.stringify(status, null, 2)); return 0; }
      console.log(`${status.local}  今天已主动 ${status.todayCount} 次`);
      console.log(`建议：${status.suggest}  —— ${status.why}`);
      if (status.lastProactive) {
        const p = status.lastProactive;
        console.log(`上一条：${formatLocal(p.ts, tz)}（${p.ageMinutes} 分钟前，${p.replied ? '已回' : '没回'}）${p.text}`);
      }
      if (status.lastChat) console.log(`最近对话：${formatLocal(status.lastChat.ts, tz)}  ${status.lastChat.title}`);
      if (status.busySignal) console.log('信号：老大最近说过"忙/开会/加班"之类的话');
      return 0;
    }

    if (command === 'tick') {
      const persona = loadPersona(personaDirOf(flags.persona));
      const now = flags.now ? parseTime(flags.now, tz) : Date.now();
      let memoryText = typeof flags.memory === 'string' ? flags.memory : '';
      if (!memoryText && typeof flags.q === 'string') {
        memoryText = buildContext(db, { q: String(flags.q), budget: 400, tz }).text;
      }
      if (!memoryText && flags.recent) {
        memoryText = buildContext(db, { budget: 400, tz }).text;
      }

      if (flags['dry-run']) {
        const history = proactiveHistory(db, { since: now - 3 * 86400000 });
        const verdict = evaluateProactive({
          now,
          policy: persona.policy?.proactive ?? {},
          history,
          tz,
        });
        console.log(JSON.stringify({
          verdict,
          prompt: buildProactivePrompt({ persona, now, tz, memoryText, history }),
        }, null, 2));
        return 0;
      }

      let compose;
      if (typeof flags.text === 'string') compose = async () => String(flags.text);
      else if (typeof flags.command === 'string') {
        compose = createCommandComposer(String(flags.command), {
          tz,
          timeoutMs: Number(flags.timeout) || 60000,
        });
      } else {
        throw new Error('tick 需要 --text "<内容>" 或 --command "<命令>"（或用 --dry-run 先看提示词）');
      }

      const out = await proactiveTick(db, {
        persona, now, tz, compose, memoryText,
        deliver: flags.send ? (text) => sendProactive(text) : undefined,
      });
      if (out.sent) {
        const sent = out.delivery ? (out.delivery.ok ? '已投递' : `投递失败：${out.delivery.message ?? out.delivery.error}`) : '未投递';
        console.log(`已生成 #${out.id}（${sent}）：${out.text}`);
      }
      else console.log(`没发：[${out.verdict.code}] ${out.verdict.reason}`);
      return 0;
    }

    if (command === 'tools') {
      if (flags.json) { console.log(JSON.stringify(TOOL_DEFINITIONS, null, 2)); return 0; }
      for (const t of TOOL_DEFINITIONS) console.log(`${t.name}  —  ${t.description}`);
      return 0;
    }

    if (command === 'tool') {
      const name = positional[1];
      if (!name) throw new Error('tool 需要一个工具名（whalefall tools 查看）');
      let args = {};
      if (typeof flags.args === 'string') {
        try { args = JSON.parse(flags.args); } catch (e) { throw new Error(`--args 不是合法 JSON：${e.message}`); }
      }
      for (const [key, value] of Object.entries(flags)) {
        if (['args', 'db', 'json', 'tz'].includes(key)) continue;
        if (value === true || value === false) continue;
        args[key] = value;
      }
      const result = callTool(db, name, args, { tz });
      console.log(JSON.stringify(result, null, 2));
      return result.ok === false ? 1 : 0;
    }

    if (command === 'proactive') {
      const sub = positional[1];
      if (sub === 'log') {
        const rows = proactiveHistory(db);
        if (flags.json) { console.log(JSON.stringify(rows, null, 2)); return 0; }
        if (!rows.length) { console.log('还没有主动记录。'); return 0; }
        for (const r of rows) console.log(`${formatLocal(r.ts, tz)}  [${r.kind}]  ${r.text}`);
        return 0;
      }
      if (sub === 'record') {
        const text = String(flags.text || positional.slice(2).join(' ') || '');
        if (!text) throw new Error('proactive record 需要内容');
        const id = recordProactiveSend(db, { text, kind: String(flags.kind || 'ping') });
        console.log(`已记录 #${id}`);
        return 0;
      }
      // 默认 check
      const persona = flags.persona === false ? null : loadPersona(personaDirOf(flags.persona));
      const policy = persona?.policy?.proactive ?? { enabled: false };
      const now = flags.now ? parseTime(flags.now, tz) : Date.now();
      const since = now - 2 * 86400000;
      const history = proactiveHistory(db, { since });
      const verdict = evaluateProactive({
        now,
        policy,
        history,
        lastUserMessageAt: flags['user-last'] ? parseTime(flags['user-last'], tz) : null,
        hasSubstance: flags.substance !== false,
        tz,
      });
      if (flags.json) { console.log(JSON.stringify({ verdict, now, history: history.length }, null, 2)); return 0; }
      console.log(`${verdict.ok ? '✅ 可以开口' : '⛔ 不说话'}  [${verdict.code}]  ${verdict.reason}`);
      return 0;
    }

    if (command === 'persona') {
      const dir = personaDirOf(flags.dir);
      const persona = loadPersona(dir);
      const rendered = renderPersona(persona);
      if (flags.json) {
        console.log(JSON.stringify({
          id: persona.id, name: persona.name, version: persona.version,
          examples: persona.examples.length, tokens: rendered.tokens, text: rendered.text,
        }, null, 2));
        return 0;
      }
      console.log(rendered.text);
      console.log(`\n-- ${rendered.tokens} tokens · v${persona.version}`);
      return 0;
    }

    if (command === 'personas') {
      const list = listPersonas(String(flags.dir || 'personas'));
      if (flags.json) { console.log(JSON.stringify(list, null, 2)); return 0; }
      if (!list.length) { console.log('没有找到人格包。'); return 0; }
      for (const p of list) console.log(`${p.name}  (${p.id} v${p.version})  ${p.dir}`);
      return 0;
    }

    if (command === 'ask') {
      const question = positional.slice(1).join(' ');
      if (!question) throw new Error('ask 需要一个问题');
      const entities = db.prepare('SELECT name FROM entities ORDER BY id').all().map((r) => r.name);
      const plan = planQuery(question, { now: Date.now(), tz, entities });
      const hits = searchByPlan(db, plan, { limit: Number(flags.limit) || 3 });
      if (flags.json) { console.log(JSON.stringify({ plan, hits }, null, 2)); return 0; }
      const range = plan.from == null ? '不限时间' : `${formatLocal(plan.from, tz)} → ${formatLocal(plan.to, tz)}`;
      console.log(`计划：实体=${plan.entity ?? '-'}  时间=${range}`);
      console.log(`词项：${plan.terms.join(' / ') || '(无)'}`);
      console.log('');
      if (!hits.length) { console.log('没找到。'); return 0; }
      for (const e of hits) console.log(fmtEvent(e), '\n');
      return 0;
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
        console.log(`${formatLocal(row.bucketStart, tz)}  ${row.level}/${row.source}  ${row.promptVersion}  ${row.sourceCount} 条`);
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
      const entities = db.prepare('SELECT name FROM entities ORDER BY id').all().map((r) => r.name);
      const planner = flags.nl
        ? (q) => planQuery(q.question, { now: Date.now(), tz, entities })
        : null;
      const suite = {
        easy: runQuestions(db, map, easy, { k, tz, planner }),
        hard: hard ? runQuestions(db, map, hard, { k, tz, planner }) : null,
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

process.on('SIGINT', () => { console.log('\n再见。'); process.exit(0); });

main()
  .then((code) => { process.exitCode = code; })
  .catch((error) => {
    console.error(`错误：${error?.message ?? error}`);
    process.exitCode = 1;
  });
