import test from 'node:test';
import assert from 'node:assert/strict';
import { openDb, closeDb } from '../src/db.mjs';
import { addEvent } from '../src/events.mjs';
import { recentThreads, renderRecentThreads } from '../src/threads.mjs';

const TZ = 'Asia/Shanghai';
const BASE = Date.parse('2026-11-01T22:00:00+08:00');

function seed(db) {
  addEvent(db, {
    title: '今天代码写完了吗', body: '用户：今天代码写完了吗\n\n助手：写完了，就是有点累',
    ts: BASE, tz: TZ, source: 'qq', kind: 'conversation', sessionId: 's-qq',
  });
  addEvent(db, {
    title: '晚上吃什么', body: '用户：晚上吃什么\n\n助手：白饭加个蛋',
    ts: BASE + 10 * 60000, tz: TZ, source: 'telegram', kind: 'conversation', sessionId: 's-tg',
  });
  addEvent(db, {
    title: '主动消息', body: '老大，快十一点了。',
    ts: BASE + 20 * 60000, tz: TZ, source: 'agent', kind: 'proactive',
  });
}

test('跨渠道：按时间正序、带渠道标签', () => {
  const db = openDb(':memory:');
  try {
    seed(db);
    const lines = recentThreads(db, { now: BASE + 30 * 60000, tz: TZ });
    assert.equal(lines.length, 3);
    assert.match(lines[0], /^\[QQ 22:00\] 老大：今天代码写完了吗 → 我：写完了/);
    assert.match(lines[1], /^\[TG 22:10\] 老大：晚上吃什么/);
    assert.match(lines[2], /^\[主动 22:20\] 我（主动）：老大，快十一点了。/);
  } finally {
    closeDb(db);
  }
});

test('跨渠道：排除当前会话，避免和上下文重复', () => {
  const db = openDb(':memory:');
  try {
    seed(db);
    const lines = recentThreads(db, { now: BASE + 30 * 60000, excludeSessionId: 's-qq', tz: TZ });
    assert.equal(lines.length, 2);
    assert.ok(lines.every((line) => !line.includes('今天代码写完了吗')));
  } finally {
    closeDb(db);
  }
});

test('超过时间窗口的不出现', () => {
  const db = openDb(':memory:');
  try {
    seed(db);
    const lines = recentThreads(db, { now: BASE + 48 * 3600000, hours: 24, tz: TZ });
    assert.equal(lines.length, 0);
  } finally {
    closeDb(db);
  }
});

test('太长会截断', () => {
  const db = openDb(':memory:');
  try {
    addEvent(db, {
      title: '长', body: `用户：${'啊'.repeat(200)}\n\n助手：${'哦'.repeat(200)}`,
      ts: BASE, tz: TZ, source: 'qq', kind: 'conversation', sessionId: 's',
    });
    const [line] = recentThreads(db, { now: BASE + 1000, clip: 20, tz: TZ });
    assert.ok(line.length < 100, line);
    assert.match(line, /…/);
  } finally {
    closeDb(db);
  }
});

test('renderRecentThreads：没有内容时返回空串', () => {
  const db = openDb(':memory:');
  try {
    assert.equal(renderRecentThreads(db, { now: BASE }), '');
  } finally {
    closeDb(db);
  }
});
