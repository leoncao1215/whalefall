import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createTokenManager, readQqConfig, sendMessage, sendProactive } from '../src/qq-send.mjs';

const PROFILE = `- id: im-qqbot
  config:
    appId: "1234567890"
    appSecret: abcdefghijklmnopqrstuvwxyz123456
    access:
      c2cMode: allowlist
      c2cAllow:
        - AAAA1111BBBB2222
    groups:
      - GGGG3333
- id: next-plugin
  config:
    foo: bar
`;

function tmpProfile(text = PROFILE) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'whalefall-qq-'));
  const file = path.join(dir, 'cordis.patch.yml');
  fs.writeFileSync(file, text);
  return file;
}

test('从 profile 解析 im-qqbot 配置', () => {
  const file = tmpProfile();
  const cfg = readQqConfig(file);
  assert.equal(cfg.appId, '1234567890');
  assert.equal(cfg.appSecret, 'abcdefghijklmnopqrstuvwxyz123456');
  assert.deepEqual(cfg.c2cAllow, ['AAAA1111BBBB2222']);
  assert.deepEqual(cfg.groupAllow, ['GGGG3333']);
});

test('profile 里没有 im-qqbot 时明确报错', () => {
  const file = tmpProfile('- id: other\n  config: {}\n');
  assert.throws(() => readQqConfig(file), /没有 im-qqbot/);
});

test('token 缓存：过期前复用，过期后刷新', async () => {
  let calls = 0;
  let clock = 1_000_000;
  const fetchImpl = async () => {
    calls += 1;
    return { ok: true, status: 200, json: async () => ({ access_token: `t${calls}`, expires_in: 7200 }) };
  };
  const mgr = createTokenManager({ appId: 'a', appSecret: 's', fetchImpl, now: () => clock });
  assert.equal(await mgr.get(), 't1');
  assert.equal(await mgr.get(), 't1');
  assert.equal(calls, 1);
  clock += 7200 * 1000;
  assert.equal(await mgr.get(), 't2');
  assert.equal(calls, 2);
});

test('发送：主动消息不带 msg_id，被动回复带 msg_id/msg_seq', async () => {
  const calls = [];
  const fetchImpl = async (url, init) => {
    calls.push({ url, body: JSON.parse(init.body), headers: init.headers });
    return { ok: true, status: 200, text: async () => JSON.stringify({ id: 'm1', timestamp: 't' }) };
  };

  const active = await sendMessage({ openid: 'u1', content: '早', accessToken: 'tk', fetchImpl });
  assert.equal(active.ok, true);
  assert.equal(active.id, 'm1');
  assert.match(calls[0].url, /\/v2\/users\/u1\/messages$/);
  assert.equal(calls[0].headers.Authorization, 'QQBot tk');
  assert.deepEqual(calls[0].body, { content: '早', msg_type: 0 });

  await sendMessage({ openid: 'u1', content: '回复', msgId: 'mid', msgSeq: 2, accessToken: 'tk', fetchImpl });
  assert.deepEqual(calls[1].body, { content: '回复', msg_type: 0, msg_id: 'mid', msg_seq: 2 });

  await sendMessage({ groupOpenid: 'g1', content: '群里', accessToken: 'tk', fetchImpl });
  assert.match(calls[2].url, /\/v2\/groups\/g1\/messages$/);
});

test('发送失败：透出平台错误码与信息', async () => {
  const fetchImpl = async () => ({
    ok: false, status: 429,
    text: async () => JSON.stringify({ code: 22009, message: 'msg limit exceed' }),
  });
  const out = await sendMessage({ openid: 'u1', content: 'x', accessToken: 'tk', fetchImpl });
  assert.equal(out.ok, false);
  assert.equal(out.status, 429);
  assert.equal(out.code, 22009);
  assert.match(out.message, /limit/);
});

test('参数缺失时拒绝发送', async () => {
  await assert.rejects(() => sendMessage({ content: 'x', accessToken: 'tk' }), /openid 或 groupOpenid/);
  await assert.rejects(() => sendMessage({ openid: 'u', content: '  ', accessToken: 'tk' }), /为空/);
  await assert.rejects(() => sendMessage({ openid: 'u', content: 'x' }), /accessToken/);
});

test('sendProactive：默认发给 c2cAllow 第一个人', async () => {
  const file = tmpProfile();
  const sent = [];
  const fetchImpl = async (url, init) => {
    sent.push({ url, init });
    if (url.includes('getAppAccessToken')) {
      return { ok: true, status: 200, json: async () => ({ access_token: 'tk', expires_in: 7200 }) };
    }
    return { ok: true, status: 200, text: async () => JSON.stringify({ id: 'm9' }) };
  };
  const out = await sendProactive('测试', { profile: file, fetchImpl });
  assert.equal(out.ok, true);
  assert.equal(out.id, 'm9');
  assert.match(sent[1].url, /\/v2\/users\/AAAA1111BBBB2222\/messages$/);
});
