import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { initInstance, listInstances, resolveInstance, templateDir } from '../src/instance.mjs';

function withHome(fn) {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'whalefall-home-'));
  const previous = process.env.WHALEFALL_HOME;
  process.env.WHALEFALL_HOME = home;
  try {
    return fn(home);
  } finally {
    if (previous === undefined) delete process.env.WHALEFALL_HOME;
    else process.env.WHALEFALL_HOME = previous;
    fs.rmSync(home, { recursive: true, force: true });
  }
}

test('模板存在且是可用的个体骨架', () => {
  for (const file of ['persona/persona.json', 'persona/identity.md', 'persona/policy.json', 'persona/examples.jsonl', 'README.md']) {
    assert.ok(fs.existsSync(path.join(templateDir(), file)), `缺模板文件：${file}`);
  }
});

test('init：复制模板、替换 id 与名字', () => withHome((home) => {
  const created = initInstance('xiaoyu', { name: '小雨' });
  assert.equal(created.id, 'xiaoyu');
  assert.equal(created.dir, path.join(home, 'instances', 'xiaoyu'));
  assert.ok(fs.existsSync(path.join(created.dir, 'persona', 'identity.md')));
  assert.ok(fs.existsSync(path.join(created.dir, 'growth')));

  const manifest = JSON.parse(fs.readFileSync(path.join(created.personaDir, 'persona.json'), 'utf8'));
  assert.equal(manifest.id, 'xiaoyu');
  assert.equal(manifest.name, '小雨');

  const identity = fs.readFileSync(path.join(created.personaDir, 'identity.md'), 'utf8');
  assert.ok(identity.includes('小雨'), '身份文件里的占位应被替换');
  assert.ok(!identity.includes('{{'), '不应该留下未替换的占位');
}));

test('init：重复创建要拒绝，除非 force', () => withHome(() => {
  initInstance('dup');
  assert.throws(() => initInstance('dup'), /已存在/);
  assert.doesNotThrow(() => initInstance('dup', { force: true }));
}));

test('init：非法 id 直接拒绝', () => withHome(() => {
  assert.throws(() => initInstance('Bad Name'), /只能是小写字母/);
  assert.throws(() => initInstance('../escape'), /只能是小写字母/);
}));

test('listInstances：列出 home 里的个体', () => withHome(() => {
  initInstance('one');
  initInstance('two');
  const ids = listInstances();
  assert.ok(ids.includes('one'));
  assert.ok(ids.includes('two'));
}));

test('resolveInstance：home 里没有时退回旧位置', () => withHome((home) => {
  const inst = resolveInstance('dafeiyu');
  assert.equal(inst.dir, path.join(home, 'instances', 'dafeiyu'));
  // 仓库里有旧人格包，应该被识别为 legacy
  if (fs.existsSync(path.resolve('personas', 'dafeiyu', 'persona.json'))) {
    assert.equal(inst.legacy.persona, true);
  }
}));
