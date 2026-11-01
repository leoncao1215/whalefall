# 主动心跳

原来的主动消息是 `cron → tick → 调 QQ API`：旁路发送，没有会话、没有上下文、发完就忘。
现在改成 **DSH schedule 投递一次真正的会话轮次**：到点后 agent 先查状态，自己决定说不说、
说什么，说出来就是普通的一条消息，回复也会正常进入对话。

```
DSH schedule（0 9-21/2 * * *，Asia/Shanghai；安静时段 23:00-09:00）
        │  投递一条内部提示
        ▼
   agent 醒来 → whalefall heartbeat --json
        │
        ├─ hold      → 输出空 → 什么都不发（默认结局）
        ├─ followup  → 上一条没人回，隔够久，追一句（一条线最多追一次）
        └─ new-topic → 找个话题：没做完的事 / 网上看见的 / 好奇的事
                          │
                          ▼
              whalefall heartbeat record --text "…"
```

## 为什么不让 cron 直接发

| | cron + tick | DSH schedule |
| --- | --- | --- |
| 上下文 | 无 | 整段对话 |
| 能不能查记忆 | 只能预拼一段摘要 | 能，随时 `memory_search` |
| 说不说的判断 | 命令行闸门，一次性 | 可以先看状态、再想、再决定 |
| 用户回复 | 变成另一条孤立的对话 | 同一段对话里接着聊 |

## 状态面板

`whalefall heartbeat --json` 回答四件事：

- `gate` —— 复用 `evaluateProactive`，安静时段/日限/间隔/用户刚说话，一处判断
- `lastProactive` —— 上一条说了什么、多久之前、**回过没**、这条线追过几次
- `lastUserAt` / `silentMinutes` —— 老大多久没说话了
- `suggest` —— `hold` / `followup` / `new-topic`，以及一句人话的理由

`replied` 的判断不靠标记，靠事件：上一条主动消息之后，库里有没有出现新的对话事件。

## 追问不会失控

追问（`--kind followup`）会自动挂到上一条线上（`meta.thread`），
同一根线上 `followUps` 达到 `maxFollowUps` 就不再追——否则每次追问都算新线，会追到天荒地老。

## 参数（`personas/dafeiyu/policy.json`）

```json
"proactive": {
  "quietHours": ["23:00-09:00"],
  "dailyMax": 3,
  "minGapMinutes": 120,
  "followUp": { "followUpMinutes": 180, "maxFollowUps": 1, "minSilentMinutes": 90 }
}
```

| 参数 | 值 | 意思 |
| --- | --- | --- |
| `minGapMinutes` | 120 | 两次主动之间至少隔 2 小时 |
| `dailyMax` | 3 | 一天最多主动 3 次 |
| `followUpMinutes` | 180 | 上一条没人回，隔 3 小时才允许追 |
| `maxFollowUps` | 1 | 同一条线最多追一次 |
| `minSilentMinutes` | 90 | 想开新话题，老大得先安静 90 分钟 |

## 已知的坑

- QQ 插件 `showToolResults` 默认关，但**工具报错一定会发给用户**，所以心跳里的命令必须能跑通；
- 流式只在回复某条消息时启用；主动消息没有 `msgId`，走整段发送，正文里多一句解释就会原样发出去；
- DSH schedule 归属某个会话，这个心跳挂在本会话上，换会话要重新建。

## 改配置会打断正在跑的那一轮

`cordis.patch.yml` 是 QQ 插件的配置，写它会触发插件热重载：旧实例 `disposeAll()`
会把所有会话的 agent `cancel({kind:'user'})` —— 包括正在说话的那一轮。
所以同步人格（`scripts/sync-qq-persona.mjs`）要放在本轮收尾做，
否则会看到「说到一半突然没了」。
