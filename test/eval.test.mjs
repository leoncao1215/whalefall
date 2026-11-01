import test from 'node:test';
import assert from 'node:assert/strict';
import { openDb, closeDb } from '../src/db.mjs';
import { seedCorpus, runQuestions, toMarkdown } from '../src/eval.mjs';

const corpus = [
  { key: 'a', ts: '2026-11-01 12:00', kind: 'meal', title: '午饭', body: '猪脚饭' },
  { key: 'b', ts: '2026-11-01 20:00', kind: 'meal', title: '晚饭', body: '火锅' },
];

test('评测骨架：seed → 检索 → recall / MRR', () => {
  const db = openDb(':memory:');
  try {
    const map = seedCorpus(db, corpus);
    assert.equal(map.size, 2);

    const report = runQuestions(db, map, [
      { id: 'q1', question: '吃了什么', query: '猪脚饭', expected: ['a'] },
      { id: 'q2', question: '吃了吗', query: '不存在的词', expected: ['a'] },
      { id: 'q3', question: '火锅', query: '火锅', expected: ['b'] },
    ]);

    assert.equal(report.total, 3);
    assert.equal(report.hits, 2);
    assert.equal(report.recall, 2 / 3);
    assert.equal(report.results[0].rank, 0);
    assert.equal(report.results[1].hit, false);
    assert.ok(report.mrr > 0 && report.mrr <= 1);
    assert.match(toMarkdown(report), /recall@5/);
  } finally {
    closeDb(db);
  }
});

test('seedCorpus 幂等：重复 seed 不产生重复事件', () => {
  const db = openDb(':memory:');
  try {
    const first = seedCorpus(db, corpus);
    const second = seedCorpus(db, corpus);
    assert.deepEqual([...second.values()], [...first.values()]);
    const count = db.prepare('SELECT COUNT(*) AS n FROM events').get().n;
    assert.equal(Number(count), 2);
  } finally {
    closeDb(db);
  }
});

test('查询计划里的时间窗生效', () => {
  const db = openDb(':memory:');
  try {
    const map = seedCorpus(db, corpus);
    const hit = runQuestions(db, map, [
      { id: 't1', question: '午饭', query: '猪脚饭', from: '2026-11-01', to: '2026-11-02', expected: ['a'] },
    ]);
    assert.equal(hit.recall, 1);

    const miss = runQuestions(db, map, [
      { id: 't2', question: '午饭', query: '猪脚饭', from: '2026-11-02', to: '2026-11-03', expected: ['a'] },
    ]);
    assert.equal(miss.recall, 0);
  } finally {
    closeDb(db);
  }
});
