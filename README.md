# dsh-multi-workspace

> **Windows 上先看清这三条**：① 文件工具（`write`/`edit`/`ops_*`/Office 工具）认额外根；② `pwsh`/`bash` 子进程**不认**额外根，只认工作区 + 私有 temp；③ 读本来就全放开，本项目只管**写**。
> 这不是"没做完"，是 DSH 0.2.2-rc.3 的既有边界（`dsh-pwsh-sandbox` 只把 workspace root 与私有 temp 交给子进程）。

一句话：**给 DSH Agent 自由加多个文件活动范围，并且每个根能单独规定读/写/删/移**。不重写沙箱，只在现有能力上做"规则 + 入口 + 审计"。

## 0. 第一次使用（30 秒）

装好之后，点会话输入框左边的「根 N」胶囊；面板第一屏就是三步引导，关掉以后点右上角 **?** 能再看一遍。

1. **加一个根** —— 粘贴一个绝对路径（例如 `D:\work\proj-a`），选能力位（读/写/删/移），按「添加」。
2. **确认它生效** —— 顶部「持久根」列表里出现这一行；想反悔就按「撤销」（最多回 5 步）。
3. **让 Agent 用它** —— 在会话里直接说「在 `D:\work\proj-a` 下新建 `x.py`」；被拒时会告诉你哪条规则拦的、为什么。

两件最容易踩的事：`pwsh` / `bash` 子进程**不认**额外根（只有文件工具认）；`panel/preview.html` 是离线演示页，能点但**不写配置**，真面板在 DSH 里。

---

## 1. 它解决的到底是什么问题

DSH 默认只有**一个**工作区。换个项目写个文件就会被围栏拦下来，提示 `[sandbox: file access denied under workspace-write mode]`。

内核其实早就有"多根"的底层能力，缺的是**给人用的入口**和**按路径的细分权限**：

| 需求 | 内核现状 | 本项目 |
| --- | --- | --- |
| 加多个可写目录 | 有 `additionalWritableRoots`（部署级）+ `registerWritableRoot(session, dir)`（单会话） | 一句话添加、增删、列出、持久化 |
| 不再只有三档（read-only / workspace-write / danger-full-access） | 只有三档 | 每个根自带 `read/write/delete/move` 四能力位 + `ro` 只读标记 |
| 按文件/子目录细分 | 围栏是**按根**的，一道围栏管五种写操作 | 根内 `include`/`exclude` 的 glob 子规则 |
| 保护 `.env` / `*.pem` / `id_rsa` | 无 | 敏感名单**优先于**根匹配，命中即拒 |
| 事后能查"谁被拒了、为什么" | 审批不带参数、无记录 | JSONL 审计，超 5MB 轮转 |

## 2. 三层架构（重要：它不碰执行层）

```
① 规则层   本项目拥有   profile 的 multi-workspace 行（roots / shell / sensitive / audit）
② 授权层   DSH 拥有     profile 的 additionalWritableRoots（告诉沙箱"这些目录可写"）
③ 执行层   DSH 拥有     文件沙箱与 ACL runner（本项目一行都不改）
```

**为什么要分三层**：权限判定是我们的事，落盘拦截是内核的事。混在一起就会出现"规则说能写、沙箱还是拒"的假象 —— 因为真正让步的是第 ② 层。

`sync` 只做"把规则层算出来的根写进授权层"，并且**必须**整行重述（DSH 的 patch 是整行替换，只写一个键会把 `mode`/`workspaceRoot` 弄丢）。

## 3. 规则长什么样

```yaml
roots:
  - path: D:\work\proj-a
    capabilities: [read, write, delete, move]
    mode: rw
  - path: D:\work\proj-a\secret
    capabilities: [read]          # 子目录只读：最长前缀优先，不会被上面那个根放行
  - path: E:\scratch
    capabilities: [read, write]
    mode: rw
    expiresAt: 1767225600000      # 临时授权，过期即拒
shell:
  mode: deny                      # deny（默认）/ allowlist
  allowlist: []                   # 只认"命令全等"，不认前缀
sensitive:
  deny: ['.env', '*.pem', 'id_rsa', '.ssh/**', '.dsh/**']
audit:
  enabled: true
  file: .dsh/multi-workspace-audit.jsonl
```

判定顺序（写死在 `src/rules.mjs` 的 `resolve`）：

