import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { DEFAULT_MODEL, isPeakTime, resolveApiKey, summarize } from '../src/deepseek.mjs';
import { writeSecrets } from '../src/secrets.mjs';

const MONDAY = Date.UTC(2026, 10, 2); // 2026-11-02 是周一

function fakeFetch(response) {
  const calls = [];
  const impl = async (url, init) => {
    calls.push({ url, init });
    return typeof response === 'function' ? response(url, init) : response;
  };
  return { impl, calls };
}

function okJson(body) {
  return { ok: true, status: 200, json: async () => body, text: async () => JSON.stringify(body) };
}

test('高峰时段判断（UTC 01–04 / 06–10 工作日）', () => {
  assert.equal(isPeakTime(MONDAY + 1 * 3600000), true);
  assert.equal(isPeakTime(MONDAY + 3 * 3600000 + 59 * 60000), true);
  assert.equal(isPeakTime(MONDAY + 4 * 3600000), false);
  assert.equal(isPeakTime(MONDAY + 6 * 3600000), true);
  assert.equal(isPeakTime(MONDAY + 10 * 3600000), false);
  // 周末全天不算高峰
  const saturday = Date.UTC(2026, 10, 7, 2);
  assert.equal(isPeakTime(saturday), false);
});

test('构造请求：URL / 鉴权 / 模型 / 消息', async () => {
  const { impl, calls } = fakeFetch(okJson({
    model: 'deepseek-flash',
    choices: [{ message: { content: '  这天吃了猪脚饭。  ' } }],
    usage: { prompt_tokens: 100, completion_tokens: 20 },
  }));

  const out = await summarize({ prompt: '事件列表……', apiKey: 'sk-test', fetchImpl: impl });
  assert.equal(calls.length, 1);
  assert.equal(calls[0].url, 'https://api.deepseek.com/chat/completions');
  assert.equal(calls[0].init.method, 'POST');
  assert.equal(calls[0].init.headers.Authorization, 'Bearer sk-test');
  assert.equal(calls[0].init.headers['Content-Type'], 'application/json');

  const body = JSON.parse(calls[0].init.body);
  assert.equal(body.model, DEFAULT_MODEL);
  assert.equal(body.stream, false);
  assert.equal(body.temperature, 0.2);
  assert.equal(body.messages.length, 2);
  assert.match(body.messages[0].content, /记忆整理器/);
  assert.equal(body.messages[1].content, '事件列表……');

  assert.equal(out.text, '这天吃了猪脚饭。');
  assert.equal(out.model, 'deepseek-flash');
  assert.equal(out.usage.completion_tokens, 20);
});

test('非 2xx 时报出状态码与响应片段', async () => {
  const { impl } = fakeFetch({
    ok: false, status: 402,
    text: async () => '{"error":{"message":"Insufficient Balance"}}',
  });
  await assert.rejects(
    () => summarize({ prompt: 'x', apiKey: 'k', fetchImpl: impl }),
    /DeepSeek API 402.*Insufficient Balance/s,
  );
});

test('空内容与缺 key 都明确报错', async () => {
  const { impl } = fakeFetch(okJson({ choices: [{ message: { content: '   ' } }] }));
  await assert.rejects(() => summarize({ prompt: 'x', apiKey: 'k', fetchImpl: impl }), /空内容/);
  await assert.rejects(() => summarize({ prompt: 'x', apiKey: '', fetchImpl: impl }), /缺少 DeepSeek API key/);
  await assert.rejects(() => summarize({ prompt: '   ', apiKey: 'k', fetchImpl: impl }), /prompt 为空/);
});

test('密钥来源：环境变量优先，其次密钥文件', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'whalefall-ds-'));
  const file = path.join(dir, 'secrets.json');
  writeSecrets({ 'deepseek.apiKey': 'from-file' }, file);
  assert.equal(resolveApiKey({}, file), 'from-file');
  assert.equal(resolveApiKey({ DEEPSEEK_API_KEY: 'from-env' }, file), 'from-env');
  assert.equal(resolveApiKey({}, path.join(dir, 'missing.json')), '');
});
