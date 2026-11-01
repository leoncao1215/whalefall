#!/usr/bin/env node
/**
 * 把人格包同步进 DSH profile 的 QQ 插件配置。
 *
 *   node scripts/sync-qq-persona.mjs --check     # 只看有没有漂移，不写
 *   node scripts/sync-qq-persona.mjs             # 写入（自动备份）
 *   node scripts/sync-qq-persona.mjs --dry-run   # 打印将写入的内容
 *
 * 改完需要重启 DSH 才生效。
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { loadPersona } from '../src/persona.mjs';
import { applyPersonaBlock, isInSync, renderQqPrompts } from '../src/persona-sync.mjs';

const args = process.argv.slice(2);
const flag = (name) => args.includes(`--${name}`);
const value = (name) => {
  const i = args.indexOf(`--${name}`);
  return i >= 0 && args[i + 1] && !args[i + 1].startsWith('--') ? args[i + 1] : null;
};

const personaDir = value('persona') || 'personas/dafeiyu';
const profile = value('profile') || 'web';
const file = value('file') || path.join(
  process.env.DSH_HOME || path.join(os.homedir(), '.dsh'),
  'profiles', profile, 'cordis.patch.yml',
);

try {
  const persona = loadPersona(personaDir);
  const prompts = renderQqPrompts(persona);

  if (!fs.existsSync(file)) throw new Error(`找不到 profile 文件：${file}`);
  const source = fs.readFileSync(file, 'utf8');

  if (flag('check')) {
    const synced = isInSync(source, prompts);
    console.log(synced ? '✅ 已同步' : '❌ 有漂移：跑一次 sync-qq-persona.mjs 更新');
    process.exit(synced ? 0 : 1);
  }

  const { text, action } = applyPersonaBlock(source, prompts);
  if (flag('dry-run')) {
    console.log(text);
    process.exit(0);
  }

  if (action === 'unchanged') {
    console.log('没有变化，跳过写入。');
    process.exit(0);
  }

  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  const backup = `${file}.bak-${stamp}`;
  fs.copyFileSync(file, backup);
  fs.writeFileSync(file, text, 'utf8');

  console.log(`已${action === 'inserted' ? '插入' : '更新'}人格块 → ${file}`);
  console.log(`备份：${backup}`);
  console.log(`persona：${persona.name} v${persona.version}（私聊 ${prompts.direct.length} 字 / 群聊 ${prompts.group.length} 字）`);
  console.log('需要重启 DSH 才生效。');
} catch (error) {
  console.error(`错误：${error?.message ?? error}`);
  process.exit(1);
}
