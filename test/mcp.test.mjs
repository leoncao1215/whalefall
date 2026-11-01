import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import readline from 'node:readline';
import { fileURLToPath } from 'node:url';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const SERVER = path.join(ROOT, 'src', 'mcp.mjs');

/** 起一个 MCP server 子进程，返回 rpc()。 */
function startServer() {
  const dbFile = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'whalefall-mcp-')), 'test.db');
  const child = spawn(process.execPath, ['--disable-warning=ExperimentalWarning', SERVER], {
    env: { ...process.env, WHALEFALL_DB: dbFile, WHALEFALL_TZ: 'Asia/Shanghai', WHALEFALL_NO_HARVEST: '1' },
    stdio: ['pipe', 'pipe', 'pipe'],
  });

  const pending = new Map();
  const rl = readline.createInterface({ input: child.stdout });
  rl.on('line', (line) => {
    if (!line.trim()) return;
    const msg = JSON.parse(line);
    const resolve = pending.get(msg.id);
    if (resolve) {
      pending.delete(msg.id);
      resolve(msg);
    }
  });

  let nextId = 1;
  return {
    child,
    rpc(method, params) {
      const id = nextId;
      nextId += 1;
      return new Promise((resolve, reject) => {
        const timer = setTimeout(() => {
          pending.delete(id);
          reject(new Error(`MCP 超时：${method}`));
        }, 5000);
        pending.set(id, (msg) => {
          clearTimeout(timer);
          resolve(msg);
        });
        child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id, method, params })}\n`);
      });
    },
    close() {
      rl.close();
      child.kill('SIGTERM');
    },
  };
}

test('MCP：initialize → tools/list → tools/call', async () => {
  const server = startServer();
  try {
    const init = await server.rpc('initialize', {
      protocolVersion: '2024-11-05',
      capabilities: {},
      clientInfo: { name: 'test', version: '0' },
    });
    assert.equal(init.result.serverInfo.name, 'whalefall');
    assert.equal(init.result.protocolVersion, '2024-11-05');

    const list = await server.rpc('tools/list', {});
    const names = list.result.tools.map((t) => t.name);
    assert.ok(names.includes('memory_search'));
    assert.ok(names.includes('memory_remember'));
    for (const tool of list.result.tools) assert.equal(tool.inputSchema.type, 'object');

    const remembered = await server.rpc('tools/call', {
      name: 'memory_remember',
      arguments: { title: '午饭', body: '猪脚饭，好吃', ts: '2026-11-01 12:30' },
    });
    const payload = JSON.parse(remembered.result.content[0].text);
    assert.equal(payload.ok, true);
    assert.ok(payload.id > 0);

    const searched = await server.rpc('tools/call', {
      name: 'memory_search',
      arguments: { q: '猪脚饭' },
    });
    const found = JSON.parse(searched.result.content[0].text);
    assert.equal(found.count, 1);
    assert.equal(found.items[0].title, '午饭');
  } finally {
    server.close();
  }
});

test('MCP：未知方法与未知工具都有明确错误', async () => {
  const server = startServer();
  try {
    const badMethod = await server.rpc('nope/nope', {});
    assert.equal(badMethod.error.code, -32601);

    const badTool = await server.rpc('tools/call', { name: 'memory_nope', arguments: {} });
    assert.equal(badTool.error.code, -32603);
    assert.match(badTool.error.message, /未知工具/);
  } finally {
    server.close();
  }
});

test('MCP：工具的业务错误走 isError，而不是 JSON-RPC error', async () => {
  const server = startServer();
  try {
    const res = await server.rpc('tools/call', { name: 'memory_get', arguments: {} });
    assert.equal(res.result.isError, true);
    const payload = JSON.parse(res.result.content[0].text);
    assert.equal(payload.ok, false);
    assert.match(payload.error, /id/);
  } finally {
    server.close();
  }
});
