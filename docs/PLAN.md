# whalefall（鲸落）· 计划

> 给 agent 一套真正记得住的记忆：**原文永远沉底，摘要按层分解，检索按需下潜。**
>
> 状态：P1–P6 服务端完成 · P7 改为接入官方 QQ 插件 · 最后更新 2026-11-01

---

## 0. 一句话

历史不分层存储，而是**分层索引**：原文是不可变的真相，摘要只是可重算的加速层。
什么时候要细节，就下潜到原文；什么时候只要个大概，就停在浅层。

## 1. 为什么自己写

参照物是 `Mieksido/surfcore`（QQ/B站/记忆/桌宠），它证明了"记忆+人格+主动"这条路能跑通，但：

- 只支持 Windows（SnowLuma、ACL、`.bat` 绑定）；
- 摘要**写时**生成，每层都过一次模型，成本高且层数被锁死；
- 记忆卡是单文件，没有实体维度，查"关于某个人的所有事"要靠全文碰运气；
- 桌宠接口写死 loopback，跨机要改代码。

我们要的：Linux 原生、原文可回溯、摘要可重算、检索可评测、入口可替换。

## 2. 目标 / 非目标

**目标（v1）**

1. 事件归档：任何来源的历史都能落成不可变 event，带时间、时区、来源、实体。
2. 分层摘要：day → week → month 可懒生成、可重算、带 prompt 版本；原文不受影响。
3. 混合检索：时间窗 + 实体 + 全文（中文友好）→ 原文；摘要用于导航。
4. 人格包：身份/语气/策略/示例，版本化。
5. 主动：定时 + 闸门 + 幂等，宁可不说话。
6. 入口解耦：桌宠走 WebSocket，QQ 走官方 API，二者都不影响核心。

**非目标（v1 前）**

- B站相关的任何自动化；
- 多租户 / 云端同步 / 图形界面；
- 自建向量库（先用 SQLite FTS5，向量作为可选插件后接）。

## 3. 架构

```
采集  CLI · DSH 插件 · 桌宠 WS · QQ webhook
        │  统一成 event（ts/tz/source/kind/title/body/actors/refs）
        ▼
存储  SQLite ── events（原文，append-only）
        │        ├─ events_fts（FTS5 trigram，中文 ≥3 字）
        │        ├─ entities / event_entities（实体轴）
        │        └─ summaries（level+bucket+prompt_version，可重算）
        ▼
派生  rollup：day → week → month（懒生成 / 夜间批处理）
        ▼
检索  hybrid：time ∧ entity ∧ text → raw；summary 负责"哪段值得展开"
        ▼
装配  user card（~200 token） + 最近 N 轮 + 按需工具结果
        ▼
表达  agent 回复 · 主动消息（带闸门）
```

技术选型：

| 决策 | 选择 | 原因 |
| --- | --- | --- |
| 运行时 | Node ≥ 22.13，ESM | 与 DSH 一致 |
| 存储 | `node:sqlite`（内置，零依赖） | 免编译、免 native 依赖 |
| 全文 | FTS5 `trigram` + 短词 LIKE 兜底 | CJK 无需分词；<3 字走 LIKE |
| 时间桶 | 按时区计算日历边界 | "每天"是本地日，不是 UTC 日 |
| 摘要 | 外置 summarizer 接口 | 先定协议，后接任何模型 |

## 4. 数据模型

```sql
events(id, uid, ts, tz, source, kind, title, body, actors, refs,
       session_id, hash UNIQUE, created_at)
events_fts(title, body)            -- 外部内容表 + 三个触发器
entities(id, uid, name, kind, aliases)
event_entities(event_id, entity_id, role)
summaries(id, uid, level, bucket_start, bucket_end, tz, text, status,
          prompt_version, model, source_count, created_at, updated_at,
          UNIQUE(level, bucket_start, prompt_version))
```

规则：

- `events` **只增不改**。修订历史用新 event 表达（`refs` 指回旧 event）。
- `hash` 默认对 `(source, kind, title, body, actors, ts)` 取 SHA-256，重复写入返回已有 id。
- 摘要同一 `(level, bucket, prompt_version)` 唯一；换 prompt 就是换一版，旧版保留。
- 删除：删 event 会级联清掉关联；派生摘要需要在同一事务里标脏（P2 实现）。

## 5. 阶段与验收

### P0 · 脚手架 ✅

计划文档、git、目录结构、先提交一版空骨架。

**验收**：`git log` 有提交，`docs/PLAN.md` 可读。

### P1 · 存储与检索核心（本次）

schema + 迁移、event 写入（去重/脱敏）、实体、FTS、时间桶、检索、CLI。

**验收**：

```bash
npm test                      # 全绿
node src/cli.mjs add --title "午饭" --body "猪脚饭，好吃"
node src/cli.mjs search "猪脚饭"   # 能搜到
node src/cli.mjs timeline 2026-11-01
```

### P2 · 摘要与 rollup ✅

`planRollup` 输出待摘要桶，`applyRollup` 接 summarize 回调写回；预算与失败重试。

已完成：`src/summarizer.mjs`（命令适配器 + mock）、`whalefall rollup`、6 个单测。
摘要器契约：stdin JSON（`prompt` + `events`）→ stdout 文本或 `{"text","model"}`。

**验收**：给 7 天假数据 → plan 出 7 个 day 桶 → 假 summarizer 写入 → 再 plan 为空（幂等）。

### P3.6 · 对账与重建