1. 不认识的工具 → 放行（不碰别人的工具）
2. shell 类 → 按 `shell.mode`
3. 抽不到路径 → 放行
4. 全局 `read-only` 且非读 → 拒
5. 读且没开 `enforceRead` → 放行（DSH 本来不围栏读）
6. **敏感名单** → 拒（先于根匹配）
7. 最长前缀找根 → 找不到：`PATH_OUTSIDE_SCOPE`
8. 过期 → `GRANT_EXPIRED`
9. `exclude` → `EXCLUDED_PATH`
10. `include`（非读）→ `NOT_INCLUDED`
11. `ro` 且非读 → `READ_ONLY_ROOT`
12. 没有该能力位 → `CAPABILITY_DENIED`

## 4. 两种用法

### A. 本地控制台（零依赖，不装进 DSH 就能用）

```bash
node bin/mw.mjs list
node bin/mw.mjs add "D:\work\proj-a" --caps read,write --mode rw
node bin/mw.mjs add "E:\scratch" --caps read --expires 1767225600000
node bin/mw.mjs remove "E:\scratch"
node bin/mw.mjs validate "D:\work\proj-a"      # 只校验不写
node bin/mw.mjs probe "D:\work\proj-a"         # 真写一个临时文件再删
node bin/mw.mjs diff                            # 规则层 vs 授权层差多少
node bin/mw.mjs status
```

规则优先写进 profile 的配置行；写不进去时落到工作区内的兜底文件 `.dsh/multi-workspace-rules.json`（面板会明说这次落在哪）。`diff` 会读 profile 的 `cordis.patch.yml`，扫不到 `additionalWritableRoots` 时如实说"没有这一段"，而不是假装"已经一致"。

### B. 装进 DSH（模型自己用 `workspace_roots` 工具）

见第 6 节。**这一步会改 profile，需要你拍板。**

## 5. 模型看到的工具

工具名 `workspace_roots`，一个入口多个动作：

```json
{ "action": "list" }
{ "action": "add", "path": "D:\\work\\proj-a", "capabilities": ["read","write"], "mode": "rw" }
{ "action": "add", "path": "E:\\scratch", "expiresAt": 1767225600000 }
{ "action": "remove", "path": "E:\\scratch" }
{ "action": "update", "path": "D:\\work\\proj-a", "capabilities": ["read"] }
{ "action": "validate", "path": "D:\\work\\proj-a" }
{ "action": "probe", "path": "D:\\work\\proj-a" }
{ "action": "status" }
{ "action": "sync", "dryRun": true }
{ "action": "audit", "limit": 20 }
{ "action": "evaluate", "toolName": "write", "argsJson": "{\"file_path\":\"D:\\\\work\\\\proj-a\\\\x.txt\"}" }
{ "action": "doctor" }
{ "action": "undo" }
{ "action": "export" }
{ "action": "import", "json": "{\"version\":2,\"roots\":[...]}" }
{ "action": "session-add", "path": "E:\\scratch", "sessionId": "<会话 id>", "ttlMinutes": 60 }
{ "action": "session-list", "sessionId": "<会话 id>" }
{ "action": "session-remove", "path": "E:\\scratch", "sessionId": "<会话 id>" }
```

- `add/remove/update/sync/probe` 属于**变更类**，默认必须过审批；没有审批通道时返回 `APPROVAL_UNAVAILABLE` 并**拒绝**（fail closed，绝不默认放行）。
- 返回值固定带 `subprocessHonored: false` 与人话说明，免得模型以为 `pwsh` 也认这些目录。
- 默认**不管读**（`enforceRead: false`）。管了会先把"看日志、看 asar、看别人的配置"这些正常操作弄坏。
- `evaluate` **只判不执行**：拿工具名 + 参数问"会不会被放行"，用来排查"为什么这次写被拒了"。
- `session-*` 是**会话级临时根**：走 `ctx.sandboxPolicy.registerWritableRoot(session, dir)`，只对那一场会话生效、不写配置、不继承 subagent，`ttlMinutes` 到点自动撤销。
- `undo` 最多回退 5 步；`export`/`import` 是整份规则文档往返（导入要过审批）。

## 6. 装进 DSH（真机验证过的步骤）

> 这一节在 v0.5.1 重写过。旧版教人手工往 `cordis.patch.yml` 加 `- id: multi-workspace`，那是错的：
> 行 id 必须等于包名 `dsh-multi-workspace`，否则 `configEditor.edit` 会报
> `Configuration entry is no longer available`。

### 6.1 链进 profile（link:，不复制目录）

