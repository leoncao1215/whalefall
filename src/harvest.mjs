/**
 * 会话归档（"做梦"的前半段）：把 DSH 的会话日志变成记忆事件。
 *
 * DSH 的会话文件是**多帧 zstd 拼接的 JSONL**：每个 zstd 帧里是一行 JSON 记录
 * （session / turn/start / user/message / assistant/message / tool/call …）。
 * 直接 zstdDecompress 只能拿到第一帧，所以要按魔数切帧逐帧解。
 *
 * 只归档"真正的对话"：
 *   · user/message 里 source.kind 必须是 'user'（过滤掉 runtime context 这类注入）；
 *   · assistant/message 只取 text 块（reasoning 不要）；
 *   · tool/call、tool/result 不归档——工具调用是过程，不是记忆。
 */
import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';
import { addEvent } from './events.mjs';

const MAGIC = Buffer.from([0x28, 0xb5, 0x2f, 0xfd]);

/** 按 zstd 魔数切帧并解码成记录数组。坏帧跳过，不整体失败。 */
export function decodeSessionBuffer(buf) {
  const positions = [];
  let at = 0;
  while ((at = buf.indexOf(MAGIC, at)) !== -1) {
    positions.push(at);
    at += MAGIC.length;
  }
  const records = [];
  for (let i = 0; i < positions.length; i += 1) {
    const end = i + 1 < positions.length ? positions[i + 1] : buf.length;
    try {
      const text = zlib.zstdDecompressSync(buf.subarray(positions[i], end)).toString('utf8');
      for (const line of text.split('\n')) {
        if (!line.trim()) continue;
        try { records.push(JSON.parse(line)); } catch { /* 半截行，跳过 */ }
      }
    } catch { /* 坏帧（多半是误判的魔数），跳过 */ }
  }
  return records;
}

export function readSessionFile(file) {
  return decodeSessionBuffer(fs.readFileSync(file));
}

/** 从会话的 cwd 推出来源：QQ 插件有固定 workspace，其余算 web。 */
export function sessionSource(cwd) {
  const value = String(cwd ?? '');
  if (value.includes('.dsh-qqbot')) return 'qq';
  if (value) return 'web';
  return 'unknown';
}

function textOf(content) {
  if (!Array.isArray(content)) return '';
  return content
    .filter((block) => block && block.type === 'text' && typeof block.text === 'string')
    .map((block) => block.text.trim())
    .filter(Boolean)
    .join('\n');
}

/**
 * 把记录切成 turn。
 * @returns {Array<{turn:number, ts:number|null, user:string[], assistant:string[]}>}
 */
export function extractTurns(records, { createdAt = null } = {}) {
  const turns = new Map();
  let current = 0;

  const ensure = (n, ts) => {
    if (!turns.has(n)) turns.set(n, { turn: n, ts: ts ?? createdAt, user: [], assistant: [] });
    return turns.get(n);
  };

  for (const record of records) {
    if (!record || typeof record !== 'object') continue;
    const ts = Number.isFinite(Number(record.time)) ? Number(record.time) : null;

    if (record.type === 'turn/start') {
      current = Number(record.data?.turn ?? current + 1);
      ensure(current, ts);
      continue;
    }

    if (record.type === 'user/message' && record.data?.source?.kind === 'user') {
      const text = textOf(record.data?.content);
      if (text) ensure(current, ts).user.push(text);
      continue;
    }

    if (record.type === 'assistant/message') {
      const turnNo = Number(record.data?.turn ?? current);
      // 只取最终文本；一次 turn 里可能有多步，拼起来
      const text = textOf(record.data?.message?.content);
      if (text) ensure(turnNo, ts).assistant.push(text);
    }
  }

  return [...turns.values()]
    .filter((t) => t.user.length || t.assistant.length)
    .sort((a, b) => a.turn - b.turn);
}

/** 把一个 turn 渲染成一条记忆事件的内容。 */
export function turnToEvent(turn) {
  const body = [
    turn.user.length ? `用户：${turn.user.join('\n')}` : '',
    turn.assistant.length ? `助手：${turn.assistant.join('\n')}` : '',
  ].filter(Boolean).join('\n\n');
  const title = (turn.user[0] ?? turn.assistant[0] ?? '').replace(/\s+/g, ' ').slice(0, 24);
  return { title, body };
}

/**
 * 归档一个会话文件。幂等：dedupeKey = sessionId:turn。
 * @returns {{sessionId: string, source: string, turns: number, added: number, skipped: number}}
 */
export function harvestSessionFile(db, file, { tz, dryRun = false } = {}) {
  const records = readSessionFile(file);
  const header = records.find((r) => r.type === 'session') ?? null;
  const sessionId = header?.id ?? path.basename(path.dirname(file));
  const createdAt = Number(header?.createdAt) || null;
  const source = sessionSource(header?.cwd);

  const turns = extractTurns(records, { createdAt });
  let added = 0;
  let skipped = 0;

  for (const turn of turns) {
    const { title, body } = turnToEvent(turn);
    if (!body) { skipped += 1; continue; }
    if (dryRun) { added += 1; continue; }
    const result = addEvent(db, {
      title,
      body,
      ts: turn.ts ?? createdAt ?? Date.now(),
      tz,
      source,
      kind: 'conversation',
      sessionId,
      dedupeKey: `${sessionId}:turn:${turn.turn}`,
    });
    if (result.deduplicated) skipped += 1;
    else added += 1;
  }

  return { sessionId, source, turns: turns.length, added, skipped };
}

/** 找到会话根目录下的所有 session.v4.jsonl.zstd。 */
export function findSessionFiles(root) {
  const out = [];
  const walk = (dir, depth) => {
    if (depth > 4) return;
    let entries;
    try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }
    for (const entry of entries) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) walk(full, depth + 1);
      else if (entry.name.endsWith('.jsonl.zstd')) out.push(full);
    }
  };
  walk(root, 0);
  return out;
}

/**
 * 归档一段时间内的所有会话。
 * @param {object} opts
 * @param {number} opts.since 只看 mtime 不早于它的文件（粗筛，快）
 * @param {string[]} [opts.sources] 只要这些来源（'qq' | 'web' | ...）
 */
export function harvestSessions(db, { root, since = 0, sources = null, tz, dryRun = false } = {}) {
  const files = findSessionFiles(root).filter((f) => {
    try { return fs.statSync(f).mtimeMs >= since; } catch { return false; }
  });

  const stats = { files: 0, sessions: [], added: 0, skipped: 0 };
  for (const file of files) {
    let result;
    try { result = harvestSessionFile(db, file, { tz, dryRun }); } catch { continue; }
    if (sources && !sources.includes(result.source)) continue;
    stats.files += 1;
    stats.sessions.push(result);
    stats.added += result.added;
    stats.skipped += result.skipped;
  }
  return stats;
}
