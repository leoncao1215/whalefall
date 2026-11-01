import test from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import {
  buildReplyPayload, buildValidationReply, createAccessTokenManager,
  normalizeEvent, stripMention, verifyCallbackSignature,
} from '../src/qq.mjs';

test('stripMention：去掉群聊 @ 前缀', () => {
  assert.equal(stripMention('<@!123456> 你好'), '你好');
  assert.equal(stripMention('<@123456>   今天吃什么'), '今天吃什么');
  assert.equal(stripMention('没有 at'), '没有 at');
  assert.equal(stripMention(undefined), '');
});

test('normalizeEvent：群聊 @ 事件', () => {
  const e = normalizeEvent({
    op: 0,
    t: 'GROUP_AT_MESSAGE_CREATE',
    d: {
      id: 'msg-1', content: '<@!9> 午饭吃啥', group_openid: 'g-1',
      author: { member_openid: 'u-1' }, timestamp: '2026-11-01T12:00:00+08:00',
    },
  });
  assert.equal(e.kind, 'group');
  assert.equal(e.text, '午饭吃啥');
  assert.equal(e.groupOpenid, 'g-1');
  assert.equal(e.messageId, 'msg-1');
  assert.equal(e.ts, Date.parse('2026-11-01T12:00:00+08:00'));
});

test('normalizeEvent：私聊事件与非消息事件', () => {
  const c2c = normalizeEvent({
    op: 0, t: 'C2C_MESSAGE_CREATE',
    d: { id: 'm2', content: '在吗', author: { user_openid: 'u2' } },
  }, { now: 1000 });
  assert.equal(c2c.kind, 'c2c');
  assert.equal(c2c.ts, 1000);

  assert.equal(normalizeEvent({ op: 0, t: 'GROUP_ADD_ROBOT', d: {} }).kind, 'other');
  assert.equal(normalizeEvent({ op: 13 }).kind, 'ignored');
});

test('buildReplyPayload：群聊与私聊的 URL / body', () => {
  const group = buildReplyPayload(
    { kind: 'group', groupOpenid: 'g-1', messageId: 'm1' }, '好的', { msgSeq: 2 },
  );
  assert.equal(group.url, 'https://api.sgroup.qq.com/v2/groups/g-1/messages');
  assert.deepEqual(group.body, { content: '好的', msg_type: 0, msg_id: 'm1', msg_seq: 2 });

  const c2c = buildReplyPayload({ kind: 'c2c', userOpenid: 'u-1', messageId: 'm2' }, '在');
  assert.equal(c2c.url, 'https://api.sgroup.qq.com/v2/users/u-1/messages');

  assert.throws(() => buildReplyPayload({ kind: 'other' }, 'x'), /只能回复/);
  assert.throws(() => buildReplyPayload({ kind: 'group', groupOpenid: 'g' }, 'x'), /messageId/);
  assert.throws(() => buildReplyPayload({ kind: 'group', groupOpenid: 'g', messageId: 'm' }, '  '), /为空/);
});

test('签名校验：正确签名通过，改一个字节就失败', () => {
  const { publicKey, privateKey } = crypto.generateKeyPairSync('ed25519');
  const ts = '1793500000';
  const body = JSON.stringify({ op: 0, t: 'C2C_MESSAGE_CREATE', d: { id: 'x' } });
  const message = Buffer.concat([Buffer.from(ts), Buffer.from(body)]);
  const signature = crypto.sign(null, message, privateKey).toString('hex');

  const good = verifyCallbackSignature({
    publicKey, rawBody: body, timestamp: ts, signature, now: Number(ts) * 1000,
  });
  assert.equal(good.ok, true);

  const tampered = verifyCallbackSignature({
    publicKey, rawBody: `${body} `, timestamp: ts, signature, now: Number(ts) * 1000,
  });
  assert.equal(tampered.ok, false);
  assert.equal(tampered.reason, 'bad-signature');

  const stale = verifyCallbackSignature({
    publicKey, rawBody: body, timestamp: ts, signature, now: Number(ts) * 1000 + 10 * 60 * 1000,
  });
  assert.equal(stale.reason, 'expired');

  assert.equal(verifyCallbackSignature({ rawBody: body, timestamp: ts, signature }).reason, 'missing-public-key');
  assert.equal(verifyCallbackSignature({ publicKey, rawBody: body, timestamp: ts }).reason, 'missing-headers');
});

test('回调验证（op=13）：返回的签名能被同一把公钥验过', () => {
  const { publicKey, privateKey } = crypto.generateKeyPairSync('ed25519');
  const reply = buildValidationReply({
    plainToken: 'token-abc',
    eventTs: '1793500000',
    sign: (message) => crypto.sign(null, message, privateKey),
  });
  assert.equal(reply.plain_token, 'token-abc');

  const ok = verifyCallbackSignature({
    publicKey,
    rawBody: 'token-abc',
    timestamp: '1793500000',
    signature: reply.signature,
    now: 1793500000 * 1000,
  });
  assert.equal(ok.ok, true);
});

test('access token：缓存命中、过期刷新、并发合并', async () => {
  let calls = 0;
  let clock = 1_000_000;
  const fetchImpl = async () => {
    calls += 1;
    await new Promise((r) => setTimeout(r, 10));
    return { ok: true, status: 200, json: async () => ({ access_token: `t${calls}`, expires_in: 7200 }) };
  };
  const mgr = createAccessTokenManager({
    appId: 'a', clientSecret: 's', fetchImpl, now: () => clock,
  });

  const [a, b] = await Promise.all([mgr.get(), mgr.get()]);
  assert.equal(a, 't1');
  assert.equal(b, 't1');
  assert.equal(calls, 1, '并发请求应合并成一次');

  assert.equal(await mgr.get(), 't1');
  assert.equal(calls, 1, '未过期应命中缓存');

  clock += 7200 * 1000;
  assert.equal(await mgr.get(), 't2');
  assert.equal(calls, 2);
});

test('access token：平台报错时抛出可读原因', async () => {
  const mgr = createAccessTokenManager({
    appId: 'a', clientSecret: 's',
    fetchImpl: async () => ({ ok: false, status: 401, json: async () => ({}) }),
  });
  await assert.rejects(() => mgr.get(), /HTTP 401/);
});
