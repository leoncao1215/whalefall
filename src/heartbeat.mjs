/**
 * 心跳：给"定时醒来一次"的 agent 一个可查询的状态面板。
 *
 * 和 tick.mjs 的区别：
 *   · tick 是旁路发送（cron → 生成 → 调 QQ API），没有会话、没有上下文；
 *   · heartbeat 不发送任何东西，它只回答问题："我现在该不该开口，开什么口"。
 *     真正开口由 DSH schedule 投递一次会话轮次，agent 自己说话、自己记录。
 *
 * 三条出口：
 *   hold      闭嘴（默认，也是绝大多数情况）
 *   followup  上一条还没回，隔了够久，可以再蹭一下
 *   new-topic 没人理但也没欠着，挑个新话题
 */
import { evaluateProactive, proactiveHistory } from './proactive.mjs';
import { DEFAULT_TZ, formatLocal } from './time.mjs';

const DEFAULTS = {
  followUpMinutes: 180, // 上一条没回，隔这么久才允许追
  maxFollowUps: 1, // 同一条最多追一次，追多了就是烦
  minSilentMinutes: 90, // 用户至少安静这么久才考虑开新话题
};

function minutes(ms) {
  return Math.round(ms / 60000);
}

/** 用户最后一次说话之后，有没有出现过新的对话事件（= 回过了）。 */
function repliedAfter(db, ts) {
  const row = db
    .prepare(
      `SELECT ts FROM events
        WHERE ts > ? AND kind != 'proactive' AND source != 'agent'
        ORDER BY ts ASC LIMIT 1`,
    )
    .get(Number(ts));
  return row ? Number(row.ts) : null;
}

function lastUserEvent(db) {
  return (
    db
      .prepare(
        `SELECT ts, title, body FROM events
          WHERE kind != 'proactive' AND source != 'agent'
          ORDER BY ts DESC LIMIT 1`,
      )
      .get() ?? null
  );
}

function followUpCount(db, threadId) {
  const row = db
    .prepare(`SELECT COUNT(*) AS n FROM proactive_log WHERE json_extract(meta, '$.thread') = ?`)
    .get(Number(threadId));
  return Number(row?.n ?? 0);
}

/**
 * @param {import('node:sqlite').DatabaseSync} db
 * @param {object} opts
 * @param {object} opts.persona
 * @param {number} [opts.now]
 * @param {string} [opts.tz]
 */
export function heartbeatStatus(db, opts = {}) {
  const tz = opts.tz || DEFAULT_TZ;
  const now = Number(opts.now) || Date.now();
  const persona = opts.persona ?? null;
  const policy = { ...(persona?.policy?.proactive ?? {}) };
  const rules = { ...DEFAULTS, ...(policy.followUp ?? {}) };

  const history = proactiveHistory(db, { since: now - 3 * 86400000 }).filter(
    (item) => item.meta?.delivery?.ok !== false,
  );

  const lastUser = lastUserEvent(db);
  const lastUserAt = lastUser ? Number(lastUser.ts) : null;

  const gate = evaluateProactive({
    now,
    policy,
    history,
    lastUserMessageAt: lastUserAt,
    hasSubstance: true,
    tz,
  });

  const lastSend = history.length ? history[history.length - 1] : null;
  const repliedAt = lastSend ? repliedAfter(db, lastSend.ts) : null;
  // 追过一次之后再算，要按"这条线"算，不能按最后那条追问自己算，
  // 否则每次追问都会重新开一条线，永远追不完。
  const threadRoot = lastSend ? Number(lastSend.meta?.thread ?? lastSend.id) : null;
  const followUps = threadRoot != null ? followUpCount(db, threadRoot) : 0;

  const lastProactive = lastSend
    ? {
        id: lastSend.id,
        ts: lastSend.ts,
        ageMinutes: minutes(now - Number(lastSend.ts)),
        text: lastSend.text,
        replied: repliedAt != null,
        repliedAt,
        followUps,
      }
    : null;

  const silentMinutes = lastUserAt == null ? null : minutes(now - lastUserAt);
  const openThread =
    lastProactive && !lastProactive.replied && lastProactive.ageMinutes >= rules.followUpMinutes;

  const today = formatLocal(now, tz).slice(0, 10);

  let suggest = 'hold';
  let why = '';
  if (!gate.ok) {
    suggest = 'hold';
    why = `闸门：${gate.reason}`;
  } else if (openThread && lastProactive.followUps < rules.maxFollowUps) {
    suggest = 'followup';
    why = `上一条 ${lastProactive.ageMinutes} 分钟没回，可以追一次`;
  } else if (silentMinutes == null) {
    suggest = 'new-topic';
    why = '还没有任何对话记录，可以打个招呼';
  } else if (silentMinutes >= rules.minSilentMinutes) {
    suggest = 'new-topic';
    why = `老大已经安静 ${silentMinutes} 分钟，可以找个话题`;
  } else {
    suggest = 'hold';
    why = `老大 ${silentMinutes} 分钟前才说过话，先别动`;
  }

  return {
    now,
    local: formatLocal(now, tz),
    tz,
    gate,
    suggest,
    why,
    todayCount: history.filter((h) => formatLocal(Number(h.ts), tz).slice(0, 10) === today).length,
    lastProactive,
    lastUserAt,
    silentMinutes,
    lastChat: lastUser
      ? {
          ts: Number(lastUser.ts),
          title: String(lastUser.title ?? ''),
          body: String(lastUser.body ?? '').slice(0, 200),
        }
      : null,
    limits: policy,
  };
}

/** 把"这次我说了什么"记下来，下一次心跳才知道自己说过。 */
export function recordHeartbeat(db, { text, kind = 'proactive', thread = null, now = Date.now(), meta = {} } = {}) {
  const payload = { ...meta, delivery: { ok: true, via: 'dsb-schedule' } };
  // 追问默认挂在"上一条"这条线上；不挂就会自己开新线，永远追不完。
  let root = thread;
  if (root == null && kind === 'followup') {
    const last = db.prepare('SELECT id, meta FROM proactive_log ORDER BY id DESC LIMIT 1').get();
    if (last) {
      let parsed = {};
      try { parsed = JSON.parse(last.meta ?? '{}'); } catch { parsed = {}; }
      root = parsed.thread ?? Number(last.id);
    }
  }
  if (root != null) payload.thread = Number(root);
  const info = db
    .prepare('INSERT INTO proactive_log (ts, kind, text, meta) VALUES (?, ?, ?, ?)')
    .run(Number(now), String(kind), String(text ?? ''), JSON.stringify(payload));
  return Number(info.lastInsertRowid);
}
