#!/usr/bin/env node
/**
 * 把旧位置（仓库内）的人格包和数据库搬到个体目录：
 *
 *   personas/<id>/        →  $WHALEFALL_HOME/instances/<id>/persona/
 *   data/whalefall.db     →  $WHALEFALL_HOME/instances/<id>/memory.db
 *   data/secrets.json     →  $WHALEFALL_HOME/secrets.json
 *
 * 默认只预览。--apply 才写。原文件保留，确认没问题后自己删。
 *
 * 数据库用 `VACUUM INTO` 复制，WAL 也会被正确合并，不会复制出一个半截的库。
 *
 *   node scripts/migrate-to-instance.mjs --id dafeiyu
 *   node scripts/migrate-to-instance.mjs --id dafeiyu --apply
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { openDb, closeDb } from '../src/db.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const args = process.argv.slice(2);
const apply = args.includes('--apply');
const id = (() => {
  const at = args.indexOf('--id');
  return at >= 0 ? args[at + 1] : 'dafeiyu';
})();

const home = process.env.WHALEFALL_HOME || path.join(os.homedir(), '.whalefall');
const instanceDir = path.join(home, 'instances', id);
const personaSrc = path.join(ROOT, 'personas', id);
const dbSrc = path.join(ROOT, 'data', 'whalefall.db');
const secretsSrc = path.join(ROOT, 'data', 'secrets.json');

console.log(`个体：${id}`);
console.log(`目标：${instanceDir}`);
console.log(apply ? '模式：执行' : '模式：预览（加 --apply 才写）');

const steps = [];
if (fs.existsSync(personaSrc)) steps.push(['persona', personaSrc, path.join(instanceDir, 'persona')]);
else console.log(`⚠ 没有人格包：${personaSrc}（跳过）`);
if (fs.existsSync(dbSrc)) steps.push(['memory.db', dbSrc, path.join(instanceDir, 'memory.db')]);
else console.log(`⚠ 没有数据库：${dbSrc}（跳过）`);
if (fs.existsSync(secretsSrc)) steps.push(['secrets', secretsSrc, path.join(home, 'secrets.json')]);

for (const [what, from, to] of steps) console.log(`  ${what}: ${from} → ${to}`);
if (!steps.length) process.exit(0);
if (!apply) {
  console.log('\n预览结束。执行请加 --apply。');
  process.exit(0);
}

fs.mkdirSync(path.join(instanceDir, 'growth'), { recursive: true, mode: 0o700 });
fs.mkdirSync(home, { recursive: true, mode: 0o700 });

for (const [what, from, to] of steps) {
  if (fs.existsSync(to)) {
    console.log(`⚠ 目标已存在，跳过：${to}`);
    continue;
  }
  if (what === 'memory.db') {
    const db = openDb(from);
    try {
      db.exec(`VACUUM INTO '${to.replaceAll("'", "''")}'`);
    } finally {
      closeDb(db);
    }
  } else if (what === 'persona') {
    fs.cpSync(from, to, { recursive: true });
  } else {
    fs.copyFileSync(from, to);
    fs.chmodSync(to, 0o600);
  }
  console.log(`✓ ${what}`);
}

const moved = fs
  .readdirSync(path.join(instanceDir), { withFileTypes: true })
  .map((entry) => entry.name);
console.log(`\n完成。${instanceDir} 里现在有：${moved.join('、')}`);
console.log('确认没问题后，可以删掉仓库里的旧位置（personas/、data/*.db、data/secrets.json）。');
console.log('如果 DSH profile 里显式设了 WHALEFALL_DB，记得改成新的 memory.db 或删掉让它走默认。');
