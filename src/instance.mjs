/**
 * 个体（instance）与基建（whalefall）的分界。
 *
 * whalefall 是引擎：事件、摘要、检索、提示词合流、入口适配。
 * 个体是住在 `$WHALEFALL_HOME/instances/<id>/` 里的一套资产：
 *
 *   persona/   identity.md / policy.json / examples.jsonl / persona.json
 *   memory.db  她记得的东西
 *   growth/    人格版本与反思日志（"我发现自己……"）
 *
 * 仓库里只有 `instances/example/` 模板；个体的数据永远不进公开仓库。
 *
 * 迁移期兼容：如果 `$WHALEFALL_HOME/instances/<id>` 还不存在，
 * 会退回仓库里的旧位置（`personas/<id>`、`data/whalefall.db`），
 * 所以拆分可以先落代码、再搬数据。
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

export const DEFAULT_INSTANCE = 'dafeiyu';

export function whalefallHome() {
  return process.env.WHALEFALL_HOME || path.join(os.homedir(), '.whalefall');
}

export function instancesRoot() {
  return path.join(whalefallHome(), 'instances');
}

export function templateDir() {
  return path.join(REPO_ROOT, 'instances', 'example');
}

function exists(...parts) {
  try { return fs.existsSync(path.join(...parts)); } catch { return false; }
}

/**
 * 解析一个个体的路径。不要求所有目录都存在——调用方可以根据 `legacy` 判断。
 * @param {string} [id]
 */
export function resolveInstance(id = process.env.WHALEFALL_INSTANCE || DEFAULT_INSTANCE) {
  const dir = path.join(instancesRoot(), id);
  const homePersona = path.join(dir, 'persona');
  const legacyPersona = path.join(REPO_ROOT, 'personas', id);
  const homeDb = path.join(dir, 'memory.db');
  const legacyDb = path.join(REPO_ROOT, 'data', 'whalefall.db');

  const personaDir = exists(homePersona) ? homePersona : (exists(legacyPersona) ? legacyPersona : homePersona);
  const db = exists(homeDb) ? homeDb : (exists(legacyDb) ? legacyDb : homeDb);

  return {
    id,
    dir,
    personaDir,
    db,
    growth: path.join(dir, 'growth'),
    home: whalefallHome(),
    exists: exists(personaDir),
    legacy: {
      persona: personaDir === legacyPersona,
      db: db === legacyDb,
    },
  };
}

export function listInstances() {
  const root = instancesRoot();
  const found = [];
  if (fs.existsSync(root)) {
    for (const entry of fs.readdirSync(root, { withFileTypes: true })) {
      if (entry.isDirectory() && exists(path.join(root, entry.name, 'persona'))) found.push(entry.name);
    }
  }
  // 迁移期：仓库里的旧人格包也算
  const legacyRoot = path.join(REPO_ROOT, 'personas');
  if (fs.existsSync(legacyRoot)) {
    for (const entry of fs.readdirSync(legacyRoot, { withFileTypes: true })) {
      if (entry.isDirectory() && exists(path.join(legacyRoot, entry.name, 'persona.json')) && !found.includes(entry.name)) {
        found.push(entry.name);
      }
    }
  }
  return found.sort();
}

/**
 * 从模板初始化一个个体。
 * @param {string} id
 * @param {{from?:string, force?:boolean, name?:string}} [opts]
 */
export function initInstance(id, opts = {}) {
  if (!/^[a-z0-9][a-z0-9_-]{0,31}$/.test(String(id))) {
    throw new Error('个体 id 只能是小写字母、数字、下划线或连字符');
  }
  const dir = path.join(instancesRoot(), id);
  if (fs.existsSync(dir) && !opts.force) {
    throw new Error(`个体已存在：${dir}（要覆盖加 --force）`);
  }
  const from = opts.from ?? templateDir();
  if (!fs.existsSync(from)) throw new Error(`模板不存在：${from}`);

  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  fs.cpSync(from, dir, { recursive: true });
  fs.mkdirSync(path.join(dir, 'growth'), { recursive: true, mode: 0o700 });

  // 模板里的 persona.json 用 {{id}} / {{name}} 占位
  const manifestFile = path.join(dir, 'persona', 'persona.json');
  if (fs.existsSync(manifestFile)) {
    const manifest = JSON.parse(fs.readFileSync(manifestFile, 'utf8'));
    manifest.id = id;
    if (opts.name) manifest.name = opts.name;
    else if (typeof manifest.name === 'string') manifest.name = manifest.name.replaceAll('{{name}}', id);
    fs.writeFileSync(manifestFile, `${JSON.stringify(manifest, null, 2)}\n`, { mode: 0o600 });
  }
  // 其余文件里的占位也换掉（identity.md 里的名字）
  for (const file of ['identity.md', 'policy.json', 'examples.jsonl']) {
    const target = path.join(dir, 'persona', file);
    if (!fs.existsSync(target)) continue;
    const text = fs.readFileSync(target, 'utf8');
    if (!text.includes('{{')) continue;
    fs.writeFileSync(target, text.replaceAll('{{name}}', opts.name ?? id).replaceAll('{{id}}', id), { mode: 0o600 });
  }

  return resolveInstance(id);
}
