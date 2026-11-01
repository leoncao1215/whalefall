import test from 'node:test';
import assert from 'node:assert/strict';
import { openDb, closeDb } from '../src/db.mjs';
import {
  countSendsOnDay, evaluateProactive, inQuietHours, proactiveHistory, recordProactiveSend,
} from '../src/proactive.mjs';

const SH = 'Asia/Shanghai';
const at = (iso) => Date.parse(iso);

const POLICY = {
  enabled: true,
  quietHours: ['23:30-08:00'],
  dailyMax: 2,
  minGapMinutes: 180,
};

test('安静时段支持跨午夜', () => {
  assert.equal(inQuietHours(at('2026-11-01T23:40:00+08:00'), POLICY.quietHours, SH), true);
  assert.equal(inQuietHours(at('2026-11-02T03:00:00+08:00'), POLICY.quietHours, SH), true);
  assert.equal(inQuietHours(at('2026-11-02T08:00:00+08:00'), POLICY.quietHours, SH), false);
  assert.equal(inQuietHours(at('2026-11-01T15:00:00+08:00'), POLICY.quietHours, SH), false);
});

test('普通时段区间', () => {
  assert.equal(inQuietHours(at('2026-11-01T12:30:00+08:00'), ['12:00-13:00'], SH), true);
  assert.equal(inQuietHours(at('2026-11-01T13:00:00+08:00'), ['12:00-13:00'], SH), false);
});

test('关闭时一律不说', () => {
  const v = evaluateProactive({ now: at('2026-11-01T15:00:00+08:00'), policy: { ...POLICY, enabled: false }, tz: SH });
  assert.equal(v.ok, false);
  assert.equal(v.code, 'disabled');
});

test('安静时段优先于其它条件', () => {
  const v = evaluateProactive({
    now: at('2026-11-01T23:40:00+08:00'), policy: POLICY, tz: SH, hasSubstance: true,
  });
  assert.equal(v.code, 'quiet');
});

test('每日上限', () => {
  const now = at('2026-11-01T15:00:00+08:00');
  const history = [
    { ts: at('2026-11-01T09:00:00+08:00') },
    { ts: at('2026-11-01T13:00:00+08:00') },
  ];
  assert.equal(countSendsOnDay(history, now, SH), 2);
  const v = evaluateProactive({ now, policy: POLICY, history, tz: SH });
  assert.equal(v.code, 'daily-cap');
});

test('最小间隔', () => {
  const now = at('2026-11-01T15:00:00+08:00');
  const v = evaluateProactive({
    now, policy: POLICY, history: [{ ts: at('2026-11-01T14:30:00+08:00') }], tz: SH,
  });
  assert.equal(v.code, 'min-gap');
  assert.match(v.reason, /再等 150 分钟/);
});

test('用户正在聊天时不插嘴', () => {
  const now = at('2026-11-01T15:00:00+08:00');
  const v = evaluateProactive({
    now, policy: POLICY, history: [], lastUserMessageAt: at('2026-11-01T14:58:00+08:00'), tz: SH,
  });
  assert.equal(v.code, 'user-active');
});

test('没料可说不开口；条件都满足才开口', () => {
  const now = at('2026-11-01T15:00:00+08:00');
  assert.equal(evaluateProactive({ now, policy: POLICY, hasSubstance: false, tz: SH }).code, 'nothing-to-say');
  const ok = evaluateProactive({ now, policy: POLICY, history: [], hasSubstance: true, tz: SH });
  assert.equal(ok.ok, true);
});

test('主动记录落库，migration v2 生效', () => {
  const db = openDb(':memory:');
  try {
    const version = db.prepare('PRAGMA user_version').get().user_version;
    assert.equal(Number(version), 5);
    const id = recordProactiveSend(db, { ts: at('2026-11-01T09:00:00+08:00'), text: '早，今天有雨' });
    assert.ok(id > 0);
    const rows = proactiveHistory(db);
    assert.equal(rows.length, 1);
    assert.equal(rows[0].text, '早，今天有雨');
  } finally {
    closeDb(db);
  }
});