```bash
cd C:\Users\lin\.dsh\profiles\desktop

# 1) package.json 的 dependencies 加一行
#    "dsh-multi-workspace": "link:C:/Users/lin/Desktop/AIAgent活动文件限制/dsh-multi-workspace"

# 2) 同一个 package.json 的 dsh.profile.bundles 数组里加一个 "dsh-multi-workspace"

# 3) 建 junction（Windows 用 mklink /J；不要复制目录，也不要 Remove-Item -Recurse 删它）
cmd /c mklink /J node_modules\dsh-multi-workspace "C:\Users\lin\Desktop\AIAgent活动文件限制\dsh-multi-workspace"
```

### 6.2 让 DSH 真的加载它（缺这一步就是"装了但没界面"）

只改 `package.json` 不够 —— bundle 还要被"选中/启用"：

```
plugin_manager action=set_bundle target=dsh-multi-workspace enabled=true
```

- 返回 `"application":"applied"` 才算加载成功；
- 返回 `"application":"failed"` 时，`error.diagnostic` 会写明哪一行没激活。我们真撞过的两种：
  `cannot get property "configEditor" without inject`（服务没 inject 就读）
  与 `tool "workspace_roots" must declare output { schema, render }`（工具声明不全）。
- 客户端 bundle 与节点侧是**两条链**：面板能显示不代表服务端加载了。

### 6.3 验证（30 秒，别猜）

```bash
# 1) 服务端路由活着 → 200 + JSON
curl http://127.0.0.1:<你的端口>/plugins/dsh-multi-workspace/state

# 2) 404 但面板有胶囊 → 节点侧没加载（回去看 6.2 的 diagnostic）

# 3) 输入框左侧出现「根 N」胶囊 → 客户端也通了
```

### 6.4 回滚

1. `plugin_manager action=set_bundle target=dsh-multi-workspace enabled=false`
2. 删 `dependencies` 那行与 `dsh.profile.bundles` 里的名字
3. `cmd /c rmdir node_modules\dsh-multi-workspace`（junction 用 rmdir）
4. 重启 DSH

规则留在 profile 配置行里，写不进去时在 `.dsh/multi-workspace-rules.json`；审计日志在
`.dsh/multi-workspace-audit.jsonl`。两者都不影响 DSH 启动，可以随时删。

## 7. 自检

```bash
node tests/run-all.mjs     # 期望：tests 205 / pass 205 / fail 0
node bin/mw.mjs list       # 期望：一句人话，不是空表格
node bin/mw.mjs diff       # 期望：如实报告授权层现状
```

为什么不用 `node --test`：DSH 的 workspace-write 沙箱里测试运行器要 `spawn` 子进程，会直接 `Error: spawn EPERM`（一条用例都没跑，报成 `tests 1 fail 1`）。`run-all.mjs` 用**同进程 import** 跑全部用例。

## 8. 已知边界（诚实清单）

| # | 边界 | 会不会补 |
| --- | --- | --- |
| 1 | **Windows 子进程不认额外根**：`pwsh`/`bash`/`python`/`node` 里的写操作仍被围到 workspace + 私有 temp | 不补。要真正打通得给额外根打 ACL，属高风险且需要管理员，默认不做 |
| 2 | shell 命令的路径藏在字符串里，守卫看不到真实目标 | 默认 `shell.mode: deny`；开白名单也只认"命令全等"（`git status && del x` 绕不过去） |
| 3 | 读不受管（默认） | 需要时 `enforceRead: true`，但会先影响"看日志/看 asar"这类正常操作 |
| 4 | 会话级根（`registerWritableRoot`）不持久、不继承 subagent | 需要持久就用授权层（profile） |
| 5 | 撤销授权后，**已在跑**的进程保持旧权限 | 起新进程才生效 |
| 6 | 沙箱是**策略围栏**，不是内核边界（残留 TOCTOU 已被缩小但没消除） | 上游的事 |
| 7 | 审批**不携带工具参数**（`dsh-user-approval` 原文），所以审批弹窗看不到路径 | 这是为什么路径判定必须放在 guard 里，而不是指望人点"允许"时能看见路径 |
| 8 | 守卫管不到 shell 里的删除/移动 | 同第 2 条 |
| 9 | `sandbox-policy` 行 id 未在 base 里确认 | 安装步骤已标注"按 edit 报错处理，不要猜" |
| 10 | **面板的写操作不过工具审批** | 审批是给"模型发起的工具调用"的；点面板的是人本人，人本身就是授权来源。模型想改规则仍走 `workspace_roots` + 审批 |
| 11 | `/plugins/<包名>/...` **不经过** session cookie 校验 | 所以每条路由都必须自己做"只收本机回环 + Origin 与 Host 同源"两道检查；漏一条就是局域网里谁都能改你的可写根 |
| 12 | **面板不显示 ≠ 插件没加载** | 先用 `curl .../plugins/dsh-multi-workspace/state` 分辨：404 = 服务端没挂；200 但没有胶囊 = 客户端 bundle/槽位问题 |

