# whalefall-dsh-plugin

把某个 whalefall 个体接进 DSH：

- 每轮构建 system prompt 时，注入她的人格（`persona/`）和跨渠道最近对话（`<recent>`）；
- 只对 **cwd 等于个体目录** 的会话生效——工作会话不受影响；
- 人格每轮从磁盘读，改完下一句话就生效，不用重启。

## 配置

```yaml
- id: whalefall-persona
  name: whalefall-dsh-plugin
  config:
    instance: dafeiyu      # 个体 id
    recentLimit: 8         # 跨渠道最近几条
    tz: Asia/Shanghai
```

## 为什么按 cwd 判断

DSH 没有"这个会话属于谁"的概念，但有个更结实的约定：
**她的会话都开在自己的个体目录下**。这样既标识身份，又让文件沙箱天然限定在她自己的数据里。
