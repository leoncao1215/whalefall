/**
 * 摘要器适配层：不绑定厂商，任何"读 stdin JSON、写 stdout"的命令都能当模型。
 *
 * 契约：
 *   stdin  ← { level, bucket:{key,start,end}, tz, prompt, events:[{ts,title,body,kind,actors}] }
 *   stdout → 纯文本摘要，或 {"text":"...","model":"..."}
 *
 * 这样 `ollama run qwen`、`llm -m ...`、自家脚本都能用；
 * 没有模型时用 createMockSummarizer() 跑通链路。
 */
import { spawn } from 'node:child_process';
import { formatLocal } from './time.mjs';

const LEVEL_LABEL = {
  day: '这一天',
  week: '这一周',
  month: '这个月',
  year: '这一年',
};

const LEVEL_LENGTH = {
  day: '3~5 句',
  week: '5~8 句',
  month: '6~10 句',
  year: '8~12 句',
};

/** 给人/模型看的提示词，刻意短：摘要要做的是压缩，不是创作。 */
export function buildSummarizerPrompt({ level, bucket, tz, events }) {
  const lines = events
    .map((e) => {
      const when = formatLocal(e.ts, e.tz || tz);
      const body = e.body ? `：${e.body}` : '';
      return `- ${when} [${e.kind}] ${e.title}${body}`;
    })
    .join('\n');

  return [
    `你是记忆整理器。请把${LEVEL_LABEL[level] ?? '这段时间'}的事件压缩成中文摘要。`,
    '要求：',
    '1. 只保留：做了什么、和谁、结果或感受、没做完的事；',
    '2. 不编造，不确定的信息直接省略；',
    `3. 长度 ${LEVEL_LENGTH[level] ?? '3~6 句'}，不要分点，不要标题；`,
    '4. 只输出摘要正文。',
    '',
    `时间范围：${bucket.key}（时区 ${tz}）`,
    '事件：',
    lines,
  ].join('\n');
}

export function summarizerPayload({ level, bucket, tz, events }) {
  return {
    level,
    tz,
    bucket: { key: bucket.key, start: bucket.start, end: bucket.end },
    prompt: buildSummarizerPrompt({ level, bucket, tz, events }),
    events: events.map((e) => ({
      ts: e.ts,
      kind: e.kind,
      title: e.title,
      body: e.body,
      actors: e.actors,
    })),
  };
}

/**
 * 跑一个外部命令当摘要器。
 * @param {string} command 交给 shell 执行；这是用户自己的命令，不做转义
 * @param {object} payload
 * @param {{timeoutMs?: number, cwd?: string, env?: Record<string,string>}} [opts]
 * @returns {Promise<{text: string, model: string|null, raw: string}>}
 */
export function runSummarizerCommand(command, payload, opts = {}) {
  const timeoutMs = Number(opts.timeoutMs) || 60_000;
  return new Promise((resolve, reject) => {
    let child;
    try {
      child = spawn(command, {
        shell: true,
        cwd: opts.cwd,
        env: { ...process.env, ...(opts.env ?? {}) },
        stdio: ['pipe', 'pipe', 'pipe'],
      });
    } catch (error) {
      reject(error);
      return;
    }

    let stdout = '';
    let stderr = '';
    let settled = false;

    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      child.kill('SIGTERM');
      reject(new Error(`summarizer 超时（${timeoutMs}ms）：${command}`));
    }, timeoutMs);

    child.stdout.on('data', (chunk) => { stdout += chunk; });
    child.stderr.on('data', (chunk) => { stderr += chunk; });
    child.on('error', (error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      reject(error);
    });
    child.on('close', (code) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (code !== 0) {
        reject(new Error(`summarizer 退出码 ${code}：${stderr.trim().slice(0, 500) || command}`));
        return;
      }
      const raw = stdout.trim();
      if (!raw) {
        reject(new Error('summarizer 没有输出'));
        return;
      }
      let parsed = null;
      if (raw.startsWith('{')) {
        try { parsed = JSON.parse(raw); } catch { parsed = null; }
      }
      const text = typeof parsed?.text === 'string' ? parsed.text.trim() : raw;
      if (!text) {
        reject(new Error('summarizer 输出为空'));
        return;
      }
      resolve({ text, model: typeof parsed?.model === 'string' ? parsed.model : null, raw });
    });

    child.stdin.on('error', () => { /* 命令提前退出时忽略 EPIPE */ });
    child.stdin.end(JSON.stringify(payload));
  });
}

/** 把命令包装成 applyRollup 需要的 summarizer。 */
export function createCommandSummarizer(command, opts = {}) {
  if (!command) throw new Error('缺少 summarizer 命令');
  return async ({ level, bucket, tz, events }) => {
    const payload = summarizerPayload({ level, bucket, tz, events });
    const result = await runSummarizerCommand(command, payload, opts);
    return { text: result.text, model: result.model ?? 'command' };
  };
}

/**
 * 没有模型时的假摘要器：只做机械压缩，用来验证链路与写库，
 * 不要拿它的输出当记忆质量看。
 */
export function createMockSummarizer() {
  return async ({ level, bucket, events }) => {
    const titles = events.slice(0, 5).map((e) => e.title).filter(Boolean);
    const more = events.length > titles.length ? ` 等 ${events.length} 条` : '';
    return {
      text: `【${bucket.key}·${level}】${titles.join('、')}${more}`,
      model: 'mock',
    };
  };
}
