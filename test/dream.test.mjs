import test from 'node:test';
import assert from 'node:assert/strict';
import { openDb, closeDb } from '../src/db.mjs';
import { addEvent } from '../src/events.mjs';
import { listSummaries } from '../src/summaries.mjs';
import { runDreamSummaries } from '../src/dream.mjs';

const SH = 'Asia/Shanghai';
const BASE = Date.parse('2026-11-02T00:00:00+08:00'); // 周一

test('dream：日/周两层，按来源 + 合并视图', async () => {
  const db = openDb(':memory:');
  try {
    addEvent(db, { title: 'qq 第一天', body: 'a', ts: BASE + 3600000, tz: SH, source: 'qq' });
    addEvent(db, { title: 'web 第一天', body: 'b', ts: BASE + 7200000, tz: SH, source: 'web' });
    addEvent(db, { title: 'qq 第二天', body: 'c', ts: BASE + 86400000 + 3600000, tz: SH, source: 'qq' });

    const out = await runDreamSummaries(db, {
      tz: SH,
      from: BASE,
      to: BASE + 7 * 86400000,
      summarize: async ({ level, events }) => ({ text: `${level}:${events.length}` }),
    });

    assert.equal(out.failed, 0);
    assert.ok(out.done >= 4, `done=${out.done}`);

    const day = listSummaries(db, { level: 'day' });
    const daySources = [...new Set(day.map((s) => s.source))].sort();
    assert.deepEqual(daySources, ['all', 'qq', 'web']);

    // 合并的日摘要读的是 qq 日 + web 日 两份摘要
    const dayAll = day.find((s) => s.source === 'all' && s.bucketStart === BASE);
    assert.equal(dayAll.text, 'day:2');

    const week = listSummaries(db, { level: 'week' });
    const weekAll = week.find((s) => s.source === 'all');
    assert.equal(weekAll.text, 'week:2'); // qq 周 + web 周
    assert.equal(weekAll.sourceCount, 2);
  } finally {
    closeDb(db);
  }
});

test('dream：没有变化时不会重复调用摘要器', async () => {
  const db = openDb(':memory:');
  try {
    addEvent(db, { title: 'x', body: 'y', ts: BASE + 3600000, tz: SH, source: 'qq' });
    let calls = 0;
    const summarize = async ({ events }) => { calls += 1; return { text: `${events.length}` }; };

    const first = await runDreamSummaries(db, { tz: SH, from: BASE, to: BASE + 86400000, summarize });
    assert.ok(first.done > 0);
    const before = calls;

    const second = await runDreamSummaries(db, { tz: SH, from: BASE, to: BASE + 86400000, summarize });
    assert.equal(second.done, 0);
    assert.equal(calls, before);
  } finally {
    closeDb(db);
  }
});
