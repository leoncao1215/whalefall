/**
 * 人格包：身份、说话方式、行为边界、示例。
 *
 * 故意拆成四份而不是一个 md：
 *   identity.md   我是谁（稳定，写得越像人越好）
 *   policy.json   什么时候主动、什么不能说、风格约束（可被代码读取）
 *   examples.jsonl 真实对话样本（比一堆形容词有用）
 *   persona.json  清单与版本
 *
 * 关系状态（认识你多久、知道你什么）**不属于人格**，那在记忆里。
 */
import fs from 'node:fs';
import path from 'node:path';
import { estimateTokens } from './context.mjs';

function readJson(file) {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch (error) {
    throw new Error(`读取 ${file} 失败：${error.message}`);
  }
}

function readJsonl(file) {
  return fs
    .readFileSync(file, 'utf8')
    .split('\n')
    .map((line) => line.trim())
    .filter(Boolean)
    .map((line, i) => {
      try {
        return JSON.parse(line);
      } catch (error) {
        throw new Error(`${file} 第 ${i + 1} 行不是合法 JSON：${error.message}`);
      }
    });
}

/**
 * 载入一个目录形式的人格包。
 * @param {string} dir
 */
export function loadPersona(dir) {
  const root = path.resolve(dir);
  const manifestFile = path.join(root, 'persona.json');
  if (!fs.existsSync(manifestFile)) throw new Error(`不是人格包（缺 persona.json）：${root}`);
  const manifest = readJson(manifestFile);

  if (!manifest.id) throw new Error(`${manifestFile} 缺少 id`);
  if (!manifest.name) throw new Error(`${manifestFile} 缺少 name`);

  const identityFile = path.join(root, manifest.identityFile ?? 'identity.md');
  if (!fs.existsSync(identityFile)) throw new Error(`缺少身份文件：${identityFile}`);
  const identity = fs.readFileSync(identityFile, 'utf8').trim();
  if (!identity) throw new Error(`身份文件是空的：${identityFile}`);

  const policyFile = path.join(root, manifest.policyFile ?? 'policy.json');
  const policy = fs.existsSync(policyFile) ? readJson(policyFile) : {};

  const examplesFile = path.join(root, manifest.examplesFile ?? 'examples.jsonl');
  const examples = fs.existsSync(examplesFile) ? readJsonl(examplesFile) : [];

  for (const [i, ex] of examples.entries()) {
    if (!ex.user || !ex.assistant) throw new Error(`${examplesFile} 第 ${i + 1} 条需要 user 与 assistant`);
  }

  return {
    id: String(manifest.id),
    name: String(manifest.name),
    version: String(manifest.version ?? '0.0.0'),
    description: manifest.description ? String(manifest.description) : '',
    identity,
    policy,
    examples,
    root,
  };
}

function bulletList(items, prefix = '- ') {
  return (items ?? []).map((x) => `${prefix}${x}`).join('\n');
}

/** 把人格包渲染成一段系统提示词。 */
export function renderPersona(persona) {
  const lines = [];
  lines.push(`# 你是 ${persona.name}`);
  if (persona.description) lines.push(persona.description);
  lines.push('');
  lines.push('## 身份');
  lines.push(persona.identity.trim());

  const style = persona.policy?.style;
  if (style) {
    lines.push('');
    lines.push('## 说话方式');
    if (style.tone) lines.push(`- 语气：${style.tone}`);
    if (style.length) lines.push(`- 长度：${style.length}`);
    if (Array.isArray(style.avoid) && style.avoid.length) lines.push(`- 避免：${style.avoid.join('、')}`);
  }

  const proactive = persona.policy?.proactive;
  if (proactive) {
    lines.push('');
    lines.push('## 主动联系');
    if (proactive.quietHours?.length) lines.push(`- 安静时段：${proactive.quietHours.join('、')}`);
    if (proactive.dailyMax != null) lines.push(`- 每天最多 ${proactive.dailyMax} 次`);
    if (proactive.minGapMinutes != null) lines.push(`- 两次之间至少 ${proactive.minGapMinutes} 分钟`);
    if (proactive.rule) lines.push(`- ${proactive.rule}`);
  }

  if (Array.isArray(persona.policy?.boundaries) && persona.policy.boundaries.length) {
    lines.push('');
    lines.push('## 边界');
    lines.push(bulletList(persona.policy.boundaries));
  }

  if (persona.examples.length) {
    lines.push('');
    lines.push('## 对话示例');
    for (const ex of persona.examples.slice(0, 5)) {
      lines.push(`用户：${ex.user}`);
      lines.push(`你：${ex.assistant}`);
    }
  }

  const text = lines.join('\n').trim();
  return { text, tokens: estimateTokens(text) };
}

/** 列出一个人格目录下的所有包（子目录里带 persona.json 的）。 */
export function listPersonas(rootDir) {
  if (!fs.existsSync(rootDir)) return [];
  return fs
    .readdirSync(rootDir, { withFileTypes: true })
    .filter((d) => d.isDirectory())
    .map((d) => path.join(rootDir, d.name))
    .filter((dir) => fs.existsSync(path.join(dir, 'persona.json')))
    .map((dir) => {
      const manifest = readJson(path.join(dir, 'persona.json'));
      return { id: manifest.id, name: manifest.name, version: manifest.version ?? '0.0.0', dir };
    });
}