## 9. 文件地图

| 文件 | 作用 |
| --- | --- |
| `src/paths.mjs` | 路径判定的**唯一来源**（canonical / keyOf / withinOf / glob / 抽路径） |
| `src/rules.mjs` | 纯规则引擎：`resolve()` 十二步判定，不碰配置与沙箱 |
| `src/validate.mjs` | 收根校验：形态、存在、symlink、deny-list、重复、覆盖 |
| `src/guard.mjs` | V1 兼容层：`createGuard` / `decide`，内部转调 `rules.resolve` |
| `src/store.mjs` | 规则文档的读写 + 授权层同步计划（落盘全走 `ctx.configEditor.edit`） |
| `src/tool.mjs` | 模型入口 `workspace_roots` |
| `src/audit.mjs` | JSONL 审计 + 5MB 轮转（**参数只记形状不记值**） |
| `src/cli.mjs` + `bin/mw.mjs` | 本地控制台（不依赖 DSH 运行时） |
| `src/index.mjs` | DSH 插件入口（唯一依赖真实 DSH API 形状的文件） |
| `panel/preview.html` | 1360 行可视化预览：第一次使用的三步引导卡 + 可点/可拖/可改名 + 判定 12 步可视化 + 二级说明页（8 条 FAQ）+ 根的能力对比表；不连 DSH、不写配置 |
| `src/http.mjs` | 面板的本机接口：`GET /plugins/dsh-multi-workspace/state`、`POST .../roots`（回环 + 同源双闸） |
| `lib/client.js` | 浏览器端 bundle：输入框左侧「根 N」胶囊 + 弹层（手写，不经打包器） |
| `tests/http.test.mjs` | 路由守卫与写入行为（403 两道闸、add/remove/update、坏 JSON） |
| `tests/client.test.mjs` | 用 `vm` + 假 React 真跑一遍 bundle：id 对包名、`apply` 挂对槽位、无 ESM 语句 |
| `tests/store.test.mjs` | 规则文档读写、授权层 diff、撤销栈、导入导出（假 configEditor） |
| `tests/tool.test.mjs` | 工具面：审批闸、evaluate/doctor/undo/import/session-* |
| `tests/run-all.mjs` | 同进程聚合跑 205 条用例（含面板结构守卫 `panel.test.mjs`） |
| `LICENSE` / `CHANGELOG.md` / `SECURITY.md` | 开源三件套（安全模型写在 `SECURITY.md`） |
| `.github/workflows/ci.yml` | CI：语法检查 + 全量测试 + 装前自检 + CLI 冒烟 |

## 10. DSH 里的面板（v0.5）

装进 profile 并**重启**之后，对话输入框左侧（自动继续开关那一条的最左边）会出现一个「根 N」小胶囊：

- 点开：列出额外活动范围，点圆片切「读/写/删/移」，开只读，移除，输入路径添加；
- 数据走 `GET/POST /plugins/dsh-multi-workspace/...`，不直接碰配置文件；
- 写入会落进 profile 的 `cordis.patch.yml`（规则层），并留一条审计；
- 改完对**下一个**模型请求生效；已经在跑的子进程保持旧权限。

三条必须记住的：

1. 面板的写操作**不过工具审批**（人点的是人本人）；模型改规则仍然要走 `workspace_roots` 工具 + 审批。
2. 这些路由**不经过** session cookie，所以服务端自己做了回环 + 同源检查 —— 这也是为什么它只在本机浏览器里可用。
3. 面板不显示时，先用 `curl http://127.0.0.1:<端口>/plugins/dsh-multi-workspace/state` 分辨是"服务端没挂"还是"客户端没挂"。

### 10.1 v0.5 面板新增了什么

