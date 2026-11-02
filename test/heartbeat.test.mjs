import test from 'node:test';
import assert from 'node:assert/strict';
import { openDb, closeDb } from '../src/db.mjs';
import { addEvent } from '../src/events.mjs';
import { heartbeatStatus, recordHeartbeat, sayHeartbeat } from '../src/heartbeat.mjs';

const SH = 'Asia/Shanghai';
const at = (iso) => Date.parse(iso);

const POLICY = {
  proactive: {
    enabled: true,
    quietHours: ['00:30-08:00'],
    dailyMax: 50,
    minGapMinutes: 0,
    followUp: {
      minMinutes: 5,
      maxMinutes: 30,
      maxFollowUps: 20,
      busyAfter: 5,
      busyMinutes: 240,
      minSilentMinutes: 90,
    },
  },
};
const PERSONA = { name: '大肥鱼', policy: POLICY };

function freshDb() {
  return openDb(':memory:');
}

function userSaid(db, title, iso) {
  addEvent(db, { title, ts: at(iso), tz: SH, source: 'qq', kind: 'conversation' });
}

test('追问间隔是 5~30 分钟的随机值，不是整点', () => {
  const db = freshDb();
  userSaid(db, '老大：在写插件', '2026-11-01T10:00:00+08:00');
  const t0 = at('2026-11-01T10:00:00+08:00');

  const early = recordHeartbeat(db, { text: '老大，吃了吗', now: t0, policy: POLICY, random: () => 0 });
  const late = recordHeartbeat(db, { text: '老大，在吗', now: t0, policy: POLICY, random: () => 0.999 });
  const mid = recordHeartbeat(db, { text: '老大？', now: t0, policy: POLICY, random: () => 0.5 });

  assert.equal((early.nextFollowUpAt - t0) / 60000, 5);
  assert.equal((late.nextFollowUpAt - t0) / 60000, 30);
  const gap = (mid.nextFollowUpAt - t0) / 60000;
  assert.ok(gap > 5 && gap < 30, `间隔应落在区间内，实际 ${gap}`);
  closeDb(db);
});

test('没到点闭嘴，到点才追', () => {
  const db = freshDb();
  userSaid(db, '老大：在写插件', '2026-11-01T09:00:00+08:00');
  recordHeartbeat(db, {
    text: '老大，吃了吗', now: at('2026-11-01T10:00:00+08:00'), policy: POLICY, random: () => 0,
  });

  const notYet = heartbeatStatus(db, { persona: PERSONA, now: at('2026-11-01T10:03:00+08:00'), tz: SH });
  assert.equal(notYet.suggest, 'hold');
  assert.match(notYet.why, /还没到下一次/);

  const due = heartbeatStatus(db, { persona: PERSONA, now: at('2026-11-01T10:06:00+08:00'), tz: SH });
  assert.equal(due.suggest, 'followup');
  assert.equal(due.lastProactive.replied, false);
  closeDb(db);
});

test('追了五次之后当作他在忙，间隔拉长到 240 分钟', () => {
  const db = freshDb();
  userSaid(db, '老大：在写插件', '2026-11-01T09:00:00+08:00');

  let t = at('2026-11-01T09:00:00+08:00');
  const first = recordHeartbeat(db, { text: '第一句', now: t, policy: POLICY, random: () => 0 });
  assert.equal((first.nextFollowUpAt - t) / 60000, 5);

  for (let i = 0; i < 5; i += 1) {
    const out = recordHeartbeat(db, {
      text: `追第 ${i + 1} 次`, kind: 'followup', now: t, policy: POLICY, random: () => 0,
    });
    t = out.nextFollowUpAt;
  }

  const last = db.prepare('SELECT meta FROM proactive_log ORDER BY id DESC LIMIT 1').get();
  assert.equal(JSON.parse(last.meta).nextGapMinutes, 240);

  const status = heartbeatStatus(db, { persona: PERSONA, now: t + 60000, tz: SH });
  assert.equal(status.lastProactive.followUps, 5);
  assert.equal(status.suggest, 'followup');
  assert.match(status.why, /大概在忙/);
  closeDb(db);
});

