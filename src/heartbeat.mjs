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
 *   followup  上一条还没回，到点了，可以再蹭一下
 *   new-topic 没人理但也没欠着，挑个新话题
 *
 * 追问的节奏不是固定间隔：每条消息发出时就掷一次骰子（默认 5~30 分钟），
 * 把下一次的时间写进 meta.nextFollowUpAt。这样追问是"随机地想起来"，
 * 而不是"整点打卡"。追到 busyAfter 次还没回，间隔拉长成 busyMinutes，
 * 相当于承认"他在忙"。
 */
import { evaluateProactive, inQuietHours, proactiveHistory } from './proactive.mjs';
import { DEFAULT_TZ, formatLocal } from './time.mjs';

const DEFAULTS = {
  minMinutes: 5, // 追问间隔下限
  maxMinutes: 30, // 追问间隔上限
  maxFollowUps: 20, // 一条线最多追这么多次
  busyAfter: 5, // 追到第几次开始当作"他在忙"
  busyMinutes: 240, // 当作他在忙之后，间隔拉长到这么久
  minSilentMinutes: 90, // 开新话题前，老大至少安静这么久
};

/** 用户随口说"在忙"的痕迹，只扫用户自己说的话（事件标题）。 */
const BUSY_RE = /(忙|开会|加班|出差|在路上|在车上|别等|晚点说|先不聊|回头聊|赶时间|通宵|睡会儿)/;

function minutes(ms) {
  return Math.round(ms / 60000);
}

function rulesOf(policy) {
  // 传进来的既可能是 persona.policy，也可能已经是 policy.proactive，
  // 两种都认，免得调用方记错层级。
  const proactive = policy?.proactive ?? policy ?? {};
  return { ...DEFAULTS, ...(proactive.followUp ?? {}) };
}

function pickGap(rules, random = Math.random) {
  const min = Math.max(1, Number(rules.minMinutes) || DEFAULTS.minMinutes);
  const max = Math.max(min, Number(rules.maxMinutes) || DEFAULTS.maxMinutes);
  // 均匀分布就够；不需要更好看的分布，这里只要"不是整点"
  return Math.round(min + random() * (max - min));
}

/** 用户最后一次说话之后，有没有出现过新的对话事件（= 回过了）。 */
// 采集会把"我自己主动说的那句"也记成一条 qq/conversation 事件（正文以「助手：」开头）。
// 那不是老大在说话，算进 replied 和 lastUserAt 会让追问链自己骗自己。
const NOT_ASSISTANT = "body NOT LIKE '助手：%' AND body NOT LIKE '助手:%'";

