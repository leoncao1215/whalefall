import test from 'node:test';
import assert from 'node:assert/strict';
import { openDb, closeDb } from '../src/db.mjs';
import { addEvent } from '../src/events.mjs';
import { planRollup, runRollup } from '../src/rollup.mjs';
import { upsertSummary, listSummaries } from '../src/summaries.mjs';
import { planSummaryRollup, runSummaryRollup } from '../src/hierarchy.mjs';

const SH = 'Asia/Shanghai';
const DAY = Date.parse('2026-11-02T00:00:00+08:00'); // 周一，保证三天同一周

function seedDaySummaries(db, source = 'qq') {
  // 11-01 周一 与 11-02 周二，同一周（11-02 起是 W45）
  const days = [
    Date.parse('2026-11-02T00:00:00+08:00'),
    Date.parse('2026-11-03T00:00:00+08:00'),
  ];
  days.forEach((ts, i) => {
    upsertSummary(db, {
      level: 'day', ts, tz: SH, source, text: `第 ${i + 1} 天的摘要`, sourceCount: 1,
    });
  });
  return days;
}

test('周摘要从日摘要聚合，父桶覆盖两个日桶', () => {
  const db = openDb(':memory:');
  try {
    seedDaySummaries(db, 'qq');
    const plan = planSummaryRollup(db, { level: 'week', source: 'qq', tz: SH, from: DAY, to: DAY + 7 * 86400000 });
    assert.equal(plan.length, 1);
    assert.equal(plan[0].children.length, 2);
    assert.match(plan[0].key, /^2026-W\d\d$/);
  } finally {
    closeDb(db);
  }
});

test('生成周摘要后不再重复规划；子摘要更新则重新变脏', async () => {
  const db = openDb(':memory:');
  try {
    seedDaySummaries(db, 'qq');
    const range = { level: 'week', source: 'qq', tz: SH, from: DAY, to: DAY + 7 * 86400000 };

    const plan = planSummaryRollup(db, range);
    const { ok } = await runSummaryRollup(db, plan, async ({ events }) => ({ text: `周：${events.length} 天` }), { tz: SH });
    assert.equal(ok.length, 1);
    assert.equal(planSummaryRollup(db, range).length, 0);

    // 再更新一次某天的摘要 → 周摘要应该变脏
    upsertSummary(db, {
      level: 'day', ts: Date.parse('2026-11-02T00:00:00+08:00'), tz: SH, source: 'qq',
      text: '第 1 天改过了', sourceCount: 2,
    });
    const again = planSummaryRollup(db, range);
    assert.equal(again.length, 1);
  } finally {
    closeDb(db);
  }
});

test('all 视图从各来源同层摘要聚合', async () => {
  const db = openDb(':memory:');
  try {
    const range = { level: 'week', tz: SH, from: DAY, to: DAY + 7 * 86400000 };
    for (const source of ['qq', 'web']) {
      seedDaySummaries(db, source);
      const plan = planSummaryRollup(db, { ...range, source });
      await runSummaryRollup(db, plan, async ({ events }) => ({ text: `${source} 周：${events.length} 天` }), { tz: SH });
    }

    const all = planSummaryRollup(db, {
      ...range, source: 'all', childLevel: 'week', childSource: null,
    });
    assert.equal(all.length, 1);
    assert.equal(all[0].children.length, 2); // qq 周 + web 周
    assert.deepEqual(all[0].children.map((c) => c.source).sort(), ['qq', 'web']);
  } finally {
    closeDb(db);
  }
});

test('窗口从周三开始，也能聚合到这一周（子桶起点早于 from）', () => {
  const db = openDb(':memory:');
  try {
    seedDaySummaries(db, 'qq');
    const wednesday = Date.parse('2026-11-04T00:00:00+08:00');
    const plan = planSummaryRollup(db, { level: 'week', source: 'qq', tz: SH, from: wednesday, to: DAY + 7 * 86400000 });
    assert.equal(plan.length, 1);
    assert.equal(plan[0].children.length, 2);
  } finally {
    closeDb(db);
  }
});

test('日摘要 → 周摘要端到端（从事件到周摘要）', async () => {
  const db = openDb(':memory:');
  try {
    for (let d = 0; d < 3; d += 1) {
      addEvent(db, { title: `第${d}天`, body: 'x', ts: DAY + d * 86400000 + 3600000, tz: SH, source: 'qq' });
    }
    const days = planRollup(db, { level: 'day', tz: SH, from: DAY, to: DAY + 7 * 86400000, source: 'qq' });
    await runRollup(db, days, async ({ bucket }) => ({ text: `${bucket.key} 摘要` }), { tz: SH });

    const weeks = planSummaryRollup(db, { level: 'week', source: 'qq', tz: SH, from: DAY, to: DAY + 7 * 86400000 });
    assert.equal(weeks.length, 1);
    await runSummaryRollup(db, weeks, async ({ events }) => ({ text: `这一周：${events.map((e) => e.body).join(' / ')}` }), { tz: SH });

    const rows = listSummaries(db, { level: 'week', source: 'qq' });
    assert.equal(rows.length, 1);
    assert.match(rows[0].text, /这一周：/);
    assert.equal(rows[0].sourceCount, 3);
  } finally {
    closeDb(db);
  }
});
