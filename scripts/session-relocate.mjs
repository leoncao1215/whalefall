#!/usr/bin/env node
/**
 * 把一个 DSH 会话目录"搬到"另一个 workspace 下（实验性）。
 *
 * DSH 按 cwd 给会话分目录，并且校验"物理路径 == 由 header.cwd 和 id 推出的路径"。
 * 所以搬迁 = 复制会话目录 + 改写第一帧 header 里的 cwd + 放到新 cwd 对应的目录下。
 *
 * 这是**实验性**操作：DSH 可能还有会话索引/缓存不认这份拷贝。
 * 所以默认只复制、不删除原目录，出问题可以回退。
 *
 * 用法：
 *   node scripts/session-relocate.mjs <原会话目录> <新 workspace 绝对路径>
 */
import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';
import { pathToFileURL } from 'node:url';

const MAGIC = Buffer.from([0x28, 0xb5, 0x2f, 0xfd]);

/** 复刻 DSH 的 cwd → 目录名转义：'--' + 路径（/ 变 -，非 ASCII 变 ~HEX）+ '--' */
export function escapeCwd(cwd) {
  // 注意：DSH 的目录名是 '--' + 去掉前导斜杠的路径 + '--'，不是把 '/' 直接换掉
  const normalized = String(cwd).replace(/\/+$/, '').replace(/^\/+/, '');
  const body = [...normalized.replace(/\//g, '-')]
    .map((ch) => (/[A-Za-z0-9._-]/.test(ch)
      ? ch
      : `~${ch.codePointAt(0).toString(16).toUpperCase().padStart(4, '0')}`))
    .join('');
  return `--${body}--`;
}

function main() {
  const [srcDir, newCwd] = process.argv.slice(2);
  if (!srcDir || !newCwd) {
    console.error('用法：node scripts/session-relocate.mjs <原会话目录> <新 workspace 绝对路径>');
    process.exit(1);
  }

  const srcFile = path.join(srcDir, 'session.v4.jsonl.zstd');
  if (!fs.existsSync(srcFile)) throw new Error(`找不到会话文件：${srcFile}`);

  const buf = fs.readFileSync(srcFile);
  if (buf.indexOf(MAGIC) !== 0) throw new Error('不是 zstd 多帧会话文件');

  const second = buf.indexOf(MAGIC, MAGIC.length);
  const firstEnd = second === -1 ? buf.length : second;
  const firstText = zlib.zstdDecompressSync(buf.subarray(0, firstEnd)).toString('utf8');
  const header = JSON.parse(firstText.trim().split('\n')[0]);
  if (header?.type !== 'session' || !header.id) throw new Error('第一帧不是 session 头');

  const sessionsRoot = path.dirname(path.dirname(srcDir)); // .../.dsh/sessions
  const targetDir = path.join(sessionsRoot, escapeCwd(newCwd), header.id);
  if (fs.existsSync(targetDir)) throw new Error(`目标已存在，先确认：${targetDir}`);

  const updated = { ...header, cwd: newCwd };
  const newFirst = zlib.zstdCompressSync(Buffer.from(`${JSON.stringify(updated)}\n`, 'utf8'));
  const rest = buf.subarray(firstEnd);

  fs.mkdirSync(targetDir, { recursive: true, mode: 0o700 });
  const targetFile = path.join(targetDir, 'session.v4.jsonl.zstd');
  fs.writeFileSync(targetFile, Buffer.concat([newFirst, rest]), { mode: 0o600 });

  // 复制会话目录里的其它文件（标题、附件索引等），不覆盖刚写的主文件
  for (const entry of fs.readdirSync(srcDir, { withFileTypes: true })) {
    if (entry.name === 'session.v4.jsonl.zstd') continue;
    const from = path.join(srcDir, entry.name);
    const to = path.join(targetDir, entry.name);
    if (entry.isDirectory()) fs.cpSync(from, to, { recursive: true });
    else fs.copyFileSync(from, to);
  }

  console.log(`会话已复制到：${targetDir}`);
  console.log(`新 cwd：${newCwd}`);
  console.log('原会话目录保持不动（出问题可回退）。');
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
  try { main(); } catch (error) {
    console.error(`错误：${error?.message ?? error}`);
    process.exit(1);
  }
}
