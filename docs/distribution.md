# 分发闭环 · dsh-multi-workspace

> 把「发出去」的步骤写死、把「被看见」的材料备好、把「怎么说」定调。
> 标 **【人工】** 的需要作者本人操作；标 **【已做】** 的是本轮已验证或已改好的。

## 0 · 现状（2026-11-21 实测）

| 项 | 状态 | 证据 |
|---|---|---|
| npm 包是否存在 | **不存在** | `npm view dsh-multi-workspace version` → `E404` |
| `publishConfig` | 【已做】`public` + 官方 registry | `package.json` |
| `dsh.engines.dsh` | 【已做】`>=0.2.2-rc.3`（并注明更低版本未验证） | `package.json` |
| `author` | 【已做】`David-Martinez-worldexecute`（原为 "contributors"） | `package.json` |
| `icon.svg` | 【已做】新建，并登记进 `files[]` | 仓库根目录 |
| `docs/DETAIL.md` | 【已做】详情页文案 | `docs/DETAIL.md` |
| 本机 npm 身份 | `corvou_4`，2FA = `auth-and-writes` | 发布需 OTP |
| 版本号 | `0.5.3` | 首次发布建议 `0.5.4`（本轮改了 README/package.json） |

## 1 · npm 发布检查清单

| 检查项 | 要求 | 当前 |
|---|---|---|
| `name` | 唯一 | `dsh-multi-workspace`（E404 = 未被占用） |
| `version` | 未发过 | `0.5.3`；建议 bump 到 `0.5.4` |
| `files` | 只发运行时需要的 | `src/` `lib/` `bin/` `panel/` `docs/` `icon.svg` `cordis.patch.yml` `README.md` 等 |
| `license` | MIT | 有 `LICENSE` |
| `repository`/`homepage`/`bugs` | 有 | 齐全 |
| `publishConfig` | `access: public` | 【已做】 |
| `engines.node` | `>=20.0.0` —— 已于 2026-11-21 决定放宽 | 实测环境 Node 25.1.0；20–24 未逐一验证，`tests/run-all.mjs` 在放宽后重跑 218 passed |
| `bin` | `bin/mw.mjs` 存在但**未声明** | 本轮刻意不加（避免破坏现有用法）；如需 `mw` 命令再单独加 |
| 敏感文件 | `边界与自检.md` 在 `files[]` 里，已净化 3 处本机路径 | 【已做】`remaining=0` |
| `M4-安装记录.md` | 不在 `files[]`，但仍在 git 里，含 6 处本机路径 | 【需人工】决定：删除 / 加 `.gitignore` / 净化 |
| tarball 无本机路径 | `npm pack --dry-run` | 【待验证】 |
| `CON` 残留文件 | 物理存在，`git add -A` 会 `unable to stat 'CON'` | 【需人工】删除（它只是 git 失败残留，内容为一行提示） |

### 发布命令（【人工】，需要 OTP）

```bash
cd <仓库目录>
node tests/run-all.mjs      # 期望 tests 217 / pass 217 / fail 0
node scripts/load-check.mjs # 假宿主装载检查
npm pack --dry-run          # 看清单与体积，确认没有本机路径
npm version patch
npm publish --otp=<6位码>
```

发完立刻验：`npm view dsh-multi-workspace version`，然后在一个**新的 profile 名**上跑
`npx -y @deepseek-ai/dsh plugin --profile probe2 add dsh-multi-workspace`，重启 DSH 看会话输入框左侧有没有「根 N」胶囊。

## 2 · 社区索引提交材料

| 字段 | 内容 |
|---|---|
| 标题 | `dsh-multi-workspace — 给 Agent 多开几个可写目录，并且留下看得懂的信任证据` |
| 一句话描述（中） | 为 DSH Agent 增加工作区之外的目录，按「读/写/删/移」四档分别授权；每次判定留一行审计，面板把「允许到什么程度、被哪条规则拦、最近谁写过」说成一句人话。 |
| 一句话描述（英） | Extra writable roots for a DSH agent with per-root capability bits, a sensitive-file deny list, and an audit trail you can read as plain-language trust summaries instead of JSONL. |
| 标签 | `dsh-plugin` `sandbox` `writable-roots` `agent-safety` `permissions` `audit` |
| 安装命令 | `npx -y @deepseek-ai/dsh plugin --profile desktop add dsh-multi-workspace` |
| 仓库 | https://github.com/David-Martinez-worldexecute/dsh-multi-workspace |
| 版本要求 | DSH ≥ 0.2.2-rc.3 · Node ≥ 20 |
| 截图 | `docs/panel-preview.png`；建议补「拒绝时那行规则名」的实拍 |