test('追到上限就不再追，nextFollowUpAt 为 null', () => {
  const db = freshDb();
  const policy = {
    proactive: { ...POLICY.proactive, followUp: { ...POLICY.proactive.followUp, maxFollowUps: 2 } },
  };
  userSaid(db, '老大：在写插件', '2026-11-01T09:00:00+08:00');
  const now = at('2026-11-01T09:00:00+08:00');

  recordHeartbeat(db, { text: '第一句', now, policy, random: () => 0 });
  const second = recordHeartbeat(db, { text: '追一次', kind: 'followup', now, policy, random: () => 0 });
  assert.notEqual(second.nextFollowUpAt, null);

  const third = recordHeartbeat(db, { text: '追两次', kind: 'followup', now, policy, random: () => 0 });
  assert.equal(third.nextFollowUpAt, null);

  const status = heartbeatStatus(db, { persona: { name: 'x', policy }, now: now + 3600 * 1000, tz: SH });
  assert.equal(status.suggest, 'hold');
  assert.match(status.why, /上限/);
  closeDb(db);
});

test('回了就不再追，安静够久才开新话题', () => {
  const db = freshDb();
  userSaid(db, '老大：在写插件', '2026-11-01T10:00:00+08:00');
  recordHeartbeat(db, {
    text: '老大，吃了吗', now: at('2026-11-01T10:00:00+08:00'), policy: POLICY, random: () => 0,
  });
  userSaid(db, '老大：吃了', '2026-11-01T10:05:00+08:00');

  const status = heartbeatStatus(db, { persona: PERSONA, now: at('2026-11-01T15:00:00+08:00'), tz: SH });
  assert.equal(status.lastProactive.replied, true);
  assert.equal(status.suggest, 'new-topic');
  assert.equal(status.silentMinutes, 295);
  closeDb(db);
});

test('老大说了在忙，心跳能闻到', () => {
  const db = freshDb();
  userSaid(db, '老大：今晚加班，别等我', '2026-11-01T19:00:00+08:00');
  const status = heartbeatStatus(db, { persona: PERSONA, now: at('2026-11-01T19:10:00+08:00'), tz: SH });
  assert.equal(status.busySignal, true);
  closeDb(db);
});

test('用户刚说过话不插嘴', () => {
  const db = freshDb();
  userSaid(db, '老大：在吗', '2026-11-01T10:00:00+08:00');

  const status = heartbeatStatus(db, { persona: PERSONA, now: at('2026-11-01T10:05:00+08:00'), tz: SH });
  assert.equal(status.gate.code, 'user-active');
  assert.equal(status.suggest, 'hold');
  closeDb(db);
});

test('追问不受日限和两小时间隔管，只受自己的次数上限管', () => {
  const db = freshDb();
  const policy = {
    proactive: {
      ...POLICY.proactive,
      dailyMax: 1,
      minGapMinutes: 120,
    },
  };
  userSaid(db, '老大：在写插件', '2026-11-01T09:00:00+08:00');
  const t0 = at('2026-11-01T09:00:00+08:00');
  const first = recordHeartbeat(db, { text: '第一句', now: t0, policy, random: () => 0 });
  const second = recordHeartbeat(db, { text: '追一次', kind: 'followup', now: first.nextFollowUpAt, policy, random: () => 0 });

  const status = heartbeatStatus(db, { persona: { name: 'x', policy }, now: second.nextFollowUpAt, tz: SH });
  // 闸门（日限/间隔）对新话题生效，把追问拦在外面是不对的
  assert.equal(status.gate.ok, false);
  assert.equal(status.suggest, 'followup');
  closeDb(db);
});

test('say：发送成功才记账并写事件，失败什么都不留', async () => {
  const db = openDb(':memory:');
  try {
    const ok = await sayHeartbeat(db, {
      text: '在吗', now: at('2026-11-02T23:00:00+08:00'), tz: SH,
      policy: POLICY,
      send: async () => ({ ok: true, id: 'm1' }),
    });
    assert.equal(ok.delivery.id, 'm1');
    assert.equal(db.prepare('SELECT COUNT(*) AS n FROM proactive_log').get().n, 1);
    assert.equal(db.prepare("SELECT COUNT(*) AS n FROM events WHERE kind = 'proactive'").get().n, 1);
    assert.ok(ok.nextFollowUpAt > 0);

    await assert.rejects(
      () => sayHeartbeat(db, {
        text: '发不出去', now: at('2026-11-02T23:30:00+08:00'), tz: SH, policy: POLICY,
        send: async () => ({ ok: false, status: 500, message: 'boom' }),
      }),
      /发送失败/,
    );
    assert.equal(db.prepare('SELECT COUNT(*) AS n FROM proactive_log').get().n, 1);
    assert.equal(db.prepare("SELECT COUNT(*) AS n FROM events WHERE kind = 'proactive'").get().n, 1);
  } finally {
    closeDb(db);
  }
});
