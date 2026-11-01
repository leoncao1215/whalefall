/**
 * 跨渠道的“最近聊到哪儿了”。
 *
 * 原始记录按渠道分开存（审计、回放、精确检索都要它），
 * 但她在任何一个渠道开口时，都该知道别的渠道刚刚发生过什么——
 * 人对“同一个人”的感觉来自共享大意，不是共享录音。
 *
 * 这里只做读取：从 events 里取最近若干条，压成几行，
 * 由调用方塞进 system prompt 的 <recent> 块。
 */
import { formatLocal } from './time.mjs';

const CHANNEL_LABEL = {
  qq: 'QQ',
  web: 'DSH',
  telegram: 'TG',
  pet: '桌宠',
  agent: '主动',
};

function channelOf(source) {
  return CHANNEL_LABEL[source] ?? source ?? '?';
}

function clip(text, max) {
  const flat = String(text ?? '').replace(/\s+/g, ' ').trim();
  return flat.length > max ? `${flat.slice(0, max - 1)}…` : flat;
}

/** 把 "用户：…\n\n助手：…" 拆成两段，顺手去掉前缀。 */
function splitTurn(body) {
  const user = /用户：([\s\S]*?)(?:\n\n助手：|$)/.exec(body ?? '')?.[1] ?? '';
  const assistant = /助手：([\s\S]*)$/.exec(body ?? '')?.[1] ?? '';
  return { user: user.trim(), assistant: assistant.trim() };
}

/**
 * @param {import('node:sqlite').DatabaseSync} db
 * @param {object} [opts]
 * @param {number} [opts.limit] 最多几条
 * @param {number} [opts.hours] 只看最近多久
 * @param {string} [opts.excludeSessionId] 不重复当前会话（它已经在上下文里）
 * @param {number} [opts.now]
 * @param {string} [opts.tz]
 * @param {number} [opts.clip] 每段最多几个字
 */
export function recentThreads(db, opts = {}) {
  const limit = Math.max(1, Number(opts.limit) || 8);
  const hours = Math.max(1, Number(opts.hours) || 24);
  const now = Number(opts.now) || Date.now();
  const exclude = opts.excludeSessionId ?? null;
  const maxChars = Math.max(20, Number(opts.clip) || 50);
  const tz = opts.tz || 'Asia/Shanghai';

  const rows = db
    .prepare(
      `SELECT id, ts, source, kind, title, body, session_id
         FROM events
        WHERE ts >= ?
          AND kind IN ('conversation', 'proactive')
          AND (? IS NULL OR session_id IS NULL OR session_id != ?)
        ORDER BY ts DESC
        LIMIT ?`,
    )
    .all(now - hours * 3600000, exclude, exclude, limit)
    .reverse();

  return rows.map((row) => {
    const when = formatLocal(Number(row.ts), tz).slice(11, 16); // HH:MM
    const channel = channelOf(row.source);
    let line;
    if (row.kind === 'proactive') {
      line = `我（主动）：${clip(row.body || row.title, maxChars)}`;
    } else {
      const { user, assistant } = splitTurn(row.body);
      const left = user ? `老大：${clip(user, maxChars)}` : '';
      const right = assistant ? `我：${clip(assistant, maxChars)}` : '';
      line = [left, right].filter(Boolean).join(' → ') || clip(row.title, maxChars);
    }
    return `[${channel} ${when}] ${line}`;
  });
}

/**
 * 渲染成可以直接塞进 prompt 的文本；没有内容时返回空串。
 */
export function renderRecentThreads(db, opts = {}) {
  const lines = recentThreads(db, opts);
  return lines.join('\n');
}
