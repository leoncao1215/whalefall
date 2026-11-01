import test from 'node:test';
import assert from 'node:assert/strict';
import { openDb, closeDb } from '../src/db.mjs';
import { addEvent } from '../src/events.mjs';
import { extractTerms, parseTimeHints, planQuery, searchByPlan } from '../src/query.mjs';

const SH = 'Asia/Shanghai';
const NOW = Date.parse('2026-11-01T15:00:00+08:00'); // 周日

test('时间词：今天 / 昨天 / 前天', () => {
  const today = parseTimeHints('今天吃了什么', NOW, SH);
  assert.equal(today.from, Date.parse('2026-11-01T00:00:00+08:00'));
  assert.equal(today.to, Date.parse('2026-11-02T00:00:00+08:00'));

  const yesterday = parseTimeHints('昨天呢', NOW, SH);
  assert.equal(yesterday.from, Date.parse('2026-10-31T00:00:00+08:00'));

  const before = parseTimeHints('前天', NOW, SH);
  assert.equal(before.from, Date.parse('2026-10-30T00:00:00+08:00'));
});

test('时间词：上周三（当前周从 10-26 开始）', () => {
  const range = parseTimeHints('上周三午饭吃了什么', NOW, SH);
  assert.equal(range.from, Date.parse('2026-10-21T00:00:00+08:00'));
  assert.equal(range.to, Date.parse('2026-10-22T00:00:00+08:00'));
});

test('时间词：上个月 / 最近 N 天 / 具体日期', () => {
  const lastMonth = parseTimeHints('上个月都在忙什么', NOW, SH);
  assert.equal(lastMonth.from, Date.parse('2026-10-01T00:00:00+08:00'));
  assert.equal(lastMonth.to, Date.parse('2026-11-01T00:00:00+08:00'));

  const recent = parseTimeHints('最近 3 天', NOW, SH);
  assert.equal(recent.from, Date.parse('2026-10-30T00:00:00+08:00'));
  assert.equal(recent.to, Date.parse('2026-11-02T00:00:00+08:00'));

  const day = parseTimeHints('2026-10-14 那天', NOW, SH);
  assert.equal(day.from, Date.parse('2026-10-14T00:00:00+08:00'));

  assert.equal(parseTimeHints('你好', NOW, SH), null);
});

test('切词：去停用词，保留实词', () => {
  const terms = extractTerms('我上次吃猪脚饭觉得怎么样');
  assert.ok(terms.includes('猪脚饭'), terms.join(','));
  assert.ok(!terms.includes('我'));
  assert.ok(!terms.includes('觉得'));
  assert.ok(!terms.includes('怎么样'));
});

test('计划：识别时间与实体', () => {
  const plan = planQuery('上周和小鲸鱼聊了什么', {
    now: NOW, tz: SH, entities: ['小鲸鱼', '阿哲'],
  });
  assert.equal(plan.entity, '小鲸鱼');
  assert.equal(plan.from, Date.parse('2026-10-19T00:00:00+08:00'));
  assert.equal(plan.to, Date.parse('2026-10-26T00:00:00+08:00'));
  assert.ok(plan.terms.length > 0);
});

test('按计划检索：自然语言问句能找到那条记忆', () => {
  const db = openDb(':memory:');
  try {
    const base = Date.parse('2026-10-14T00:00:00+08:00');
    addEvent(db, { title: '午饭', body: '公司楼下的猪脚饭，今天偏咸', kind: 'meal', ts: base + 12 * 3600000, tz: SH });
    addEvent(db, { title: '午饭', body: '麻辣烫，加了两份丸子', kind: 'meal', ts: base + 86400000 + 12 * 3600000, tz: SH });
    addEvent(db, { title: '猫', body: '楼下的橘猫又来了', ts: base + 2 * 86400000, tz: SH });

    const plan = planQuery('我上次吃猪脚饭觉得怎么样', { now: NOW, tz: SH });
    const hits = searchByPlan(db, plan, { limit: 3 });
    assert.ok(hits.length >= 1);
    assert.match(hits[0].body, /猪脚饭/);

    const catPlan = planQuery('楼下那只猫', { now: NOW, tz: SH });
    const catHits = searchByPlan(db, catPlan, { limit: 3 });
    assert.match(catHits[0].title, /猫/);
  } finally {
    closeDb(db);
  }
});

test('按计划检索：时间窗生效', () => {
  const db = openDb(':memory:');
  try {
    const d1 = Date.parse('2026-10-14T12:00:00+08:00');
    addEvent(db, { title: '午饭', body: '猪脚饭', kind: 'meal', ts: d1, tz: SH });
    addEvent(db, { title: '午饭', body: '猪脚饭', kind: 'meal', ts: d1 + 86400000, tz: SH });

    const plan = planQuery('今天吃猪脚饭了吗', { now: d1, tz: SH });
    const hits = searchByPlan(db, plan, { limit: 5 });
    assert.equal(hits.length, 1);
    assert.equal(hits[0].ts, d1);
  } finally {
    closeDb(db);
  }
});
