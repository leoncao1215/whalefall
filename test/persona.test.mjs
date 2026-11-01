import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { listPersonas, loadPersona, renderPersona } from '../src/persona.mjs';

const ROOT = path.dirname(fileURLToPath(import.meta.url));
const EXAMPLE = path.join(ROOT, '..', 'personas', 'dafeiyu');

function tmpDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'whalefall-persona-'));
}

test('示例人格包能载入', () => {
  const persona = loadPersona(EXAMPLE);
  assert.equal(persona.id, 'dafeiyu');
  assert.equal(persona.name, '大肥鱼');
  assert.ok(persona.identity.length > 50);
  assert.ok(persona.examples.length >= 3);
  assert.equal(persona.policy.proactive.dailyMax, 3);
});

test('渲染结果包含身份、风格、主动策略、边界与示例', () => {
  const persona = loadPersona(EXAMPLE);
  const { text, tokens } = renderPersona(persona);
  assert.match(text, /# 你是 大肥鱼/);
  assert.match(text, /## 说话方式/);
  assert.match(text, /安静时段/);
  assert.match(text, /## 边界/);
  assert.match(text, /用户：/);
  assert.ok(tokens > 100 && tokens < 2000, `tokens=${tokens}`);
});

test('缺 persona.json 时报错', () => {
  const dir = tmpDir();
  assert.throws(() => loadPersona(dir), /不是人格包/);
});

test('示例格式不对时报错', () => {
  const dir = tmpDir();
  fs.writeFileSync(path.join(dir, 'persona.json'), JSON.stringify({ id: 'x', name: 'X' }));
  fs.writeFileSync(path.join(dir, 'identity.md'), '身份');
  fs.writeFileSync(path.join(dir, 'examples.jsonl'), '{"user":"只有用户"}\n');
  assert.throws(() => loadPersona(dir), /需要 user 与 assistant/);
});

test('listPersonas 能发现示例包', () => {
  const list = listPersonas(path.join(ROOT, '..', 'personas'));
  assert.ok(list.some((p) => p.id === 'dafeiyu'));
});
