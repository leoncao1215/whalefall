/**
 * 主动的一次心跳：闸门 → 生成 → 落库。
 *
 * 顺序不能反：先过闸门再生成，能省掉绝大多数没必要的模型调用；
 * 生成后再检查一次"是不是空话"，空话就当没发生。
 */
import { evaluateProactive, proactiveHistory, recordProactiveSend } from './proactive.mjs';
import { runSummarizerCommand } from './summarizer.mjs';
import { renderPersona } from './persona.mjs';
import { DEFAULT_TZ, bucketKey, formatLocal, parseTime } from './time.mjs';

/**
 * 主动消息的提示词。
 * 关键是最后两条：允许"不说话"，以及不许复述最近说过的话。
 */
export function buildProactivePrompt({ persona, now, tz = DEFAULT_TZ, memoryText = '', history = [] }) {
  const name = persona?.name ?? '你';
  const recent = history
    .slice(-3)
    .map((h) => `- ${formatLocal(Number(h.ts), tz)}：${h.text}`)
    .join('\n');

  return [
    `现在是 ${formatLocal(now, tz)}（${bucketKey(now, 'day', tz)}）。`,
    `你是「${name}」，现在想主动找对方说句话。`,
    '',
    '你记得的最近的事：',
    memoryText ? `<memory>\n${memoryText}\n</memory>` : '（没什么特别的）',
    '',
    '规则：',
    '1. 只有确实有话说时才开口；没有值得说的，就输出空。',
    '2. 一到两句话，别寒暄，别提"根据记忆"，别说"我注意到"。',
    '3. 不要重复你最近已经说过的话。',
    '4. 不催、不追问、不制造焦虑。',
    '',
    recent ? `你最近主动说过：\n${recent}` : '你最近没主动说过话。',
    '',
    '只输出你要说的那句话；不想说就输出空。',
  ].join('\n');
}

/**
 * @param {import('node:sqlite').DatabaseSync} db
 * @param {object} opts
 * @param {object} opts.persona
 * @param {number} opts.now
 * @param {string} [opts.tz]
 * @param {(ctx: object) => Promise<string|{text:string,model?:string}>} opts.compose
 * @param {string} [opts.memoryText]
 * @param {number} [opts.lastUserMessageAt]
 * @param {boolean} [opts.hasSubstance]
 */
export async function proactiveTick(db, opts) {
  const tz = opts.tz || DEFAULT_TZ;
  const now = Number(opts.now) || Date.now();
  const policy = opts.persona?.policy?.proactive ?? {};
  const history = proactiveHistory(db, { since: now - 3 * 86400000 });

  const verdict = evaluateProactive({
    now,
    policy,
    history,
    lastUserMessageAt: opts.lastUserMessageAt ?? null,
    hasSubstance: opts.hasSubstance !== false,
    tz,
  });
  if (!verdict.ok) return { sent: false, verdict, history };

  const composed = await opts.compose({
    persona: opts.persona,
    now,
    tz,
    history,
    memoryText: opts.memoryText ?? '',
    prompt: buildProactivePrompt({
      persona: opts.persona,
      now,
      tz,
      memoryText: opts.memoryText ?? '',
      history,
    }),
  });

  const text = String(typeof composed === 'string' ? composed : composed?.text ?? '').trim();
  if (!text) {
    return { sent: false, verdict: { ok: false, code: 'empty', reason: '生成不出值得说的话' }, history };
  }

  const model = typeof composed === 'object' ? composed?.model : undefined;
  const id = recordProactiveSend(db, {
    ts: now,
    kind: 'proactive',
    text,
    meta: model ? { model } : {},
  });

  // 可选：真的发出去（QQ / 其它通道），并把投递结果记进 meta
  let delivery = null;
  if (typeof opts.deliver === 'function') {
    try {
      delivery = await opts.deliver(text);
    } catch (error) {
      delivery = { ok: false, error: String(error?.message ?? error) };
    }
    db.prepare('UPDATE proactive_log SET meta = ? WHERE id = ?').run(
      JSON.stringify({ ...(model ? { model } : {}), delivery }),
      id,
    );
  }

  return { sent: true, id, text, verdict, history, delivery };
}

/** 用外部命令当"嘴"：payload 与 summarizer 同构，命令读 stdin JSON。 */
export function createCommandComposer(command, opts = {}) {
  const tz = opts.tz || DEFAULT_TZ;
  return async ({ persona, now, history, memoryText, prompt }) => {
    const payload = {
      kind: 'proactive',
      now,
      tz,
      prompt,
      system: persona ? renderPersona(persona).text : '',
      persona: {
        name: persona?.name ?? '',
        text: persona ? renderPersona(persona).text : '',
      },
      memory: memoryText,
      history: history.map((h) => ({ ts: h.ts, text: h.text })),
    };
    const result = await runSummarizerCommand(command, payload, { timeoutMs: opts.timeoutMs });
    return { text: result.text, model: result.model ?? 'command' };
  };
}

export function parseNow(value, tz = DEFAULT_TZ) {
  return value == null ? Date.now() : parseTime(value, tz);
}