function repliedAfter(db, ts) {
  const row = db
    .prepare(
      `SELECT ts FROM events
        WHERE ts > ? AND kind != 'proactive' AND source != 'agent' AND ${NOT_ASSISTANT}
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
          WHERE kind != 'proactive' AND source != 'agent' AND ${NOT_ASSISTANT}
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

/** 老大最近有没有说过"在忙"之类的话。 */
function busySignal(db, now) {
  const rows = db
    .prepare(
      `SELECT title FROM events
        WHERE ts > ? AND kind != 'proactive' AND source != 'agent' AND ${NOT_ASSISTANT}
        ORDER BY ts DESC LIMIT 20`,
    )
    .all(now - 12 * 3600 * 1000);
  for (const row of rows) {
    if (BUSY_RE.test(String(row.title ?? ''))) return true;
  }
  return false;
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
  const rules = rulesOf(policy);

  const history = proactiveHistory(db, { since: now - 3 * 86400000 }).filter(
    (item) => item.meta?.delivery?.ok !== false,
  );

  const lastUser = lastUserEvent(db);
  const lastUserAt = lastUser ? Number(lastUser.ts) : null;

  // 闸门只管"新话题"：追问是自己的节奏（随机间隔 + 次数上限），
  // 要是也走日限和 2 小时间隔，20 次追问根本追不出去。
  const topicHistory = history.filter((item) => item.kind !== 'followup');
  const gate = evaluateProactive({
    now,
    policy,
    history: topicHistory,
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

  const nextFollowUpAt = lastSend?.meta?.nextFollowUpAt != null ? Number(lastSend.meta.nextFollowUpAt) : null;
  const followUpDue = nextFollowUpAt != null && now >= nextFollowUpAt;
  const busy = busySignal(db, now);

  const lastProactive = lastSend
    ? {
        id: lastSend.id,
        ts: lastSend.ts,
        ageMinutes: minutes(now - Number(lastSend.ts)),
        text: lastSend.text,
        replied: repliedAt != null,
        repliedAt,
        followUps,
        maxFollowUps: rules.maxFollowUps,
        nextFollowUpAt,
        dueInMinutes: nextFollowUpAt == null ? null : minutes(nextFollowUpAt - now),
      }
    : null;

  const silentMinutes = lastUserAt == null ? null : minutes(now - lastUserAt);
  const today = formatLocal(now, tz).slice(0, 10);
  const todayCount = history.filter((h) => formatLocal(Number(h.ts), tz).slice(0, 10) === today).length;

  let suggest = 'hold';
  let why = '';
  const quiet = inQuietHours(now, policy.quietHours ?? [], tz);
  if (lastProactive && !lastProactive.replied) {
    // 追问是"同一条线上接着说话"，不占新话题的日限和间隔，
    // 但它自己也要守安静时段、次数上限和节奏。
    if (quiet) {
      suggest = 'hold';
      why = '处在安静时段';
    } else if (followUps >= rules.maxFollowUps) {
      suggest = 'hold';
      why = `这条已经追了 ${followUps} 次，到上限了，别再追`;
    } else if (!followUpDue) {
      suggest = 'hold';
      why = `还没到下一次追问的时间（${lastProactive.dueInMinutes} 分钟后）`;
    } else {
      suggest = 'followup';
      why =
        followUps >= rules.busyAfter
          ? `追了 ${followUps} 次还没回，大概在忙；不过到点了，轻轻蹭一下`
          : `上一条 ${lastProactive.ageMinutes} 分钟没回，到点了，可以追`;
    }
  } else if (!gate.ok) {
    suggest = 'hold';
    why = `闸门：${gate.reason}`;
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
    todayCount,
    lastProactive,
    lastUserAt,
    silentMinutes,
    busySignal: busy,
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

/**
 * 把"这次我说了什么"记下来，下一次心跳才知道自己说过。
 *
 * 顺手掷一次骰子，算出下一次追问的时间（meta.nextFollowUpAt），
 * 调用方拿这个时间去挂一次性提醒，追问链路才是"随机"而不是"定时"。
 *
 * @returns {{id: number, nextFollowUpAt: number|null}}
 */
export function recordHeartbeat(db, opts = {}) {
  const { text, kind = 'proactive', thread = null, now = Date.now(), meta = {}, policy = null, random = Math.random } = opts;
  const rules = rulesOf(policy);
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

  const sentFollowUps = (root != null ? followUpCount(db, root) : 0) + (kind === 'followup' ? 1 : 0);
  payload.followUps = sentFollowUps;

  let nextFollowUpAt = null;
  if (sentFollowUps < rules.maxFollowUps) {
    const gap = sentFollowUps >= rules.busyAfter
      ? Math.max(1, Number(rules.busyMinutes) || DEFAULTS.busyMinutes)
      : pickGap(rules, random);
    nextFollowUpAt = Number(now) + gap * 60000;
    payload.nextFollowUpAt = nextFollowUpAt;
    payload.nextGapMinutes = gap;
  }

  const info = db
    .prepare('INSERT INTO proactive_log (ts, kind, text, meta) VALUES (?, ?, ?, ?)')
    .run(Number(now), String(kind), String(text ?? ''), JSON.stringify(payload));
  return { id: Number(info.lastInsertRowid), nextFollowUpAt };
}
