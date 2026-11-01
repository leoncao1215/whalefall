import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  deleteSecret, listSecrets, mask, readSecrets, setSecret, writeSecrets,
} from '../src/secrets.mjs';

function tmpFile() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'whalefall-secret-'));
  return path.join(dir, 'secrets.json');
}

test('写入后能读回，文件权限 600', () => {
  const file = tmpFile();
  const out = setSecret('qq.appSecret', 'abcdefgh12345678', file);
  assert.equal(out.masked, 'abcd…5678');
  assert.equal(readSecrets(file)['qq.appSecret'], 'abcdefgh12345678');
  const mode = fs.statSync(file).mode & 0o777;
  assert.equal(mode, 0o600, `mode=${mode.toString(8)}`);
});

test('掩码不会泄漏中间部分', () => {
  assert.equal(mask(''), '');
  assert.equal(mask('short'), '*****');
  assert.equal(mask('1234567890abcdef'), '1234…cdef');
  assert.ok(!mask('1234567890abcdef').includes('567890ab'));
});

test('list 只返回键名与掩码', () => {
  const file = tmpFile();
  setSecret('qq.appId', '102000001', file);
  setSecret('qq.appSecret', 'secret-value-1234', file);
  const rows = listSecrets(file);
  assert.deepEqual(rows.map((r) => r.key), ['qq.appId', 'qq.appSecret']);
  assert.ok(rows.every((r) => !r.masked.includes('102000001')));
  assert.equal(JSON.stringify(rows).includes('secret-value-1234'), false);
});

test('删除与不存在的键', () => {
  const file = tmpFile();
  setSecret('qq.appId', 'x', file);
  assert.equal(deleteSecret('qq.appId', file).deleted, true);
  assert.equal(deleteSecret('qq.appId', file).deleted, false);
  assert.deepEqual(readSecrets(file), {});
});

test('非法键名与空值被拒绝', () => {
  const file = tmpFile();
  assert.throws(() => setSecret('QQ Secret', 'x', file), /不合法/);
  assert.throws(() => setSecret('qq.appSecret', '   ', file), /为空/);
});
