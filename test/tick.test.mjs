import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { openDb, closeDb } from '../src/db.mjs';
import { loadPersona } from '../src/persona.mjs';
import { proactiveHistory } from '../src/proactive.mjs';
import { buildProactivePrompt, proactiveTick } from '../src/tick.mjs';

const ROOT = path.dirname(fileURLToPath(import.meta.url));
const PERSONA = loadPersona(path.join(ROOT, '..', 'personas', 'dafeiyu'));
const SH = 'Asia/Shanghai';
const NOON = Date.parse('2026-11-01T15:00:00+08:00');

test('提示词：带时间、人格名、记忆块，并允许不说话', () => {
  const prompt = buildProactivePrompt({
    persona: PERSONA,
    now: NOON,
    tz: SH,
    memoryText: '对方昨天感冒了',
    history: [{ ts: NOON - 4 * 3600000, text: '早，记得吃早饭' }],
  });
  assert.match(prompt, /2026-11-01 15:00/);
  assert.match(prompt, /阿鲸/);
  assert.match(prompt, /感冒/);
  assert.match(prompt, /输出空/);
  assert.match(prompt, /不要重复/);
});

test('安静时段不发，也不落库', async () => {
  const db = openDb(':memory:');
  try {
    let called = 0;
    const out = await proactiveTick(db, {
      persona: PERSONA,
      now: Date.parse('2026-11-02T00:40:00+08:00'),
      tz: SH,
      compose: async () => { called += 1; return '在吗'; },
    });
    assert.equal(out.sent, false);
    assert.equal(out.verdict.code, 'quiet');
    assert.equal(called, 0);
    assert.equal(proactiveHistory(db).length, 0);
  } finally {
    closeDb(db);
  }
});

test('条件满足时发一条，并写下流水', async () => {
  const db = openDb(':memory:');
  try {
    const out = await proactiveTick(db, {
      persona: PERSONA, now: NOON, tz: SH, memoryText: '对方昨天感冒了',
      compose: async ({ prompt }) => ({ text: '感冒好点没，别喝凉的', model: 'mock-model', sawPrompt: prompt.length > 0 }),
    });
    assert.equal(out.sent, true);
    assert.equal(out.text, '感冒好点没，别喝凉的');

    const rows = proactiveHistory(db);
    assert.equal(rows.length, 1);
    assert.equal(rows[0].meta.model, 'mock-model');
  } finally {
    closeDb(db);
  }
});

test('刚发过就再 tick：被最小间隔挡住', async () => {
  const db = openDb(':memory:');
  try {
    await proactiveTick(db, {
      persona: PERSONA, now: NOON, tz: SH, compose: async () => '第一条',
    });
    const second = await proactiveTick(db, {
      persona: PERSONA, now: NOON + 60 * 60 * 1000, tz: SH, compose: async () => '第二条',
    });
    assert.equal(second.sent, false);
    assert.equal(second.verdict.code, 'min-gap');
  } finally {
    closeDb(db);
  }
});

test('生成空话时不发', async () => {
  const db = openDb(':memory:');
  try {
    const out = await proactiveTick(db, {
      persona: PERSONA, now: NOON, tz: SH, compose: async () => '   ',
    });
    assert.equal(out.sent, false);
    assert.equal(out.verdict.code, 'empty');
    assert.equal(proactiveHistory(db).length, 0);
  } finally {
    closeDb(db);
  }
});

test('没有值得说的事：连模型都不调', async () => {
  const db = openDb(':memory:');
  try {
    let called = 0;
    const out = await proactiveTick(db, {
      persona: PERSONA, now: NOON, tz: SH, hasSubstance: false,
      compose: async () => { called += 1; return 'hi'; },
    });
    assert.equal(out.sent, false);
    assert.equal(called, 0);
  } finally {
    closeDb(db);
  }
});
