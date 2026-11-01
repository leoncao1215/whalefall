#!/usr/bin/env node
/**
 * whalefall 摘要器 → DeepSeek。
 *
 * 契约：stdin 收 rollup 的 payload（JSON），stdout 返回 {"text","model","usage"}。
 * 用法：
 *   node src/cli.mjs rollup --summarizer "node scripts/deepseek-summarize.mjs" --level day --days 7
 */
import { isPeakTime, resolveApiKey, summarize } from '../src/deepseek.mjs';

async function readStdin() {
  const chunks = [];
  for await (const chunk of process.stdin) chunks.push(chunk);
  return Buffer.concat(chunks).toString('utf8');
}

try {
  const raw = (await readStdin()).trim();
  if (!raw) throw new Error('stdin 没有内容（这个脚本要给 rollup 用，不能单独跑）');
  const payload = JSON.parse(raw);
  const prompt = payload.prompt;
  if (!prompt) throw new Error('payload 里没有 prompt');

  if (isPeakTime()) {
    process.stderr.write('[whalefall] 现在是高峰时段（价格约为空闲的 2 倍），建议改到夜里跑批\n');
  }

  const result = await summarize({
    prompt,
    apiKey: resolveApiKey(),
    system: payload.system || undefined,
    model: process.env.DEEPSEEK_MODEL || undefined,
    maxTokens: Number(process.env.DEEPSEEK_MAX_TOKENS) || 600,
  });

  process.stdout.write(JSON.stringify(result));
} catch (error) {
  process.stderr.write(`[whalefall] 摘要失败：${error?.message ?? error}\n`);
  process.exit(1);
}
