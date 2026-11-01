#!/usr/bin/env node
/**
 * 最小 MCP server（stdio / 换行分隔 JSON-RPC）。
 *
 * 为什么手写而不引 SDK：整个项目零运行时依赖，MCP 的 tools 子集协议很小，
 * 手写反而更好审。stdout 只允许出现协议消息，日志一律走 stderr。
 *
 * 用法（DSH 的 profile cordis.patch.yml）：
 *   - insert:
 *       - id: whalefall
 *         name: '@deepseek-ai/dsh-mcp-client'
 *         config:
 *           serverName: whalefall
 *           transport: stdio
 *           command: node
 *           args: ['/abs/path/whalefall/src/mcp.mjs']
 *
 * 环境变量：WHALEFALL_DB（默认 data/whalefall.db）、WHALEFALL_TZ
 */
import readline from 'node:readline';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { openDb } from './db.mjs';
import { callTool, TOOL_DEFINITIONS } from './tools.mjs';
import { harvestSessions } from './harvest.mjs';

const VERSION = '0.1.0';
const DEFAULT_PROTOCOL = '2024-11-05';

function log(...args) {
  process.stderr.write(`[whalefall-mcp] ${args.join(' ')}\n`);
}

function send(message) {
  process.stdout.write(`${JSON.stringify(message)}\n`);
}

function reply(id, result) {
  send({ jsonrpc: '2.0', id, result });
}

function replyError(id, code, message) {
  send({ jsonrpc: '2.0', id, error: { code, message } });
}

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const DB_FILE = process.env.WHALEFALL_DB || path.join(ROOT, 'data', 'whalefall.db');

const SESSIONS_ROOT = process.env.WHALEFALL_SESSIONS
  || path.join(process.env.DSH_HOME || path.join(os.homedir(), '.dsh'), 'sessions');

let db = null;
let lastHarvestAt = 0;
const HARVEST_THROTTLE_MS = 15_000;

/**
 * 读穿透：查询类工具调用前，先把会话日志的新帧收进来。
 * 有节流（15 秒一次），文件没变时基本只是一次 stat；失败不影响查询。
 */
function freshHarvest() {
  if (process.env.WHALEFALL_NO_HARVEST === '1') return;
  const now = Date.now();
  if (now - lastHarvestAt < HARVEST_THROTTLE_MS) return;
  lastHarvestAt = now;
  try {
    const stats = harvestSessions(getDb(), { root: SESSIONS_ROOT, since: now - 24 * 3600 * 1000 });
    if (stats.added > 0) log(`read-through harvested ${stats.added} events`);
  } catch (error) {
    log(`read-through failed: ${error?.message ?? error}`);
  }
}

function getDb() {
  if (!db) {
    db = openDb(DB_FILE);
    log(`db ready: ${DB_FILE}`);
  }
  return db;
}

const handlers = {
  initialize(params) {
    const requested = typeof params?.protocolVersion === 'string' ? params.protocolVersion : DEFAULT_PROTOCOL;
    return {
      protocolVersion: requested,
      capabilities: { tools: { listChanged: false } },
      serverInfo: { name: 'whalefall', version: VERSION },
      instructions: '这是分层记忆服务：先 memory_summary 看大意，需要细节再 memory_search / memory_get。',
    };
  },

  ping() {
    return {};
  },

  'tools/list'() {
    return {
      tools: TOOL_DEFINITIONS.map((t) => ({
        name: t.name,
        description: t.description,
        inputSchema: t.inputSchema,
      })),
    };
  },

  'tools/call'(params) {
    const name = String(params?.name ?? '');
    const args = params?.arguments ?? {};
    if (/^memory_(search|timeline|summary|recall)$/.test(name)) freshHarvest();
    const result = callTool(getDb(), name, args, { tz: process.env.WHALEFALL_TZ });
    // MCP 的内容块：文本里放结构化结果，模型两边都能读
    return {
      content: [{ type: 'text', text: JSON.stringify(result, null, 2) }],
      isError: result.ok === false,
    };
  },

  'resources/list'() {
    return { resources: [] };
  },

  'prompts/list'() {
    return { prompts: [] };
  },
};

const rl = readline.createInterface({ input: process.stdin, crlfDelay: Infinity });

rl.on('line', (line) => {
  const text = line.trim();
  if (!text) return;

  let message;
  try {
    message = JSON.parse(text);
  } catch {
    log('收到非 JSON 的行，已忽略');
    return;
  }

  // 通知（没有 id）不需要回应
  if (message.id === undefined || message.id === null) return;

  const handler = handlers[message.method];
  if (!handler) {
    replyError(message.id, -32601, `Method not found: ${message.method}`);
    return;
  }

  try {
    reply(message.id, handler(message.params ?? {}));
  } catch (error) {
    replyError(message.id, -32603, String(error?.message ?? error));
  }
});

rl.on('close', () => {
  try { db?.close(); } catch { /* ignore */ }
  process.exit(0);
});

process.on('SIGTERM', () => {
  try { db?.close(); } catch { /* ignore */ }
  process.exit(0);
});

log(`started v${VERSION}`);
