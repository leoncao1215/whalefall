import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { openDb, closeDb } from '../src/db.mjs';
import { searchEvents } from '../src/search.mjs';
import {
  decodeSessionBuffer, extractTurns, harvestSessionFile, sessionSource, turnToEvent,
} from '../src/harvest.mjs';
import { buildSessionBuffer } from './fixtures/session-builder.mjs';

const SH = 'Asia/Shanghai';
const SESSION_ID = 'session-test-1';

function records() {
  return [
    { type: 'session', version: 4, id: SESSION_ID, createdAt: Date.parse('2026-11-01T21:00:00+08:00'), cwd: '/root/.dsh-qqbot/workspace' },
    { type: 'permission/preset', seq: 1, time: 1, data: {} },
    { type: 'turn/start', seq: 2, time: Date.parse('2026-11-01T21:00:01+08:00'), data: { turn: 1 } },
    { type: 'user/message', seq: 3, time: Date.parse('2026-11-01T21:00:02+08:00'), data: { role: 'user', source: { kind: 'user' }, content: [{ type: 'text', text: '你好呀' }] } },
    { type: 'assistant/message', seq: 4, time: Date.parse('2026-11-01T21:00:03+08:00'), data: { turn: 1, step: 1, message: { role: 'assistant', content: [{ type: 'reasoning', text: '思考中' }, { type: 'text', text: '你好！有什么可以帮你的？' }] } } },
    { type: 'tool/call', seq: 5, time: Date.parse('2026-11-01T21:00:04+08:00'), data: { turn: 1, step: 2, name: 'memory_remember', arguments: '{}' } },
    { type: 'turn/end', seq: 6, time: Date.parse('2026-11-01T21:00:05+08:00'), data: { turn: 1 } },
    { type: 'turn/start', seq: 7, time: Date.parse('2026-11-01T21:01:00+08:00'), data: { turn: 2 } },
    { type: 'user/message', seq: 8, time: Date.parse('2026-11-01T21:01:01+08:00'), data: { role: 'user', source: { kind: 'runtime' }, content: [{ type: 'text', text: 'Current runtime context...' }] } },
    { type: 'user/message', seq: 9, time: Date.parse('2026-11-01T21:01:02+08:00'), data: { role: 'user', source: { kind: 'user' }, content: [{ type: 'text', text: '今天好累' }] } },
    { type: 'assistant/message', seq: 10, time: Date.parse('2026-11-01T21:01:03+08:00'), data: { turn: 2, step: 1, message: { role: 'assistant', content: [{ type: 'text', text: '那就早点睡。' }] } } },
    { type: 'turn/end', seq: 11, time: Date.parse('2026-11-01T21:01:04+08:00'), data: { turn: 2 } },
  ];
}

test('解码多帧 zstd 会话文件', () => {
  const buf = buildSessionBuffer(records());
  const decoded = decodeSessionBuffer(buf);
  assert.equal(decoded.length, records().length);
  assert.equal(decoded[0].type, 'session');
});

test('来源识别：QQ workspace → qq，其它 → web', () => {
  assert.equal(sessionSource('/root/.dsh-qqbot/workspace'), 'qq');
  assert.equal(sessionSource('/root/大肥鱼的电饭煲'), 'web');
  assert.equal(sessionSource(''), 'unknown');
});

test('按 turn 提取：过滤 runtime 注入、跳过 reasoning、忽略工具调用', () => {
  const turns = extractTurns(decodeSessionBuffer(buildSessionBuffer(records())));
  assert.equal(turns.length, 2);

  assert.equal(turns[0].user[0], '你好呀');
  assert.equal(turns[0].assistant[0], '你好！有什么可以帮你的？');
  assert.ok(!turns[0].assistant.join('').includes('思考中'));

  assert.equal(turns[1].user.length, 1);
  assert.equal(turns[1].user[0], '今天好累');
  assert.ok(!turns[1].user.join('').includes('runtime'));
});

