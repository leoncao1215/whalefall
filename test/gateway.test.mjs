import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { openDb, closeDb } from '../src/db.mjs';
import { loadPersona } from '../src/persona.mjs';
import { createGateway } from '../src/gateway.mjs';
import { recordProactiveSend } from '../src/proactive.mjs';

const ROOT = path.dirname(fileURLToPath(import.meta.url));
const PERSONA = loadPersona(path.join(ROOT, '..', 'personas', 'dafeiyu'));
const TOKEN = 'test-token-0123456789abcdef';

async function start(overrides = {}) {
  const db = overrides.db ?? openDb(':memory:');
  const server = createGateway({
    db,
    token: TOKEN,
    persona: PERSONA,
    responder: async ({ text }) => `收到：${text}`,
    pollMs: 50,
    ...overrides,
    // db/persona 已在上面展开，避免被 overrides 覆盖后丢失
    ...(overrides.db ? {} : {}),
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address();
  return {
    db,
    server,
    base: `http://127.0.0.1:${port}`,
    async close() {
      await new Promise((resolve) => server.close(resolve));
      closeDb(db);
    },
  };
}

test('网关：没 token 一律 401', async () => {
  const gw = await start();
  try {
    assert.equal((await fetch(`${gw.base}/health`)).status, 401);
    assert.equal((await fetch(`${gw.base}/v1/chat`, { method: 'POST', body: '{}' })).status, 401);
    const ok = await fetch(`${gw.base}/health`, { headers: { Authorization: `Bearer ${TOKEN}` } });
    assert.equal(ok.status, 200);
    assert.equal((await ok.json()).name, 'whalefall-gateway');
  } finally {
    await gw.close();
  }
});

test('网关：聊天往返，消息与回复都落库', async () => {
  const gw = await start();
  try {
    const res = await fetch(`${gw.base}/v1/chat`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${TOKEN}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ text: '在吗' }),
    });
    assert.equal(res.status, 200);
    const body = await res.json();
    assert.equal(body.ok, true);
    assert.equal(body.reply, '收到：在吗');
    assert.ok(body.userEventId > 0);
    assert.ok(body.replyEventId > body.userEventId);

    const history = await fetch(`${gw.base}/v1/history?limit=10`, {
      headers: { Authorization: `Bearer ${TOKEN}` },
    });
    const items = (await history.json()).items;
    assert.equal(items.length, 2);
    assert.deepEqual(items.map((i) => i.kind), ['message', 'reply']);
    assert.equal(items[1].body, '收到：在吗');
  } finally {
    await gw.close();
  }
});

test('网关：空消息 400', async () => {
  const gw = await start();
  try {
    const res = await fetch(`${gw.base}/v1/chat`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${TOKEN}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ text: '   ' }),
    });
    assert.equal(res.status, 400);
  } finally {
    await gw.close();
  }
});

test('网关：回复失败返回 502，且不写回复事件', async () => {
  const gw = await start({
    responder: async () => { throw new Error('模型挂了'); },
  });
  try {
    const res = await fetch(`${gw.base}/v1/chat`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${TOKEN}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ text: '在吗' }),
    });
    assert.equal(res.status, 502);
    const rows = gw.db.prepare("SELECT kind FROM events WHERE source='pet'").all();
    assert.deepEqual(rows.map((r) => r.kind), ['message']);
  } finally {
    await gw.close();
  }
});

test('网关：SSE 能收到主动消息', async () => {
  const gw = await start();
  const ac = new AbortController();
  try {
    const res = await fetch(`${gw.base}/v1/stream?token=${TOKEN}`, { signal: ac.signal });
    assert.equal(res.status, 200);
    assert.match(res.headers.get('content-type'), /text\/event-stream/);

    recordProactiveSend(gw.db, { text: '该喝水了' });

    const reader = res.body.getReader();
    const decoder = new TextDecoder();
    let buffer = '';
    const deadline = Date.now() + 3000;
    while (Date.now() < deadline && !buffer.includes('该喝水了')) {
      const { value, done } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
    }
    reader.cancel().catch(() => {});
    assert.match(buffer, /event: message/);
    assert.match(buffer, /该喝水了/);
  } finally {
    ac.abort();
    await gw.close();
  }
});

test('网关：参数不合法时拒绝启动', () => {
  const db = openDb(':memory:');
  try {
    assert.throws(() => createGateway({ db, token: 'short', responder: async () => '' }), /token/);
    assert.throws(() => createGateway({ token: TOKEN, responder: async () => '' }), /db/);
  } finally {
    closeDb(db);
  }
});
