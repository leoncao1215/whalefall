/**
 * 桌宠网关：让"坐在别的机器上的分身"连上这口锅。
 *
 * 传输选 SSE + POST 而不是 WebSocket：零依赖、过代理稳、断线重连简单，
 * 对桌宠这种"一问一答 + 偶尔推送"的形态足够了。
 *
 * 安全默认值：
 *   · 只监听 127.0.0.1；要跨机必须显式 --host 0.0.0.0（并且一定带 token）
 *   · 所有请求校验 Bearer token（SSE 用 ?token=，因为浏览器 EventSource 不能带头）
 *   · 请求体有上限，错误不泄漏内部路径
 */
import http from 'node:http';
import crypto from 'node:crypto';
import { addEvent } from './events.mjs';
import { assembleSystemPrompt } from './assemble.mjs';
import { proactiveSince } from './proactive.mjs';
import { listSummaries } from './summaries.mjs';
import { runSummarizerCommand } from './summarizer.mjs';
import { DEFAULT_TZ } from './time.mjs';

const MAX_BODY = 256 * 1024;

function readJson(req) {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks = [];
    req.on('data', (chunk) => {
      size += chunk.length;
      if (size > MAX_BODY) {
        reject(new Error('请求体过大'));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => {
      try {
        const text = Buffer.concat(chunks).toString('utf8');
        resolve(text ? JSON.parse(text) : {});
      } catch {
        reject(new Error('请求体不是合法 JSON'));
      }
    });
    req.on('error', reject);
  });
}

function sendJson(res, status, value) {
  const body = JSON.stringify(value);
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': Buffer.byteLength(body),
    'Cache-Control': 'no-store',
  });
  res.end(body);
}

function safeEqual(a, b) {
  const ba = Buffer.from(String(a));
  const bb = Buffer.from(String(b));
  if (ba.length !== bb.length) return false;
  return crypto.timingSafeEqual(ba, bb);
}

/**
 * @param {object} opts
 * @param {import('node:sqlite').DatabaseSync} opts.db
 * @param {string} opts.token 必填
 * @param {object} [opts.persona]
 * @param {(ctx: {text: string, system: string}) => Promise<string>} opts.responder
 * @param {string} [opts.tz]
 * @param {number} [opts.pollMs] SSE 轮询间隔（测试用）
 * @param {number} [opts.contextBudget]
 */
export function createGateway(opts) {
  const {
    db, token, persona, responder, tz = DEFAULT_TZ,
    pollMs = 2000, contextBudget = 1200,
  } = opts;
  if (!db) throw new Error('createGateway 需要 db');
  if (!token || String(token).length < 16) throw new Error('token 至少 16 位');

  function authorized(req, url) {
    const header = String(req.headers.authorization ?? '');
    if (header.startsWith('Bearer ') && safeEqual(header.slice(7), token)) return true;
    const query = url.searchParams.get('token');
    return Boolean(query) && safeEqual(query, token);
  }

  async function handleChat(req, res) {
    const body = await readJson(req);
    const text = String(body.text ?? '').trim();
    if (!text) return sendJson(res, 400, { ok: false, error: 'text 不能为空' });

    const userEvent = addEvent(db, {
      title: text.slice(0, 24),
      body: text,
      source: 'pet',
      kind: 'message',
      actors: body.actor ? [String(body.actor)] : [],
    });

    const assembled = assembleSystemPrompt(db, {
      persona,
      q: text,
      budget: contextBudget,
      tz,
    });

    let reply = '';
    try {
      reply = String(await responder({ text, system: assembled.system, memory: assembled.context.text }) ?? '').trim();
    } catch (error) {
      return sendJson(res, 502, { ok: false, error: `回复失败：${String(error?.message ?? error)}` });
    }

    if (!reply) return sendJson(res, 502, { ok: false, error: '没有生成回复' });

    const replyEvent = addEvent(db, {
      title: '回复',
      body: reply,
      source: 'pet',
      kind: 'reply',
      refs: [{ type: 'event', id: String(userEvent.id) }],
    });

    return sendJson(res, 200, {
      ok: true,
      reply,
      userEventId: userEvent.id,
      replyEventId: replyEvent.id,
      usage: { promptTokens: assembled.tokens, contextTokens: assembled.parts.context },
    });
  }

  function handleStream(req, res, url) {
    res.writeHead(200, {
      'Content-Type': 'text/event-stream; charset=utf-8',
      'Cache-Control': 'no-cache, no-transform',
      Connection: 'keep-alive',
      'X-Accel-Buffering': 'no',
    });
    res.write(': connected\n\n');

    let lastId = Number(url.searchParams.get('since')) || 0;
    const timer = setInterval(() => {
      for (const item of proactiveSince(db, lastId)) {
        lastId = item.id;
        res.write(`event: message\ndata: ${JSON.stringify(item)}\n\n`);
      }
    }, Math.max(20, Number(pollMs) || 2000));

    const stop = () => {
      clearInterval(timer);
      try { res.end(); } catch { /* 已断开 */ }
    };
    req.on('close', stop);
    req.on('error', stop);
  }

  const server = http.createServer(async (req, res) => {
    let url;
    try {
      url = new URL(req.url, 'http://localhost');
    } catch {
      sendJson(res, 400, { ok: false, error: 'bad url' });
      return;
    }

    try {
      if (url.pathname === '/health') {
        if (!authorized(req, url)) return sendJson(res, 401, { ok: false, error: 'unauthorized' });
        return sendJson(res, 200, { ok: true, name: 'whalefall-gateway', time: Date.now() });
      }

      if (!authorized(req, url)) return sendJson(res, 401, { ok: false, error: 'unauthorized' });

      if (url.pathname === '/v1/chat' && req.method === 'POST') {
        await handleChat(req, res);
        return;
      }

      if (url.pathname === '/v1/stream' && req.method === 'GET') {
        handleStream(req, res, url);
        return;
      }

      if (url.pathname === '/v1/history' && req.method === 'GET') {
        const limit = Math.max(1, Math.min(200, Number(url.searchParams.get('limit')) || 30));
        const rows = db
          .prepare("SELECT id, ts, kind, title, body FROM events WHERE source = 'pet' ORDER BY ts DESC LIMIT ?")
          .all(limit);
        return sendJson(res, 200, { ok: true, items: rows.reverse() });
      }

      if (url.pathname === '/v1/summaries' && req.method === 'GET') {
        return sendJson(res, 200, { ok: true, items: listSummaries(db, { status: 'ready', limit: 10 }) });
      }

      return sendJson(res, 404, { ok: false, error: 'not found' });
    } catch (error) {
      return sendJson(res, 500, { ok: false, error: String(error?.message ?? error) });
    }
  });

  return server;
}

/** 用外部命令当"嘴"（与 summarizer 同构：读 stdin JSON、写 stdout）。 */
export function createCommandResponder(command, opts = {}) {
  return async ({ text, system, memory }) => {
    const result = await runSummarizerCommand(command, {
      kind: 'chat',
      text,
      system,
      memory,
      persona: opts.personaName ?? '',
    }, { timeoutMs: opts.timeoutMs });
    return result.text;
  };
}
