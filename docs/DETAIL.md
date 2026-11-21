# dsh-multi-workspace · 详情

给 DSH Agent 加额外的可写目录，并且**让「它为什么能写这里」变成一个能读的答案**，而不是一份要你自己去翻的 JSONL。

## 解决什么问题

你让 Agent 干活，它说「写不进去」，或者——更糟——它写进去了，但你说不清那个目录是什么时候被允许的。

DSH 本身有文件沙箱，但它回答的是「能不能写」这一个布尔值。真正做决定时你需要的是另外三个问题：

1. **这个目录，我现在允许它写到什么程度？**（读 / 写 / 删 / 移，不是一个开关）
2. **刚才那次写入，是被哪条规则放行的？还是被拦的？**
3. **这条授权是不是早就该过期了？**

这个插件把这三件事变成面板上的一句话，比如：

> 该根有写权限但**无**删权限；`.env` 已被敏感名单拦截；过去 7 天写入 3 次，均来自同一会话。

## 它做什么

| 能力 | 说明 |
|---|---|
| 附加可写根 | 给 Agent 增加工作区之外的目录，DSH 文件工具真的认（`workspace_roots` 工具 + profile 授权层同步） |
| 四能力位 | 每个根单独配 `read` / `write` / `delete` / `move`，不是「可写/不可写」两档 |
| 子规则 | 每个根可加 `include` / `exclude` glob 与 `expiresAt` 过期时间 |
| 敏感名单 | 先于根匹配的一道闸：`.env`、`*.pem`、`id_rsa`、`.ssh/**`、`.dsh/**` 默认直接拒绝 |
| 工具级守卫 | 覆盖 `write` / `edit` / 文件工具，拒绝时返回**具体规则名**（`PATH_OUTSIDE_SCOPE`、`GRANT_EXPIRED`、`CAPABILITY_DENIED` …） |
| 审计 | 每次判定写一行 JSONL（默认 `.dsh/multi-workspace-audit.jsonl`，超 5MB 轮转） |
| 会话级临时根 | `session-add` 只对那一场会话生效、不写配置、不继承 subagent，`ttlMinutes` 到点自动撤销 |
| 先试后改 | `evaluate` 只判不执行：拿工具名 + 参数问「会不会被放行」，专治「为什么这次写被拒了」 |
| 浏览器面板 | 长在会话输入框左侧的「根 N」胶囊里，三步引导、撤销最多 5 步 |
| 撤销 / 导出 / 导入 | 规则改动可回退；整份规则文档可往返 |

## 三层结构（分清谁拥有什么）

| 层 | 谁拥有 | 内容 |
|---|---|---|
| 规则层 | **本项目** | profile 里 `multi-workspace` 那一行的 `roots` / `shell` / `sensitive` / `audit` |
| 授权层 | DSH | profile 的 `additionalWritableRoots`（本项目通过 `sync` 整行重述） |
| 执行层 | DSH | 文件沙箱与 ACL runner —— 本项目**一行不改** |

## 三条边界（很重要）

| 边界 | 意思 |
|---|---|
| 文件工具认额外根 | `write` / `edit` / 文件类工具走 DSH 授权层，能真的写到附加根 |
| `pwsh` / `bash` 子进程**不认** | DSH 0.2.2-rc.3 的限制，子进程不受这个授权管；工具返回值里固定带 `subprocessHonored: false` |
| 默认不管读 | `enforceRead: false`。开了会先把「看日志、看 asar、看别人的配置」这些正常操作弄坏 |

## 判定顺序（`src/rules.mjs` 的 `resolve`）

不认识工具 → 放行；`shell` → 按 mode；抽不到路径 → 放行；全局只读且非读 → 拒；读且未开 `enforceRead` → 放行；**敏感名单 → 拒（先于根匹配）**；最长前缀找根 → `PATH_OUTSIDE_SCOPE`；过期 → `GRANT_EXPIRED`；`exclude` → `EXCLUDED_PATH`；`include` → `NOT_INCLUDED`；只读根且非读 → `READ_ONLY_ROOT`；能力位不够 → `CAPABILITY_DENIED`。

注意第三条：**抽不到路径就等于放行**。这是刻意选的（宁可放过也不误伤），也意味着「解析不出参数形态」的工具要单独看。

## 它不做什么

- 不替代 DSH 沙箱，不 patch 内核；
- 不管网络、不管进程、不管 `pwsh` 子进程里的路径；
- 不替你决定该给多大权限 —— 它只负责让这件事**可读、可回滚、可审计**。

## 安装

```bash
npx -y @deepseek-ai/dsh plugin --profile desktop add dsh-multi-workspace
```

需要 Node ≥ 20、DSH ≥ 0.2.2-rc.3（实测环境 Node 25.x，20–24 未逐一验证）。重启后会话输入框左侧出现「根 N」胶囊即安装成功。

本地开发安装（`link:` + junction，改代码即时生效）与回滚步骤见 README §6。
