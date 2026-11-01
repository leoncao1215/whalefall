/**
 * 把人格包同步进 DSH profile 的 QQ 插件配置。
 *
 * 单一来源原则：`personas/<id>/` 是唯一源头，profile 里的 `directPrompt` /
 * `groupPrompt` 是**生成物**。生成物带 BEGIN/END 标记，脚本只替换标记之间的内容，
 * 其余配置（appId、白名单、别的插件）一个字都不碰。
 *
 * 为什么不用 YAML 解析器重写整个文件：注释、顺序、锚点都会丢，而这份文件是用户
 * 手改过的；文本块替换更保守，也更容易在 diff 里看懂改了什么。
 */
import { renderPersona } from './persona.mjs';
import { MEMORY_RULES } from './assemble.mjs';

export const MARKER_BEGIN = '# >>> whalefall-persona BEGIN（由 scripts/sync-qq-persona.mjs 生成，勿手改）';
export const MARKER_END = '# <<< whalefall-persona END';

const MEMORY_SECTION = `## 记忆
你现在有一套记忆工具：memory_search / memory_timeline / memory_get / memory_summary / memory_remember / memory_forget。
- 老大提到过去的事，先查再答；不确定就说记不清，别编。
- 老大让你记住什么，用 memory_remember 存下来。
- 聊到最近几天，先 memory_summary 看大意，再决定要不要翻原文。`;

const GROUP_RULES = `## 群聊规矩
- 只在被 @ 的时候说话；一句话说清，别抢话。
- 群里有别人，私下的黏人劲儿收着点。
- 涉及老大私事，不在群里展开。`;

/** 渲染两份 prompt：私聊用完整人格，群聊加一层"收着点"的规矩。 */
export function renderQqPrompts(persona) {
  const base = renderPersona(persona).text;
  const direct = `${base}\n\n${MEMORY_SECTION}`;
  const group = `${base}\n\n${GROUP_RULES}\n\n${MEMORY_SECTION}`;
  return { direct, group };
}

function indentBlock(text, spaces) {
  const pad = ' '.repeat(spaces);
  return String(text)
    .replace(/\r\n/g, '\n')
    .split('\n')
    .map((line) => (line.trim() ? `${pad}${line}` : ''))
    .join('\n');
}

function yamlBlock(key, text, indent) {
  return `${' '.repeat(indent)}${key}: |\n${indentBlock(text, indent + 2)}`;
}

/**
 * 在 profile 文本里插入或替换人格块。
 * @param {string} source profile 的 YAML 原文
 * @param {{direct: string, group: string}} prompts
 * @returns {{text: string, action: 'inserted'|'replaced'|'unchanged'}}
 */
export function applyPersonaBlock(source, prompts) {
  const lines = String(source).replace(/\r\n/g, '\n').split('\n');

  const beginIdx = lines.findIndex((line) => line.trim() === MARKER_BEGIN);
  const endIdx = beginIdx >= 0 ? lines.findIndex((line, i) => i > beginIdx && line.trim() === MARKER_END) : -1;

  if (beginIdx >= 0 && endIdx > beginIdx) {
    const indent = lines[beginIdx].length - lines[beginIdx].trimStart().length;
    const block = [
      `${' '.repeat(indent)}${MARKER_BEGIN}`,
      yamlBlock('directPrompt', prompts.direct, indent),
      yamlBlock('groupPrompt', prompts.group, indent),
      `${' '.repeat(indent)}${MARKER_END}`,
    ].join('\n');
    const next = [...lines.slice(0, beginIdx), block, ...lines.slice(endIdx + 1)].join('\n');
    return { text: next, action: next === lines.join('\n') ? 'unchanged' : 'replaced' };
  }

  // 首次插入：找到 im-qqbot 的 config: 行，插在它后面
  const idIdx = lines.findIndex((line) => /^-\s+id:\s*im-qqbot\s*$/.test(line));
  if (idIdx < 0) throw new Error('profile 里没有找到 `- id: im-qqbot`，先装好 QQ 插件再同步');

  let configIdx = -1;
  for (let i = idIdx + 1; i < lines.length; i += 1) {
    if (/^\S/.test(lines[i])) break; // 到了下一个顶层条目
    if (/^\s+config:\s*$/.test(lines[i])) { configIdx = i; break; }
  }
  if (configIdx < 0) throw new Error('im-qqbot 下面没有找到 config:，配置结构可能变了');

  const configIndent = lines[configIdx].length - lines[configIdx].trimStart().length;
  const keyIndent = configIndent + 2;
  const block = [
    `${' '.repeat(keyIndent)}${MARKER_BEGIN}`,
    yamlBlock('directPrompt', prompts.direct, keyIndent),
    yamlBlock('groupPrompt', prompts.group, keyIndent),
    `${' '.repeat(keyIndent)}${MARKER_END}`,
  ].join('\n');

  const next = [...lines.slice(0, configIdx + 1), block, ...lines.slice(configIdx + 1)].join('\n');
  return { text: next, action: 'inserted' };
}

/** 当前 profile 里是否已经是这份人格（用于 --check）。 */
export function isInSync(source, prompts) {
  const lines = String(source).replace(/\r\n/g, '\n').split('\n');
  const beginIdx = lines.findIndex((line) => line.trim() === MARKER_BEGIN);
  if (beginIdx < 0) return false;
  const endIdx = lines.findIndex((line, i) => i > beginIdx && line.trim() === MARKER_END);
  if (endIdx < 0) return false;

  const current = lines.slice(beginIdx, endIdx + 1).join('\n');
  const expected = applyPersonaBlock(source, prompts);
  const expectedLines = expected.text.split('\n');
  const eBegin = expectedLines.findIndex((line) => line.trim() === MARKER_BEGIN);
  const eEnd = expectedLines.findIndex((line, i) => i > eBegin && line.trim() === MARKER_END);
  return current === expectedLines.slice(eBegin, eEnd + 1).join('\n');
}
