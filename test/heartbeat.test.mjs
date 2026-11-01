import test from 'node:test';
import assert from 'node:assert/strict';
import { openDb, closeDb } from '../src/db.mjs';
import { addEvent } from '../src/events.mjs';
import { heartbeatStatus, recordHeartbeat } from '../src/heartbeat.mjs';

const SH = 'Asia/Shanghai';
const at = (iso) => Date.parse(iso);

const PERSONA = {
  name: '大肥鱼',
  policy: {
    proactive: {
      enabled: true,
      quietHours: ['00:30-08:00'],
      dailyMax: 3,
      minGapMinutes: 120,
      followUp: { followUpMinutes: 180, maxFollowUps: 1, minSilentMinutes: 90 },
    },
  },
};

function freshDb() {
  const db = openDb(':memory:');
  return db;
}

test('主动说完没人理，隔够了就建议 followup', () => {
  const db = freshDb();
  addEvent(db, { title: '老大：在写插件', ts: at('2026-11-01T10:00:00+08:00'), tz: SH, source: 'qq', kind: 'conversation' });
  recordHeartbeat(db, { text: '老大，吃了吗', now: at('2026-11-01T12:00:00+08:00') });

  const status = heartbeatStatus(db, { persona: PERSONA, now: at('2026-11-01T15:30:00+08:00'), tz: SH });
  assert.equal(status.suggest, 'followup');
  assert.equal(status.lastProactive.replied, false);
  assert.equal(status.lastProactive.ageMinutes, 210);
  closeDb(db);
});

test('隔得不够久就闭嘴', () => {
  const db = freshDb();
  addEvent(db, { title: '老大：在写插件', ts: at('2026-11-01T10:00:00+08:00'), tz: SH, source: 'qq', kind: 'conversation' });
  recordHeartbeat(db, { text: '老大，吃了吗', now: at('2026-11-01T12:00:00+08:00') });

  const status = heartbeatStatus(db, { persona: PERSONA, now: at('2026-11-01T13:30:00+08:00'), tz: SH });
  assert.equal(status.suggest, 'hold');
  assert.match(status.why, /闸门/);
  closeDb(db);
});

test('回了就不再追，安静够久才开新话题', () => {
  const db = freshDb();
  addEvent(db, { title: '老大：在写插件', ts: at('2026-11-01T10:00:00+08:00'), tz: SH, source: 'qq', kind: 'conversation' });
  recordHeartbeat(db, { text: '老大，吃了吗', now: at('2026-11-01T12:00:00+08:00') });
  addEvent(db, { title: '老大：吃了', ts: at('2026-11-01T12:05:00+08:00'), tz: SH, source: 'qq', kind: 'conversation' });

  const status = heartbeatStatus(db, { persona: PERSONA, now: at('2026-11-01T15:00:00+08:00'), tz: SH });
  assert.equal(status.lastProactive.replied, true);
  assert.equal(status.suggest, 'new-topic');
  assert.equal(status.silentMinutes, 175);
  closeDb(db);
});

test('已经追过一次就不再追，避免连着骚扰', () => {
  const db = freshDb();
  addEvent(db, { title: '老大：在写插件', ts: at('2026-11-01T09:00:00+08:00'), tz: SH, source: 'qq', kind: 'conversation' });
  const id = recordHeartbeat(db, { text: '老大，吃了吗', now: at('2026-11-01T09:10:00+08:00') });
  recordHeartbeat(db, { text: '不理我就不理我', kind: 'followup', thread: id, now: at('2026-11-01T12:30:00+08:00') });

  const status = heartbeatStatus(db, { persona: PERSONA, now: at('2026-11-01T16:00:00+08:00'), tz: SH });
  assert.equal(status.lastProactive.replied, false);
  assert.equal(status.suggest, 'new-topic');
  closeDb(db);
});

test('用户刚说过话不插嘴', () => {
  const db = freshDb();
  addEvent(db, { title: '老大：在吗', ts: at('2026-11-01T10:00:00+08:00'), tz: SH, source: 'qq', kind: 'conversation' });

  const status = heartbeatStatus(db, { persona: PERSONA, now: at('2026-11-01T10:05:00+08:00'), tz: SH });
  assert.equal(status.gate.code, 'user-active');
  assert.equal(status.suggest, 'hold');
  closeDb(db);
});

test('追问不给 thread 时自动挂到上一条线上', () => {
  const db = freshDb();
  addEvent(db, { title: '老大：在写插件', ts: at('2026-11-01T09:00:00+08:00'), tz: SH, source: 'qq', kind: 'conversation' });
  const id = recordHeartbeat(db, { text: '老大，吃了吗', now: at('2026-11-01T09:10:00+08:00') });
  const followId = recordHeartbeat(db, { text: '不理我算了', kind: 'followup', now: at('2026-11-01T12:30:00+08:00') });

  const rows = db.prepare('SELECT id, meta FROM proactive_log ORDER BY id').all();
  const follow = rows.find((r) => Number(r.id) === followId);
  assert.equal(JSON.parse(follow.meta).thread, id);

  const status = heartbeatStatus(db, { persona: PERSONA, now: at('2026-11-01T16:00:00+08:00'), tz: SH });
  assert.equal(status.lastProactive.followUps, 1);
  assert.equal(status.suggest, 'new-topic');
  closeDb(db);
});
