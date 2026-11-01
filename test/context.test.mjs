import test from 'node:test';
import assert from 'node:assert/strict';
import { openDb, closeDb } from '../src/db.mjs';
import { addEvent } from '../src/events.mjs';
import { upsertSummary } from '../src/summaries.mjs';
import { buildContext, estimateTokens } from '../src/context.mjs';

const SH = 'Asia/Shanghai';

function seed(db) {
  const base = Date.parse('2026-11-01T00:00:00+08:00');
  addEvent(db, { title: '午饭', body: '猪脚饭，好吃', kind: 'meal', ts: base + 12 * 3600000, tz: SH });
  addEvent(db, { title: '和小鲸鱼聊天', body: '聊到记忆分层', ts: base + 20 * 3600000, tz: SH, actors: ['小鲸鱼'] });
  addEvent(db, { title: '健身房', body: '硬拉 60 公斤', ts: base + 2 * 86400000, tz: SH });
}

test('token 估算：汉字接近 1 字 1 token', () => {
  assert.equal(estimateTokens(''), 0);
  assert.ok(estimateTokens('你好世界') >= 4);
  assert.ok(estimateTokens('hello world') < 5);
  assert.ok(estimateTokens('你好 world') >= 3);
});

test('命中块优先，且带 event id 方便回查', () => {
  const db = openDb(':memory:');
  try {
    seed(db);
    const ctx = buildContext(db, { q: '猪脚饭', budget: 400 });
    assert.match(ctx.text, /猪脚饭/);
    assert.match(ctx.text, /#\d+/);
    assert.equal(ctx.blocks[0].kind, 'hits');
    assert.ok(ctx.used <= ctx.budget);
  } finally {
    closeDb(db);
  }
});

test('摘要块会出现在上下文里', () => {
  const db = openDb(':memory:');
  try {
    seed(db);
    upsertSummary(db, {
      level: 'day',
      ts: Date.parse('2026-11-01T12:00:00+08:00'),
      tz: SH,
      text: '这天吃了猪脚饭，晚上和小鲸鱼聊记忆',
      sourceCount: 2,
    });
    const ctx = buildContext(db, { q: '记忆', budget: 600 });
    assert.ok(ctx.blocks.some((b) => b.kind === 'summaries'));
    assert.match(ctx.text, /和小鲸鱼聊记忆/);
  } finally {
    closeDb(db);
  }
});

test('预算紧时宁可少给，也不超预算', () => {
  const db = openDb(':memory:');
  try {
    seed(db);
    for (const budget of [80, 120, 200, 400]) {
      const ctx = buildContext(db, { q: '猪脚饭', budget });
      assert.ok(ctx.used <= budget, `budget ${budget} 超了：${ctx.used}`);
    }
  } finally {
    closeDb(db);
  }
});

test('空库返回空上下文', () => {
  const db = openDb(':memory:');
  try {
    const ctx = buildContext(db, { q: '什么也没有', budget: 300 });
    assert.equal(ctx.text, '');
    assert.equal(ctx.used, 0);
    assert.equal(ctx.blocks.length, 0);
  } finally {
    closeDb(db);
  }
});