| 能力 | 怎么用 | 注意 |
| --- | --- | --- |
| 自动刷新 | 打开面板即每 10 秒拉一次 `GET /state`，用 `rev` 短路：没变就不重绘 | 输入框里的字不会被刷掉 |
| 持久根 / 临时根分区 | 面板分两块；「加临时根」只在当前会话有效 | 临时根需要浏览器侧传 `sessionId` |
| 三个预设 | 每条根后面：只读浏览 / 项目协作 / 含删除 | 只改这一条根，不做批量 |
| 试算 | 「工具」页贴一段 `{"toolName":...,"args":...}`，点试算 | 只判不执行 |
| 最近记录 | 「工具」页拉最近 8 条面板操作 / 被拒记录 | 参数只记形状 |
| 撤销 | 「根」页底部「撤销」 | 最多 5 步，写失败的不进栈 |
| 导入导出 | 「工具」页导出到文本框 / 粘贴回来导入 | 导入会覆盖整份规则文档 |

## 11. v0.5 的高级功能（代码层对应）

| 功能 | 代码落点 | 判定/返回 |
| --- | --- | --- |
| 会话级临时根 | `src/index.mjs`（`registerSessionRoot` / `removeSessionRoot` / `disposeAllSessionRoots`） | `SESSION_ADDED` / `SESSION_UNAVAILABLE` / `POLICY_UNAVAILABLE` / `REGISTER_FAILED` |
| 试算 | `src/index.mjs` `evaluateCall` + `src/http.mjs` `POST /evaluate` | `{decision:'allow'|'deny', code, reason, matchedRoot}` |
| 自检 | `src/index.mjs` `doctorReport` | 8 个接线点，任一不过 → `DEGRADED` |
| 撤销 | `src/store.mjs` `undo` / `undoDepth` | `UNDONE` / `NOTHING_TO_UNDO` |
| 导入导出 | `src/store.mjs` `exportJson` / `importDoc` | `IMPORTED` / `BAD_DOC` |
| 面板事件流 | `src/http.mjs` `GET /events` | `{items:[{code,path,at}]}` |

### 11.1 开源前还差一步

仓库级的东西已经准备好了（`LICENSE`、`CHANGELOG.md`、`SECURITY.md`、`.gitignore`、CI）。**推上 GitHub 不是本地动作**：需要先建远端仓库、再加 `repository` 字段，然后由你决定是否 `git push`。本项目不做自动推送。

## 12. v0.5.1 踩过的五个坑（真机才撞得到）

这一节不是功能介绍，是「装上之后为什么没反应」的排障索引。每一条都在这台机器上真实发生过，现象和根因都在下面。

| 现象 | 真正的原因 | 现在的处理 |
| --- | --- | --- |
| 面板一直是 `HTTP 404`，但客户端 UI 正常显示 | `ctx.configEditor` / `ctx.workspaceRoot` 这类服务在 Cordis 里**先 inject 才能读**；直接读抛 `cannot get property "X" without inject`，异常打断**整个插件激活** | 统一走 `safeService()`，读不到就 `undefined`；每个实例往 `.dsh/load-trace.log` 写一行状态 |
| 点「加持久根」报 `Configuration entry is no longer available` | `rowId` 默认值是 `multi-workspace`，而 `cordis.patch.yml` 里的行 id 是 `dsh-multi-workspace` | 两处默认值统一；任何自定义行 id 必须与 patch 行 id 逐字相同 |
| 工具表里没有 `workspace_roots` | `tool "workspace_roots" must declare output { schema, render, presentationMeta? }` | 补 `output.schema` + `output.render` |
| 配置里写了 `allowShell: true`，命令还是被拒 | `resolve()` 从来没读过这个键 | `allowShell` 现在是总闸；不写就按 `doc.shell` 判 |
| 界面上只勾了「读+写」，实际能删能移 | 面板原来的 `add` 请求不带能力位，服务端按四个全给建档 | 请求带 `caps`；`/roots` 三个入口同时认 `caps` 与 `capabilities` |

两条给后来者的提醒：

1. **插件"能显示"和"能干活"是两条独立的加载链**。客户端 bundle 走 `dsh.client` + `exports["./client"]`；服务端走 `cordis.patch.yml` 的 `- insert:` 行。客户端能渲染，完全不代表节点侧活着 —— 先 `curl /plugins/<包名>/state`，404 就是节点侧没起来。
2. **降级要留痕**。写配置失败时现在会退到 `.dsh/multi-workspace-rules.json`，并把 `via: 'file'` 一路透到面板上 —— 否则「保存成功」可能只是落在没人读的地方。
