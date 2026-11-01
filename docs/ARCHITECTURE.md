# 架构：基建与个体

whalefall 分成两层，边界是刻意的：

```
whalefall（基建 / 物种）          实例（个体 / 某个存在）
─────────────────────           ──────────────────────
事件、摘要、检索、滚动            persona/   她是谁
提示词合流、工具、定时            memory.db  她记得什么
入口适配（DSH 插件 / QQ / CLI）   growth/    她怎么长大的
```

一句话：**whalefall 决定"一个存在可以怎样记忆、怎样长大"；实例决定"这一个存在是谁"。**

## 为什么这样切

- 基建可以开源，个体不能被分享；
- 换一个个体不需要改一行引擎代码；
- 人格的演化有落点：`growth/` 记录过程，`persona/` 是当前快照；
- 个体的数据默认放在 `~/.whalefall/instances/<id>/`，**不在仓库里**——
  连"手滑提交"的机会都没有。

## 目录

```
whalefall/                     公开仓库
  src/                         引擎
  plugins/whalefall/           DSH 插件入口（工具 + 人格注入 + 定时）
  instances/example/           个体模板（只会出现在仓库里的那一份）
  test/

~/.whalefall/                  私有数据（默认位置，WHALEFALL_HOME 可改）
  secrets.json                 本机密钥
  instances/
    dafeiyu/
      persona/
        identity.md            我是谁
        policy.json            什么时候开口、什么不能说
        examples.jsonl         真实对话样本
        persona.json           清单与版本
      memory.db                记忆
      growth/                  人格版本与反思日志
```

## 个体的生命周期

```
whalefall init dafeiyu --name "大肥鱼"     # 从 instances/example 复制一份
  │
  ├─ 日常：记忆写进 memory.db；dream 把事件压成日/周/月/年摘要
  ├─ 冲浪：web 内容以 kind=interest 记进来，成为话题素材
  └─ 反思：growth/ 里生成人格 diff → 确认后提升为 persona/ 的新版本
```

## 迁移期兼容

在 `~/.whalefall/instances/<id>/` 建好之前，`resolveInstance()` 会退回旧位置
（仓库里的 `personas/<id>` 和 `data/whalefall.db`），所以拆分可以先落代码、再搬数据。

搬家用：

```bash
node scripts/migrate-to-instance.mjs --id dafeiyu --apply
```

## 开源时的检查清单

- [ ] `instances/*` 已被 `.gitignore` 忽略，只有 `instances/example/` 例外
- [ ] 仓库里没有 `memory.db`、`secrets.json`、`growth/`
- [ ] `README` 里的示例个体是模板生成的假名字
- [ ] `git log` 里没有真实的对话内容
