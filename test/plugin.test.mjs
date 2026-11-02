import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { apply } from '../plugins/whalefall/index.js';
import { initInstance } from '../src/instance.mjs';

function setup() {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'whalefall-plugin-'));
  const previous = process.env.WHALEFALL_HOME;
  process.env.WHALEFALL_HOME = home;
  const instance = initInstance('testins', { name: '测试鱼' });

  const listeners = [];
  const ctx = { on: (event, fn) => listeners.push([event, fn]) };
  apply(ctx, { instance: 'testins', recentLimit: 3, tz: 'Asia/Shanghai' });

  const assemble = listeners.find(([event]) => event === 'system-prompt/assemble')?.[1];
  assert.ok(assemble, '应该注册 system-prompt/assemble');

  return {
    instance,
    assemble,
    cleanup() {
      if (previous === undefined) delete process.env.WHALEFALL_HOME;
      else process.env.WHALEFALL_HOME = previous;
      fs.rmSync(home, { recursive: true, force: true });
    },
  };
}

test('cwd 是个体目录：注入人格', async () => {
  const { instance, assemble, cleanup } = setup();
  try {
    const out = await assemble(
      { sections: [] },
      { agent: { id: 's1', session: { cwd: instance.dir } } },
      async () => ({ sections: [] }),
    );
    const section = out.sections.find((item) => item.name === 'whalefall:persona');
    assert.ok(section, '应该追加 whalefall:persona');
    assert.match(section.text, /测试鱼/);
    assert.match(section.text, /记忆使用规则/);
  } finally {
    cleanup();
  }
});

test('cwd 不是个体目录：原样返回，不干扰工作会话', async () => {
  const { assemble, cleanup } = setup();
  try {
    const out = await assemble(
      { sections: [{ name: 'base', text: 'base' }] },
      { agent: { id: 's2', session: { cwd: '/tmp/elsewhere' } } },
      async () => ({ sections: [{ name: 'base', text: 'base' }] }),
    );
    assert.equal(out.sections.length, 1);
    assert.equal(out.sections[0].name, 'base');
  } finally {
    cleanup();
  }
});

test('没有 agent 上下文时不动', async () => {
  const { assemble, cleanup } = setup();
  try {
    const out = await assemble({ sections: [] }, {}, async () => ({ sections: [] }));
    assert.equal(out.sections.length, 0);
  } finally {
    cleanup();
  }
});

test('人格包坏了就退回默认，不拖垮会话', async () => {
  const { instance, assemble, cleanup } = setup();
  try {
    fs.rmSync(path.join(instance.personaDir, 'persona.json'));
    const out = await assemble(
      { sections: [] },
      { agent: { id: 's3', session: { cwd: instance.dir } } },
      async () => ({ sections: [] }),
    );
    assert.equal(out.sections.length, 0);
  } finally {
    cleanup();
  }
});
