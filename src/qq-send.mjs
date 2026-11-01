/**
 * QQ 主动消息发送（C2C / 群聊）。
 *
 * 凭据从 DSH profile 里读（`im-qqbot` 那段），不另存副本：
 * profile 是插件真正在用的配置，复制一份迟早会漂。
 *
 * 实测：连续 5 条不带 msg_id 的消息都返回 200，旧的"单聊每月 4 条"没有触发。
 * 所以这里不设硬额度，只保留最基本的防呆（内容非空、超长截断、错误码透传）。
 */
import fs from 'node:fs';
import path from 'node:path';

export const TOKEN_URL = 'https://bots.qq.com/app/getAppAccessToken';
export const API_BASE = 'https://api.sgroup.qq.com';
const MAX_CONTENT = 2000;

export function defaultProfilePath() {
  const home = process.env.DSH_HOME || path.join(process.env.HOME || '/root', '.dsh');
  return path.join(home, 'profiles', 'web', 'cordis.patch.yml');
}

/**
 * 从 profile 里解析 im-qqbot 的配置。只做行级扫描，不引 YAML 依赖。
 * @param {string} [file]
 * @returns {{appId:string, appSecret:string, c2cAllow:string[], groupAllow:string[]}}
 */
export function readQqConfig(file = defaultProfilePath()) {
  const text = fs.readFileSync(file, 'utf8');
  const lines = text.split('\n');
  const start = lines.findIndex((line) => /^-\s+id:\s*im-qqbot\s*$/.test(line));
  if (start < 0) throw new Error(`profile 里没有 im-qqbot：${file}`);

  let appId = '';
  let appSecret = '';
  const c2cAllow = [];
  const groupAllow = [];
  let section = '';

  for (let i = start + 1; i < lines.length; i += 1) {
    const line = lines[i];
    if (/^-\s+id:/.test(line)) break; // 下一个顶层插件
    const trimmed = line.trim();
    if (/^c2cAllow:/.test(trimmed)) { section = 'c2c'; continue; }
    if (/^groups?:/.test(trimmed) || /^groupAllow:/.test(trimmed)) { section = 'group'; continue; }
    if (/^[a-zA-Z]+:/.test(trimmed)) { section = ''; }
    if (/^\s*-\s*[A-Za-z0-9]+$/.test(line) && section) {
      (section === 'c2c' ? c2cAllow : groupAllow).push(trimmed.slice(1).trim());
      continue;
    }
    const idMatch = trimmed.match(/^appId:\s*"?([0-9]+)"?/);
    if (idMatch) { appId = idMatch[1]; continue; }
    const secretMatch = trimmed.match(/^appSecret:\s*"?([^"\s]+)"?/);
    if (secretMatch) { appSecret = secretMatch[1]; }
  }

  if (!appId || !appSecret) throw new Error('没解析出 appId / appSecret，profile 结构可能变了');
  return { appId, appSecret, c2cAllow, groupAllow };
}

/** access token 缓存：提前 60 秒过期，并发合并成一次请求。 */
export function createTokenManager({ appId, appSecret, fetchImpl = globalThis.fetch, now = () => Date.now() }) {
  if (!appId || !appSecret) throw new Error('缺少 appId / appSecret');
  let token = '';
  let expiresAt = 0;
  let inflight = null;

  async function refresh() {
    const res = await fetchImpl(TOKEN_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ appId, clientSecret: appSecret }),
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok || !data.access_token) {
      throw new Error(`换取 access token 失败：HTTP ${res.status} ${JSON.stringify(data).slice(0, 200)}`);
    }
    token = data.access_token;
    expiresAt = now() + Math.max(0, Number(data.expires_in ?? 7200) * 1000 - 60_000);
    return token;
  }

  return {
    async get() {
      if (token && now() < expiresAt) return token;
      if (!inflight) inflight = refresh().finally(() => { inflight = null; });
      return inflight;
    },
  };
}

/**
 * 发一条消息。带 msgId 是被动回复，不带是主动消息。
 * @returns {Promise<{ok:boolean, id?:string, status:number, code?:number|null, message?:string}>}
 */
export async function sendMessage(opts) {
  const {
    openid, groupOpenid, content, msgId, msgSeq,
    accessToken, fetchImpl = globalThis.fetch,
  } = opts ?? {};

  const text = String(content ?? '').trim();
  if (!text) throw new Error('消息内容为空');
  if (!openid && !groupOpenid) throw new Error('需要 openid 或 groupOpenid');
  if (!accessToken) throw new Error('缺少 accessToken');

  const url = groupOpenid
    ? `${API_BASE}/v2/groups/${encodeURIComponent(groupOpenid)}/messages`
    : `${API_BASE}/v2/users/${encodeURIComponent(openid)}/messages`;

  const body = { content: text.slice(0, MAX_CONTENT), msg_type: 0 };
  if (msgId) {
    body.msg_id = msgId;
    body.msg_seq = Number(msgSeq) || 1;
  }

  const res = await fetchImpl(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `QQBot ${accessToken}` },
    body: JSON.stringify(body),
  });
  const raw = await res.text();
  let data = {};
  try { data = JSON.parse(raw); } catch { /* 非 JSON 响应 */ }

  if (!res.ok) {
    return {
      ok: false,
      status: res.status,
      code: data.code ?? null,
      message: String(data.message ?? raw).slice(0, 300),
    };
  }
  return { ok: true, status: res.status, id: data.id ?? null, timestamp: data.timestamp ?? null };
}

/** 组合：读配置 → 拿 token → 发给某人（默认 c2cAllow 里的第一个人）。 */
export async function sendProactive(content, opts = {}) {
  const config = opts.config ?? readQqConfig(opts.profile);
  const token = opts.token ?? await createTokenManager({
    appId: config.appId,
    appSecret: config.appSecret,
    fetchImpl: opts.fetchImpl,
  }).get();
  const groupOpenid = opts.groupOpenid ?? (opts.toGroup ? config.groupAllow[0] : null);
  if (groupOpenid) {
    return sendMessage({ groupOpenid, content, accessToken: token, fetchImpl: opts.fetchImpl });
  }
  const openid = opts.openid ?? config.c2cAllow[0];
  if (!openid) throw new Error('没有可发送的 openid（profile 的 c2cAllow 是空的）');
  return sendMessage({ openid, content, accessToken: token, fetchImpl: opts.fetchImpl });
}
