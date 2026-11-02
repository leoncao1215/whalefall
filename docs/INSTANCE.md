# 个体目录的约定

每个个体住在 `$WHALEFALL_HOME/instances/<id>/`，它的会话 cwd 也指向这里。
目录被分成三个写区，规则对所有个体通用。

## 三个区

| 路径 | 谁能写 | 规则 |
| --- | --- | --- |
| `growth/` | 她自己 | 自由写：反思、想法、想改人格的理由。append-only 最好 |
| `persona/` | 受控 | 改之前自动快照到 `growth/versions/<时间戳>/`；改了要留一句为什么 |
| `memory.db` | 引擎 | 只通过记忆工具写，别直接改文件；每天一份备份到 `backups/` |

## 为什么要分

- `growth/` 是过程，允许乱、允许试错；
- `persona/` 是快照，代表"现在的她"，改动要可追溯；
- `memory.db` 是事实，坏了很难重建（虽然有会话日志兜底）。

## 会话 cwd = 个体目录

这不是随便定的：

1. 它是"这个会话属于谁"的标识（插件按它决定注不注入人格）；
2. 它让 DSH 的文件沙箱正好圈在个体数据里——她能写自己的东西，但碰不到
   `~/.whalefall/secrets.json` 这种邻居。

## 备份

```bash
node src/cli.mjs backup --instance dafeiyu   # 计划中：VACUUM INTO backups/<日期>.db
```

在实现之前，最少也要保证 `memory.db` 不进 git、不被她直接删。
