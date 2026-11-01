# whalefall（鲸落）

**原文沉底，摘要分层，检索下潜。**

一条鲸鱼死后沉到海底，会被不同深度的生物一层层分解——这套记忆系统是同一个结构：
所有历史原封不动地沉在底层，上面每一层只保留"够用"的浓度，需要细节时再潜下去。

## 现在有什么（v0.1）

- **事件归档**：不可变 event，带时间、时区、来源、类型、参与者、引用；入库前脱敏；重复写入自动去重。
- **实体轴**：事件可以挂在人/物/主题上，检索时按实体过滤（"关于小鲸鱼的所有事"）。
- **中文检索**：SQLite FTS5 `trigram`，≥3 字直接命中；1~2 字退化成 LIKE。
- **时间桶**：按**用户时区**的日历切 day/week/month/year，不是 UTC。
- **分层摘要**：`summaries` 按 `(level, bucket, prompt_version)` 唯一，可懒生成、可重算、旧版本保留。
- **摘要链路**：`plan → summarizer → 写库`，摘要器可以是**任何命令**（读 stdin JSON、写 stdout 文本/JSON），先用 mock 也能跑通。
- **上下文装配**：`buildContext()` 按预算拼「命中 → 摘要 → 最近」，每块带 id，超预算宁可少给。
- **人格包**：`identity.md` + `policy.json` + `examples.jsonl`，可渲染成系统提示词；示例是大肥鱼本人。
- **系统提示装配**：人格 + 记忆规则 + `<memory>` 数据块，按预算裁剪；记忆明确标成数据而不是指令。
- **主动闸门 + 心跳**：闸门（安静时段/日上限/最小间隔/用户在聊）+ `proactiveTick()`（闸门 → 生成 → 落库），默认不说话。
- **MCP server**：零依赖 stdio 服务，`memory_*` 七个工具直接接进 DSH。
- **工具门面**：7 个 `memory_*` 工具（search / timeline / get / summary / remember / forget / stats），带 JSON Schema。
- **真删除**：`memory_forget` 删原文，并把覆盖该时刻的摘要标脏（stale），下次 rollup 会重算。
- **CLI**：`add / search / timeline / context / plan / rollup / summaries / stats / eval / export`。

还没有的：上下文装配、人格包、主动机制、桌宠/QQ 入口（见 [docs/PLAN.md](docs/PLAN.md) 的 P3 之后）。

## 快速开始

```bash
node -v                     # 需要 >= 22.13（node:sqlite 内置）

npm test                    # 全部单测

node src/cli.mjs add --title "午饭" --body "猪脚饭，好吃" --tz Asia/Shanghai
node src/cli.mjs add --title "和小鲸鱼聊天" --body "聊到了记忆架构" --actor 小鲸鱼
node src/cli.mjs search 猪脚饭
node src/cli.mjs search 小鲸鱼 --entity 小鲸鱼
node src/cli.mjs timeline 2026-11-01
node src/cli.mjs stats
node src/cli.mjs plan --level day --days 7
node src/cli.mjs context 猪脚饭 --budget 300
node src/cli.mjs persona --dir personas/dafeiyu
node src/cli.mjs prompt 猪脚饭 --budget 900
node src/cli.mjs proactive check --now 2026-11-01T23:40
node src/cli.mjs tools
node src/cli.mjs tool memory_search --q 猪脚饭
node src/cli.mjs tick --now 2026-11-01T15:00 --text "感冒好点没"
```

## 接到 DSH（MCP）

`src/mcp.mjs` 是一个零依赖的 stdio MCP server，暴露七个 `memory_*` 工具。
在 DSH profile 的 `cordis.patch.yml` 里加一段（路径换成你的）：

```yaml
- insert:
    - id: whalefall
      name: '@deepseek-ai/dsh-mcp-client'
      config:
        serverName: whalefall
        transport: stdio
        command: node
        args: ['/绝对路径/whalefall/src/mcp.mjs']
```

库路径默认锚在仓库的 `data/whalefall.db`，可用环境变量 `WHALEFALL_DB` 覆盖。

## 接模型（或任何命令）

`rollup` 不绑定厂商：摘要器是一个命令，读 stdin 的 JSON（含 `prompt` 和 `events`），
往 stdout 写纯文本或 `{"text": "...", "model": "..."}`。

```bash
# 1. 先看会喂给模型什么，不花钱
node src/cli.mjs rollup --dry-run --level day --days 1

# 2. 用 mock 验证写库链路
node src/cli.mjs rollup --mock --level day --days 7

# 3. 换成任何模型命令（按你自己的工具替换）
node src/cli.mjs rollup --summarizer "ollama run qwen2.5" --level day --days 7
node src/cli.mjs rollup --summarizer "llm -m deepseek-chat" --level week --days 30
```

单个桶失败不会影响其它桶（CLI 会返回非零退出码并打印失败的桶）。

数据库默认在 `data/whalefall.db`，可用 `--db` 或 `WHALEFALL_DB` 覆盖。

## 目录

```
src/db.mjs         连接、PRAGMA、迁移
src/time.mjs       时区 / 日历边界 / ISO 周
src/redact.mjs     入库前脱敏
src/events.mjs     事件写入、去重、实体关联
src/search.mjs     混合检索、时间线、统计
src/summaries.mjs  摘要读写与版本
src/rollup.mjs     桶规划与摘要应用
src/summarizer.mjs 摘要器适配层（任意命令 / mock）
src/context.mjs    上下文装配与 token 预算
src/persona.mjs    人格包加载与渲染
src/assemble.mjs   人格 + 记忆规则 + 数据块 → system prompt
src/proactive.mjs  主动闸门与流水
src/tools.mjs      模型可调的工具门面（memory_*）
src/forget.mjs     删除与派生摘要标脏
src/tick.mjs       主动心跳：闸门 → 生成 → 落库
src/mcp.mjs        MCP stdio server
src/eval.mjs       检索评测
src/cli.mjs        命令行
personas/          人格包（dafeiyu 是示例）
test/              node:test
```

## 设计取舍

- **原文不删不改**：摘要可以重算，原文不能重建。
- **摘要是索引不是真相**：任何一层摘要出问题，都能回到 event 重来。
- **时间桶按本地日历**：用户说"每天"指的是他所在时区的每天。
- **零运行时依赖**：只用 `node:sqlite`，不引入 native 编译和向量库；接口留好，将来可替换。
