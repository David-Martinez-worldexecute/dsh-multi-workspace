# 安全说明

这个插件给 Agent 增加"可写目录"，所以它的安全模型必须写清楚：**它是策略栅栏，不是内核边界。**

## 它真正守住什么

| 面 | 是否受本插件控制 | 依据 |
| --- | --- | --- |
| DSH 文件工具（`write` / `edit` / patch / `delete` / `move`） | **是**，按根 + 能力位 + glob + 敏感名单判定 | `ctx.tools.guard` 拿到完整 `ToolExecution`（含 `name` 与 `arguments`） |
| `pwsh` / `bash` / `python` 等子进程 | **否**，默认一律拒绝 | Windows 沙箱子进程不认额外根（DSH 0.2.2-rc.3 既有边界） |
| 读操作 | **默认不管** | DSH 本来就不围栏读；`enforceRead` 可开，但会连"看日志"一起挡掉 |
| 子进程里已启动的持久进程 | **否** | 撤销范围只影响后续解析 |

## 面板 HTTP 路由

`/plugins/dsh-multi-workspace/...` **不经过** DSH 的 session cookie 校验层（那一层只管 `/api` 与 WebSocket）。因此每条路由自己做了两道闸：

1. `isLoopback(remoteAddress)` —— 只接受 127.0.0.1 / ::1 / ::ffff:127.0.0.1；
2. `Origin` 存在时必须与 `Host` 同源。

响应带 `cache-control: no-store`。请求体上限 64 KiB。

## 已知绕过路径（诚实列出）

- **shell**：只要 `shell.mode` 不是 `deny`（默认就是 `deny`），命令字符串里的路径无法被可靠解析。`allowlist` 只认**命令全等**，不做前缀匹配（`git status && del x` 这类拼接因此进不来），但它仍然是"按整条字符串"判的。
- **symlink / junction**：收录时拒绝符号链接；不排除"收录之后被人换成链接"这种情况（DSH 的授权层每次调用会重校验，我们这一层没有实时校验 inode）。
- **盘符以下的一切**：给一个很宽的根（例如 `D:\`）等于把 D 盘全放开。`validate.mjs` 有 deny-list（盘根、`C:\Windows`、`Program Files*`、home 根、`%USERPROFILE%\.dsh` 等），但它拦不住"给一个很深的上级目录"。
- **模型自己改规则**：走 `workspace_roots` 工具时必须过审批；面板的写操作不过工具审批（点面板的是人，人本身就是授权来源）。如果模型被诱导去调工具，审批层是最后一道。

## 报告问题

这是本地工具，没有服务端组件。发现绕过路径时，请附：

1. 规则文档（脱敏后的 `roots` 片段）；
2. 触发它的工具名与参数形状（不需要真实的敏感内容）；
3. `workspace_roots({ action: 'evaluate', ... })` 的判定输出（它只判不执行）。
