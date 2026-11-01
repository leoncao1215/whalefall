import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { openDb, closeDb } from '../src/db.mjs';
import { addEvent } from '../src/events.mjs';
import { upsertSummary, listSummaries } from '../src/summaries.mjs';
import { harvestSessionFile } from '../src/harvest.mjs';
import { rebuildFromSessions, verifyHarvest } from '../src/verify.mjs';
import { buildSessionBuffer } from './fixtures/session-builder.mjs';

const SH = 'Asia/Shanghai';
const SID = 'session-verify-1';
const T1 = Date.parse('2026-11-01T21:00:00+08:00');

function sessionRecords() {
  return [
    { type: 'session', version: 4, id: SID, createdAt: T1, cwd: '/root/.dsh-qqbot/workspace' },
    { type: 'turn/start', seq: 1, time: T1, data: { turn: 1 } },
    { type: 'user/message', seq: 2, time: T1 + 1000, data: { role: 'user', source: { kind: 'user' }, content: [{ type: 'text', text: '你好呀' }] } },
    { type: 'assistant/message', seq: 3, time: T1 + 2000, data: { turn: 1, step: 1, message: { role: 'assistant', content: [{ type: 'text', text: '你好！' }] } } },
    { type: 'turn/end', seq: 4, time: T1 + 3000, data: { turn: 1 } },
    { type: 'turn/start', seq: 5, time: T1 + 4000, data: { turn: 2 } },
    { type: 'user/message', seq: 6, time: T1 + 5000, data: { role: 'user', source: { kind: 'user' }, content: [{ type: 'text', text: '今天好累' }] } },
    { type: 'assistant/message', seq: 7, time: T1 + 6000, data: { turn: 2, step: 1, message: { role: 'assistant', content: [{ type: 'text', text: '那就早点睡。' }] } } },
    { type: 'turn/end', seq: 8, time: T1 + 7000, data: { turn: 2 } },
  ];
}

function setup() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'whalefall-verify-'));
  const file = path.join(dir, 'session.v4.jsonl.zstd');
  fs.writeFileSync(file, buildSessionBuffer(sessionRecords()));
  const db = openDb(':memory:');
  return { dir, file, db };
}

test('verify：全部入库时报 0 缺失', () => {
  const { dir, file, db } = setup();
  try {
    harvestSessionFile(db, file, { tz: SH });
    const out = verifyHarvest(db, { root: dir });
    assert.equal(out.files, 1);
    assert.equal(out.turns, 2);
    assert.equal(out.present, 2);
    assert.equal(out.missing.length, 0);
  } finally {
    closeDb(db);
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('verify：删掉一条对话后能指出来', () => {
  const { dir, file, db } = setup();
  try {
    harvestSessionFile(db, file, { tz: SH });
    db.prepare("DELETE FROM events WHERE title = '今天好累'").run();

    const out = verifyHarvest(db, { root: dir });
    assert.equal(out.turns, 2);
    assert.equal(out.present, 1);
    assert.equal(out.missing.length, 1);
    assert.equal(out.missing[0].turn, 2);
    assert.equal(out.missing[0].title, '今天好累');
  } finally {
    closeDb(db);
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('reindex：恢复对话事件，保留手工记忆，摘要清空待重算', () => {
  const { dir, file, db } = setup();
  try {
    harvestSessionFile(db, file, { tz: SH });
    addEvent(db, { title: '手工记的一条', body: '别忘', ts: T1, tz: SH, source: 'agent' });
    upsertSummary(db, { level: 'day', ts: T1, tz: SH, text: '旧摘要', sourceCount: 2 });
    assert.equal(listSummaries(db, { level: 'day' }).length, 1);

    const out = rebuildFromSessions(db, { root: dir, tz: SH });
    assert.equal(out.before.conversations, 2);
    assert.equal(out.after.conversations, 2);

    const conversations = db.prepare("SELECT COUNT(*) AS n FROM events WHERE kind = 'conversation'").get().n;
    assert.equal(Number(conversations), 2);

    const note = db.prepare("SELECT COUNT(*) AS n FROM events WHERE source = 'agent'").get().n;
    assert.equal(Number(note), 1, '手工记忆不该被删');

    assert.equal(listSummaries(db, { level: 'day' }).length, 0);
  } finally {
    closeDb(db);
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