`src/verify.mjs`：verify 比对"会话里的 turn"与"库里的事件"；reindex 清派生数据后从会话重建。

### P3.5 · dream（会话归档 + 自底向上滚动）

`src/harvest.mjs` 采集；`src/hierarchy.mjs` 让周从日、月从周、年从月；`all` 从各来源同层摘要聚合。

### P3.5 · dream（会话归档）

`src/harvest.mjs`：多帧 zstd 解码 → 按 turn 抽对话 → 写事件（带 source）→ rollup。
`covered_until` 保证新对话会触发重摘。

### P3 · 装配与评测（进行中）

`buildContext()`：user card + 最近 N 条 + 工具结果；`memory.search/timeline/get` 三个工具。

已完成：`src/eval.mjs` + 合成语料（30 条）+ 两套题（15 关键词 / 5 换句话），
基线 `eval/report.md`：关键词 100%、换句话 0%；`src/context.mjs` 装配层（预算内拼命中/摘要/最近）。

**结论**：瓶颈不在检索算法，在"把问题翻译成查询"。P3 下一步做 query planning，再谈向量。

已完成：`memory_*` 七个工具（search/timeline/get/summary/remember/forget/stats）+ `forget` 的派生层标脏。

已完成：`src/query.mjs`（时间词 / 实体识别 / 2–3 字滑窗词项 / JS 重排）+ `whalefall ask`；
自然语言模式下关键词题 100%、换句话问 80%（详见 eval/README）。

**剩余**：模型做查询扩展（语义改写），这是最后一块。

**验收**：30 题评测集跑出 recall@5 基线并记录到 `eval/report.md`。

### P4 · 人格 ✅

`persona/` 包：identity.md + policy.json + examples.jsonl；加载器与版本号。

已完成：`src/persona.mjs`（加载/校验/渲染）、`personas/dafeiyu/` 示例、`src/assemble.mjs` 合流、5 个单测。
剩余：按版本切换、示例 A/B。

**验收**：改人格不影响记忆；同一输入换包输出风格可辨。

### P5 · 主动（进行中）

schedule（DSH 已有）+ 检索 + 闸门（安静时段/日上限/正在聊/额度）+ 幂等。

已完成：`src/proactive.mjs` 闸门（跨午夜安静时段、日上限、最小间隔、用户活跃、无料不说）、
`proactive_log` 表（migration v2）、`src/tick.mjs` 心跳（闸门 → 生成 → 落库，空话不发）、CLI tick。
剩余：真正的定时器（交给 DSH schedule 或 cron）。

**验收**：连续 24h 模拟，主动消息条数 ≤ 上限，安静时段 0 条。

### P6 · 入口（进行中）

MCP：`src/mcp.mjs` 零依赖 stdio server，七个工具已可接进 DSH（验收：MCP 测试三连通过）。

桌宠网关：`src/gateway.mjs`（HTTP + SSE，Bearer token，默认回环），客户端可用任意前端实现。

桌宠客户端：

WebSocket + token + 断线重连 + 离线队列；参考客户端不在本仓库。

**验收**：跨机连接，断网 30s 重连不丢事件。

### P7 · QQ（改为接入官方插件）

**不再自研**：QQ 官方提供了 DSH 插件 `@tencent-connect/dsh-qqbot`，负责连接、会话隔离、
图片理解、发文件、审批按钮。本仓库在 v0.1 写过一版适配层（webhook 验签 + token 缓存），
确认官方插件可用后已移除——维护一份用不上的传输层是纯负债。

剩下的工作只有接线：

1. 验证 QQ 会话里能看到 `memory_*`（MCP 是 profile 级注册）；
2. 给 `im-qqbot` 配 `directPrompt` / `groupPrompt`，把人格和"该用记忆"写进去；
3. 注意：官方插件没有"主动发消息"的工具，主动能力暂时只能走桌宠网关。

**验收**：在 QQ 里说"记住……"，`memory_stats` 条数 +1；问"我以前说过什么"，能召回。

## 6. 评测

- `eval/questions.jsonl`：30 条"关于我过去"的问题，字段 `id/question/kinds/expected_contains/notes`。
- 指标：recall@5、平均检索耗时、每答 token 成本。
- 每次改检索/摘要策略都要跑一遍，结果写 `eval/report.md`。

## 7. 风险

| 风险 | 应对 |
| --- | --- |
| 摘要误差逐层放大 | 原文不可变；摘要带 prompt 版本；随时可重算 |
| 成本失控 | 摘要懒生成 + 夜间批处理 + 预算上限 |
| 隐私 | 落盘前脱敏；DB 文件权限 600；删除连带派生层 |
| 提示注入 | 记忆文本进 prompt 时明确标为数据，不当指令 |
| 中文检索 | trigram FTS + 短词 LIKE；评测集里专门放单字/双字查询 |
| 时间语义 | 所有事件带 tz；桶边界按本地日历算 |
| 过度主动 | 默认不说话；闸门前置；每日上限 |

## 8. 目录

```
src/db.mjs         连接、迁移、PRAGMA
src/time.mjs       时区/日历边界/ISO 周
src/redact.mjs     入库前脱敏
src/events.mjs     事件写入、实体关联、去重
src/search.mjs     混合检索、时间线、统计
src/summaries.mjs  摘要读写与版本
src/rollup.mjs     桶规划与摘要应用（P2）
src/cli.mjs        命令行入口
test/              node:test
docs/              计划与决策
eval/              评测集与报告
```
