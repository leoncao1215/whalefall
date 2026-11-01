import test from 'node:test';
import assert from 'node:assert/strict';
import { openDb, closeDb } from '../src/db.mjs';
import { addEvent } from '../src/events.mjs';
import { planRollup, runRollup } from '../src/rollup.mjs';
import { listSummaries, summaryAt, upsertSummary } from '../src/summaries.mjs';

const SH = 'Asia/Shanghai';

function fresh() {
  return openDb(':memory:');
}

function seedThreeDays(db) {
  const base = Date.parse('2026-11-01T00:00:00+08:00');
  for (let d = 0; d < 3; d += 1) {
    addEvent(db, {
      title: `第${d + 1}天的午饭`,
      body: d === 0 ? '猪脚饭，好吃' : '随便吃了点',
      ts: base + d * 86400000 + 12 * 3600000,
      tz: SH,
    });
  }
  return { from: base, to: base + 4 * 86400000 };
}

test('rollup：plan → apply → 再 plan 为空 → 换版本再来一遍', async () => {
  const db = fresh();
  try {
    const { from, to } = seedThreeDays(db);

    const plan = planRollup(db, { level: 'day', tz: SH, from, to });
    assert.equal(plan.length, 3);
    assert.equal(plan[0].count, 1);
    assert.equal(plan[0].key, '2026-11-01');

    const result = await runRollup(db, plan, async ({ bucket, events }) => ({
      text: `${bucket.key}：${events.map((e) => `${e.title} / ${e.body}`).join('；')}`,
      model: 'fake-model',
    }));
    assert.equal(result.ok.length, 3);
    assert.equal(result.failed.length, 0);

    const summaries = listSummaries(db, { level: 'day' });
    assert.equal(summaries.length, 3);
    assert.equal(summaries[0].sourceCount, 1);
    assert.ok(summaries.some((s) => s.text.includes('猪脚饭')));

    assert.equal(planRollup(db, { level: 'day', tz: SH, from, to }).length, 0);

    const v2 = planRollup(db, { level: 'day', tz: SH, from, to, promptVersion: 'v2' });
    assert.equal(v2.length, 3);
  } finally {
    closeDb(db);
  }
});

test('按来源切分：qq 桶只算 qq 的事件，合并桶算全部', () => {
  const db = fresh();
  try {
    const base = Date.parse('2026-11-01T00:00:00+08:00');
    addEvent(db, { title: 'qq 聊天', body: 'QQ 里说的话', ts: base + 10 * 3600000, tz: SH, source: 'qq' });
    addEvent(db, { title: 'web 聊天', body: 'web 里说的话', ts: base + 11 * 3600000, tz: SH, source: 'web' });

    const all = planRollup(db, { level: 'day', tz: SH, from: base, to: base + 86400000 });
    assert.equal(all.length, 1);
    assert.equal(all[0].count, 2);
    assert.equal(all[0].source, 'all');

    const qqPlan = planRollup(db, { level: 'day', tz: SH, from: base, to: base + 86400000, source: 'qq' });
    assert.equal(qqPlan.length, 1);
    assert.equal(qqPlan[0].count, 1);
    assert.equal(qqPlan[0].source, 'qq');

    const webPlan = planRollup(db, { level: 'day', tz: SH, from: base, to: base + 86400000, source: 'web' });
    assert.equal(webPlan[0].count, 1);
  } finally {
    closeDb(db);
  }
});

test('不同来源的摘要共存，互不覆盖', async () => {
  const db = fresh();
  try {
    const base = Date.parse('2026-11-01T00:00:00+08:00');
    addEvent(db, { title: 'qq', body: 'a', ts: base + 3600000, tz: SH, source: 'qq' });
    addEvent(db, { title: 'web', body: 'b', ts: base + 7200000, tz: SH, source: 'web' });

    for (const source of ['qq', 'web', null]) {
      const plan = planRollup(db, { level: 'day', tz: SH, from: base, to: base + 86400000, source });
      assert.equal(plan.length, 1);
      await runRollup(db, plan, async ({ events }) => ({ text: `${source ?? 'all'}:${events.length}` }), { tz: SH });
    }

    const rows = listSummaries(db, { level: 'day' });
    assert.equal(rows.length, 3);
    assert.deepEqual(rows.map((r) => r.source).sort(), ['all', 'qq', 'web']);
    assert.equal(summaryAt(db, base + 3600000, 'day', { tz: SH, source: 'qq' }).text, 'qq:1');
    assert.equal(summaryAt(db, base + 3600000, 'day', { tz: SH }).text, 'all:2');
  } finally {
    closeDb(db);
  }
});

test('同一天新增事件后，需要重新摘要', async () => {
  const db = fresh();
  try {
    const { from, to } = seedThreeDays(db);
    const summarize = async ({ bucket, events }) => ({ text: `${bucket.key}：${events.length} 条` });

    const first = planRollup(db, { level: 'day', tz: SH, from, to });
    await runRollup(db, first, summarize, { tz: SH });
    assert.equal(planRollup(db, { level: 'day', tz: SH, from, to }).length, 0);

    // 同一天又来了一条新对话
    const base = Date.parse('2026-11-01T00:00:00+08:00');
    addEvent(db, { title: '新事件', body: '夜里又聊了两句', ts: base + 22 * 3600000, tz: SH });

    const again = planRollup(db, { level: 'day', tz: SH, from, to });
    assert.equal(again.length, 1);
    assert.equal(again[0].key, '2026-11-01');
    assert.equal(again[0].count, 2);
  } finally {
    closeDb(db);
  }
});

test('单桶失败不影响其它桶', async () => {
  const db = fresh();
  try {
    const { from, to } = seedThreeDays(db);
    const plan = planRollup(db, { level: 'day', tz: SH, from, to });
    let n = 0;
    const result = await runRollup(db, plan, async ({ bucket }) => {
      n += 1;
      if (n === 2) throw new Error('模型超时');
      return { text: `ok ${bucket.key}` };
    });
    assert.equal(result.ok.length, 2);
    assert.equal(result.failed.length, 1);
    assert.equal(listSummaries(db, { level: 'day' }).length, 2);
  } finally {
    closeDb(db);
  }
});

test('stale 摘要不会再被 summaryAt 返回', () => {
  const db = fresh();
  try {
    const ts = Date.parse('2026-11-01T12:00:00+08:00');
    const s = upsertSummary(db, { level: 'day', ts, tz: SH, text: '待作废', sourceCount: 1 });
    db.prepare("UPDATE summaries SET status = 'stale' WHERE id = ?").run(s.id);
    assert.equal(summaryAt(db, ts, 'day', { tz: SH }), null);
    assert.equal(listSummaries(db, { level: 'day', status: 'ready' }).length, 0);
  } finally {
    closeDb(db);
  }
});

test('summaryAt 能按时刻找到对应层级摘要', () => {
  const db = fresh();
  try {
    const ts = Date.parse('2026-11-01T12:00:00+08:00');
    upsertSummary(db, { level: 'day', ts, tz: SH, text: '当天摘要', sourceCount: 1 });
    const hit = summaryAt(db, ts, 'day', { tz: SH });
    assert.equal(hit.text, '当天摘要');
    assert.equal(summaryAt(db, ts + 86400000, 'day', { tz: SH }), null);
  } finally {
    closeDb(db);
  }
});
