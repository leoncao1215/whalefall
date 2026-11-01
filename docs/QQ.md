# QQ 官方机器人接入

> 状态：适配层完成，**尚未上线**（缺凭据与公网回调）。
> 与之前那个插件的路线不同：这里走官方开放平台，不碰个人号，没有封号风险。

## 已实现（`src/qq.mjs` + 8 个测试）

| 能力 | 说明 |
| --- | --- |
| 事件规范化 | `GROUP_AT_MESSAGE_CREATE` / `C2C_MESSAGE_CREATE` → `{kind, groupOpenid, userOpenid, messageId, text, ts}`；顺带剥掉 `<@!123>` |
| 被动回复报文 | 群 `/v2/groups/{openid}/messages`、私聊 `/v2/users/{openid}/messages`，带 `msg_id` + `msg_seq` |
| 回调签名校验 | `Ed25519(timestamp + rawBody)`，5 分钟时间窗，定长比较，坏签名一律拒绝 |
| 回调地址验证 | `op=13` 时返回 `{plain_token, signature}` |
| access token | 提前 60 秒过期、并发请求合并成一次、失败给出可读原因 |

签名校验是对着真实密钥对测的：正确签名通过、改一个字节失败、过期失败。

## 没做 / 做不了的部分（诚实清单）

1. **Bot Token → Ed25519 密钥对**。
   官方说法是"用 Bot Token 作种子生成密钥对"，但具体派生方式（是否先哈希、如何截断成 32 字节种子）
   我没法在没凭据的情况下验证，所以**没有瞎猜着实现**。`qq.mjs` 只接受 PEM 公钥/私钥，
   派生这一步留给你用官方示例或平台工具做，把公钥填进平台、私钥给我。
2. **回调注册**。需要公网可达的 HTTPS 地址。本机网关默认只听 `127.0.0.1`，
   要么反代（Caddy/nginx），要么内网穿透。QQ 平台要求回调地址可验证，本地开发得先打通这一层。
3. **主动推送**。官方对主动消息有条数限制，且要靠 `msg_seq` 去重；目前只做被动回复。
   主动能力在 whalefall 里已经有了（`tick` + 闸门），接 QQ 时直接复用即可。
4. **权限**。群消息只有被 @ 才推送；私聊需要单独申请。做不到"看群里所有消息"。

## 拿到凭据后怎么接

```js
import { createAccessTokenManager, normalizeEvent, buildReplyPayload, verifyCallbackSignature } from './src/qq.mjs';

const tokens = createAccessTokenManager({ appId, clientSecret });
const event = normalizeEvent(body);
if (event.kind === 'group' || event.kind === 'c2c') {
  const reply = await agent(event.text);           // 走 assemble + responder
  const req = buildReplyPayload(event, reply);
  await fetch(req.url, {
    method: req.method,
    headers: { ...req.headers, Authorization: `QQBot ${await tokens.get()}` },
    body: JSON.stringify(req.body),
  });
}
```

签名校验：

```js
const check = verifyCallbackSignature({
  publicKey,                       // 平台给你的公钥（PEM 或 KeyObject）
  rawBody: rawBodyBuffer,          // 必须是原始字节，不能用解析后的 JSON 重新序列化
  timestamp: req.headers['x-signature-timestamp'],
  signature: req.headers['x-signature-ed25519'],
});
if (!check.ok) return res.writeHead(401).end();
```

**坑点**：`rawBody` 必须是原始字节。很多人用 `JSON.stringify(req.body)` 去验签，一旦字段顺序或空格不同就全挂。
