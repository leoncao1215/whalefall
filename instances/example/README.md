# 一个个体（instance）

这里放的是**某个存在**的全部私有资产。whalefall 是引擎，这一份是住在引擎里的人。

```
persona/
  identity.md     我是谁（最重要的一个文件）
  policy.json     什么时候开口、什么不能说、说话风格
  examples.jsonl  真实对话样本（比一堆形容词有用）
  persona.json    清单与版本
memory.db         记忆（初始化时自动创建，不进仓库）
growth/           人格版本与反思日志
```

## 怎么用

```bash
# 从模板创建一个新个体
node src/cli.mjs init <id> --name "她的名字"

# 看有哪些个体
node src/cli.mjs instances
```

数据默认在 `~/.whalefall/instances/<id>/`，可以用 `WHALEFALL_HOME` 改位置。

## 关于"长大"

`persona/` 是当前快照，`growth/` 是过程：每次人格调整都在 `growth/` 留一份
diff 和一句"为什么改"，确认后再提升为 `persona/` 的新版本。

这样她的变化是可追溯的——不是某天突然变了个人。
