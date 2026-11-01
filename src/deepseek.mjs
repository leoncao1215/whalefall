/**
 * DeepSeek 摘要器（纯函数，网络注入，方便测试）。
 *
 * 为什么单独一层：脚本只是"读 stdin 写 stdout"的壳，请求构造和错误处理放这里，
 * 才能不联网就把边界情况测掉。
 *
 * 价格提示：高峰是 UTC 01–04 / 06–10（北京时间 09–12、14–18 的工作日），
 * 其余时间是空闲价，正好适合夜里跑批。节假日官方也按空闲算，这里没建日历，
 * 只会多提示、不会少收费。
 */
import { readSecrets } from './secrets.mjs';

export const DEEPSEEK_BASE_URL = 'https://api.deepseek.com';
export const DEFAULT_MODEL = 'deepseek-flash';

const SYSTEM_PROMPT = '你是记忆整理器。只输出摘要正文，不要解释、不要加标题。';

/** 是否处于高峰计价时段（按 UTC 判断，与官方口径一致）。 */
export function isPeakTime(ts = Date.now()) {
  const d = new Date(ts);
  const weekday = d.getUTCDay(); // 0 = 周日
  if (weekday === 0 || weekday === 6) return false;
  const hour = d.getUTCHours();
  return (hour >= 1 && hour < 4) || (hour >= 6 && hour < 10);
}

/** 环境变量优先，其次本地密钥库。 */
export function resolveApiKey(env = process.env, file) {
  return String(env.DEEPSEEK_API_KEY || readSecrets(file)['deepseek.apiKey'] || '');
}

/**
 * @param {object} opts
 * @param {string} opts.prompt
 * @param {string} opts.apiKey
 * @param {string} [opts.model]
 * @param {Function} [opts.fetchImpl]
 * @param {string} [opts.baseUrl]
 * @param {number} [opts.temperature]
 * @param {number} [opts.maxTokens]
 * @param {number} [opts.timeoutMs]
 */
export async function summarize(opts) {
  const {
    prompt,
    apiKey,
    model = DEFAULT_MODEL,
    fetchImpl = globalThis.fetch,
    baseUrl = process.env.DEEPSEEK_BASE_URL || DEEPSEEK_BASE_URL,
    temperature = 0.2,
    maxTokens = 600,
    timeoutMs = 120_000,
  } = opts ?? {};

  if (!apiKey) {
    throw new Error('缺少 DeepSeek API key：设置 DEEPSEEK_API_KEY，或 whalefall secret set deepseek.apiKey --prompt');
  }
  if (!String(prompt ?? '').trim()) throw new Error('prompt 为空');

  const res = await fetchImpl(`${String(baseUrl).replace(/\/+$/, '')}/chat/completions`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${apiKey}`,
    },
    body: JSON.stringify({
      model,
      messages: [
        { role: 'system', content: SYSTEM_PROMPT },
        { role: 'user', content: String(prompt) },
      ],
      temperature,
      max_tokens: maxTokens,
      stream: false,
    }),
    signal: AbortSignal.timeout(timeoutMs),
  });

  if (!res.ok) {
    const body = await res.text().catch(() => '');
    throw new Error(`DeepSeek API ${res.status}：${body.slice(0, 300)}`);
  }

  const data = await res.json();
  const text = String(data?.choices?.[0]?.message?.content ?? '').trim();
  if (!text) throw new Error('DeepSeek 返回了空内容');
  return { text, model: data?.model ?? model, usage: data?.usage ?? null };
}
