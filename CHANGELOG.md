# 变更记录

遵循 [Semantic Versioning](https://semver.org/lang/zh-CN/)。

## [0.5.4] - 2026-11-23

### 新增

- **`npm run doctor`：离线体检**。`src/doctor.mjs`（纯函数，注入 fs）+ `scripts/doctor.mjs`（零依赖 CLI，`--json` 可机读）。检查 profile 的依赖声明、`bundles` 登记、junction 解析、配置行、规则文件、审计文件、最后加载时间，共 9 个问题码；`LINK_BROKEN` 会直接给出修复命令。退出码 0 = 通过，1 = 有问题。
  - 来由：项目父目录改名后，profile 里的 `link:` 仍指旧路径，DSH 启动时解析失败并**静默跳过**——模块不导入、`apply` 不执行、路由不挂载，面板却照旧渲染。这种失效以前没有任何提示，现在一条命令就能看见。

### 修复

- **隐私**：17 处本机绝对路径脱敏（README / DETAIL / panel / tests / 边界与自检），`scripts/privacy-check.mjs` 入库并接进 `npm run check`。检查器支持 `// privacy-check: allow` 行内豁免，仅用于「夹具里必须出现敏感形状」的显式场景。
- **CI**：Node matrix 从 `24.x` 扩到 `20.x / 22.x / 24.x`（与 `engines.node >=20` 对齐），并新增隐私检查步骤。

### 测试

- 新增 `tests/doctor.test.mjs` 4 条：健康 profile、**把 junction 指向的目录删掉 → 必须报 `LINK_BROKEN`**、`roots=0` 只报 `ROOTS_EMPTY`、helper 单测。全量 **222 条通过**。

## [0.5.3] - 2026-11-21

### 修复

- **守卫与"判定模拟器"对同一个调用给出相反答案**：`allowShell: true` 时真正干活的那条路（`guard()`）放行 shell，而 `POST /evaluate`（面板里点"试算"看到的结果）却回 `SHELL_UNCONTROLLED` / deny。根因是 `evaluateCall()` 漏传 `allowShell`，已补上。新增 `tests/contract.test.mjs`：同一个调用，两个出口必须同答案。
- **`/state` 里的 `limits.shellTools` 与实际策略不符**：`allowShell: true` 时仍写着"当前一律拒绝"。现在按三档如实输出（整体放行 / 白名单 / 一律拒绝）。
- **工具 `workspace_roots` 的 `status` 与面板 `limits` 是同一套说法**：`summarize()` 新增 `options.allowShell`，`src/tool.mjs`、`src/http.mjs`、`src/index.mjs` 三处调用点都传真实值，避免两个界面各说一套。
- **可选服务一律探测不到（真机降级的真根因）**：`safeService()` 原来只做 `try { return ctx?.[name] } catch {}`，而宿主在没 `inject` 时不把这些服务挂在属性上 —— 于是 `configEditor` / `sandboxPolicy` / `sessions` 永远是 `undefined`，插件自我降级成"临时根不可用、规则只能落兜底文件"。改成**优先 `ctx.get(name)`**（宿主 app.asar 自带文档的写法：`const editor = ctx.get('configEditor')`），属性访问只作兜底。热激活实测：`persistVia` 从 `file` 变回 `config`、`sessionRootsSupported` 变 `true`、`problems` 清空。
- **`persistVia` 说了假话**：服务在 ≠ 真写进去了。实测 profile 的 `cordis.patch.yml` 里**没有本插件的行**（bundle 的行住在插件自己的包里，`configEditor` 不认），`configEditor.edit()` 会抛 `Configuration entry is no longer available`、store 自动降级写兜底文件。现在 `persistVia` 报**默认落点**（`file`），并在 `status.notes` 里写清原因，不再声称"配置行已写"。

### 为什么值得单发一版

这不是文案问题。面板"判定模拟器"的用途是让人在动手之前就知道"这条会不会被拦"；它和真实守卫判错方向，代价是你在反方向找 bug。本次真机事故就是这样：另一个会话写不进文件，而插件自己的审计 JSONL 里那段时间**零拒绝记录**（最近 75 条全在 12:51Z / 12:54Z，比事故早三个小时）。

### 自检

- `node tests/run-all.mjs` → **tests 217 / pass 217 / fail 0**（新增契约测试 4 条：守卫/试算同答案 ×3、只给 `ctx.get` 的宿主形状 ×1；另一条"配了根写根外"因夹具假设错被删，围栏判定仍由 `tests/rules.test.mjs` 覆盖 `resolve()`）。
- `node scripts/load-check.mjs` → 24 项全过。
- `node scripts/route-probe.mjs` → 6 条路由全注册，`STATUS` 里 `persistVia: "file"` 且带 `notes` 说明落点。
- 真机热激活实测（`curl /plugins/dsh-multi-workspace/state`）：`persistent: true`、`sessionRootsSupported: true`、`problems: []`；`POST /roots` 加根→`ADDED`/`via: file`→`remove`→`REMOVED`，兜底文件回到 `roots: []`。

## [0.5.2] - 2026-11-20

### 新增

- **第一次使用的引导卡**：面板第一屏三步（加一个根 → 确认生效 → 让 Agent 用它），关掉后右上角 `?` 随时重开；不写浏览器存储，刷新即回到初始状态。`panel/preview.html` 离线演示页也有同一张卡。
- **README「第一次使用（30 秒）」**：从装好到真正能用只讲三步，外加两件最容易踩的事。

### 整理

- README §4 的规则文件路径改成真实落点：优先写 profile 配置行，写不进去落到 `.dsh/multi-workspace-rules.json`。
- README §6 整节重写为真机验证过的安装步骤（`link:` + `dsh.profile.bundles` + `mklink /J` → `plugin_manager set_bundle` → `curl /state` → 回滚），并删掉旧版"手工往 `cordis.patch.yml` 加 `- id: multi-workspace`"的错误指导（真实行 id 是 `dsh-multi-workspace`）。
- 自检计数 203 → 205（新增客户端引导卡守卫、离线预览引导卡守卫）。

### 仓库

- 首次发布到 GitHub：<https://github.com/David-Martinez-worldexecute/dsh-multi-workspace>（本次提交同时补齐 `package.json` 的 `repository` / `homepage` / `bugs`）。

### 仓库规范化（开源形状）

- **README 重写为双语**：首屏换成徽章 + 一句话定位 + 面板截图 + 「快速开始 · Quick start」+ 三条边界表 + 18 行目录；正文 12 个标题统一成 `N · 中文 · English`；新增「兼容性 / 贡献 / 安全 / 版本与发布 / 许可证 / 致谢」六节。
- **面板截图**：`docs/panel-preview.png`（2360×1720，无头 Chromium 渲染 `panel/preview.html`），README 首屏直接引用。
- **社区文件**：`CONTRIBUTING.md`、`CODE_OF_CONDUCT.md`、`.github/PULL_REQUEST_TEMPLATE.md`、`.github/ISSUE_TEMPLATE/{config,bug_report,feature_request}.yml`。
- **仓库形状守卫** `tests/docs.test.mjs`（8 条）：截图存在且是真 PNG、README 本地链接全部可达、目录行数与正文标题数一致、社区文件齐全、`package.json` 元数据与 `dsh` 字段齐全。自检计数 205 → 213。

## [0.5.1] - 2026-11-20

这一版没有新功能，全部是「装上之后真的能用」的修复。每一条都是在本机真实加载里撞出来的，不是推测。

### 修复

- **节点侧从不激活**（面板一直 `HTTP 404` 的根因）：`ctx.configEditor`、`ctx.workspaceRoot` 这类服务在 Cordis 里必须**先 inject 才能读**，直接读会抛 `cannot get property "X" without inject`，而这个异常会打断整个插件激活 —— 症状是客户端 UI 正常、服务端路由全 404。现在统一走 `safeService()`，读不到就返回 `undefined`，不再炸整条激活链。
- **配置行 id 与 patch 行 id 不一致**：`rowId` 默认值原为 `multi-workspace`，而 `cordis.patch.yml` 里的行 id 是 `dsh-multi-workspace` → 每次保存都报 `Configuration entry is no longer available`。两处默认值已统一，并要求任何自定义行 id 必须与 patch 行 id 逐字相同。
- **工具注册被拒**：`tool "workspace_roots" must declare output { schema, render, presentationMeta? }`。补上 `output.schema` 与 `output.render` 之后工具才真的出现在工具表里。
- **`allowShell` 写了但代码没读**：配置里有 `allowShell`，`resolve()` 从来没看过它 → 装上插件后命令类工具一律被拒。现在它是总闸。
- **空根等于把整个 Agent 锁死**：`roots: []` 时原来按「不在任何范围内」拒绝一切写入。现在改为「没有任何登记范围 = 不做围栏」，装上插件不会顺手把 Agent 关进笼子。
- **面板「加根」丢失能力位**：前端只发 `{op, path, scope}`，服务端按四个能力位全给建档 —— 界面只勾了读+写，实际拿到了删除与移动。现在请求带 `caps`，`/roots` 三个入口同时认 `caps` 与 `capabilities`；输入框下方也加了能力位选择。
- **`configEditor` 缺席时无法保存**：现在 `save()` 在编辑器不可用、或编辑器报 `Configuration entry is no longer available` 时**降级写 `.dsh/multi-workspace-rules.json`**，并把 `via: 'file'` 透出来，让界面能说清「这次落在哪」。

### 边界（新增，已写进 SECURITY.md 与 边界与自检.md）

- 行 id 必须等于 patch 行 id，否则保存会静默失败到文件兜底 —— 两个落点都可能被读到，但只有一个是「下次重启还算数」的那个。
- inject 读服务失败会**静默降级**：插件不报错，但功能缺一块。所以每个实例都往 `.dsh/load-trace.log` 写一行状态，排障先看这个文件。

## [0.5.0] - 2026-11-20

### 新增

- **会话级临时根**：`workspace_roots({ action: 'session-add', sessionId, ttlMinutes })` 与面板上的「加临时根」。走 `ctx.sandboxPolicy.registerWritableRoot(session, dir)`，只对那一场会话生效、不持久、不继承 subagent；TTL 到点自动撤销。
- **试算（evaluate）**：`workspace_roots({ action: 'evaluate', toolName, argsJson })` 与 `POST /evaluate`。只按当前规则判一次，不真的执行 —— 用来回答"这条调用会被放行吗"。
- **撤销**：store 内最多 5 步撤销栈（写成功才入栈，写失败不入栈）；`action: 'undo'` / `POST /roots {op:'undo'}`。
- **导入导出**：`action: 'export' | 'import'`、`GET /export`、`POST /import`，整份规则文档往返。
- **自检（doctor）**：`action: 'doctor'` 汇总 8 个接线点（guard / tool / configEditor / sandboxPolicy / sessions / webServer / audit / rules），任一项不过就 `DEGRADED`。
- **面板升级**：10 秒轮询 + `rev` 短路重绘、持久根/临时根分区、三个预设（只读浏览 / 项目协作 / 含删除）、试算框、最近操作记录、导入导出、撤销。

### 修复

- `RULE_CODE` 缺 `BAD_DOC`：坏规则文档原来会显示 `undefined: 规则文档必须是对象`，现在返回可判的 `BAD_DOC`。
- `store.replace()` 走 `mutate` 后没有返回值，导致"替换整份文档"实际不写入。

## [0.4.0] - 2026-11-20

### 新增

- **浏览器面板**：`lib/client.js` 挂到 `conversation.input.left`（输入框左侧、自动继续开关旁边）；`GET /plugins/dsh-multi-workspace/state`、`POST /plugins/dsh-multi-workspace/roots`。
- 面板路由自带回环 + 同源两道闸（`/plugins/**` 不走 session cookie）。

## [0.3.0] - 2026-11-20

### 新增

- 插件自描述：`dsh.bundle.patch`、`dsh.client`、`main`、`exports`。
- `scripts/load-check.mjs`：假 ctx 真调 `apply()` 的 24 项装前自检（含临时根、试算、撤销、导出）。
- `apply()` 全段 fail-soft：加载期异常只降级，不把整个 profile 带走。

## [0.2.0] - 2026-11-20

### 新增

- 自由规则引擎（`src/rules.mjs`）：每根四能力位（读/写/删/移）、`mode: rw|ro`、`include`/`exclude` glob、`expiresAt`、敏感名单。
- 持久化（`src/store.mjs`）：全走 `ctx.configEditor.edit`，原子写 + 写后校验 + 授权层漂移检测。
- 工具面（`src/tool.mjs`）：单一入口 `workspace_roots`，`add/remove/update/validate/probe/sync/audit`。
- 本地控制台（`src/cli.mjs` + `bin/mw.mjs`）：不依赖 DSH 也能看规则、试 probe、比对 profile。
- 审计 JSONL（`src/audit.mjs`），5 MB 轮转。

## [0.1.0] - 2026-11-20

### 新增

- 路径校验器（`src/validate.mjs`）：绝对路径、拒绝 UNC/长路径/符号链接、deny-list、大小写与尾斜杠归一。
- 工具级守卫原型（`src/guard.mjs`）。
