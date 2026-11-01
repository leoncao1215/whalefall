import test from 'node:test';
import assert from 'node:assert/strict';
import { openDb, closeDb } from '../src/db.mjs';
import { addEvent, ensureEntity, getEvent, linkEntity } from '../src/events.mjs';
import { searchEvents, stats, timeline } from '../src/search.mjs';
import { bucketOf, startOf } from '../src/time.mjs';

const SH = 'Asia/Shanghai';

function fresh() {
  return openDb(':memory:');
}

test('写入、读取与去重', () => {
  const db = fresh();
  try {
    const a = addEvent(db, { title: '午饭', body: '猪脚饭，好吃', ts: '2026-11-01 12:30', tz: SH });
    assert.equal(a.deduplicated, false);
    const same = addEvent(db, { title: '午饭', body: '猪脚饭，好吃', ts: '2026-11-01 12:30', tz: SH });
    assert.equal(same.id, a.id);
    assert.equal(same.deduplicated, true);
    const loaded = getEvent(db, a.uid);
    assert.equal(loaded.title, '午饭');
    assert.equal(loaded.body, '猪脚饭，好吃');
  } finally {
    closeDb(db);
  }
});

test('dedupeKey 覆盖默认哈希', () => {
  const db = fresh();
  try {
    const a = addEvent(db, { title: 'x', body: '1', dedupeKey: 'k1', ts: 1 });
    const b = addEvent(db, { title: 'y', body: '2', dedupeKey: 'k1', ts: 2 });
    assert.equal(a.id, b.id);
    assert.equal(addEvent(db, { title: 'y', body: '2', ts: 3 }).id, b.id + 1);
  } finally {
    closeDb(db);
  }
});

test('中文检索：>=3 字走 FTS，2 字退化为 LIKE', () => {
  const db = fresh();
  try {
    addEvent(db, { title: '午饭', body: '今天吃了猪脚饭，很香', ts: '2026-11-01 12:30', tz: SH });
    addEvent(db, { title: '晚饭', body: '晚上和朋友吃火锅', ts: '2026-11-01 19:00', tz: SH });
    addEvent(db, { title: '加班', body: '写代码到深夜', ts: '2026-11-02 01:00', tz: SH });

    assert.equal(searchEvents(db, { q: '猪脚饭' }).length, 1);
    assert.equal(searchEvents(db, { q: '火锅' }).length, 1);
    assert.equal(searchEvents(db, { q: '不存在的词' }).length, 0);
    // 多词 AND
    assert.equal(searchEvents(db, { q: '猪脚饭 很香' }).length, 1);
    assert.equal(searchEvents(db, { q: '猪脚饭 火锅' }).length, 0);
  } finally {
    closeDb(db);
  }
});

test('按时间与实体过滤', () => {
  const db = fresh();
  try {
    addEvent(db, { title: '和小鲸鱼吃饭', body: '聊了很久', ts: '2026-11-01 12:00', tz: SH, actors: ['小鲸鱼'] });
    addEvent(db, { title: '独自吃饭', body: '随便对付', ts: '2026-11-02 12:00', tz: SH });

    const byEntity = searchEvents(db, { entity: '小鲸鱼' });
    assert.equal(byEntity.length, 1);
    assert.equal(byEntity[0].actors[0], '小鲸鱼');

    const from = startOf(Date.parse('2026-11-02T00:00:00+08:00'), 'day', SH);
    const byTime = searchEvents(db, { from });
    assert.equal(byTime.length, 1);
    assert.equal(byTime[0].title, '独自吃饭');
  } finally {
    closeDb(db);
  }
});

test('入库前脱敏，原文里的口令不落库', () => {
  const db = fresh();
  try {
    addEvent(db, { title: '配置', body: 'password=hunter2 还有 sk-ABCDEFGHIJKLMNOP1234', ts: 1 });
    const rows = searchEvents(db, { q: '配置' });
    assert.equal(rows.length, 1);
    assert.ok(!rows[0].body.includes('hunter2'));
    assert.ok(!rows[0].body.includes('sk-ABCDEFGHIJKLMNOP1234'));
    assert.ok(rows[0].body.includes('[REDACTED]'));
  } finally {
    closeDb(db);
  }
});

test('timeline 与 stats', () => {
  const db = fresh();
  try {
    addEvent(db, { title: 'a', body: '1', ts: '2026-11-01 08:00', tz: SH });
    addEvent(db, { title: 'b', body: '2', ts: '2026-11-01 20:00', tz: SH, kind: 'meal' });
    const day = startOf(Date.parse('2026-11-01T00:00:00+08:00'), 'day', SH);
    const range = bucketOf(day, 'day', SH);
    const rows = timeline(db, { start: range.start, end: range.end });
    assert.deepEqual(rows.map((r) => r.title), ['a', 'b']);

    const s = stats(db);
    assert.equal(s.events, 2);
    assert.equal(s.byKind.find((x) => x.kind === 'meal').count, 1);
  } finally {
    closeDb(db);
  }
});

test('实体是幂等的，别名会合并', () => {
  const db = fresh();
  try {
    const e1 = ensureEntity(db, '小鲸鱼', { kind: 'person' });
    const e2 = ensureEntity(db, '小鲸鱼', { kind: 'person', aliases: ['鱼鱼'] });
    assert.equal(e1, e2);
    const a = addEvent(db, { title: 'x', body: 'y', ts: 1 });
    linkEntity(db, a.id, e1, 'topic');
    assert.equal(searchEvents(db, { entity: '小鲸鱼' }).length, 1);
  } finally {
    closeDb(db);
  }
});