### 与替代方案怎么讲（重要）

同名的 `somnusovis/dsh-multi-workspace` 主打「零配置、自动授予写权限」。
**不建议去贬低它**，也不要在 README 里假装它不存在。可以这样区分（写进 README 或索引描述）：

> 如果你只想要「让 Agent 能写这个目录」，零配置方案更省事。
> 这个插件的取舍是：**每个根分四种能力、敏感文件默认拦、每次判定留证据**。
> 代价是你要先想清楚给多大权限；回报是出事时你能说出「谁在什么时候被哪条规则允许的」。

**待核实**：竞品的确切行为、是否也做审计 —— 引用前请自己打开它的 README 看一遍，不要把传闻写进文档。

### 提交入口

| 索引 | 入口 | 状态 |
|---|---|---|
| awesome-dsh-plugin.com | 提交表单 / PR 入口 —— **需确认** | 先打开站点找 submit |
| dsh-plugin-catalog | 由 npm 包生成 —— **需确认**收录方式 | 发 npm 后观察 24–48h |
| 其它 awesome-list | 各自规则不同 —— **需确认** | 优先挑有 sandbox / permissions 分类的 |

## 3 · 冷启动文案（三条）

### ① DSH-Guild / 社区面板（问题先行）

> 我让 Agent 写一个工作区外的目录，结果它写进去了 —— 但我花了十分钟才搞清那是哪次授权、什么时候该过期。
> 所以把「能写」这件事做成了可读的：每个根分读/写/删/移四档，`.env` 之类默认拦，面板上一句话告诉你「这个根能写不能删、最近 7 天写过 3 次」。
> 想找几位**已经在用附加根**的人试试，一条命令：
> `npx -y @deepseek-ai/dsh plugin --profile desktop add dsh-multi-workspace`
> 我最想听的：你第一次看到那句信任摘要时，有没有哪个词看不懂。

### ② GitHub Release / README 顶部

> Agent 能写你的文件。但你能一眼说出它刚才动过哪儿、被谁允许的吗？

### ③ 中文技术社区（对比式，但不贬低）

> 给 Agent 开额外写权限，通常有两种做法：要么全放开图省事，要么每次手动改配置图安心。
> 我选了第三条：权限按「读/写/删/移」分四档、敏感文件先拦一道、每次判定写一行审计，然后把这行审计翻成一句人话。
> 代码在这，欢迎用真实项目测边界：<仓库链接>

## 4 · 7 天节奏

| 天 | 动作 | 谁做 |
|---|---|---|
| D1 | 决定 `engines.node` 是否放宽 → 跑 217 测试 → 发 npm | 【人工】 |
| D1 | 清理 `CON`、M4-安装记录（三选一） | 【人工】 |
| D2 | 补一张「拒绝 + 规则名」的 GIF | 【人工】录屏 |
| D2 | 提交索引（入口确认后） | 【人工】 |
| D3 | DSH-Guild 发 ①，明确要「哪个词看不懂」 | 【人工】 |
| D4–D5 | 收反馈 → 只改文案与默认值 | 我 |
| D6 | 发补丁版 + Release 写「按反馈改了什么」 | 【人工】 |
| D7 | 复盘：一条命令的成功率、卡在哪 | 一起 |

## 5 · 验收标准

- [ ] `npm view dsh-multi-workspace version` 返回版本号
- [ ] 新 profile 一条命令装完，重启后出现「根 N」胶囊
- [ ] `npm pack --dry-run` 清单里没有 `C:\Users\lin`、没有 `边界与自检.md` 里的本机路径
- [ ] README 第一屏可见：标题、一句话、一条安装命令
- [ ] 至少一个索引页能搜到
