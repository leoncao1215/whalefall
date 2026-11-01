import zlib from 'node:zlib';

/**
 * 把若干条记录压成"多帧 zstd 拼接"的会话文件内容，用来喂 harvest 的测试。
 * 真实文件就是这么存的：一行一个 zstd 帧。
 */
export function buildSessionBuffer(records) {
  return Buffer.concat(
    records.map((record) => zlib.zstdCompressSync(Buffer.from(`${JSON.stringify(record)}\n`, 'utf8'))),
  );
}
