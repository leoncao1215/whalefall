/**
 * QQ 官方机器人（v2 webhook）适配层。
 *
 * 这里只做**不依赖凭据**就能验证的部分：事件规范化、回复报文、回调签名校验、
 * access token 缓存。真正上线还缺两件事（见 docs/QQ.md）：
 *   · 用 Bot Token 派生 Ed25519 密钥对并把公钥交给平台；
 *   · 把 webhook 注册到平台、拿 appId/clientSecret 换 access token。
 *
 * 签名算法（官方 v2）：signature = Ed25519(timestamp + rawBody)，签名在请求头
 * `X-Signature-Ed25519`，时间戳在 `X-Signature-Timestamp`（秒）。
 */
import crypto from 'node:crypto';

export const API_BASE = 'https://api.sgroup.qq.com';
export const TOKEN_URL = 'https://bots.qq.com/app/getAppAccessToken';

const MAX_CONTENT = 2000;

/** 去掉群聊里的 @ 前缀（<@!123456> 或 <@123456>）。 */
export function stripMention(text) {
  return String(text ?? '')
    .replace(/<@!?\d+>/g, '')
    .replace(/[ \t]+/g, ' ')
    .trim();
}

/**
 * 把平台回调规范化成内部结构。
 * @returns {{op:number, kind:'group'|'c2c'|'other'|'ignored', ...}}
 */
export function normalizeEvent(payload, { now = Date.now() } = {}) {
  const op = Number(payload?.op ?? -1);
  if (op !== 0) return { op, kind: 'ignored' };

  const type = String(payload?.t ?? '');
  const d = payload?.d ?? {};
  const parsed = d.timestamp ? Date.parse(d.timestamp) : NaN;
  const ts = Number.isFinite(parsed) ? parsed : now;

  if (type === 'GROUP_AT_MESSAGE_CREATE') {
    return {
      op,
      type,
      kind: 'group',
      groupOpenid: String(d.group_openid ?? ''),
      userOpenid: String(d.author?.member_openid ?? d.author?.id ?? ''),
      messageId: String(d.id ?? ''),
      text: stripMention(d.content),
      ts,
    };
  }

  if (type === 'C2C_MESSAGE_CREATE') {
    return {
      op,
      type,
      kind: 'c2c',
      userOpenid: String(d.author?.user_openid ?? d.author?.id ?? ''),
      messageId: String(d.id ?? ''),
      text: String(d.content ?? '').trim(),
      ts,
    };
  }

  return { op, type, kind: 'other' };
}

/**
 * 被动回复的请求描述（不直接发，交给调用方注入 fetch，方便测试）。
 */
export function buildReplyPayload(event, text, { msgSeq = 1 } = {}) {
  if (!event || (event.kind !== 'group' && event.kind !== 'c2c')) {
    throw new Error('只能回复群聊或私聊消息');
  }
  if (!event.messageId) throw new Error('缺少 messageId：被动回复必须带 msg_id');
  const content = String(text ?? '').trim().slice(0, MAX_CONTENT);
  if (!content) throw new Error('回复内容为空');

  const path = event.kind === 'group'
    ? `/v2/groups/${encodeURIComponent(event.groupOpenid)}/messages`
    : `/v2/users/${encodeURIComponent(event.userOpenid)}/messages`;

  return {
    method: 'POST',
    url: `${API_BASE}${path}`,
    headers: { 'Content-Type': 'application/json' },
    body: { content, msg_type: 0, msg_id: event.messageId, msg_seq: msgSeq },
  };
}

/**
 * 校验回调签名。publicKey 可以是 PEM 字符串或 KeyObject。
 * @param {{publicKey:any, rawBody:Buffer|string, timestamp:string, signature:string, now?:number, maxSkewMs?:number}} input
 */
export function verifyCallbackSignature(input) {
  const { publicKey, rawBody, timestamp, signature } = input;
  const now = Number(input.now ?? Date.now());
  const maxSkewMs = Number(input.maxSkewMs ?? 5 * 60 * 1000);

  if (!publicKey) return { ok: false, reason: 'missing-public-key' };
  if (!timestamp || !signature) return { ok: false, reason: 'missing-headers' };

  const seconds = Number(timestamp);
  if (!Number.isFinite(seconds)) return { ok: false, reason: 'bad-timestamp' };
  if (Math.abs(now - seconds * 1000) > maxSkewMs) return { ok: false, reason: 'expired' };

  const body = Buffer.isBuffer(rawBody) ? rawBody : Buffer.from(String(rawBody));
  const message = Buffer.concat([Buffer.from(String(timestamp)), body]);
  let hex = String(signature).trim();
  if (!/^[0-9a-f]+$/i.test(hex) || hex.length % 2 !== 0) return { ok: false, reason: 'bad-signature' };

  try {
    const ok = crypto.verify(null, message, publicKey, Buffer.from(hex, 'hex'));
    return ok ? { ok: true } : { ok: false, reason: 'bad-signature' };
  } catch {
    return { ok: false, reason: 'bad-signature' };
  }
}

/**
 * 回调地址验证（op=13）：返回 {plain_token, signature}。
 * 签名的原文同样是 event_ts + plain_token。
 * @param {{plainToken:string, eventTs:string, sign:(message:Buffer)=>Buffer}} input
 */
export function buildValidationReply({ plainToken, eventTs, sign }) {
  if (typeof sign !== 'function') throw new Error('需要 sign 函数（用私钥签名）');
  const message = Buffer.concat([Buffer.from(String(eventTs)), Buffer.from(String(plainToken))]);
  return {
    plain_token: String(plainToken),
    signature: sign(message).toString('hex'),
  };
}

/**
 * access token 缓存：提前 60 秒过期，并发请求合并成一次。
 */
export function createAccessTokenManager({
  appId,
  clientSecret,
  fetchImpl = globalThis.fetch,
  now = () => Date.now(),
  skewMs = 60_000,
} = {}) {
  if (!appId || !clientSecret) throw new Error('需要 appId 与 clientSecret');
  let token = '';
  let expiresAt = 0;
  let inflight = null;

  async function refresh() {
    const res = await fetchImpl(TOKEN_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ appId, clientSecret }),
    });
    if (!res?.ok) throw new Error(`换取 access token 失败：HTTP ${res?.status ?? '?'}`);
    const data = await res.json();
    if (!data?.access_token) throw new Error('平台没有返回 access_token');
    token = String(data.access_token);
    expiresAt = now() + Math.max(0, Number(data.expires_in ?? 7200) * 1000 - skewMs);
    return token;
  }

  return {
    async get() {
      if (token && now() < expiresAt) return token;
      if (!inflight) {
        inflight = refresh().finally(() => { inflight = null; });
      }
      return inflight;
    },
    peek() {
      return token;
    },
  };
}