test('turn 渲染成事件正文', () => {
  const [turn] = extractTurns(decodeSessionBuffer(buildSessionBuffer(records())));
  const event = turnToEvent(turn);
  assert.equal(event.title, '你好呀');
  assert.match(event.body, /用户：你好呀/);
  assert.match(event.body, /助手：你好！/);
});

test('增量：追加新 turn 后只补新的', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'whalefall-harvest-'));
  const file = path.join(dir, 'session.v4.jsonl.zstd');
  fs.writeFileSync(file, buildSessionBuffer(records()));
  const db = openDb(':memory:');
  try {
    const first = harvestSessionFile(db, file, { tz: SH });
    assert.equal(first.added, 2);

    const extra = [
      { type: 'turn/start', seq: 12, time: Date.parse('2026-11-01T21:05:00+08:00'), data: { turn: 3 } },
      { type: 'user/message', seq: 13, time: Date.parse('2026-11-01T21:05:01+08:00'), data: { role: 'user', source: { kind: 'user' }, content: [{ type: 'text', text: '晚安' }] } },
      { type: 'assistant/message', seq: 14, time: Date.parse('2026-11-01T21:05:02+08:00'), data: { turn: 3, step: 1, message: { role: 'assistant', content: [{ type: 'text', text: '晚安，做个好梦。' }] } } },
      { type: 'turn/end', seq: 15, time: Date.parse('2026-11-01T21:05:03+08:00'), data: { turn: 3 } },
    ];
    fs.appendFileSync(file, buildSessionBuffer(extra));

    const second = harvestSessionFile(db, file, { tz: SH });
    assert.equal(second.added, 1);
    assert.equal(second.turns, 1);
    assert.equal(searchEvents(db, { q: '晚安' }).length, 1);

    const total = db.prepare("SELECT COUNT(*) AS n FROM events WHERE kind = 'conversation'").get().n;
    assert.equal(Number(total), 3);
  } finally {
    closeDb(db);
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('增量：turn 没结束就不消费（避免半条被去重吃掉）', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'whalefall-harvest-'));
  const file = path.join(dir, 'session.v4.jsonl.zstd');
  const head = records().slice(0, 4); // 只有 turn 1 的 user/assistant，没有 turn/end
  fs.writeFileSync(file, buildSessionBuffer(head));
  const db = openDb(':memory:');
  try {
    const partial = harvestSessionFile(db, file, { tz: SH });
    assert.equal(partial.added, 0);
    assert.equal(searchEvents(db, { q: '你好呀' }).length, 0);

    // 补上 turn/end 再采一次
    fs.appendFileSync(file, buildSessionBuffer([{ type: 'turn/end', seq: 99, time: Date.now(), data: { turn: 1 } }]));
    const done = harvestSessionFile(db, file, { tz: SH });
    assert.equal(done.added, 1);
    assert.equal(searchEvents(db, { q: '你好呀' }).length, 1);
  } finally {
    closeDb(db);
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('归档幂等：同样的会话跑两次只写一次', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'whalefall-harvest-'));
  const file = path.join(dir, 'session.v4.jsonl.zstd');
  fs.writeFileSync(file, buildSessionBuffer(records()));

  const db = openDb(':memory:');
  try {
    const first = harvestSessionFile(db, file, { tz: SH });
    assert.equal(first.added, 2);
    assert.equal(first.source, 'qq');

    // 增量：没有新帧，什么都不做
    const incrementalAgain = harvestSessionFile(db, file, { tz: SH });
    assert.equal(incrementalAgain.added, 0);

    // 全量重扫：靠 dedupeKey 保证不重复
    const full = harvestSessionFile(db, file, { tz: SH, incremental: false });
    assert.equal(full.added, 0);
    assert.equal(full.skipped, 2);

    const rows = searchEvents(db, { q: '今天好累' });
    assert.equal(rows.length, 1);
    assert.equal(rows[0].source, 'qq');
    assert.equal(rows[0].sessionId, SESSION_ID);
    assert.equal(rows[0].kind, 'conversation');
  } finally {
    closeDb(db);
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
