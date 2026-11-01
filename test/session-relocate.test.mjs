import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import zlib from 'node:zlib';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { escapeCwd } from '../scripts/session-relocate.mjs';
import { buildSessionBuffer } from './fixtures/session-builder.mjs';

const ROOT = path.dirname(fileURLToPath(import.meta.url));
const SCRIPT = path.join(ROOT, '..', 'scripts', 'session-relocate.mjs');

test('cwd 转义与 DSH 的会话目录命名一致', () => {
  assert.equal(escapeCwd('/root/dsh-plugins'), '--root-dsh-plugins--');
  assert.equal(escapeCwd('/root/repos'), '--root-repos--');
  assert.equal(escapeCwd('/root/大肥鱼的电饭煲'), '--root-~5927~80A5~9C7C~7684~7535~996D~7172--');
  assert.equal(escapeCwd('/root/.dsh-qqbot/workspace'), '--root-.dsh-qqbot-workspace--');
});

test('搬迁：改写 header.cwd、保留帧、原目录不动', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'whalefall-relocate-'));
  const oldSlug = path.join(root, escapeCwd('/tmp/old-ws'));
  const sessionId = 'session-11111111-2222-3333-4444-555555555555';
  const srcDir = path.join(oldSlug, sessionId);
  fs.mkdirSync(srcDir, { recursive: true });

  const records = [
    { type: 'session', version: 4, id: sessionId, createdAt: Date.now(), cwd: '/tmp/old-ws' },
    { type: 'turn/start', seq: 1, time: Date.now(), data: { turn: 1 } },
    { type: 'user/message', seq: 2, time: Date.now(), data: { role: 'user', source: { kind: 'user' }, content: [{ type: 'text', text: '你好' }] } },
    { type: 'turn/end', seq: 3, time: Date.now(), data: { turn: 1 } },
  ];
  fs.writeFileSync(path.join(srcDir, 'session.v4.jsonl.zstd'), buildSessionBuffer(records));

  try {
    execFileSync(process.execPath, [SCRIPT, srcDir, '/tmp/new-ws'], { stdio: 'pipe' });

    const targetFile = path.join(root, escapeCwd('/tmp/new-ws'), sessionId, 'session.v4.jsonl.zstd');
    assert.ok(fs.existsSync(targetFile));

    const buf = fs.readFileSync(targetFile);
    const magic = Buffer.from([0x28, 0xb5, 0x2f, 0xfd]);
    const header = JSON.parse(
      zlib.zstdDecompressSync(buf.subarray(0, buf.indexOf(magic, magic.length))).toString().trim(),
    );
    assert.equal(header.cwd, '/tmp/new-ws');
    assert.equal(header.id, sessionId);

    let frames = 0;
    let at = 0;
    while ((at = buf.indexOf(magic, at)) !== -1) { frames += 1; at += magic.length; }
    assert.equal(frames, records.length);

    assert.ok(fs.existsSync(path.join(srcDir, 'session.v4.jsonl.zstd')), '原会话应保留');
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('搬迁：目标已存在时拒绝覆盖', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'whalefall-relocate-'));
  const sessionId = 'session-99999999-8888-7777-6666-555555555555';
  const srcDir = path.join(root, escapeCwd('/tmp/a'), sessionId);
  fs.mkdirSync(srcDir, { recursive: true });
  fs.writeFileSync(path.join(srcDir, 'session.v4.jsonl.zstd'), buildSessionBuffer([
    { type: 'session', version: 4, id: sessionId, createdAt: Date.now(), cwd: '/tmp/a' },
  ]));
  fs.mkdirSync(path.join(root, escapeCwd('/tmp/b'), sessionId), { recursive: true });

  try {
    assert.throws(
      () => execFileSync(process.execPath, [SCRIPT, srcDir, '/tmp/b'], { stdio: 'pipe' }),
      /目标已存在/,
    );
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});
