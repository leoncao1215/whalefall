import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { openDb, closeDb } from '../src/db.mjs';
import { addEvent } from '../src/events.mjs';
import { planRollup, runRollup } from '../src/rollup.mjs';
import { listSummaries } from '../src/summaries.mjs';
import {
  buildSummarizerPrompt, createCommandSummarizer, createMockSummarizer,
  runSummarizerCommand, summarizerPayload,
} from '../src/summarizer.mjs';

const SH = 'Asia/Shanghai';
const FAKE_LLM = path.join(path.dirname(fileURLToPath(import.meta.url)), 'fixtures', 'fake-llm.mjs');

function seed(db) {
  const base = Date.parse('2026-11-01T00:00:00+08:00');
  addEvent(db, { title: '午饭', body: '猪脚饭', kind: 'meal', ts: base + 12 * 3600000, tz: SH });
  addEvent(db, { title: '聊天', body: '聊记忆架构', ts: base + 20 * 3600000, tz: SH, actors: ['小鲸鱼'] });
  addEvent(db, { title: '健身房', body: '硬拉 60 公斤', ts: base + 86400000 + 18 * 3600000, tz: SH });
  return { from: base, to: base + 3 * 86400000 };
}

test('提示词包含时间范围与全部事件', () => {
  const events = [
    { ts: Date.parse('2026-11-01T12:00:00+08:00'), tz: SH, kind: 'meal', title: '午饭', body: '猪脚饭', actors: [] },
    { ts: Date.parse('2026-11-01T20:00:00+08:00'), tz: SH, kind: 'note', title: '聊天', body: '记忆', actors: [] },
  ];
  const bucket = { key: '2026-11-01', start: 0, end: 1 };
  const prompt = buildSummarizerPrompt({ level: 'day', bucket, tz: SH, events });
  assert.match(prompt, /2026-11-01/);
  assert.match(prompt, /猪脚饭/);
  assert.match(prompt, /记忆/);
  assert.match(prompt, /只输出摘要正文/);

  const payload = summarizerPayload({ level: 'day', bucket, tz: SH, events });
  assert.equal(payload.events.length, 2);
  assert.equal(payload.level, 'day');
  assert.ok(payload.prompt.length > 20);
});

test('外部命令摘要器：读 stdin、回 JSON', async () => {
  const command = `"${process.execPath}" "${FAKE_LLM}"`;
  const result = await runSummarizerCommand(command, {
    level: 'day',
    bucket: { key: '2026-11-01', start: 0, end: 1 },
    tz: SH,
    prompt: '测试',
    events: [{ ts: 0, title: '午饭', body: '猪脚饭', kind: 'meal', actors: [] }],
  });
  assert.equal(result.model, 'fake-llm-0.1');
  assert.match(result.text, /2026-11-01/);
  assert.match(result.text, /猪脚饭/);
});

test('外部命令失败时抛出退出码', async () => {
  await assert.rejects(
    () => runSummarizerCommand(`"${process.execPath}" -e "process.exit(3)"`, { events: [] }),
    /退出码 3/,
  );
});

test('空输出视为失败', async () => {
  await assert.rejects(
    () => runSummarizerCommand(`"${process.execPath}" -e "process.exit(0)"`, { events: [] }),
    /没有输出/,
  );
});

test('rollup 端到端：命令摘要器写库', async () => {
  const db = openDb(':memory:');
  try {
    const { from, to } = seed(db);
    const plan = planRollup(db, { level: 'day', tz: SH, from, to });
    assert.equal(plan.length, 2);

    const summarize = createCommandSummarizer(`"${process.execPath}" "${FAKE_LLM}"`);
    const { ok, failed } = await runRollup(db, plan, summarize, { tz: SH });
    assert.equal(ok.length, 2);
    assert.equal(failed.length, 0);

    const rows = listSummaries(db, { level: 'day' });
    assert.equal(rows.length, 2);
    assert.ok(rows.every((r) => r.model === 'fake-llm-0.1'));
    assert.ok(rows.some((r) => r.text.includes('猪脚饭')));

    // 已经摘过的桶不会再被 plan 选中
    assert.equal(planRollup(db, { level: 'day', tz: SH, from, to }).length, 0);
  } finally {
    closeDb(db);
  }
});

test('mock 摘要器可用（无模型时跑通链路）', async () => {
  const db = openDb(':memory:');
  try {
    const { from, to } = seed(db);
    const plan = planRollup(db, { level: 'week', tz: SH, from, to });
    const { ok } = await runRollup(db, plan, createMockSummarizer(), { tz: SH });
    assert.ok(ok.length >= 1);
    assert.ok(listSummaries(db, { level: 'week' }).every((r) => r.model === 'mock'));
  } finally {
    closeDb(db);
  }
});
