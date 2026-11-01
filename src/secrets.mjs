/**
 * 本地密钥存储。
 *
 * 设计取舍：
 *   · 文件放在 `data/secrets.json`（被 .gitignore 忽略），权限 0600，原子写；
 *   · 环境变量优先，方便临时注入 / CI，不落盘；
 *   · 只存"这一台机器上跑这个服务"需要的东西，不做加密——
 *     本地磁盘加密靠整机（LUKS/FileVault），应用层再包一层只会给人虚假的安全感；
 *   · 键名用点号扁平结构（qq.appId），避免嵌套 merge 的边界情况。
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

export function defaultSecretsFile() {
  return process.env.WHALEFALL_SECRETS || path.join(ROOT, 'data', 'secrets.json');
}

function assertKey(key) {
  if (!/^[a-z][a-zA-Z0-9]*(\.[a-zA-Z0-9_]+)+$/.test(String(key))) {
    throw new Error(`密钥名不合法：${key}（形如 qq.appSecret）`);
  }
  return String(key);
}

export function readSecrets(file = defaultSecretsFile()) {
  try {
    const parsed = JSON.parse(fs.readFileSync(file, 'utf8'));
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : {};
  } catch (error) {
    if (error.code === 'ENOENT') return {};
    throw new Error(`读取密钥文件失败（${file}）：${error.message}`);
  }
}

export function writeSecrets(data, file = defaultSecretsFile()) {
  const dir = path.dirname(file);
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  const tmp = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, `${JSON.stringify(data, null, 2)}\n`, { encoding: 'utf8', mode: 0o600 });
  fs.renameSync(tmp, file);
  try { fs.chmodSync(file, 0o600); } catch { /* Windows 上可能不支持 */ }
  return file;
}

/** 只显示前 4 位和后 4 位，避免日志/截图泄漏。 */
export function mask(value) {
  const s = String(value ?? '');
  if (!s) return '';
  if (s.length <= 8) return '*'.repeat(s.length);
  return `${s.slice(0, 4)}…${s.slice(-4)}`;
}

export function setSecret(key, value, file) {
  const cleanKey = assertKey(key);
  const cleanValue = String(value ?? '').trim();
  if (!cleanValue) throw new Error('密钥值为空');
  const target = file || defaultSecretsFile();
  const data = readSecrets(target);
  data[cleanKey] = cleanValue;
  writeSecrets(data, target);
  return { key: cleanKey, masked: mask(cleanValue), file: target };
}

export function deleteSecret(key, file) {
  const cleanKey = assertKey(key);
  const data = readSecrets(file);
  if (!(cleanKey in data)) return { key: cleanKey, deleted: false };
  delete data[cleanKey];
  writeSecrets(data, file);
  return { key: cleanKey, deleted: true };
}

/** 给 CLI 看的清单：只有键名和掩码。 */
export function listSecrets(file) {
  const data = readSecrets(file);
  return Object.keys(data).sort().map((key) => ({ key, masked: mask(data[key]) }));
}
