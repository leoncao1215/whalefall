#!/usr/bin/env node
// 测试用的假模型：读 stdin 的 payload，回一段可预测的摘要。
const chunks = [];
process.stdin.on('data', (c) => chunks.push(c));
process.stdin.on('end', () => {
  const payload = JSON.parse(Buffer.concat(chunks).toString('utf8'));
  const n = payload.events.length;
  const first = payload.events[0] ? `${payload.events[0].title}：${payload.events[0].body}` : '(空)';
  process.stdout.write(JSON.stringify({
    text: `${payload.bucket.key} 共 ${n} 条，第一条是「${first}」，提示词 ${payload.prompt.length} 字`,
    model: 'fake-llm-0.1',
  }));
});
