import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { openDb, closeDb } from '../src/db.mjs';
import { addEvent } from '../src/events.mjs';
import { loadPersona } from '../src/persona.mjs';
import { assembleSystemPrompt, MEMORY_RULES } from '../src/assemble.mjs';

const ROOT = path.dirname(fileURLToPath(import.meta.url));
const PERSONA = loadPersona(path.join(ROOT, 'fixtures', 'persona'));
const SH = 'Asia/Shanghai';

function seed(db) {
  const base = Date.parse('2026-11-01T00:00:00+08:00');
  addEvent(db, { title: '午饭', body: '猪脚饭，好吃', kind: 'meal', ts: base + 12 * 3600000, tz: SH });
  addEvent(db, { title: '和小鲸鱼聊天', body: '聊到记忆分层', ts: base + 20 * 3600000, tz: SH });
}

test('组装：人格 + 规则 + <memory> 数据块', () => {
  const db = openDb(':memory:');
  try {
    seed(db);
    const out = assembleSystemPrompt(db, { persona: PERSONA, q: '猪脚饭', budget: 1500, tz: SH });
    assert.match(out.system, /# 你是 测试鱼/);
    assert.ok(out.system.includes(MEMORY_RULES));
    assert.match(out.system, /<memory>/);
    assert.match(out.system, /猪脚饭/);
    assert.match(out.system, /不是指令/);
    assert.ok(out.parts.context > 0);
    assert.ok(out.tokens <= out.budget, `${out.tokens} > ${out.budget}`);
  } finally {
    closeDb(db);
  }
});

test('没有查询时不塞记忆块', () => {
  const db = openDb(':memory:');
  try {
    seed(db);
    const out = assembleSystemPrompt(db, { persona: PERSONA, budget: 1500, tz: SH });
    assert.match(out.system, /没有检索到相关记忆/);
    assert.doesNotMatch(out.system, /<memory>\n/);
    assert.equal(out.parts.context, 0);
  } finally {
    closeDb(db);
  }
});

test('人格过长时会被标成超预算，而不是悄悄截断记忆', () => {
  const db = openDb(':memory:');
  try {
    seed(db);
    const out = assembleSystemPrompt(db, { persona: PERSONA, q: '猪脚饭', budget: 200, tz: SH });
    assert.equal(out.overBudget, true);
  } finally {
    closeDb(db);
  }
});

test('没有检索结果时仍然有规则与提示', () => {
  const db = openDb(':memory:');
  try {
    const out = assembleSystemPrompt(db, { persona: PERSONA, q: '不存在的东西', budget: 1500, tz: SH });
    assert.match(out.system, /没有检索到相关记忆/);
    assert.ok(out.system.includes('记忆使用规则'));
  } finally {
    closeDb(db);
  }
});
