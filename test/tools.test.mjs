import test from 'node:test';
import assert from 'node:assert/strict';
import { openDb, closeDb } from '../src/db.mjs';
import { addEvent } from '../src/events.mjs';
import { callTool, TOOL_DEFINITIONS } from '../src/tools.mjs';
import { listSummaries, upsertSummary } from '../src/summaries.mjs';
import { planRollup } from '../src/rollup.mjs';
import { startOf } from '../src/time.mjs';

const SH = 'Asia/Shanghai';
const DAY = Date.parse('2026-11-01T00:00:00+08:00');

test('工具定义：名字唯一、都有 inputSchema', () => {
  const names = TOOL_DEFINITIONS.map((t) => t.name);
  assert.equal(new Set(names).size, names.length);
  assert.ok(names.includes('memory_search'));
  for (const tool of TOOL_DEFINITIONS) {
    assert.equal(tool.inputSchema.type, 'object');
    assert.ok(tool.description.length > 5);
  }
});

test('remember → search → get 闭环', () => {
  const db = openDb(':memory:');
  try {
    const created = callTool(db, 'memory_remember', {
      title: '午饭', body: '猪脚饭，好吃', ts: '2026-11-01 12:30',
    }, { tz: SH });
    assert.equal(created.ok, true);
    assert.ok(created.id > 0);

    const found = callTool(db, 'memory_search', { q: '猪脚饭' }, { tz: SH });
    assert.equal(found.ok, true);
    assert.equal(found.count, 1);
    assert.equal(found.items[0].id, created.id);

    const got = callTool(db, 'memory_get', { id: created.id }, { tz: SH });
    assert.equal(got.ok, true);
    assert.equal(got.event.body, '猪脚饭，好吃');
  } finally {
    closeDb(db);
  }
});

test('remember 去重：同一内容不会写两次', () => {
  const db = openDb(':memory:');
  try {
    const a = callTool(db, 'memory_remember', { title: 'x', body: 'y', ts: '2026-11-01 12:00' }, { tz: SH });
    const b = callTool(db, 'memory_remember', { title: 'x', body: 'y', ts: '2026-11-01 12:00' }, { tz: SH });
    assert.equal(a.id, b.id);
    assert.equal(b.deduplicated, true);
  } finally {
    closeDb(db);
  }
});

test('forget：真删原文 + 摘要标脏 + 可被重新摘要', () => {
  const db = openDb(':memory:');
  try {
    const { id } = callTool(db, 'memory_remember', { title: '午饭', body: '猪脚饭', ts: '2026-11-01 12:30' }, { tz: SH });
    // 同一天还有别的记忆：删掉一条后，这个日桶仍然应该被重新摘要
    addEvent(db, { title: '晚饭', body: '火锅', ts: '2026-11-01 19:00', tz: SH });
    upsertSummary(db, {
      level: 'day', ts: DAY + 12 * 3600000, tz: SH, text: '这天吃了猪脚饭', sourceCount: 1,
    });
    assert.equal(listSummaries(db, { level: 'day' })[0].status, 'ready');

    const forgotten = callTool(db, 'memory_forget', { id }, { tz: SH });
    assert.equal(forgotten.ok, true);
    assert.equal(forgotten.deleted, true);
    assert.equal(forgotten.staleSummaries, 1);

    assert.equal(callTool(db, 'memory_search', { q: '猪脚饭' }, { tz: SH }).count, 0);
    assert.equal(callTool(db, 'memory_get', { id }, { tz: SH }).ok, false);

    const rows = listSummaries(db, { level: 'day' });
    assert.equal(rows[0].status, 'stale');

    const plan = planRollup(db, {
      level: 'day', tz: SH,
      from: startOf(DAY + 3600000, 'day', SH),
      to: startOf(DAY + 86400000, 'day', SH),
    });
    assert.equal(plan.length, 1);
  } finally {
    closeDb(db);
  }
});

test('timeline 按日期取，且正序', () => {
  const db = openDb(':memory:');
  try {
    addEvent(db, { title: '早', body: '', ts: '2026-11-01 08:00', tz: SH });
    addEvent(db, { title: '晚', body: '', ts: '2026-11-01 20:00', tz: SH });
    const out = callTool(db, 'memory_timeline', { date: '2026-11-01' }, { tz: SH });
    assert.equal(out.ok, true);
    assert.deepEqual(out.items.map((i) => i.title), ['早', '晚']);
  } finally {
    closeDb(db);
  }
});

test('summary 工具：没有摘要时返回 null + hint', () => {
  const db = openDb(':memory:');
  try {
    const out = callTool(db, 'memory_summary', { level: 'day', date: '2026-11-01' }, { tz: SH });
    assert.equal(out.ok, true);
    assert.equal(out.summary, null);
    assert.match(out.hint, /还没有摘要/);
  } finally {
    closeDb(db);
  }
});

test('参数错误返回 ok:false，而不是抛异常；未知工具才抛', () => {
  const db = openDb(':memory:');
  try {
    assert.equal(callTool(db, 'memory_get', {}, { tz: SH }).ok, false);
    assert.equal(callTool(db, 'memory_forget', {}, { tz: SH }).ok, false);
    assert.throws(() => callTool(db, 'memory_nope', {}, { tz: SH }), /未知工具/);
  } finally {
    closeDb(db);
  }
});
