import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadPersona } from '../src/persona.mjs';
import {
  applyPersonaBlock, isInSync, MARKER_BEGIN, MARKER_END, renderQqPrompts,
} from '../src/persona-sync.mjs';

const ROOT = path.dirname(fileURLToPath(import.meta.url));
const PERSONA = loadPersona(path.join(ROOT, '..', 'personas', 'dafeiyu'));

const PROFILE = `# profile
- id: im-qqbot
  config:
    appId: "123"
    appSecret: secret
    access:
      c2cMode: allowlist
- id: other-plugin
  config:
    foo: bar
`;

test('渲染：私聊与群聊两份 prompt 都有记忆规则', () => {
  const { direct, group } = renderQqPrompts(PERSONA);
  assert.match(direct, /大肥鱼/);
  assert.match(direct, /memory_search/);
  assert.match(group, /群聊规矩/);
  assert.match(group, /memory_search/);
  assert.ok(group.length > direct.length, '群聊版应该多一段规矩');
});

test('首次插入：块放在 im-qqbot 的 config 下面，别的插件不受影响', () => {
  const { direct, group } = renderQqPrompts(PERSONA);
  const { text, action } = applyPersonaBlock(PROFILE, { direct, group });
  assert.equal(action, 'inserted');
  assert.ok(text.indexOf(MARKER_BEGIN) > text.indexOf('  config:'));
  assert.ok(text.indexOf(MARKER_BEGIN) < text.indexOf('appId'));
  assert.ok(text.includes('    directPrompt: |'));
  assert.ok(text.includes('    groupPrompt: |'));
  assert.ok(text.includes('- id: other-plugin'));
  assert.ok(text.endsWith('\n'));
});

test('幂等：再跑一次不产生变化', () => {
  const { direct, group } = renderQqPrompts(PERSONA);
  const first = applyPersonaBlock(PROFILE, { direct, group });
  const second = applyPersonaBlock(first.text, { direct, group });
  assert.equal(second.action, 'unchanged');
  assert.equal(second.text, first.text);
});

test('替换：人格内容变了就更新，并且不重复插入', () => {
  const { direct, group } = renderQqPrompts(PERSONA);
  const first = applyPersonaBlock(PROFILE, { direct, group });
  const changed = applyPersonaBlock(first.text, {
    direct: `${direct}\n（新加的一句）`,
    group,
  });
  assert.equal(changed.action, 'replaced');
  assert.equal(changed.text.split(MARKER_BEGIN).length - 1, 1);
  assert.match(changed.text, /新加的一句/);
});

test('isInSync：同步后为真，漂移后为假', () => {
  const { direct, group } = renderQqPrompts(PERSONA);
  const applied = applyPersonaBlock(PROFILE, { direct, group });
  assert.equal(isInSync(applied.text, { direct, group }), true);
  assert.equal(isInSync(applied.text, { direct: `${direct} 改过`, group }), false);
  assert.equal(isInSync(PROFILE, { direct, group }), false);
});

test('没有 im-qqbot 时明确报错', () => {
  const { direct, group } = renderQqPrompts(PERSONA);
  assert.throws(() => applyPersonaBlock('- id: other\n  config: {}\n', { direct, group }), /im-qqbot/);
});
