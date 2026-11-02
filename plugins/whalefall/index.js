/**
 * 把 whalefall 个体接进 DSH。
 *
 * 只做两件事：
 *   1. 每轮构建 system prompt 时，追加她的人格（persona/，每轮重读，改完即生效）；
 *   2. 追加跨渠道最近对话（<recent>），让她知道别的渠道刚聊过什么。
 *
 * 作用范围：cwd 等于个体目录的会话。工作会话不受影响。
 */
import fs from 'node:fs';
import path from 'node:path';
import { resolveInstance } from '../../src/instance.mjs';
import { loadPersona, renderPersona } from '../../src/persona.mjs';
import { openDb, closeDb } from '../../src/db.mjs';
import { renderRecentThreads } from '../../src/threads.mjs';
import { MEMORY_RULES } from '../../src/assemble.mjs';

export const name = 'whalefall';
export const inject = ['agents'];

function plain(value) {
  return value && typeof value.get === 'function' ? value.get() : value;
}

export function apply(ctx, config = {}) {
  const settings = plain(config) ?? {};
  const instance = resolveInstance(settings.instance || process.env.WHALEFALL_INSTANCE);
  const recentLimit = Number(settings.recentLimit) || 8;
  const tz = settings.tz || process.env.WHALEFALL_TZ || 'Asia/Shanghai';

  let db = null;
  const getDb = () => (db ??= openDb(instance.db));
  // 允许软链与子目录：只要落在个体目录里，就算“她”
  const inInstance = (cwd) => {
    const target = path.resolve(String(cwd));
    const root = path.resolve(instance.dir);
    try {
      const realTarget = fs.realpathSync(target);
      const realRoot = fs.realpathSync(root);
      return realTarget === realRoot || realTarget.startsWith(`${realRoot}${path.sep}`);
    } catch {
      return target === root || target.startsWith(`${root}${path.sep}`);
    }
  };

  const assemble = async (assembly, context, next) => {
    const assembled = await next();
    const agent = context?.agent;
    if (!agent) return assembled;

    // 只认"工作目录就是个体目录"的会话
    const cwd = agent.session?.cwd;
    if (!cwd || !inInstance(cwd)) return assembled;

    let persona;
    try {
      persona = loadPersona(instance.personaDir);
    } catch {
      return assembled; // 人格包坏了就退回默认，不拖垮会话
    }

    const recent = renderRecentThreads(getDb(), {
      tz,
      limit: recentLimit,
      excludeSessionId: agent.id,
    });

    const text = [
      renderPersona(persona).text,
      MEMORY_RULES,
      recent ? `<recent>\n${recent}\n</recent>` : '',
    ].filter(Boolean).join('\n\n');

    return {
      ...assembled,
      sections: [...(assembled.sections ?? []), { name: 'whalefall:persona', order: 95, text }],
    };
  };

  ctx.on('system-prompt/assemble', assemble);

  ctx.on('dispose', () => {
    if (db) closeDb(db);
    db = null;
  });
}
